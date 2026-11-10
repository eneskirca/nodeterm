// Where a node is and how big it is, as `list` reports it (issue #1288): the numbers `place` and
// `resize` take back, so a script can read a layout, copy a size the user set by hand onto the
// other nodes, and check the result.
//
// Two sources, one shape. The LIVE canvas reports what React Flow MEASURED from the DOM — the size
// actually on screen — and falls back to the persisted width/height for a node that has not been
// measured yet (the first tick after a load). A project that is NOT on screen was never rendered,
// so its rows are the PERSISTED size: what the node was born with, or the last size the user (or
// `resize`) gave it — which is what it will be drawn at when the project is next shown.
//
// In @shared so the control listing (`list`) is one implementation on the desktop canvas and the
// Server Edition. `COLLAPSED_HEIGHT` lives here for the same reason; lib/nodeSizing re-exports it.

import { rootPositionWith } from '@shared/root-position'

/** Height of a node when collapsed (header only). Re-exported by renderer lib/nodeSizing. */
export const COLLAPSED_HEIGHT = 40

export interface NodeGeometry {
  /** Top-left in ROOT (canvas) space — a framed node's frame origins are added in. Whole px. */
  x: number
  y: number
  /** The size it occupies now (a collapsed node: its header bar). Whole px. */
  width: number
  height: number
  /** The frame it sits in, or null at the top level. */
  parent: string | null
  /** Header-only. `expandedHeight` is the height it opens to — the one `resize --height` sets. */
  collapsed?: true
  expandedHeight?: number
}

// Rounded: sub-pixel positions are routine (a drag at fractional zoom), and the verbs that take these
// numbers back take whole pixels. `+ 0` normalizes a -0.
const px = (v: number): number => Math.round(v) + 0

/** The slice of a live React Flow node this reads. */
export interface LiveGeometryNode {
  id: string
  position: { x: number; y: number }
  parentId?: string
  measured?: { width?: number; height?: number }
  width?: number | null
  height?: number | null
  style?: { width?: unknown; height?: unknown }
  data: { collapsed?: unknown; expandedHeight?: unknown }
}

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

/** A node on the LIVE canvas: measured size first, persisted second (see the header). */
export function liveNodeGeometry(node: LiveGeometryNode, nodes: readonly LiveGeometryNode[]): NodeGeometry {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const root = rootPositionWith(node, (id) => byId.get(id))
  const width = num(node.measured?.width) ?? num(node.width) ?? num(node.style?.width) ?? 0
  const height = num(node.measured?.height) ?? num(node.height) ?? num(node.style?.height) ?? 0
  const collapsed = !!node.data.collapsed
  const expanded = num(node.data.expandedHeight)
  return {
    x: px(root.x),
    y: px(root.y),
    width: px(width),
    height: px(height),
    parent: node.parentId ?? null,
    ...(collapsed ? { collapsed: true as const, ...(expanded !== undefined ? { expandedHeight: px(expanded) } : {}) } : {})
  }
}

/** The slice of a SERIALIZED node (`CanvasNodeState`) this reads. */
export interface StoredGeometryNode {
  id: string
  position: { x: number; y: number }
  size: { width: number; height: number }
  parentId?: string
  collapsed?: boolean
}

/**
 * A node of a project that is NOT on screen: the persisted size. A collapsed node persists the
 * height it EXPANDS to (`flowToNodeStates`), so its drawn height is the header bar's.
 */
export function storedNodeGeometry(node: StoredGeometryNode, nodes: readonly StoredGeometryNode[]): NodeGeometry {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const root = rootPositionWith(node, (id) => byId.get(id))
  const collapsed = !!node.collapsed
  return {
    x: px(root.x),
    y: px(root.y),
    width: px(node.size.width),
    height: px(collapsed ? COLLAPSED_HEIGHT : node.size.height),
    parent: node.parentId ?? null,
    ...(collapsed ? { collapsed: true as const, expandedHeight: px(node.size.height) } : {})
  }
}

/** The text form behind `list --geometry on`: ` @ x,y w×h`, then where it sits and whether it is folded. */
export function geometryText(g: NodeGeometry): string {
  return (
    ` @ ${g.x},${g.y} ${g.width}×${g.height}` +
    (g.parent ? ` in ${g.parent}` : '') +
    (g.collapsed ? ` collapsed${g.expandedHeight !== undefined ? ` (expands to ${g.expandedHeight})` : ''}` : '')
  )
}
