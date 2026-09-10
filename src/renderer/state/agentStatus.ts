import { create, type StoreApi, type UseBoundStore } from 'zustand'
import { WORKING_STALE_MS } from '@shared/agents/stale'
import type { AgentId } from '@shared/agents/config'
import type { AgentState } from '@shared/agents/normalize'
import type { NodeTerminalApi, ObservedClaudeAccount } from '@shared/types'
import type { RestartRefusalReason } from '@renderer/terminal/agent-restart'

/**
 * Transient per-node status for agent (e.g. Claude Code) sessions, driven by the agent's hooks.
 * `unread`, `session`, `sessionId`, `agentId`, `account`, `loop` and `hibernated` are persisted to
 * localStorage so they survive a reload/restart; the live `state` (working/waiting/…) is not
 * (it'd be stale on relaunch), and neither are its two clocks (`stateAt`, `lastEventAt`).
 * `agentId` is durable because a PLAIN terminal's agent identity exists nowhere else: an
 * explicit agent node re-derives it from `data.agentId`, but a hand-launched `claude` in a
 * plain terminal is only known here, and its context links must keep classifying across
 * restarts (tmux keeps the session — and the agent — alive through them). `account` is durable
 * for exactly that reason too — see its field comment.
 *
 * ONE STORE PER CORE (stage 4): `createAgentStatusSession(persistKey?)` builds an isolated
 * instance — node ids are per-core, so status tables from two cores must never mix. The module
 * keeps a DEFAULT instance for the local core and re-exports its members under the historical
 * names, so the existing single-session consumers are untouched. The session registry resolves
 * a store through `agentStatusForApi(api)` — memoized BY API IDENTITY like presence, and seeded
 * with `window.nodeTerminal → defaultAgentStatus`, so the local session (and any path handed a
 * repeat api) structurally gets the one existing store, never a parallel twin.
 *
 * PERSISTENCE IS PER-KEY, AND ONLY THE DEFAULT HAS ONE. This is deliberately the opposite call
 * from presence's shared ME_KEY: {name, color} is who the HUMAN is (one per person, shared
 * across sessions), but agent status is per-NODE state on a SPECIFIC core — a remote core's
 * unread/sessionId for `nt-x` is not this machine's `nt-x` (tmux persistKeys are unique within
 * one core only), and `save()` rewrites the WHOLE table, so a remote session sharing
 * `nodeterm.agentStatus` would clobber the local nodes' persisted unread/session/loop on its
 * first write. So: the default instance keeps the historical key (bit-for-bit today's
 * behavior, legacy migration included); a keyless instance persists NOTHING (remote status is
 * rebuilt from the remote core's hooks on reconnect — a durable per-remote key needs a stable
 * session identity, which sub-stage 4c owns); the `persistKey` parameter is how 4c opts a
 * session into its own namespaced key without touching this file.
 */
