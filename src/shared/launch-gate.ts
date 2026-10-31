// The dependency and launch-state rules a held launch (`pendingLaunch`) is judged by, in @shared so
// the desktop canvas (renderer lib/pendingLaunch, which re-exports all of it) and the Server
// Edition's `list` read ONE definition. Pure: no React, no stores.
import type { AgentState } from './agents/normalize'
import { outcomeOf, type StationOutcomeRecord, type SuccessDepFacts } from './station-outcome'
import type { StationHandoverRecord } from './station-handover'
import type { PendingLaunch } from './types'

/** The subset of a canvas node this module reads. */
export interface ArmedNode {
  id: string
  data: { pendingLaunch?: PendingLaunch }
}

/** The subset of the agentStatus store this module reads. */
export type StatusById = Record<
  string,
  { state?: AgentState; lastTurnError?: { at: number }; lastTurnInterrupted?: { at: number } } | undefined
>

/**
 * Stations with unfinished HANDED-OVER work (core/station-handover.ts, mirrored): a station here is
 * never a satisfied `--after` dep, whatever its state reads — its `done` is from before the work it
 * was just handed. Absent = nothing handed over.
 */
export type HandoverById = Readonly<Record<string, StationHandoverRecord | undefined>>

export function handedOver(handovers: HandoverById | undefined, depId: string): boolean {
  return !!handovers && Object.prototype.hasOwnProperty.call(handovers, depId) && !!handovers[depId]
}

/**
 * What the success wait knows about one station, from the same sources the `--after` gate reads:
 * whether it is still on the canvas, whether its turn is over without an error (`depSatisfied`'s
 * rule, so a success wait can never release where plain `--after` would still hold), and its report.
 */
export function successDepFacts(
  depId: string,
  status: StatusById,
  live: ReadonlySet<string>,
  outcomes: Readonly<Record<string, StationOutcomeRecord>>,
  handovers?: HandoverById
): SuccessDepFacts {
  const exists = live.has(depId)
  const reported = outcomeOf(outcomes, depId)
  return {
    exists,
    turnDone: exists && depSatisfied(depId, status, live, handovers),
    ...(reported ? { outcome: reported } : {})
  }
}

/** A list row states only observed facts; absence of a launch error is not proof of a live CLI. */
export function controlLaunchState(
  pending: boolean,
  delivery: LaunchDelivery | undefined,
  status?: { dropped?: boolean; state?: AgentState },
  /** The node's `--after-pr` wait has passed its deadline: it will not start on its own. */
  prExpired = false,
  /** Where the node's `--after-success` wait stands, when it has one. */
  success?: 'met' | 'waiting' | 'blocked' | 'expired'
):
  | 'queued'
  | 'stalled'
  | 'failed'
  | 'starting'
  | 'brief-missing'
  | 'dropped'
  | 'working'
  | 'expired'
  | 'success-expired'
  | 'waiting-success'
  | 'blocked-failure'
  | undefined {
  if (pending) {
    if (delivery) return delivery.kind
    if (prExpired) return 'expired'
    if (success === 'expired') return 'success-expired'
    if (success === 'blocked') return 'blocked-failure'
    if (success === 'waiting') return 'waiting-success'
    return 'queued'
  }
  if (status?.dropped) return 'dropped'
  if (status?.state === 'working') return 'working'
  return undefined
}

/**
 * Is one dependency satisfied?
 *
 * `done` is the agent's busy→idle edge — the same signal that drives the completion badge and
 * notification. It means "this station has produced something and stopped", which is exactly
 * when a downstream station should start reading it. It does NOT mean "this station will never
 * run again": an agent that finishes turn 1 and awaits more input is also `done`. That is the
 * intended semantics for a station given one self-contained prompt, and it is documented as
 * such rather than being papered over with a turn counter that would guess differently.
 *
 * A dep that is no longer on the canvas counts as satisfied — a deleted node can never report,
 * so treating it as pending would strand the dependent forever. An UNKNOWN state (the dep
 * exists but has reported nothing yet) is deliberately NOT satisfied: right after a fan-out the
 * upstream stations have not emitted a hook event yet, and reading "no news" as "finished"
 * would fire every dependent immediately — the exact bug that makes a dependency edge useless.
 *
 * A dep that is `done` **with a live `lastTurnError`** is refused (issue #521). An errored station
 * reaches idle IMMEDIATELY and looked healthy from every surface an orchestrator can read, so a
 * whole dependency chain launched against an upstream that had produced nothing. Firing with a
 * warning instead was considered and dropped: a dependent that has already launched cannot
 * un-launch, so the warning would arrive after the damage. The armed node keeps its manual ▶
 * run-now escape, so the human — or the orchestrator, after a retry — is never stuck.
 *
 * The refusal ends by itself: `lastTurnError` is cleared by the upstream's next genuine new turn,
 * so a station that is nudged and answers successfully satisfies its dependents on that turn.
 *
 * A dep whose last turn the user INTERRUPTED (Esc / Ctrl+C — `lastTurnInterrupted`) is refused
 * for the same reason: an interrupted station is idle too, and its turn did not produce what the
 * dependent was waiting for. Claude sends no hook for an interrupt; the `done` comes from the
 * transcript marker (`recordTurnInterrupt`). Same escape (▶), same self-healing (next turn).
 *
 * A dep that has been HANDED NEW WORK it has not finished (`handovers`, core/station-handover.ts)
 * is refused too. A station is reused: an orchestrator hands it its next task and then arms a
 * dependent on it, and until the station starts that task its state is still the PREVIOUS task's
 * `done` — the dependent would start at once, on the old output. Core decides when the hand-over
 * is answered (a turn that started after it has ended); here it is only a membership test, so the
 * renderer and the Server Edition's factory cannot disagree.
 */
export function depSatisfied(
  depId: string,
  status: StatusById,
  live: ReadonlySet<string>,
  handovers?: HandoverById
): boolean {
  if (!live.has(depId)) return true
  if (handedOver(handovers, depId)) return false
  const st = status[depId]
  return st?.state === 'done' && !st.lastTurnError && !st.lastTurnInterrupted
}

/** Why a dep is held (see `handedOverDeps`): new work handed to it, or ONLY tasks its last turn left
 *  running in the background. Named differently in the tooltip and in `list`. */
export function holdReason(record: StationHandoverRecord | undefined): 'work' | 'background' {
  return record?.background && !record.queued && record.since === undefined ? 'background' : 'work'
}

/** Of the deps this node is still waiting on, which are held because they were handed new work
 *  they have not finished — what the QUEUED tooltip and `list` name. */
export function handedOverDeps(
  node: ArmedNode,
  live: ReadonlySet<string>,
  handovers: HandoverById | undefined
): string[] {
  return (node.data.pendingLaunch?.after ?? []).filter((d) => live.has(d) && handedOver(handovers, d))
}

/**
 * What the delivery loop has to say about ONE armed node's held launch — the visible half of the
 * two failure modes that used to be a `console.warn` nobody reads. Declared here rather than in
 * the store so the rendering below stays pure and testable; the store only holds it.
 */
export type LaunchDelivery =
  | { kind: 'stalled'; since: number }
  | { kind: 'failed'; attempts: number; at: number }
  /** A headless start (#925) is in flight: core owns the pane, so ▶ must not type into it. */
  | { kind: 'starting'; since: number }
  /** The file the launch reads its prompt from was gone at delivery: held for ▶, never typed. */
  | { kind: 'brief-missing'; path: string; at: number }
