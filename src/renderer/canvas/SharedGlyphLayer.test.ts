import { adoptUserNodes } from '@xyflow/system'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  GlyphGridRendererAddonCore,
  type CursorBlinkPhaseTarget,
  type CursorBlinkSeam
} from '../glyphgrid/addon'
// The addon's fakes, shared with `glyphgrid/addon.test.ts`. A plain module, not a `.test.ts`:
// importing a test file makes vitest collect its whole suite a second time under this one.
import { fakeTerm, recordingAtlas, recordingHandle } from '../glyphgrid/addon-fakes'
import { FLAG_CURSOR, readCell } from '../glyphgrid/cells'
import type { GridHandle } from '../glyphgrid/engine'
import { createFrameLoop, type FrameLoop, type FrameLoopHost } from '../glyphgrid/frame-driver'
import {
  createBoardFrameGate,
  createCellRebuildGuard,
  createContextLossPolicy,
  createCursorBlinkClock,
  createPixelRatioWatcher,
  cursorBlinkTarget,
  setCursorBlinkTarget,
  subscribeCursorBlinkRestart,
  subscribeCursorBlinkTarget,
  CURSOR_BLINK_INTERVAL_MS,
  failSharedGlyph,
  getSharedGlyphContext,
  effectiveStackOrder,
  flushOpaqueNodeIds,
  gestureTerminalIds,
  hasActiveGesture,
  idsFromOrderSig,
  installAtlasResetLog,
  nodeIsOpaque,
  nodeOrderSig,
  nodeStackZ,
  nodeZFor,
  cellsDisagree,
  opaqueNodeIds,
  pixelRatioChanged,
  primeOpaqueNodeIds,
  releaseCursorBlinkTarget,
  restartCursorBlink,
  setNodeZOrder,
  setOpaqueNodeIds,
  setSharedGlyphCamera,
  sharedGlyphActive,
  sharedGlyphAvailable,
  subscribeNodeZOrder,
  subscribeOpaqueSet,
  syncAtlasPixelRatio,
  useSharedGlyph,
  RESTORE_COOLDOWN_MS,
  type AtlasResetSource,
  type CursorBlinkClock,
  type CursorBlinkTarget,
  type PixelRatioWatchHost,
  type StackedNode,
  type StackOrderNode
} from './SharedGlyphLayer'

// Only the PURE parts are unit-testable here: there is no WebGL2, no OffscreenCanvas and no
// layout in the node test environment, so the component, the rAF driver and the GL singleton are
// device-verified (T6 checklist). What IS covered is everything the other tasks build on: the
// order signature Canvas derives, the store transitions T5/T6 read, and the z-order map + its
// notification seam.

beforeEach(() => {
  // The store and the z map are module singletons; reset them explicitly so the tests are
  // order-independent.
  useSharedGlyph.setState({ enabled: false, generation: 0, failed: false })
  setNodeZOrder([])
  setOpaqueNodeIds([])
})

describe('nodeOrderSig', () => {
  it('joins TERMINAL node ids in array order', () => {
    const sig = nodeOrderSig([
      { id: 'a', type: 'terminal' },
      { id: 'b', type: 'terminal' }
    ])
    expect(idsFromOrderSig(sig)).toEqual(['a', 'b'])
  })

  it('ignores every other node kind — only terminals own a grid', () => {
    const sig = nodeOrderSig([
      { id: 's1', type: 'sticky' },
      { id: 't1', type: 'terminal' },
      { id: 'g1', type: 'group' },
      { id: 't2', type: 'terminal' },
      { id: 'sub', type: 'subagent' }
    ])
    expect(idsFromOrderSig(sig)).toEqual(['t1', 't2'])
  })

  it('is order sensitive — a reorder must produce a different signature', () => {
    const a = nodeOrderSig([
      { id: 'x', type: 'terminal' },
      { id: 'y', type: 'terminal' }
    ])
    const b = nodeOrderSig([
      { id: 'y', type: 'terminal' },
      { id: 'x', type: 'terminal' }
    ])
    expect(a).not.toBe(b)
  })

  it('elevates a SELECTED terminal above the unselected ones, wherever it sits in the array', () => {
    // React Flow's elevateNodesOnSelect (default on, and now on in EVERY renderer mode) lifts the
    // selected node's DOM to z 1000; the grids mirror it so canvas and DOM tell the same story.
    // Round 4 removed the mirroring and turned the prop off instead — rejected in round 5, because
    // that takes away "selecting/dragging brings a node to the front". The overlap it was trying to
    // fix is handled by `opaqueNodeIds` (a stacked terminal leaves the canvas entirely) instead.
    const sig = nodeOrderSig([
      { id: 'a', type: 'terminal' },
      { id: 'b', type: 'terminal', selected: true },
      { id: 'c', type: 'terminal' }
    ])
    expect(idsFromOrderSig(sig)).toEqual(['a', 'c', 'b'])
  })

  it('keeps selected nodes in their own relative order (a multi-select is stable)', () => {
    const sig = nodeOrderSig([
      { id: 'a', type: 'terminal', selected: true },
      { id: 'b', type: 'terminal' },
      { id: 'c', type: 'terminal', selected: true }
    ])
    expect(idsFromOrderSig(sig)).toEqual(['b', 'a', 'c'])
  })

  it('an all-selected canvas keeps plain array order', () => {
    const sig = nodeOrderSig([
      { id: 'a', type: 'terminal', selected: true },
      { id: 'b', type: 'terminal', selected: true }
    ])
    expect(idsFromOrderSig(sig)).toEqual(['a', 'b'])
  })

  it('a selected NON-terminal does not reorder the terminals', () => {
    // The elevation is applied over ALL nodes (that is what the DOM does) and terminals are
    // filtered out of the result afterwards — so a selected sticky must be invisible here.
    const sig = nodeOrderSig([
      { id: 't1', type: 'terminal' },
      { id: 's1', type: 'sticky', selected: true },
      { id: 't2', type: 'terminal' }
    ])
    expect(idsFromOrderSig(sig)).toEqual(['t1', 't2'])
  })

  it('puts a GROUPED terminal above an ungrouped one that follows it in the array', () => {
    // A child gets `parentZ + 1` = 1 while every ungrouped node is 0, so the grouped terminal is on
    // top regardless of array position. (The FRAME itself is 0 — tied with the ungrouped node, not
    // above it; that is the part the 'auto'-branch model got wrong.)
    const sig = nodeOrderSig([
      { id: 'g', type: 'group' },
      { id: 'inside', type: 'terminal', parentId: 'g' },
      { id: 'outside', type: 'terminal' }
    ])
    expect(idsFromOrderSig(sig)).toEqual(['outside', 'inside'])
  })

  it('a SELECTED frame carries its children above a selected ungrouped terminal', () => {
    const sig = nodeOrderSig([
      { id: 'g', type: 'group', selected: true },
      { id: 'inside', type: 'terminal', parentId: 'g' },
      { id: 'outside', type: 'terminal', selected: true }
    ])
    expect(idsFromOrderSig(sig)).toEqual(['outside', 'inside'])
  })

  it('an untyped node is not a terminal (React Flow defaults type to "default")', () => {
    expect(nodeOrderSig([{ id: 'a' }])).toBe('')
  })

  it('round-trips the empty canvas as an EMPTY list, not a one-element list of ""', () => {
    const sig = nodeOrderSig([])
    expect(sig).toBe('')
    expect(idsFromOrderSig(sig)).toEqual([])
  })
})

