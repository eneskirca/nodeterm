// Pure logic for ARMED terminal nodes — the canvas-control `--after` dependency edge. A node
// opened with `--after <ids>` holds its launch command (see PendingLaunch in @shared/types)
// until every station it waits on has gone idle; this module decides when that is, and which
// dependency edges to draw meanwhile. Kept free of React/store imports so the satisfaction
// matrix is unit-testable — Canvas.tsx only wraps these in an effect and a setState.
import type { GitHubPullBoard } from '@shared/github-pull-status'
import type { PrWaitHold } from '@shared/pr-wait'
import {
  normalizeSuccessWaitHold,
  successWaitSatisfied,
  type StationOutcomeRecord,
  type SuccessWaitHold
} from '@shared/station-outcome'
import type { PendingLaunch } from '@shared/types'
import { prHoldSatisfied } from './prWait'
import {
  depSatisfied,
  successDepFacts,
  type ArmedNode,
  type HandoverById,
  type LaunchDelivery,
  type StatusById
} from '@shared/launch-gate'

// Moved to @shared/launch-gate so the Server Edition's `list` judges a held launch the same way.
export {
  controlLaunchState,
  handedOverDeps,
  holdReason,
  successDepFacts,
  type ArmedNode,
  type HandoverById,
  type LaunchDelivery,
  type StatusById
} from '@shared/launch-gate'

export interface LaunchToFire {
  id: string
  command: string
  /** The file `command` reads its prompt from, which the loop checks before typing. */
  briefFile?: string
}

/**
 * Record the file a held launch reads its prompt from (`--prompt-file`, or a spilled `--prompt`).
 * Applied by every control open path after arming, so the delivery loop can check the file is still
 * there when the node finally launches — possibly weeks later, for a cold open.
 */
export function withLaunchBrief<T extends { data: { pendingLaunch?: PendingLaunch } }>(
  node: T,
  promptFile: string | undefined
): T {
  const p = node.data.pendingLaunch
  if (!promptFile || !p) return node
  return { ...node, data: { ...node.data, pendingLaunch: { ...p, promptFile } } }
}

/** What `launchesToFire` needs to judge a `--after-pr` wait: the ACTIVE project's pull request
 *  status (#1008's board, absent until the watch has read it) and the clock deadlines are on. */
export interface PrGateContext {
  board?: GitHubPullBoard
  now: number
}

/** What `launchesToFire` needs to judge a `--after-success` wait: every station's latest task
 *  report (core's durable store, mirrored) and the clock deadlines are on. */
export interface SuccessGateContext {
  outcomes: Readonly<Record<string, StationOutcomeRecord>>
  now: number
}

/**
 * Attach a `--after-success` wait to a node whose launch is already held — the sibling of
 * `withPrHold`, applied by every open path that applies that one, so no path can arm a node that
 * forgets a wait it was asked for.
 */
export function withSuccessHold<T extends { data: { pendingLaunch?: PendingLaunch } }>(
  node: T,
  hold: SuccessWaitHold | undefined
): T {
  const p = node.data.pendingLaunch
  if (!hold || !p) return node
  return { ...node, data: { ...node.data, pendingLaunch: { ...p, afterSuccess: hold } } }
}

/** Control opens reply before the PTY exists. Keep their command durable until delivery lands,
 * even with no dependencies (or dependencies that are already done). */
export function queueControlLaunch<T extends { data: { initialCommand?: string; pendingLaunch?: PendingLaunch } }>(
  node: T,
  after: string[] = [],
  awaitSetupGroup?: string
): T & { data: { pendingLaunch?: PendingLaunch } } {
  const command = node.data.initialCommand
  if (!command) return node
  return {
    ...node,
    data: {
      ...node.data,
      initialCommand: undefined,
      pendingLaunch: { after, command, attempted: false, ...(awaitSetupGroup ? { awaitSetupGroup } : {}) }
    }
  }
}

/**
 * Attach a `--after-pr` wait to a node whose launch is already held (by `queueControlLaunch`,
 * `armForColdOpen`, or `--after`). ONE helper for every open path — live, cold and `--project` —
 * so no path can arm a node that forgets the wait it was asked for. A node with nothing held has
 * nothing to wait with (the flag gate already refused `open-terminal` without `--cmd`).
 */
export function withPrHold<T extends { data: { pendingLaunch?: PendingLaunch } }>(
  node: T,
  hold: PrWaitHold | undefined
): T {
  const p = node.data.pendingLaunch
  if (!hold || !p) return node
  return { ...node, data: { ...node.data, pendingLaunch: { ...p, afterPr: hold } } }
}

