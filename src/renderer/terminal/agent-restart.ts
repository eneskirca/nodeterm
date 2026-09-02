/**
 * Pure helpers for restarting an agent CLI IN PLACE inside its tmux pane — quit the CLI, then
 * relaunch it with the provider's own `--resume`, so a newly released model shows up in the CLI's
 * model list without losing the conversation. Kept free of DOM/IPC so the node menu, the bulk
 * filter and the restart choreography can all share exactly one set of rules.
 */
import {
  canResume,
  canResumeWith,
  capabilityAgentId,
  resumeCommand,
  type AgentId
} from '../../shared/agents/config'
import { isShellCommand } from '@shared/agents/pane'
import {
  DELIVERY_ATTEMPTS,
  KILL_LINE,
  VERIFY_TIMEOUT_MS,
  deliverCommand,
  type DeliveryIo
} from './command-delivery'

/** In-band exit command per agent CLI. Only agents listed here can be restarted in place —
 *  an unknown CLI has no safe way to be asked to quit. One entry turns on both surfaces at once:
 *  the single-node "Restart agent (resume)" row in the node context menu, and the bulk "restart
 *  idle agents" action (pane menu + command palette). There is no header button for either —
 *  `HIDEABLE_HEADER_BUTTONS` is refresh / mic / ai-name / comments. The matching relaunch line
 *  always comes from `resumeCommand`.
 *
 *  Each value is the CLI's own DOCUMENTED PRIMARY, and is sent BARE:
 *    - grok:   `/quit` (its `/exit` is an alias).
 *    - gemini: `/quit` (alias `/exit`), measured in its bundled `docs/reference/commands.md:325`.
 *    - devin:  `/exit` (alias `/quit`), measured in its bundled
 *              `share/devin/docs/reference/commands.mdx:439` (CLI 3000.4.25): "Exit the
 *              application (alias: `/quit`)" — it takes NO arguments. Devin's destructive command
 *              is a SEPARATE verb, `/rm-session <id>` ("Irreversibly delete a session and all its
 *              data"), which nothing here may ever emit.
 *
 *  Bare is a safety rule, not a style: gemini's `/quit` also takes a `--delete` flag that exits AND
 *  *permanently deletes* the session's history and temporary files — the very conversation the
 *  `--resume` behind it is meant to return to. Nothing may append arguments to a value here. */
const EXIT_SEQUENCES: Record<string, string> = {
  claude: '/exit',
  codex: '/quit',
  grok: '/quit',
  gemini: '/quit',
  copilot: '/exit',
  opencode: '/exit',
  devin: '/exit'
}

export function exitSequence(agentId: string): string | null {
  // Resolve through the BASE harness so a custom agent that inherits claude (e.g. a proxy wrapper)
  // exits with claude's `/exit` — its own CLI grammar is claude's. A baseless custom agent has no
  // exit sequence (no safe way to ask an unknown CLI to quit) and returns null, as before.
  return EXIT_SEQUENCES[capabilityAgentId(agentId)] ?? null
}

/** Re-exported, not redefined: it lives in `@shared/agents/pane` so the main process can ask the
 *  same question, and `lib/sessionRename.ts` (plus this module's own tests) import it from here. */
export { isShellCommand }

export type IneligibleReason = 'working' | 'no-session' | 'not-resumable'

/** States in which the pane must be left alone. `blocked` is here for a sharper reason than
 *  politeness: it means a permission / question dialog owns the prompt (see normalize.ts —
 *  Claude's PermissionRequest, codex's permission.asked / question.asked, gemini's
 *  Notification/ToolPermission), so writing the exit line would be typed AS THE ANSWER to that
 *  dialog instead of quitting the CLI — whichever line it is (`/exit` for claude, `/quit` for the
 *  rest). Both states report the reason `'working'`: to the user they are the same "busy, try
 *  again in a moment". */
const BUSY_STATES = new Set(['working', 'blocked'])

/** Single gate shared by the node menu, the bulk filter and the choreography itself.
 *  `not-resumable` wins over the other two: a CLI we cannot quit or resume can never be
 *  restarted, so there is nothing for the user to fix by waiting or picking another node. */
