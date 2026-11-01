/**
 * "Focus the node over there" — which node a directional move (⌘←/→/↑/↓) lands on, and which
 * node the gesture starts from when nothing is focused yet.
 *
 * The gesture is the one terminal multiplexers give you for free (Ghostty's `goto_split`, tmux's
 * `select-pane -L`, i3's `focus left`), but those all navigate a TREE OF SPLITS where "the pane to
 * the left" is a structural fact. On a canvas there is no tree: nodes are free-form rectangles the
 * user dragged, so the answer has to be inferred from geometry.
 *
 * Nearest-by-distance is the obvious inference and the wrong one — the closest node in the raw
 * Euclidean sense is very often the one diagonally up-and-left, so ⌘→ lands somewhere the user
 * never pointed. Candidates are therefore ranked in TWO TIERS:
 *
 *   Tier 0 — the candidate's perpendicular span OVERLAPS the origin's. These are the nodes a user
 *            would call "in the same row" (for a horizontal move) or "the same column" (vertical),
 *            and one of them is the answer whenever one exists, however far away it sits. Ordered
 *            by distance along the axis, so the immediate neighbour beats the one behind it.
 *   Tier 1 — no overlap, i.e. reachable only diagonally. Ordered by axial distance plus a
 *            {@link PERPENDICULAR_WEIGHT} penalty on the sideways offset, which is what stops a
 *            far-off-axis node beating a nearly-aligned one. This tier is why a node sitting alone
 *            on its row is not a dead end in every direction — a dead end there reads as the
 *            feature being broken, not as a deliberate boundary.
 *
 * Ties break on node id, so one canvas always answers the same way and the tests can state it.
 *
 * There is deliberately NO wrap-around: the last node in a direction is the end of the line, which
 * is what `goto_split` does and what keeps repeated presses from cycling forever.
 *
 * Every rect comes from `nodeFocus`'s `nodeFitRect`/`absolutePosition`, never from `node.position`
 * directly, and that is load-bearing rather than tidy: a GROUPED node's own `position` is relative
 * to its frame, so comparing one against a top-level node's compares two different coordinate
 * spaces. A terminal sitting at (24, 60) inside a frame parked at (4000, 0) would otherwise look
 * like the leftmost node on the canvas, and ⌘← from anywhere would fly to it.
 */
import { absolutePosition, nodeFitRect, type FocusableNode } from './nodeFocus'

export type FocusDirection = 'left' | 'right' | 'up' | 'down'

/** xyflow wraps every node in an element with this class and a `data-id` holding the node id —
 *  which is how the gesture finds the node the KEYBOARD is in, not merely the selected one.
 *  Pinned against the installed dist by the test beside this file, the same way keyContext.ts
 *  pins xterm's helper-textarea class: an upgrade that renames it must fail loudly rather than
 *  quietly leave every move starting from the wrong node. Note handles carry a `data-id` too
 *  (a composite), so the class has to be matched FIRST and the attribute read off that element. */
export const FLOW_NODE_CLASS = 'react-flow__node'

/**
 * A focus destination: everything `nodeFocus` needs to place a node in absolute space, plus the
 * node KIND, which is the one thing that decides what may be focused at all. Structural rather
 * than `CanvasNode` so the unit tests need no xyflow types and no DOM.
 */
export interface DirectionalNode extends FocusableNode {
  /** Group FRAMES are containers, not destinations — see {@link isFocusTarget}. */
  type?: string
}

/** Cost of a sideways offset relative to a step along the direction, for the diagonal tier. At 2,
 *  a node twice as far sideways as it is forward loses to one straight ahead. */
const PERPENDICULAR_WEIGHT = 2

/** Centers within this many world px of each other along the axis are not "beyond" each other, so
 *  two nodes the grid snapped into the same column never answer each other's ⌘→. */
const AXIS_EPSILON = 1

/**
 * The node a move in `dir` from `fromId` should focus, or null when `fromId` is the last node that
 * way (or is not on this canvas).
 */
export function nextNodeInDirection(
  nodes: readonly DirectionalNode[],
  fromId: string,
  dir: FocusDirection
): string | null {
  const origin = nodes.find((n) => n.id === fromId)
  if (!origin) return null
  const o = boundsOf(origin, nodes)
  const horizontal = dir === 'left' || dir === 'right'
  const forward = dir === 'right' || dir === 'down' ? 1 : -1

  let best: Score | null = null
  for (const node of nodes) {
    if (node.id === fromId || !isFocusTarget(node)) continue
    const r = boundsOf(node, nodes)
    // A non-finite center poisons every comparison below rather than merely losing them: NaN
    // fails `<` in both directions, so the FIRST such candidate becomes `best` and then nothing
    // valid can displace it. Positions arrive from a persisted workspace file, where a null
    // coordinate is one arithmetic step from NaN, so this is cheaper than trusting the input.
    if (!Number.isFinite(r.cx) || !Number.isFinite(r.cy)) continue
    const advance = forward * ((horizontal ? r.cx : r.cy) - (horizontal ? o.cx : o.cy))
    if (!(advance > AXIS_EPSILON)) continue
    const perp = Math.abs((horizontal ? r.cy : r.cx) - (horizontal ? o.cy : o.cx))
    const overlaps = horizontal
      ? r.top < o.bottom && o.top < r.bottom
      : r.left < o.right && o.left < r.right
    const score: Score = {
      tier: overlaps ? 0 : 1,
      cost: overlaps ? advance : advance + PERPENDICULAR_WEIGHT * perp,
      perp,
      id: node.id
    }
    if (!best || better(score, best)) best = score
  }
  return best?.id ?? null
}

