/**
 * The MOUNTING SURFACE of the glyphgrid renderer (Phase 1b): the one WebGL2 canvas every
 * terminal on the board paints into, the rAF driver that submits its frames, and the two feeds
 * the canvas owns — the camera and the node paint order.
 *
 * Three things live here and nowhere else:
 *
 * 1. **The engine singleton.** ONE GL context for the whole canvas is the entire point of the
 *    shared renderer (the per-terminal path fights Chromium's ~16-context cap through
 *    `terminal/webgl-budget.ts`; see the WebGL section of CLAUDE.md). So the context is a module
 *    singleton, not component state: it must survive `<SharedGlyphLayer/>` remounting, and it is
 *    created LAZILY — a user who never turns the experimental mode on must never cost a GPU
 *    context, which is why `getSharedGlyphContext()` returns null while the mode is off.
 * 2. **The failure path, and the one recovery.** `GlyphGridEngine.frame()` RETHROWS on a GL error
 *    by contract (it restores its damage first), and that lands on `failSharedGlyph()`: warn once,
 *    tear the context down, and flip the store's `failed` — the session-level "everyone back to
 *    the DOM renderer" signal that TerminalNode reads. A LOST CONTEXT is no longer one of those: it
 *    arrives as an event rather than a throw, and it is restored ONCE per context
 *    (`createContextLossPolicy` → `engine.suspendGpu` / `reviveGpu`), because a GPU reset is what
 *    macOS does on sleep/wake and the shared renderer is meant to be the default. A second loss
 *    inside the cooldown, or a rebuild that throws, falls back through the same `failSharedGlyph`.
 *    **A GPU reset has a SECOND half**: it also blanks the OffscreenCanvas the atlas rasterizes
 *    into, and that one cannot be restored — its pixels are gone while `GlyphAtlas.slots` still
 *    claims every key is cached, which is the "every terminal went blank at once" report. It is
 *    answered by the same policy object driving `rebuildSharedContext` instead of a revive
 *    (`createContext`'s `atlasLoss`), and by a pixel check on the revive path for the silent case
 *    that fires no event at all (`reviveGpuOrRebuild`, `ATLAS_SENTINEL_RGBA`).
 * 3. **The seams the rest of the integration reads**: `useSharedGlyph` (mode + generation +
 *    failure), `setNodeZOrder`/`nodeZFor`/`subscribeNodeZOrder` (paint order),
 *    `setOpaqueNodeIds`/`nodeIsOpaque`/`subscribeOpaqueSet` (which terminals must leave the shared
 *    canvas — see the stacking rule above that set), and `setSharedGlyphCamera` (pan/zoom). Every
 *    one of them is a no-op while no context exists, so Canvas can call them unconditionally and a
 *    default-mode user pays a null check.
 *
 * The component and the GL singleton have NO unit tests by design — there is no WebGL2, no
 * OffscreenCanvas and no layout in vitest's node environment. The pure parts (order signature,
 * store transitions, z map) are tested; the rest is on the T6 device checklist. That split is the
 * same one `terminal/glyphgrid-attach.ts` makes for xterm's internals.
 */

import { useEffect, useRef, useState } from 'react'
import { create } from 'zustand'
import {
  GUTTER_PX,
  GlyphAtlas,
  type GlyphAtlasSubscription,
  type GlyphSlotAllocation
} from '../glyphgrid/atlas'
import { sanitizeCamera, type Camera } from '../glyphgrid/camera'
import { GlyphGridEngine } from '../glyphgrid/engine'
import { setBlankCellProbe } from '../glyphgrid/feed'
import { createFrameLoop, type FrameLoop } from '../glyphgrid/frame-driver'
import type { GlyphGL } from '../glyphgrid/gl'
import { createWebgl2GL } from '../glyphgrid/gl-webgl2'
import { createCanvasRasterizer, type AtlasPageHealth } from '../glyphgrid/raster'
import { useProjects } from '../state/projects'
import { useSettings } from '../state/settings'
import { useViewMode, viewFor } from '../state/viewMode'

/** Atlas page edge, in DEVICE pixels. 2048 (not Phase 0's 1024) because the atlas cells are
 *  device-sized AND the page is now keyed by COLOUR: at dpr 2 a 13px terminal font is roughly a
 *  16x32 device cell, which on a 2048 page (slot pitch = the cell plus a gutter each side) leaves
 *  room for a few thousand `(code, style, fg, bg)` slots. Under the old monochrome keying that was
 *  a whole session's glyph REPERTOIRE; under colour keying the same repertoire costs one slot per
 *  colour pair it is ever drawn in, so the page is a working set rather than a cache of everything.
 *
 *  Which is why filling it is a NORMAL event, not a failure: `GlyphAtlas` answers a full page by
 *  clearing it and telling every addon to repack (see its `reset`), so the cost is one expensive
 *  frame instead of the missing text an earlier version of this comment described. Sizing the page
 *  generously is therefore about keeping resets RARE (they are logged — see `installAtlasResetLog`),
 *  not about never reaching the end of it.
 *
 *  2048² RGBA = 16 MB, plus the mip chain the minification filter needs — clamped to MAX_SAFE_LOD,
 *  so levels 1 and 2 only, about 5 MB more. ~21 MB of VRAM, once, for the whole canvas. */
const ATLAS_PAGE_PX = 2048

/** A cell larger than this would make the atlas page hold almost nothing. The number now comes
 *  from xterm rather than from a measurement of a user-typed font family, so this is a sanity
 *  clamp on a pathological font size rather than a guard against a bad guess. */
const MAX_CELL_PX = 256

/**
 * The cell the atlas rasterizes into, in DEVICE pixels.
 *
 * **The invariant: the atlas texel grid IS xterm's device cell grid, always.** The engine draws a
 * cell as `css.cell × zoom` onto a dpr-scaled buffer, i.e. `device.cell` device pixels at zoom 1,
 * and the atlas slot is stretched over exactly that quad. Any disagreement between the two is a
 * per-glyph resample — the "text is rougher than the DOM renderer" report. So the atlas does not
 * measure anything itself: the first terminal to build the context hands over xterm's own
 * `dimensions.device.cell`, which already carries xterm's rounding chain (charSize × dpr, ceil on
 * the char height, letterSpacing, lineHeight).
 *
 * One cell for the whole canvas is correct because the font settings are GLOBAL — every terminal
 * computes the same device cell from the same font family/size and the same dpr.
 */
export interface DeviceCell {
  cellW: number
  cellH: number
}

// ---------------------------------------------------------------------------------------------
// Store — the reactive half of the seam
// ---------------------------------------------------------------------------------------------

interface SharedGlyphState {
  /** Resolved renderer mode is 'shared'. Written only by `applyRendererMode` (App.tsx), and false
   *  unless the user opted into the experimental mode — which is what keeps this whole module
   *  inert for everyone else. */
  enabled: boolean
  /** Bumped whenever every mounted terminal must re-evaluate its participation: the mode was
   *  turned ON, the context was rebuilt (font change), the mode was turned off, or the session
   *  failed. TerminalNode subscribes to exactly this number — the context it then asks for
   *  answers what to do next (a new engine, or null = back to the DOM renderer). */
  generation: number
  /** Session-level "the shared renderer is off for good" — set by the rAF catch, or by a context
   *  loss that the restore policy refused to answer (a second one inside `RESTORE_COOLDOWN_MS`, or
   *  a rebuild that threw). Deliberately NOT auto-cleared: a GPU that just threw at us gets one
   *  chance per app run, and a retry loop is how you turn a bad driver into a flicker. */
  failed: boolean
  setEnabled(on: boolean): void
  bumpGeneration(): void
  markFailed(): void
}

export const useSharedGlyph = create<SharedGlyphState>((set, get) => ({
  enabled: false,
  generation: 0,
  failed: false,
  setEnabled(on) {
    if (get().enabled === on) return
    if (on) {
      // Turning the mode ON creates nothing — the first terminal that asks builds the context,
      // lazily — but it must still be ANNOUNCED, in the same single set() so the notification
      // carries the new `enabled` alongside the bump. Every mounted terminal re-evaluates its
      // participation on a generation change; without the bump here, flipping the setting with a
      // canvas full of live terminals would do nothing visible until each of them remounted (a
      // project switch), and the setting would look broken. Safe for a node that has never
      // registered a grid: its teardown is a no-op and its re-setup is the same gated
      // `setupGlyph()` a fresh mount runs.
      //
      // A FRESH CELL EPOCH too: the next context is built from whichever terminal asks first, and
      // whatever the last one measured — possibly before a webfont resolved — must not still be
      // holding this epoch's one drift rebuild. See `CellRebuildGuard`.
      cellGuard.beginEpoch()
      set({ enabled: true, generation: get().generation + 1 })
      return
    }
    set({ enabled: on })
    // Turning the mode OFF hands the GPU context back. The whole point of the shared renderer is
    // that contexts are scarce (see terminal/webgl-budget.ts), so leaving one — plus a 16 MB
    // atlas — parked for a mode the user just left would be the exact cost this feature exists to
    // remove.
    disposeContext()
    // ...and the disposal MUST be announced. Every registered grid is now holding an inert handle;
    // without the bump a terminal that subscribes to `generation` alone would keep writing rows
    // into nothing and stay blank until it remounted. Same one-signal contract the failure path
    // honors — never dispose the context without bumping.
    set({ generation: get().generation + 1 })
  },
  bumpGeneration() {
    set({ generation: get().generation + 1 })
  },
  markFailed() {
    // Delegates so that "the session failed" has exactly ONE implementation: warn once, drop the
    // context, then flip the flag. A store action that only flipped the flag would be a reachable
    // half-failure — the flag set, the GPU context still held — and it is the shape a caller
    // naturally reaches for.
    failSharedGlyph('marked failed')
  }
}))

/** Non-reactive gate for the imperative call sites (TerminalNode's register path). */
export function sharedGlyphActive(): boolean {
  const s = useSharedGlyph.getState()
  return s.enabled && !s.failed
}

/**
 * Will this canvas paint terminals into the shared context — whether or not one has been BUILT
 * yet? This, not the presence of a context object, is the question a terminal asks when deciding
 * which renderer it belongs to (and therefore whether it takes a WebGL budget client).
 *
 * Deliberately non-creating, and deliberately NOT `getSharedGlyphContext(…) !== null`. Since the
 * atlas adopts a live terminal's device cell, the context now comes into existence at the first
 * `setupGlyph` — so "no context yet" is the normal state at a fresh mount, and again after every
 * font change (the layer disposes the context BEFORE it bumps the generation). A caller reading
 * that as "not shared" would hand every terminal on the canvas a budget client moments before
 * they all attach grids: the both-renderers hazard. Nor may such a caller build one to find out —
 * at the font-change bump xterm has not re-measured its cell yet, so a context created there
 * would rasterize its atlas at the OLD cell while every grid registers against the new one.
 *
 * False therefore means only: the mode is off, the session has failed, or this machine has
 * already proved it cannot build a context (`creationAttempted` with nothing live — a flag every
 * disposal resets, so a font change never looks like a failure).
 */
export function sharedGlyphAvailable(): boolean {
  if (!sharedGlyphActive()) return false
  return live !== null || !creationAttempted
}

/** Reactive form of `sharedGlyphActive()` — Canvas mounts the layer on this. */
export function useSharedGlyphActive(): boolean {
  return useSharedGlyph((s) => s.enabled && !s.failed)
}

// ---------------------------------------------------------------------------------------------
// Node paint order
// ---------------------------------------------------------------------------------------------

/** The separator for the order signature. NUL cannot occur in a node id (they are nanoid/uuid
 *  shaped), so `split` is an exact inverse of `join`. */
const ORDER_SEP = '\u0000'

let zOrder = new Map<string, number>()
let zOrderSig = ''
const zListeners = new Set<() => void>()

/** React Flow's selection elevation (`@xyflow/system`'s `SELECTED_NODE_Z`). Copied rather than
 *  imported because it is not exported; pinned by `nodeStackZ`'s tests. */
const SELECTED_NODE_Z = 1000

/** The node fields the stacking model reads. */
export interface StackOrderNode {
  id: string
  parentId?: string
  selected?: boolean
}

/**
 * REPRODUCTION of the z React Flow assigns each node, for this app's configuration: no explicit
 * `zIndex` anywhere, `elevateNodesOnSelect` at its default (on), and — the detail that decides
 * everything below — **`zIndexMode` at its default, which is `'basic'`, not `'auto'`**. Nothing in
 * `src/` passes the prop, and `@xyflow/react` 12.11 defaults it to `'basic'` in both
 * `getInitialState` and the `<ReactFlow>` component. The whole rule is then two lines of
 * `calculateZ` / `calculateChildXYZ`:
 *
 *  - Every node is `selected ? 1000 : 0`.
 *  - A CHILD is then `parentZ >= childZ ? parentZ + 1 : childZ`, its parent resolved first (React
 *    Flow requires parents before children in the array, which `nodeStatesToFlow` guarantees).
 *
 * What that means on this canvas: a group FRAME is z 0, tied with every ungrouped node — so array
 * order decides between them, and since frames sort FIRST, an ungrouped terminal overlapping a
 * populated frame paints ON TOP of it. A frame's child is 1, above both. A selected frame is 1000
 * and carries its children to 1001, above a selected ungrouped node at 1000. Nested frames stack
 * 0 / 1 / 2.
 *
 * **Two wrong models have been shipped here; both are worth naming.** Round 5's first cut modelled
 * selection only, which put a grouped terminal BELOW an ungrouped one it is in fact above. Its
 * replacement transcribed the `'auto'` branch, complete with the `ROOT_PARENT_Z_INCREMENT` banding
 * that gives a populated frame z 10 — which is gated on `zIndexMode === 'auto'` and therefore never
 * runs here. That one said an ungrouped terminal sitting on a frame was BELOW the frame, so the
 * terminal stayed transparent and the frame's border and label pill showed through it: exactly the
 * ghost this round exists to delete. The lesson is in the verification, not the reading — the model
 * is now checked against the real `adoptUserNodes`, and the tests state the numbers it returns.
 *
 * With the banding gone the model carries no order-dependent state, which also removes the
 * `checkEquality` caveat this comment used to carry: z depends only on `selected` and the parent
 * chain, React Flow recomputes every CHILD on each adopt regardless of reuse, and a reused ROOT's
 * z was computed from an identical node object. The model is exact, not approximate.
 */