export function restartEligibility(
  agentId: string | undefined,
  state: string | undefined,
  sessionId: string | undefined
): { ok: true } | { ok: false; reason: IneligibleReason } {
  if (!agentId || !canResume(agentId) || !exitSequence(agentId))
    return { ok: false, reason: 'not-resumable' }
  // Quitting mid-turn would abandon work the agent is in the middle of; quitting a blocked
  // session would answer its dialog with the exit command (see BUSY_STATES).
  if (BUSY_STATES.has(state ?? '')) return { ok: false, reason: 'working' }
  // Without a provider session id there is nothing to resume into.
  if (!sessionId) return { ok: false, reason: 'no-session' }
  return { ok: true }
}

/**
 * Prefer the live hook-reported id, then the caller-chosen id persisted on the node. Copilot and
 * modern Claude can start with a minted id before their first hook lands; making each menu/closure
 * rediscover this fallback separately would make one of them offer a restart that the other
 * refuses. `restartEligibility` remains the interpolation guard for the chosen value.
 */
export function restartSessionId(live: unknown, persisted: unknown): string | undefined {
  if (typeof live === 'string' && live.trim()) return live.trim()
  if (typeof persisted === 'string' && persisted.trim()) return persisted.trim()
  return undefined
}

export type RestartOutcome = 'restarted' | 'exit-timeout' | 'not-eligible'

export const RESTART_EXIT_TIMEOUT_MS = 6000
export const RESTART_POLL_MS = 250

/** How long the resume delivery may take before this restart stops waiting for it. The delivery's
 *  own retry chain is bounded (DELIVERY_ATTEMPTS × VERIFY_TIMEOUT_MS, then a fail-open submit), so
 *  the slack is only there to let the last attempt land. A backstop, not a policy: nothing in a
 *  restart may wait forever — the awaiting node is held un-restartable and, in a bulk run, every
 *  node after it is blocked and the summary the user is waiting for never arrives. */
export const RESTART_DELIVERY_TIMEOUT_MS = DELIVERY_ATTEMPTS * VERIFY_TIMEOUT_MS + 1000

/**
 * One bounded pane query. Unbounded, a wedged tmux server (or a relay whose IPC never answers)
 * would hang the restart — and with it the bulk run's summary — forever. A lapsed, failed or
 * empty query reads as `null`: "we cannot see this pane right now".
 *
 * Exported for hibernation's WAKE, which asks the same question for a sharper reason: hours pass
 * between the exit and the resume, so the pane may since have been given to vim, to `top`, or to a
 * CLI the user launched by hand — and the resume's first write is un-KILL_LINE'd, so it would be
 * spliced into whatever is there. One definition, not a second copy in the node (a duplicated rule
 * drifts; see CLAUDE.md's "Adding a new agent" rule 10).
 */
export async function queryPaneWithin(
  fn: () => Promise<string | null>,
  ms: number
): Promise<string | null> {
  let lapse: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      fn(),
      new Promise<null>((r) => {
        lapse = setTimeout(() => r(null), ms)
      })
    ])
  } catch {
    return null // transient IPC failure — same reading as "cannot see it"
  } finally {
    clearTimeout(lapse)
  }
}

/** The exit half's own outcomes. `'exited'` means only that the CLI let go of the pane — the
 *  conversation is not back until the resume half has delivered. */
export type ExitPhaseOutcome = 'exited' | 'exit-timeout' | 'not-eligible'

/** The resume half's own outcomes. `'not-eligible'` covers both refusals: a session id that could
 *  never reach a command line, and a pane that stopped existing under the delivery. */
export type ResumePhaseOutcome = 'resumed' | 'not-eligible'

/**
 * PHASE 1 — ask the agent to quit and wait until the CLI has let go of the pane. Never
 * force-kills: on timeout the CLI is left running and the caller reports the node. Once the exit
 * has been sent, `paneCommand` errors count as "not a shell yet"; the timeout is the backstop.
 *
 * NOTHING is written until one `paneCommand` has come back non-null. The exit command is
 * irreversible — the conversation is only recoverable through the `--resume` that follows it — so
 * a pane we cannot WATCH must never be quit: with tmux switched off in Settings, or absent from
 * the machine, the query answers null forever, and quitting first would leave the agent dead, the
 * relaunch never sent, and the user told (after 6s of polling) that "the session was left
 * running". The pre-flight makes that state a plain `'not-eligible'`, with an untouched pane.
 *
 * The bare `resumeCommand` is a gate HERE too, not only in the resume half: a session this app
 * would refuse to resume must not be exited either, or the exit alone would lose it. Hibernation
 * (which quits a pane it means to bring back later) depends on that refusal being decided before
 * the first byte is written.
 */
