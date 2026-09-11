import { describe, it, expect } from 'vitest'
import { getViewportForBounds } from '@xyflow/system'
import {
  FIT_NODE_OPTIONS,
  absolutePosition,
  isMaximized,
  isMeasured,
  nodeFitRect,
  viewportForRect
} from './nodeFocus'
import type { FocusableNode } from './nodeFocus'
import { NODE_MAXIMIZE_MARGIN_PX } from './nodeMaximize'

const term = (over: Partial<FocusableNode> = {}): FocusableNode => ({
  id: 'n1',
  position: { x: 4000, y: 3000 },
  width: 600,
  height: 400,
  ...over
})

describe('absolutePosition', () => {
  it('returns the position of a top-level node unchanged', () => {
    expect(absolutePosition(term(), [term()])).toEqual({ x: 4000, y: 3000 })
  })

  it('adds the group origin for a child (what node PLACEMENT needs)', () => {
    // The regression this guards: Duplicate / Branch / Transfer positioned the new node from the
    // source's raw `position`, which for a grouped node is relative to its frame — so a copy made
    // top-level landed the group's own x/y away from the node it came from.
    const group: FocusableNode = { id: 'g', position: { x: 5000, y: 200 } }
    const child = term({ id: 'c', position: { x: 50, y: 60 }, parentId: 'g' })
    expect(absolutePosition(child, [group, child])).toEqual({ x: 5050, y: 260 })
  })

  it('answers even when the node has no size at all', () => {
    const n: FocusableNode = { id: 'x', position: { x: 12, y: 34 } }
    expect(absolutePosition(n, [n])).toEqual({ x: 12, y: 34 })
    expect(nodeFitRect(n, [n])).toBeNull()
  })

  it('stops on a parent cycle instead of looping', () => {
    const a: FocusableNode = { id: 'a', position: { x: 10, y: 10 }, parentId: 'b' }
    const b: FocusableNode = { id: 'b', position: { x: 20, y: 20 }, parentId: 'a' }
    expect(absolutePosition(a, [a, b])).toEqual({ x: 30, y: 30 })
  })
})

describe('nodeFitRect', () => {
  it('reads the persisted size of a node React Flow has not measured yet', () => {
    // The regression this guards: a node loaded a tick ago has NO `measured` — and React
    // Flow's own fitView drops such nodes, collapsing its bounds to the canvas origin.
    expect(nodeFitRect(term(), [term()])).toEqual({ x: 4000, y: 3000, width: 600, height: 400 })
  })

  it('prefers the measured size once React Flow has one (a live-resized terminal)', () => {
    const n = term({ measured: { width: 640, height: 512 } })
    expect(nodeFitRect(n, [n])).toEqual({ x: 4000, y: 3000, width: 640, height: 512 })
  })

  it('resolves a grouped node to its ABSOLUTE position', () => {
    const group: FocusableNode = {
      id: 'g',
      position: { x: 5000, y: 200 },
      width: 1400,
      height: 900
    }
    const child = term({ id: 'c', position: { x: 50, y: 60 }, parentId: 'g' })
    expect(nodeFitRect(child, [group, child])).toEqual({
      x: 5050,
      y: 260,
      width: 600,
      height: 400
    })
  })

  it('resolves a nested group chain', () => {
    const outer: FocusableNode = { id: 'o', position: { x: 1000, y: 1000 }, width: 100, height: 100 }
    const inner: FocusableNode = {
      id: 'i',
      position: { x: 100, y: 200 },
      width: 100,
      height: 100,
      parentId: 'o'
    }
    const child = term({ id: 'c', position: { x: 10, y: 20 }, parentId: 'i' })
    expect(nodeFitRect(child, [outer, inner, child])).toMatchObject({ x: 1110, y: 1220 })
  })

  it('survives a broken parent chain (missing parent, self-parent, cycle)', () => {
    const orphan = term({ parentId: 'gone' })
    expect(nodeFitRect(orphan, [orphan])).toMatchObject({ x: 4000, y: 3000 })

    const selfish = term({ id: 's', parentId: 's' })
    expect(nodeFitRect(selfish, [selfish])).toMatchObject({ x: 4000, y: 3000 })

    const a: FocusableNode = { id: 'a', position: { x: 1, y: 1 }, width: 10, height: 10, parentId: 'b' }
    const b: FocusableNode = { id: 'b', position: { x: 2, y: 2 }, width: 10, height: 10, parentId: 'a' }
    expect(nodeFitRect(a, [a, b])).not.toBeNull()
  })

  it('falls back to the style size, then gives up rather than guessing', () => {
    const styled: FocusableNode = {
      id: 'n',
      position: { x: 10, y: 20 },
      style: { width: 300, height: 150 }
    }
    expect(nodeFitRect(styled, [styled])).toEqual({ x: 10, y: 20, width: 300, height: 150 })

    const sizeless: FocusableNode = { id: 'n', position: { x: 10, y: 20 } }
    expect(nodeFitRect(sizeless, [sizeless])).toBeNull()
    // A zero-size node would produce the very origin jump we are fixing.
    expect(nodeFitRect({ id: 'n', position: { x: 5, y: 5 }, width: 0, height: 0 }, [])).toBeNull()
  })
})

