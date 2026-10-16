// Where to drop a NEW node when there is no cursor to place it at (the kanban board's "+ New
// session", the dock's add menu, the command palette). Those all fell back to the view center, so
// every node created that way piled up on the same spot — switch to the canvas and you'd find a
// stack of overlapping nodes. `freeSpot` instead finds the nearest empty position.
//
// `slotBelowSource` is the same problem for a node an AGENT opens (canvas-control's open/show
// verbs), where there IS an anchor — the agent's own node — and the layout should read as "hanging
// off that conversation".

import { rootPositionIn, type PlacedNode } from './projectOpen'

export interface Box {
  x: number
  y: number
  w: number
  h: number
}

/** How far a bounded placement steps down-right off a node whose top-left it would share (#1140):
 *  enough to leave that node's header row showing above the new one. */
export const CASCADE_STEP = 32
const CASCADE_MAX_HOPS = 64

/** `p`, moved down-right by `CASCADE_STEP` until no box in `existing` starts within a step of it. */
function cascadeOff(existing: Box[], p: { x: number; y: number }): { x: number; y: number } {
  let { x, y } = p
  for (
    let hop = 0;
    hop < CASCADE_MAX_HOPS &&
    existing.some((b) => Math.abs(b.x - x) < CASCADE_STEP && Math.abs(b.y - y) < CASCADE_STEP);
    hop++
  ) {
    x += CASCADE_STEP
    y += CASCADE_STEP
  }
  return { x, y }
}

/**
 * The nearest position (to `preferred`) where a `size` box does not overlap any of `existing`,
 * searched outward on a grid stepped by the node size. Returns `preferred` unchanged when it's
 * already clear (so a lone node / an empty canvas keeps the centered placement). Pure + testable.
 * `preferred` and the answer are TOP-LEFT corners.
 *
 * `gap` is the minimum breathing room kept between boxes. The ring search is capped so a pathological
 * canvas can never loop forever — past the cap it gives up and returns `preferred` (overlap is a far
 * lesser evil than a hang).
 *
 * `bounds` (issue #1140) keeps the answer inside a rectangle — the visible canvas — so a node made
 * from a shortcut never lands somewhere the user cannot see. Inside it the search runs on a half-step
 * grid (a view is only a few nodes wide), and when nothing in view is clear it takes the in-view
 * spot covered LEAST, nearest first: a busy view gets a visible, partly overlapping node rather than
 * a clear one off screen. The search starts from `preferred` pulled inside `bounds` (a pinned panel
 * can push the view centre's box past the visible edge), and a node too big for `bounds` at all
 * (zoomed in past the node's size) stays at `preferred`.
 *
 * Whatever the bounded branch answers is CASCADED off any node whose top-left it would share
 * (`CASCADE_STEP` down-right per hit, like stacked windows): a view under about two node-widths has
 * no other in-view cell, and without this every node made in a row landed exactly on the last one —
 * invisible, the very pile this function exists to prevent.
 */