export async function performExitPhase(d: {
  agentId: string
  sessionId: string
  io: DeliveryIo
  paneCommand: () => Promise<string | null>
  timeoutMs?: number
  pollMs?: number
  /**
   * "Is the pane we are quitting still there?" — asked before the exit is written and on every
   * poll. A session can die under a restart (the node is deleted or respawned, or another client
   * destroys the tmux session), and there is then no pane left to fail in.
   */
  isLive?: () => boolean
}): Promise<ExitPhaseOutcome> {
  const exit = exitSequence(d.agentId)
  // The eligibility GATE (not the command): `canResumeWith` validates the session id the way
  // `resumeCommand` does, without building the command — which for a custom agent needs its
  // `launchCmd` from settings (unavailable in this pure module). The typed resume line is the
  // caller's job (`performResumePhase` takes it as `d.command`); the exit half only needs to know
  // the session is one we WOULD resume into, so it does not quit a conversation it cannot bring back.
  if (!exit || !canResumeWith(d.agentId, d.sessionId)) return 'not-eligible'
  const timeoutMs = d.timeoutMs ?? RESTART_EXIT_TIMEOUT_MS
  const pollMs = d.pollMs ?? RESTART_POLL_MS
  // A dead session is not a restart that failed — there is no pane left to fail in. `'not-eligible'`
  // (uncounted) rather than `'exit-timeout'`, which claims something sharper and false: that the CLI
  // is still running and refused to quit, sending the user to look at a pane that is gone.
  const gone = (): boolean => !!d.isLive && !d.isLive()
  if (gone()) return 'not-eligible'
  // ── Pre-flight: prove we can SEE this pane before quitting anything in it (see the header).
  // Reported as `'not-eligible'`, the outcome that means "not a target right now" and is the one
  // the menu and the notice already have wording for. Nothing has been written at this point.
  const before = await queryPaneWithin(d.paneCommand, timeoutMs)
  if (before === null || gone()) return 'not-eligible'
  // Clear the prompt before typing the exit command. The pane is a REPL the user types into: a
  // half-written prompt left in it would otherwise be submitted as `…refactor the/exit` — the
  // draft lost and a real turn started (tokens, possibly edits) — and the CLI, still running,
  // would then be reported as an exit timeout.
  //
  // ASSUMPTION, unverified on a real build: Ctrl-U is "clear line" inside every TUI in
  // EXIT_SEQUENCES (claude, codex, grok, gemini, devin) — it is in every readline/ZLE prompt, and it is
  // what command-delivery.ts already relies on for its rewrites. Each agent added to that table
  // inherits this assumption; only a device check retires it, per agent. If a TUI binds Ctrl-U to
  // something else this becomes one stray keystroke before the exit command — no worse than
  // today's blind write. Belongs in the manual test matrix.
  d.io.write(KILL_LINE)
  // opencode's TUI does not submit when text and CR arrive in the same input burst
  // (batched-input handling). Measured on 1.18.18-1.18.25, Linux, tmux, isolated socket:
  // one-burst `/exit\r` leaves `/exit` in the composer with popup armed and times out
  // at 6s; splitting CR by 100ms exits in ~500ms. The resume half already uses
  // echo-verified delivery (command-delivery.ts) for this shape; for exit we keep
  // the minimal split so the other agents' blind-write contract stays unchanged.
  if (d.agentId === 'opencode') {
    d.io.write(exit)
    await new Promise((r) => setTimeout(r, 150))
    if (gone()) return 'not-eligible'
    d.io.write('\r')
  } else {
    d.io.write(exit + '\r')
  }
  const deadline = Date.now() + timeoutMs
  let last: string | null = null
  for (;;) {
    await new Promise((r) => setTimeout(r, pollMs))
    const pane = await queryPaneWithin(d.paneCommand, Math.max(0, deadline - Date.now()))
    if (gone()) return 'not-eligible' // stop polling a pane that no longer exists
    // Two ways to know the CLI let go of the pane. The allowlist is the confident one and is
    // taken immediately. The other — "the foreground command is no longer what it was before the
    // exit" — covers the shells the allowlist cannot know (`nu`, `xonsh`, `pwsh`, anything the
    // user set as `defaultShell`), where waiting for a listed shell would time out with the agent
    // already quit and never resumed. It is required on two CONSECUTIVE polls: a single changed
    // reading can be a momentary foreground child of a still-running CLI, and typing the resume
    // line into a live CLI would send it as a message.
    if (isShellCommand(pane)) return 'exited'
    if (pane !== null && pane !== before && pane === last) return 'exited'
    last = pane
    if (Date.now() > deadline) return 'exit-timeout'
  }
}