export function nodeStackZ(nodes: readonly StackOrderNode[]): Map<string, number> {
  const z = new Map<string, number>()
  const byId = new Map<string, StackOrderNode>()
  for (const n of nodes) byId.set(n.id, n)
  for (const node of nodes) {
    const ownZ = node.selected ? SELECTED_NODE_Z : 0
    z.set(node.id, ownZ)
    if (!node.parentId) continue
    const parent = byId.get(node.parentId)
    // React Flow warns and gives up on a child whose parent is missing or comes LATER in the
    // array; `nodeStatesToFlow` sorts parents first precisely so this cannot happen.
    if (!parent || !z.has(parent.id)) continue
    const parentZ = z.get(parent.id) ?? 0
    z.set(node.id, parentZ >= ownZ ? parentZ + 1 : ownZ)
  }
  return z
}

/**
 * The order React Flow actually PAINTS the nodes in: ascending `nodeStackZ`, ties broken by array
 * order (a stable sort). Later in this list = nearer the viewer.
 *
 * ONE function, because two consumers must never disagree about it: `nodeOrderSig` (the grids' z)
 * and `opaqueNodeIds` (which terminals may stay on the shared canvas at all). If the opaque set
 * were derived from a different order than the z, a terminal could be told it is in the clear by
 * one rule and painted underneath by the other — the mixed-order soup of round 4, reintroduced one
 * level down.
 */
export function effectiveStackOrder<T extends StackOrderNode>(nodes: readonly T[]): readonly T[] {
  const z = nodeStackZ(nodes)
  let ordered = false
  for (const n of nodes) {
    if (z.get(n.id) !== 0) {
      ordered = true
      break
    }
  }
  // Every z is 0 — no selection and no group frame with children anywhere — so the array is already
  // in paint order and the input is returned rather than an identical copy. Worth having (a canvas
  // with no groups and nothing selected is a real state, and this runs on every nodes change) but
  // NOT the common case it was once described as: one populated group frame gives its children z 1
  // and puts every nodes change through the sort.
  if (!ordered) return nodes
  return nodes
    .map((n, i) => ({ n, i, z: z.get(n.id) ?? 0 }))
    .sort((a, b) => a.z - b.z || a.i - b.i)
    .map((e) => e.n)
}

/**
 * The paint order of the TERMINAL nodes, as one string. Canvas recomputes it per nodes change and
 * only pushes when it differs — a string compare instead of an array diff, the same trick the
 * data-signature effect next to it uses.
 *
 * Only terminals: they are the only kind that registers a grid, and mixing other kinds in would
 * churn the signature on every sticky edit.
 *
 * **The rule is `effectiveStackOrder`** — React Flow's own z (selection elevation and the
 * frame-child lift; see `nodeStackZ`), ties broken by array order. The canvas z among the glyph
 * grids mirrors the DOM's, so both worlds tell the same story about who is on top.
 *
 * Round 4 removed the mirroring and turned the PROP off instead. That was the wrong end of the
 * problem: it did make the two orders agree, but at the cost of "click/drag brings a node to the
 * front", which the user rejected outright. Round 5 fixes the overlap where it actually lives —
 * a terminal whose transparent body could reveal a node BENEATH it leaves the shared canvas and
 * paints itself on its own DOM renderer (`opaqueNodeIds` below). With every overlapping-top
 * terminal off the canvas, no two grids can be in the configuration this signature used to be
 * blamed for, so mirroring the elevation is free again.
 *
 * It matters mainly for TRANSIENT states — the frames between an overlap starting and the opaque
 * set being recomputed, and the frames after it clears — since a terminal that is durably stacked
 * over something is on the DOM renderer and owns no grid at all. Those are precisely the frames in
 * which a wrong z is visible, which is why the mirroring is worth its handful of lines.
 */
export function nodeOrderSig(
  nodes: readonly (StackOrderNode & { type?: string })[]
): string {
  let sig = ''
  for (const n of effectiveStackOrder(nodes)) {
    if (n.type !== 'terminal') continue
    sig = sig === '' ? n.id : sig + ORDER_SEP + n.id
  }
  return sig
}

export function idsFromOrderSig(sig: string): string[] {
  return sig === '' ? [] : sig.split(ORDER_SEP)
}

/** Publish the terminal paint order. Change-gated on the joined signature: the registered grids
 *  re-read their z from the notification, and re-pushing an unchanged order would walk every
 *  terminal on the canvas for nothing. */
export function setNodeZOrder(ids: readonly string[]): void {
  const sig = ids.join(ORDER_SEP)
  if (sig === zOrderSig) return
  zOrderSig = sig
  const next = new Map<string, number>()
  ids.forEach((id, i) => next.set(id, i))
  zOrder = next
  for (const fn of zListeners) fn()
}

/** The z a grid should carry. An id we have not been told about yet lands on TOP: a node created
 *  between two order pushes is appended last on the canvas, so "topmost" matches what the user
 *  sees, while 0 would flash it underneath every other terminal for a frame. */
export function nodeZFor(id: string): number {
  const z = zOrder.get(id)
  return z === undefined ? zOrder.size : z
}

/** Grid owners subscribe here and re-read `nodeZFor` — the engine change-gates `setZ`, so a
 *  no-op reorder costs one comparison per grid. */
export function subscribeNodeZOrder(fn: () => void): () => void {
  zListeners.add(fn)
  return () => {
    zListeners.delete(fn)
  }
}

// ---------------------------------------------------------------------------------------------
// The opaque set — "glyph in the open, DOM when stacked"
// ---------------------------------------------------------------------------------------------

/**
 * THE STACKING RULE OF THE SHARED RENDERER, and the thing to read before touching any of this.
 *
 * A shared-mode terminal is a TRANSPARENT WINDOW: its body has no background, its text lives on
 * the one canvas that sits UNDER the whole node layer, and the only thing it puts between itself
 * and whatever is behind it is its grid's opaque plate — which is also on that canvas, i.e. also
 * under every node's DOM chrome. So a glyph terminal cannot occlude a node beneath it the way an
 * ordinary node does. It can hide the node's canvas TEXT (plate over plate) but never its chrome:
 * the border, the header seam, a label pill all paint straight through.
 *
 * There is no z-ordering that fixes that, in either world — one canvas cannot interleave itself
 * with per-node DOM stacking. Round 4 tried to make the two orders agree by taking selection
 * elevation away; that removed "click/drag brings it to the front", which is not negotiable.
 *
 * Round 5's rule instead: **a terminal renders through the shared canvas only while it is in the
 * open.** The moment its body could reveal something underneath, it drops the grid and goes back
 * to xterm's own DOM renderer — opaque body, native stacking, total occlusion. Concretely a
 * terminal is OPAQUE (DOM) when either holds:
 *
 *  a) its rect intersects the rect of ANY node — of any kind — that is BELOW it in the effective
 *     paint order (`effectiveStackOrder`), or
 *  b) it is in a GESTURE: it, or a group frame containing it, is being dragged or resized. A
 *     gesture is "about to be above things", and holding the node opaque for its whole duration is
 *     also what lets the rect sweep be frozen while `nodes` churns per frame. This set carries the
 *     answer (`gestureTerminalIds`, which is the only thing that can see the children of a dragged
 *     FRAME); TerminalNode additionally reads its own `dragging` prop, which flips synchronously
 *     and needs nobody — two sources for one state, deliberately, and documented at both.
 *
 * A terminal that is only UNDERNEATH others stays on the canvas: the opaque node above it hides it
 * natively, which is the case this whole design leans on. The cost is that a stacked terminal is
 * rendered by the DOM renderer for as long as it is stacked — its text is very slightly softer at
 * zoom ≠ 1 than its neighbours', which is the expected tell, not a defect.
 *
 * Two deliberate exclusions from "below it":
 *  - **A node's own ANCESTOR chain.** Every grouped terminal sits inside its group frame's rect by
 *    construction; counting that as an overlap would put every grouped terminal on the DOM
 *    renderer forever, which would gut the feature on the canvases most likely to use it.
 *  - **Nodes with unknowable geometry** (no `measured`, no `width`/`height` — the tick before
 *    React Flow has measured a fresh node). They contribute nothing in either direction, and the
 *    measurement lands as an ordinary nodes change that recomputes the set.
 *
 * TWO KNOWN GAPS, stated rather than papered over — a device tester must not file either as a bug:
 *  - The EPHEMERAL subagent/loop cards are merged into React Flow at the `<ReactFlow>` prop and are
 *    not in Canvas's `nodes` array, so they are invisible to this rule. A card can therefore sit
 *    over a glyph terminal and be visible through its body. They are display-only, they live for
 *    the length of one turn, and putting them in the rule means putting them in the nodes array,
 *    which is precisely what keeps them out of persistence and undo.
 *  - The rule compares NODE RECTS, and two node-attached surfaces deliberately escape their node's
 *    rect: the 💬 comments flyout (`.term-node__comments`) and the kanban `ColumnPill`, both
 *    siblings of the overflow:hidden node root. A NEIGHBOUR's flyout or pill overhanging a glyph
 *    terminal is not seen here, so it can show through that terminal's body. Fixing it means
 *    feeding real chrome geometry into the rule — a Phase-2 question, and the same one L15's other
 *    Phase-2 answer (chrome on the canvas) settles for free.
 */

/** Node shape this derivation reads. Loose on purpose: it must accept a live measured node and a
 *  freshly deserialized one (`width`/`height`, no `measured`) alike. */
export interface StackedNode extends StackOrderNode {
  type?: string
  position: { x: number; y: number }
  width?: number | null
  height?: number | null
  measured?: { width?: number | null; height?: number | null }
  /** React Flow's own gesture flags: `dragging` during a node drag, `resizing` while a
   *  `NodeResizer` handle is held. */
  dragging?: boolean
  resizing?: boolean
  data?: { collapsed?: unknown; mdMode?: unknown }
}

interface StackRect {
  x: number
  y: number
  w: number
  h: number
}

/** A `parentId` chain longer than this is a data bug (or a cycle) — stop walking. Same constant,
 *  same reason, as `lib/nodeFocus`. */
const MAX_PARENT_DEPTH = 20

const positiveSize = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null

/** The node's rect in ABSOLUTE canvas coordinates (a grouped node's `position` is relative to its
 *  frame, so the parent chain is walked), or null when its size is not knowable yet. */
function absoluteRect(node: StackedNode, byId: Map<string, StackedNode>): StackRect | null {
  const w = positiveSize(node.measured?.width) ?? positiveSize(node.width)
  const h = positiveSize(node.measured?.height) ?? positiveSize(node.height)
  if (w === null || h === null) return null
  let { x, y } = node.position
  let parentId = node.parentId
  const seen = new Set<string>([node.id])
  for (let depth = 0; parentId && depth < MAX_PARENT_DEPTH; depth++) {
    if (seen.has(parentId)) break
    seen.add(parentId)
    const parent = byId.get(parentId)
    if (!parent) break
    x += parent.position.x
    y += parent.position.y
    parentId = parent.parentId
  }
  return { x, y, w, h }
}

/** Strictly overlapping AREA. Edge-to-edge nodes (a snapped grid, a tidy row) share a boundary and
 *  nothing else — treating that as an overlap would send half a neat canvas to the DOM renderer. */
function rectsOverlap(a: StackRect, b: StackRect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
}

/** Whether `ancestorId` is on `node`'s parent chain — see the exclusion note above. */
function isAncestorOf(node: StackedNode, ancestorId: string, byId: Map<string, StackedNode>): boolean {
  let parentId = node.parentId
  const seen = new Set<string>([node.id])
  for (let depth = 0; parentId && depth < MAX_PARENT_DEPTH; depth++) {
    if (parentId === ancestorId) return true
    if (seen.has(parentId)) return false
    seen.add(parentId)
    parentId = byId.get(parentId)?.parentId
  }
  return false
}

/**
 * The terminals that must render on their OWN (opaque, DOM) renderer right now, by the rule
 * documented above. Pure — Canvas owns WHEN to run it (see the settle gate there), this owns what
 * the answer is.
 *
 * Collapsed / ⌘M terminals are left out: they hold no grid either way, so naming them here would
 * only churn the pushed signature. They still count as nodes something else can be stacked over —
 * a collapsed terminal is an opaque header strip, and covering one is a real overlap.
 */
export function opaqueNodeIds(nodes: readonly StackedNode[]): string[] {
  const order = effectiveStackOrder(nodes)
  const byId = new Map<string, StackedNode>()
  for (const n of nodes) byId.set(n.id, n)
  const rects = order.map((n) => absoluteRect(n, byId))
  const out: string[] = []
  for (let i = 0; i < order.length; i++) {
    const node = order[i]
    if (node.type !== 'terminal') continue
    if (node.data?.collapsed || node.data?.mdMode) continue
    const rect = rects[i]
    if (!rect) continue
    for (let j = 0; j < i; j++) {
      const below = rects[j]
      if (!below || !rectsOverlap(rect, below)) continue
      if (isAncestorOf(node, order[j].id, byId)) continue
      out.push(node.id)
      break
    }
  }
  return out
}

/**
 * Is a node GESTURE (drag or `NodeResizer` resize) in progress anywhere on the canvas? While one
 * is, the O(n²) rect sweep above is skipped: `nodes` is rebuilt every frame of a gesture, and
 * recomputing there would flip a terminal's neighbours between the two renderers at 60 Hz — each
 * flip is a real xterm renderer swap. The frozen set is topped up with `gestureTerminalIds`.
 */
export function hasActiveGesture(nodes: readonly StackedNode[]): boolean {
  for (const n of nodes) if (n.dragging || n.resizing) return true
  return false
}