/**
 * Is the file a held launch reads its prompt from still there, right before the launch is typed?
 * Only a definite "not there" answers false. No file to check, a check that fails (sync or async),
 * and any project not on this machine's disk answer true: an SSH project never gets a spilled file,
 * and there `exists === false` cannot tell a gone file from a dropped ControlMaster; a relay tab's
 * launches are refused elsewhere. The open-time check fails open the same way.
 */
export async function launchBriefPresent(
  path: string | undefined,
  project: { id: string; ssh?: unknown; remote?: boolean } | undefined,
  exists: (path: string) => Promise<boolean>
): Promise<boolean> {
  if (!path || !project || project.ssh || project.remote) return true
  try {
    return (await exists(path)) !== false
  } catch {
    return true
  }
}

/** Of the deps this node is still waiting on, which are held because they ERRORED rather than
 *  because they have not finished? What the QUEUED tooltip names (issue #521). */
export function erroredDeps(
  node: ArmedNode,
  status: StatusById,
  live: ReadonlySet<string>
): string[] {
  return (node.data.pendingLaunch?.after ?? []).filter(
    (d) => live.has(d) && status[d]?.state === 'done' && !!status[d]?.lastTurnError
  )
}

/** Of the deps this node is still waiting on, which are held because the user INTERRUPTED their
 *  last turn? Named by the QUEUED tooltip, like `erroredDeps`. An errored dep is left to
 *  `erroredDeps` — that is the stronger fact, and one reason is enough. */
export function interruptedDeps(
  node: ArmedNode,
  status: StatusById,
  live: ReadonlySet<string>
): string[] {
  return (node.data.pendingLaunch?.after ?? []).filter(
    (d) =>
      live.has(d) &&
      status[d]?.state === 'done' &&
      !status[d]?.lastTurnError &&
      !!status[d]?.lastTurnInterrupted
  )
}

/**
 * Which armed nodes are ready to launch, given the live canvas and the current agent states.
 * `live` is passed in (rather than derived from `nodes`) because the caller already holds the
 * full node list while `nodes` here may be pre-filtered.
 *
 * `setupDone` is the SECOND gate, for a node opened into a worktree frame whose project runs a
 * setup script with `waitForSetup`: the node's command must not race an `npm ci` that is still
 * writing node_modules underneath it. It answers per group id, and the two gates are ANDed —
 * a node can be waiting on both its upstream stations and its checkout being ready.
 *
 * An ABSENT probe (`setupDone` not passed) means the gate is open. That is the honest default,
 * not laxness: the run store is rebuilt from live events, so after an app restart a node armed
 * with `awaitSetupGroup` has no run to hear from ever again, and reading "nothing known" as
 * "still running" would strand it forever — the same reasoning as a deleted dependency counting
 * as satisfied. (The caller's probe applies the same rule to a group with no entry.)
 */
export function launchesToFire(
  nodes: readonly ArmedNode[],
  status: StatusById,
  live: ReadonlySet<string>,
  setupDone?: (groupId: string) => boolean,
  deliveries?: Record<string, LaunchDelivery | undefined>,
  pr?: PrGateContext,
  success?: SuccessGateContext,
  /** Stations with unfinished handed-over work — never a satisfied dep (see `depSatisfied`). */
  handovers?: HandoverById
): LaunchToFire[] {
  const out: LaunchToFire[] = []
  for (const n of nodes) {
    const p = n.data.pendingLaunch
    if (!p || !p.command || p.manualOnly || p.executor === 'server') continue
    if (deliveries?.[n.id]?.kind === 'failed') continue
    // A headless start (#925) owns this pane and is typing the launch into it. Its claim makes the
    // node manualOnly, which the guard above already skips; this covers a live copy that has not
    // caught up with the claim yet while the store already says so.
    if (deliveries?.[n.id]?.kind === 'starting') continue
    if (p.awaitSetupGroup && !(setupDone?.(p.awaitSetupGroup) ?? true)) continue
    // The THIRD gate (`--after-pr`). Unlike the setup gate, an absent context is CLOSED: a caller
    // that did not say what the pull requests look like has told us nothing, and "no news" is
    // exactly what must never release a launch (the same rule as an unknown agent state).
    if (p.afterPr && !(pr && prHoldSatisfied(p.afterPr, pr.board, pr.now))) continue
    // The FOURTH gate (`--after-success`): every named station reported SUCCESS and its turn is over.
    // Closed without a context, for the same reason as the PR gate: no news is never a success.
    // Re-read through the shape rule: live node data can arrive by a path that did not cross a
    // serializer seam (a peer's canvas mutation), and a malformed hold must hold, never throw.
    const successHold = normalizeSuccessWaitHold(p.afterSuccess)
    if (
      successHold &&
      !(
        success &&
        successWaitSatisfied(
          successHold,
          (d) => successDepFacts(d, status, live, success.outcomes, handovers),
          success.now
        )
      )
    )
      continue
    if (p.after.every((d) => depSatisfied(d, status, live, handovers))) {
      out.push({ id: n.id, command: p.command, ...(p.promptFile ? { briefFile: p.promptFile } : {}) })
    }
  }
  return out
}

