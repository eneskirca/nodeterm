/**
 * Pure helpers for restarting an agent CLI IN PLACE inside its tmux pane — stop the exact
 * identity-verified foreground process group, then relaunch with the provider's own `--resume`,
 * so a newly released model shows up in the CLI's model list without losing the conversation.
 * Kept free of DOM/IPC so the node menu, the bulk
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
import { modelRespawnErrorKind, modelRespawnTrace } from '@shared/model-respawn-trace'
import type { TerminateForegroundOutcome } from '@shared/types'
import {
  DELIVERY_ATTEMPTS,
  VERIFY_TIMEOUT_MS,
  deliverCommand,
  type DeliveryIo
} from './command-delivery'

/** Historical in-band exit grammar per agent CLI. Production restarts no longer TYPE these
 *  strings — they use the exact-PID `terminateForeground` path — but the table remains the
 *  deliberately reviewed support allowlist for restart/hibernation. One entry turns on both surfaces at once:
 *  the single-node "Restart agent (resume)" row in the node context menu, and the bulk "restart
 *  idle agents" action (pane menu + command palette). There is no header button for either —
 *  `HIDEABLE_HEADER_BUTTONS` is refresh / mic / ai-name / comments. The matching relaunch line
 *  always comes from `resumeCommand`.
 *
 *  Each value is the CLI's own DOCUMENTED PRIMARY and stays BARE in this reviewed table:
 *    - grok:   `/quit` (its `/exit` is an alias).
 *    - gemini: `/quit` (alias `/exit`), measured in its bundled `docs/reference/commands.md:325`.
 *
 *  Bare is still a safety rule, not a style: gemini's `/quit` also takes a `--delete` flag that
 *  permanently deletes session history. Runtime restart does not write the value, but support
 *  metadata must never normalize the destructive variant into this allowlist. */