describe('useSharedGlyph store', () => {
  // The failure funnel warns by design; silence it here and assert the once-ness explicitly.
  let warn: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    warn.mockRestore()
  })

  it('starts off, ungenerated and unfailed — the default-mode user must see nothing', () => {
    expect(useSharedGlyph.getState()).toMatchObject({ enabled: false, generation: 0, failed: false })
    expect(sharedGlyphActive()).toBe(false)
  })

  it('bumpGeneration increments (the re-register signal)', () => {
    useSharedGlyph.getState().bumpGeneration()
    useSharedGlyph.getState().bumpGeneration()
    expect(useSharedGlyph.getState().generation).toBe(2)
  })

  it('markFailed flips failed AND bumps the generation, so one subscription wakes every node', () => {
    useSharedGlyph.getState().markFailed()
    expect(useSharedGlyph.getState().failed).toBe(true)
    expect(useSharedGlyph.getState().generation).toBe(1)
  })

  it('markFailed is idempotent — a second failure must not re-notify or re-log', () => {
    useSharedGlyph.getState().markFailed()
    useSharedGlyph.getState().markFailed()
    expect(useSharedGlyph.getState().generation).toBe(1)
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('markFailed goes through the SAME funnel as failSharedGlyph (no half-failed state)', () => {
    // The store action must not be a shortcut that flips the flag while the GPU context stays
    // held: it delegates, so the two entries are interchangeable and the second one is a no-op.
    failSharedGlyph('test')
    useSharedGlyph.getState().markFailed()
    expect(useSharedGlyph.getState()).toMatchObject({ failed: true, generation: 1 })
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('disabling the mode bumps the generation — a disposed context must be announced', () => {
    // setEnabled(false) drops the context; every registered grid is now holding an inert handle
    // and would stay blank until it remounted without this signal.
    useSharedGlyph.getState().setEnabled(true)
    useSharedGlyph.getState().setEnabled(false)
    expect(useSharedGlyph.getState().generation).toBe(2)
    // Change-gated: a repeated disable disposes nothing, so it announces nothing.
    useSharedGlyph.getState().setEnabled(false)
    expect(useSharedGlyph.getState().generation).toBe(2)
  })

  it('ENABLING the mode bumps the generation too — already-mounted terminals must join', () => {
    // The user flips the setting to Shared with a canvas full of live terminals. Each of them
    // subscribes to `generation` and re-evaluates its participation on a bump; without one here
    // they would keep painting through xterm's own renderer until they remounted (a project
    // switch), and the setting would look like it did nothing. The bump is the ONE signal in this
    // seam, so enabling rides it exactly like disposal does.
    expect(useSharedGlyph.getState().generation).toBe(0)
    useSharedGlyph.getState().setEnabled(true)
    expect(useSharedGlyph.getState()).toMatchObject({ enabled: true, generation: 1 })
  })

  it('an enable bump carries the NEW enabled flag in the SAME notification', () => {
    // A subscriber's first move is to ask `sharedGlyphActive()`. If `enabled` were written in a
    // separate set() from the generation, one of the two notifications would carry a state that
    // disagrees with the other and a node would decide on the stale half.
    const seen: { enabled: boolean; generation: number }[] = []
    const unsub = useSharedGlyph.subscribe((s) =>
      seen.push({ enabled: s.enabled, generation: s.generation })
    )
    useSharedGlyph.getState().setEnabled(true)
    unsub()
    expect(seen).toEqual([{ enabled: true, generation: 1 }])
  })

  it('a repeated enable is change-gated — no bump, no re-registration storm', () => {
    useSharedGlyph.getState().setEnabled(true)
    useSharedGlyph.getState().setEnabled(true)
    expect(useSharedGlyph.getState().generation).toBe(1)
  })

  it('sharedGlyphActive is enabled AND not failed', () => {
    useSharedGlyph.getState().setEnabled(true)
    expect(sharedGlyphActive()).toBe(true)
    useSharedGlyph.getState().markFailed()
    expect(sharedGlyphActive()).toBe(false)
  })

  it('setEnabled is change-gated and survives a disable/enable round trip', () => {
    // Disabling also drops the GPU context; with none created (node env) that is a no-op, and it
    // must not throw or disturb the flags.
    useSharedGlyph.getState().setEnabled(true)
    useSharedGlyph.getState().setEnabled(true)
    expect(() => useSharedGlyph.getState().setEnabled(false)).not.toThrow()
    expect(sharedGlyphActive()).toBe(false)
    useSharedGlyph.getState().setEnabled(true)
    expect(sharedGlyphActive()).toBe(true)
  })

  it('setEnabled(false) after a failure keeps the session failed (no silent retry)', () => {
    useSharedGlyph.getState().setEnabled(true)
    useSharedGlyph.getState().markFailed()
    useSharedGlyph.getState().setEnabled(false)
    useSharedGlyph.getState().setEnabled(true)
    expect(useSharedGlyph.getState().failed).toBe(true)
    expect(sharedGlyphActive()).toBe(false)
  })
})

describe('setNodeZOrder', () => {
  it('maps each id to its index — array order IS the paint order', () => {
    setNodeZOrder(['a', 'b', 'c'])
    expect(nodeZFor('a')).toBe(0)
    expect(nodeZFor('b')).toBe(1)
    expect(nodeZFor('c')).toBe(2)
  })

  it('an id it has never seen lands on TOP, not at 0', () => {
    // A node created between two order pushes is appended last on the canvas, so "topmost" is the
    // answer that matches what the user sees; 0 would flash it under every other terminal.
    setNodeZOrder(['a', 'b'])
    expect(nodeZFor('fresh')).toBe(2)
  })

  it('notifies subscribers when the order changes', () => {
    const seen = vi.fn()
    const unsub = subscribeNodeZOrder(seen)
    setNodeZOrder(['a'])
    setNodeZOrder(['a', 'b'])
    expect(seen).toHaveBeenCalledTimes(2)
    unsub()
  })

  it('does NOT notify when the same order is pushed again', () => {
    setNodeZOrder(['a', 'b'])
    const seen = vi.fn()
    const unsub = subscribeNodeZOrder(seen)
    setNodeZOrder(['a', 'b'])
    expect(seen).not.toHaveBeenCalled()
    unsub()
  })

  it('stops notifying after unsubscribe', () => {
    const seen = vi.fn()
    subscribeNodeZOrder(seen)()
    setNodeZOrder(['z'])
    expect(seen).not.toHaveBeenCalled()
  })

  it('an emptied canvas clears the map', () => {
    setNodeZOrder(['a', 'b'])
    setNodeZOrder([])
    expect(nodeZFor('a')).toBe(0)
  })
})

describe('nodeStackZ (React Flow z, reproduced)', () => {
  // Every number below was READ OFF the real `adoptUserNodes` from @xyflow/system, called with what
  // @xyflow/react's store passes it: `{ elevateNodesOnSelect: true, zIndexMode: 'basic' }`. 'basic'
  // is the default in BOTH `getInitialState` and the <ReactFlow> component, and nothing in src/
  // passes the prop. That detail decides the load-bearing case: the 'auto' branch adds a
  // ROOT_PARENT_Z_INCREMENT band that would put a populated frame at 10 instead of 0, reversing
  // frame-vs-ungrouped — and a previous cut of this file shipped exactly that mistake.

  it('is 0 for a plain node and 1000 for a selected one', () => {
    const z = nodeStackZ([{ id: 'a' }, { id: 'b', selected: true }])
    expect(z.get('a')).toBe(0)
    expect(z.get('b')).toBe(1000)
  })

  it('leaves a group FRAME at 0 — tied with every ungrouped node — and lifts its child to 1', () => {
    // A frame does NOT outrank ungrouped nodes. Frames merely sort first in the array, so an
    // ungrouped node overlapping one paints ON TOP of it (and must therefore go opaque).
    const z = nodeStackZ([{ id: 'g' }, { id: 'inside', parentId: 'g' }, { id: 'outside' }])
    expect(z.get('g')).toBe(0)
    expect(z.get('inside')).toBe(1)
    expect(z.get('outside')).toBe(0)
  })

  it('does not band root frames — two frames tie, and so do their children', () => {
    const z = nodeStackZ([
      { id: 'g1' },
      { id: 'g2' },
      { id: 'c1', parentId: 'g1' },
      { id: 'c2', parentId: 'g2' }
    ])
    expect(z.get('g1')).toBe(0)
    expect(z.get('g2')).toBe(0)
    expect(z.get('c1')).toBe(1)
    expect(z.get('c2')).toBe(1)
  })

  it('a selected frame carries its children to 1001, above a selected ungrouped node', () => {
    const z = nodeStackZ([
      { id: 'g', selected: true },
      { id: 'c', parentId: 'g' },
      { id: 'outside', selected: true }
    ])
    expect(z.get('g')).toBe(1000)
    expect(z.get('c')).toBe(1001)
    expect(z.get('outside')).toBe(1000)
  })

  it('a selected CHILD of an unselected frame wins on its own z', () => {
    // childZ 1000 > parentZ 0, so the child keeps 1000 rather than parentZ + 1.
    const z = nodeStackZ([{ id: 'g' }, { id: 'c', parentId: 'g', selected: true }])
    expect(z.get('c')).toBe(1000)
  })

  it('nested frames stack one per level', () => {
    const z = nodeStackZ([
      { id: 'outer' },
      { id: 'inner', parentId: 'outer' },
      { id: 't', parentId: 'inner' }
    ])
    expect(z.get('outer')).toBe(0)
    expect(z.get('inner')).toBe(1)
    expect(z.get('t')).toBe(2)
  })

  it('ignores a child whose parent is missing or comes later (React Flow warns and gives up)', () => {
    const z = nodeStackZ([{ id: 'c', parentId: 'g' }, { id: 'g' }])
    expect(z.get('c')).toBe(0)
  })

  it('survives a parentId cycle', () => {
    expect(() => nodeStackZ([{ id: 'a', parentId: 'b' }, { id: 'b', parentId: 'a' }])).not.toThrow()
  })

  // The cases above are readable; THIS is the one that keeps them honest. `nodeStackZ` is
  // transcribed from someone else's algorithm, and transcription is how the last two bugs got in —
  // the first modelled selection only, the second modelled the `'auto'` branch of a library that
  // defaults to `'basic'`. Reading the source more carefully is not a fix for that class of
  // mistake; RUNNING it is. So every shape below goes through the real `adoptUserNodes`, called
  // exactly as `@xyflow/react`'s store calls it, and the answers must be identical. It needs no
  // DOM, which is why it can live in this suite at all.
  //
  // If this ever fails after a React Flow bump, the LIBRARY moved: re-derive `nodeStackZ` from the
  // new behaviour rather than pinning the old numbers.
  describe('agrees with the real adoptUserNodes', () => {
    const rf = (nodes: readonly StackOrderNode[]): Record<string, number> => {
      const lookup = new Map<string, { internals: { z: number } }>()
      adoptUserNodes(
        nodes.map((n) => ({
          ...n,
          position: { x: 0, y: 0 },
          data: {},
          measured: { width: 10, height: 10 }
        })) as never,
        lookup as never,
        new Map(),
        // The store's own options (index.mjs `setNodes`): everything else is left at its default,
        // which is where `zIndexMode: 'basic'` comes from.
        { elevateNodesOnSelect: true, checkEquality: true } as never
      )
      const out: Record<string, number> = {}
      for (const [id, n] of lookup) out[id] = n.internals.z
      return out
    }
    const ours = (nodes: readonly StackOrderNode[]): Record<string, number> =>
      Object.fromEntries(nodeStackZ(nodes))

    const shapes: Record<string, StackOrderNode[]> = {
      'flat canvas': [{ id: 'a' }, { id: 'b' }],
      'one selected': [{ id: 'a' }, { id: 'b', selected: true }],
      'frame, child, ungrouped': [{ id: 'g' }, { id: 'inside', parentId: 'g' }, { id: 'outside' }],
      'ungrouped before the frame': [
        { id: 'outside' },
        { id: 'g' },
        { id: 'inside', parentId: 'g' }
      ],
      'two frames': [
        { id: 'g1' },
        { id: 'g2' },
        { id: 'c1', parentId: 'g1' },
        { id: 'c2', parentId: 'g2' }
      ],
      'two frames, children interleaved': [
        { id: 'g1' },
        { id: 'g2' },
        { id: 'c2', parentId: 'g2' },
        { id: 'c1', parentId: 'g1' }
      ],
      'selected frame': [
        { id: 'g', selected: true },
        { id: 'c', parentId: 'g' },
        { id: 'outside', selected: true }
      ],
      'selected child': [{ id: 'g' }, { id: 'c', parentId: 'g', selected: true }],
      'nested frames': [
        { id: 'outer' },
        { id: 'inner', parentId: 'outer' },
        { id: 't', parentId: 'inner' }
      ],
      'nested frames, outer selected': [
        { id: 'outer', selected: true },
        { id: 'inner', parentId: 'outer' },
        { id: 't', parentId: 'inner' }
      ],
      'several children of one frame': [
        { id: 'g' },
        { id: 'c1', parentId: 'g' },
        { id: 'c2', parentId: 'g' },
        { id: 'c3', parentId: 'g' }
      ]
    }

    for (const [name, nodes] of Object.entries(shapes)) {
      it(name, () => {
        expect(ours(nodes)).toEqual(rf(nodes))
      })
    }
  })
})

describe('effectiveStackOrder', () => {
  it('returns the input array itself when every z is 0 (no copy on the common canvas)', () => {
    const nodes = [{ id: 'a' }, { id: 'b' }]
    expect(effectiveStackOrder(nodes)).toBe(nodes)
  })

  it('breaks z ties by array order (a stable sort)', () => {
    const order = effectiveStackOrder([
      { id: 'a' },
      { id: 'b' },
      { id: 'c', selected: true },
      { id: 'd' }
    ])
    expect(order.map((n) => n.id)).toEqual(['a', 'b', 'd', 'c'])
  })
})

describe('opaqueNodeIds', () => {
  /** A 100×100 node at (x, y). Sizes come through `measured` (a live canvas) unless overridden. */
  const at = (
    id: string,
    x: number,
    y: number,
    extra: Partial<StackedNode> = {}
  ): StackedNode => ({
    id,
    type: 'terminal',
    position: { x, y },
    measured: { width: 100, height: 100 },
    ...extra
  })

  it('leaves a terminal that overlaps nothing on the shared canvas', () => {
    expect(opaqueNodeIds([at('a', 0, 0), at('b', 200, 0)])).toEqual([])
  })

  it('marks the UPPER terminal of an overlapping pair, and only it', () => {
    // The lower one may stay on the canvas: the opaque node above hides it natively, which is the
    // asymmetry the whole design rests on.
    expect(opaqueNodeIds([at('low', 0, 0), at('high', 50, 50)])).toEqual(['high'])
  })

  it('a terminal stacked over a NON-terminal node counts too', () => {
    // "Reveals another node" is about any kind — a sticky's text under a transparent body is the
    // same defect as a terminal's.
    const nodes = [at('note', 0, 0, { type: 'sticky' }), at('t', 20, 20)]
    expect(opaqueNodeIds(nodes)).toEqual(['t'])
  })

  it('follows the SELECTION elevation, not raw array order', () => {
    // Selecting the lower node lifts it above its neighbour in the DOM, so it is now the one whose
    // body could reveal something — and the neighbour is free to go back on the canvas.
    const nodes = [at('a', 0, 0, { selected: true }), at('b', 50, 50)]
    expect(opaqueNodeIds(nodes)).toEqual(['a'])
    expect(opaqueNodeIds([at('a', 0, 0), at('b', 50, 50)])).toEqual(['b'])
  })

  it('edge-to-edge nodes are not overlapping', () => {
    // A snapped grid or a tidy row shares boundaries everywhere; treating that as an overlap would
    // send half a neat canvas to the DOM renderer.
    expect(opaqueNodeIds([at('a', 0, 0), at('b', 100, 0)])).toEqual([])
  })

  it('does NOT count a node\'s own group frame as something beneath it', () => {
    // A grouped terminal is inside its frame's rect by construction. Counting it would put every
    // grouped terminal on the DOM renderer permanently.
    const group: StackedNode = {
      id: 'g',
      type: 'group',
      position: { x: 0, y: 0 },
      measured: { width: 400, height: 400 }
    }
    const child = at('t', 20, 20, { parentId: 'g' })
    expect(opaqueNodeIds([group, child])).toEqual([])
  })

  it('counts an UNRELATED group frame beneath it', () => {
    const group: StackedNode = {
      id: 'g',
      type: 'group',
      position: { x: 0, y: 0 },
      measured: { width: 400, height: 400 }
    }
    expect(opaqueNodeIds([group, at('t', 20, 20)])).toEqual(['t'])
  })

  it('resolves a grouped node\'s position through its parent chain', () => {
    // The child's own `position` is frame-relative: read raw it would sit at (10,10) and miss the
    // terminal it actually covers at (510,510).
    const group: StackedNode = {
      id: 'g',
      type: 'group',
      position: { x: 500, y: 500 },
      measured: { width: 400, height: 400 }
    }
    // `out` is placed BEFORE the frame so it is beneath everything and cannot be marked itself —
    // the assertion is about the child's resolved position and nothing else.
    const outside = at('out', 510, 510)
    const child = at('t', 10, 10, { parentId: 'g' })
    expect(opaqueNodeIds([outside, group, child])).toEqual(['t'])
  })

  it('ignores collapsed and ⌘M terminals — they hold no grid either way', () => {
    expect(opaqueNodeIds([at('a', 0, 0), at('b', 50, 50, { data: { collapsed: true } })])).toEqual(
      []
    )
    expect(opaqueNodeIds([at('a', 0, 0), at('b', 50, 50, { data: { mdMode: true } })])).toEqual([])
  })

  it('a collapsed terminal is still something to be stacked OVER', () => {
    // It is an opaque header strip on screen; covering it is a real overlap.
    const nodes = [at('c', 0, 0, { data: { collapsed: true } }), at('t', 50, 50)]
    expect(opaqueNodeIds(nodes)).toEqual(['t'])
  })

  it('falls back to width/height when React Flow has not measured the node yet', () => {
    const a: StackedNode = { id: 'a', type: 'terminal', position: { x: 0, y: 0 }, width: 100, height: 100 }
    const b: StackedNode = { id: 'b', type: 'terminal', position: { x: 50, y: 50 }, width: 100, height: 100 }
    expect(opaqueNodeIds([a, b])).toEqual(['b'])
  })

  it('a node of unknowable size contributes nothing, in either direction', () => {
    const sizeless: StackedNode = { id: 'x', type: 'terminal', position: { x: 0, y: 0 } }
    expect(opaqueNodeIds([sizeless, at('t', 10, 10)])).toEqual([])
    expect(opaqueNodeIds([at('t', 10, 10), sizeless])).toEqual([])
  })

  it('survives a parentId cycle instead of spinning', () => {
    const a = at('a', 0, 0, { parentId: 'b' })
    const b = at('b', 0, 0, { parentId: 'a' })
    expect(() => opaqueNodeIds([a, b])).not.toThrow()
  })

  it('reports every stacked terminal on a pile, not just the top one', () => {
    expect(opaqueNodeIds([at('a', 0, 0), at('b', 20, 20), at('c', 40, 40)])).toEqual(['b', 'c'])
  })

  it('marks a terminal lying on a POPULATED group frame — the frame is not above it', () => {
    // The case both wrong z models broke, from opposite sides. A frame is z 0, tied with every
    // ungrouped node, and frames sort FIRST in the array — so `outside` paints on top of the frame
    // and must be opaque, or the frame's dashed border and its label pill (DOM, above any canvas
    // plate) show straight through the terminal's transparent body. The banded 'auto' model gave
    // the frame z 10, concluded the terminal was underneath it, and left it transparent.
    // `inside` is placed clear of `outside` so this asserts only the frame relationship.
    const group: StackedNode = {
      id: 'g',
      type: 'group',
      position: { x: 0, y: 0 },
      measured: { width: 400, height: 400 }
    }
    const inside = at('inside', 300, 300, { parentId: 'g' })
    const outside = at('outside', 10, 10)
    expect(opaqueNodeIds([group, inside, outside])).toEqual(['outside'])
  })

  it('marks BOTH when a grouped and an ungrouped terminal overlap each other on a frame', () => {
    // z: frame 0, outside 0 (later in the array ⇒ above the frame), inside 1 (above both). So
    // `outside` is opaque for lying on the frame, and `inside` for lying on `outside`; the frame
    // is skipped for `inside` because it is its ancestor.
    const group: StackedNode = {
      id: 'g',
      type: 'group',
      position: { x: 0, y: 0 },
      measured: { width: 400, height: 400 }
    }
    const inside = at('inside', 20, 20, { parentId: 'g' })
    const outside = at('outside', 60, 60)
    expect(opaqueNodeIds([group, inside, outside])).toEqual(['outside', 'inside'])
  })
})

describe('hasActiveGesture / gestureTerminalIds', () => {
  const node = (id: string, extra: Partial<StackedNode> = {}): StackedNode => ({
    id,
    type: 'terminal',
    position: { x: 0, y: 0 },
    measured: { width: 100, height: 100 },
    ...extra
  })

  it('sees a drag and a RESIZE alike', () => {
    expect(hasActiveGesture([node('a')])).toBe(false)
    expect(hasActiveGesture([node('a', { dragging: true })])).toBe(true)
    expect(hasActiveGesture([node('a', { resizing: true })])).toBe(true)
  })

  it('a gesture on a NON-terminal still freezes (it changes who overlaps whom)', () => {
    expect(hasActiveGesture([node('s', { type: 'sticky', dragging: true })])).toBe(true)
    expect(gestureTerminalIds([node('s', { type: 'sticky', dragging: true })])).toEqual([])
  })

  it('names the dragged terminal itself', () => {
    expect(gestureTerminalIds([node('a', { dragging: true }), node('b')])).toEqual(['a'])
  })

  it('names the CHILDREN of a dragged group frame', () => {
    // React Flow's getDragItems excludes children of a dragged parent, so they never carry
    // `dragging` themselves — without the ancestor walk they stayed transparent all gesture.
    const nodes: StackedNode[] = [
      node('g', { type: 'group', dragging: true }),
      node('c1', { parentId: 'g' }),
      node('c2', { parentId: 'g' }),
      node('far')
    ]
    expect(gestureTerminalIds(nodes)).toEqual(['c1', 'c2'])
  })

  it('walks more than one level of frame', () => {
    const nodes: StackedNode[] = [
      node('outer', { type: 'group', resizing: true }),
      node('inner', { type: 'group', parentId: 'outer' }),
      node('t', { parentId: 'inner' })
    ]
    expect(gestureTerminalIds(nodes)).toEqual(['t'])
  })

  it('survives a parentId cycle', () => {
    const nodes: StackedNode[] = [node('a', { parentId: 'b' }), node('b', { parentId: 'a' })]
    expect(() => gestureTerminalIds(nodes)).not.toThrow()
  })
})

describe('setOpaqueNodeIds', () => {
  it('answers membership', () => {
    setOpaqueNodeIds(['a', 'b'])
    expect(nodeIsOpaque('a')).toBe(true)
    expect(nodeIsOpaque('c')).toBe(false)
  })

  it('notifies subscribers when the set changes', () => {
    const seen = vi.fn()
    const unsub = subscribeOpaqueSet(seen)
    setOpaqueNodeIds(['a'])
    setOpaqueNodeIds(['a', 'b'])
    expect(seen).toHaveBeenCalledTimes(2)
    unsub()
  })

  it('does NOT notify when the same MEMBERSHIP arrives in a different order', () => {
    // This is a set, not a sequence: a node reorder that changes nothing about who overlaps whom
    // must not wake every terminal on the canvas.
    setOpaqueNodeIds(['a', 'b'])
    const seen = vi.fn()
    const unsub = subscribeOpaqueSet(seen)
    setOpaqueNodeIds(['b', 'a'])
    expect(seen).not.toHaveBeenCalled()
    unsub()
  })

  it('does NOT notify when the same set is pushed again', () => {
    setOpaqueNodeIds(['a', 'b'])
    const seen = vi.fn()
    const unsub = subscribeOpaqueSet(seen)
    setOpaqueNodeIds(['a', 'b'])
    expect(seen).not.toHaveBeenCalled()
    unsub()
  })

  it('clears back to empty and notifies once', () => {
    setOpaqueNodeIds(['a'])
    const seen = vi.fn()
    const unsub = subscribeOpaqueSet(seen)
    setOpaqueNodeIds([])
    expect(seen).toHaveBeenCalledTimes(1)
    expect(nodeIsOpaque('a')).toBe(false)
    unsub()
  })

  it('stops notifying after unsubscribe', () => {
    const seen = vi.fn()
    subscribeOpaqueSet(seen)()
    setOpaqueNodeIds(['z'])
    expect(seen).not.toHaveBeenCalled()
  })
})

describe('primeOpaqueNodeIds / flushOpaqueNodeIds', () => {
  it('primes the ANSWER immediately and the NOTIFICATION only on flush', () => {
    // This is the ordering fix: Canvas primes during its own render (a listener's setState there is
    // what React refuses), so a child reads the current answer while rendering, and the
    // notification — needed only by nodes that did not re-render — follows from an effect.
    const seen = vi.fn()
    const unsub = subscribeOpaqueSet(seen)
    primeOpaqueNodeIds(['a'])
    expect(nodeIsOpaque('a')).toBe(true)
    expect(seen).not.toHaveBeenCalled()
    flushOpaqueNodeIds()
    expect(seen).toHaveBeenCalledTimes(1)
    unsub()
  })

  it('returns the signature, so the caller can key an effect on it', () => {
    expect(primeOpaqueNodeIds(['b', 'a'])).toBe(primeOpaqueNodeIds(['a', 'b']))
  })

  it('a flush with nothing pending is free', () => {
    primeOpaqueNodeIds(['a'])
    flushOpaqueNodeIds()
    const seen = vi.fn()
    const unsub = subscribeOpaqueSet(seen)
    flushOpaqueNodeIds()
    flushOpaqueNodeIds()
    expect(seen).not.toHaveBeenCalled()
    unsub()
  })

  it('coalesces several primes into ONE notification', () => {
    const seen = vi.fn()
    const unsub = subscribeOpaqueSet(seen)
    primeOpaqueNodeIds(['a'])
    primeOpaqueNodeIds(['a', 'b'])
    primeOpaqueNodeIds(['c'])
    flushOpaqueNodeIds()
    expect(seen).toHaveBeenCalledTimes(1)
    expect(nodeIsOpaque('c')).toBe(true)
    expect(nodeIsOpaque('a')).toBe(false)
    unsub()
  })
})

describe('graceful degrade without a GPU', () => {
  /** A plausible xterm device cell (13px font at dpr 2): fractional width, integer height. */
  const CELL = { cellW: 15.66, cellH: 31 }
  let warn: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    warn.mockRestore()
  })

  it('getSharedGlyphContext returns null while the shared mode is off — no context is acquired', () => {
    expect(getSharedGlyphContext(CELL)).toBeNull()
  })

  it('returns null (rather than throwing) when WebGL2/OffscreenCanvas are unavailable', () => {
    useSharedGlyph.getState().setEnabled(true)
    expect(getSharedGlyphContext(CELL)).toBeNull()
  })

  it('returns null once the session has failed', () => {
    useSharedGlyph.getState().setEnabled(true)
    useSharedGlyph.getState().markFailed()
    expect(getSharedGlyphContext(CELL)).toBeNull()
  })

  // The atlas rasterizes into xterm's DEVICE cell, and only a live terminal knows it. A caller
  // with no cell to offer (the layer component itself) must therefore adopt an existing context or
  // get null — never build one from guessed metrics, which is the mismatch that made every glyph
  // resample against the quad it is drawn onto.
  it('does not CREATE a context for a caller that supplies no device cell', () => {
    useSharedGlyph.getState().setEnabled(true)
    const g = globalThis as unknown as Record<string, unknown>
    const hadDocument = 'document' in g
    const hadOffscreen = 'OffscreenCanvas' in g
    const prevDocument = g.document
    const prevOffscreen = g.OffscreenCanvas
    try {
      let constructed = 0
      g.document = { createElement: () => ({ style: {}, className: '' }) }
      g.OffscreenCanvas = class {
        constructor() {
          constructed++
        }
        getContext(): null {
          return null
        }
      }
      expect(getSharedGlyphContext()).toBeNull()
      expect(constructed).toBe(0)
      // …and an unusable cell is the same as no cell: it must not latch the one creation attempt.
      expect(getSharedGlyphContext({ cellW: 0, cellH: NaN })).toBeNull()
      expect(constructed).toBe(0)
      // A usable one does reach construction.
      expect(getSharedGlyphContext(CELL)).toBeNull() // no 2d context in this environment
      expect(constructed).toBe(1)
    } finally {
      if (hadDocument) g.document = prevDocument
      else delete g.document
      if (hadOffscreen) g.OffscreenCanvas = prevOffscreen
      else delete g.OffscreenCanvas
      useSharedGlyph.getState().markFailed()
      useSharedGlyph.setState({ enabled: false, failed: false })
    }
  })

  it('setSharedGlyphCamera is inert without a context', () => {
    expect(() => setSharedGlyphCamera({ x: 10, y: 20, zoom: 2 })).not.toThrow()
  })

  // The absence paths above are the easy half: every guard inside `createContext` RETURNS null.
  // A constructor that THROWS instead (a wedged/lost GPU process, a hardened environment that
  // raises on canvas construction) took a different route out of `ensureLiveContext` — up through
  // whichever node happened to ask for the context first. It must degrade identically.
  it('returns null (not a throw) when the OffscreenCanvas constructor THROWS rather than being absent', () => {
    const g = globalThis as unknown as Record<string, unknown>
    const hadDocument = 'document' in g
    const hadOffscreen = 'OffscreenCanvas' in g
    const prevDocument = g.document
    const prevOffscreen = g.OffscreenCanvas
    try {
      // `creationAttempted` latches after the first attempt so a machine without a GPU is never
      // asked twice; the teardown `markFailed()` runs is the only thing that clears it, and it is
      // the supported way to get a fresh attempt out of this module singleton.
      useSharedGlyph.getState().setEnabled(true)
      useSharedGlyph.getState().markFailed()
      useSharedGlyph.setState({ enabled: true, failed: false })
      warn.mockClear()

      // Past the `typeof document === 'undefined'` guard, so construction is actually attempted.
      g.document = { createElement: () => ({ style: {}, className: '' }) }
      g.OffscreenCanvas = class {
        constructor() {
          throw new Error('canvas construction refused')
        }
      }

      expect(getSharedGlyphContext(CELL)).toBeNull()
      expect(warn).toHaveBeenCalled()
      expect(String(warn.mock.calls[0]?.[0])).toContain('[glyphgrid]')
      // A construction throw is "not available here", NOT a session failure: flipping `failed`
      // would bump the generation and re-notify every registrant from inside the very call one of
      // them is making, and would additionally kill the mode for the rest of the app run.
      expect(useSharedGlyph.getState().failed).toBe(false)
    } finally {
      if (hadDocument) g.document = prevDocument
      else delete g.document
      if (hadOffscreen) g.OffscreenCanvas = prevOffscreen
      else delete g.OffscreenCanvas
      // Leave the latch clear so a later test is not silently short-circuited by this one.
      useSharedGlyph.getState().markFailed()
      useSharedGlyph.setState({ enabled: false, failed: false })
    }
  })
})