describe('viewportForRect', () => {
  it('centres the node in the container instead of the canvas origin', () => {
    const vp = viewportForRect({ x: 4000, y: 3000, width: 600, height: 400 }, 1280, 900)
    // Same maths React Flow's fitView would have used for a MEASURED node.
    expect(vp).toEqual(
      getViewportForBounds(
        { x: 4000, y: 3000, width: 600, height: 400 },
        1280,
        900,
        FIT_NODE_OPTIONS.minZoom,
        FIT_NODE_OPTIONS.maxZoom,
        FIT_NODE_OPTIONS.padding
      )
    )
    // The node's centre lands in the middle of the container…
    expect(vp!.x + 4300 * vp!.zoom).toBeCloseTo(640, 0)
    expect(vp!.y + 3200 * vp!.zoom).toBeCloseTo(450, 0)
    // …which is emphatically NOT where an empty fit-set puts it (the bug: 640/450 at maxZoom,
    // i.e. the canvas origin parked in the middle of the screen).
    expect(vp!.x).not.toBeCloseTo(640, 0)
  })

  it('clamps the zoom for tiny and huge nodes', () => {
    expect(viewportForRect({ x: 0, y: 0, width: 20, height: 20 }, 1280, 900)!.zoom).toBe(
      FIT_NODE_OPTIONS.maxZoom
    )
    expect(viewportForRect({ x: 0, y: 0, width: 40000, height: 40000 }, 1280, 900)!.zoom).toBe(
      FIT_NODE_OPTIONS.minZoom
    )
  })

  it('refuses to compute against a container it cannot size', () => {
    expect(viewportForRect({ x: 0, y: 0, width: 600, height: 400 }, 0, 0)).toBeNull()
  })
})

describe('viewportForRect — the framing "go to node" applies', () => {
  const rect = { x: 5000, y: 4000, width: 600, height: 400 }

  it('centres the node in the pane, whatever chrome floats over it', () => {
    // Twice-reported regression: framing against the chrome-free rectangle — centred in it, or
    // centred in the pane and then nudged clear of it — pushes the node right by most of its width,
    // because the sessions sidebar is a 300px OVERLAY and it is open exactly when this is used.
    // "Go to node" puts the node where the eye is; the free-rect solve belongs to fitAll.
    const wide = viewportForRect(rect, 3440, 1400)!
    expect(wide.x + 5300 * wide.zoom).toBeCloseTo(1720, 0)
    expect(wide.y + 4200 * wide.zoom).toBeCloseTo(700, 0)
    const laptop = viewportForRect(rect, 1440, 900)!
    expect(laptop.x + 5300 * laptop.zoom).toBeCloseTo(720, 0)
    expect(laptop.y + 4200 * laptop.zoom).toBeCloseTo(450, 0)
  })

  it('keeps a given zoom and only pans (settings.focusZoomToNode off)', () => {
    // The point of the option: a user who settled on a zoom level loses their sense of place when
    // a jump also rescales the canvas. The node is still centred.
    const vp = viewportForRect(rect, 1440, 900, 0.5)!
    expect(vp.zoom).toBe(0.5)
    expect(vp.x + 5300 * 0.5).toBeCloseTo(720, 0)
    expect(vp.y + 4200 * 0.5).toBeCloseTo(450, 0)
  })

  it('passes an out-of-framing-range zoom through — it is one the canvas already shows', () => {
    // Re-clamping to FIT_NODE_OPTIONS would rescale the very view this option exists to leave
    // alone; the canvas's own limits already bound what getZoom() can return.
    expect(viewportForRect(rect, 1440, 900, 1.9)!.zoom).toBe(1.9)
    expect(viewportForRect(rect, 1440, 900, 0.1)!.zoom).toBe(0.1)
    expect(viewportForRect(rect, 1440, 900, 0)).toBeNull()
  })
})

describe('isMeasured', () => {
  it('reads React Flow measurements from either node shape, and tolerates a missing node', () => {
    expect(isMeasured({ measured: { width: 600, height: 400 } })).toBe(true)
    // A freshly deserialized node: sized, but not yet measured — fitView would DROP it.
    expect(isMeasured(term())).toBe(false)
    expect(isMeasured({ measured: { width: 600 } })).toBe(false)
    expect(isMeasured({ measured: { width: 0, height: 0 } })).toBe(false)
    expect(isMeasured(undefined)).toBe(false)
  })
})