export interface AgentNodeStatus {
  /** Live activity; undefined = idle/unknown. */
  state?: AgentState
  /**
   * When the LAST hook event asserted the current state (freshness, not transition time).
   * Never rendered — drives the done-holdoff guard, the stale-working sweeper, and the
   * interrupt-inference baseline. Same-state events refresh it in place (no re-render).
   */
  stateAt?: number
  /**
   * Did the hook POST that set the current `state` carry a per-node token? Mirrors
   * `MirrorEntry.stateVerified` (core/agent-status-mirror.ts), which is where the messaging gate
   * actually reads it — this copy exists so the UI can SHOW identity state, not so anything can
   * gate on it. TRANSIENT, deliberately excluded from the durable whitelist in `save()`: a relaunch
   * has seen no events, and a restored `true` would assert proof that was never presented this run.
   */
  stateVerified?: boolean
  /**
   * When this node last CHANGED state (or was explicitly woken) — rendered as the status group's
   * relative age and also read as the idle clock by `terminal/hibernation-policy.ts`. Deliberately
   * not `stateAt`: that one is refreshed by every same-state event (freshness), while "how long in
   * this state" means "how long since the transition". TRANSIENT — never persisted: a relaunch has
   * seen no events yet, and a stale stamp read as "idle since before the restart" would hibernate a
   * session the moment the app came back. Absent ⇒ unknown idle ⇒ never a hibernation candidate.
   */
  lastEventAt?: number
  /**
   * When this node last launched a BACKGROUND shell task (Claude's `Bash` with
   * `run_in_background: true`). Such a task lives inside the CLI process, so terminating that
   * exact process group for Eco or bulk restart kills it silently, with no output and no error.
   * The stamp is what those two exclude on.
   *
   * TRANSIENT — never persisted, same rationale as `lastEventAt`: after a relaunch Eco is inert
   * until a turn happens anyway, and any turn's `working` would have cleared this. A stale stamp
   * restored from disk would exempt the node from Eco for good.
   */
  backgroundTaskAt?: number
  /**
   * The agent CLI was exited to reclaim its RAM ("Eco" mode) and its conversation is waiting to be
   * resumed when the node is next viewed. PERSISTED beside unread/session/sessionId: the tmux
   * session outlives the app, so after a relaunch this flag is the only thing that knows the pane
   * holds a shell rather than a live CLI.
   */
  hibernated?: boolean
  /**
   * What the pane's foreground command settled to once the CLI let go of it — recorded at the
   * moment of hibernation, persisted beside the flag, and dropped with it.
   *
   * The wake refuses to type a launch line into a pane it does not recognize as a shell, and its
   * allowlist (`isShellCommand`) knows zsh/bash/fish/… but not `nu`, `xonsh` or `pwsh`. The EXIT
   * half has a second, allowlist-free signal for exactly those users (the foreground command
   * stopped being the CLI, twice in a row) — so without this the wake is STRICTER than the exit,
   * and a `nu` user could be hibernated and then never woken: the chip would refuse forever.
   * Remembering what we exited TO closes that gap, and it is narrow by construction: it permits
   * one specific string, on one specific node, recorded by us.
   */
  hibernatedPane?: string
  /**
   * The user (or Eco's idle sweep, when `settings.agentHibernationPersistAcrossRestart` is on)
   * explicitly PAUSED this node: its CLI was exited (and, for the deeper "pause & end session"
   * choice, its tmux session recycled too) and it must NOT auto-resume on the next reveal or on
   * a cold restart — only an explicit Resume brings it back. PERSISTED, and — unlike `hibernated`
   * — deliberately NOT cleared by a `fresh` cold restore: that self-heal is what lets Eco's
   * ordinary hibernation "come back automatically when reopened", which is exactly the behavior
   * this flag exists to opt a node OUT of. Cleared only by an explicit resume or by a genuine
   * live hook event (see `setState`'s self-heal) — the same self-heal `hibernated` gets, for the
   * same reason: a live state is proof the CLI is running, so a standing `paused` would be wrong.
   */
  paused?: boolean
  /**
   * This node's agent CLI left its pane and NOTHING accounted for it — no SessionEnd hook, no
   * `hibernated`, no `paused`. In practice: the process was killed (the OOM killer, a `pkill`, a
   * host that ran out of memory), or a cold-restore `--resume` failed and fell back to a bare
   * shell. The decision is the pure `terminal/agent-liveness.ts`; this field is only where the
   * node records the verdict so its header and the kanban card can render the DROPPED chip.
   *
   * TRANSIENT, like `state` and for a stronger reason than the other clocks: it is a claim about a
   * pane, and a pane's contents are re-measurable in milliseconds. Persisting it would let a stale
   * verdict survive into a run where the session had been resumed by hand — a chip on a healthy
   * node with nothing left to disprove it, since the check that would clear it only runs for nodes
   * it can still see.
   */
  dropped?: boolean
  /**
   * The LAST refusal reason this node's restart/exit reported (see the store method of the same
   * idea). TRANSIENT — never persisted; absent = no refusal since the last success.
   */
  lastRestartRefusal?: { reason: RestartRefusalReason; detail?: string; at: number }
  /** Which agent this node is running (claude/codex/gemini/…), when known. */
  agentId?: AgentId
  /**
   * Which Claude account this node's session was OBSERVED running under, off any hook event that
   * carried one (`NormalizedAgentEvent.account`, derived from the hook's `transcript_path`).
   *
   * PERSISTED beside `agentId`, and durable for the same reason: a hand-launched
   * `CLAUDE_CONFIG_DIR=~/.claude-2 claude` in a PLAIN terminal has its identity nowhere else —
   * the node carries no `data.accountId`, and tmux keeps the session alive across an app restart
   * that will see no further event until the user next talks to it. Without this the chip and the
   * account-scoped transcript readers would silently fall back to the system account after every
   * relaunch.
   *
   * Deliberately NOT cleared at a session end (same rule as `agentId`): identity survives turn
   * boundaries, and a new session in the same pane overwrites it with its own observation.
   *
   * A LABEL, never a gate — see `ObservedClaudeAccount` in shared/types.
   */
  account?: ObservedClaudeAccount
  /** A turn finished / needs attention while the user wasn't looking. */
  unread: boolean
  /** Claude's own session name/title (from the terminal title), shown beside the title. */
  session?: string
  /** Claude session id (from hooks) — used to resume/branch the conversation. */
  sessionId?: string
  /**
   * Deterministic hook-reply approval ticket (docs/hook-reply-approvals.md). Set while the node is
   * `blocked` on a Claude permission request whose managed hook is holding open; the header's
   * Approve/Deny buttons answer it. TRANSIENT — never persisted, and cleared the moment the node
   * leaves `blocked` (so the buttons vanish once the decision lands). Absent = legacy prompt path.
   */
  pendingId?: string
  /**
   * The station's LAST turn ended on an API/model error (issue #521) — set from the agent's own
   * `StopFailure` hook, cleared by the next genuine new turn.
   *
   * An annotation beside `state`, never a fifth `AgentState`: an errored station **is** idle, so
   * the two facts coexist. Before it existed, a station whose first turn died was byte-identical
   * to one that had finished — the orchestrator's `--after` dependents fired on an upstream that
   * had produced nothing, and started a whole dependency chain on bad ground. That is what
   * `depSatisfied` now refuses (`renderer/lib/pendingLaunch.ts`).
   *
   * TRANSIENT, like `state` itself, and for the same reason `lastEventAt` is: after a relaunch no
   * hook has spoken, nothing armed can fire anyway, and a verdict restored from disk would
   * describe a turn from another app run.
   *
   * `at` only. Whether the hook payload carries the failure text has not been measured, and
   * `last_assistant_message` is the previous assistant turn rather than the error — see
   * `NormalizedAgentEvent.errored`. Reading the error itself is still owed.
   */
  lastTurnError?: { at: number }
  /** Set when running /loop, /schedule or /cron (heuristic); shown as a connected node. */
  loop?: {
    count: number
    kind: 'loop' | 'schedule' | 'cron'
    /**
     * The user dismissed the CARD, but the job itself is still out there. Only `cron`/`schedule`
     * ever carry this: those outlive turns, sessions and app restarts, so "I don't want to look at
     * this card" and "this job is gone" are different statements — and the card's × has always
     * said so ("does not remove the job"). An in-session `/loop` still clears outright; it dies
     * with its session anyway.
     *
     * It matters beyond the card: `loop` is the ONLY record that this node has a wakeup pending,
     * and it is what stops Eco mode from hibernating it (terminating the CLI process also kills the
     * scheduled wakeup dies with it — a silently cancelled job). Clearing the entry on dismiss
     * dropped that guard while the job lived on, so the fact is now retained and only the RENDER
     * filters on it. A real end (CronDelete) still clears the entry.
     */
    dismissed?: boolean
    /** Schedule expression (cron) shown as a sub-label. */
    schedule?: string
    /** The task/prompt — shown in full and re-issued by the node's Play button. */
    task?: string
    /** Per-iteration summaries (in-session /loop). */
    items: string[]
  }
}