export function freeSpot(
  existing: Box[],
  preferred: { x: number; y: number },
  size: { w: number; h: number },
  gap = 28,
  bounds?: Box
): { x: number; y: number } {
  const clear = (x: number, y: number): boolean =>
    !existing.some(
      (b) =>
        x < b.x + b.w + gap &&
        x + size.w + gap > b.x &&
        y < b.y + b.h + gap &&
        y + size.h + gap > b.y
    )

  if (clear(preferred.x, preferred.y)) return preferred

  if (bounds) {
    // "Does it fit at all" is size against bounds, never where the centred box happens to sit.
    if (size.w > bounds.w || size.h > bounds.h) return cascadeOff(existing, preferred)
    const inside = (x: number, y: number): boolean =>
      x >= bounds.x && y >= bounds.y && x + size.w <= bounds.x + bounds.w && y + size.h <= bounds.y + bounds.h
    const start = {
      x: Math.min(Math.max(preferred.x, bounds.x), bounds.x + bounds.w - size.w),
      y: Math.min(Math.max(preferred.y, bounds.y), bounds.y + bounds.h - size.h)
    }
    if (clear(start.x, start.y)) return start
    const covered = (x: number, y: number): number =>
      existing.reduce((sum, b) => {
        const w = Math.min(x + size.w, b.x + b.w) - Math.max(x, b.x)
        const h = Math.min(y + size.h, b.y + b.h) - Math.max(y, b.y)
        return w > 0 && h > 0 ? sum + w * h : sum
      }, 0)
    const sx = (size.w + gap) / 2
    const sy = (size.h + gap) / 2
    const rings = Math.min(200, Math.ceil(Math.max(bounds.w / sx, bounds.h / sy)) + 1)
    let best = { x: start.x, y: start.y, area: covered(start.x, start.y) }
    for (let ring = 1; ring <= rings; ring++) {
      for (let dy = -ring; dy <= ring; dy++) {
        for (let dx = -ring; dx <= ring; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue // perimeter only
          const x = start.x + dx * sx
          const y = start.y + dy * sy
          if (!inside(x, y)) continue
          if (clear(x, y)) return { x, y }
          const area = covered(x, y)
          if (area < best.area) best = { x, y, area }
        }
      }
    }
    return cascadeOff(existing, { x: best.x, y: best.y })
  }

  const stepX = size.w + gap
  const stepY = size.h + gap
  // Expanding square rings around `preferred`; within a ring, walk the perimeter and take the first
  // clear cell. Nearest-first keeps new nodes close to where the user is looking.
  for (let ring = 1; ring <= 60; ring++) {
    for (let dy = -ring; dy <= ring; dy++) {
      for (let dx = -ring; dx <= ring; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue // perimeter only
        const x = preferred.x + dx * stepX
        const y = preferred.y + dy * stepY
        if (clear(x, y)) return { x, y }
      }
    }
  }
  return preferred
}

/**
 * `freeSpot` in the terms the node factories speak: a CENTRE in, a CENTRE out (`placeAt` turns a
 * centre into the top-left by subtracting half the size). Issue #1140: `emptyNodePos` used to hand
 * the view centre to `freeSpot` AS a top-left and then give the answer to the factories AS a centre,
 * so every overlap check was made half a node away from where the node actually landed.
 */
export function emptySpotCenter(
  existing: Box[],
  view: Box | undefined,
  center: { x: number; y: number },
  size: { w: number; h: number },
  gap = 28
): { x: number; y: number } {
  const topLeft = { x: center.x - size.w / 2, y: center.y - size.h / 2 }
  const at = freeSpot(existing, topLeft, size, gap, view)
  return at === topLeft ? center : { x: at.x + size.w / 2, y: at.y + size.h / 2 }
}

/**
 * Where a node an AGENT opens lands (canvas-control's `open-*` / `show-*` verbs). Returns a
 * TOP-LEFT point in root space.
 *
 * The old rule was a fixed point under the source, fanned right by 460 px per node of the SAME
 * call, with no look at the canvas. So the ordinary orchestration shape — one `open-claude` per
 * worktree, each a separate call with count 1 — put every session on exactly one spot, and even a
 * single `--count 3` overlapped itself (a default node is 640 px wide).
 *
 * Now: a grid under the source, left-aligned to it, filled row by row (`cols` per row), taking the
 * first cell that keeps `gap` clear of everything in `occupied`. The cell is tested AFTER `snap`,
 * so grid rounding cannot slide a node onto a neighbour after the check passed. `occupied` must be
 * root-space and must include every node placed earlier in the same batch. Past the search cap it
 * drops below everything, which is clear by construction — overlap is never the fallback.
 */
