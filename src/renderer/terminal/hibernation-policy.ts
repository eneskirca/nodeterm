/**
 * Which idle agent sessions may be HIBERNATED — the pure decision half of "Eco" mode
 * (`settings.agentHibernationEnabled`). Hibernating means the agent CLI is asked to `/exit` and
 * the conversation is resumed (`--resume`) the next time the user looks at the node: the tmux
 * session, its pane and its scrollback are untouched; what is reclaimed is the CLI process's RAM.
 * The wiring that acts on this plan lives elsewhere — this module only decides.
 *
 * WHY EACH EXCLUSION EXISTS (each one is a way to lose the user's work or their attention):
 *
 *  - **Only `done`, never `waiting`** (nor `blocked`, nor an unknown state). `waiting`/`blocked`
 *    mean the CLI is holding a question or a permission request open for the user. Exiting there
 *    would SILENTLY SWALLOW A NEEDS-YOU QUESTION — the badge is exactly the thing the user is
 *    being asked to come back for, and the exit line typed into a permission prompt would ANSWER
 *    it rather than quit. `working` is refused for the obvious reason (a turn in flight), and an
 *    unknown state is not evidence of idleness.
 *  - **Never a `recurring` node** (`/loop`, `/schedule`, `/cron`, any kind). `/exit` kills the CLI
 *    PROCESS, and a loop's `ScheduleWakeup` / an in-session cron wakeup dies with it — the job
 *    would simply never fire again. Between iterations such a node looks EXACTLY like the target
 *    profile (`done`, offscreen, long idle), so this guard is the only thing standing between Eco
 *    mode and a silently cancelled recurring job.
 *  - **Never a node with live subagents.** Claude launches subagents async: the completion of an
 *    async-launched subagent is queued into the PARENT's transcript, and a dead parent CLI never
 *    reads it. Hibernating the parent orphans every subagent still running under it.
 *  - **Never a node with a live BACKGROUND TASK.** A Claude `Bash` launched with
 *    `run_in_background` runs inside the CLI process, so `/exit` kills it silently — no output, no
 *    error, no record. And no hook fires while it runs, so a node whose only activity is a long
 *    background job looks EXACTLY like the target profile (`done`, offscreen, idle for hours): the
 *    stamp the launch left behind (`agentStatus.backgroundTaskAt`, cleared at the next turn start)
 *    is the only signal there is.
 *  - **Unknown idle is NOT idle.** A candidate with no `lastEventAt` (no hook event has ever been
 *    seen for it in this run) is never eligible — the same rule as pendingLaunch's "an unknown
 *    dependency state is not satisfied". Guessing here costs the user a live session.
 *  - **Never a REMOTE session** (SSH project / relay tab) in v1 — and excluded at PLAN time, not
 *    only when the exit is attempted: the plan is a deterministic sort-and-slice, so two remote
 *    nodes at the head of the oldest-idle order would occupy both batch slots on every pass and no
 *    local node would ever hibernate.
 *  - **`restartEligibility` is the shared gate.** Hibernation is exit + resume, so a node this
 *    module picks must be one the restart machinery could actually bring back: a CLI we cannot
 *    quit or resume, or a session with no provider session id, has nothing to resume INTO.
 *
 * The batch cap keeps a sweep from stopping a canvas full of agents at once (each exit + resume
 * is real work in a real pane): the oldest-idle nodes go first, at most `HIBERNATE_BATCH_MAX` per
 * pass, so a long-idle backlog drains over several sweeps instead of in one storm.
 */
import { restartEligibility } from './agent-restart'

/** How many sessions one hibernation pass may take. */
export const HIBERNATE_BATCH_MAX = 2

/** How often the canvas re-asks. Coarse on purpose: the shortest window the setting offers is
 *  measured in minutes, so a faster sweep would only pay for a plan that cannot have changed. */
export const HIBERNATE_SWEEP_MS = 60_000