/**
 * PHASE 2 — echo-deliver the resume command into a pane the CLI has already let go of.
 *
 * Deliberately NOT gated on `exitSequence`: this half only types a launch line into a pane that is
 * already free, so a CLI we have no way to ASK to quit is still perfectly resumable here (the exit
 * half owns that question). What gates this half is the bare `resumeCommand` below — the session id
 * has to be one this app would put on a command line. Hibernation's wake path relies on the split:
 * it drives this half alone, hours after the exit.
 *
 * Resolves only once the resume line has actually LEFT the pane (deliverCommand's echo-verify
 * retries run for up to DELIVERY_ATTEMPTS × VERIFY_TIMEOUT_MS after the first write). The
 * un-submitted line is the pane's most fragile moment — anything typed into it during that window
 * is spliced into the command — so "this delivery is over" must mean it settled, not that it was
 * started. `guardConcurrentRestart` frees the node on exactly that boundary.
 */
export async function performResumePhase(d: {
  agentId: string
  sessionId: string
  io: DeliveryIo
  /**
   * The exact launch line to relaunch with, when the caller has one. `withPermissionMode` is the
   * app's single funnel for every CLI launch, and it needs the ACTIVE mode — an async read that
   * belongs to the node, not to this module. Without it a canvas running in `acceptEdits` / `plan`
   * would come back from a bulk restart in the default mode and start prompting.
   *
   * Eligibility is still decided by the bare `resumeCommand` below: a session id this app would
   * not put on a command line (SAFE_SESSION_ID) refuses the delivery before anything is written,
   * whatever the caller passes.
   */
  command?: string
  /** Backstop for the resume delivery; see RESTART_DELIVERY_TIMEOUT_MS. */
  deliveryTimeoutMs?: number
  /**
   * Handed `deliverCommand`'s cancel the moment a delivery starts — and only then. The delivery
   * outlives this promise (it runs on its own echo-verify timers), so its lifetime belongs to
   * whoever owns the transport: a node torn down mid-restart cancels it here instead of letting
   * a retry rewrite, or the fail-open submit, land in a dead session.
   */
  onDelivery?: (cancel: () => void) => void
  /**
   * Asked once more after the delivery, before a resume is reported: a session that died under it
   * had the delivery cancelled by the teardown, so nothing reached the pane and reporting success
   * would put a phantom in the bulk summary.
   */
  isLive?: () => boolean
}): Promise<ResumePhaseOutcome> {
  // The eligibility GATE (see performExitPhase): `canResumeWith` validates the session id without
  // building the command. The typed line is the caller's `d.command`; for a builtin with no
  // override, `resumeCommand` supplies the bare resume command. A custom agent MUST pass
  // `d.command` (its baseAgent-aware line, built by `assembleResumeCommand` in the node) — it has
  // no `resumeCommand` here, so a missing `command` for a custom agent refuses before any write.
  if (!canResumeWith(d.agentId, d.sessionId)) return 'not-eligible'
  const base = resumeCommand(d.agentId, d.sessionId)
  const cmd = d.command ?? base
  if (!cmd) return 'not-eligible'
  const gone = (): boolean => !!d.isLive && !d.isLive()
  // Awaited, not fire-and-forget: see the header. `deliverCommand` is started inside the executor
  // (synchronously, so `onDelivery` still hands the cancel out before any await) and announces the
  // end of the delivery — submitted, fail-open or cancelled — through `settle`.
  await new Promise<void>((resolve, reject) => {
    let lapse: ReturnType<typeof setTimeout> | undefined
    let settled = false
    let started = false
    // A settle announced from INSIDE deliverCommand's synchronous body is only applied below,
    // after it has returned: that body can announce the end of the delivery and then throw (a
    // transport that rejects the very first write ends the delivery, then reports), and a promise
    // resolved first could no longer be rejected — the restart would claim success for a resume
    // line that never reached the pane.
    const settle = (): void => {
      settled = true
      if (!started) return
      clearTimeout(lapse)
      resolve()
    }
    try {
      // Two statements on purpose: `d.onDelivery?.(deliverCommand(…))` short-circuits the ARGUMENT
      // too when no callback was passed — nothing would be delivered and this promise would never
      // settle.
      const cancelDelivery = deliverCommand(d.io, cmd, settle)
      started = true
      d.onDelivery?.(cancelDelivery)
    } catch (e) {
      reject(e) // the caller counts a failure; no timer has been armed yet
      return
    }
    if (settled) return resolve() // an io that echoes inside write() finishes the delivery there
    // Bounded even so. The delivery's own retry chain is finite, but this await holds the node
    // (and, in a bulk run, every node after it and the summary), so it must not depend on a third
    // party announcing itself.
    lapse = setTimeout(resolve, d.deliveryTimeoutMs ?? RESTART_DELIVERY_TIMEOUT_MS)
  })
  // The session can have died while the line was being verified — the delivery is then cancelled by
  // the teardown and nothing reached the pane, so don't claim a resume.
  return gone() ? 'not-eligible' : 'resumed'
}