/**
 * The BOTH-RENDERERS invariant, tested at the one seam that is reachable headless.
 *
 * A terminal is either a budget-coordinated per-node WebGL client or a grid on the shared canvas —
 * never both (the glyph addon's `setRenderer` and `WebglAddon.dispose()` each silently replace the
 * other's renderer) and never neither. `TerminalNode` decides that from `sharedGlyphAvailable()`,
 * so the predicate must answer "shared" for a canvas whose context has not been BUILT yet: the
 * atlas now adopts a live terminal's device cell, which makes "no context yet" the normal state at
 * a fresh mount and again after every font change.
 */
describe('sharedGlyphAvailable', () => {
  const CELL = { cellW: 15.66, cellH: 31 }

  beforeEach(() => {
    // `creationAttempted` is a module singleton that survives a store reset, and only
    // `disposeContext()` clears it — which an enable/disable pair runs, silently (unlike
    // `markFailed`, which logs). Without this the block would depend on what ran before it.
    useSharedGlyph.getState().setEnabled(true)
    useSharedGlyph.getState().setEnabled(false)
  })

  afterEach(() => {
    useSharedGlyph.setState({ enabled: false, generation: 0, failed: false })
  })

  it('is false while the mode is off, and false once the session has failed', () => {
    expect(sharedGlyphAvailable()).toBe(false)
    useSharedGlyph.getState().setEnabled(true)
    useSharedGlyph.getState().markFailed()
    expect(sharedGlyphAvailable()).toBe(false)
  })

  it('is TRUE with the mode on and no context built yet — the fresh-mount state', () => {
    useSharedGlyph.getState().setEnabled(true)
    // Nothing has asked for a context, so none exists. A probe that reported "not shared" here
    // would hand every terminal on the canvas a WebGL budget client moments before each of them
    // attaches a grid.
    expect(sharedGlyphAvailable()).toBe(true)
  })

  it('turns false once this machine has PROVED it cannot build a context', () => {
    useSharedGlyph.getState().setEnabled(true)
    // No OffscreenCanvas in this environment: creation is attempted and produces nothing.
    expect(getSharedGlyphContext(CELL)).toBeNull()
    expect(sharedGlyphAvailable()).toBe(false)
  })

  it('is TRUE again after a disposal — a font change must not look like a failure', () => {
    useSharedGlyph.getState().setEnabled(true)
    expect(getSharedGlyphContext(CELL)).toBeNull() // latches the failed attempt
    expect(sharedGlyphAvailable()).toBe(false)
    // Mode off → disposeContext() (the same call a font change makes) → the latch is cleared.
    useSharedGlyph.getState().setEnabled(false)
    useSharedGlyph.getState().setEnabled(true)
    expect(sharedGlyphAvailable()).toBe(true)
  })
})