export interface AgentStatusStore {
  byId: Record<string, AgentNodeStatus>
  /** The terminal node the user is currently focused in (for unread decisions). */
  activeId: string | null
  setActive(id: string, active: boolean): void
  /** `newTurn` marks a genuine UserPromptSubmit — the only working that may follow a fresh done.
   *  `pendingId` (deterministic approvals) is retained only while `state === 'blocked'`; any other
   *  state clears it, so the header's Approve/Deny buttons disappear as soon as the node moves on.
   *  `verified` is the identity evidence for THIS transition (see `stateVerified`); a caller that
   *  omits it asserts nothing, which is why it is trailing and optional.
   *  `errored` says this `done` came from the agent's `StopFailure` hook (see `lastTurnError`);
   *  `newTurn` retires the previous turn's verdict, so the two are read on the same edge. */
  setState(
    id: string,
    state: AgentState | undefined,
    agentId?: AgentId,
    newTurn?: boolean,
    pendingId?: string,
    verified?: boolean,
    errored?: boolean
  ): void
  /** Clear `working` entries whose last event is older than `staleMs` (lost-Stop safety net). */
  sweepStaleWorking(staleMs?: number): void
  setSession(id: string, session: string): void
  /** Record — or, with `undefined`, FORGET — this node's agent session id. Forgetting is what a
   *  cold-restore resume does when the CLI reports the conversation does not exist (issue #707):
   *  keeping a proven-dead id would make the next cold restore replay the same failed `--resume`. */
  setSessionId(id: string, sessionId: string | undefined): void
  /** Record the Claude account a hook event says this node is running under. Persisted; see
   *  `account`. Idempotent — a re-assert of the same account writes nothing. */
  setAccount(id: string, account: ObservedClaudeAccount): void
  /** Mark the node's agent CLI as exited-for-RAM (true) or live again (false). Persisted.
   *  Waking also restarts the idle clock (`lastEventAt`), so a quiet resumed session is not
   *  re-hibernated on the next sweep. */
  setHibernated(id: string, on: boolean): void
  /** Record what the pane settled to when this node's CLI let go of it (`null` = forget: a stale
   *  value must never permit a wake into a pane we did not measure). See `hibernatedPane`. */
  setHibernatedPane(id: string, pane: string | null): void
  /** Mark the node explicitly paused (true) or resumed (false). Persisted; see `paused`. Waking
   *  restarts the idle clock, same as `setHibernated` — a resumed session must not read as having
   *  been idle since before the pause. */
  setPaused(id: string, on: boolean): void
  /** Record (or withdraw) the verdict that this node's CLI died unannounced. Transient; see
   *  `dropped`. Cheap to call repeatedly — it bails when the flag already reads that way. */
  setDropped(id: string, on: boolean): void
  /** Record that this node just launched a background shell task (see `backgroundTaskAt`).
   *  Transient — nothing is written to localStorage. */
  markBackgroundTask(id: string): void
  markUnread(id: string): void
  /**
   * Drop a node's unread flag. By default a clear of a FINISHED (done) node also ACKs the read
   * cross-surface (dismisses the paired phone's DONE Live Activity via the mirror's `ackDone`).
   * Pass `{ external: true }` for a clear that was ITSELF driven by a phone read-ack the host swept
   * (`agent:unread-clear`): it must NOT re-ack, or host→renderer→ackDone would loop.
   */
  clearUnread(id: string, opts?: { external?: boolean }): void
  /** Start (active=true, resets) or stop a /loop, /schedule or /cron indicator. */
  setLoop(
    id: string,
    active: boolean,
    kind?: 'loop' | 'schedule' | 'cron',
    opts?: { schedule?: string; task?: string }
  ): void
  /** Hide a cron/schedule CARD while keeping the fact that the job exists (see `loop.dismissed`).
   *  No-op if the node has no loop entry. */
  dismissLoopCard(id: string): void
  /** Record a /loop iteration (count++ and append its summary). No-op if not looping. */
  bumpLoop(id: string, message?: string): void
  remove(id: string): void
  /**
   * WHY this node's last restart, model switch or hibernation exit refused — ONE refusal, ONE — ONE refusal, ONE
   * reason. Written by every refusal site in the restart closure (TerminalNode) and the
   * restart/hibernate phases (agent-restart.ts) immediately before their early return, and read
   * by the Canvas notice and the grouped-restart strip so an unexplained ✗ row or the old
   * five-conditions-behind-one-string notice dies. TRANSIENT — never persisted: a stale refusal
   * from before an app reload would explain a restart that never happened. Cleared on a
   * successful restart of the node.
   */
  setLastRestartRefusal(
    id: string,
    refusal: { reason: RestartRefusalReason; detail?: string } | null
  ): void
}