/**
 * In-place CLI restart: the two phases above, in order. Ask the agent to quit, wait until the CLI
 * has let go of the pane (`performExitPhase`), then echo-deliver the resume command into it
 * (`performResumePhase`). Composition only — every rule lives in one of the two halves, and this
 * function's four outcomes are unchanged: `'exited'` continues, anything else from the exit half
 * is passed through as-is, and a `'resumed'` is what the caller reads as `'restarted'`.
 *
 * No gate of its own: `performExitPhase` refuses (writing nothing) on exactly the same two facts —
 * no exit sequence, or a session id `resumeCommand` would not put on a command line — and it runs
 * first, so a copy here could only drift. Both halves re-check for themselves because either can be
 * driven directly: hibernation quits a pane in one phase and resumes it much later in the other.
 */
export async function performRestartResume(d: {
  agentId: string
  sessionId: string
  io: DeliveryIo
  paneCommand: () => Promise<string | null>
  /** See `performResumePhase`: the caller's launch line (permission mode), gated by the bare one. */
  command?: string
  timeoutMs?: number
  pollMs?: number
  /** Backstop for the resume delivery; see RESTART_DELIVERY_TIMEOUT_MS. */
  deliveryTimeoutMs?: number
  /** Handed `deliverCommand`'s cancel as the delivery starts; see `performResumePhase`. */
  onDelivery?: (cancel: () => void) => void
  /**
   * "Is the pane we are restarting still there?" — asked before the exit is written, on every
   * poll, and once more after the delivery, before a restart is reported. A session can die under
   * a restart (the node is deleted or respawned, or another client destroys the tmux session): its
   * io then silently no-ops and reporting `'restarted'` would put a phantom in the bulk summary.
   */
  isLive?: () => boolean
}): Promise<RestartOutcome> {
  const exited = await performExitPhase({
    agentId: d.agentId,
    sessionId: d.sessionId,
    io: d.io,
    paneCommand: d.paneCommand,
    timeoutMs: d.timeoutMs,
    pollMs: d.pollMs,
    isLive: d.isLive
  })
  // `'exit-timeout'` / `'not-eligible'` mean the same things they always did, so they are the
  // restart's outcome verbatim — nothing has been resumed and nothing more may be written.
  if (exited !== 'exited') return exited
  const resumed = await performResumePhase({
    agentId: d.agentId,
    sessionId: d.sessionId,
    io: d.io,
    command: d.command,
    deliveryTimeoutMs: d.deliveryTimeoutMs,
    onDelivery: d.onDelivery,
    isLive: d.isLive
  })
  return resumed === 'resumed' ? 'restarted' : resumed
}

// ── One restart at a time, per node ──────────────────────────────────────────────────────
const inFlight = new Set<string>()