const EXIT_SEQUENCES: Record<string, string> = {
  claude: '/exit',
  codex: '/quit',
  grok: '/quit',
  gemini: '/quit',
  copilot: '/exit',
  opencode: '/exit'
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

/**
 * Everyone who can refuse a restart, exit or wake, and why. The outcome unions stay bare
 * strings (`'not-eligible'` — spec-frozen by tests and the bulk summary), so the REASON rides
 * the transient agentStatus side channel (`lastRestartRefusal`); this union is the one
 * vocabulary both readers (Canvas notice, grouped-restart strip) and every writer render or
 * compose from. Never prose at a refusal site — a member of this union plus optional detail.
 */
export type RestartRefusalReason =
  | IneligibleReason      // from the shared eligibility gate (busy / no id / not drivable)
  | 'busy'                // a restart/exit of this node is already in flight (concurrent guard)
  | 'unwatchable'         // the pane cannot be watched (pre-flight paneCommand null)
  | 'agent-diverged'      // the session's agent changed/deleted under a stale menu
  | 'no-model'            // a model switch named a model the harness cannot express
  | 'missing-env'         // the relaunch line references env that no longer resolves
  | 'relay'               // relay sessions belong to another core
  | 'gone'                // the session died under the restart (delete/respawn/destroy)
  | 'lost-foreground'     // the pane's foreground changed hands before we could act
  | 'pane-not-shell'      // the pane is held by another program (vim/top/…) — wake refuses
  | 'agent-not-running'   // replacement shell lived, but its separately tracked agent PID exited
  | 'threw'               // the machinery itself errored (fail loud: detail = the exception)

/** ONE sentence per reason. Composed ONCE here so the Canvas notice and the strip row cannot
 *  disagree; a detail from the refusal site (the pane content, the missing var names, the thrown
 *  error) is appended by the renderer when it has one. */
export const RESTART_REFUSAL_COPY: Record<RestartRefusalReason, string> = {
  working: 'the session is mid-turn or blocked on a permission prompt — nothing was written to the pane.',
  'no-session': 'there is no session id to resume into (the CLI never reported one) — nothing was written to the pane.',
  'not-resumable': 'this agent has no resume grammar nodeterm can drive — no exit line to ask it to quit, nothing to relaunch.',
  busy: 'another restart, model switch or hibernation of this session is already in flight.',
  unwatchable: 'the pane cannot be watched without persistent tmux sessions (or tmux at all), so the restart cannot verify the CLI quit before relaunching.',
  'agent-diverged': 'the session changed agent (or the agent was deleted) since the menu was built.',
  'no-model': 'the model to switch to is not expressible in this harness’s grammar.',
  'missing-env': 'the relaunch line references an environment variable that no longer resolves — check the agent config.',
  relay: 'relay sessions run on another machine’s core — this machine cannot restart them.',
  gone: 'the tmux session died during the restart.',
  'lost-foreground': 'the pane’s foreground process changed hands before the restart could act.',
  'pane-not-shell': 'the pane is held by another program — bring it back to a prompt first.',
  'agent-not-running': 'the replacement shell started, but the agent process exited during startup.',
  threw: 'the restart machinery threw an exception — see the detail.'
}

/** States in which the pane must be left alone. `blocked` is here for a sharper reason than
 *  politeness: it means a permission / question dialog owns the prompt (see normalize.ts —
 *  Claude's PermissionRequest, codex's permission.asked / question.asked, gemini's
 *  Notification/ToolPermission). Even though PID termination cannot answer that dialog by
 *  accident, an ordinary restart must not discard active work or a pending user decision. Both
 *  states report `'working'`: to the user they are the same "busy, try again in a moment". */
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
  // Stopping mid-turn would abandon work the agent is in the middle of; stopping a blocked
  // session would discard a decision that belongs to the user (see BUSY_STATES).
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

/**
 * "Restart on subscription" (clear-env) has the same interruption contract as a model switch: it
 * is the explicit force-recovery action: core proves the expected agent owns the foreground
 * process group and terminates that group by PID before the pane is recycled, so a `working` or
 * `blocked` session may be interrupted intentionally. Ordinary `restartEligibility` keeps its
 * conservative do-not-interrupt-active-work policy even though it shares the same safe terminator.
 * Gateway overload — the scenario this feature exists for — shows up mid-turn: the turn is stuck or
 * failing, and "wait for the turn to finish" is exactly what you cannot do when the gateway is down.
 *
 * The durable requirements are shared with restart: the harness must support resume and there must
 * be a provider session id to carry into the replacement process. The strip set itself is checked
 * by the caller through `vanillaEnvStripPattern` (only claude/codex/copilot builtins have one).
 */
export function clearEnvEligibility(
  agentId: string | undefined,
  sessionId: string | undefined
): { ok: true } | { ok: false; reason: Exclude<IneligibleReason, 'working'> } {
  if (!agentId || !canResume(agentId) || !exitSequence(agentId))
    return { ok: false, reason: 'not-resumable' }
  if (!sessionId) return { ok: false, reason: 'no-session' }
  return { ok: true }
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

/** The exit half's own outcomes. `'exited'` means this call stopped the CLI and observed the shell;
 *  `'already-exited'` means core successfully observed that the expected agent no longer owns the
 *  foreground group. The distinction lets a local restart force the fresh-session respawn path
 *  without misidentifying whatever replaced the agent as a safe PID target. */
export type ExitPhaseOutcome =
  | 'exited'
  | 'already-exited'
  | 'exit-timeout'
  | 'not-eligible'

/** The resume half's own outcomes. `'not-eligible'` covers both refusals: a session id that could
 *  never reach a command line, and a pane that stopped existing under the delivery. */
export type ResumePhaseOutcome = 'resumed' | 'not-eligible'

/**
 * PHASE 1 — terminate the exact, identity-verified agent process group and wait until the CLI has
 * let go of the pane. The terminator is supplied by the session-scoped caller and implemented in
 * core (`pty.terminateForeground`): it proves the expected harness's PID is STILL live in the
 * foreground group immediately before SIGTERM. Nothing is typed into the pane, so a stale restart
 * can never submit `/exit` to a raw shell, permission prompt, editor, or replacement process.
 *
 * NOTHING is terminated until one `paneCommand` has come back non-null. The stop is irreversible
 * until the `--resume` that follows, so a pane we cannot WATCH must never be stopped: with tmux
 * switched off in Settings, or absent from the machine, the query answers null forever and the
 * relaunch could never be timed safely. The pre-flight makes that state a plain
 * `'not-eligible'`, with an untouched pane.
 *
 * The bare `resumeCommand` is a gate HERE too, not only in the resume half: a session this app
 * would refuse to resume must not be exited either, or the exit alone would lose it. Hibernation
 * (which quits a pane it means to bring back later) depends on that refusal being decided before
 * the first byte is written.
 */
export async function performExitPhase(d: {
  agentId: string
  sessionId: string
  /** Kept beside the resume dependency so the composed restart has one IO bundle. This phase no
   *  longer writes to it; the process terminator below is the only stop mechanism. */
  io: DeliveryIo
  paneCommand: () => Promise<string | null>
  /** Identity-gated core operation. It distinguishes an exact-PID termination, an expected agent
   *  absent from a successfully read foreground group, and an unreadable/unsafe refusal. */
  terminateForeground: () => Promise<TerminateForegroundOutcome>
  timeoutMs?: number
  pollMs?: number
  /**
   * "Is the pane we are quitting still there?" — asked before the exit is written and on every
   * poll. A session can die under a restart (the node is deleted or respawned, or another client
   * destroys the tmux session), and there is then no pane left to fail in.
   */
  isLive?: () => boolean
  /** WHY did we refuse? Rides the transient side channel (`agentStatus.lastRestartRefusal`) so
   *  the Canvas notice and strip can render one refusal with one reason; the outcome unions stay
   *  bare strings. Optional so refusals keep their existing behavior when unset (tests). */
  onRefusal?: (reason: RestartRefusalReason, detail?: string) => void
}): Promise<ExitPhaseOutcome> {
  modelRespawnTrace('exit.begin', {
    agentId: d.agentId,
    hasSessionId: !!d.sessionId,
    timeoutMs: d.timeoutMs ?? RESTART_EXIT_TIMEOUT_MS
  })
  const exit = exitSequence(d.agentId)
  // The eligibility GATE (not the command): `canResumeWith` validates the session id the way
  // `resumeCommand` does, without building the command — which for a custom agent needs its
  // `launchCmd` from settings (unavailable in this pure module). The typed resume line is the
  // caller's job (`performResumePhase` takes it as `d.command`); the exit half only needs to know
  // the session is one we WOULD resume into, so it does not quit a conversation it cannot bring back.
  if (!exit || !canResumeWith(d.agentId, d.sessionId)) {
    modelRespawnTrace('exit.refused', { agentId: d.agentId, reason: 'not-resumable' })
    d.onRefusal?.('not-resumable')
    return 'not-eligible'
  }
  const timeoutMs = d.timeoutMs ?? RESTART_EXIT_TIMEOUT_MS
  const pollMs = d.pollMs ?? RESTART_POLL_MS
  // A dead session is not a restart that failed — there is no pane left to fail in. `'not-eligible'`
  // (uncounted) rather than `'exit-timeout'`, which claims something sharper and false: that the CLI
  // is still running and refused to quit, sending the user to look at a pane that is gone.
  const gone = (): boolean => !!d.isLive && !d.isLive()
  if (gone()) {
    modelRespawnTrace('exit.refused', { agentId: d.agentId, reason: 'gone-before-preflight' })
    d.onRefusal?.('gone')
    return 'not-eligible'
  }
  // ── Pre-flight: prove we can SEE this pane before quitting anything in it (see the header).
  // Reported as `'not-eligible'`, the outcome that means "not a target right now" and is the one
  // the menu and the notice already have wording for. Nothing has been written at this point.
  const before = await queryPaneWithin(d.paneCommand, timeoutMs)
  modelRespawnTrace('exit.preflight', {
    agentId: d.agentId,
    paneVisible: before !== null,
    paneCommand: before ?? 'unavailable'
  })
  if (before === null || gone()) {
    modelRespawnTrace('exit.refused', { agentId: d.agentId, reason: 'unwatchable' })
    d.onRefusal?.('unwatchable')
    return 'not-eligible'
  }
  // Re-prove ownership at the destructive boundary. `paneCommand` above only says the pane is
  // watchable; it is deliberately NOT treated as identity evidence (npm-installed CLIs commonly
  // all appear as `node`). Core reads full argv + PID and refuses on any uncertainty or handoff.
  let termination: TerminateForegroundOutcome = 'refused'
  try {
    termination = await d.terminateForeground()
  } catch (error) {
    modelRespawnTrace('exit.terminate-threw', {
      agentId: d.agentId,
      errorKind: modelRespawnErrorKind(error)
    })
    termination = 'refused'
  }
  modelRespawnTrace('exit.termination', { agentId: d.agentId, outcome: termination })
  if (gone()) {
    modelRespawnTrace('exit.refused', { agentId: d.agentId, reason: 'gone-after-terminate' })
    d.onRefusal?.('gone')
    return 'not-eligible'
  }
  if (termination === 'already-exited') {
    modelRespawnTrace('exit.complete', { agentId: d.agentId, outcome: 'already-exited' })
    return 'already-exited'
  }
  if (termination !== 'terminated') {
    modelRespawnTrace('exit.refused', { agentId: d.agentId, reason: 'lost-foreground' })
    d.onRefusal?.('lost-foreground')
    return 'not-eligible'
  }
  const deadline = Date.now() + timeoutMs
  let last: string | null = null
  for (;;) {
    await new Promise((r) => setTimeout(r, pollMs))
    const pane = await queryPaneWithin(d.paneCommand, Math.max(0, deadline - Date.now()))
    if (gone()) {
      d.onRefusal?.('gone')
      return 'not-eligible' // stop polling a pane that no longer exists
    }
    // Two ways to know the CLI let go of the pane. The allowlist is the confident one and is
    // taken immediately. The other — "the foreground command is no longer what it was before the
    // exit" — covers the shells the allowlist cannot know (`nu`, `xonsh`, `pwsh`, anything the
    // user set as `defaultShell`), where waiting for a listed shell would time out with the agent
    // already quit and never resumed. It is required on two CONSECUTIVE polls: a single changed
    // reading can be a momentary foreground child of a still-running CLI, and typing the resume
    // line into a live CLI would send it as a message.
    if (isShellCommand(pane)) {
      modelRespawnTrace('exit.complete', {
        agentId: d.agentId,
        outcome: 'exited',
        evidence: 'shell'
      })
      return 'exited'
    }
    if (pane !== null && pane !== before && pane === last) {
      modelRespawnTrace('exit.complete', {
        agentId: d.agentId,
        outcome: 'exited',
        evidence: 'stable-command-change',
        paneCommand: pane
      })
      return 'exited'
    }
    last = pane
    if (Date.now() > deadline) {
      modelRespawnTrace('exit.complete', {
        agentId: d.agentId,
        outcome: 'exit-timeout',
        lastPaneCommand: pane ?? 'unavailable'
      })
      return 'exit-timeout'
    }
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
  /** WHY did we refuse? See the exit half. */
  onRefusal?: (reason: RestartRefusalReason, detail?: string) => void
}): Promise<ResumePhaseOutcome> {
  modelRespawnTrace('resume.begin', {
    agentId: d.agentId,
    hasSessionId: !!d.sessionId,
    hasAssembledCommand: !!d.command
  })
  // The eligibility GATE (see performExitPhase): `canResumeWith` validates the session id without
  // building the command. The typed line is the caller's `d.command`; for a builtin with no
  // override, `resumeCommand` supplies the bare resume command. A custom agent MUST pass
  // `d.command` (its baseAgent-aware line, built by `assembleResumeCommand` in the node) — it has
  // no `resumeCommand` here, so a missing `command` for a custom agent refuses before any write.
  if (!canResumeWith(d.agentId, d.sessionId)) {
    modelRespawnTrace('resume.refused', { agentId: d.agentId, reason: 'not-resumable' })
    d.onRefusal?.('not-resumable')
    return 'not-eligible'
  }
  const base = resumeCommand(d.agentId, d.sessionId)
  const cmd = d.command ?? base
  if (!cmd) {
    modelRespawnTrace('resume.refused', { agentId: d.agentId, reason: 'no-session' })
    d.onRefusal?.('no-session')
    return 'not-eligible'
  }
  const gone = (): boolean => !!d.isLive && !d.isLive()
  // Awaited, not fire-and-forget: see the header. `deliverCommand` is started inside the executor
  // (synchronously, so `onDelivery` still hands the cancel out before any await) and announces the
  // end of the delivery — successfully submitted, failed, or cancelled — through `settle`.
  await new Promise<void>((resolve, reject) => {
    let lapse: ReturnType<typeof setTimeout> | undefined
    let settled = false
    let settledSubmitted = false
    let started = false
    let cancelDelivery: (() => void) | undefined
    // A settle announced from INSIDE deliverCommand's synchronous body is only applied below,
    // after it has returned: that body can announce the end of the delivery and then throw (a
    // transport that rejects the very first write ends the delivery, then reports), and a promise
    // resolved first could no longer be rejected — the restart would claim success for a resume
    // line that never reached the pane.
    const settle = (submitted: boolean): void => {
      settled = true
      settledSubmitted = submitted
      if (!started) return
      clearTimeout(lapse)
      if (submitted) resolve()
      else reject(new Error('resume delivery did not submit'))
    }
    try {
      // Two statements on purpose: `d.onDelivery?.(deliverCommand(…))` short-circuits the ARGUMENT
      // too when no callback was passed — nothing would be delivered and this promise would never
      // settle.
      cancelDelivery = deliverCommand(d.io, cmd, (outcome) => settle(outcome === 'submitted'))
      started = true
      modelRespawnTrace('resume.delivery-started', { agentId: d.agentId })
      d.onDelivery?.(cancelDelivery)
    } catch (e) {
      modelRespawnTrace('resume.delivery-threw', {
        agentId: d.agentId,
        errorKind: modelRespawnErrorKind(e)
      })
      reject(e) // the caller counts a failure; no timer has been armed yet
      return
    }
    if (settled) {
      // A synchronous echo can settle inside the first write, including an Enter write that
      // rejects inside that re-entrant callback. Preserve its actual submission verdict.
      return settledSubmitted
        ? resolve()
        : reject(new Error('resume delivery did not submit'))
    }
    // Bounded even so. The delivery's own retry chain is finite, but this await holds the node
    // (and, in a bulk run, every node after it and the summary), so it must not depend on a third
    // party announcing itself.
    lapse = setTimeout(() => {
      // A timeout is not proof that Enter reached the pane. Stop the still-live retry chain before
      // failing so it cannot submit later, after the restart owner has already released the node.
      cancelDelivery?.()
      reject(new Error('resume delivery timed out before submission'))
    }, d.deliveryTimeoutMs ?? RESTART_DELIVERY_TIMEOUT_MS)
  })
  // The session can have died while the line was being verified — the delivery is then cancelled by
  // the teardown and nothing reached the pane, so don't claim a resume.
  if (gone()) {
    modelRespawnTrace('resume.refused', { agentId: d.agentId, reason: 'gone-after-delivery' })
    d.onRefusal?.('gone')
    return 'not-eligible'
  }
  modelRespawnTrace('resume.complete', { agentId: d.agentId, outcome: 'resumed' })
  return 'resumed'
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
  /** The one stop mechanism used by every production restart path; see `performExitPhase`. */
  terminateForeground: () => Promise<TerminateForegroundOutcome>
  /** Local terminals use this to force the same recycle path as "Restart agent and shell" when
   *  the expected agent no longer owns the pane. Relay callers may omit it and resume in place. */
  onAlreadyExited?: () => Promise<RestartOutcome>
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
  /** WHY did we refuse? See performExitPhase. Composed down to both halves. */
  onRefusal?: (reason: RestartRefusalReason, detail?: string) => void
}): Promise<RestartOutcome> {
  modelRespawnTrace('restart.compose-begin', {
    agentId: d.agentId,
    hasSessionId: !!d.sessionId,
    forceRecycleAvailable: !!d.onAlreadyExited
  })
  const exited = await performExitPhase({
    agentId: d.agentId,
    sessionId: d.sessionId,
    io: d.io,
    paneCommand: d.paneCommand,
    terminateForeground: d.terminateForeground,
    timeoutMs: d.timeoutMs,
    pollMs: d.pollMs,
    isLive: d.isLive,
    onRefusal: d.onRefusal
  })
  // A local caller can force-recycle a session whose expected agent is absent. With no callback
  // (notably a relay session), the caller deliberately falls back to its in-place resume path.
  if (exited === 'already-exited' && d.onAlreadyExited) {
    modelRespawnTrace('restart.force-recycle', { agentId: d.agentId })
    const outcome = await d.onAlreadyExited()
    modelRespawnTrace('restart.compose-complete', { agentId: d.agentId, outcome })
    return outcome
  }
  if (exited !== 'exited' && exited !== 'already-exited') {
    modelRespawnTrace('restart.compose-complete', { agentId: d.agentId, outcome: exited })
    return exited
  }
  const resumed = await performResumePhase({
    agentId: d.agentId,
    sessionId: d.sessionId,
    io: d.io,
    command: d.command,
    deliveryTimeoutMs: d.deliveryTimeoutMs,
    onDelivery: d.onDelivery,
    isLive: d.isLive,
    onRefusal: d.onRefusal
  })
  const outcome = resumed === 'resumed' ? 'restarted' : resumed
  modelRespawnTrace('restart.compose-complete', { agentId: d.agentId, outcome })
  return outcome
}

// ── One restart at a time, per node ──────────────────────────────────────────────────────
const inFlight = new Set<string>()

/**
 * Serialize a node's restarts. The per-node menu action and the bulk palette action can both
 * reach the same node, and two runs against one pane would stop the replacement process and emit
 * two resume commands.
 *
 * ONE set for every kind of run: a hibernation exit, a wake resume and a user restart all pass
 * through here, so a sweep cannot quit the pane a menu restart is already resuming, and vice versa.
 * Generic in the outcome so the two halves can be guarded on their own (`ExitPhaseOutcome` /
 * `ResumePhaseOutcome`), which is what hibernation drives — the refusal is `'not-eligible'`, a
 * member of every one of those unions.
 *
 * The node is held for the WHOLE run, delivery included (see performResumePhase's header): a
 * second run arriving while the resume line sits un-submitted could terminate the new process or
 * splice a second launch line into the first — likeliest precisely when echo verification is slow.
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
    if (inFlight.has(nodeId)) {
      modelRespawnTrace('restart.concurrent-refused', { nodeId })
      return 'not-eligible'
    }
    modelRespawnTrace('restart.guard-acquired', { nodeId })
    inFlight.add(nodeId)
    try {
      const outcome = await fn(...args)
      modelRespawnTrace('restart.guard-complete', { nodeId, outcome })
      return outcome
    } catch (error) {
      modelRespawnTrace('restart.guard-threw', {
        nodeId,
        errorKind: modelRespawnErrorKind(error)
      })
      throw error
    } finally {
      // Released on rejection too: a transport that threw once must not leave the node
      // permanently un-restartable for the rest of the app's run.
      inFlight.delete(nodeId)
      modelRespawnTrace('restart.guard-released', { nodeId })
    }
  }
}

// ── Node registry (same park-surviving pattern as TerminalNode's restartSubs) ────────────
// The closure's optional args select what kind of restart:
//  - no args                  → plain "Restart agent": terminate + resume the SAME agent in the SAME shell.
//  - `targetAgentId`          → "Reopen session as <variant>": terminate + resume the SAME session id
//                               under a same-base agent's binary (the id is harness-portable within
//                               a base; see lib/reopenVariants.ts).
//  - `targetModel`            → switch the gateway model: quit + RECYCLE the tmux session so a fresh
//                               shell spawns with the new gateway env, then the agent auto-resumes.
//  - `restartShell: true`     → "Restart agent and shell": terminate + RECYCLE for a FRESH shell (picks up
//                               profile/env changes the same-shell restart cannot) keeping the SAME
//                               agent + model, then the agent auto-resumes. The recycle-after-exit
//                               mechanism is the one a model switch already uses, exposed as its own
//                               action for the "I changed my .zshrc" case.
export type AgentRestartFn = (
  targetAgentId?: AgentId,
  targetModel?: string,
  restartShell?: boolean,
  // "Restart on subscription": recycle the session VANILLA — strip the gateway + inherited
  // provider env so the agent falls back to its OWN default provider. No model/agent change; the
  // cold-restore auto-resume keeps the same conversation. Uses `clearEnvEligibility` (permits busy,
  // since `terminateForeground` is PID-safe — no `/exit` typed into a dialog) and recycles the same
  // way a model switch does, because tmux env changes do not retroactively change an existing shell.
  clearEnv?: boolean
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
  /** Stop the CLI and wait for the pane. Only a CLI this call actually stopped (`'exited'`) may be
   *  recorded as hibernated; an already-absent agent and every refusal leave the node as it was. */
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
 * means the restart was attempted and did not complete, possibly leaving the pane between stop
 * and resume, so it needs the same "go look at that node" reading a timeout gets. Filing it as a skip
 * would tell the user nothing happened there, which is exactly what we do not know. (A fifth
 * outcome is not an option — the summary line is spec-frozen at four parts.)
 */
export async function settleRestart(
  fn: () => Promise<RestartOutcome>,
  /** Present in the real callers so a THROWN exception fails LOUD: the verbatim error text rides
   *  the side channel (reason `'threw'`) instead of vanishing into the generic timeout wording.
   *  Tests that pass no reporter get the behavior unchanged. */
  onRefusal?: (reason: RestartRefusalReason, detail?: string) => void
): Promise<RestartOutcome> {
  try {
    return await fn()
  } catch (e) {
    onRefusal?.('threw', e instanceof Error ? e.message : String(e))
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