/**
 * The dpr rebuild. The atlas cell and the baseline are latched at construction, so a window that
 * moves between a retina and a 1x display keeps a page rasterized for the display it LEFT — soft on
 * one, over-sharp on the other, for the life of the context. Nothing downstream rescues it: the
 * grids register with the CSS cell, which is dpr-invariant, so no re-registration is triggered by
 * the move. Only a rebuild re-rasterizes, and the rebuild is the FONT change's funnel with a
 * different trigger.
 */
describe('pixelRatioChanged', () => {
  it('is false for the ratio the atlas was built at', () => {
    expect(pixelRatioChanged(2, 2)).toBe(false)
  })

  it('is true in both directions — retina to 1x and back', () => {
    expect(pixelRatioChanged(2, 1)).toBe(true)
    expect(pixelRatioChanged(1, 2)).toBe(true)
  })

  it('ignores float noise — a rebuild costs every grid on the canvas', () => {
    expect(pixelRatioChanged(2, 2 + 1e-9)).toBe(false)
  })

  it('sees the fractional ratios a scaled display reports', () => {
    expect(pixelRatioChanged(2, 1.5)).toBe(true)
    expect(pixelRatioChanged(1.25, 1.5)).toBe(true)
  })

  it('treats an unreadable ratio as unchanged, never as a reason to rebuild', () => {
    // 0 / NaN come out of a detached window or a broken shim. The atlas we have is the one the
    // display we are on asked for; throwing it away on a bad reading is strictly worse than
    // keeping it.
    expect(pixelRatioChanged(2, 0)).toBe(false)
    expect(pixelRatioChanged(2, NaN)).toBe(false)
    expect(pixelRatioChanged(2, -1)).toBe(false)
    expect(pixelRatioChanged(2, Infinity)).toBe(false)
  })
})

