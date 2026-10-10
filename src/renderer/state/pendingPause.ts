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

/** Fires each pending target once on its done edge and drops marks whose node is gone or paused. */
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
      if (shouldFirePendingPause(prev.byId[id], next)) {
        gone.push(id)
        fire(pending[id])
      }
    }
    if (gone.length) usePendingPause.getState().remove(gone)
  })
}
