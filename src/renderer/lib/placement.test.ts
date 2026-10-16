import { describe, it, expect } from 'vitest'
import {
  CASCADE_STEP,
  emptySpotCenter,
  freeSpot,
  placeBelowSource,
  pendingClaimBoxes,
  pruneClaims,
  slotBelowSource,
  PLACEMENT_CLAIM_TTL_MS,
  type Box
} from './placement'

const size = { w: 100, h: 100 }

describe('freeSpot', () => {
  it('returns the preferred spot on an empty canvas', () => {
    expect(freeSpot([], { x: 0, y: 0 }, size)).toEqual({ x: 0, y: 0 })
  })

  it('returns the preferred spot when it does not overlap anything', () => {
    const existing: Box[] = [{ x: 500, y: 500, w: 100, h: 100 }]
    expect(freeSpot(existing, { x: 0, y: 0 }, size)).toEqual({ x: 0, y: 0 })
  })

  it('moves the node off an occupied spot to a nearby clear one', () => {
    const existing: Box[] = [{ x: 0, y: 0, w: 100, h: 100 }]
    const spot = freeSpot(existing, { x: 0, y: 0 }, size)
    expect(spot).not.toEqual({ x: 0, y: 0 })
    // the chosen spot must not overlap the occupied box (with the default gap)
    const overlaps = spot.x < 128 && spot.x + 128 > 0 && spot.y < 128 && spot.y + 128 > 0
    expect(overlaps).toBe(false)
  })

  it('respects the gap: an adjacent-but-too-close spot is rejected, a spot a full step away is taken', () => {
    // One box at origin; the first clear cell is a full (size+gap) step out.
    const existing: Box[] = [{ x: 0, y: 0, w: 100, h: 100 }]
    const spot = freeSpot(existing, { x: 0, y: 0 }, size, 28)
    // nearest ring cell is 128px away on an axis
    expect(Math.max(Math.abs(spot.x), Math.abs(spot.y))).toBe(128)
  })

  it('finds a hole in a packed grid rather than piling on', () => {
    // Fill a 3x3 grid around origin EXCEPT the center; preferred=center → it should stay (clear),
    // so instead leave the center occupied and a hole at (128,0).
    const step = 128
    const existing: Box[] = []
    for (let gx = -1; gx <= 1; gx++)
      for (let gy = -1; gy <= 1; gy++)
        if (!(gx === 1 && gy === 0)) existing.push({ x: gx * step, y: gy * step, w: 100, h: 100 })
    const spot = freeSpot(existing, { x: 0, y: 0 }, size)
    expect(spot).toEqual({ x: 128, y: 0 }) // the one hole
  })

  it('never overlaps any existing node across a dense fill', () => {
    const existing: Box[] = []
    for (let i = 0; i < 20; i++) existing.push({ x: (i % 5) * 128, y: Math.floor(i / 5) * 128, w: 100, h: 100 })
    const spot = freeSpot(existing, { x: 0, y: 0 }, size)
    const clear = !existing.some(
      (b) => spot.x < b.x + b.w + 28 && spot.x + 128 > b.x && spot.y < b.y + b.h + 28 && spot.y + 128 > b.y
    )
    expect(clear).toBe(true)
  })
})

describe('slotBelowSource — where an agent-opened node lands', () => {
  const source: Box = { x: 100, y: 200, w: 800, h: 600 }
  const node = { w: 640, h: 440 }
  const gap = 40
  const overlap = (a: Box, b: Box): boolean =>
    a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y

  it('lands the first node left-aligned under its source, clear of the source', () => {
    expect(slotBelowSource([source], source, node, { gap })).toEqual({ x: 100, y: 880 })
  })

  it('never stacks: four separate opens from one source land in four distinct cells', () => {
    // The field report: an orchestrator opened one session per worktree — four calls, each with
    // count 1 — and every one landed on the same point.
    const occupied: Box[] = [source]
    const placed: Box[] = []
    for (let i = 0; i < 4; i++) {
      const at = slotBelowSource(occupied, source, node, { gap })
      const box = { ...at, ...node }
      occupied.push(box)
      placed.push(box)
    }
    expect(placed.map((b) => b.x)).toEqual([100, 780, 1460, 2140])
    expect(new Set(placed.map((b) => b.y))).toEqual(new Set([880]))
    for (let i = 0; i < placed.length; i++) {
      expect(overlap(placed[i], source)).toBe(false)
      for (let j = i + 1; j < placed.length; j++) expect(overlap(placed[i], placed[j])).toBe(false)
    }
  })

  it('wraps to the next row once a row holds `cols` nodes', () => {
    const occupied: Box[] = [source]
    let last = { x: 0, y: 0 }
    for (let i = 0; i < 5; i++) {
      last = slotBelowSource(occupied, source, node, { gap, cols: 4 })
      occupied.push({ ...last, ...node })
    }
    expect(last).toEqual({ x: 100, y: 880 + 440 + gap })
  })

  it('steps past an unrelated node already sitting under the source', () => {
    const stranger: Box = { x: 150, y: 900, w: 300, h: 200 }
    expect(slotBelowSource([source, stranger], source, node, { gap })).toEqual({ x: 780, y: 880 })
  })

  it('checks the SNAPPED cell, so grid rounding cannot slide a node onto its neighbour', () => {
    const grid = 24
    const snap = (p: { x: number; y: number }) => ({
      x: Math.round(p.x / grid) * grid,
      y: Math.round(p.y / grid) * grid
    })
    // The blocker takes cell 0; cell 1 is raw (780, 880) and snaps to (792, 888). Whatever comes
    // back must be ON the grid and still keep the full gap from everything.
    const blocker: Box = { x: 60, y: 880, w: 40, h: 40 }
    const at = slotBelowSource([source, blocker], source, node, { gap, snap })
    expect(at.x % grid).toBe(0)
    expect(at.y % grid).toBe(0)
    const box = { ...at, ...node }
    const padded = { x: blocker.x - gap, y: blocker.y - gap, w: blocker.w + 2 * gap, h: blocker.h + 2 * gap }
    expect(overlap(box, padded)).toBe(false)
  })

  it('falls back to below EVERYTHING when the grid under the source is walled off — never onto a node', () => {
    const wall: Box = { x: -1e6, y: 850, w: 2e6, h: 1e6 }
    const at = slotBelowSource([source, wall], source, node, { gap })
    expect(at.x).toBe(source.x)
    expect(at.y).toBeGreaterThanOrEqual(wall.y + wall.h + gap)
  })
})

