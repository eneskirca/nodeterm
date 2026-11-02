import { create } from 'zustand'
import type { PullHighlight, PullProposal, ShownProposal } from '@shared/pull-agent-verbs'

/**
 * What a linked agent asked a pull node to show or do (`pr-show`, `pr-propose`). Transient on
 * purpose: never persisted, so a proposal never outlives the app run or reaches project.json, and
 * only the user's Confirm in the node turns it into a GitHub write.
 */
export interface PullAgentState {
  highlight: Record<string, PullHighlight>
  /** `seq` grows on every propose, so a replaced proposal remounts the bar and disarms Confirm. */
  proposal: Record<string, ShownProposal>
  show(nodeId: string, highlight: Omit<PullHighlight, 'seq'> | null): void
  propose(nodeId: string, proposal: PullProposal): void
  dismiss(nodeId: string): void
}

let seq = 0

export const usePullAgent = create<PullAgentState>((set) => ({
  highlight: {},
  proposal: {},
  show: (nodeId, highlight) => set((s) => {
    const next = { ...s.highlight }
    if (highlight) next[nodeId] = { ...highlight, seq: ++seq }
    else delete next[nodeId]
    return { highlight: next }
  }),
  propose: (nodeId, proposal) => set((s) => ({ proposal: { ...s.proposal, [nodeId]: { ...proposal, seq: ++seq } } })),
  dismiss: (nodeId) => set((s) => {
    const next = { ...s.proposal }
    delete next[nodeId]
    return { proposal: next }
  })
}))

/** An edge (rope or context link) joins the two nodes, in either direction. */
export function nodesJoined(edges: readonly { source: string; target: string }[], a: string, b: string): boolean {
  return edges.some((e) => (e.source === a && e.target === b) || (e.source === b && e.target === a))
}

/** The agent nodes (terminal nodes running an agent CLI) joined to the pull node, in canvas order:
 *  who "Send to agent" may send to. Title falls back to the node id. */
export function linkedAgents(
  edges: readonly { source: string; target: string }[],
  nodes: readonly { id: string; type?: string; data: { title?: unknown; agentId?: unknown } }[],
  pullId: string
): { id: string; title: string }[] {
  return nodes
    .filter((n) => n.id !== pullId && n.type === 'terminal' && typeof n.data.agentId === 'string' && n.data.agentId &&
      nodesJoined(edges, n.id, pullId))
    .map((n) => ({ id: n.id, title: (typeof n.data.title === 'string' && n.data.title.trim()) || n.id }))
}