/**
 * Serialize a node's restarts. The per-node menu action and the bulk palette action can both
 * reach the same node, and two runs against one pane would write two `/exit` lines (the second
 * typed INTO the CLI the first is resuming) and two resume commands.
 *
 * ONE set for every kind of run: a hibernation exit, a wake resume and a user restart all pass
 * through here, so a sweep cannot quit the pane a menu restart is already resuming, and vice versa.
 * Generic in the outcome so the two halves can be guarded on their own (`ExitPhaseOutcome` /
 * `ResumePhaseOutcome`), which is what hibernation drives — the refusal is `'not-eligible'`, a
 * member of every one of those unions.
 *
 * The node is held for the WHOLE run, delivery included (see performResumePhase's header): a
 * second `/exit` arriving while the resume line sits un-submitted in the pane would be spliced
 * into it and submit `claude --resume <sid>/exit` — the exact mangled line command-delivery.ts
 * exists to prevent, and likeliest precisely when echo verification is being slow.
 *
 * The refused call reports `'not-eligible'` deliberately: the run already in flight owns this
 * node's outcome and will report it, and `'not-eligible'` is the one outcome `summarizeOutcomes`
 * does not count — so a doubled request is neither counted twice as restarted nor reported as a
 * failure the user could act on. (The alternative, a fifth outcome, would break that frozen line.)
 */
export function guardConcurrentRestart<T extends string, Args extends unknown[]>(
  nodeId: string,
  fn: (...args: Args) => Promise<T>
): (...args: Args) => Promise<T | 'not-eligible'> {
  return async (...args: Args) => {
    if (inFlight.has(nodeId)) return 'not-eligible'
    inFlight.add(nodeId)
    try {
      return await fn(...args)
    } finally {
      // Released on rejection too: a transport that threw once must not leave the node
      // permanently un-restartable for the rest of the app's run.
      inFlight.delete(nodeId)
    }
  }
}

// ── Node registry (same park-surviving pattern as TerminalNode's restartSubs) ────────────
// The closure's optional args select what kind of restart:
//  - no args                  → plain "Restart agent": quit + resume the SAME agent in the SAME shell.
//  - `targetAgentId`          → "Reopen session as <variant>": quit + resume the SAME session id
//                               under a same-base agent's binary (the id is harness-portable within
//                               a base; see lib/reopenVariants.ts).
//  - `targetModel`            → switch the gateway model: quit + RECYCLE the tmux session so a fresh
//                               shell spawns with the new gateway env, then the agent auto-resumes.
//  - `restartShell: true`     → "Restart agent and shell": quit + RECYCLE for a FRESH shell (picks up
//                               profile/env changes the same-shell restart cannot) keeping the SAME
//                               agent + model, then the agent auto-resumes. The recycle-after-exit
//                               mechanism is the one a model switch already uses, exposed as its own
//                               action for the "I changed my .zshrc" case.
export type AgentRestartFn = (
  targetAgentId?: AgentId,
  targetModel?: string,
  restartShell?: boolean
) => Promise<RestartOutcome>

const restartFns = new Map<string, AgentRestartFn>()

/** Register a node's restart closure; returns an unregister that is inert if superseded. */
export function registerAgentRestart(nodeId: string, fn: AgentRestartFn): () => void {
  restartFns.set(nodeId, fn)
  return () => {
    if (restartFns.get(nodeId) === fn) restartFns.delete(nodeId)
  }
}

export function agentRestartFn(nodeId: string): AgentRestartFn | undefined {
  return restartFns.get(nodeId)
}

/**
 * A node's two HIBERNATION halves, registered together because they are useless apart: the sweep
 * quits the CLI now, and the wake resumes the same conversation minutes or hours later.
 *
 * Separate from `restartFns` on purpose — a restart is one indivisible action, hibernation is two
 * that are deliberately far apart in time — but both are built by the SAME node from the same
 * `io` / `paneCommand` / `isLive`, and both go through `guardConcurrentRestart`, so the sweep, the
 * wake and a user restart can never write into one pane at once.
 */
export interface AgentHibernateFns {
  /** Ask the CLI to quit and wait for the pane. `'exited'` is the only outcome that may be
   *  recorded as hibernated — anything else leaves the node exactly as it was. */
  exit: () => Promise<ExitPhaseOutcome>
  /** Re-launch the conversation with the provider's own `--resume`. */
  resume: () => Promise<ResumePhaseOutcome>
}