const EMPTY: AgentNodeStatus = { unread: false }
/** The DEFAULT (local-core) persistence key. Only the default instance uses it. */
const KEY = 'nodeterm.agentStatus'
const LEGACY_KEY = 'nodeterm.claudeStatus'

// Claude Code runs hooks in PARALLEL, so the last PostToolUse's POST can arrive after the
// Stop's POST — hold done against any non-newTurn working for this long.
export const DONE_HOLDOFF_MS = 3000
// Last-resort net for a lost Stop POST / crashed CLI: a working entry that saw no event at
// all for this long decays to idle. Long on purpose:
// a single silent tool run (e.g. a long build) fires no hooks between Pre- and PostToolUse,
// so anything shorter would flip genuinely-running turns to idle.
// One rule, three surfaces — the window lives in shared/agents/stale.ts and the mirror's sweep is
// the decider (it fires a synthetic end edge). This local sweeper stays as the renderer's own
// safety net for a badge whose events never reached the mirror.
export const STALE_WORKING_MS = WORKING_STALE_MS
// Esc/Ctrl-C interrupt inference: how long to wait for a hook event before concluding the
// turn was cancelled without a final Stop.
export const INTERRUPT_SETTLE_MS = 1500

/** One-time localStorage migration from the old key. Runs before the default store hydrates —
 *  and ONLY for the default key: a namespaced or keyless instance must never adopt legacy data
 *  that belongs to the local core. */
function migrateLegacyKey(): void {
  try {
    if (!localStorage.getItem(KEY)) {
      const legacy = localStorage.getItem(LEGACY_KEY)
      if (legacy) localStorage.setItem(KEY, legacy)
    }
  } catch {
    /* ignore */
  }
}

/** One session's agent status: its store plus the interrupt-inference helper bound to it. */
export interface AgentStatusSession {
  store: UseBoundStore<StoreApi<AgentStatusStore>>
  /**
   * Esc/Ctrl-C interrupt inference: Claude Code fires NO hook when the user
   * cancels a turn, so a node interrupted mid-work would sit on "working" forever. Called
   * from the terminal's input path on a lone Esc / Ctrl-C: wait one settle window; if the
   * node is still `working` and NOT ONE hook event arrived since the keystroke (stateAt
   * unchanged), conclude the turn was cancelled and flip it to done. A wrong guess
   * self-corrects: the next real hook event sets working again (it's past the holdoff).
   */
  inferInterruptAfterSettle(id: string, settleMs?: number): void
}

/**
 * Build the agent-status store for ONE core. `persistKey` is the localStorage key this
 * instance hydrates from and saves to; `undefined` = in-memory only (load returns nothing,
 * save is a no-op — the instance never touches localStorage). See the module docblock for
 * why only the default instance has a key today.
 */
