// Pure planner for "Pause all": sorts terminal nodes into pause-now / pause-after-the-current-turn /
// already-exited / skipped. No React, no store access — the caller injects the status lookup, so
// the same rules serve the menu, the palette and the tests.
import { canResumeWith } from '../../shared/agents/config'
import type { AgentNodeStatus } from '../state/agentStatus'
import { exitSequence } from '../terminal/agent-restart'

export type BulkPauseSkip =
  | 'not-agent' | 'no-session-id' | 'not-resumable' | 'already-paused' | 'relay' | 'dropped' | 'ended'
  | 'state-unknown'

export interface BulkPauseTarget {
  nodeId: string
  agentId: string | undefined
  relay: boolean
  hostKey: string
  /** The session the target was planned against (set by the planner for every actionable target).
   *  A pending mark or a queued exit for it is void once the node runs another session — a
   *  restart, a model or account switch, `/clear` — because the turn it was waiting on is gone. */
  sessionId?: string
}

export interface BulkPausePlan {
  now: BulkPauseTarget[]
  whenDone: BulkPauseTarget[]
  alreadyExited: BulkPauseTarget[]
  skip: { target: BulkPauseTarget; reason: BulkPauseSkip }[]
}

/**
 * Typing an exit into a working/waiting/blocked session, or one holding a question/approval
 * ticket, would abandon the turn or ANSWER the dialog — those wait for their turn to end.
 * An unknown state is not busy, but it is not idle either: see `idleForPause`.
 */
export function isBusyForPause(st: AgentNodeStatus | undefined): boolean {
  if (!st) return false
  if (st.state === 'working' || st.state === 'waiting' || st.state === 'blocked') return true
  return !!(st.held || st.pendingId)
}

/**
 * Idle enough to type an exit into: a known `done`, or — when the live state is unknown, as after
 * an app restart (state is transient; nothing has reported yet) — a persisted last-seen clock that
 * says the last hook event was a `done`. Without either we cannot tell an idle CLI from one that is
 * mid-turn, and an exit typed into a running turn abandons it: such a node is skipped, never
 * guessed at. Busy is decided first by `isBusyForPause`; this is the other half.
 */
export function idleForPause(st: AgentNodeStatus | undefined): boolean {
  if (!st) return false
  if (st.state === 'done') return true
  return st.state === undefined && st.lastSeen?.state === 'done'
}

export function planBulkPause(
  targets: BulkPauseTarget[],
  statusOf: (id: string) => AgentNodeStatus | undefined
): BulkPausePlan {
  const plan: BulkPausePlan = { now: [], whenDone: [], alreadyExited: [], skip: [] }
  for (const target of targets) {
    const st = statusOf(target.nodeId)
    const skip = (reason: BulkPauseSkip): void => void plan.skip.push({ target, reason })
    // A relay tab's pane belongs to another machine: never typed into from here.
    if (target.relay) { skip('relay'); continue }
    if (!target.agentId) { skip('not-agent'); continue }
    if (st?.paused) { skip('already-paused'); continue }
    if (!st?.sessionId) { skip('no-session-id'); continue }
    // Resumable AND quittable: an agent with no exit sequence (antigravity resumes but has no
    // in-band quit) is refused by `performExitPhase` at fire time, so it is never planned at all.
    if (!canResumeWith(target.agentId, st.sessionId) || !exitSequence(target.agentId)) {
      skip('not-resumable')
      continue
    }
    const bound: BulkPauseTarget = { ...target, sessionId: st.sessionId }
    // Already exited by Eco: nothing to type; the caller only marks it paused.
    if (st.hibernated) { plan.alreadyExited.push(bound); continue }
    if (st.dropped) { skip('dropped'); continue }
    // The CLI announced its exit: nothing to type an exit into (a shell owns the pane).
    if (st.sessionEnded) { skip('ended'); continue }
    if (isBusyForPause(st)) plan.whenDone.push(bound)
    else if (idleForPause(st)) plan.now.push(bound)
    else skip('state-unknown')
  }
  return plan
}