export function slotBelowSource(
  occupied: readonly Box[],
  source: Box,
  size: { w: number; h: number },
  opts: {
    gap?: number
    cols?: number
    snap?: (p: { x: number; y: number }) => { x: number; y: number }
  } = {}
): { x: number; y: number } {
  const gap = opts.gap ?? 40
  const cols = Math.max(1, Math.floor(opts.cols ?? 4))
  const snap = opts.snap ?? ((p) => p)
  const clear = (p: { x: number; y: number }): boolean =>
    !occupied.some(
      (b) =>
        p.x < b.x + b.w + gap &&
        p.x + size.w + gap > b.x &&
        p.y < b.y + b.h + gap &&
        p.y + size.h + gap > b.y
    )
  // 80 px under the source: the room the lineage rope has always had.
  const top = source.y + source.h + 80
  for (let row = 0; row < 200; row++) {
    for (let col = 0; col < cols; col++) {
      const p = snap({ x: source.x + col * (size.w + gap), y: top + row * (size.h + gap) })
      if (clear(p)) return p
    }
  }
  const bottom = occupied.reduce((m, b) => Math.max(m, b.y + b.h + gap), top)
  // Snap can round up to half a cell back toward the box above; a whole extra gap absorbs it.
  return snap({ x: source.x, y: bottom + gap })
}

/** A node as the live canvas (React Flow, with `measured`) or the serialized store (`size`) holds
 *  it — enough to place something next to it. */
export interface PlaceableNode extends PlacedNode {
  id: string
  measured?: { width?: number; height?: number }
}

const DEFAULT_W = 600
const DEFAULT_H = 400

const boxOf = (n: PlaceableNode, at: { x: number; y: number }): Box => ({
  x: at.x,
  y: at.y,
  w: n.measured?.width ?? n.size?.width ?? (n.width as number | undefined) ?? DEFAULT_W,
  h: n.measured?.height ?? n.size?.height ?? (n.height as number | undefined) ?? DEFAULT_H
})

/**
 * `slotBelowSource` over a project's node array: resolves every node (and the source) to ROOT
 * space, and leaves out the frames that CONTAIN the source — the opened node is parented into the
 * source's frame, so that frame is where it belongs, not an obstacle. Any other frame is one: a
 * top-level node drawn over a frame reads as inside it while it is not. `extra` is what this batch
 * (or a racing call) already placed and the array does not show yet. `undefined` when the source
 * is not in `nodes`.
 */
export function placeBelowSource(
  nodes: readonly PlaceableNode[],
  sourceId: string,
  size: { w: number; h: number },
  opts: { extra?: readonly Box[]; snapGrid?: number } = {}
): { x: number; y: number } | undefined {
  const src = nodes.find((n) => n.id === sourceId)
  if (!src) return undefined
  const ancestors = new Set<string>()
  const byId = new Map(nodes.map((n) => [n.id, n]))
  for (let p = src.parentId; p && !ancestors.has(p); p = byId.get(p)?.parentId) ancestors.add(p)
  const occupied = nodes
    .filter((n) => !ancestors.has(n.id))
    .map((n) => boxOf(n, rootPositionIn(nodes, n)))
  const g = opts.snapGrid ?? 0
  return slotBelowSource(
    [...occupied, ...(opts.extra ?? [])],
    boxOf(src, rootPositionIn(nodes, src)),
    size,
    g > 0
      ? { snap: (p) => ({ x: Math.round(p.x / g) * g + 0, y: Math.round(p.y / g) * g + 0 }) }
      : {}
  )
}

/**
 * A box an open has taken but the node array may not show yet: `setNodes` commits on the next
 * render and the cold path's snapshot is read before its awaits, so two opens racing each other
 * (an agent firing `open-claude … &` per worktree) would otherwise both see the same empty cell.
 */
export interface PlacementClaim {
  projectId: string
  id: string
  box: Box
  at: number
}

/** Long enough to outlive any render/IPC lag, short enough that a deleted node's cell frees up. */
export const PLACEMENT_CLAIM_TTL_MS = 10_000

export function pruneClaims(claims: readonly PlacementClaim[], now: number): PlacementClaim[] {
  return claims.filter((c) => now - c.at < PLACEMENT_CLAIM_TTL_MS)
}

/** The claims that still answer for a cell: same project, still young, and not yet in the array —
 *  once the node is present its REAL box (which the user may have moved) speaks for it. */
export function pendingClaimBoxes(
  claims: readonly PlacementClaim[],
  projectId: string,
  presentIds: ReadonlySet<string>,
  now: number
): Box[] {
  return claims
    .filter((c) => c.projectId === projectId && now - c.at < PLACEMENT_CLAIM_TTL_MS && !presentIds.has(c.id))
    .map((c) => c.box)
}