/**
 * The terminals that must be opaque BECAUSE OF a gesture: their own node is being dragged/resized,
 * or an ANCESTOR is.
 *
 * The ancestor half is not a nicety. React Flow's `getDragItems` excludes the children of a dragged
 * parent (the frame moves, the children ride along on `positionAbsolute`), so dragging a GROUP
 * never sets `dragging` on the terminals inside it. Without this walk those terminals stayed
 * transparent for the whole gesture while the frame swept them across the canvas — the worst case
 * of the bug this design exists to fix, and the one case the per-node `dragging` prop cannot see.
 *
 * The dragged node itself is included even though TerminalNode also reads its own `dragging` prop:
 * one answer, from one place, for a state two consumers act on.
 */
export function gestureTerminalIds(nodes: readonly StackedNode[]): string[] {
  const byId = new Map<string, StackedNode>()
  for (const n of nodes) byId.set(n.id, n)
  const out: string[] = []
  for (const node of nodes) {
    if (node.type !== 'terminal') continue
    let cur: StackedNode | undefined = node
    const seen = new Set<string>()
    for (let depth = 0; cur && depth <= MAX_PARENT_DEPTH; depth++) {
      if (cur.dragging || cur.resizing) {
        out.push(node.id)
        break
      }
      if (seen.has(cur.id)) break
      seen.add(cur.id)
      cur = cur.parentId ? byId.get(cur.parentId) : undefined
    }
  }
  return out
}

let opaqueIds = new Set<string>()
let opaqueSig = ''
let opaquePending = false
const opaqueListeners = new Set<() => void>()

/**
 * Store the opaque set WITHOUT notifying, returning the signature. Change-gated on a SORTED
 * signature — this is a set, not a sequence, so the same membership arriving in a different order
 * (a node reorder that changes nothing about who overlaps whom) must not wake every terminal.
 *
 * **The split from `flushOpaqueNodeIds` is the ordering fix, and it is the point of this seam.**
 * Canvas computes the set DURING ITS RENDER, because React renders a parent before its children:
 * that is the only moment at which a TerminalNode can read the answer for the same `nodes` array
 * it is itself rendering with. Computing it in an effect cannot work — effects run CHILD FIRST, so
 * on the commit that ends a drag the node's participation effect re-attached a glyph against the
 * PREVIOUS set, and the parent's effect then told it to tear the glyph down again: one frame of a
 * transparent node sitting over the thing it had just been dropped on, plus a wasted attach/detach
 * pair. The same window opened on create-into-overlap and on project-load-with-overlaps.
 *
 * Notifying cannot happen there, though: a listener's `setState` during another component's render
 * is exactly what React refuses. So the write and the notification are separated — the write is
 * safe during render, and `flushOpaqueNodeIds` (an effect) delivers the notification afterwards,
 * for the one case a render-time read cannot cover: a node whose own object did not change and
 * which therefore did not re-render at all (something slid UNDER it).
 */
export function primeOpaqueNodeIds(ids: readonly string[]): string {
  const sig = [...ids].sort().join(ORDER_SEP)
  if (sig === opaqueSig) return sig
  opaqueSig = sig
  opaqueIds = new Set(ids)
  opaquePending = true
  return sig
}

/** Deliver the notification for a primed change. Idempotent — a second call with nothing pending
 *  is free, which is what lets Canvas call it from an effect keyed on the signature. */
export function flushOpaqueNodeIds(): void {
  if (!opaquePending) return
  opaquePending = false
  for (const fn of opaqueListeners) fn()
}

/** Prime + flush in one call. The imperative form, for callers that are NOT inside a render. */
export function setOpaqueNodeIds(ids: readonly string[]): void {
  primeOpaqueNodeIds(ids)
  flushOpaqueNodeIds()
}

/** Must this node paint its own pixels right now? Always false while nothing has been pushed,
 *  which is every default-mode session. Read at RENDER time by TerminalNode (see above) — never
 *  mirrored into state, which is what would make it stale. */
export function nodeIsOpaque(id: string): boolean {
  return opaqueIds.has(id)
}

/** Terminals subscribe here and re-read `nodeIsOpaque` — same lifecycle as the z subscription. */
export function subscribeOpaqueSet(fn: () => void): () => void {
  opaqueListeners.add(fn)
  return () => {
    opaqueListeners.delete(fn)
  }
}

// ---------------------------------------------------------------------------------------------
// The engine singleton
// ---------------------------------------------------------------------------------------------

export interface SharedGlyphContext {
  engine: GlyphGridEngine
  atlas: GlyphAtlas
}

interface LiveContext extends SharedGlyphContext {
  canvas: HTMLCanvasElement
  gl: GlyphGL
  /** The atlas PAGE, held for its health surface alone (`sourceIntact` on the revive path). The
   *  atlas itself never exposes it — see `ATLAS_SENTINEL_RGBA` for why the page has to be asked. */
  raster: AtlasPageHealth
  /** The page's own contextlost/contextrestored subscription, and the policy behind it. Both die
   *  with the context: a listener on a page we have thrown away would rebuild a context that no
   *  longer exists, and the policy's watchdog would fail a session that has already recovered. */
  sourceLoss: { dispose(): void }
  atlasLoss: ContextLossPolicy
  /** The console reset gauge's subscription, held so teardown can drop it: the atlas dies with the
   *  context, but a subscription left on a rebuilt-and-then-disposed one would keep a closure alive
   *  per font change. */
  resetLog: GlyphAtlasSubscription
  /** Font settings this context was rasterized for — a change tears it down. */
  fontKey: string
  /** The display pixel ratio the atlas was rasterized at — a change tears it down too, through the
   *  SAME funnel, because the atlas cell is device-sized and latched at construction. */
  dpr: number
  /** Set by `disposeContext`, read by the rAF driver, which holds this object across a frame.
   *  Teardown is SYNCHRONOUS (a settings change, the mode being switched off) and can land
   *  between a scheduled tick and its callback — a frame submitted after `gl.dispose()` would
   *  throw against deleted GPU objects, and the driver's catch would read that as a GPU failure
   *  and burn the whole session. A font-size change must not be able to disable the renderer. */
  disposed: boolean
}

let live: LiveContext | null = null
/** The context as it stands RIGHT NOW, typed honestly.
 *
 *  Exists to defeat TypeScript's narrowing, which is not a style point here: `live` is a module
 *  `let` that several functions null out (`disposeContext`, and therefore every rebuild funnel),
 *  and control-flow narrowing from an `if (live)` survives any call made inside the branch. Reading
 *  it back through a function call is the one spelling the compiler cannot narrow, so a caller that
 *  re-reads after doing something that MIGHT have disposed gets `LiveContext | null` and is forced
 *  to handle the null the runtime can genuinely produce. */
function currentLive(): LiveContext | null {
  return live
}
/** One creation attempt per context lifetime (reset by `disposeContext`). Without it every
 *  terminal mount would re-probe a machine that has already said "no WebGL2", and each probe is a
 *  real `getContext` call. */
let creationAttempted = false
let settingsUnsub: (() => void) | null = null
/** The camera survives teardown so a rebuilt context opens where the user is looking, and so
 *  Canvas can feed the camera before the layer has ever mounted (the project-load seed runs
 *  first). Recording it is three number writes — cheaper than the null check it replaces. */
let lastCamera: Camera = { x: 0, y: 0, zoom: 1 }

function fontKeyOf(
  fontFamily: string,
  fontSize: number,
  fontWeight: number,
  fontWeightBold: number
): string {
  // The WEIGHTS are part of the key because the atlas bakes them into every slot: changing one
  // must rebuild the context, exactly as changing the family or the size does. Left out, the
  // picker would move and the canvas would keep drawing the old weight until something else
  // happened to rebuild it.
  return `${fontFamily}|${fontSize}|${fontWeight}|${fontWeightBold}`
}

/** The display's pixel ratio, guarded for the environments that have no `window` (the test suite)
 *  or report nothing useful. */
function currentDpr(): number {
  return typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1
}

/** Sanity-check the cell a caller supplies before it becomes the atlas's fixed geometry. Null =
 *  "do not build a context from this" — the caller stays on the DOM renderer, which is always a
 *  correct outcome. */
function usableCell(cell: DeviceCell | undefined): DeviceCell | null {
  if (!cell) return null
  const { cellW, cellH } = cell
  if (!Number.isFinite(cellW) || !Number.isFinite(cellH)) return null
  if (cellW <= 0 || cellH <= 0) return null
  return { cellW: Math.min(cellW, MAX_CELL_PX), cellH: Math.min(cellH, MAX_CELL_PX) }
}

/**
 * TEMPORARY device-debug instrumentation for the blank-single-glyph bug (round 5's `ç`, round 7's
 * lowercase `x`: one letter renders blank while its neighbours are fine, reproducibly, for the
 * whole session). It is OFF unless `localStorage['nodeterm.glyphgridDebug'] === '1'`.
 *
 * Why instrumentation instead of a fix: every path that can blank ONE slot was audited headlessly
 * and is clean (see `GlyphSlotAllocation`). Reproducing needs a real font on a real device, so
 * rather than guess at a fifth candidate, one device round is spent turning the report into a
 * measurement. Remove this once the bug is closed.
 *
 * The dump is the load-bearing half. It answers the one question that halves the search space:
 * **is the letter missing from the ATLAS, or present in the atlas but blank on screen?**
 *  - missing in the atlas  → the rasterizer (font/baseline/clip) is the suspect;
 *  - present in the atlas  → the slot→uv mapping or the texture upload is.
 * Everything else is downstream of that answer, which is why the tester is asked for the PNG and
 * not for a longer log.
 */
function glyphDebugOn(): boolean {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem('nodeterm.glyphgridDebug') === '1'
  } catch {
    // Storage can throw outright (Safari private mode, a locked-down embedder). Debug off is
    // always a safe answer.
    return false
  }
}

function glyphDebugTap(): ((info: GlyphSlotAllocation) => void) | undefined {
  if (!glyphDebugOn()) return undefined
  return ({ slot, code, bold, italic, x, y, fg, bg, part }): void => {
    console.warn(
      `[glyphgrid] slot ${slot} code 0x${code.toString(16)} ${JSON.stringify(
        String.fromCodePoint(code)
      )}${bold ? ' bold' : ''}${italic ? ' italic' : ''}${
        // Only a WIDE part is called out. Every ordinary glyph is 'whole', so printing that on
        // every line would be noise on the one log a device round reads line by line — and a wide
        // character showing no PAIR here is exactly the failure worth spotting.
        part === 'whole' ? '' : ` ${part}`
      } at ${x},${y} fg=${fg.toString(16)} bg=${bg.toString(16)}`
    )
  }
}

/** Names the author of a cell that HOLDS a character and still packs to "draw nothing".
 *
 *  The three answers are not a list of suspects, they are the three code paths that can produce a
 *  blank lane, so the first report ends the guessing:
 *   - `width 0`   → the buffer says this column is a wide glyph's FOLLOWER. Then the bug is upstream
 *                   of us (or in the lead's width handling), not in the atlas.
 *   - `width -1`  → the buffer had no cell for the column at all, i.e. we packed past the end of a
 *                   line we thought was longer.
 *   - `width >=1` → the cell exists and holds text, and the crash guard still refused the derived
 *                   code: read the reported `code` against `isRenderableCode`.
 *
 *  Throttled per (row, col) so a stuck cell on a repainting row cannot flood the console — the
 *  interesting fact is WHICH cell and WHY, and it does not get truer the hundredth time. */
function installBlankCellProbe(): void {
  if (!glyphDebugOn()) return
  const seen = new Set<string>()
  setBlankCellProbe(({ col, row, width, code, chars }) => {
    const key = `${row}:${col}`
    if (seen.has(key)) return
    seen.add(key)
    console.warn(
      `[glyphgrid] BLANK CELL row ${row} col ${col} holds ${JSON.stringify(chars)} ` +
        `(code 0x${code.toString(16)}, width ${width}) but drew nothing`
    )
  })
}

/** Exposes `window.__glyphgridDump()` → `{ page, ...geometry }`, where `page` is a PNG data URL of
 *  the whole atlas. Installed only under the debug flag; the tester opens the data URL in a tab and
 *  looks for the reported letter.
 *
 *  READING THE PNG SINCE THE ATLAS WENT COLOURED. It is no longer white ink on a black page: each
 *  slot holds the glyph in its real foreground over its real background, so a dark-theme page is
 *  mostly dark-on-dark and the whole page ground OUTSIDE the allocated slots is TRANSPARENT (it
 *  renders as the viewer's own backdrop — white in a browser tab, not black). "The letter's cell is
 *  black" is therefore no longer the test for "missing": the test is whether the cell holds an
 *  inkless expanse of its own BACKGROUND colour. The same letter can also legitimately appear MANY
 *  times, once per colour pair it has been drawn in.
 *
 *  `gutterPx` and `resetCount` ride along for that reading: a slot's ink starts one gutter inside
 *  its pitch cell (so `strideX`-based arithmetic alone lands a couple of texels off), and a page
 *  that has reset is a page whose slot numbering has been reused — a dumped slot index only means
 *  something alongside the reset count it was taken at. */
function installGlyphDump(atlas: GlyphAtlas, raster: { cellW: number; cellH: number }): void {
  if (!glyphDebugOn() || typeof window === 'undefined') return
  ;(window as unknown as Record<string, unknown>).__glyphgridDump = async (): Promise<unknown> => {
    const source = atlas.source
    const geometry = {
      pageSizePx: atlas.sizePx,
      cellW: raster.cellW,
      cellH: raster.cellH,
      strideX: atlas.strideX,
      strideY: atlas.strideY,
      gutterPx: GUTTER_PX,
      cols: Math.floor(atlas.sizePx / atlas.strideX),
      capacity: atlas.capacity,
      resetCount: atlas.resetCount
    }
    // `source` is the rasterizer's OffscreenCanvas; convertToBlob is the only way to read it back.
    if (!source || typeof (source as OffscreenCanvas).convertToBlob !== 'function')
      return { ...geometry, page: null }
    const blob = await (source as OffscreenCanvas).convertToBlob({ type: 'image/png' })
    const page = await new Promise<string>((resolve) => {
      const fr = new FileReader()
      fr.onload = (): void => resolve(String(fr.result))
      fr.readAsDataURL(blob)
    })
    return { ...geometry, page }
  }
}