describe('placeBelowSource — slotBelowSource over a real node array', () => {
  const size = { w: 640, h: 440 }

  it('resolves a source nested in frames to ROOT space', () => {
    const outer = { id: 'g1', type: 'group', position: { x: 1000, y: 1000 }, width: 3000, height: 3000 }
    const inner = { id: 'g2', type: 'group', parentId: 'g1', position: { x: 100, y: 100 }, width: 2000, height: 2000 }
    const src = { id: 's', parentId: 'g2', position: { x: 50, y: 60 }, width: 600, height: 400 }
    expect(placeBelowSource([outer, inner, src], 's', size)).toEqual({ x: 1150, y: 1640 })
  })

  it('does not treat the frames CONTAINING the source as obstacles, but does treat any other frame as one', () => {
    const own = { id: 'g1', type: 'group', position: { x: 0, y: 0 }, width: 5000, height: 5000 }
    const src = { id: 's', parentId: 'g1', position: { x: 0, y: 0 }, width: 600, height: 400 }
    expect(placeBelowSource([own, src], 's', size)).toEqual({ x: 0, y: 480 })
    const other = { id: 'g9', type: 'group', position: { x: -10, y: 470 }, width: 700, height: 300 }
    expect(placeBelowSource([other, { ...src, parentId: undefined }], 's', size)).not.toEqual({
      x: 0,
      y: 480
    })
  })

  it("prefers React Flow's measured size, then the persisted size, then the width field", () => {
    const measured = { id: 's', position: { x: 0, y: 0 }, width: 600, height: 400, measured: { width: 600, height: 900 } }
    expect(placeBelowSource([measured], 's', size)!.y).toBe(980)
    const stored = { id: 's', position: { x: 0, y: 0 }, size: { width: 600, height: 700 } }
    expect(placeBelowSource([stored], 's', size)!.y).toBe(780)
  })

  it('counts boxes placed earlier in the same batch (setNodes has not committed them yet)', () => {
    const src = { id: 's', position: { x: 0, y: 0 }, width: 600, height: 400 }
    const first = placeBelowSource([src], 's', size)!
    const second = placeBelowSource([src], 's', size, { extra: [{ ...first, ...size }] })!
    expect(second).not.toEqual(first)
    expect(second.y).toBe(first.y)
  })

  it('returns undefined when the source is not in the array (the caller keeps its old answer)', () => {
    expect(placeBelowSource([], 'nope', size)).toBeUndefined()
  })
})

describe('placement claims — opens that raced ahead of the render', () => {
  const box: Box = { x: 0, y: 0, w: 10, h: 10 }
  it('answers only for the same project, while young, and until the node itself is present', () => {
    const claims = [
      { projectId: 'p', id: 'a', box, at: 1000 },
      { projectId: 'q', id: 'b', box, at: 1000 },
      { projectId: 'p', id: 'c', box, at: 1000 - PLACEMENT_CLAIM_TTL_MS },
      { projectId: 'p', id: 'd', box, at: 1000 }
    ]
    expect(pendingClaimBoxes(claims, 'p', new Set(['d']), 1000)).toEqual([box])
  })
  it('prunes expired claims', () => {
    const claims = [
      { projectId: 'p', id: 'a', box, at: 0 },
      { projectId: 'p', id: 'b', box, at: 5 }
    ]
    expect(pruneClaims(claims, PLACEMENT_CLAIM_TTL_MS + 1).map((c) => c.id)).toEqual(['b'])
  })
})

