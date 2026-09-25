import { describe, it, expect } from 'vitest'
import { arrangeNodes, alignNodes, arrangeByLineage, lineageLayers, type CanvasNode } from './workspace'

// Minimal node stub: only the fields the layout fns read (id, position, width/height, parentId).
const n = (id: string, x: number, y: number, w = 100, h = 50): CanvasNode =>
  ({ id, type: 'terminal', position: { x, y }, width: w, height: h, data: { title: id, color: '#fff', group: null } }) as CanvasNode

describe('arrangeNodes', () => {
  it('lays out a row left-to-right from the bounding-box origin with the gap', () => {
    const out = arrangeNodes([n('a', 50, 90), n('b', 10, 200)], ['a', 'b'], { layout: 'row', gap: 20 })
    const a = out.find((x) => x.id === 'a')!
    const b = out.find((x) => x.id === 'b')!
    // origin = bounding-box top-left of current positions = (10, 90)
    expect(a.position).toEqual({ x: 10, y: 90 })
    expect(b.position).toEqual({ x: 10 + 100 + 20, y: 90 })
  })

  it('lays out a column top-to-bottom', () => {
    const out = arrangeNodes([n('a', 0, 0), n('b', 300, 300)], ['a', 'b'], { layout: 'column', gap: 10 })
    expect(out.find((x) => x.id === 'a')!.position).toEqual({ x: 0, y: 0 })
    expect(out.find((x) => x.id === 'b')!.position).toEqual({ x: 0, y: 50 + 10 })
  })

  it('grid wraps at cols and rows advance by the tallest node in the row', () => {
    const out = arrangeNodes(
      [n('a', 0, 0, 100, 50), n('b', 0, 0, 100, 80), n('c', 0, 0, 100, 50)],
      ['a', 'b', 'c'],
      { layout: 'grid', cols: 2, gap: 10, origin: { x: 0, y: 0 } }
    )
    expect(out.find((x) => x.id === 'a')!.position).toEqual({ x: 0, y: 0 })
    expect(out.find((x) => x.id === 'b')!.position).toEqual({ x: 110, y: 0 })
    // row 2 starts below the tallest of row 1 (80) + gap
    expect(out.find((x) => x.id === 'c')!.position).toEqual({ x: 0, y: 90 })
  })

  it('refuses a set mixing containers, and no-ops an empty/ghost selection', () => {
    // A top-level node + a group child cannot be co-arranged (their coordinate spaces differ),
    // so a MIXED set is a deliberate no-op — NOT "silently arrange the top-level ones" (that
    // silent subset-arrange was the surprise this replaced). Same for unknown ids.
    const child = { ...n('kid', 5, 5), parentId: 'g1' } as CanvasNode
    const nodes = [n('a', 7, 7), child]
    expect(arrangeNodes(nodes, ['a', 'kid', 'ghost'], { layout: 'row', origin: { x: 0, y: 0 } })).toBe(nodes)
    expect(arrangeNodes(nodes, ['ghost'])).toBe(nodes) // nothing resolvable → same array
    // Same-container sets still arrange: two children of one frame lay out in frame space.
    const framed = [
      { ...n('c1', 40, 40), parentId: 'g1' } as CanvasNode,
      { ...n('c2', 300, 5), parentId: 'g1' } as CanvasNode
    ]
    const laid = arrangeNodes(framed, ['c1', 'c2'], { layout: 'row', gap: 20 })
    expect(laid.find((x) => x.id === 'c1')!.position).toEqual({ x: 40, y: 5 })
    expect(laid.find((x) => x.id === 'c2')!.position).toEqual({ x: 40 + 100 + 20, y: 5 })
  })
})