/** The deps an armed node is still waiting on — what the node badge and tooltip report. */
export function unmetDeps(
  node: ArmedNode,
  status: StatusById,
  live: ReadonlySet<string>,
  handovers?: HandoverById
): string[] {
  const p = node.data.pendingLaunch
  if (!p) return []
  return p.after.filter((d) => !depSatisfied(d, status, live, handovers))
}

/**
 * How long an armed node whose gate is OPEN may sit with no terminal to deliver into before the
 * badge says so. It is a WARNING, not a deadline: the launch is still held and still fires the
 * moment the session comes up (an SSH host that reconnects, a spawn behind a slow `npm ci`).
 *
 * Chosen well past a cold project switch on a loaded canvas, so an ordinary open never trips it.
 */
export const LAUNCH_STALL_MS = 45_000

/**
 * Which delivery records the Canvas sweep retires: every record whose node is no longer an armed
 * node on the ACTIVE canvas (delivered, run by hand with ▶, deleted, or in another project) —
 * EXCEPT a `starting` one. A headless start (#925) runs precisely for a node that is not on the
 * active canvas, and its orchestrator owns the record end to end (`clear` on success or
 * not-persistent, `markFailed` otherwise). Retiring it here would re-enable ▶ the moment the user
 * switched to that project mid-start — the manualOnly claim alone reads as a failed launch — and ▶
 * would then type into a pane core is still typing into.
 */
export function deliveriesToRetire(
  byId: Record<string, LaunchDelivery | undefined>,
  isArmedOnCanvas: (nodeId: string) => boolean
): string[] {
  return Object.keys(byId).filter((id) => byId[id]?.kind !== 'starting' && !isArmedOnCanvas(id))
}

/**
 * The QUEUED badge's tooltip. One function for every case so the sentences cannot drift, and
 * so the two warnings are held to the same standard as the ordinary one: say what is true, name
 * what would fix it, and never claim a cause that was not measured.
 *
 * `stalled` is careful about that last point. We know the terminal has not come up; we do NOT know
 * why (a host that is down, a spawn that failed, a machine under load all look identical from
 * here), so the text says what we observed and leaves the diagnosis to the node's own overlay,
 * which does know.
 *
 * `starting` comes first, ahead even of the relay sentence: while core is typing the launch, no
 * sentence may offer ▶, and "waiting for X" would describe a wait that is already over.
 */
/**
 * A node's own first-open launch is in flight: the live `initialCommand` alias is still set (it is
 * cleared on every outcome), the delivery loop has reported nothing, and nothing holds it. Its
 * `pendingLaunch` is then only the durable write-ahead record — and it carries `manualOnly` from the
 * claim until Enter lands — so a QUEUED chip there would paint "⚠ QUEUED" on EVERY freshly opened
 * agent for the length of its delivery. A real hold (deps, setup script, PR / success wait) or a
 * reported failure/stall still shows. ONE rule for the canvas node and the board card, so the two
 * views of a session cannot disagree about whether it is queued.
 */
export function firstOpenInFlight(
  hasInitialCommand: boolean,
  pending: PendingLaunch | undefined,
  observedDelivery: LaunchDelivery | undefined
): boolean {
  return (
    hasInitialCommand &&
    !observedDelivery &&
    !pending?.after?.length &&
    !pending?.awaitSetupGroup &&
    !pending?.afterPr &&
    !pending?.afterSuccess
  )
}