/** The atlas surface the reset log reads. Structural rather than `GlyphAtlas` so the log can be
 *  exercised without a page full of real glyphs — filling a real one takes a rasterizer, which this
 *  environment does not have. */
export interface AtlasResetSource {
  resetCount: number
  onReset(cb: () => void): GlyphAtlasSubscription
}

/** Quiet period after a logged reset. */
const RESET_LOG_INTERVAL_MS = 1000

/**
 * Announce atlas page resets on the console.
 *
 * NOT gated on the debug flag, unlike the dump and the allocation tap. A reset is the v1
 * reset-on-full model's pressure gauge: it is supposed to be RARE, and the number that decides
 * whether Phase 2 has to build real LRU eviction is how often it actually happens in a day's use —
 * which nobody will have collected if seeing it required knowing to turn a flag on first. It costs a
 * console line per reset on a canvas where resets are rare, which is the case this design claims.
 *
 * THROTTLED, because the case where the claim is wrong is exactly the case that would drown in it: a
 * page too small for the canvas resets on every repack, i.e. once per frame, and an unthrottled warn
 * there is both a real frame cost and a console the tester cannot read the rest of. So at most one
 * line per `RESET_LOG_INTERVAL_MS`, carrying the count of the ones it swallowed — a burst still
 * reports as a burst, in one line instead of sixty.
 *
 * `now` is injected for the tests; production passes nothing.
 */
export function installAtlasResetLog(
  atlas: AtlasResetSource,
  now: () => number = Date.now
): GlyphAtlasSubscription {
  // -Infinity, not 0: the FIRST reset must always print, whatever the clock reads.
  let lastAt = -Infinity
  let swallowed = 0
  return atlas.onReset(() => {
    const t = now()
    if (t - lastAt < RESET_LOG_INTERVAL_MS) {
      swallowed++
      return
    }
    lastAt = t
    const extra = swallowed > 0 ? ` (+${swallowed} more since the last line)` : ''
    swallowed = 0
    console.warn(
      `[glyphgrid] atlas page reset #${atlas.resetCount} — colour key space full, every row repacks${extra}`
    )
  })
}

function createContext(cell: DeviceCell): LiveContext | null {
  if (typeof document === 'undefined' || typeof OffscreenCanvas === 'undefined') return null
  const { fontFamily, fontSize, fontWeight, fontWeightBold } = useSettings.getState().settings
  const dpr = currentDpr()
  // The atlas is rasterized at DEVICE resolution: the addon reports device-pixel cells, and a
  // CSS-sized atlas would be visibly soft on every retina display. The dpr is read ONCE and LATCHED
  // (below, on the context) precisely because it cannot be changed afterwards — the cell, the
  // baseline and every slot already in the page were rasterized for it. Moving the window to a
  // display with a different ratio therefore disposes this context and rebuilds it, exactly as a
  // font change does; `syncAtlasPixelRatio` is the trigger and `rebuildSharedContext` is the shared
  // funnel. The drawing BUFFER follows the dpr independently, on every resize (see the component's
  // `pushViewport`), so geometry is never wrong even in the frames before the rebuild lands.
  const devicePx = Math.max(1, fontSize * dpr)
  const { cellW, cellH } = cell
  // Rasterizer FIRST: it needs no GPU, so a missing OffscreenCanvas bails out before a WebGL
  // context has been created (the harness learned this the expensive way — a context acquired
  // and then dropped unreferenced is exactly the leak this whole layer exists to avoid).
  const raster = createCanvasRasterizer(
    {
      family: fontFamily,
      sizePx: devicePx,
      cellW,
      cellH,
      weight: fontWeight,
      weightBold: fontWeightBold
    },
    ATLAS_PAGE_PX
  )
  if (!raster) return null
  const canvas = document.createElement('canvas')
  canvas.className = 'glyphgrid-canvas'
  // The GL layer sizes the BACKING STORE (canvas.width/height in device px); the CSS box is ours.
  canvas.style.cssText =
    'position:absolute;inset:0;width:100%;height:100%;display:block;pointer-events:none'
  const gl = createWebgl2GL(canvas)
  if (!gl) return null
  const atlas = new GlyphAtlas(raster, ATLAS_PAGE_PX, glyphDebugTap())
  installGlyphDump(atlas, raster)
  installBlankCellProbe()
  const engine = new GlyphGridEngine(gl, atlas)
  engine.setCamera(lastCamera)
  /**
   * The ATLAS PAGE's own loss policy — the 2D half of a GPU reset, which until now had none.
   *
   * It is the SAME policy object the WebGL side uses, and the four rules transfer intact: restore
   * once, give up on a second loss inside the cooldown, give up if the rebuild throws, give up on a
   * bounded watchdog rather than waiting forever. Two details differ and both are spelled here
   * rather than in the policy, because they are properties of the 2D context and not of the rule:
   *
   *  - `onLost()`'s BOOLEAN IS MEANINGLESS HERE and is deliberately dropped. It means "call
   *    preventDefault()", which on a WebGL canvas is how you ASK for a restore and on a 2D canvas is
   *    how you REFUSE automatic restoration — the exact opposite. `onSourceLoss` never cancels.
   *  - REVIVE IS A REBUILD, not a restore. A lost 2D page cannot be restored: its pixels are gone
   *    while `GlyphAtlas.slots` still claims every key is present, so the only correct answer is to
   *    throw the whole context away and let every terminal re-rasterize what it needs against a
   *    fresh page. That is precisely `rebuildSharedContext`, the funnel a font change already uses,
   *    and it begins a new cell epoch for the same reason a font change does.
   *
   * SUSPEND IS A NO-OP, and that is the useful behaviour rather than a gap: the GL texture still
   * holds the LAST GOOD upload of the page, so leaving the canvas exactly as it is shows the user
   * their text — frozen — for the fraction of a second until the restore lands. Parking frames would
   * show the same thing; re-uploading, which is what the un-fixed code did, shows nothing at all.
   */
  const atlasLoss = createContextLossPolicy({
    now: () => Date.now(),
    suspend: () => undefined,
    revive: () => rebuildSharedContext(),
    fail: (reason, err) => failSharedGlyph(reason, err),
    setTimer: (cb, ms) => window.setTimeout(cb, ms),
    clearTimer: (h) => window.clearTimeout(h)
  })
  return {
    engine,
    atlas,
    canvas,
    gl,
    raster,
    atlasLoss,
    sourceLoss: raster.onSourceLoss({
      lost: () => {
        atlasLoss.onLost()
      },
      restored: () => atlasLoss.onRestored()
    }),
    resetLog: installAtlasResetLog(atlas),
    fontKey: fontKeyOf(fontFamily, fontSize, fontWeight, fontWeightBold),
    dpr,
    disposed: false
  }
}

/** Tear the context down and free the GPU objects. Every registered grid is left holding an
 *  INERT handle (`disposeAll`'s contract), so a terminal that writes one more row during
 *  teardown is a no-op rather than a throw. */
function disposeContext(): void {
  const ctx = live
  live = null
  creationAttempted = false
  if (!ctx) return
  // BEFORE any GL call: a rAF tick already scheduled with this context must skip its frame rather
  // than submit against deleted objects (see `LiveContext.disposed`).
  ctx.disposed = true
  try {
    // FIRST, and before anything that can throw: the atlas page's listeners and the watchdog behind
    // them are the two things here that could outlive the context. A surviving listener would drive
    // a rebuild off a page nobody is drawing from, and a surviving watchdog would fail a session
    // whose context was merely handed back (this rebuild, the mode switched off) — which cannot then
    // be re-enabled without a relaunch.
    ctx.sourceLoss.dispose()
    ctx.atlasLoss.stop()
    ctx.resetLog.dispose()
    ctx.engine.disposeAll()
    ctx.gl.dispose()
    // `gl.dispose()` frees the buffers/texture/program but NOT the context itself, and the
    // browser's live-context cap counts contexts, not objects. A rebuild creates a fresh canvas
    // (a canvas hands back the same context forever), so the old one must be explicitly lost or
    // every font change permanently spends one of the ~16 slots the whole app shares.
    const raw = ctx.canvas.getContext('webgl2')
    raw?.getExtension('WEBGL_lose_context')?.loseContext()
  } catch (err) {
    console.warn('[glyphgrid] teardown error (continuing)', err)
  }
  ctx.canvas.remove()
}

/** Warn, drop the context, and put the session on the DOM renderer. The ONE failure funnel — the
 *  store's `markFailed()` delegates here, and this writes the flag DIRECTLY (calling back into the
 *  action would recurse). */
export function failSharedGlyph(reason: string, err?: unknown): void {
  // Checked before the warn so a lost context that arrives twice (throwing frame + event) logs
  // once, and so a second failure never re-notifies the registrants.
  const store = useSharedGlyph.getState()
  if (store.failed) return
  console.warn(`[glyphgrid] shared renderer disabled for this session (${reason})`, err)
  disposeContext()
  // The generation rides along so a node that only subscribes to `generation` still wakes up —
  // it will ask for the context, get null, and stay on the DOM renderer. One signal, one
  // subscription.
  useSharedGlyph.setState({ failed: true, generation: useSharedGlyph.getState().generation + 1 })
}

/**
 * THE re-rasterize path: drop the context and tell every registered terminal to re-evaluate its
 * participation, which is how they end up re-registering their grids against a freshly built atlas.
 *
 * ONE function, because there is now more than one trigger — a font change, a display pixel ratio
 * change, an atlas page whose 2D context was lost, and a cell drift — and they must be the same
 * event. The order is load-bearing and is the same contract `setEnabled(false)` and
 * `failSharedGlyph` honour: dispose FIRST, announce SECOND, never dispose without announcing (every
 * registered grid is holding an inert handle until the bump arrives) and never announce before
 * disposing (a terminal that re-asked for the context in between would adopt the very context we
 * are about to delete).
 *
 * `cellEpoch` is the ONE thing the triggers do not agree on, which is why it is a parameter rather
 * than something this function could decide for itself. Everything that rebuilds because the world
 * changed (a new font, a new display, a fresh atlas page) makes the previous cell measurement
 * meaningless and starts a new epoch — the DEFAULT, so a future trigger gets the safe answer by
 * omission. The drift rebuild alone passes 'same': it is spending that epoch's single allowance, and
 * re-arming the guard from inside the rebuild the guard permitted is exactly the ping-pong loop
 * `CellRebuildGuard` exists to prevent.
 */
type CellEpoch = 'new' | 'same'

function rebuildSharedContext(cellEpoch: CellEpoch = 'new'): void {
  if (cellEpoch === 'new') cellGuard.beginEpoch()
  disposeContext()
  useSharedGlyph.getState().bumpGeneration()
}

/** Rebuild on a terminal font change: the atlas is rasterized for one font, so a new one means a
 *  new atlas — and the engine's grids are re-registered by their owners on the generation bump.
 *
 *  Never unsubscribed, deliberately: the context it watches is a module singleton with no owner
 *  to outlive, and a subscription dropped at teardown would miss the font change that happens
 *  while the mode is momentarily off. It is one closure for the life of the renderer process. */
function ensureSettingsSubscription(): void {
  if (settingsUnsub) return
  settingsUnsub = useSettings.subscribe((s) => {
    if (!live) return
    if (
      live.fontKey ===
      fontKeyOf(
        s.settings.fontFamily,
        s.settings.fontSize,
        s.settings.fontWeight,
        s.settings.fontWeightBold
      )
    )
      return
    // A new font is a new cell epoch, and `rebuildSharedContext` begins one by default — the reset
    // no longer lives here, so every other epoch-establishing trigger gets it too.
    rebuildSharedContext()
  })
}

/** Below this, a difference between two pixel ratios is float noise. Real values are far apart
 *  (1, 1.25, 1.5, 2, 3) and nothing legitimately moves one by a thousandth, while a rebuild costs a
 *  dropped and re-registered grid on every terminal on the canvas. */
const DPR_EPS = 0.001

/**
 * Has the display's pixel ratio moved away from the one the atlas was rasterized at?
 *
 * `current` is `window.devicePixelRatio`, which is not a trustworthy number in every environment
 * (0 on a detached window, NaN through a hostile shim). An unreadable ratio answers "unchanged":
 * the atlas we hold is the one the display we are on asked for, and throwing it away on a bad
 * reading is strictly worse than keeping it.
 */
export function pixelRatioChanged(builtAt: number, current: number): boolean {
  if (!Number.isFinite(current) || current <= 0) return false
  return Math.abs(builtAt - current) > DPR_EPS
}

/** The context surface the dpr reconciliation reads. Structural rather than `LiveContext` — the
 *  same trick `AtlasResetSource` uses — so the rebuild decision is exercisable without a GPU. */
export interface PixelRatioContext {
  /** The ratio the atlas was rasterized at. */
  dpr: number
  /** Already torn down. */
  disposed: boolean
}

/**
 * Rebuild the atlas when the window has moved to a display with a different pixel ratio.
 *
 * WHY A REBUILD, AND WHY NOTHING ELSE FIXES IT. The atlas cell IS xterm's DEVICE cell (see
 * `DeviceCell`) and the baseline is derived from the same font at the same moment — both latched at
 * construction, along with every slot already rasterized into the page. So a retina window dragged
 * onto a 1x display keeps a page drawn at twice the resolution its quads are now sampled at, and
 * the reverse leaves it soft. Nothing downstream rescues that: the grids are registered with the
 * CSS cell, which is dpr-invariant, so the move triggers no re-registration at all and the page
 * stays wrong for the life of the context.
 *
 * It goes through the font change's funnel deliberately (`rebuildSharedContext`): a dpr change is
 * the same event with a different trigger, and a second dispose-and-re-register path is a second
 * place to get the both-renderers invariant wrong.
 *
 * Returns whether it rebuilt, so the caller can skip pushing a viewport into a context it has just
 * disposed.
 */