export function createAgentStatusSession(
  persistKey?: string,
  ackDone?: (nodeId: string) => void
): AgentStatusSession {
  if (persistKey === KEY) migrateLegacyKey()

  function load(): Record<string, AgentNodeStatus> {
    if (!persistKey) return {}
    try {
      const raw = localStorage.getItem(persistKey)
      if (!raw) return {}
      const data = JSON.parse(raw) as Record<string, Partial<AgentNodeStatus>>
      const out: Record<string, AgentNodeStatus> = {}
      for (const [id, v] of Object.entries(data)) {
        out[id] = { unread: !!v.unread, session: v.session, sessionId: v.sessionId, agentId: v.agentId }
        // Minimal shape check, like `loop` below: this file is on disk and hand-editable, and a
        // half-written entry must not put a chip on a node claiming an identity it never had.
        if (
          v.account &&
          typeof v.account === 'object' &&
          typeof v.account.configDir === 'string' &&
          typeof v.account.known === 'boolean'
        ) {
          out[id].account = {
            configDir: v.account.configDir,
            accountId: typeof v.account.accountId === 'string' ? v.account.accountId : null,
            known: v.account.known,
            // `remote` MUST round-trip. This loader rebuilds the object field by field, so a field
            // it forgets is silently dropped — and for this one the dropped value reads as LOCAL,
            // which puts a Link button back on an SSH host's config dir at the first reload and
            // matches it against local accounts again. The absent-is-local default is only correct
            // for an entry written before the field existed, where nothing remote was ever
            // recorded; a `false` is not stored, so those entries hydrate byte-identically.
            ...(v.account.remote ? { remote: true } : {})
          }
        }
        // Only when set: an absent flag stays absent, so an entry saved before this field
        // existed hydrates byte-identically (and `hibernated: false` never grows in the file).
        if (v.hibernated) out[id].hibernated = true
        // Alongside EITHER flag: `hibernated` is the ordinary case (the pane we exited TO), but a
        // `paused` node with `hibernated` unset needs it just as much — the deep "pause & end
        // session" choice, and a shallow pause whose tmux session died in a reboot (`fresh` clears
        // `hibernated` but not `paused`), both leave the wake with a brand-new pane to recognize,
        // and this is the only record of what that pane turned out to be (see the cold-restore
        // gate in TerminalNode.tsx). Meaningless (and, as a wake permission, unwanted) once
        // NEITHER flag holds.
        if ((v.hibernated || v.paused) && typeof v.hibernatedPane === 'string')
          out[id].hibernatedPane = v.hibernatedPane
        // Independent of `hibernated`: the deep "pause & end session" choice recycles the tmux
        // session, so a paused node can perfectly well hydrate with `hibernated` unset.
        if (v.paused) out[id].paused = true
        // A recurring job (cron/schedule — and tmux keeps in-session loops alive too) outlives
        // the app: restore its card. Minimal shape check so a corrupt entry can't break load.
        if (v.loop && typeof v.loop === 'object' && v.loop.kind) {
          out[id].loop = {
            count: v.loop.count ?? 0,
            kind: v.loop.kind,
            schedule: v.loop.schedule,
            task: v.loop.task,
            items: Array.isArray(v.loop.items) ? v.loop.items : []
          }
          // A dismissed card must STAY dismissed across a restart — and the fact it hides
          // (a live cron/schedule job) must stay readable to the hibernation guard.
          if (v.loop.dismissed) out[id].loop.dismissed = true
        }
      }
      return out
    } catch {
      return {}
    }
  }

  // Persist only the durable fields (not the live `state`).
  function save(byId: Record<string, AgentNodeStatus>): void {
    if (!persistKey) return
    try {
      const out: Record<string, Partial<AgentNodeStatus>> = {}
      for (const [id, v] of Object.entries(byId)) {
        if (
          v.unread ||
          v.session ||
          v.sessionId ||
          v.loop ||
          v.agentId ||
          v.account ||
          v.hibernated ||
          v.paused
        ) {
          out[id] = {
            unread: v.unread,
            session: v.session,
            sessionId: v.sessionId,
            agentId: v.agentId,
            // Durable beside `agentId`, and for the same reason (see the field comment): a plain
            // terminal's observed account exists nowhere else, and the tmux session that knows it
            // outlives the app.
            account: v.account,
            loop: v.loop,
            hibernated: v.hibernated,
            // Never written without a flag it belongs to (see `hibernatedPane`'s load comment).
            hibernatedPane: v.hibernated || v.paused ? v.hibernatedPane : undefined,
            paused: v.paused
          }
        }
      }
      localStorage.setItem(persistKey, JSON.stringify(out))
    } catch {
      // ignore quota / serialization errors
    }
  }

  const store = create<AgentStatusStore>((set) => ({
    byId: load(),
    activeId: null,

    setActive: (id, active) =>
      set((s) => {
        if (active) return s.activeId === id ? s : { activeId: id }
        return s.activeId === id ? { activeId: null } : s
      }),

    setState: (id, state, agentId, newTurn, pendingId, verified, errored) =>
      set((s) => {
        const prev = s.byId[id] ?? EMPTY
        const now = Date.now()
        // Does this event change the last-turn verdict (issue #521)? Read up front because the
        // same-state fast path below mutates IN PLACE to avoid a re-render — which is exactly what
        // a badge appearing or disappearing needs, so an event that moves this must not take it.
        const turnErrorMoves =
          errored === true || (newTurn === true && prev.lastTurnError !== undefined)
        // Done-holdoff: a late working event (parallel hook curls arrive out of order, or a
        // tool POST that was in flight when the user interrupted) must not resurrect a turn
        // that just finished. Only a genuine new turn (UserPromptSubmit) may.
        if (
          state === 'working' &&
          !newTurn &&
          prev.state === 'done' &&
          now - (prev.stateAt ?? 0) < DONE_HOLDOFF_MS
        ) {
          return s
        }
        // A re-asserted `blocked` carrying a NEW pendingId (Claude re-asks) must break the fast
        // path so the header buttons retarget the new answer file — otherwise treat same-state as
        // a freshness-only refresh.
        const samePendingWhileBlocked =
          state !== 'blocked' || (pendingId ?? prev.pendingId) === prev.pendingId
        if (
          prev.state === state &&
          (agentId === undefined || prev.agentId === agentId) &&
          samePendingWhileBlocked &&
          !turnErrorMoves
        ) {
          // Same-state event: refresh freshness in place — stateAt is never rendered, and a
          // new object here would re-render every node header on each tool event.
          if (s.byId[id]) {
            s.byId[id].stateAt = now
            // The evidence rides along, in place and for the same reason: a re-assert of the SAME
            // state by a legacy POST must not leave an earlier `true` standing, or this copy would
            // disagree with the mirror the gate actually reads.
            s.byId[id].stateVerified = verified === true
          }
          return s
        }
        // The ONE place a state transition is recorded, so it is also the one place the idle
        // clock is stamped (the same-state fast path above deliberately does not touch it —
        // see `lastEventAt`).
        const next = { ...prev, state, stateAt: now, lastEventAt: now }
        // Written on the same edge the state is — the evidence describes THIS transition, and an
        // absent argument is not evidence.
        next.stateVerified = verified === true
        if (agentId !== undefined) next.agentId = agentId
        // Retain the approval ticket only while blocked; any other state clears it (transient).
        next.pendingId = state === 'blocked' ? (pendingId ?? prev.pendingId) : undefined
        // The last-turn verdict (issue #521). A genuine new turn retires it — the station is being
        // asked something else, and the old failure no longer describes what it is doing. Anything
        // else LEAVES IT STANDING (it rides the spread): the intermediate transitions between the
        // error and the next prompt say nothing about whether that turn produced anything.
        if (newTurn) next.lastTurnError = undefined
        else if (errored) next.lastTurnError = { at: now }
        // A LIVE state is proof the CLI is running, so the hibernated flag is simply wrong and is
        // dropped here — the one self-heal this flag has. It is set by a controller that watched
        // the CLI let go of the pane, but the world moves on without us: the user relaunches the
        // agent by hand, a wake lands and its `--resume` starts reporting, or a resume we could
        // not confirm turns out to have worked. Left standing, the flag is not cosmetic: it
        // renders RUNNING and SLEEPING side by side, and (because a hibernated node is skipped by
        // the sweep) exempts that session from Eco for good.
        // `done` deliberately does NOT clear it — a hibernated node's last known state IS done,
        // and a late Stop POST arriving after the exit would undo the hibernation we just did.
        //
        // ---- a different field, and the opposite rule ----
        //
        // The BACKGROUND-TASK guard is dropped at the START OF THE NEXT TURN — `done` → `working`,
        // and nothing else.
        //
        // Not on `done` itself: that is the launching turn ending while the task runs on, which is
        // precisely the window Eco / the bulk restart would kill it in. A turn start is safe
        // because Claude delivers a finished background task back as a <task-notification>, whose
        // own turn is exactly this `working` — so by the time one begins, the task has reported.
        //
        // Not on EVERY `working` transition either, because `blocked`/`waiting` → `working` is a
        // MID-TURN RESUMPTION. A background Bash whose command needs approval runs
        // UserPromptSubmit(working) → PreToolUse(stamp) → PermissionRequest(blocked) → approve →
        // PostToolUse(working): that last edge would clear the stamp milliseconds after it was
        // set, for exactly the task this guard exists for.
        //
        // And NOT from an unknown previous state, which is the same hole from the other side:
        // `undefined` is reachable MID-TURN — a renderer reload starts with an empty table, and
        // `sweepStaleWorking` blanks a working entry after the stale window — so post-reload a
        // background launch would stamp an entry with no state, and the very next tool event's
        // `working` would read as a turn start and delete it. Requiring `done` makes the miss
        // fail SAFE: every real turn ends Stop → `done`, so the clear still happens, at most one
        // turn late.
        //
        // Deliberately NOT keyed on `newTurn`: the <task-notification> prompt is explicitly not
        // flagged as one (see normalizeClaude), so the intended clear would never fire.
        if (state === 'working' && prev.state === 'done') next.backgroundTaskAt = undefined
        const alive = state === 'working' || state === 'blocked' || state === 'waiting'
        if (alive && prev.hibernated) {
          next.hibernated = undefined
          next.hibernatedPane = undefined // goes with the flag, always
        }
        // Same self-heal, same reasoning: a live hook event is proof the CLI is running, whatever
        // brought it back (our own resume, or the user typing the launch line by hand) — a standing
        // `paused` would be wrong, and (unlike a cold restart) this IS evidence, not a guess.
        if (alive && prev.paused) {
          next.paused = undefined
          // Goes with the flag, UNLESS `hibernated` still owns it (shallow pause clears both flags
          // together above, in which case this is already undefined) — the deep-pause case has no
          // `hibernated` to protect it, so without this an in-memory record describing a pane that
          // is now demonstrably running something else would linger, and stand as permission for
          // the next deep pause to be typed into recognizing a pane it never measured.
          if (!next.hibernated) next.hibernatedPane = undefined
        }
        // A hook event of ANY kind is proof the CLI is alive — it is the CLI that fired it — so a
        // standing DROPPED verdict is withdrawn here, `done` included. That is the one self-heal
        // above which deliberately does NOT gate on `alive`: `done` must not clear `hibernated`
        // (a late Stop POST would undo a hibernation we just performed), but it absolutely does
        // disprove "this pane has no CLI in it". Nothing is saved — the flag is transient.
        if (prev.dropped) next.dropped = undefined
        const byId = { ...s.byId, [id]: next }
        // `state` itself is transient, so a plain transition writes nothing — but dropping a
        // PERSISTED flag has to reach disk, or a relaunch would restore a hibernated/paused node
        // that has been demonstrably running since.
        if (alive && (prev.hibernated || prev.paused)) save(byId)
        return { byId }
      }),

    sweepStaleWorking: (staleMs = STALE_WORKING_MS) =>
      set((s) => {
        const now = Date.now()
        let changed = false
        const byId = { ...s.byId }
        for (const [id, v] of Object.entries(byId)) {
          if (v.state === 'working' && now - (v.stateAt ?? 0) > staleMs) {
            // This is a real transition to Unknown, even though it did not arrive through a hook.
            // Stamp both clocks so the sidebar age and Eco idle clock begin at the transition.
            byId[id] = { ...v, state: undefined, stateAt: now, lastEventAt: now }
            changed = true
          }
        }
        return changed ? { byId } : s
      }),

    setSession: (id, session) =>
      set((s) => {
        const prev = s.byId[id] ?? EMPTY
        if (prev.session === session) return s
        const byId = { ...s.byId, [id]: { ...prev, session } }
        save(byId)
        return { byId }
      }),

    setSessionId: (id, sessionId) =>
      set((s) => {
        const prev = s.byId[id] ?? EMPTY
        if (prev.sessionId === sessionId) return s
        const byId = { ...s.byId, [id]: { ...prev, sessionId } }
        save(byId)
        return { byId }
      }),

    setAccount: (id, account) =>
      set((s) => {
        const prev = s.byId[id] ?? EMPTY
        const cur = prev.account
        // Same-account events are the common case (every hook POST of every turn carries one), so
        // bail before allocating: a new object here would re-render every consumer of this node's
        // status on each tool event, for a value that did not change.
        if (
          cur &&
          cur.configDir === account.configDir &&
          cur.accountId === account.accountId &&
          cur.known === account.known
        ) {
          return s
        }
        const byId = { ...s.byId, [id]: { ...prev, account } }
        save(byId)
        return { byId }
      }),

    setHibernated: (id, on) =>
      set((s) => {
        const prev = s.byId[id] ?? EMPTY
        if (!!prev.hibernated === on) return s
        // The renderer owns this flag; the core only mirrors it (agent-status mirror → SLEEPING on
        // the phone). Reported on the same edge the store changes, guarded because tests (and any
        // non-preload context) run this store without a bridge.
        try {
          window.nodeTerminal?.reportHibernated?.(id, on)
        } catch {
          /* the mirror is a side-channel; a failed report must never break the store */
        }
        // Cleared by dropping the key, not by storing `false`: `save` skips entries that carry
        // nothing durable, so a woken node leaves no residue behind in localStorage.
        // The recorded pane belongs to THIS hibernation: it goes with the flag, in both
        // directions. Kept past a wake it would be a standing permission to type into whatever
        // that string names, long after we measured it.
        const next: AgentNodeStatus = {
          ...prev,
          hibernated: on ? true : undefined,
          // Hibernating KEEPS what the exit closure just recorded; waking drops it.
          hibernatedPane: on ? prev.hibernatedPane : undefined
        }
        // Waking RESTARTS the idle clock. Without this, a node whose conversation was resumed but
        // whose CLI then sits quiet (an agent that fires no hook until you talk to it) still
        // carries the `lastEventAt` from before it was hibernated — hours old — so the very next
        // sweep, 60 s later, would quit the session the user just came back to. Hibernating does
        // not touch the clock: nothing happened in that session, and the flag itself is what keeps
        // the sweep off it.
        if (!on) next.lastEventAt = Date.now()
        const byId = { ...s.byId, [id]: next }
        save(byId)
        return { byId }
      }),

    setHibernatedPane: (id, pane) =>
      set((s) => {
        const prev = s.byId[id] ?? EMPTY
        const next = pane ?? undefined
        if (prev.hibernatedPane === next) return s
        const byId = { ...s.byId, [id]: { ...prev, hibernatedPane: next } }
        save(byId)
        return { byId }
      }),

    setPaused: (id, on) =>
      set((s) => {
        const prev = s.byId[id] ?? EMPTY
        if (!!prev.paused === on) return s
        // Cleared by dropping the key, not by storing `false` — same reasoning as `setHibernated`:
        // `save` skips entries with nothing durable, so a resumed node leaves no residue.
        const next: AgentNodeStatus = { ...prev, paused: on ? true : undefined }
        // Resuming restarts the idle clock — a session that sat paused for hours must not read as
        // having been idle that whole time on the very next Eco sweep.
        if (!on) {
          next.lastEventAt = Date.now()
          // Drop the recorded pane too, UNLESS `hibernated` still owns it (a resume normally clears
          // both flags together, in which case `setHibernated(id, false)` already dropped this —
          // but `setPaused` must be correct standing alone, for the deep-pause case where
          // `hibernated` was never set and this is the only owner).
          if (!prev.hibernated) next.hibernatedPane = undefined
        }
        const byId = { ...s.byId, [id]: next }
        save(byId)
        return { byId }
      }),

    setDropped: (id, on) =>
      set((s) => {
        const prev = s.byId[id] ?? EMPTY
        // Bail when nothing changes: the liveness check re-asks on every reveal and on a timer, so
        // the overwhelmingly common call is "still fine, still fine" — and a fresh entry object
        // each time would re-render the node (and the minimap) for no news.
        if (!!prev.dropped === on) return s
        // Transient: cleared by dropping the key, and NO `save()` — see the field comment. An entry
        // holding nothing else durable must not be conjured onto disk by a pane reading.
        return { byId: { ...s.byId, [id]: { ...prev, dropped: on ? true : undefined } } }
      }),

    markBackgroundTask: (id) =>
      set((s) => {
        const prev = s.byId[id] ?? EMPTY
        // Transient (see `backgroundTaskAt`) — no save(): a stamp restored from disk would exempt
        // the node from Eco forever.
        return { byId: { ...s.byId, [id]: { ...prev, backgroundTaskAt: Date.now() } } }
      }),

    markUnread: (id) =>
      set((s) => {
        const prev = s.byId[id] ?? EMPTY
        if (prev.unread) return s
        const byId = { ...s.byId, [id]: { ...prev, unread: true } }
        save(byId)
        return { byId }
      }),

    clearUnread: (id, opts) =>
      set((s) => {
        const prev = s.byId[id]
        if (!prev) return s
        // Cross-surface ACK: opening a session marks its finish read EVERYWHERE — the notch
        // capsule's green blob, the paired phone's lingering DONE Live Activity, and its Inbox
        // Finished card (all via the core mirror's `ackDone`). This is READ state only: the live
        // workflow state remains `done` until a genuine new turn begins.
        //
        // Deliberately gated on NOTHING but the external flag:
        //  - not on the unread flag, because a session you were LOOKING at when it finished never
        //    got marked unread (the `watching` gate in Canvas), so opening it is the only local
        //    read signal there will ever be;
        //  - not on the node's current state, because a node whose PREVIOUS turn finished while a
        //    new one is already running left the phone showing a Finished card for a result the
        //    user had open on screen.
        // `ackDone` is a no-op when the node has no unresolved done event, and it only ever
        // resolves `done` events — a live approval/question card is untouched.
        //
        // SUPPRESSED for an `external` clear — one the host drove FROM a phone read-ack it swept
        // (`agent:unread-clear`): re-acking would loop host→renderer→ackDone straight back.
        if (!opts?.external) ackDone?.(id)
        if (!prev.unread) return s
        const byId = { ...s.byId, [id]: { ...prev, unread: false } }
        save(byId)
        return { byId }
      }),

    setLoop: (id, active, kind = 'loop', opts) =>
      set((s) => {
        const prev = s.byId[id] ?? EMPTY
        if (active) {
          const byId = {
            ...s.byId,
            [id]: {
              ...prev,
              loop: { count: 0, kind, schedule: opts?.schedule, task: opts?.task, items: [] }
            }
          }
          save(byId)
          return { byId }
        }
        if (!prev.loop) return s
        const { loop: _drop, ...rest } = prev
        const byId = { ...s.byId, [id]: rest }
        save(byId)
        return { byId }
      }),

    dismissLoopCard: (id) =>
      set((s) => {
        const prev = s.byId[id]
        if (!prev?.loop || prev.loop.dismissed) return s
        const byId = { ...s.byId, [id]: { ...prev, loop: { ...prev.loop, dismissed: true } } }
        save(byId)
        return { byId }
      }),

    bumpLoop: (id, message) =>
      set((s) => {
        const prev = s.byId[id]
        // Only count in-session /loop turns; /schedule and /cron run in the background.
        if (!prev?.loop || prev.loop.kind !== 'loop') return s
        const items = message
          ? [...prev.loop.items, message.trim().slice(0, 4000)].slice(-100)
          : prev.loop.items
        const byId = {
          ...s.byId,
          [id]: { ...prev, loop: { ...prev.loop, count: prev.loop.count + 1, items } }
        }
        save(byId)
        return { byId }
      }),

    remove: (id) =>
      set((s) => {
        if (!(id in s.byId)) return s
        const byId = { ...s.byId }
        delete byId[id]
        save(byId)
        return { byId }
      }),
    setLastRestartRefusal: (id, refusal) =>
      set((s) => {
        const prev = s.byId[id]
        if (!prev && !refusal) return s
        const next: AgentNodeStatus = {
          ...prev ?? EMPTY,
          lastRestartRefusal: refusal ? { ...refusal, at: Date.now() } : undefined
        }
        // No persistence — see the field's JSDoc.
        return { byId: { ...s.byId, [id]: next } }
      })
  }))

  function inferInterruptAfterSettle(id: string, settleMs = INTERRUPT_SETTLE_MS): void {
    const st = store.getState().byId[id]
    if (st?.state !== 'working') return
    const baseline = st.stateAt
    setTimeout(() => {
      const cur = store.getState()
      const now = cur.byId[id]
      if (now?.state === 'working' && now.stateAt === baseline) {
        cur.setState(id, 'done', now.agentId)
      }
    }, settleMs)
  }

  return { store, inferInterruptAfterSettle }
}