describe('alignNodes', () => {
  const pair = () => [n('a', 10, 20, 100, 50), n('b', 200, 300, 60, 80)]
  it('left aligns x to the min x', () => {
    const out = alignNodes(pair(), ['a', 'b'], 'left')
    expect(out.map((x) => x.position.x)).toEqual([10, 10])
  })
  it('right aligns right edges to the max right edge', () => {
    const out = alignNodes(pair(), ['a', 'b'], 'right')
    // max right = 200+60=260 → a.x=260-100=160, b.x=200
    expect(out.find((x) => x.id === 'a')!.position.x).toBe(160)
    expect(out.find((x) => x.id === 'b')!.position.x).toBe(200)
  })
  it('vcenter aligns vertical centers; hcenter aligns horizontal centers', () => {
    const v = alignNodes(pair(), ['a', 'b'], 'vcenter')
    // bbox y: 20..380 → center 200 → a.y=200-25=175, b.y=200-40=160
    expect(v.find((x) => x.id === 'a')!.position.y).toBe(175)
    expect(v.find((x) => x.id === 'b')!.position.y).toBe(160)
    const h = alignNodes(pair(), ['a', 'b'], 'hcenter')
    // bbox x: 10..260 → center 135 → a.x=85, b.x=105
    expect(h.find((x) => x.id === 'a')!.position.x).toBe(85)
    expect(h.find((x) => x.id === 'b')!.position.x).toBe(105)
  })
  it('unknown ids only → same array', () => {
    const nodes = pair()
    expect(alignNodes(nodes, ['ghost'], 'left')).toBe(nodes)
  })
})

// A frame and its children: a rope routinely ends on a node INSIDE a frame, and the frame is the
// top-level object a layer layout has to place.
const frame = (id: string, x: number, y: number, w = 300, h = 200): CanvasNode =>
  ({ id, type: 'group', position: { x, y }, width: w, height: h, data: { title: id, color: '#fff', group: null } }) as CanvasNode
const child = (id: string, parentId: string, x = 10, y = 10): CanvasNode =>
  ({ id, type: 'terminal', position: { x, y }, width: 100, height: 50, parentId, data: { title: id, color: '#fff', group: null } }) as CanvasNode

describe('lineageLayers', () => {
  it('layers by who opened whom, roots first', () => {
    const nodes = [n('coord', 0, 0), n('arch', 500, 0), n('coder', 500, 200), n('rev', 900, 0)]
    const { layers, loose } = lineageLayers(nodes, [
      { source: 'coord', target: 'arch' },
      { source: 'coord', target: 'coder' },
      { source: 'arch', target: 'rev' }
    ])
    expect(layers).toEqual([['coord'], ['arch', 'coder'], ['rev']])
    expect(loose).toEqual([])
  })

  it('lifts a rope that lands inside a frame up to the frame itself', () => {
    // The coordinator opens a team into a group: the rope ends on `a1`, but `g1` is what moves.
    const nodes = [n('coord', 0, 0), frame('g1', 500, 0), child('a1', 'g1'), child('a2', 'g1')]
    const { layers, loose } = lineageLayers(nodes, [{ source: 'coord', target: 'a1' }])
    expect(layers).toEqual([['coord'], ['g1']])
    expect(loose).toEqual([])
  })

  it('drops a rope internal to one frame', () => {
    // a1 opened a2 inside the same group: both lift to g1, which cannot be its own opener.
    const nodes = [n('other', 0, 0), frame('g1', 500, 0), child('a1', 'g1'), child('a2', 'g1')]
    const { layers, loose } = lineageLayers(nodes, [{ source: 'a1', target: 'a2' }])
    expect(layers).toEqual([])
    expect(loose).toEqual(['other', 'g1'])
  })

  // c is opened by a AND by b: the shortest path would put c in layer 1 beside b, and the
  // a-to-c rope would then run sideways instead of down. Asserted in BOTH edge orders on
  // purpose: ropes arrive in creation order out of project.json, and a reducer that keeps the
  // LAST opener instead of the deepest one happens to be right in one of the two orders.
  it.each([
    ['deepest opener last', [{ source: 'a', target: 'c' }, { source: 'b', target: 'c' }]],
    ['deepest opener first', [{ source: 'b', target: 'c' }, { source: 'a', target: 'c' }]]
  ])('uses the LONGEST path, so every rope points downward (%s)', (_label, tail) => {
    const nodes = [n('a', 0, 0), n('b', 300, 0), n('c', 600, 0)]
    const { layers } = lineageLayers(nodes, [{ source: 'a', target: 'b' }, ...tail])
    expect(layers).toEqual([['a'], ['b'], ['c']])
  })

  it('keeps untouched nodes out of layer 0, in their own loose band', () => {
    const nodes = [n('coord', 0, 0), n('agent', 300, 0), n('note', 0, 400), n('editor', 300, 400)]
    const { layers, loose } = lineageLayers(nodes, [{ source: 'coord', target: 'agent' }])
    expect(layers).toEqual([['coord'], ['agent']])
    expect(loose).toEqual(['note', 'editor'])
  })

  it('orders a layer by the slot of its opener above, so siblings sit together', () => {
    // Two roots with two children each, interleaved on the canvas: without the slot ordering the
    // children alternate p1,p2,p1,p2 and every rope crosses.
    const nodes = [
      n('p1', 0, 0),
      n('p2', 400, 0),
      n('b1', 600, 300),
      n('a1', 0, 300),
      n('b2', 900, 300),
      n('a2', 300, 300)
    ]
    const { layers } = lineageLayers(nodes, [
      { source: 'p1', target: 'a1' },
      { source: 'p2', target: 'b1' },
      { source: 'p1', target: 'a2' },
      { source: 'p2', target: 'b2' }
    ])
    expect(layers[0]).toEqual(['p1', 'p2'])
    expect(layers[1]).toEqual(['a1', 'a2', 'b1', 'b2'])
  })

  it('does not hang on a cycle', () => {
    const nodes = [n('a', 0, 0), n('b', 300, 0), n('c', 600, 0)]
    const { layers, loose } = lineageLayers(nodes, [
      { source: 'a', target: 'b' },
      { source: 'b', target: 'c' },
      { source: 'c', target: 'a' }
    ])
    // Every node is still placed exactly once and nothing is lost.
    expect([...layers.flat(), ...loose].sort()).toEqual(['a', 'b', 'c'])
  })

  it('ignores a rope whose endpoint is no longer on the canvas', () => {
    const nodes = [n('a', 0, 0), n('b', 300, 0)]
    const { layers, loose } = lineageLayers(nodes, [{ source: 'ghost', target: 'b' }])
    expect(layers).toEqual([])
    expect(loose).toEqual(['a', 'b'])
  })
})