export function syncAtlasPixelRatio(current: number, ctx: PixelRatioContext): boolean {
  // Re-entry guard. `pushViewport` runs from the ResizeObserver, the window `resize` listener AND
  // the resolution media query, and a display change can fire more than one of them;
  // `disposeContext()` flips this flag on the context the closure still holds, so the second call
  // is a no-op instead of a second epoch bump — which would run teardown/setup twice on every
  // terminal for one display change.
  if (ctx.disposed) return false
  if (!pixelRatioChanged(ctx.dpr, current)) return false
  rebuildSharedContext()
  return true
}

/** The query xterm's own `CoreBrowserService` watches for a device-pixel-ratio change, verbatim.
 *  Exported so the test can assert the form rather than only the behaviour: the ratio is embedded
 *  in the STRING, which is the whole reason the watcher below has to re-arm. */
export function pixelRatioQuery(dpr: number): string {
  return `screen and (resolution: ${dpr}dppx)`
}

/** The two methods of a `MediaQueryList` the watcher uses, both optional: an environment can expose
 *  only the deprecated `addListener` pair, and that degrades to "not watched" rather than a throw. */
export interface PixelRatioMediaQuery {
  addEventListener?(type: 'change', fn: () => void): void
  removeEventListener?(type: 'change', fn: () => void): void
}

/** The browser surface the dpr watcher needs, injected — the component itself has no DOM under the
 *  unit tests, and the re-arm is precisely what needs testing. */
export interface PixelRatioWatchHost {
  /** Read AFRESH at every arm: the query embeds the ratio, so it must be the ratio we are on now. */
  dpr(): number
  /** `window.matchMedia`, or null where the environment has none. */
  match(query: string): PixelRatioMediaQuery | null
}

/**
 * Watch for a device-pixel-ratio change and call back once per change.
 *
 * WHY THIS EXISTS ALONGSIDE `resize`. The move it answers — a window dragged between a retina and a
 * 1x display at the same point size — leaves the host's CSS box identical, so the ResizeObserver is
 * silent, and whether Blink dispatches `resize` for a scale-factor change with an unchanged CSS
 * viewport is not something to bet the atlas on. xterm does not bet on it: `CoreBrowserService`
 * watches exactly this media query. Both triggers run, funnelled through the same `pushViewport`,
 * and `syncAtlasPixelRatio`'s re-entry guard makes the double fire free.
 *
 * THE RE-ARM IS THE WHOLE JOB. `screen and (resolution: 2dppx)` answers the move OFF 2dppx and then
 * never again, so each change disarms the spent query and arms one at the ratio we have just landed
 * on — otherwise the move BACK is silent and the canvas keeps an atlas rasterized for a display it
 * is no longer on. Re-arming happens BEFORE the callback: `onChange` may dispose the context, and
 * the next display change must be watched for either way.
 *
 * No `addListener` fallback: nothing else in this repo carries one, and a query list we cannot
 * subscribe to leaves the `resize` trigger in place.
 */
export function createPixelRatioWatcher(
  host: PixelRatioWatchHost,
  onChange: () => void
): { stop(): void } {
  let mql: PixelRatioMediaQuery | null = null
  let stopped = false

  const disarm = (): void => {
    mql?.removeEventListener?.('change', handler)
    mql = null
  }

  const arm = (): void => {
    disarm()
    if (stopped) return
    const next = host.match(pixelRatioQuery(host.dpr()))
    if (!next || typeof next.addEventListener !== 'function') return
    next.addEventListener('change', handler)
    mql = next
  }

  function handler(): void {
    if (stopped) return
    arm()
    onChange()
  }

  arm()
  return {
    stop(): void {
      stopped = true
      disarm()
    }
  }
}

/**
 * Bring the engine's GPU objects back — UNLESS the atlas page did not survive whatever took them.
 * Returns whether the caller may carry on with this context; false means it has been rebuilt and
 * the generation bump is already on its way.
 *
 * THE CASE THIS CATCHES, and why the WebGL side's own policy cannot. A GPU reset takes the WebGL
 * context AND blanks the OffscreenCanvas the atlas rasterizes into. The WebGL half announces itself
 * and is answered by `engine.reviveGpu`, which re-uploads the atlas page — and `reviveGpu`'s comment
 * says outright that this costs one upload rather than a re-rasterization "because the atlas SOURCE
 * did not die with the context". When it did die, that upload is of an EMPTY page: `GlyphAtlas.slots`
 * still holds every key, so nothing re-rasterizes, and every terminal on the canvas goes blank at
 * once and stays blank until a font or dpr change happens to rebuild.
 *
 * The 2D context usually announces itself too (`onSourceLoss`), and when it does this check never
 * fires. It exists for the case where it does NOT — a backing store that comes back wiped with no
 * event — which is why the question is asked of the PIXELS (`ATLAS_SENTINEL_RGBA`) rather than of a
 * flag. One 1px readback, on a path that runs at most once per context.
 */
function reviveGpuOrRebuild(ctx: LiveContext): boolean {
  // ALREADY GONE. Both halves of a GPU reset land as events, in an order nobody controls, and the
  // 2D half answers by DISPOSING this context — while the generation bump that tears the effect
  // down is a React state update, i.e. not synchronous. So `webglcontextrestored` can arrive for a
  // context that no longer exists, and reviving it would call into a disposed GL layer: a throw the
  // policy reads as a failed rebuild, taking the whole session to the DOM renderer for a context
  // that was merely replaced. Same guard, same reason, as `syncAtlasPixelRatio`'s.
  if (ctx.disposed) return false
  if (!ctx.raster.sourceIntact()) {
    console.warn(
      '[glyphgrid] the atlas page did not survive the GPU outage — every cached glyph now points ' +
        'at a blank texel, so the context is being rebuilt rather than re-uploaded'
    )
    rebuildSharedContext()
    return false
  }
  ctx.engine.reviveGpu()
  return true
}

/** Fires when a context has just been BUILT. The component listens so it can mount the fresh
 *  canvas: creation is now driven by the first terminal that offers a device cell, which can
 *  happen after the layer's own effect has already run and found nothing. Deliberately NOT a
 *  generation bump — that notification is a re-evaluate-your-participation signal to every
 *  registered terminal, and raising it from INSIDE the call one of them is making would re-enter
 *  `setupGlyph` before it has registered its grid. */
const contextListeners = new Set<() => void>()

export function subscribeSharedGlyphContext(fn: () => void): () => void {
  contextListeners.add(fn)
  return () => {
    contextListeners.delete(fn)
  }
}

/** One line per context lifetime: every terminal supplies its own device cell and they are all
 *  supposed to agree (the font settings are global). A disagreement is a real defect — a dpr
 *  change under a live context, a per-terminal letterSpacing — and the symptom is soft text, so
 *  say so rather than silently rescaling. */
/**
 * THE LOOP-GUARD INVARIANT for the drift rebuild, in one object because it was previously two
 * module variables reset in one place and read in another.
 *
 * **One drift rebuild per CELL EPOCH, and an epoch begins only where a new cell is legitimately
 * expected.** Both halves are load-bearing and they fail in opposite directions:
 *
 *  - WITHOUT the cap: the rebuild disposes the context, and `disposeContext` deliberately clears
 *    the other creation state — so a guard stored there would be wiped by the very rebuild it
 *    bounds. Two terminals with genuinely different cells would rebuild for each other forever, one
 *    per registration, and the canvas would never paint. This is why `allowRebuild()` does NOT
 *    re-arm itself and why the funnel it calls must be told not to begin an epoch.
 *  - WITHOUT the re-arm: the FIRST drift in a session spends the only allowance there will ever be.
 *    That is the defect this replaces — the counter was reset in the settings subscription alone, so
 *    a later, unrelated drift (a webfont resolving after a dpr rebuild latched a fallback face's
 *    cell) only warned, and that terminal stayed resampled — soft and 5% wide — for the rest of the
 *    session, with the cause long gone.
 *
 * AN EPOCH BEGINS at every rebuild cause that makes the previous measurement meaningless: a font
 * change, a dpr rebuild, the atlas page being rebuilt after a 2D context loss, and the mode being
 * switched back on. It does NOT begin at the drift rebuild itself — see `rebuildSharedContext`'s
 * `cellEpoch` argument, which is where that distinction is spelled.
 *
 * Pure and injectable-free, so the rule is exercisable without a GPU (the singleton around it is
 * not testable at all — see the header).
 */
export interface CellRebuildGuard {
  /** A fresh cell epoch: the old measurement is meaningless and the next drift may rebuild. */
  beginEpoch(): void
  /** Consume this epoch's rebuild allowance. False = already spent; leave the terminal resampled. */
  allowRebuild(): boolean
  /** True at most once per epoch — the give-up log, which must not repeat per registration. */
  takeWarning(): boolean
}

export function createCellRebuildGuard(limit = 1): CellRebuildGuard {
  let rebuilds = 0
  let warned = false
  return {
    beginEpoch(): void {
      rebuilds = 0
      warned = false
    },
    allowRebuild(): boolean {
      if (rebuilds >= limit) return false
      rebuilds++
      return true
    },
    takeWarning(): boolean {
      if (warned) return false
      warned = true
      return true
    }
  }
}

const cellGuard = createCellRebuildGuard()
/**
 * The atlas cell against a terminal's real one — and REBUILD when they disagree, rather than only
 * saying so.
 *
 * `ensureLiveContext` fixes the atlas geometry from the FIRST terminal that registers, for the life
 * of the context. That is fine when every terminal measures the same cell and wrong the moment one
 * does not: the glyph is rasterized into the atlas's box and drawn into the terminal's, so the
 * whole canvas is resampled by the ratio between them.
 *
 * That is the 2026-08-10 report, measured. Every node reported a device cell of 16.79998×36 while
 * the atlas had latched to 16×36 — a horizontal ratio of 1.05, which is exactly the 4.9% wider
 * advance measured off screenshots against xterm's own WebGL renderer, with the line spacing
 * identical to the pixel because the heights agreed. A glyph stretched 5% is wider, heavier AND
 * softer, which is why the report arrived as "not crisp" and survived four other explanations.
 *
 * The likely latch is a first terminal that measured before its webfont resolved, so the fallback
 * face's metrics fixed the page. Nothing recovered from it: a font change rebuilds the context, a
 * dpr change rebuilds it, but a cell that simply disagreed only logged — and a project switch
 * deliberately does NOT rebuild, so the wrong page outlived everything short of a restart.
 *
 * A drift is therefore treated exactly like a font change, through the same funnel. It CANNOT
 * loop: the cell is read raw from xterm (`deviceCellOf`) and came back identical across all 48
 * nodes in the field dump, so one rebuild settles it — and the guard below makes even a
 * pathological disagreement rebuild once per distinct cell rather than every frame.
 */
export function cellsDisagree(atlas: DeviceCell, cell: DeviceCell): boolean {
  return Math.abs(atlas.cellW - cell.cellW) >= 0.01 || Math.abs(atlas.cellH - cell.cellH) >= 0.01
}

function reconcileAtlasCell(ctx: LiveContext, cell: DeviceCell | null): void {
  if (!cell) return
  if (!cellsDisagree({ cellW: ctx.atlas.cellW, cellH: ctx.atlas.cellH }, cell)) return
  if (!cellGuard.allowRebuild()) {
    // Already spent this epoch's rebuild and a terminal STILL disagrees: two of them want
    // different cells, and rebuilding again would just hand the atlas back and forth. Say so and
    // leave it — one resampled terminal is a cosmetic loss, a rebuild loop is a dead canvas.
    if (cellGuard.takeWarning()) {
      console.warn(
        `[glyphgrid] atlas cell ${ctx.atlas.cellW}×${ctx.atlas.cellH} still does not match a ` +
          `terminal's device cell ${cell.cellW}×${cell.cellH} after a rebuild — terminals disagree ` +
          `about their metrics, so this one's glyphs stay resampled`
      )
    }
    return
  }
  console.warn(
    `[glyphgrid] atlas cell ${ctx.atlas.cellW}×${ctx.atlas.cellH} does not match this terminal's ` +
      `device cell ${cell.cellW}×${cell.cellH} — rebuilding the atlas for it (every glyph was ` +
      `being resampled by the ratio between them)`
  )
  // 'same' is the guard: this rebuild must NOT begin a new epoch, or it would restore the allowance
  // it has just consumed and two disagreeing terminals would rebuild for each other forever.
  rebuildSharedContext('same')
}

/**
 * The singleton, created on first use. Internal because it also exposes the canvas + GL, which
 * only this file's component may touch.
 *
 * Creation needs `cell` — xterm's device cell (see `DeviceCell`) — so a caller that has no
 * terminal to ask (the component itself) gets the EXISTING context or null, and never builds one
 * with guessed metrics. The first caller that does have one fixes the atlas geometry for the life
 * of the context; a font change tears it down and the next caller rebuilds it with the new cell.
 */
function ensureLiveContext(cell?: DeviceCell): LiveContext | null {
  if (!sharedGlyphActive()) return null
  if (live) {
    // `reconcileAtlasCell` CAN DISPOSE THE VERY CONTEXT IT IS HANDED — a cell drift rebuilds, and
    // `disposeContext()` nulls `live`. So the answer has to be re-read afterwards, and it is read
    // through `currentLive()` rather than as `live` because TypeScript's narrowing from the `if`
    // above survives the call: written `return live`, the value is correct at RUNTIME (it is a
    // variable read, not a captured reference) while the compiler believes it is non-null, and the
    // first edit that trusts that type — `live.engine`, a spread, an `!` — hands a caller an engine
    // whose GL objects have been deleted. Null is the DESIGNED answer here: the caller drops to
    // `ensureWebglClient` and the generation bump the rebuild raised brings it back on a fresh
    // context.
    reconcileAtlasCell(live, usableCell(cell))
    return currentLive()
  }
  const seed = usableCell(cell)
  if (!seed) return null
  if (creationAttempted) return null
  creationAttempted = true
  ensureSettingsSubscription()
  // Construction is guarded, and deliberately does NOT go through `failSharedGlyph`: a THROW here
  // (an OffscreenCanvas/2d-context/WebGL constructor that raises instead of returning null on a
  // hostile or exhausted GPU stack) must degrade EXACTLY like the null-returning paths inside
  // `createContext` — return null, the caller stays on the DOM renderer. Setting `failed` would
  // additionally bump the generation and re-notify every registrant from inside a call one of
  // them is already making, and it would mark the whole session dead for a condition the
  // null paths treat as "not available here". `creationAttempted` is already true, so the throw
  // is never retried in a loop.
  try {
    live = createContext(seed)
  } catch (err) {
    console.warn('[glyphgrid] shared context construction threw; staying on the DOM renderer', err)
    live = null
  }
  // Announced only on success, and AFTER `live` is set, so a listener that immediately asks for
  // the context finds it.
  if (live) for (const fn of contextListeners) fn()
  return live
}