describe('syncAtlasPixelRatio', () => {
  /** The structural stand-in for a live context — the same trick `AtlasResetSource` uses, so the
   *  rebuild decision is exercisable without a GPU. In production `disposed` is flipped by
   *  `disposeContext()` itself, which is what makes the re-entry guard below real. */
  const ctx = (dpr: number, disposed = false): { dpr: number; disposed: boolean } => ({
    dpr,
    disposed
  })

  it('does nothing while the display has not changed', () => {
    expect(syncAtlasPixelRatio(2, ctx(2))).toBe(false)
    expect(useSharedGlyph.getState().generation).toBe(0)
  })

  it('rebuilds on a change, bumping the generation EXACTLY once', () => {
    // One bump, because that is the signal every mounted terminal re-registers on. Two would run
    // the teardown/setup pair twice for one display change.
    expect(syncAtlasPixelRatio(1, ctx(2))).toBe(true)
    expect(useSharedGlyph.getState().generation).toBe(1)
  })

  it('bumps twice for two distinct changes (2 → 1 → 2), each against the FRESH context', () => {
    // The second context is a different object because the first was disposed: a display change
    // that goes there and back must rebuild both times, not latch after the first.
    expect(syncAtlasPixelRatio(1, ctx(2))).toBe(true)
    expect(syncAtlasPixelRatio(2, ctx(1))).toBe(true)
    expect(useSharedGlyph.getState().generation).toBe(2)
  })

  it('is inert on a context that is already disposed — the re-entry guard', () => {
    expect(syncAtlasPixelRatio(1, ctx(2, true))).toBe(false)
    expect(useSharedGlyph.getState().generation).toBe(0)
  })

  it('a SECOND observer firing on the same display change does not bump again', () => {
    // The guard above only means something because of two facts this asserts together, and which a
    // pre-disposed literal cannot show. (1) `pushViewport` runs from the ResizeObserver, the window
    // `resize` listener AND the resolution media query, and all three close over the SAME context
    // object — so the second call sees what the first one did. (2) `disposeContext()` flips
    // `disposed` on that live object,
    // which is what the guard reads; here that write is stood in for explicitly, since this
    // environment can build no real context to dispose.
    const same = ctx(2)
    expect(syncAtlasPixelRatio(1, same)).toBe(true)
    same.disposed = true // ← what `disposeContext()` does to the live context, inside that call
    expect(syncAtlasPixelRatio(1, same)).toBe(false)
    // One display change, ONE re-registration of every grid on the canvas.
    expect(useSharedGlyph.getState().generation).toBe(1)
  })

  it('does not rebuild on an unreadable ratio', () => {
    expect(syncAtlasPixelRatio(0, ctx(2))).toBe(false)
    expect(useSharedGlyph.getState().generation).toBe(0)
  })
})

/**
 * The dpr watcher — the TRIGGER the rebuild above depends on.
 *
 * `syncAtlasPixelRatio` is only ever reached from `pushViewport`, and the move it exists for (a
 * window dragged between a retina and a 1x display at the SAME point size) leaves the host's CSS
 * box identical, so the ResizeObserver stays silent and the whole fix rests on whatever else fires.
 * xterm does not trust `resize` for this — `CoreBrowserService` watches
 * `matchMedia('screen and (resolution: Xdppx)')` — and this suite is what makes the same watch
 * testable here, since the component itself has no DOM in this environment.
 *
 * The part most likely to be got wrong is the RE-ARM: the query string embeds the ratio it was
 * built at, so a query armed at 2dppx says nothing once the window is at 1dppx.
 */
