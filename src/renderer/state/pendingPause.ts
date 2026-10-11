import { create } from 'zustand'
import { useAgentStatus, type AgentNodeStatus } from './agentStatus'
import type { BulkPauseTarget } from '../lib/bulkPause'

/** Nodes asked to pause once their current turn ends. TRANSIENT on purpose: after a restart the
 *  agent state is unknown and a mark firing hours later would surprise. */
export const usePendingPause = create<{
  byId: Record<string, BulkPauseTarget>
  add(targets: BulkPauseTarget[]): void
  remove(nodeIds: string[]): void
}>((set) => ({
  byId: {},
  add: (targets) =>
    set((s) => ({ byId: { ...s.byId, ...Object.fromEntries(targets.map((t) => [t.nodeId, t])) } })),
  remove: (ids) =>
    set((s) => {
      if (!ids.some((id) => id in s.byId)) return s
      const byId = { ...s.byId }
      for (const id of ids) delete byId[id]
      return { byId }
    })
}))

/** A turn that ended cleanly: errored and interrupted turns stay pending (the next clean `done`
 *  fires), and a held question/approval ticket means the CLI is still waiting on a person. */
export function shouldFirePendingPause(
  prev: AgentNodeStatus | undefined,
  next: AgentNodeStatus | undefined
): boolean {
  if (!next || next.state !== 'done' || prev?.state === 'done') return false
  if (next.lastTurnError || next.lastTurnInterrupted) return false
  return !(next.held || next.pendingId)
}

/** Fires each pending target once on its done edge and drops marks whose node is gone or paused,
 *  or now runs a different session than the one the mark was taken against (a restart, a model or
 *  account switch, `/clear`): the turn it was waiting on is over, and so is the request. */
export function startPendingPauseWatcher(fire: (t: BulkPauseTarget) => void): () => void {
  return useAgentStatus.subscribe((s, prev) => {
    const pending = usePendingPause.getState().byId
    const ids = Object.keys(pending)
    if (ids.length === 0) return
    const gone: string[] = []
    for (const id of ids) {
      const next = s.byId[id]
      if (!next && prev.byId[id]) {
        gone.push(id)
        continue
      }
      if (next?.paused) {
        gone.push(id) // paused elsewhere
        continue
      }
      const bound = pending[id].sessionId
      if (bound && next?.sessionId && next.sessionId !== bound) {
        gone.push(id)
        continue
      }
      if (shouldFirePendingPause(prev.byId[id], next)) {
        // Drop the mark BEFORE firing: `fire` may re-queue the same node (a fire-time re-ask that
        // finds it busy again answers 'deferred'), and a batch removal after the loop would wipe
        // that fresh mark.
        usePendingPause.getState().remove([id])
        fire(pending[id])
      }
    }
    if (gone.length) usePendingPause.getState().remove(gone)
  })
}