export function launchTooltip(
  delivery: LaunchDelivery | undefined,
  waitingOn: string,
  command: string,
  erroredOn?: string,
  relay = false,
  /** The node's `--after-pr` wait: what is still unmet (`prHoldSummary`), whether it has passed
   *  its deadline, and that deadline as the caller formats it (a locale string is not pure). */
  pr?: { expired: boolean; summary: string; deadline: string },
  /** The node's `--after-success` wait: where it stands (`successWaitStatus`), the unmet stations
   *  (`successWaitSummary`), and its deadline as the caller formats it. */
  success?: { status: 'met' | 'waiting' | 'blocked' | 'expired'; summary: string; deadline: string },
  /** The deps held because the user interrupted their last turn (`interruptedDeps`). */
  interruptedOn?: string,
  /** The deps that were handed new work they have not finished (core/station-handover.ts), named. */
  handedOverOn?: string
): string {
  if (delivery?.kind === 'starting') return 'Starting in the background — an agent asked for this session to run now.'
  const runs = `Runs:\n${command}`
  if (relay) return `Launch delivery from a relay tab is unavailable. Open the host to run this command.\n${runs}`
  // Checked right before typing: the file the prompt is read from went away (a spill outlived its
  // TTL while a cold-opened node waited, or a `--prompt-file` was deleted). Typing the command would
  // start the agent with an empty prompt, so it is held, and ▶ is the human's call.
  if (delivery?.kind === 'brief-missing')
    return (
      `The file this launch reads its prompt from no longer exists:\n${delivery.path}\n` +
      'It was not started, because the agent would get no brief. Open the node again with its ' +
      `prompt, or press \u25b6 to run it anyway.\n${runs}`
    )
  if (delivery?.kind === 'failed')
    return (
      'Launch delivery is unconfirmed; automatic retry is stopped.\n' +
      `Inspect the terminal, then press \u25b6 to retry at a shell prompt.\n${runs}`
    )
  // Issue #521: an errored upstream is idle, so without this the tooltip would say "waiting for X
  // to finish" about a station that finished twenty minutes ago. Named first, because it is the
  // one case where waiting will not end on its own.
  if (erroredOn)
    return (
      `${erroredOn} ended its last turn on an error, so this is held rather than started on ` +
      'what it did not produce.\n' +
      `Retry or nudge it — a successful turn releases this — or press ▶ to run it now.\n${runs}`
    )
  // Same shape: an interrupted upstream is idle, and nothing will release this on its own.
  if (interruptedOn)
    return (
      `${interruptedOn} was interrupted before its turn finished, so this is held rather than ` +
      'started on unfinished work.\n' +
      `Give it its next prompt — a turn that finishes releases this — or press ▶ to run it now.\n${runs}`
    )
  // A wait that passed its deadline will not end on its own either — the one other case where
  // "waiting for" would be a promise nobody keeps.
  if (pr?.expired)
    return (
      `The wait on pull requests passed its deadline (${pr.deadline}), so this will not start on ` +
      'its own.\n' +
      `Press \u25b6 to run it now.\n${runs}`
    )
  if (success?.status === 'expired')
    return (
      `The wait for stations to report success passed its deadline (${success.deadline}), so this ` +
      'will not start on its own.\n' +
      `Press \u25b6 to run it now.\n${runs}`
    )
  // A reported failure is the other wait that will not end on its own: named, with both ways out.
  if (success?.status === 'blocked')
    return (
      `Held on ${success.summary}.\n` +
      'It does not start on a task that did not succeed. Retry that station — this starts when it ' +
      `reports success — or press \u25b6 to run it now.\n${runs}`
    )
  if (delivery?.kind === 'stalled')
    return (
      'Ready to run, but this terminal has not started yet — the launch is still held and ' +
      'fires as soon as it does.\n' +
      `Press \u25b6 to try it now.\n${runs}`
    )
  // A station that just got new work still reads `done` from its previous task; saying "waiting for
  // X to finish" alone would read as a wait that should already be over.
  if (handedOverOn)
    return (
      `Waiting for ${handedOverOn} to finish — a turn that ended before that work was done does not ` +
      `count${waitingOn ? ` (all waits: ${waitingOn})` : ''}, then runs:\n${command}`
    )
  if (success?.status === 'waiting') {
    // `waitingOn` here is the caller's list of the OTHER stations (plain `--after`), if any.
    const stations = waitingOn ? `${waitingOn} to finish and for ` : ''
    const prs = pr?.summary ? `, and for ${pr.summary}` : ''
    return (
      `Waiting for ${stations}a reported success from ${success.summary}${prs}, until ` +
      `${success.deadline}, then runs:\n${command}`
    )
  }
  if (pr?.summary) {
    const stations = waitingOn ? `${waitingOn} to finish and for ` : ''
    return `Waiting for ${stations}${pr.summary}, until ${pr.deadline}, then runs:\n${command}`
  }
  return waitingOn
    ? `Waiting for ${waitingOn} to finish, then runs:\n${command}`
    : `Queued; waiting for launch delivery.\n${runs}`
}