describe('arrangeByLineage', () => {
  const edges = [
    { source: 'coord', target: 'arch' },
    { source: 'coord', target: 'coder' }
  ]

  it('stacks each layer as a row, growing downward from the bounding-box origin', () => {
    const nodes = [n('coord', 100, 50), n('arch', 900, 400), n('coder', 500, 900)]
    const out = arrangeByLineage(nodes, edges, { gap: 20 })
    const at = (id: string) => out.find((x) => x.id === id)!.position
    // origin = (100, 50); layer 0 holds one 50-high node, so layer 1 starts at 50 + 50 + 20.
    expect(at('coord')).toEqual({ x: 100, y: 50 })
    expect(at('arch')).toEqual({ x: 100, y: 120 })
    expect(at('coder')).toEqual({ x: 100 + 100 + 20, y: 120 })
  })

  it('puts the loose band last', () => {
    const nodes = [n('coord', 0, 0), n('arch', 300, 0), n('coder', 600, 0), n('note', 0, 500)]
    const out = arrangeByLineage(nodes, edges, { gap: 20 })
    const y = (id: string) => out.find((x) => x.id === id)!.position.y
    expect(y('note')).toBeGreaterThan(y('arch'))
  })

  it('advances by the TALLEST member of a band', () => {
    // The frame in layer 0 is 200 high; the next band must clear it, not the 50 of a terminal.
    const nodes = [frame('g1', 0, 0), child('a1', 'g1'), n('other', 400, 0), n('kid', 0, 900)]
    const out = arrangeByLineage(nodes, [{ source: 'a1', target: 'kid' }], { gap: 20 })
    expect(out.find((x) => x.id === 'kid')!.position.y).toEqual(0 + 200 + 20)
  })

  it('moves a frame as one unit and leaves its children alone', () => {
    const nodes = [n('coord', 0, 0), frame('g1', 800, 600), child('a1', 'g1', 10, 10)]
    const out = arrangeByLineage(nodes, [{ source: 'coord', target: 'a1' }], { gap: 20 })
    expect(out.find((x) => x.id === 'g1')!.position).toEqual({ x: 0, y: 70 })
    // A child position is relative to its frame and must not be rewritten.
    expect(out.find((x) => x.id === 'a1')!.position).toEqual({ x: 10, y: 10 })
  })

  it('returns the SAME array when no rope is usable', () => {
    // The caller skips the undo entry and the project.json write rather than rewriting every
    // position to where it already was.
    const nodes = [n('a', 0, 0), n('b', 300, 0)]
    expect(arrangeByLineage(nodes, [])).toBe(nodes)
  })

  it('returns the SAME array below two top-level nodes', () => {
    const one = [n('a', 0, 0)]
    expect(arrangeByLineage(one, edges)).toBe(one)
  })
})