// Issue #1140: a node created by a shortcut / dock / palette landed wherever the unbounded ring
// search found room — often far outside the view — and the check was made at the wrong place.
describe('emptySpotCenter (issue #1140)', () => {
  const size = { w: 100, h: 100 }
  const view: Box = { x: -300, y: -200, w: 600, h: 400 }
  const tl = (c: { x: number; y: number }) => ({ x: c.x - size.w / 2, y: c.y - size.h / 2 })
  const overlaps = (p: { x: number; y: number }, b: Box) =>
    p.x < b.x + b.w && p.x + size.w > b.x && p.y < b.y + b.h && p.y + size.h > b.y
  const insideView = (p: { x: number; y: number }) =>
    p.x >= view.x && p.y >= view.y && p.x + size.w <= view.x + view.w && p.y + size.h <= view.y + view.h

  it('returns the view centre when it is free', () => {
    expect(emptySpotCenter([], view, { x: 0, y: 0 }, size)).toEqual({ x: 0, y: 0 })
  })

  it('checks the CENTRED box the factory will place, not a box hanging off the centre', () => {
    // Overlaps the centred node (-50..50) but not a box whose top-left is the centre (0..100).
    const box: Box = { x: -120, y: -120, w: 80, h: 80 }
    const c = emptySpotCenter([box], view, { x: 0, y: 0 }, size)
    expect(overlaps(tl(c), box)).toBe(false)
  })

  it('stays inside the view when the centre is taken', () => {
    const box: Box = { x: -60, y: -60, w: 120, h: 120 }
    const c = emptySpotCenter([box], view, { x: 0, y: 0 }, size)
    expect(overlaps(tl(c), box)).toBe(false)
    expect(insideView(tl(c))).toBe(true)
  })

  it('a full view never sends the node off screen — it takes the least-covered spot in view', () => {
    // Everything visible is covered except a strip on the right edge.
    const wall: Box = { x: -320, y: -220, w: 520, h: 440 }
    const c = emptySpotCenter([wall], view, { x: 0, y: 0 }, size)
    expect(insideView(tl(c))).toBe(true)
    // The old unbounded search answered a clear cell outside the view; this one prefers room in it.
    const fully: Box = { x: -10_000, y: -10_000, w: 20_000, h: 20_000 }
    const d = emptySpotCenter([fully], view, { x: 0, y: 0 }, size)
    expect(insideView(tl(d))).toBe(true)
  })

  it('two nodes made in a row on a full view do not land exactly on top of each other', () => {
    const wall: Box = { x: -320, y: -220, w: 640, h: 440 }
    const first = tl(emptySpotCenter([wall], view, { x: 0, y: 0 }, size))
    const second = tl(emptySpotCenter([wall, { ...first, ...size }], view, { x: 0, y: 0 }, size))
    expect(second).not.toEqual(first)
    expect(insideView(second)).toBe(true)
  })

  it('a view smaller than the node keeps the node centred on it, stepped off an exact overlap', () => {
    const tiny: Box = { x: -20, y: -20, w: 40, h: 40 }
    expect(emptySpotCenter([], tiny, { x: 0, y: 0 }, size)).toEqual({ x: 0, y: 0 })
    // Exactly where an existing node already sits: cascaded down-right, never stacked on it.
    expect(emptySpotCenter([{ x: -50, y: -50, w: 100, h: 100 }], tiny, { x: 0, y: 0 }, size)).toEqual({
      x: CASCADE_STEP,
      y: CASCADE_STEP
    })
  })

  // The review's reproduction: a 1440x864 canvas (top bar 32 px, dock 52 px, optionally a pinned
  // 308 px sidebar), one default-sized node already centred, then shortcut creates in a row. A view
  // under about two node-widths has no other in-view cell, so before the cascade every create
  // landed EXACTLY on the previous one — at zoom 1.38, where goToNode's framing lands, every time.
  it.each([
    [1.0, 0],
    [1.0, 308],
    [1.2, 0],
    [1.38, 0],
    [1.38, 308]
  ])('creates in a row never share a top-left (zoom %s, pinned %s px)', (zoom, pinned) => {
    const node = { w: 640, h: 440 }
    const toFlow = (x: number, y: number) => ({ x: x / zoom, y: y / zoom })
    const a = toFlow(pinned, 32)
    const b = toFlow(1440, 864 - 52)
    const bounds: Box = { x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y }
    const center = toFlow(720, 432)
    const boxes: Box[] = [{ x: center.x - node.w / 2, y: center.y - node.h / 2, ...node }]
    for (let i = 0; i < 4; i++) {
      const c = emptySpotCenter(boxes, bounds, center, node)
      const at = { x: c.x - node.w / 2, y: c.y - node.h / 2 }
      for (const prev of boxes) {
        expect(Math.abs(prev.x - at.x) >= CASCADE_STEP || Math.abs(prev.y - at.y) >= CASCADE_STEP).toBe(true)
      }
      boxes.push({ ...at, ...node })
    }
  })

  it('without a view it is the old unbounded search, in centre terms', () => {
    const box: Box = { x: -50, y: -50, w: 100, h: 100 }
    const c = emptySpotCenter([box], undefined, { x: 0, y: 0 }, size)
    expect(overlaps(tl(c), box)).toBe(false)
  })
})