describe('createPixelRatioWatcher', () => {
  /** A media query list with the two methods we use, and a way to deliver a change. */
  class FakeMql {
    readonly listeners = new Set<() => void>()
    constructor(readonly query: string) {}
    addEventListener(_type: 'change', fn: () => void): void {
      this.listeners.add(fn)
    }
    removeEventListener(_type: 'change', fn: () => void): void {
      this.listeners.delete(fn)
    }
    fire(): void {
      for (const fn of [...this.listeners]) fn()
    }
  }

  /** A fake display whose ratio can be moved, recording every query the watcher arms. */
  const fakeDisplay = (
    startDpr: number
  ): { host: PixelRatioWatchHost; built: FakeMql[]; move(to: number): void } => {
    let dpr = startDpr
    const built: FakeMql[] = []
    return {
      host: {
        dpr: () => dpr,
        match: (query) => {
          const mql = new FakeMql(query)
          built.push(mql)
          return mql
        }
      },
      built,
      // The browser order: `devicePixelRatio` is ALREADY the new value when the query that no
      // longer matches delivers its change.
      move(to: number): void {
        dpr = to
      }
    }
  }

  it('arms on the ratio it is constructed at, in xterm’s own query form', () => {
    const display = fakeDisplay(2)
    createPixelRatioWatcher(display.host, () => {})
    expect(display.built).toHaveLength(1)
    expect(display.built[0]?.query).toBe('screen and (resolution: 2dppx)')
  })

  it('calls back EXACTLY once for one display change', () => {
    const display = fakeDisplay(2)
    const onChange = vi.fn()
    createPixelRatioWatcher(display.host, onChange)
    display.move(1)
    display.built[0]?.fire()
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it('RE-ARMS at the new ratio — a second change still fires', () => {
    // The whole reason this is a watcher rather than one `addEventListener` call. The 2dppx query
    // is answered once and then never again; without the re-arm the move BACK is silent, and the
    // canvas keeps an atlas rasterized for the display it is no longer on.
    const display = fakeDisplay(2)
    const onChange = vi.fn()
    createPixelRatioWatcher(display.host, onChange)

    display.move(1)
    display.built[0]?.fire()
    expect(display.built).toHaveLength(2)
    expect(display.built[1]?.query).toBe('screen and (resolution: 1dppx)')
    // The spent query is released, so the move back cannot be answered twice.
    expect(display.built[0]?.listeners.size).toBe(0)

    display.move(2)
    display.built[1]?.fire()
    expect(onChange).toHaveBeenCalledTimes(2)
    expect(display.built[2]?.query).toBe('screen and (resolution: 2dppx)')
  })

  it('bumps the generation exactly once per change, through the real rebuild funnel', () => {
    // End to end for the thing the trigger exists to reach: the watcher's callback is
    // `pushViewport`, whose first act is `syncAtlasPixelRatio`. One display change, ONE
    // re-registration of every grid on the canvas — and the SECOND change gets its own.
    const display = fakeDisplay(2)
    let ctx = { dpr: 2, disposed: false }
    createPixelRatioWatcher(display.host, () => {
      if (syncAtlasPixelRatio(display.host.dpr(), ctx)) {
        // What `disposeContext()` + the re-run effect do: the closure meets a FRESH context built
        // at the ratio we are now on.
        ctx.disposed = true
        ctx = { dpr: display.host.dpr(), disposed: false }
      }
    })

    display.move(1)
    display.built[0]?.fire()
    expect(useSharedGlyph.getState().generation).toBe(1)

    display.move(2)
    display.built[1]?.fire()
    expect(useSharedGlyph.getState().generation).toBe(2)
  })

  it('stops: the listener is released and a later change reaches nobody', () => {
    const display = fakeDisplay(2)
    const onChange = vi.fn()
    const watcher = createPixelRatioWatcher(display.host, onChange)
    watcher.stop()
    expect(display.built[0]?.listeners.size).toBe(0)
    display.move(1)
    display.built[0]?.fire()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('is inert where the environment has no matchMedia at all', () => {
    // The node test environment and any hardened shell. Nothing to watch is a correct outcome —
    // the `resize` listener is still there — and it must not cost a throw at mount.
    const watcher = createPixelRatioWatcher({ dpr: () => 2, match: () => null }, () => {
      throw new Error('unreachable')
    })
    expect(() => watcher.stop()).not.toThrow()
  })

  it('is inert on a query list that cannot be listened to', () => {
    // An ancient shim exposing only the deprecated `addListener` pair. We do not carry a fallback
    // for it (nothing else in the repo does), so it degrades to the `resize` trigger alone rather
    // than throwing on every mount.
    const watcher = createPixelRatioWatcher({ dpr: () => 2, match: () => ({}) }, () => {
      throw new Error('unreachable')
    })
    expect(() => watcher.stop()).not.toThrow()
  })
})

/**
 * The board gate. The kanban board is a fully opaque overlay over the whole canvas, so every frame
 * drawn under it is invisible work — and the idle park cannot help, because a canvas of STREAMING
 * terminals under the board never goes quiet.
 *
 * The real `createFrameLoop` is driven here rather than a mock of it: what is being asserted is
 * that a stopped loop really stops (a wake cannot resurrect it) and that a reopened canvas really
 * draws, and both of those are the frame driver's contract, not this file's.
 */
describe('createBoardFrameGate', () => {
  function harness(): {
    host: FrameLoopHost
    /** Run every pending rAF callback. */
    flushFrames(): number
    pendingFrames(): number
    drew(): number
    loopsMade(): number
    makeLoop(): FrameLoop
    /** Rows arriving from a terminal: the engine goes dirty whether or not anyone draws it. */
    damage(): void
  } {
    const frames = new Map<number, () => void>()
    const timers = new Map<number, () => void>()
    let handle = 1
    let dirty = false
    let drew = 0
    let loops = 0
    const host: FrameLoopHost = {
      frame: () => {
        if (!dirty) return false
        dirty = false
        drew++
        return true
      },
      alive: () => true,
      onError: () => {},
      requestFrame: (cb) => {
        const h = handle++
        frames.set(h, cb)
        return h
      },
      cancelFrame: (h) => {
        frames.delete(h)
      },
      setTimer: (cb) => {
        const h = handle++
        timers.set(h, cb)
        return h
      },
      clearTimer: (h) => {
        timers.delete(h)
      }
    }
    return {
      host,
      flushFrames(): number {
        const due = [...frames.entries()]
        frames.clear()
        for (const [, cb] of due) cb()
        return due.length
      },
      pendingFrames: () => frames.size,
      drew: () => drew,
      loopsMade: () => loops,
      makeLoop: () => {
        loops++
        return createFrameLoop(host)
      },
      damage: () => {
        dirty = true
      }
    }
  }

  it('starts drawing when the board is closed', () => {
    const h = harness()
    createBoardFrameGate(() => false, h.makeLoop)
    expect(h.pendingFrames()).toBe(1)
  })

  it('schedules NOTHING while the board is up, damage included', () => {
    // The point of the whole gate: rows keep arriving under the board and none of them costs a
    // frame.
    const h = harness()
    const gate = createBoardFrameGate(() => true, h.makeLoop)
    expect(h.pendingFrames()).toBe(0)
    h.damage()
    gate.loop().wake()
    expect(h.pendingFrames()).toBe(0)
    expect(h.drew()).toBe(0)
  })

  it('stops drawing when the board OPENS, and drops the frame already scheduled', () => {
    const h = harness()
    let open = false
    const gate = createBoardFrameGate(() => open, h.makeLoop)
    expect(h.pendingFrames()).toBe(1)
    open = true
    gate.sync()
    expect(h.pendingFrames()).toBe(0)
    h.damage()
    gate.loop().wake()
    expect(h.pendingFrames()).toBe(0)
  })

  it('draws ONE frame immediately when the board closes — not on the next damage', () => {
    // Everything that arrived under the board is still damage on the engine, so the first frame
    // after the board closes paints the CURRENT screen. Waiting for the next write would leave a
    // finished agent's terminal showing the rows it had when the board went up.
    const h = harness()
    let open = true
    const gate = createBoardFrameGate(() => open, h.makeLoop)
    h.damage()
    expect(h.pendingFrames()).toBe(0)
    open = false
    gate.sync()
    expect(h.pendingFrames()).toBe(1)
    h.flushFrames()
    expect(h.drew()).toBe(1)
  })

  it('hands out the CURRENT loop, so damage wakes the one that is running', () => {
    // `createFrameLoop.stop()` is terminal by contract, so leaving the board builds a FRESH loop.
    // A damage subscription that captured the original would be waking a corpse for the rest of
    // the session — the frozen-canvas failure this gate must not introduce.
    const h = harness()
    let open = false
    const gate = createBoardFrameGate(() => open, h.makeLoop)
    const first = gate.loop()
    open = true
    gate.sync()
    open = false
    gate.sync()
    expect(gate.loop()).not.toBe(first)
    // The stopped loop adds nothing to what the fresh one has scheduled…
    const scheduled = h.pendingFrames()
    first.wake()
    expect(h.pendingFrames()).toBe(scheduled)
    // …while the one the gate hands out really is the one drawing.
    h.damage()
    h.flushFrames()
    expect(h.drew()).toBe(1)
  })

  it('a sync with no change costs nothing — no new loop, no lost frame', () => {
    const h = harness()
    const gate = createBoardFrameGate(() => false, h.makeLoop)
    gate.sync()
    gate.sync()
    expect(h.loopsMade()).toBe(1)
    expect(h.pendingFrames()).toBe(1)
  })

  it('stop() ends it, and a later sync cannot resurrect it', () => {
    // Teardown ordering is not guaranteed to beat a store notification that is already in flight.
    const h = harness()
    let open = true
    const gate = createBoardFrameGate(() => open, h.makeLoop)
    gate.stop()
    open = false
    gate.sync()
    expect(h.pendingFrames()).toBe(0)
    h.damage()
    gate.loop().wake()
    expect(h.pendingFrames()).toBe(0)
  })
})

describe('createCursorBlinkClock', () => {
  /**
   * Everything the clock touches is injected, so the whole policy — the three gates, the phase, the
   * teardown and the damage routing — is exercisable without a DOM, a timer or a GPU.
   *
   * The fake TARGET damages the engine when it repaints, exactly as the addon's cursor-row repack
   * does (`updateRow`/`setCursor` → `markDirty` → the layer's damage subscription). That is the
   * whole point of the harness: the trap this task exists to avoid is not visible unless the
   * repaint's own damage is modelled.
   */
  function blinkHarness(opts: { enabled?: boolean; covered?: boolean } = {}): {
    clock: CursorBlinkClock
    phases: boolean[]
    loop: { wake: ReturnType<typeof vi.fn>; pulse: ReturnType<typeof vi.fn> }
    intervalsStarted(): number
    intervalsCleared(): number
    running(): boolean
    tick(): void
    focus(name?: string): CursorBlinkTarget
    blur(): void
    setEnabled(on: boolean): void
    setCovered(on: boolean): void
    phasesOf(target: CursorBlinkTarget): boolean[]
  } {
    const phases: boolean[] = []
    const perTarget = new Map<CursorBlinkTarget, boolean[]>()
    const loop = { wake: vi.fn(), pulse: vi.fn() }
    const state = {
      enabled: opts.enabled ?? true,
      covered: opts.covered ?? false,
      target: null as CursorBlinkTarget | null
    }
    let started = 0
    let cleared = 0
    let fire: (() => void) | null = null

    const clock = createCursorBlinkClock({
      enabled: () => state.enabled,
      covered: () => state.covered,
      target: () => state.target,
      loop: () => loop,
      setInterval: (cb) => {
        started++
        fire = cb
        return started
      },
      clearInterval: () => {
        cleared++
        fire = null
      }
    })

    const focus = (): CursorBlinkTarget => {
      const target: CursorBlinkTarget = {
        setPhase(visible: boolean): void {
          phases.push(visible)
          const own = perTarget.get(target) ?? []
          own.push(visible)
          perTarget.set(target, own)
          // The repack dirties the engine, synchronously, from inside `setPhase`.
          clock.routeDamage()
        }
      }
      state.target = target
      clock.sync()
      return target
    }

    return {
      clock,
      phases,
      loop,
      intervalsStarted: () => started,
      intervalsCleared: () => cleared,
      running: () => fire !== null,
      tick: () => fire?.(),
      focus,
      blur: () => {
        state.target = null
        clock.sync()
      },
      setEnabled: (on) => {
        state.enabled = on
        clock.sync()
      },
      setCovered: (on) => {
        state.covered = on
        clock.sync()
      },
      phasesOf: (target) => perTarget.get(target) ?? []
    }
  }

  it('has no clock at all while no terminal has focus', () => {
    // The canvas everybody actually leaves open: terminals on screen, focus in the editor or in
    // another app. A clock here would be a repaint twice a second for a cursor nobody is on.
    const h = blinkHarness()
    h.clock.sync()
    expect(h.running()).toBe(false)
    expect(h.intervalsStarted()).toBe(0)
  })

  it('has no clock while the blink setting is off', () => {
    const h = blinkHarness({ enabled: false })
    h.focus()
    expect(h.running()).toBe(false)
  })

  it('has no clock while the kanban board covers the canvas', () => {
    // The board gate has STOPPED the loop, so a phase flip would repack a row nobody draws, every
    // 600 ms, for as long as the board is up.
    const h = blinkHarness({ covered: true })
    h.focus()
    expect(h.running()).toBe(false)
  })

  it('starts one clock when a focused terminal and the setting agree', () => {
    const h = blinkHarness()
    h.focus()
    expect(h.running()).toBe(true)
    expect(h.intervalsStarted()).toBe(1)
  })

  it('alternates the phase, starting from SHOWN', () => {
    const h = blinkHarness()
    h.focus()
    expect(h.phases).toEqual([]) // a freshly focused terminal gets a full period before it hides
    h.tick()
    h.tick()
    h.tick()
    expect(h.phases).toEqual([false, true, false])
  })

  it('repaints through pulse(), NEVER through wake — the park must survive the blink', () => {
    // THE test of this task. `wake()` would draw the frame and then hold rAF alive for another
    // IDLE_FRAMES_BEFORE_PARK frames, twice a second, forever.
    const h = blinkHarness()
    h.focus()
    h.tick()
    h.tick()
    expect(h.loop.pulse).toHaveBeenCalledTimes(2)
    expect(h.loop.wake).not.toHaveBeenCalled()
  })

  it('leaves ORDINARY damage on the wake path — only the blink is a one-shot', () => {
    // Damage from a terminal writing rows is likely to be followed by more, which is exactly what
    // `wake()` is for. Routing everything through `pulse()` would cost a scheduling hop per frame
    // of a streaming terminal.
    const h = blinkHarness()
    h.focus()
    h.clock.routeDamage()
    expect(h.loop.wake).toHaveBeenCalledTimes(1)
    expect(h.loop.pulse).not.toHaveBeenCalled()
  })

  it('a sync that changes nothing does not restart the interval', () => {
    const h = blinkHarness()
    h.focus()
    h.clock.sync()
    h.clock.sync()
    expect(h.intervalsStarted()).toBe(1)
    expect(h.intervalsCleared()).toBe(0)
  })

  it('turning the setting off stops the clock and hands the cursor back SHOWN', () => {
    // A cursor left in its hidden phase is an invisible cursor for the rest of the session — the
    // one way this feature can be worse than not having it.
    const h = blinkHarness()
    h.focus()
    h.tick() // hidden
    h.setEnabled(false)
    expect(h.running()).toBe(false)
    expect(h.phases).toEqual([false, true])
  })

  it('the board covering the canvas stops the clock the same way', () => {
    const h = blinkHarness()
    h.focus()
    h.tick()
    h.setCovered(true)
    expect(h.running()).toBe(false)
    expect(h.phases).toEqual([false, true])
  })

  it('losing focus stops the clock, restoring the terminal that had it', () => {
    const h = blinkHarness()
    const first = h.focus()
    h.tick()
    h.blur()
    expect(h.running()).toBe(false)
    expect(h.phasesOf(first)).toEqual([false, true])
  })

  it('a focus HANDOVER restores the old terminal and starts the new one shown', () => {
    // The old target is restored BEFORE it is forgotten — afterwards there is no handle to fix it
    // with, and its cursor would stay hidden until something unrelated repacked its row.
    const h = blinkHarness()
    const first = h.focus()
    h.tick() // first is hidden
    const second = h.focus()
    expect(h.phasesOf(first)).toEqual([false, true])
    expect(h.phasesOf(second)).toEqual([])
    expect(h.running()).toBe(true)
    h.tick()
    expect(h.phasesOf(second)).toEqual([false])
  })

  it('stop() clears the interval, restores the cursor, and a later sync cannot restart it', () => {
    // Teardown ordering is not guaranteed to beat a store notification already in flight — the
    // same discipline `createBoardFrameGate.stop()` keeps.
    const h = blinkHarness()
    const first = h.focus()
    h.tick()
    h.clock.stop()
    expect(h.running()).toBe(false)
    expect(h.phasesOf(first)).toEqual([false, true])
    h.clock.sync()
    expect(h.running()).toBe(false)
  })

  it('matches xterm’s own blink period, so a DOM-rendered terminal beside a shared one agrees', () => {
    expect(CURSOR_BLINK_INTERVAL_MS).toBe(600)
  })

  it('a cursor move during a hidden phase shows the cursor again — through pulse, not wake', () => {
    // The restart is a BLINK repaint like any other, so it has to stay inside the bracket. A
    // restart routed to `wake()` would be worse than the phase flips this design was built around:
    // it happens on every keystroke, not twice a second.
    const h = blinkHarness()
    h.focus()
    h.tick()
    expect(h.phases).toEqual([false])
    h.loop.pulse.mockClear()
    h.loop.wake.mockClear()

    h.clock.restart()

    expect(h.phases).toEqual([false, true])
    expect(h.loop.pulse).toHaveBeenCalledTimes(1)
    expect(h.loop.wake).not.toHaveBeenCalled()
  })

  it('a restart re-arms the period, so the cursor stays solid while you type', () => {
    // Showing it again without restarting the interval would leave the cursor solid only until the
    // next tick of the OLD period — up to 600 ms, but as little as a millisecond.
    const h = blinkHarness()
    h.focus()
    expect(h.intervalsStarted()).toBe(1)
    h.clock.restart()
    expect(h.intervalsCleared()).toBe(1)
    expect(h.intervalsStarted()).toBe(2)
    expect(h.running()).toBe(true)
  })

  it('a restart starts nothing while a gate is holding the clock stopped', () => {
    // `sync` owns the gates. A restart that started an interval here would blink a cursor the
    // setting (or the board) has already stopped.
    const h = blinkHarness({ enabled: false })
    h.focus()
    h.clock.restart()
    expect(h.running()).toBe(false)
    expect(h.intervalsStarted()).toBe(0)
  })

  it('a restart with nothing focused, and one after stop(), are both inert', () => {
    const h = blinkHarness()
    h.clock.restart()
    expect(h.running()).toBe(false)
    h.focus()
    h.clock.stop()
    h.clock.restart()
    expect(h.running()).toBe(false)
  })
})

describe('the cursor blink target seam', () => {
  afterEach(() => setCursorBlinkTarget(null))

  it('notifies on a change and not on a repeat', () => {
    const seen = vi.fn()
    const off = subscribeCursorBlinkTarget(seen)
    const target: CursorBlinkTarget = { setPhase: () => {} }
    setCursorBlinkTarget(target)
    setCursorBlinkTarget(target)
    expect(seen).toHaveBeenCalledTimes(1)
    expect(cursorBlinkTarget()).toBe(target)
    setCursorBlinkTarget(null)
    expect(seen).toHaveBeenCalledTimes(2)
    expect(cursorBlinkTarget()).toBeNull()
    off()
    setCursorBlinkTarget(target)
    expect(seen).toHaveBeenCalledTimes(2)
  })

  it('release only clears the blink for the target that still HOLDS it', () => {
    // THE late-blur bug, and the reason the comparison lives in this function rather than in the
    // attach shell (which has no unit tests by design): the browser does not promise that the old
    // terminal's blur reaches us before the new one's focus, and an unconditional clear would stop
    // the cursor of the terminal the user just clicked into.
    const a: CursorBlinkTarget = { setPhase: () => {} }
    const b: CursorBlinkTarget = { setPhase: () => {} }
    setCursorBlinkTarget(a)
    setCursorBlinkTarget(b)
    releaseCursorBlinkTarget(a)
    expect(cursorBlinkTarget()).toBe(b)
    releaseCursorBlinkTarget(b)
    expect(cursorBlinkTarget()).toBeNull()
  })

  it('restart notifies only for the target that holds the blink', () => {
    // A background terminal streaming output moves its cursor constantly; any of them re-arming the
    // focused terminal's period would hold the blink permanently solid.
    const seen = vi.fn()
    const off = subscribeCursorBlinkRestart(seen)
    const a: CursorBlinkTarget = { setPhase: () => {} }
    const b: CursorBlinkTarget = { setPhase: () => {} }
    setCursorBlinkTarget(a)
    restartCursorBlink(b)
    expect(seen).not.toHaveBeenCalled()
    restartCursorBlink(a)
    expect(seen).toHaveBeenCalledTimes(1)
    off()
    restartCursorBlink(a)
    expect(seen).toHaveBeenCalledTimes(1)
  })
})

/**
 * THE PARK, END TO END — the one constraint the whole blink design exists to satisfy.
 *
 * The addon's own tests prove it repacks on the caller's stack; the clock's tests above prove it
 * routes bracketed damage to `pulse()`. Neither alone proves the FEATURE parks, because the trap
 * lives exactly in the seam between them: an addon that repacked one tick later would satisfy both
 * and still put an idle canvas back at the display's refresh rate, thirty frames every 600 ms.
 *
 * So this wires the REAL addon to the REAL clock through a handle that reports damage the way the
 * engine does — edge-triggered on the clean→dirty transition, cleared by the frame the loop draws.
 * It lives on THIS side of the boundary because the dependency direction is canvas → glyphgrid; the
 * fakes come from `glyphgrid/addon-fakes.ts`, which is a plain module rather than a `.test.ts` so
 * importing it does not collect the addon's suite a second time.
 */
describe('the blink phase through the real clock', () => {
  function wired(): {
    core: GlyphGridRendererAddonCore
    loop: { wake: number; pulse: number }
    intervalsStarted(): number
    running(): boolean
    tick(): void
    frame(): void
    /** Does the NEWEST pack of the cursor row carry the block cursor? */
    cursorPainted(): boolean
  } {
    const handle = recordingHandle()
    let clock: CursorBlinkClock | null = null
    const loop = { wake: 0, pulse: 0 }
    // The engine's `markDirty` notifies on the clean→dirty EDGE only, and the FRAME clears the flag
    // — neither `wake()` nor `pulse()` draws inline, they schedule. Modelling that (rather than one
    // notification per write) is what makes the counts below mean "frames scheduled", which is the
    // number the park is about.
    let dirty = false
    const damage = (): void => {
      if (dirty) return
      dirty = true
      clock?.routeDamage()
    }
    const damaging: GridHandle = {
      ...handle,
      updateRow(row, cells) {
        handle.updateRow(row, cells)
        damage()
      },
      setCursor(cursor) {
        handle.setCursor(cursor)
        damage()
      }
    }

    let current: CursorBlinkPhaseTarget | null = null
    // The attach shell's seam, verbatim in behaviour: claim publishes, release and restart are
    // identity-guarded, and a target change re-syncs the clock (the real one does it through the
    // layer's subscription).
    const seam: CursorBlinkSeam = {
      claim(t) {
        current = t
        clock?.sync()
      },
      release(t) {
        if (current !== t) return
        current = null
        clock?.sync()
      },
      restart(t) {
        if (current !== t) return
        clock?.restart()
      }
    }

    let fire: (() => void) | null = null
    let started = 0
    clock = createCursorBlinkClock({
      enabled: () => true,
      covered: () => false,
      target: () => current,
      loop: () => ({
        wake: () => {
          loop.wake++
        },
        pulse: () => {
          loop.pulse++
        }
      }),
      setInterval: (cb) => {
        started++
        fire = cb
        return started
      },
      clearInterval: () => {
        fire = null
      }
    })

    const term = fakeTerm({ rows: 4, cols: 4, cursorY: 1, cursorX: 2, focus: true, blink: seam })
    const core = new GlyphGridRendererAddonCore(term, damaging, recordingAtlas())
    return {
      core,
      loop,
      intervalsStarted: () => started,
      running: () => fire !== null,
      tick: () => fire?.(),
      frame: () => {
        dirty = false
      },
      cursorPainted: () => {
        const rec = [...handle.rows].reverse().find((r) => r.row === 1)
        if (!rec) throw new Error('the cursor row was never packed')
        return (readCell(rec.cells, 2).flags & FLAG_CURSOR) !== 0
      }
    }
  }

  it('a phase flip costs ONE pulse and never a wake — the idle park survives the blink', () => {
    const h = wired()
    // The addon claimed the blink at construction, so the clock is already ticking.
    expect(h.running()).toBe(true)
    for (let i = 0; i < 3; i++) {
      h.tick()
      // The frame the pulse scheduled draws and clears the engine's dirty flag, 600 ms before the
      // next phase — which is what lets the next flip notify at all.
      h.frame()
    }
    expect(h.loop.pulse).toBe(3)
    expect(h.loop.wake).toBe(0)
  })

  it('ordinary damage from the SAME addon still takes wake()', () => {
    // The other half of the routing: only the clock's own bracketed repaint is a pulse. A terminal
    // writing rows is likely to be followed by more, and a pulse per write would put a scheduling
    // hop in front of every character.
    const h = wired()
    h.core.renderRows(0, 3)
    expect(h.loop.wake).toBe(1)
    expect(h.loop.pulse).toBe(0)
  })

  it('a cursor move during a hidden phase shows the cursor, restarts the period, and pulses', () => {
    // xterm holds its own cursor solid while you type; without this the shared renderer kept
    // flashing, so a stacked (DOM-rendered) terminal beside a shared one behaved differently in the
    // most attention-heavy moment there is — the drift the matched period exists to prevent.
    const h = wired()
    h.tick()
    h.frame()
    expect(h.cursorPainted()).toBe(false)

    h.core.handleCursorMove()

    expect(h.cursorPainted()).toBe(true)
    expect(h.intervalsStarted()).toBe(2)
    expect(h.loop.pulse).toBe(2)
    expect(h.loop.wake).toBe(0)
  })
})

describe('installAtlasResetLog', () => {
  /** The atlas surface the log reads, with a manual trigger. */
  function fakeAtlas(): {
    source: AtlasResetSource
    fire(): void
    subs: number
  } {
    const cbs = new Set<() => void>()
    let count = 0
    return {
      source: {
        get resetCount() {
          return count
        },
        onReset(cb) {
          cbs.add(cb)
          return {
            dispose() {
              cbs.delete(cb)
            }
          }
        }
      },
      fire() {
        // The real atlas increments its counter BEFORE it notifies (see GlyphAtlas.reset), which is
        // what lets the log line carry the number of the reset it is reporting.
        count++
        for (const cb of [...cbs]) cb()
      },
      get subs() {
        return cbs.size
      }
    }
  }

  let warn: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    warn.mockRestore()
  })

  it('logs the first reset immediately, with its number', () => {
    const atlas = fakeAtlas()
    installAtlasResetLog(atlas.source, () => 0)
    atlas.fire()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0][0])).toContain('[glyphgrid] atlas page reset #1')
  })

  // Resets are supposed to be RARE. A page too small for the canvas resets on every repack instead,
  // and an unthrottled line there would be a console write per frame — which costs frames itself
  // and buries the very signal the tester is being asked to report.
  it('throttles a burst to one line, and says how many it swallowed', () => {
    const atlas = fakeAtlas()
    let now = 0
    installAtlasResetLog(atlas.source, () => now)
    atlas.fire()
    now = 100
    atlas.fire()
    now = 200
    atlas.fire()
    expect(warn).toHaveBeenCalledTimes(1)
    now = 5000
    atlas.fire()
    expect(warn).toHaveBeenCalledTimes(2)
    const line = String(warn.mock.calls[1][0])
    expect(line).toContain('#4')
    expect(line).toContain('+2')
  })

  it('does not mention swallowed resets when none were', () => {
    const atlas = fakeAtlas()
    let now = 0
    installAtlasResetLog(atlas.source, () => now)
    atlas.fire()
    now = 5000
    atlas.fire()
    expect(warn).toHaveBeenCalledTimes(2)
    expect(String(warn.mock.calls[1][0])).not.toContain('+')
  })

  it('unsubscribes on dispose — the context that installed it is gone', () => {
    const atlas = fakeAtlas()
    const sub = installAtlasResetLog(atlas.source, () => 0)
    expect(atlas.subs).toBe(1)
    sub.dispose()
    expect(atlas.subs).toBe(0)
    atlas.fire()
    expect(warn).not.toHaveBeenCalled()
  })
})

