// Pure planner for "Pause all": sorts terminal nodes into pause-now / pause-after-the-current-turn /
// already-exited / skipped. No React, no store access — the caller injects the status lookup, so
// the same rules serve the menu, the palette and the tests.
import { canResumeWith } from '../../shared/agents/config'
import type { AgentNodeStatus } from '../state/agentStatus'

export type BulkPauseSkip =
  | 'not-agent' | 'no-session-id' | 'not-resumable' | 'already-paused' | 'relay' | 'dropped' | 'ended'

export interface BulkPauseTarget {
  nodeId: string
  agentId: string | undefined
  relay: boolean
  hostKey: string
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
 * An unknown state is not busy (nothing says a turn is running).
 */
export function isBusyForPause(st: AgentNodeStatus | undefined): boolean {
  if (!st) return false
  if (st.state === 'working' || st.state === 'waiting' || st.state === 'blocked') return true
  return !!(st.held || st.pendingId)
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
    if (!canResumeWith(target.agentId, st.sessionId)) { skip('not-resumable'); continue }
    // Already exited by Eco: nothing to type; the caller only marks it paused.
    if (st.hibernated) { plan.alreadyExited.push(target); continue }
    if (st.dropped) { skip('dropped'); continue }
    // The CLI announced its exit: nothing to type an exit into (a shell owns the pane).
    if (st.sessionEnded) { skip('ended'); continue }
    if (isBusyForPause(st)) plan.whenDone.push(target)
    else plan.now.push(target)
  }
  return plan
}

export function bulkPauseSummary(plan: BulkPausePlan): string {
  const parts: string[] = []
  const n = plan.now.length + plan.alreadyExited.length
  if (n) parts.push(`Pause ${n} now`)
  const w = plan.whenDone.length
  if (w) parts.push(`${w} after ${w === 1 ? 'its' : 'their'} current turn`)
  if (plan.skip.length) parts.push(`skip ${plan.skip.length}`)
  return parts.join(', ') || 'Nothing to pause'
}
