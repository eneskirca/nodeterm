// The parent-first node order — ONE definition, used by the renderer's live React Flow array
// (`renderer/state/workspace.ts`), the server's headless canvas control, and the shared reducer
// every canvas op goes through (`applyCanvasMutation`, which is also the Server Edition canvas
// authority's reducer). Pure: no DOM, no fs.

import type { CanvasNodeState } from './types'

/** The two fields the order reads: every node shape in the app (a persisted `CanvasNodeState`,
 *  a React Flow `Node`) carries both. */
interface OrderedNode {
  id: string
  parentId?: string
}

/**
 * Group (parent) nodes must precede their descendants in the array (React Flow requirement).
 * With nesting the old "all groups, then everything else" split is not enough — a child frame
 * could still be emitted before its parent — so groups are emitted depth-first from the root.
 * Non-group nodes keep their relative order, after every group.
 *
 * This order is also the DOWNGRADE contract: `flowToNodeStates` preserves array order, and an
 * older build's flat `kind === 'group'` sort returns 0 for two groups, which a stable sort
 * (ES2019+) leaves alone. So a nested tree written by this build still hydrates parent-first,
 * and therefore still RENDERS, on a build that predates nesting. That holds for a governed
 * project too: the Server Edition canvas authority writes the array its reducer built, and the
 * reducer re-sorts with this whenever an op appends a node or changes its `parentId`.
 *
 * `isGroup` is the only thing that differs between the two node shapes (`kind` on a persisted
 * state, `type` on a React Flow node). A cyclic `parentId` chain is emitted once, never recursed
 * forever; a `parentId` naming a node that is absent (or not a group) is simply not followed.
 */
export function groupsFirstBy<T extends OrderedNode>(nodes: readonly T[], isGroup: (node: T) => boolean): T[] {
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const emitted = new Set<string>()
  const visiting = new Set<string>()
  const groups: T[] = []
  const emitGroup = (node: T): void => {
    if (emitted.has(node.id) || !isGroup(node)) return
    if (visiting.has(node.id)) return // cyclic parentId: emit once, don't recurse forever
    visiting.add(node.id)
    const parent = node.parentId ? byId.get(node.parentId) : undefined
    if (parent && isGroup(parent)) emitGroup(parent)
    visiting.delete(node.id)
    if (!emitted.has(node.id)) {
      emitted.add(node.id)
      groups.push(node)
    }
  }
  nodes.forEach(emitGroup)
  return [...groups, ...nodes.filter((node) => !isGroup(node))]
}

/** `groupsFirstBy` for persisted node states (`kind === 'group'`). */
export function groupsFirst(nodes: readonly CanvasNodeState[]): CanvasNodeState[] {
  return groupsFirstBy(nodes, (node) => node.kind === 'group')
}