/**
 * The focus target nearest `point`, by center distance — the SEED for a canvas where nothing is
 * focused or selected yet. Without it the first ⌘→ on a freshly opened project would have no
 * origin and do nothing, which is indistinguishable from an unbound chord.
 */
export function nodeNearestPoint(
  nodes: readonly DirectionalNode[],
  point: { x: number; y: number }
): string | null {
  let bestId: string | null = null
  let bestDist = Infinity
  for (const node of nodes) {
    if (!isFocusTarget(node)) continue
    const r = boundsOf(node, nodes)
    const dist = (r.cx - point.x) ** 2 + (r.cy - point.y) ** 2
    if (dist < bestDist || (dist === bestDist && bestId !== null && node.id < bestId)) {
      bestDist = dist
      bestId = node.id
    }
  }
  return bestId
}

/**
 * A group frame is the one node kind that must never be a focus destination: it is a container
 * drawn AROUND the nodes you actually want, so its rect overlaps all of them and it would win
 * every direction from inside itself.
 */
export function isFocusTarget(node: DirectionalNode): boolean {
  return node.type !== 'group'
}

interface Bounds {
  left: number
  top: number
  right: number
  bottom: number
  cx: number
  cy: number
}

/** The node's absolute bounds. `nodeFitRect` answers null when neither a measurement nor a
 *  persisted size is known (a node added this tick, before layout); such a node is treated as a
 *  POINT at its absolute position, so it is still reachable but can never overlap anyone's row —
 *  the honest answer for something with no size yet. */
function boundsOf(node: DirectionalNode, all: readonly DirectionalNode[]): Bounds {
  const rect = nodeFitRect(node, all) ?? { ...absolutePosition(node, all), width: 0, height: 0 }
  const { x, y, width, height } = rect
  return {
    left: x,
    top: y,
    right: x + width,
    bottom: y + height,
    cx: x + width / 2,
    cy: y + height / 2
  }
}

interface Score {
  tier: number
  cost: number
  perp: number
  id: string
}

const better = (a: Score, b: Score): boolean =>
  a.tier !== b.tier
    ? a.tier < b.tier
    : a.cost !== b.cost
      ? a.cost < b.cost
      : a.perp !== b.perp
        ? a.perp < b.perp
        : a.id < b.id

/** What a directional move should do: swap the focus-mode node, or travel the camera. */
export type DirectionalMove = { kind: 'swap-focus' | 'travel'; id: string }

export interface DirectionalMoveContext {
  /** Focus mode's node (`useFocusNode.focusedId`), or null on the plain canvas. */
  focusedId: string | null
  /** The node the KEYBOARD is in (the `.react-flow__node` ancestor of the active element). */
  keyboardId: string | null
  /** The single selected focus target, if any. */
  selectedId: string | null
  /** The view center in world coordinates, for seeding a canvas with no origin; null = unknown. */
  viewCenter: { x: number; y: number } | null
}

/**
 * The one decision behind ⌘←/→/↑/↓, in both places the chord can fire:
 *
 *  - **Focus mode** — one terminal fills the window and the flow pane is display:none, so there is
 *    no camera to move; the move SWAPS the focused node for its neighbour and the user stays in
 *    focus mode (before this, going from one focused terminal to the next was ⌘⇧F, ⌘→, ⌘⇧F). The
 *    origin is the focused node itself — the reparent detaches its root from the xyflow wrapper,
 *    so the keyboard origin reads as null there — and the candidates are TERMINALS only, the one
 *    kind focus mode can show (`focusTargetId`). A null at the edge is still a claimed chord.
 *  - **Canvas** — the origin is the node the keyboard is in, else the selected node, else (first
 *    press) the node nearest the view center is ADOPTED rather than moved from; the move TRAVELS.
 */
export function planDirectionalMove(
  nodes: readonly DirectionalNode[],
  dir: FocusDirection,
  ctx: DirectionalMoveContext
): DirectionalMove | null {
  if (ctx.focusedId) {
    const terminals = nodes.filter((n) => n.type === 'terminal')
    const next = nextNodeInDirection(terminals, ctx.focusedId, dir)
    return next ? { kind: 'swap-focus', id: next } : null
  }
  const from = ctx.keyboardId ?? ctx.selectedId
  if (!from) {
    const seed = ctx.viewCenter ? nodeNearestPoint(nodes, ctx.viewCenter) : null
    return seed ? { kind: 'travel', id: seed } : null
  }
  const next = nextNodeInDirection(nodes, from, dir)
  return next ? { kind: 'travel', id: next } : null
}