describe('createContextLossPolicy', () => {
  /**
   * The whole policy is injected, so the once-only rule, the cooldown and both give-up branches
   * are exercisable without a GPU, a canvas or a clock — the same split `createBoardFrameGate`
   * and `createCursorBlinkClock` make.
   */
  function harness(): {
    deps: Parameters<typeof createContextLossPolicy>[0]
    at(ms: number): void
    suspends(): number
    revives(): number
    failures(): { reason: string; err?: unknown }[]
    /** Make the next `revive()` throw — a driver that will not rebuild. */
    breakRevive(): void
    /** How many watchdog timers are armed right now. */
    pendingTimers(): number
    /** Fire every armed timer — "the restore never arrived". */
    fireTimers(): void
  } {
    let clock = 0
    let suspends = 0
    let revives = 0
    let broken = false
    let handle = 1
    const timers = new Map<number, () => void>()
    const failures: { reason: string; err?: unknown }[] = []
    return {
      deps: {
        now: () => clock,
        suspend: () => {
          suspends++
        },
        revive: () => {
          if (broken) throw new Error('programs would not rebuild')
          revives++
        },
        fail: (reason, err) => {
          failures.push({ reason, err })
        },
        setTimer: (cb) => {
          const h = handle++
          timers.set(h, cb)
          return h
        },
        clearTimer: (h) => {
          timers.delete(h)
        }
      },
      at: (ms) => {
        clock = ms
      },
      suspends: () => suspends,
      revives: () => revives,
      failures: () => failures,
      breakRevive: () => {
        broken = true
      },
      pendingTimers: () => timers.size,
      fireTimers: () => {
        const due = [...timers.values()]
        timers.clear()
        for (const cb of due) cb()
      }
    }
  }

  let warn: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    warn.mockRestore()
  })

  it('a first loss suspends and ASKS for a restore', () => {
    // `preventDefault()` is the request for a `webglcontextrestored` event; Phase 1b never made it
    // because it had nothing to restore into.
    const h = harness()
    const policy = createContextLossPolicy(h.deps)
    expect(policy.onLost()).toBe(true)
    expect(h.suspends()).toBe(1)
    expect(h.failures()).toEqual([])
  })

  it('the restore rebuilds and says so on the console', () => {
    // A SILENT restore is indistinguishable from a freeze to whoever is debugging one, which is
    // why both branches of this policy warn.
    const h = harness()
    const policy = createContextLossPolicy(h.deps)
    policy.onLost()
    policy.onRestored()
    expect(h.revives()).toBe(1)
    expect(h.failures()).toEqual([])
    expect(warn.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')).toMatch(
      /context restored/i
    )
  })

  it('a SECOND loss inside the cooldown falls back permanently — no retry loop, ever', () => {
    // The floor under the whole feature, and Phase 1b's behaviour kept as it: a GPU that keeps
    // taking the context away must not be handed it back over and over, because that turns one
    // failure into a flicker.
    const h = harness()
    const policy = createContextLossPolicy(h.deps)
    policy.onLost()
    policy.onRestored()
    h.at(RESTORE_COOLDOWN_MS - 1)
    expect(policy.onLost()).toBe(false) // not even asking for a restore this time
    expect(h.suspends()).toBe(1) // …and no second suspend
    expect(h.failures()).toHaveLength(1)
    expect(h.failures()[0].reason).toMatch(/lost again/i)
    // Terminal: nothing that arrives afterwards may restore anything.
    policy.onRestored()
    expect(h.revives()).toBe(1)
    expect(policy.onLost()).toBe(false)
    expect(h.failures()).toHaveLength(1)
  })

  it('a loss AFTER the cooldown is restored again — one restore per context', () => {
    // The rule is "once per CONTEXT", not "once per session": a machine that sleeps twice in an
    // afternoon gets its renderer back both times.
    const h = harness()
    const policy = createContextLossPolicy(h.deps)
    policy.onLost()
    policy.onRestored()
    h.at(RESTORE_COOLDOWN_MS + 1)
    expect(policy.onLost()).toBe(true)
    policy.onRestored()
    expect(h.revives()).toBe(2)
    expect(h.failures()).toEqual([])
  })

  it('a restore that THROWS falls back permanently, carrying the error', () => {
    // A half-rebuilt context draws nothing, and a canvas of transparent node bodies drawing
    // nothing looks exactly like a freeze.
    const h = harness()
    const policy = createContextLossPolicy(h.deps)
    policy.onLost()
    h.breakRevive()
    policy.onRestored()
    expect(h.failures()).toHaveLength(1)
    expect(h.failures()[0].reason).toMatch(/restore threw/i)
    expect(h.failures()[0].err).toBeInstanceOf(Error)
    // And it is over: a later restore event cannot re-enter the rebuild.
    policy.onRestored()
    expect(h.revives()).toBe(0)
  })

  it('a restore we never asked for is ignored', () => {
    // The browser can hand a context back on its own after we have given up. Rebuilding there
    // would double-create every grid's GPU buffer and leak the first set.
    const h = harness()
    const policy = createContextLossPolicy(h.deps)
    policy.onRestored()
    expect(h.revives()).toBe(0)
    expect(h.failures()).toEqual([])
  })

  it('a restore that NEVER arrives falls back instead of stranding the canvas', () => {
    // The worst outcome this policy can produce, and it is worse than the Phase-1b floor it
    // promises to keep: suspended engine, stopped runtime, and `failed` still FALSE — so every
    // node keeps a transparent body and keeps writing rows into a canvas that paints nothing, for
    // the rest of the session, with no second line on the console. `preventDefault()` is only a
    // REQUEST, and a synthetic `loseContext()` is never auto-restored at all.
    const h = harness()
    const policy = createContextLossPolicy(h.deps)
    policy.onLost()
    expect(h.pendingTimers()).toBe(1)
    h.fireTimers()
    expect(h.failures()).toHaveLength(1)
    expect(h.failures()[0].reason).toMatch(/never restored/i)
    // Terminal, like every other give-up branch: a restore that turns up after we have given up
    // must not rebuild anything.
    policy.onRestored()
    expect(h.revives()).toBe(0)
    expect(h.failures()).toHaveLength(1)
  })

  it('the watchdog is disarmed by a restore that does arrive', () => {
    // A timer left running would fail a session that recovered perfectly well.
    const h = harness()
    const policy = createContextLossPolicy(h.deps)
    policy.onLost()
    policy.onRestored()
    expect(h.pendingTimers()).toBe(0)
    h.fireTimers()
    expect(h.failures()).toEqual([])
  })

  it('the give-up branches arm no watchdog', () => {
    // Nothing is waiting for a restore on either terminal path, and a timer that fired afterwards
    // would log a second, contradictory reason for the same failure.
    const withinCooldown = harness()
    const a = createContextLossPolicy(withinCooldown.deps)
    a.onLost()
    a.onRestored()
    withinCooldown.at(RESTORE_COOLDOWN_MS - 1)
    a.onLost()
    expect(withinCooldown.pendingTimers()).toBe(0)

    const throwing = harness()
    const b = createContextLossPolicy(throwing.deps)
    b.onLost()
    throwing.breakRevive()
    b.onRestored()
    expect(throwing.pendingTimers()).toBe(0)
  })

  it('the loss itself is announced, not only its outcome', () => {
    // The one branch a regression could silence without any assertion going red — and the one a
    // device tester reads first, since it is what says "the canvas is blank ON PURPOSE, wait".
    const h = harness()
    const policy = createContextLossPolicy(h.deps)
    policy.onLost()
    expect(warn.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')).toMatch(
      /context lost/i
    )
  })

  it('stop() disarms the watchdog, so it cannot fail a session that has moved on', () => {
    // The layer unmounts for reasons that have nothing to do with a failure — the mode switched
    // off hands the context back and disposes it. A watchdog firing after that would set the
    // session's `failed` flag, and re-enabling the mode would then do nothing until a relaunch.
    const h = harness()
    const policy = createContextLossPolicy(h.deps)
    policy.onLost()
    policy.stop()
    expect(h.pendingTimers()).toBe(0)
    h.fireTimers()
    expect(h.failures()).toEqual([])
    // …and it is terminal, like every other end state.
    expect(policy.onLost()).toBe(false)
    policy.onRestored()
    expect(h.revives()).toBe(0)
  })

  it('a duplicate loss for the SAME outage is not a second failure', () => {
    // Two `webglcontextlost` events before any restore is one outage, not a GPU that failed twice
    // — suspending again would be harmless but failing the session would not.
    const h = harness()
    const policy = createContextLossPolicy(h.deps)
    policy.onLost()
    expect(policy.onLost()).toBe(true)
    expect(h.suspends()).toBe(1)
    expect(h.failures()).toEqual([])
    policy.onRestored()
    expect(h.revives()).toBe(1)
  })
})