/**
 * The shared engine + atlas, created on first use. Null means "stay on the DOM renderer": the
 * mode is off, the session has failed, this machine has no WebGL2/OffscreenCanvas — or no context
 * exists yet and the caller passed no `deviceCell` to build one from.
 *
 * `deviceCell` is xterm's `dimensions.device.cell` for the asking terminal. It is what the atlas
 * rasterizes into, and the invariant it exists for is on `DeviceCell`: **the atlas texel grid is
 * xterm's device cell grid, always.**
 */
export function getSharedGlyphContext(deviceCell?: DeviceCell): SharedGlyphContext | null {
  return ensureLiveContext(deviceCell)
}

/** Camera feed. Always records (so a context created later opens at the right place) and only
 *  reaches the engine — which change-gates it — when one exists.
 *
 *  SANITIZED HERE, at the boundary, rather than at any one call site: the camera arrives from a live
 *  React Flow gesture (already clamped) AND from a persisted project viewport (clamped by nothing),
 *  and a zoom of 0 or NaN from the second blanks every terminal on the canvas at once. See
 *  `sanitizeCamera` for why that is invisible everywhere else. One funnel means a future third
 *  caller cannot reintroduce it. */
export function setSharedGlyphCamera(cam: Camera): void {
  lastCamera = sanitizeCamera(cam)
  live?.engine.setCamera(lastCamera)
}

// ---------------------------------------------------------------------------------------------
// The board gate — no frames under an opaque overlay
// ---------------------------------------------------------------------------------------------

/**
 * Is the kanban board currently covering the canvas?
 *
 * Read imperatively from both stores because the answer needs both: the board is a PER-PROJECT
 * view, so switching to a project that is on the board changes it with no view change at all
 * (`TerminalNode` gets away with reading the project id once because a project switch remounts it;
 * this layer stays mounted across switches).
 *
 * The `activeProjectId` check is not redundant with `viewFor`, which falls through to the GLOBAL
 * default view for an id it does not know: with "Default view = kanban" and no active project (at
 * boot, or after the last project is closed and the WelcomeScreen covers a still-mounted Canvas),
 * an empty id would report "covered" and stop the loop with no board up. This is the same
 * predicate Canvas derives `kanbanOpen` from, and it has to stay literally the same one — two
 * answers to "is the board up" that can disagree is how a canvas ends up not drawing for a reason
 * nobody can find.
 */
export function boardCoversCanvas(): boolean {
  const { activeProjectId } = useProjects.getState()
  return !!activeProjectId && viewFor(useViewMode.getState(), activeProjectId) === 'kanban'
}

export interface BoardFrameGate {
  /** The loop that is currently in charge — always call through this, never capture the result. */
  loop(): FrameLoop
  /** Re-read the board flag and act on a change. Cheap and change-gated: a store notification that
   *  did not move the board costs one comparison. */
  sync(): void
  /** Teardown. Stops the current loop for good and makes any later `sync` inert. */
  stop(): void
}

/**
 * Gate the frame loop on the kanban board.
 *
 * The board is a FULLY OPAQUE overlay over the whole canvas, so every frame drawn under it is
 * invisible work. Phase 1c's idle park does not cover this case at all: a canvas of streaming
 * terminals under the board never goes quiet, so it repaints at the display's refresh rate for
 * nobody.
 *
 * **STOPPING THE LOOP DOES NOT STOP THE FEED, and that distinction is the whole safety of this.**
 * Nothing about the terminals changes: their PTYs keep running, the addons keep writing rows into
 * the engine's grid buffers, and `markDirty` keeps recording the damage. The ONLY thing that stops
 * is the submission of frames. So the buffers stay current the entire time the board is up, and
 * closing it is a REPAINT of what is already there — not a rebuild, not a re-registration, and not
 * a screen that has to be re-fed from tmux. Nothing is lost by not drawing it.
 *
 * That is also why one frame is drawn IMMEDIATELY on close rather than waiting for the next damage:
 * the engine is still dirty from everything that arrived under the board, and the next write on an
 * idle canvas may be minutes away — a finished agent's terminal would sit there showing the rows it
 * had when the board went up. `start()` schedules that frame; `wake()` alongside it is belt and
 * braces, and free (it only reschedules a frame that draws nothing when there is nothing to draw).
 *
 * **A stopped loop is stopped FOR GOOD** — `createFrameLoop`'s contract, so that a late damage can
 * never resurrect a loop whose context is gone. Leaving the board therefore builds a FRESH loop
 * rather than restarting the old one, which is why every caller must reach the loop through
 * `loop()`: a damage subscription that captured the original would be waking a corpse for the rest
 * of the session, and a frozen canvas is a far worse failure than a wasted frame.
 */
export function createBoardFrameGate(
  boardOpen: () => boolean,
  makeLoop: () => FrameLoop
): BoardFrameGate {
  let covered = boardOpen()
  let loop = makeLoop()
  let torn = false
  // Mounting WHILE the board is up (a project that opens on the board, a remount behind it) must
  // not start drawing either — the gate's state is read at construction, not assumed to be "open
  // canvas". And a loop that is merely NEVER STARTED is not inert: `wake()` starts one, so the
  // damage subscription would schedule frames under the board through the back door. It has to be
  // STOPPED, which is also what makes the close path build a fresh one from either entry.
  if (covered) loop.stop()
  else loop.start()
  return {
    loop: () => loop,
    sync(): void {
      if (torn) return
      const now = boardOpen()
      if (now === covered) return
      covered = now
      if (now) {
        loop.stop()
        return
      }
      loop = makeLoop()
      loop.start()
      loop.wake()
    },
    stop(): void {
      torn = true
      loop.stop()
    }
  }
}

// ---------------------------------------------------------------------------------------------
// The blink clock — ONE for the whole canvas
// ---------------------------------------------------------------------------------------------

/**
 * xterm's own blink half-period (`CursorBlinkStateManager`'s `BLINK_INTERVAL`): 600 ms shown,
 * 600 ms hidden.
 *
 * Matched deliberately rather than picked. A stacked terminal leaves the shared canvas and paints
 * itself on xterm's DOM renderer (see the opaque set above), so two terminals on ONE canvas can be
 * blinking under two different mechanisms at the same moment — ours and xterm's CSS animation. Any
 * other period would make them visibly drift apart.
 */
export const CURSOR_BLINK_INTERVAL_MS = 600

/**
 * The terminal whose cursor is blinking right now — at most ONE, because at most one terminal has
 * focus, which is also why the clock is a canvas-level singleton rather than a timer per node.
 *
 * THE PRODUCER'S CONTRACT, in three parts, because the clock cannot enforce any of them:
 *  1. **Set on focus, cleared on blur.** The clock's "is anything focused" gate IS this value; a
 *     target left behind by a blurred terminal is a repaint twice a second for a cursor nobody is
 *     on.
 *  2. **`setPhase` must repaint SYNCHRONOUSLY.** The clock brackets the call to route the damage it
 *     produces through `pulse()` instead of `wake()` (see `routeDamage`); a phase applied through a
 *     deferred/debounced redraw would land outside that bracket, take the wake path, and put the
 *     idle canvas back at the display's refresh rate — the exact failure this whole design avoids.
 *  3. **Both halves of the cursor.** A block cursor is a CELL rewrite and every other shape is an
 *     overlay (see `glyphgrid/cursor.ts`), so hiding it for a phase means suppressing whichever of
 *     the two this terminal is currently drawing — not just the overlay.
 * A terminal that stops being the target must leave its own cursor SHOWN; the clock restores the
 * target it still holds, but it cannot reach one that has already been dropped.
 *
 * THE PRODUCER is `GlyphGridRendererAddonCore` — `setCursorBlinkPhase` for (2) and (3), published
 * on its own focus edges for (1) through the `blink` seam the attach shell supplies
 * (`terminal/glyphgrid-attach.ts`). It has to be the addon: it is the only thing that tracks which
 * terminal has focus and the only thing that holds both halves of a cursor.
 */
export interface CursorBlinkTarget {
  /** Show or hide this terminal's cursor for the current phase. */
  setPhase(visible: boolean): void
}

let blinkTarget: CursorBlinkTarget | null = null
const blinkTargetListeners = new Set<() => void>()
const blinkRestartListeners = new Set<() => void>()

/** Publish the focused terminal (or null on blur). Change-gated: the producer is a focus handler
 *  that may fire more than once for one focus change. */
export function setCursorBlinkTarget(target: CursorBlinkTarget | null): void {
  if (blinkTarget === target) return
  blinkTarget = target
  for (const fn of blinkTargetListeners) fn()
}

/**
 * Give the blink up — but ONLY if this target still holds it.
 *
 * THE GUARD LIVES HERE, and nowhere else. The browser does not promise that the blurred terminal's
 * blur reaches us before the newly focused one's focus, so an unconditional
 * `setCursorBlinkTarget(null)` on a late blur (or on the teardown of a terminal another node has
 * already taken focus from) would stop the cursor of the terminal the user just clicked into — the
 * only one that is supposed to be blinking. Its natural home would be the attach shell, which is
 * the file with no unit tests by design; keeping the comparison in this function is what puts it
 * under test.
 */
export function releaseCursorBlinkTarget(target: CursorBlinkTarget): void {
  if (blinkTarget !== target) return
  setCursorBlinkTarget(null)
}

/**
 * The cursor MOVED — hold it solid and start the period over.
 *
 * xterm's own `CursorBlinkStateManager.restartBlinkAnimation` does exactly this, and matching it is
 * the same argument that fixed `CURSOR_BLINK_INTERVAL_MS` at 600 ms: a STACKED terminal has left
 * the shared canvas for xterm's DOM renderer, so two terminals on one canvas blink under two
 * mechanisms at once. Without this the stacked one holds its cursor solid while you type and the
 * shared one keeps flashing — the drift the period match exists to prevent, in the most
 * attention-heavy moment there is.
 *
 * Identity-guarded like `releaseCursorBlinkTarget`, for a second reason on top of that one: a
 * background terminal streaming output moves its cursor constantly, and any of them re-arming the
 * focused terminal's period would keep the blink permanently solid.
 */
export function restartCursorBlink(target: CursorBlinkTarget): void {
  if (blinkTarget !== target) return
  for (const fn of blinkRestartListeners) fn()
}

export function cursorBlinkTarget(): CursorBlinkTarget | null {
  return blinkTarget
}

export function subscribeCursorBlinkTarget(fn: () => void): () => void {
  blinkTargetListeners.add(fn)
  return () => {
    blinkTargetListeners.delete(fn)
  }
}

/** A restart is not a target CHANGE, so it needs its own channel — `sync` deliberately does
 *  nothing while the interval is already running. */
export function subscribeCursorBlinkRestart(fn: () => void): () => void {
  blinkRestartListeners.add(fn)
  return () => {
    blinkRestartListeners.delete(fn)
  }
}

/** Everything the clock touches, injected — so the policy is testable without a timer, a DOM or a
 *  GPU, exactly as `createBoardFrameGate`'s is. */
export interface CursorBlinkClockDeps {
  /** `settings.cursorBlink`. */
  enabled(): boolean
  /** Is the kanban board covering the canvas? */
  covered(): boolean
  /** The focused terminal, or null. */
  target(): CursorBlinkTarget | null
  /** The loop in charge RIGHT NOW — always through the board gate, never captured: leaving the
   *  board builds a fresh loop and a captured one is a corpse for the rest of the session. */
  loop(): Pick<FrameLoop, 'wake' | 'pulse'>
  setInterval(cb: () => void, ms: number): number
  clearInterval(handle: number): void
}

export interface CursorBlinkClock {
  /** Re-read the three gates and act on a change. Change-gated and idempotent, so every store
   *  notification that could move any of them can call it unconditionally. */
  sync(): void
  /** The target's cursor moved: show it and start the period over — xterm's
   *  `restartBlinkAnimation`. Inert when nothing is blinking. */
  restart(): void
  /** Route ONE damage notification from the engine to the loop. The clock owns this because it is
   *  the only thing that knows whether the damage is its own. */
  routeDamage(): void
  /** Teardown. Restores the cursor, kills the timer, and makes any later `sync` inert. */
  stop(): void
}

/**
 * The canvas's single cursor-blink clock.
 *
 * **The trap it exists to avoid.** A blink is a TIMED repaint twice a second, and the repaint
 * dirties the engine like any other write — so the ordinary path (`onDamage` → `wake()`) would
 * resume the rAF chain, which then costs `IDLE_FRAMES_BEFORE_PARK` frames before parking again.
 * Thirty frames every 600 ms is a loop that never parks: Phase 1c's idle park silently undone, on
 * every canvas that has a focused terminal, which is most of them. `pulse()` (frame-driver) draws
 * exactly one frame and stays parked — and `routeDamage` is what makes sure the blink's own damage
 * reaches it instead of `wake()`. **Neither half works alone**: `pulse()` without the routing is
 * dead code, since the damage listener would have already woken the loop.
 *
 * **Gated three ways, and torn down when any of them stops holding**: the blink SETTING, a terminal
 * holding FOCUS, and the board not covering the canvas (its gate has stopped the loop, so a phase
 * flip there repacks a row nobody draws). A canvas with no focused terminal has no clock at all —
 * not a clock that ticks and finds nothing to do.
 *
 * **The cursor is always handed back SHOWN.** Every stopping path restores the phase first: a
 * cursor left hidden is an invisible cursor until something unrelated repacks its row, which is the
 * one way this feature can be worse than not having it. Precisely: the restore is PACKED at the
 * moment the clock stops — on the board path that means it is drawn when the board closes and the
 * loop starts again, since the board gate has stopped the loop; on every other path a frame follows
 * immediately.
 */
