import type { NodeKind } from '@shared/types'

/**
 * Minimum width/height for each node kind. These are the single source of truth
 * for the `minWidth`/`minHeight` every node passes to React Flow's `<NodeResizer>` —
 * the components read them here instead of re-declaring the literals, so the two
 * can't drift apart.
 *
 * The resizer enforces these only during a drag. Programmatic size changes (e.g.
 * align-to-grid) bypass the resizer, so they must clamp to these values themselves
 * to avoid shrinking a node below what its resizer would allow.
 */
export const NODE_MIN_SIZES: Record<NodeKind, { width: number; height: number }> = {
  terminal: { width: 260, height: 160 },
  sticky: { width: 160, height: 120 },
  group: { width: 200, height: 140 },
  editor: { width: 320, height: 200 },
  diff: { width: 420, height: 220 },
  video: { width: 320, height: 200 },
  web: { width: 320, height: 200 },
  browser: { width: 360, height: 240 },
  subagent: { width: 180, height: 84 },
  loop: { width: 180, height: 84 },
  dino: { width: 400, height: 160 }
}

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * Snap a rectangle so all four corners land on grid intersections: each edge
 * (left, top, right, bottom) rounds independently to its nearest grid line. The
 * width/height are then raised to the node kind's grid-aligned minimum so a small
 * node (or a large grid) never inverts or undershoots what its `<NodeResizer>`
 * would allow. Left/top stay at their snapped positions; only the right/bottom
 * edge extends when the minimum has to kick in.
 */
export function snapNodeToGrid(g: number, kind: NodeKind, r: Rect): Rect {
  const x = Math.round(r.x / g) * g
  const y = Math.round(r.y / g) * g
  let width = Math.round((r.x + r.width) / g) * g - x
  let height = Math.round((r.y + r.height) / g) * g - y
  const min = NODE_MIN_SIZES[kind] ?? { width: 0, height: 0 }
  const minW = Math.ceil(min.width / g) * g
  const minH = Math.ceil(min.height / g) * g
  if (width < minW) width = minW
  if (height < minH) height = minH
  return { x, y, width, height }
}