const hibernateFns = new Map<string, AgentHibernateFns>()

/** Register a node's hibernate/wake pair; returns an unregister that is inert if superseded. */
export function registerAgentHibernate(nodeId: string, fns: AgentHibernateFns): () => void {
  hibernateFns.set(nodeId, fns)
  return () => {
    if (hibernateFns.get(nodeId) === fns) hibernateFns.delete(nodeId)
  }
}

export function agentHibernateFns(nodeId: string): AgentHibernateFns | undefined {
  return hibernateFns.get(nodeId)
}

/** The exit half's outcome, plus `'paused'` for a manual pause that actually took. Registered
 *  separately from `hibernateFns.exit`: Eco's exit refuses a node the user is currently watching
 *  (`isNodeWatched`) — the whole point of the sweep — but a MANUAL pause is the user acting on the
 *  node they are looking at right now, so it must not carry that refusal. The resume half is
 *  intentionally NOT duplicated here: `agentHibernateFns(id).resume()` already works for a paused
 *  node whichever depth paused it (a warm hibernated pane, or a freshly recycled shell after the
 *  deeper "pause & end session") — it only asks whether the pane is a shell right now, not why. */
export type PauseOutcome = ExitPhaseOutcome | 'paused'

export interface AgentPauseFns {
  /** Ask the CLI to quit and mark the node PAUSED (see `agentStatus.paused`) so it does not
   *  auto-resume on the next reveal or cold restart. `deep` additionally recycles the tmux session
   *  for a fuller memory reclaim — the caller decides per node, at pause time. */
  pause: (deep: boolean) => Promise<PauseOutcome>
}

const pauseFns = new Map<string, AgentPauseFns>()

/** Register a node's pause closure; returns an unregister that is inert if superseded. */
export function registerAgentPause(nodeId: string, fns: AgentPauseFns): () => void {
  pauseFns.set(nodeId, fns)
  return () => {
    if (pauseFns.get(nodeId) === fns) pauseFns.delete(nodeId)
  }
}

export function agentPauseFns(nodeId: string): AgentPauseFns | undefined {
  return pauseFns.get(nodeId)
}

/** TEST ONLY (house pattern: webgl-budget's `__resetWebglBudgetForTests`): the maps above are
 *  module-global, so a test that leaves a restart in flight would otherwise refuse the next
 *  test's restart of the same node id. */
export function __resetAgentRestartForTests(): void {
  inFlight.clear()
  restartFns.clear()
  hibernateFns.clear()
  pauseFns.clear()
}

// ── Bulk run: who gets restarted, and how the run is summed up ──────────────────────────

/** One canvas node as the bulk action sees it. `agentId` is the agent the node was CREATED as
 *  (`data.agentId`, legacy `tags` fallback) — the very value the node's restart closure captured,
 *  not a hook-detected one, so this filter and that closure agree on what is an agent. */
export interface BulkRestartCandidate {
  id: string
  agentId: string | undefined
  state: string | undefined
  sessionId: string | undefined
  /** Is the node MOUNTED and wired, i.e. does it have a registered restart closure? Registration
   *  is unconditional for every terminal node, so this answers only "can I reach this pane", never
   *  "is this an agent" — `agentId` above is the one that decides that. */
  wired: boolean
  /** Is a background shell task running inside this node's CLI (Claude's `Bash` with
   *  `run_in_background`)? It dies with the CLI the exit line quits — silently, with no output and
   *  no error — and the eligibility gate cannot see it: the node reports `done` the whole time.
   *
   *  Required, not optional: typecheck is what forces every call site to answer the question (the
   *  `remote` / `liveBackgroundTask` precedent), and an omitted field would read as "no task" —
   *  the one wrong direction. Fed from `agentStatus.backgroundTaskAt`. */
  backgroundTask: boolean
}

export interface BulkRestartPlan {
  /** Node ids to restart, in canvas order. */
  runnable: string[]
  skipped: { working: number; noSession: number }
}

