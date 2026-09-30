/**
 * Record WHO opened a node, at the moment an open verb draws its lineage rope.
 *
 * This is the half of the station-failure notice (@shared/station-notice) that only the opening
 * dispatch knows: which agent asked for this node. A rope alone cannot answer it later — an
 * `--after` node is roped to every station it waits on as well, with the same id shape — so the
 * opener is written onto the node itself, and the notice is honoured only while BOTH agree (the
 * field names an agent, and that agent's rope to the node is still on the canvas).
 *
 * Terminal nodes only: a page, a video or a browser node has no agent in it, cannot fail, and
 * carrying the field would only put noise into a git-shared file.
 */
import { isSafeNodeId } from '@shared/safe-id'

export function withOpenedBy<N extends { id: string; type?: string; data: Record<string, unknown> }>(
  node: N,
  openerId: string
): N {
  if (node.type !== 'terminal' || !isSafeNodeId(openerId) || openerId === node.id) return node
  if (node.data.openedBy === openerId) return node
  return { ...node, data: { ...node.data, openedBy: openerId } }
}

/** Stamp one node inside a node array; the SAME array back when nothing changed, so a caller in a
 *  `setNodes` updater does not re-render the canvas for a display node that carries no opener. */
export function stampOpenedBy<N extends { id: string; type?: string; data: Record<string, unknown> }>(
  nodes: N[],
  nodeId: string,
  openerId: string
): N[] {
  let changed = false
  const out = nodes.map((n) => {
    if (n.id !== nodeId) return n
    const next = withOpenedBy(n, openerId)
    if (next !== n) changed = true
    return next
  })
  return changed ? out : nodes
}