export function bulkPauseSummary(plan: BulkPausePlan): string {
  const parts: string[] = []
  const n = plan.now.length + plan.alreadyExited.length
  if (n) parts.push(`Pause ${n} now`)
  const w = plan.whenDone.length
  if (w) parts.push(`${w} after ${w === 1 ? 'its' : 'their'} current turn`)
  // The skipped count is not repeated here: the confirm appends the grouped reasons.
  return parts.join(', ') || 'Nothing to pause'
}

/** The confirm dialog's whole message. Skips are named once, with their reasons. */
export function bulkPauseConfirmText(scopeLabel: string, plan: BulkPausePlan): string {
  return (
    `Pause ${scopeLabel}? ${bulkPauseSummary(plan)}. Agents exit; their panes stay, and each ` +
    'comes back with Resume.' +
    (plan.skip.length ? ` Skipped: ${describeSkips(plan.skip)}.` : '')
  )
}

/** What a finished batch did, every outcome counted: a node that is neither paused nor pending
 *  must still show up, or a batch against a disconnected host reads as "Paused 0" and nothing. */
export interface BulkPauseCounts {
  paused: number
  /** Marked "pause after this turn" (planned busy, or turned busy before its exit ran). */
  pending: number
  /** A key write did not reach the pane. */
  unreachable: number
  /** The pane owner could not be read (host unreachable, no ControlMaster): nothing was typed. */
  unverified: number
  /** Re-asked at fire time and refused (another process owns the pane, the state went unknown…). */
  notEligible: number
  /** The exit was typed and the CLI is still there. Nothing is killed. */
  timeout: number
  /** The runner itself threw. */
  failed: number
  skipped: number
}

export function bulkPauseResultText(c: BulkPauseCounts): { kind: 'info' | 'error'; text: string } {
  const parts = [`Paused ${c.paused}`]
  if (c.pending) parts.push(`${c.pending} after their current turn`)
  const unreachable = c.unreachable + c.failed
  if (unreachable) parts.push(`${unreachable} unreachable`)
  if (c.unverified) parts.push(`${c.unverified} couldn't verify the agent in its pane`)
  if (c.notEligible) parts.push(`${c.notEligible} not eligible`)
  if (c.timeout) parts.push(`${c.timeout} still running (nothing killed — check the pane)`)
  if (c.skipped) parts.push(`${c.skipped} skipped`)
  const bad = unreachable + c.unverified + c.notEligible + c.timeout
  return { kind: bad ? 'error' : 'info', text: parts.join(' · ') }
}

const SKIP_TEXT: Record<BulkPauseSkip, string> = {
  'not-agent': 'not an agent',
  'no-session-id': 'no session yet',
  'not-resumable': 'cannot be resumed',
  'already-paused': 'already paused',
  relay: 'on another machine',
  dropped: 'CLI already gone',
  ended: 'CLI already exited',
  'state-unknown': 'state unknown since restart'
}

/** "2 not an agent, 1 already paused" — the skipped half of the confirm, grouped by reason. */
export function describeSkips(skip: BulkPausePlan['skip']): string {
  const n = new Map<BulkPauseSkip, number>()
  for (const s of skip) n.set(s.reason, (n.get(s.reason) ?? 0) + 1)
  return [...n].map(([r, c]) => `${c} ${SKIP_TEXT[r]}`).join(', ')
}

/**
 * Which project's session may carry a node's pane traffic (keys, pane-command and pane-owner reads)
 * during a bulk pause. `null` = refuse, and the runner then reports the node unverified/unreachable:
 *  - no known owner: a node read while its project is still loading has none, and falling back to
 *    the ACTIVE project would route its keys through whatever session that is — a relay tab's
 *    included, i.e. into a pane on another machine;
 *  - a relay-owned node: the planner already skips it, this keeps the route refusing on its own.
 */
export function paneRouteProjectId(owner: { id: string; remote?: boolean } | undefined): string | null {
  if (!owner || owner.remote) return null
  return owner.id
}