export interface HibernationCandidate {
  id: string
  agentId?: string
  state?: string
  sessionId?: string
  /** The node has a live terminal/PTY wired up (an unwired node has nothing to exit). */
  wired: boolean
  /** The node is out of view. */
  offscreen: boolean
  /** Already hibernated — nothing left to reclaim. */
  hibernated: boolean
  /**
   * The session runs on ANOTHER MACHINE (an SSH project's terminal, or a relay/remote-server tab).
   * Excluded in v1, the same call the offscreen dispose makes: the exit and its much later resume
   * would race the ControlMaster / relay lifecycle, and a wake that cannot reach the host leaves a
   * dead conversation behind.
   *
   * Excluded HERE and not only at the moment of the exit, because this plan is a deterministic
   * sort-and-slice: two remote nodes sitting at the head of the oldest-idle order would fill both
   * batch slots on every pass, refuse at fire time, and no local node would ever be hibernated —
   * a feature that silently does nothing, which is the hardest kind of failure to notice. The
   * fire-time check stays as the freshness re-ask (a project can BECOME an SSH project).
   */
  remote: boolean
  /** Any `/loop`, `/schedule` or `/cron` indicator on this node (from `agentStatus.loop`). */
  recurring: boolean
  /** Any non-done subagent card whose parent is this node (from `state/agentNodes.ts`). */
  liveSubagents: boolean
  /** A background shell task is running inside this node's CLI (from `agentStatus.backgroundTaskAt`
   *  — set on the launch hook, cleared at the next turn start). Required, like `remote`: typecheck
   *  is what forces every call site to answer, and an omitted field would read as "no task". */
  liveBackgroundTask: boolean
  /** When this node's last hook event landed. Absent = never seen ⇒ never eligible. */
  lastEventAt?: number
  /**
   * Already `paused` (agentStatus.paused). Excluded for the same reason `hibernated` is: nothing
   * left to reclaim — but ALSO because a deep "pause & end session" node has `hibernated` UNSET
   * (its tmux session was recycled, not merely exited), so `!c.hibernated` alone would still admit
   * it. Without this field, an offscreen deep-paused node whose SessionEnd hook POST was dropped
   * (a server hiccup, a downed tunnel) could sit at `state: 'done'` with a stale `lastEventAt`,
   * pass every other filter, and have Eco's sweep KILL_LINE + `/exit` typed into its already-bare
   * shell — the exact class of mistake `alreadyExited` (the manual pause closure's own skip) exists
   * to prevent, reachable here through the automatic sweep instead.
   */
  paused: boolean
}

export interface HibernationConfig {
  enabled: boolean
  idleMinutes: number
}

/**
 * "Pause session" (see agentStatus.paused) is a persisted flag with exactly one job: stop a node
 * from coming back on its own. These two pure predicates are the whole of that job — extracted so
 * the promise stays pinned by a unit test instead of only by reading the inline condition at each
 * of the several call sites that must honor it (a cold restart, a mount-time reveal, a visibility
 * edge, and a kanban card modal open all ask one of these two questions before acting).
 */

/**
 * Should a `fresh` cold restore (reboot, first open, a reaped server — see TerminalNode's cold-
 * restore comment) auto-relaunch the agent CLI? The one thing `paused` exists to prevent is
 * exactly this: an ordinary cold restore always resumes, and `paused` is the deliberate exception
 * that survives it. Every OTHER fact that gates the relaunch (is this `fresh`, is there an agent,
 * can it be resumed) is unrelated to pausing and stays inline at the call site.
 */
export function shouldColdResume(paused: boolean | undefined): boolean {
  return !paused
}

/**
 * Should an AUTOMATIC wake trigger fire — the mount-time reveal, the offscreen→visible
 * IntersectionObserver edge, or opening a kanban card modal? Only for a node that is ordinarily
 * hibernated (Eco) and NOT paused: a paused node (whichever depth paused it — a warm hibernated
 * pane, or a freshly recycled shell after "pause & end session") must wait for an EXPLICIT Resume
 * on every reveal, not just the first one, or "only Resume brings it back" would be false the
 * moment the user looks at the node. The explicit paths (the SLEEPING/PAUSED chip's own click, the
 * node-menu Resume action) are NOT gated on this — they call the wake trigger directly.
 */
export function shouldAutoWake(
  hibernated: boolean | undefined,
  paused: boolean | undefined
): boolean {
  return !!hibernated && !paused
}

/** The node ids to hibernate now: oldest-idle first, at most `HIBERNATE_BATCH_MAX`. */
export function planHibernation(
  candidates: HibernationCandidate[],
  nowMs: number,
  cfg: HibernationConfig
): string[] {
  if (!cfg.enabled) return []
  // The window is re-validated HERE, not trusted from the type: settings.json is hand-editable and
  // merged without clamping, so `idleMinutes` can arrive as null, NaN, 0 or negative — and the UI
  // clamp only guards keystrokes. Each of those would make the window zero or negative, i.e. EVERY
  // done+offscreen node eligible on the first sweep: Eco exiting live CLIs the instant a turn ends.
  // So an unreadable window reads as "off" — the same call `offscreenDisposeMs` makes one file over.
  if (!(cfg.idleMinutes > 0)) return []
  const idleMs = cfg.idleMinutes * 60_000
  return candidates
    .filter(
      (c) =>
        !c.hibernated &&
        !c.paused &&
        !c.remote &&
        c.wired &&
        c.offscreen &&
        c.state === 'done' &&
        !c.recurring &&
        !c.liveSubagents &&
        !c.liveBackgroundTask &&
        restartEligibility(c.agentId, c.state, c.sessionId).ok &&
        // `?? Infinity`: no event ever seen ⇒ the difference is -Infinity ⇒ never eligible.
        nowMs - (c.lastEventAt ?? Infinity) >= idleMs
    )
    .sort((a, b) => (a.lastEventAt ?? 0) - (b.lastEventAt ?? 0))
    .slice(0, HIBERNATE_BATCH_MAX)
    .map((c) => c.id)
}