/**
 * Partition the canvas for a bulk restart. Two counting rules the summary line depends on:
 *
 * - A node that was never a restart target — a plain shell, or a CLI with no `--resume` / no exit
 *   sequence — is not counted at all. It is not "skipped": the action never claimed it, and
 *   counting every terminal on the canvas would drown the real skips.
 * - A node that IS eligible but has no registration (parked, or not mounted yet) is counted as a
 *   no-session skip rather than dropped silently. There is no pane this canvas can reach, which is
 *   what "no session" says to the user, and it keeps the counts adding up to the number of nodes
 *   the action considered — a node vanishing from the summary reads as a bug.
 */
export function planBulkRestart(candidates: BulkRestartCandidate[]): BulkRestartPlan {
  const plan: BulkRestartPlan = { runnable: [], skipped: { working: 0, noSession: 0 } }
  for (const c of candidates) {
    const gate = restartEligibility(c.agentId, c.state, c.sessionId)
    if (!gate.ok) {
      if (gate.reason === 'working') plan.skipped.working++
      else if (gate.reason === 'no-session') plan.skipped.noSession++
      // 'not-resumable' — never a target, see above.
      continue
    }
    // AFTER the eligibility gate, so a node that was never a target stays uncounted whatever else
    // is true of it — and BEFORE the wired check, because a live background task is the sharper
    // fact: "no session" would send the user looking for a pane that is fine.
    //
    // Counted as `working`, not as a fifth part: the summary line is spec-frozen at four, and
    // `'working'`'s documented meaning — "busy, try again in a moment" — is exactly what a running
    // background task is.
    if (c.backgroundTask) {
      plan.skipped.working++
      continue
    }
    if (!c.wired) {
      plan.skipped.noSession++
      continue
    }
    plan.runnable.push(c.id)
  }
  return plan
}

/**
 * Run one node's restart closure and always come back with an outcome — a REJECTION becomes
 * `'exit-timeout'`.
 *
 * The choreography's writes are unguarded all the way down to the socket
 * (`io.write` → `transport.write` → the relay client's `ws.send`, which throws `InvalidStateError`
 * on a CONNECTING socket), so one unlucky node can reject. In a bulk loop that rejection would
 * abandon every node after it AND lose the summary the user is waiting for, which is far worse than
 * whatever went wrong on the one node.
 *
 * `'exit-timeout'` — the "N failed" bucket — rather than the uncounted `'not-eligible'`: a throw
 * means the restart was attempted and did not complete, possibly leaving a stray `/exit` in the
 * pane, so it needs the same "go look at that node" reading a timeout gets. Filing it as a skip
 * would tell the user nothing happened there, which is exactly what we do not know. (A fifth
 * outcome is not an option — the summary line is spec-frozen at four parts.)
 */
export async function settleRestart(fn: () => Promise<RestartOutcome>): Promise<RestartOutcome> {
  try {
    return await fn()
  } catch {
    return 'exit-timeout'
  }
}

/**
 * The bulk run's one line. `'not-eligible'` outcomes are folded into the no-session skips: the
 * closure re-checks at call time and reports it for a node that stopped being a target between the
 * plan and its turn (its session died, the pane went away, or a restart was already in flight for
 * it). `summarizeOutcomes` deliberately counts neither those nor a fifth part, so folding them here
 * is what keeps them from vanishing — the alternative, a fifth part, is spec-frozen shut.
 */
export function summarizeBulkRestart(
  outcomes: RestartOutcome[],
  skipped: { working: number; noSession: number }
): string {
  const notEligible = outcomes.filter((o) => o === 'not-eligible').length
  return summarizeOutcomes(outcomes, {
    working: skipped.working,
    noSession: skipped.noSession + notEligible
  })
}

/** One toast line for the bulk action; zero-count parts are omitted. */
export function summarizeOutcomes(
  outcomes: RestartOutcome[],
  skipped: { working: number; noSession: number }
): string {
  const restarted = outcomes.filter((o) => o === 'restarted').length
  const failed = outcomes.filter((o) => o === 'exit-timeout').length
  const parts = [`${restarted} restarted`]
  if (failed) parts.push(`${failed} failed (exit timeout)`)
  if (skipped.working) parts.push(`${skipped.working} skipped (working)`)
  if (skipped.noSession) parts.push(`${skipped.noSession} skipped (no session)`)
  return parts.join(' · ')
}