/** One instance per api OBJECT — the one-store-per-core guarantee, keyed on identity exactly
 *  like presence's (a WeakMap, so a dropped api never pins its store). Seeded below with
 *  `window.nodeTerminal → defaultAgentStatus`. */
const instanceByApi = new WeakMap<NodeTerminalApi, AgentStatusSession>()

/**
 * The agent-status store for ONE core (one api). MEMOIZED BY API IDENTITY: the session
 * registry resolves its store here, so ANY session handed the local api — the local session
 * itself, a loopback debug session, a test double — shares the default (persisted) instance
 * rather than growing a parallel table the canvas listener isn't driving. A DIFFERENT api (a
 * different core, a different node-id space) gets a fresh KEYLESS instance: a remote core's
 * status must never clobber the local user's persisted unread/session under `KEY` (see the
 * module docblock). A nullish api (node-environment tests) is not memoizable and gets a
 * fresh inert instance.
 */
export function agentStatusForApi(api: NodeTerminalApi): AgentStatusSession {
  const existing = api ? instanceByApi.get(api) : undefined
  if (existing) return existing
  // Keyless — remote status is never persisted (4a) — but the done-read ack routes to THAT core's
  // api (a remote/relay core acks on its own host), so reading a finished remote session dismisses
  // its phone activity too. A nullish api (node-env tests) gets no ack.
  const session = createAgentStatusSession(undefined, api ? (id) => api.ackDone(id) : undefined)
  if (api) instanceByApi.set(api, session)
  return session
}

/**
 * The DEFAULT instance — the local core's agent status, persisted under the historical key
 * (with the one-time legacy-key migration). Every historical export below resolves to this
 * exact object, so the existing single-session consumers are untouched. Seeding the WeakMap
 * with `window.nodeTerminal` (safe at module load for the boot-order reason documented in
 * localSession.ts; the `typeof window` guard covers node-environment tests) is what makes
 * `agentStatusForApi(window.nodeTerminal)` — the session registry's local session — resolve
 * here, never to a parallel twin.
 */
// The default (local core) acks the finished-session read to `window.nodeTerminal.ackDone` — guarded
// for node-environment tests where no preload exists (the callback is invoked later, at clear time).
const defaultAgentStatus = createAgentStatusSession(KEY, (id) => {
  if (typeof window !== 'undefined') window.nodeTerminal?.ackDone?.(id)
})
export { defaultAgentStatus }
if (typeof window !== 'undefined' && window.nodeTerminal) {
  instanceByApi.set(window.nodeTerminal as NodeTerminalApi, defaultAgentStatus)
}

export const useAgentStatus = defaultAgentStatus.store
export const inferInterruptAfterSettle = defaultAgentStatus.inferInterruptAfterSettle
