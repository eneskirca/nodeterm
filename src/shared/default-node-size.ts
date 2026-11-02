// Per-kind default sizes for NEW canvas nodes (Settings → Behavior → Default node size).
//
// Terminal and agent nodes keep their own long-standing `defaultNodeWidth`/`defaultNodeHeight`
// pair; this covers every other kind the add menus create. Group frames are sized to what they
// hold, and subagent/loop cards are ephemeral and laid out by the canvas, so none of those has a
// user default. Existing nodes always keep the size they were saved with.
//
// Machine-local and hand-editable, so every reader goes through `resolveDefaultNodeSize`.

import type { NodeKind } from './types'

export type SizableNodeKind = Extract<
  NodeKind,
  'sticky' | 'editor' | 'diff' | 'video' | 'web' | 'browser' | 'files' | 'dino' | 'trigger' | 'simulator' | 'whiteboard' | 'pull' | 'issues'
>

/** In the order the Settings picker lists them. */
export const SIZABLE_NODE_KINDS: readonly SizableNodeKind[] = [
  'sticky',
  'whiteboard',
  'browser',
  'web',
  'editor',
  'diff',
  'pull',
  'issues',
  'files',
  'video',
  'simulator',
  'trigger',
  'dino'
]

export interface NodeSize {
  width: number
  height: number
}

/** The same ceiling as the terminal setting (`terminalNodeSize`): bigger than any display, small
 *  enough that a typo can't make a node you have to zoom out to find. */
export const NODE_SIZE_MAX: NodeSize = { width: 2400, height: 1600 }

/** The floor of the terminal/agent pair (`defaultNodeWidth`/`defaultNodeHeight`): what
 *  `terminalNodeSize` clamps to, and the bounds the Settings field and the settings verb offer. */
export const TERMINAL_NODE_SIZE_MIN: NodeSize = { width: 280, height: 160 }

/** A sticky note's built-in size and resizer minimum. Shared because the Server Edition creates
 *  stickies too (`headless-node-factory`), and two copies would drift. */
export const STICKY_NODE_SIZE: NodeSize = { width: 240, height: 200 }
export const STICKY_NODE_MIN_SIZE: NodeSize = { width: 160, height: 120 }

/**
 * The stored entry for a kind as the Settings field should SHOW it: the user's own numbers, per
 * axis, unclamped (clamping while typing would turn the "3" of "300" into the minimum before the
 * rest arrives); the built-in value for an axis that is absent or not a finite number. Nodes are
 * still created through `resolveDefaultNodeSize`, which does clamp.
 */
export function storedDefaultNodeSize(stored: unknown, builtin: NodeSize): NodeSize {
  const entry = typeof stored === 'object' && stored !== null ? (stored as Partial<Record<keyof NodeSize, unknown>>) : {}
  const axis = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)
  return { width: axis(entry.width, builtin.width), height: axis(entry.height, builtin.height) }
}

/** `defaultNodeSizes` as read from settings.json, or `{}` when a hand edit made it anything but a
 *  plain object — so a write never spreads a string or array into index keys. */
export function defaultNodeSizesRecord(value: unknown): Partial<Record<SizableNodeKind, NodeSize>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Partial<Record<SizableNodeKind, NodeSize>>)
    : {}
}

/**
 * The size a new node of some kind opens at. `stored` is the user's entry for that kind (absent
 * when they never set one); `builtin` is the kind's shipped default; `min` is the smallest size
 * its resizer allows. Each axis is resolved on its own, so a half-valid hand edit keeps the
 * valid half; anything not a finite number falls back to the built-in value.
 */
export function resolveDefaultNodeSize(stored: unknown, builtin: NodeSize, min: NodeSize): NodeSize {
  const entry = typeof stored === 'object' && stored !== null ? (stored as Partial<Record<keyof NodeSize, unknown>>) : {}
  const axis = (v: unknown, fallback: number, lo: number, hi: number): number => {
    const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : fallback
    return Math.min(hi, Math.max(lo, n))
  }
  return {
    width: axis(entry.width, builtin.width, min.width, NODE_SIZE_MAX.width),
    height: axis(entry.height, builtin.height, min.height, NODE_SIZE_MAX.height)
  }
}