export function createCursorBlinkClock(deps: CursorBlinkClockDeps): CursorBlinkClock {
  let handle = 0
  /** The target we are actually blinking — held rather than re-read, because a stopping path has to
   *  restore the cursor of the terminal that HAD the clock, not of whoever has focus now. */
  let current: CursorBlinkTarget | null = null
  /** Is the cursor currently shown? Starts true: nothing has hidden it yet. */
  let visible = true
  /** How many `setPhase` calls are on the stack right now — see `routeDamage`.
   *
   *  A DEPTH, not a boolean. Nothing re-enters `apply` today, but a boolean would clear the bracket
   *  at the end of the INNER call and drop the outer one's remaining damage onto `wake()` — and the
   *  bracket is the single invariant this whole design rests on, so it costs nothing to make it
   *  re-entrant rather than to rely on it never being re-entered. */
  let applying = 0
  let torn = false

  const clearTimer = (): void => {
    if (!handle) return
    deps.clearInterval(handle)
    handle = 0
  }

  const apply = (next: boolean): void => {
    visible = next
    const target = current
    if (!target) return
    // The bracket is the whole mechanism: `setPhase` repacks the cursor row synchronously, that
    // repack calls `markDirty`, and the damage lands back in `routeDamage` while this counter is
    // up. `finally`, because a throwing addon must not leave every subsequent damage on the pulse
    // path — that would starve a streaming terminal down to one frame per write.
    applying++
    try {
      target.setPhase(next)
    } finally {
      applying--
    }
  }

  /** Every path that stops blinking goes through here. */
  const stopClock = (): void => {
    clearTimer()
    if (visible) return
    // GUARDED, because `stop()` is the FIRST statement of the layer effect's cleanup. `setPhase`
    // packs a row into the engine, and the engine rejects a row of the wrong length by throwing —
    // a throw here would skip every unsubscribe after it and leave a dead loop reachable from the
    // engine and a damage subscription outliving its context, which is the exact invariant that
    // cleanup exists to hold. A cursor stuck in its hidden phase is cosmetic and self-heals on the
    // next repack of its row; a surviving subscription is a frozen canvas for the session.
    try {
      apply(true)
    } catch (err) {
      console.warn('[glyphgrid] cursor blink restore failed', err)
    }
  }

  return {
    sync(): void {
      if (torn) return
      const next = deps.target()
      if (next !== current) {
        // Restore BEFORE the handover: afterwards there is no handle to fix the old cursor with,
        // and it would sit hidden until something unrelated repacked its row.
        stopClock()
        current = next
      }
      if (!deps.enabled() || deps.covered() || !current) {
        stopClock()
        return
      }
      // Already ticking and every gate still holds — restarting the interval here would re-arm the
      // period on every unrelated settings write, so a canvas whose settings churn would never
      // reach a hide at all.
      if (handle) return
      // A terminal that has just taken focus starts SHOWN and gets a full period before its first
      // hide — xterm's own `_restartInterval` does exactly this, and it is what keeps the cursor
      // solid at the moment the user clicks into a terminal.
      if (!visible) apply(true)
      handle = deps.setInterval(() => apply(!visible), CURSOR_BLINK_INTERVAL_MS)
    },
    restart(): void {
      if (torn || !current) return
      // Show it FIRST, and through `apply` — so the re-shown cursor's repaint goes through the same
      // bracket every other phase does and takes `pulse()`. A restart that repainted outside it
      // would hand the wake path a repaint that happens on EVERY keystroke, which is worse than the
      // twice-a-second one this design was built to keep off it.
      if (!visible) apply(true)
      // Nothing is ticking (the setting is off, or the board is up): there is no period to re-arm,
      // and starting one here would blink a cursor the gates have already stopped. `sync` owns the
      // gates; this only ever restarts a clock that is already running.
      if (!handle) return
      clearTimer()
      handle = deps.setInterval(() => apply(!visible), CURSOR_BLINK_INTERVAL_MS)
    },
    routeDamage(): void {
      const loop = deps.loop()
      // Ours: one frame, still parked. Anyone else's: `wake()`, because ordinary damage (a terminal
      // writing rows) is likely to be followed by more, and a pulse per write would put a
      // scheduling hop in front of every character.
      if (applying > 0) loop.pulse()
      else loop.wake()
    },
    stop(): void {
      torn = true
      stopClock()
      current = null
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Context loss — restore ONCE per context, then fall back for good
// ---------------------------------------------------------------------------------------------

/**
 * How soon after a restore a SECOND loss means "this GPU is not coming back".
 *
 * A minute, because the two cases it separates are that far apart. A sleep/wake or a driver reset
 * takes the context away once and the machine then works for hours — that one is worth restoring,
 * and it is the whole reason this path exists (a GPU reset is what macOS does on wake, and under
 * Phase 1b it silently dropped every user to the DOM renderer until they relaunched). A GPU that is
 * genuinely failing takes it away again almost immediately, and restoring THAT in a loop is how one
 * failure becomes a flicker — the exact trade Phase 1b made by never restoring at all.
 */
export const RESTORE_COOLDOWN_MS = 60_000

/**
 * How long a suspended canvas waits for the restore it asked for before giving up.
 *
 * **`preventDefault()` is a REQUEST, not a guarantee**, and there are two ordinary ways the restore
 * never arrives: Chromium declines to restore a context whose GPU process has reset repeatedly, and
 * a SYNTHETIC loss (`WEBGL_lose_context.loseContext()` — which is how the device checklist forces
 * one) is never auto-restored at all; only an explicit `restoreContext()` on the same extension
 * object brings that one back. Without a watchdog both cases strand the session in the worst state
 * this module can produce: the engine suspended, the runtime stopped, and `failed` still FALSE — so
 * every node keeps a transparent body and keeps writing rows into a canvas that paints nothing,
 * with ONE line on the console and no second one ever, until the app is relaunched. That is
 * strictly worse than the Phase-1b behaviour this task promises to keep as its floor.
 *
 * Five seconds: a real restore lands within a few hundred milliseconds (a GPU-process restart being
 * the slow case), so this is generous by an order of magnitude, while a canvas that is never coming
 * back stays blank for a blink instead of for a session. A bounded ONE-SHOT is not the retry loop
 * the design forbids — it never asks for a second restore, it only stops waiting for the first.
 */
export const RESTORE_TIMEOUT_MS = 5000

/** Everything the policy touches, injected — so the once-only rule, the cooldown and the watchdog
 *  are testable without a GPU, a canvas, a clock or a timer, the same split
 *  `createBoardFrameGate` and `createCursorBlinkClock` make. */
export interface ContextLossDeps {
  now(): number
  /** Park everything that could draw and drop the engine's GPU objects. */
  suspend(): void
  /** Rebuild the GPU objects and resume. MAY THROW — a rebuild that fails is a permanent
   *  fallback, never a retry. */
  revive(): void
  /** The permanent fallback (`failSharedGlyph`). */
  fail(reason: string, err?: unknown): void
  setTimer(cb: () => void, ms: number): number
  clearTimer(handle: number): void
}

export interface ContextLossPolicy {
  /** Handle `webglcontextlost`. Returns whether the caller should `preventDefault()` the event —
   *  i.e. whether we are asking the browser for a restore at all. */
  onLost(): boolean
  /** Handle `webglcontextrestored`. */
  onRestored(): void
  /** Teardown: disarm the watchdog and make every later event inert. The watchdog is the one thing
   *  here that can outlive its owner, and it must not — a timer that fires after the layer has gone
   *  would fail a session whose context was merely handed back (the mode switched off), which then
   *  could not be re-enabled without a relaunch. */
  stop(): void
}

/**
 * The context-loss policy: **restore ONCE per context, never in a loop.**
 *
 * `preventDefault()` on `webglcontextlost` is what asks the browser to fire
 * `webglcontextrestored`, so it is called only when we intend to use the restore. Phase 1b
 * deliberately did not call it: there was nothing to restore into, and a session that lost its
 * context stayed on the DOM renderer until relaunch. That is a fine trade for an experimental mode
 * and an unacceptable one for the DEFAULT, because a GPU reset — sleep/wake, a driver hiccup —
 * would silently take every user's shared renderer away with no message.
 *
 * Four rules, and every one but the first is the floor Phase 1b's behaviour becomes:
 *  1. A first loss suspends and asks for a restore; the restore rebuilds and resumes.
 *  2. A second loss WITHIN `RESTORE_COOLDOWN_MS` of that restore falls back permanently. The
 *     restore is not retried, the event is not prevented, and the session goes back to the DOM
 *     renderer through the usual funnel.
 *  3. A restore that THROWS falls back permanently too — a half-rebuilt context draws nothing, and
 *     a canvas of transparent node bodies drawing nothing is indistinguishable from a freeze.
 *  4. A restore that NEVER ARRIVES falls back on a bounded watchdog (`RESTORE_TIMEOUT_MS`). Waiting
 *     forever is the one outcome that is worse than not restoring at all — see that constant.
 *
 * Every outcome is announced on the console, and that is a requirement rather than a courtesy: a
 * silent restore looks exactly like a frozen canvas to whoever is debugging one, and a silent
 * fallback looks exactly like a soft-text bug.
 */
export function createContextLossPolicy(deps: ContextLossDeps): ContextLossPolicy {
  /** When the last successful restore landed, or null while this context has never been restored. */
  let restoredAt: number | null = null
  /** Have we suspended and asked for a restore that has not arrived yet? */
  let awaiting = false
  /** Terminal: the session has fallen back, and no further event may do anything. */
  let done = false
  /** The armed watchdog, or 0 for none. Exactly one can exist: it is armed only on the transition
   *  into `awaiting` and cleared on every way out of it. */
  let watchdog = 0
  const disarm = (): void => {
    if (!watchdog) return
    deps.clearTimer(watchdog)
    watchdog = 0
  }
  /** The one place a give-up is spelled: disarm first, so no timer can fire a second, contradictory
   *  reason for a failure that has already been reported. */
  const giveUp = (reason: string, err?: unknown): void => {
    disarm()
    done = true
    deps.fail(reason, err)
  }
  return {
    onLost(): boolean {
      if (done) return false
      // A second `webglcontextlost` for the SAME outage (a duplicate event, a loss racing our own
      // teardown) is not a second failure — we are already suspended and already waiting.
      if (awaiting) return true
      if (restoredAt !== null && deps.now() - restoredAt < RESTORE_COOLDOWN_MS) {
        giveUp(
          `the WebGL context was lost again within ${Math.round(
            RESTORE_COOLDOWN_MS / 1000
          )}s of a restore — not restoring a second time`
        )
        return false
      }
      awaiting = true
      console.warn(
        '[glyphgrid] WebGL context lost — GPU objects dropped and frames parked; asking the browser to restore it'
      )
      // Armed BEFORE the suspend, so the wait can never outlive its own bound even if the suspend
      // path throws on its way through the runtime teardown.
      watchdog = deps.setTimer(() => {
        watchdog = 0
        if (done || !awaiting) return
        awaiting = false
        giveUp('the WebGL context was lost and never restored')
      }, RESTORE_TIMEOUT_MS)
      deps.suspend()
      return true
    },
    onRestored(): void {
      // A restore we did not ask for (the browser handing one back after we have already given up)
      // must not rebuild anything: the engine would double-create every grid's buffer, and the
      // session has already been told it is on the DOM renderer.
      if (done || !awaiting) return
      awaiting = false
      // The wait is over however it ends — a watchdog left running would fail a session that has
      // just recovered perfectly well.
      disarm()
      try {
        deps.revive()
      } catch (err) {
        giveUp('rebuilding the GPU objects after a context restore threw', err)
        return
      }
      // Recorded only on SUCCESS — the cooldown measures "how long did the restored context
      // survive", and a failed rebuild never produced one to measure.
      restoredAt = deps.now()
      console.warn(
        '[glyphgrid] WebGL context restored — GPU objects and every registered grid rebuilt; the canvas repaints in full'
      )
    },
    stop(): void {
      disarm()
      done = true
    }
  }
}

// ---------------------------------------------------------------------------------------------
// The component
// ---------------------------------------------------------------------------------------------

/**
 * Hosts the shared canvas inside the React Flow pane and drives its frames.
 *
 * **Stacking.** React Flow's own layers, from `@xyflow/react`'s base.css: `.react-flow__background`
 * is z-index -1 and `.react-flow__renderer` (which contains the pane and the transformed viewport
 * holding every node) is z-index 4, all inside the `.react-flow` wrapper's own stacking context.
 * Children passed to `<ReactFlow>` — this component, like `<Background/>` — render as siblings of
 * both. z-index 0 therefore puts the glyph canvas ABOVE the dot grid and BELOW the nodes, which is
 * where it has to be: node bodies stay opaque in v1, so the DOM keeps owning node chrome and
 * stacking, and the canvas only orders grids among themselves.
 *
 * **Not inside the viewport.** The canvas is screen-space — the engine applies the camera itself
 * in the shader — so it must not sit under React Flow's CSS transform, which would scale its
 * pixels instead.
 */
export function SharedGlyphLayer(): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const generation = useSharedGlyph((s) => s.generation)
  const failed = useSharedGlyph((s) => s.failed)
  /** Bumped when a terminal BUILDS the context. The layer cannot build one itself — the atlas
   *  geometry comes from a live terminal's device cell (see `DeviceCell`) — so whichever of the
   *  two runs first, the canvas still gets mounted: if this effect ran first it found nothing and
   *  this tick brings it back. Declared BEFORE the mounting effect so the subscription is live by
   *  the time a terminal in the same commit can create one. */
  const [contextTick, setContextTick] = useState(0)
  useEffect(() => subscribeSharedGlyphContext(() => setContextTick((n) => n + 1)), [])

  useEffect(() => {
    const host = hostRef.current
    if (!host || failed) return
    // No cell argument: the component never CREATES a context, it only adopts one.
    const ctx = ensureLiveContext()
    if (!ctx) return
    const canvas = ctx.canvas
    host.appendChild(canvas)

    // THE ONE INVARIANT SPANNING THE MODULE SINGLETON AND THIS EFFECT: the engine's suspended state
    // outlives the component, while the restore POLICY below is effect-scoped. A layer that
    // unmounted between a loss and its restore would therefore come back with a policy that is not
    // waiting for anything (`awaiting` false, so `onRestored` short-circuits) while the engine is
    // still suspended and `failed` is still false — the stranded canvas again, by a different road.
    // Unreachable today (every path that unmounts this effect disposes the context first, and a
    // fresh context is never suspended), which is exactly why it is worth a guard rather than a
    // comment: nothing enforces that ordering, and a mount is the one moment we can still decide.
    if (ctx.engine.gpuIsSuspended()) {
      try {
        // Rebuilt instead of revived (a blanked atlas page) means this context is gone and the
        // generation bump will re-run this effect against the fresh one.
        if (!reviveGpuOrRebuild(ctx)) return
        console.warn('[glyphgrid] mounted onto a suspended engine — GPU objects rebuilt')
      } catch (err) {
        // The context is still gone (its programs will not compile), so there is nothing to mount
        // onto. `failSharedGlyph` disposes it and re-runs this effect with `failed` true.
        failSharedGlyph('a suspended engine could not be revived at mount', err)
        return
      }
    }

    // DELIBERATELY OUTSIDE `startRuntime` BELOW — it must keep running through a context outage.
    // It draws nothing (`setViewport` only resizes the backing store and dirties), and it is what
    // keeps the GL layer's `deviceW`/`deviceH` current while the context is gone, so the viewport
    // the rebuild re-pushes is the size the canvas actually is. Moved into the runtime, a window
    // resized during an outage would come back with its grids culled against a stale viewport.
    const pushViewport = (): void => {
      const dpr = currentDpr()
      // A display change (the window dragged onto a monitor with a different pixel ratio) arrives
      // HERE, from whichever of the triggers below sees it first, and it is the one viewport input
      // the engine cannot absorb, because the ATLAS was rasterized for the old ratio. So it is
      // checked before the push: on a rebuild the context this closure holds is already gone, and
      // the fresh one gets its viewport from the re-run effect's own `pushViewport()`.
      if (syncAtlasPixelRatio(dpr, ctx) || ctx.disposed) return
      // The engine change-gates all three inputs, so calling this from every observer tick is
      // free when nothing actually moved.
      ctx.engine.setViewport(host.clientWidth, host.clientHeight, dpr)
    }
    pushViewport()

    // ResizeObserver, not just window resize: the pane also changes size when a drawer or the
    // sessions sidebar opens, and a stale viewport culls the wrong grids.
    const ro = new ResizeObserver(pushViewport)
    ro.observe(host)
    // ...and window `resize` on top of it, for the ordinary window-size changes that move the CSS
    // box without moving the host's (and as ONE of the two triggers for a dpr change).
    window.addEventListener('resize', pushViewport)
    // THE OTHER dpr trigger, and DO NOT DELETE EITHER AS REDUNDANT. Dragging the window to a
    // display with a different pixel ratio leaves the CSS box identical, so the ResizeObserver is
    // silent and only `resize` — if Blink dispatches one for a scale-factor change with an
    // unchanged CSS viewport — would carry it. xterm does not rely on that: its `CoreBrowserService`
    // watches this media query, and this atlas latches xterm's own device cell, so it watches the
    // same thing. Both land in `pushViewport`, whose `syncAtlasPixelRatio` re-entry guard makes a
    // double fire free.
    const dprWatch = createPixelRatioWatcher(
      {
        dpr: currentDpr,
        match: (query) =>
          typeof window !== 'undefined' && typeof window.matchMedia === 'function'
            ? window.matchMedia(query)
            : null
      },
      pushViewport
    )

    /**
     * EVERYTHING THAT CAN DRAW OR SCHEDULE A FRAME, as one startable/stoppable unit. (The three
     * viewport triggers above are the deliberate exception — they schedule nothing; see their
     * comments.)
     *
     * It is a unit because a lost context has to take ALL of it down at once and a restore has to
     * bring exactly it back: the rAF chain, the heartbeat timer, the blink clock's interval, the
     * damage subscription and the four store/window subscriptions that can wake or rebuild any of
     * them. A single survivor is a frame submitted against GPU objects that no longer exist — which
     * the driver's catch reads as a GPU failure and answers by burning the session that is in the
     * middle of recovering. And a single thing started twice is two rAF chains on one canvas.
     *
     * The mount path and the restore path therefore run the same function, and the cleanup below
     * and the suspend path run the same `stop()`.
     */
    const startRuntime = (): { stop(): void } => {
      // The frame loop PARKS when the canvas goes quiet — an always-registered rAF keeps Chromium's
      // whole frame pipeline ticking at the display's refresh rate to draw nothing. All the
      // scheduling and the park/heartbeat policy live in `createFrameLoop` (unit-tested there); this
      // only supplies the seams and the wake signals.
      //
      // The gate around it answers the case the park cannot: the kanban board covering the canvas.
      // It owns starting and stopping (including the "mounted while the board is already up" case),
      // which is why there is no `loop.start()` here — see `createBoardFrameGate`.
      const gate = createBoardFrameGate(boardCoversCanvas, () =>
        createFrameLoop({
          // The context can be torn down synchronously between a schedule and its callback (font
          // change, dpr change, mode switched off); the loop stops itself rather than rescheduling,
          // and the cleanup below is idempotent either way.
          alive: () => !ctx.disposed,
          frame: () => ctx.engine.frame(),
          // `frame()` rethrows by contract, having restored its own damage. A throw is a GL error
          // rather than a lost context (that arrives as an EVENT, handled below), and there is no
          // recovery from it: the whole session goes back to the DOM renderer.
          onError: (err) => failSharedGlyph('frame threw', err),
          requestFrame: (cb) => requestAnimationFrame(cb),
          cancelFrame: (h) => cancelAnimationFrame(h),
          setTimer: (cb, ms) => window.setTimeout(cb, ms),
          clearTimer: (h) => window.clearTimeout(h)
        })
      )
      // ONE blink clock for the whole canvas — not one per terminal — because at most one terminal
      // has focus. It reaches the loop through `gate.loop()` for the same reason the damage
      // subscription does, and its own repaints take `pulse()` rather than `wake()`; see
      // `createCursorBlinkClock` for why that distinction is the whole task.
      const clock = createCursorBlinkClock({
        enabled: () => useSettings.getState().settings.cursorBlink,
        covered: boardCoversCanvas,
        target: cursorBlinkTarget,
        loop: () => gate.loop(),
        setInterval: (cb, ms) => window.setInterval(cb, ms),
        clearInterval: (h) => window.clearInterval(h)
      })
      // Mounted with a terminal already focused (a remount, a project switch back, a restore that
      // never took focus away) must start the clock, exactly as the gate reads the board flag at
      // construction rather than assuming.
      clock.sync()
      // THE wake mechanism: the engine funnels every damage write through `markDirty`, which calls
      // out on the clean→dirty edge. A parked loop resumes on the very next damaging write. Reached
      // through `gate.loop()` and never captured — leaving the board builds a fresh loop, and a
      // subscription pinned to the stopped one would freeze the canvas for the rest of the session.
      //
      // Routed through the clock, which is the only thing that can tell the blink's own repaint from
      // everybody else's damage: its repaint is isolated in time and takes `pulse()` (one frame, still
      // parked), while ordinary damage keeps the `wake()` it has always had.
      const damage = ctx.engine.onDamage(() => clock.routeDamage())
      // The two gates that can move without the board moving: the blink SETTING and which terminal
      // holds focus. Both are change-gated inside `sync`.
      const unsubBlinkTarget = subscribeCursorBlinkTarget(() => clock.sync())
      const unsubBlinkSetting = useSettings.subscribe(() => clock.sync())
      // ...and the cursor MOVING, which is not a gate at all: it holds the cursor solid and starts
      // the period over, exactly as xterm does while you type. Its own channel, because `sync` is
      // deliberately a no-op while the interval is already running.
      const unsubBlinkRestart = subscribeCursorBlinkRestart(() => clock.restart())
      // Belt and braces for the background-throttling case (Task 9): a park entered while the window
      // was occluded must not outlive the return, and a throttled/coalesced rAF can leave the loop
      // parked with damage pending. Both are cheap — `wake()` only schedules a frame that draws
      // nothing when there is nothing to draw, and it is inert while the board is up.
      const onVisible = (): void => {
        if (!document.hidden) gate.loop().wake()
      }
      const onFocus = (): void => gate.loop().wake()
      window.addEventListener('focus', onFocus)
      document.addEventListener('visibilitychange', onVisible)
      // Both stores, because either can move the board over this canvas: the view toggle, and a
      // switch to a project that is already on it. `sync` is change-gated, so the projects store's
      // chattier notifications (it is rewritten on every node serialization) cost a comparison.
      // The board is the blink clock's third gate as well (a stopped loop cannot draw the phase), so
      // the two are synced together — and the gate goes FIRST, so the clock reads the board through
      // an already-updated loop.
      const syncBoard = (): void => {
        gate.sync()
        clock.sync()
      }
      const unsubView = useViewMode.subscribe(syncBoard)
      const unsubProjects = useProjects.subscribe(syncBoard)
      let stopped = false
      return {
        stop(): void {
          // Idempotent: the suspend path and the effect cleanup can both reach the same runtime
          // (a lost context that is immediately followed by an unmount), and every member below
          // would be stopped twice otherwise.
          if (stopped) return
          stopped = true
          // Everything the loop owns goes at once — the pending frame, the heartbeat TIMER and the
          // damage subscription — plus the two store subscriptions that can hand it a new one. A
          // surviving timer would keep calling `frame()` on a context this run has let go of, a
          // surviving damage subscription would keep a dead loop reachable from the engine, and a
          // surviving board subscription would BUILD a loop against a disposed context.
          // `gate.stop()` is idempotent and also makes a `sync` still in flight inert, so the
          // `ctx.disposed` and `failSharedGlyph` paths (which stop the loop themselves) land here
          // safely too.
          // The clock goes FIRST, and before the unsubscribes: it hands the cursor back SHOWN, and
          // it can only do that while it still HOLDS the target — `stop()` drops it. What that buys
          // is the packed ROW, not a drawn frame: the `pulse()` it schedules is cancelled moments
          // later by `gate.stop()`, and the point is that the grid's buffers no longer hold a hidden
          // cursor, so whatever draws them next (a remount, the board closing) draws a cursor. Its
          // restore is guarded inside `stopClock`, so a throwing repack cannot skip the teardown
          // below it.
          clock.stop()
          unsubBlinkTarget()
          unsubBlinkRestart()
          unsubBlinkSetting()
          gate.stop()
          unsubView()
          unsubProjects()
          damage.dispose()
          window.removeEventListener('focus', onFocus)
          document.removeEventListener('visibilitychange', onVisible)
        }
      }
    }
    let runtime = startRuntime()

    /**
     * A lost context is now SURVIVABLE — see `createContextLossPolicy` for the once-only rule and
     * the cooldown that keeps it from becoming a retry loop.
     *
     * The two halves are ordered against each other on purpose. On the way DOWN the runtime stops
     * before the engine drops its GPU objects, so no frame can be submitted in between; on the way
     * UP the GPU objects are rebuilt before a fresh runtime exists to schedule anything, so the
     * first frame of the new context has something to draw with. `reviveGpu` throws if the rebuild
     * fails, and the policy answers that with the permanent fallback — the runtime stays stopped,
     * which is the correct state for a session that is going back to the DOM renderer.
     */
    const policy = createContextLossPolicy({
      now: () => Date.now(),
      suspend: () => {
        runtime.stop()
        ctx.engine.suspendGpu()
      },
      revive: () => {
        // A GPU reset takes the atlas page with the context. Reviving onto a blanked page would
        // upload an empty atlas over every terminal on the canvas, so that case rebuilds instead —
        // and there is no runtime to start here, because there is no longer a context to start it
        // against.
        if (!reviveGpuOrRebuild(ctx)) return
        runtime = startRuntime()
      },
      fail: (reason, err) => failSharedGlyph(reason, err),
      setTimer: (cb, ms) => window.setTimeout(cb, ms),
      clearTimer: (h) => window.clearTimeout(h)
    })
    // `preventDefault()` is the request for a `webglcontextrestored` event, so it is called only
    // when the policy actually intends to use one. Phase 1b never called it at all.
    const onLost = (e: Event): void => {
      if (policy.onLost()) e.preventDefault()
    }
    const onRestored = (): void => policy.onRestored()
    canvas.addEventListener('webglcontextlost', onLost)
    canvas.addEventListener('webglcontextrestored', onRestored)

    return () => {
      // Nothing may outlive the context — this is also the teardown for the `ctx.disposed` and
      // `failSharedGlyph` paths, both of which re-run this effect. `runtime` is read (not captured)
      // so a cleanup after a restore stops the CURRENT runtime rather than the one this effect run
      // started with. The policy goes with it, so its watchdog cannot outlive the context it was
      // waiting on.
      runtime.stop()
      policy.stop()
      ro.disconnect()
      window.removeEventListener('resize', pushViewport)
      dprWatch.stop()
      canvas.removeEventListener('webglcontextlost', onLost)
      canvas.removeEventListener('webglcontextrestored', onRestored)
      // The canvas leaves the DOM with the host div; the CONTEXT stays alive for the next mount
      // (a project switch must not cost a context rebuild). Only `failSharedGlyph` and a font
      // change dispose it.
    }
  }, [generation, failed, contextTick])

  return (
    <div
      ref={hostRef}
      className="glyphgrid-layer"
      style={{ position: 'absolute', inset: 0, zIndex: 0, pointerEvents: 'none' }}
    />
  )
}