describe('viewportForRect — the maximized exception (issue #743)', () => {
  /**
   * The reporter's controlled measurement, reproduced as arithmetic. macOS, signed v0.3.5,
   * `focusZoomToNode` OFF (so the zoom is held and cannot confound it), sessions sidebar pinned,
   * one node, maximized. Only the CAMERA moved across "go to another node and back": the node's
   * position, size and the zoom were byte-identical before and after.
   */
  const PANE_W = 1710
  const ZOOM = 0.7345
  const INSETS = { left: 322, right: 0 }
  const rect = { x: -68.9, y: 0, width: 1824, height: 1261 }
  /** Where the node's left edge lands on screen for a given viewport. */
  const leftEdge = (vp: { x: number }) => vp.x + rect.x * ZOOM

  it('reproduces the reported drift when the framing ignores the pinned inset', () => {
    // 1824 × 0.7345 = 1339.8 rendered px; (1710 - 1339.8) / 2 = 185.1 — centred in the WHOLE pane,
    // exactly as measured. Maximize had put it at 346.0, so the camera moved 160.9 px, which is
    // 322 / 2: half the left inset, what centring a free-area-wide object in the full pane gives.
    const vp = viewportForRect(rect, PANE_W, 900, ZOOM)!
    expect(leftEdge(vp)).toBeCloseTo(185.1, 0)
    expect(leftEdge(viewportForRect(rect, PANE_W, 900, ZOOM, INSETS)!) - leftEdge(vp)).toBeCloseTo(
      160.9,
      0
    )
  })

  it('frames a maximized node exactly where maximizeTargetRect placed it', () => {
    // maximize's own origin is `marginPx + insets.left` = 24 + 322 = 346. The node is the free
    // area minus two margins, so centring it in the free area reproduces that origin — which is
    // the property that makes this a fix rather than a different opinion about where to put it.
    const vp = viewportForRect(rect, PANE_W, 900, ZOOM, INSETS)!
    expect(leftEdge(vp)).toBeCloseTo(NODE_MAXIMIZE_MARGIN_PX + INSETS.left, 0)
    // 136.9 px of the node sat behind the sidebar before; none does now.
    expect(leftEdge(vp)).toBeGreaterThanOrEqual(INSETS.left)
  })

  it('is a mathematical no-op when no panel is pinned', () => {
    const bare = viewportForRect(rect, PANE_W, 900, ZOOM)!
    const zero = viewportForRect(rect, PANE_W, 900, ZOOM, { left: 0, right: 0 })!
    expect(zero).toEqual(bare)
    expect(viewportForRect(rect, PANE_W, 900, undefined, { left: 0, right: 0 })).toEqual(
      viewportForRect(rect, PANE_W, 900)
    )
  })

  it('insets the zoom-to-fit path too, without changing the unpinned answer', () => {
    // `focusZoomToNode` ON rescales as well. The rectangle question is the same one, so the
    // maximized node is fitted INSIDE the free area rather than the pane — its whole width is
    // clear of the panel, where centring in the pane left part of it underneath.
    const fitted = viewportForRect(rect, PANE_W, 900, undefined, INSETS)!
    expect(fitted.x + rect.x * fitted.zoom).toBeGreaterThanOrEqual(INSETS.left)
    expect(fitted.x + (rect.x + rect.width) * fitted.zoom).toBeLessThanOrEqual(PANE_W)
  })

  it('falls back to the whole pane when the panels are wider than it', () => {
    // Not a rectangle anything can be centred in — solving against a negative width would put the
    // camera somewhere arbitrary. Standing on the old answer is the honest degrade.
    const narrow = viewportForRect(rect, 300, 900, ZOOM, { left: 322, right: 0 })!
    expect(narrow).toEqual(viewportForRect(rect, 300, 900, ZOOM))
  })

  it('refuses a container it cannot size, insets or not', () => {
    expect(viewportForRect(rect, 0, 0, ZOOM, INSETS)).toBeNull()
    expect(viewportForRect(rect, PANE_W, 900, 0, INSETS)).toBeNull()
  })
})

describe('isMaximized', () => {
  it('keys on premaxRect — the flag maximize itself writes and restore clears', () => {
    expect(isMaximized({ data: { premaxRect: { x: 0, y: 0, width: 10, height: 10 } } })).toBe(true)
    expect(isMaximized({ data: {} })).toBe(false)
    expect(isMaximized({})).toBe(false)
    expect(isMaximized(null)).toBe(false)
    expect(isMaximized(undefined)).toBe(false)
  })
})