/**
 * The 2026-08-10 crispness report, and the one measurement that ended it.
 *
 * `ensureLiveContext` fixes the atlas geometry from the FIRST terminal that registers, for the life
 * of the context. In the field every node reported a device cell of 16.79998×36 while the atlas had
 * latched to 16×36 — so every glyph was rasterized into a 16px box and drawn into a 16.8px cell, a
 * 5% horizontal stretch. That is exactly the 4.9% wider advance measured off screenshots against
 * xterm's own WebGL renderer, with the line spacing identical to the pixel because the heights
 * agreed. A stretched glyph is wider, heavier AND softer, which is why the report read as "not
 * crisp" and survived four other explanations.
 *
 * Nothing recovered from it: a font change rebuilt the context and a dpr change rebuilt it, but a
 * cell that simply disagreed only logged a warning — and a project switch deliberately does not
 * rebuild, so the wrong page outlived everything short of an app restart.
 */
describe('atlas cell drift', () => {
  it('is a rebuild, not a warning', () => {
    // The heights agreeing while the widths do not is the exact field shape, and the reason the
    // symptom looked like blur rather than like geometry.
    expect(cellsDisagree({ cellW: 16, cellH: 36 }, { cellW: 16.79998779296875, cellH: 36 })).toBe(
      true
    )
  })

  it('ignores float noise, so an ordinary canvas never rebuilds', () => {
    // Two terminals measuring the same cell must not fight over it; the field dump had per-node
    // residuals in the fourth decimal.
    expect(cellsDisagree({ cellW: 16.8, cellH: 36 }, { cellW: 16.800001, cellH: 36 })).toBe(false)
    expect(cellsDisagree({ cellW: 16.8, cellH: 36 }, { cellW: 16.8, cellH: 36 })).toBe(false)
  })

  it('catches a HEIGHT-only disagreement too', () => {
    expect(cellsDisagree({ cellW: 16.8, cellH: 36 }, { cellW: 16.8, cellH: 38 })).toBe(true)
  })
})

/**
 * The drift rebuild's loop guard, and the half of it that was missing: it was reset ONLY by a font
 * change, so the FIRST drift in a session spent the allowance for the rest of that session.
 *
 * The consequence is a terminal that stays resampled — soft, 5% wide — for as long as the app runs,
 * even though the cause is long gone. The field shape: a webfont resolves after a dpr rebuild has
 * latched a fallback face's cell, the drift is genuine, and it is answered with a console warning
 * instead of the rebuild it deserves.
 */
describe('createCellRebuildGuard', () => {
  it('allows one drift rebuild per epoch and refuses the second', () => {
    const guard = createCellRebuildGuard()
    expect(guard.allowRebuild()).toBe(true)
    expect(guard.allowRebuild()).toBe(false)
    expect(guard.allowRebuild()).toBe(false)
  })

  it('does NOT restore its own allowance — that is what stops a rebuild ping-pong', () => {
    // The rebuild the guard permits goes through the same funnel a font change does, so if that
    // funnel began a new epoch unconditionally the guard would re-arm itself and two terminals with
    // genuinely different cells would hand the atlas back and forth forever, one rebuild per
    // registration, with the canvas never painting.
    const guard = createCellRebuildGuard()
    guard.allowRebuild()
    expect(guard.allowRebuild()).toBe(false)
  })

  it('re-arms on a new epoch, so a LATER genuine drift is still answered', () => {
    const guard = createCellRebuildGuard()
    expect(guard.allowRebuild()).toBe(true)
    expect(guard.allowRebuild()).toBe(false)
    // A font change, a dpr rebuild, the mode being switched back on: the old measurement is
    // meaningless and the next terminal's cell is a fresh question.
    guard.beginEpoch()
    expect(guard.allowRebuild()).toBe(true)
  })

  it('logs the give-up once per epoch, not once per registration', () => {
    const guard = createCellRebuildGuard()
    guard.allowRebuild()
    expect(guard.takeWarning()).toBe(true)
    expect(guard.takeWarning()).toBe(false)
    guard.beginEpoch()
    expect(guard.takeWarning()).toBe(true)
  })

  it('starts an epoch armed, so the very first drift on a fresh context rebuilds', () => {
    expect(createCellRebuildGuard().allowRebuild()).toBe(true)
  })
})
