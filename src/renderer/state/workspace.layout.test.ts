import { describe, it, expect } from 'vitest'
import {
  arrangeNodes,
  alignNodes,
  arrangeByLineage,
  arrangeGroupChildren,
  fitGroupToChildren,
  groupArrangeRefusal,
  lineageLayers,
  GROUP_PAD,
  GROUP_HEADER,
  type CanvasNode
} from './workspace'

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

describe('placement order', () => {
  // `arrangeNodes` used to fill its slots in ARRAY order and ignore the order of the ids it was
  // handed, which silently discarded every caller's sort: Tidy canvas's reading order, and the
  // slot order `lineageLayers` computes so siblings sit under their opener.
  it('arrangeNodes fills its slots in the order of the ids, not in array order', () => {
    const out = arrangeNodes([n('a', 0, 0), n('b', 300, 0)], ['b', 'a'], {
      layout: 'row',
      gap: 10,
      origin: { x: 0, y: 0 }
    })
    expect(out.find((x) => x.id === 'b')!.position).toEqual({ x: 0, y: 0 })
    expect(out.find((x) => x.id === 'a')!.position).toEqual({ x: 110, y: 0 })
    // The array itself is not reordered: persistence order is not the layout's to change.
    expect(out.map((x) => x.id)).toEqual(['a', 'b'])
  })

  it('a repeated id takes one slot', () => {
    const out = arrangeNodes([n('a', 0, 0), n('b', 300, 0)], ['a', 'a', 'b'], {
      layout: 'row',
      gap: 10,
      origin: { x: 0, y: 0 }
    })
    expect(out.find((x) => x.id === 'b')!.position.x).toBe(110)
  })

  it('arrangeByLineage PLACES siblings under their opener, not in array order', () => {
    // The same interleaved canvas as the lineageLayers slot test, asserted on positions: the
    // layer order is only worth computing if the placement honours it.
    const nodes = [
      n('p1', 0, 0),
      n('p2', 400, 0),
      n('b1', 600, 300),
      n('a1', 0, 300),
      n('b2', 900, 300),
      n('a2', 300, 300)
    ]
    const out = arrangeByLineage(
      nodes,
      [
        { source: 'p1', target: 'a1' },
        { source: 'p2', target: 'b1' },
        { source: 'p1', target: 'a2' },
        { source: 'p2', target: 'b2' }
      ],
      { gap: 10 }
    )
    const row = out
      .filter((x) => x.position.y > 0)
      .sort((x, y) => x.position.x - y.position.x)
      .map((x) => x.id)
    expect(row).toEqual(['a1', 'a2', 'b1', 'b2'])
  })
})

// A frame nested in another frame.
const inner = (id: string, parentId: string, x: number, y: number, w = 300, h = 200): CanvasNode =>
  ({ ...frame(id, x, y, w, h), parentId }) as CanvasNode
const at = (nodes: CanvasNode[], id: string) => nodes.find((x) => x.id === id)!
/** `kid` lies fully inside `parent` (kid positions are parent-relative). */
const holds = (nodes: CanvasNode[], parent: string, kid: string): boolean => {
  const p = at(nodes, parent)
  const k = at(nodes, kid)
  return (
    k.position.x >= 0 &&
    k.position.y >= 0 &&
    k.position.x + (k.width as number) <= (p.width as number) &&
    k.position.y + (k.height as number) <= (p.height as number)
  )
}

describe('lineageLayers inside a frame', () => {
  it('layers the frame\'s direct children and ignores a rope from outside it', () => {
    // `coord` opened the whole team from outside the frame: that says nothing about the order
    // INSIDE it, so only a1→a2 / a1→a3 count.
    const nodes = [n('coord', 0, 0), frame('g1', 500, 0), child('a1', 'g1'), child('a2', 'g1', 200), child('a3', 'g1', 400), child('note', 'g1', 0, 300)]
    const { layers, loose } = lineageLayers(
      nodes,
      [
        { source: 'coord', target: 'a1' },
        { source: 'a1', target: 'a2' },
        { source: 'a1', target: 'a3' }
      ],
      'g1'
    )
    expect(layers).toEqual([['a1'], ['a2', 'a3']])
    expect(loose).toEqual(['note'])
  })

  it('lifts a rope that lands inside a NESTED frame up to that frame', () => {
    const nodes = [frame('g1', 0, 0), child('a1', 'g1'), inner('in', 'g1', 200, 0), child('k', 'in')]
    const { layers } = lineageLayers(nodes, [{ source: 'a1', target: 'k' }], 'g1')
    expect(layers).toEqual([['a1'], ['in']])
  })

  it('the top level is unchanged by the container parameter', () => {
    const nodes = [n('coord', 0, 0), frame('g1', 500, 0), child('a1', 'g1'), child('a2', 'g1')]
    const edges = [{ source: 'coord', target: 'a1' }]
    expect(lineageLayers(nodes, edges)).toEqual(lineageLayers(nodes, edges, null))
  })
})

describe('arrangeGroupChildren', () => {
  // g1 sits at (500, 300); its three children are scattered, one of them outside the frame.
  const scattered = () => [
    frame('g1', 500, 300, 300, 200),
    child('c1', 'g1', 200, 150),
    child('c2', 'g1', 10, 20),
    child('c3', 'g1', 400, 400)
  ]

  it('packs the children in reading order from the frame\'s content origin', () => {
    const out = arrangeGroupChildren(scattered(), 'g1')
    // 3 children → 2 columns; reading order is c2 (y 20), c1 (y 150), c3 (y 400).
    expect(at(out, 'c2').position).toEqual({ x: GROUP_PAD, y: GROUP_PAD + GROUP_HEADER })
    expect(at(out, 'c1').position).toEqual({ x: GROUP_PAD + 100 + 40, y: GROUP_PAD + GROUP_HEADER })
    expect(at(out, 'c3').position).toEqual({ x: GROUP_PAD, y: GROUP_PAD + GROUP_HEADER + 50 + 40 })
  })

  it('keeps the frame\'s own top-left where it was and sizes it to the content', () => {
    const out = arrangeGroupChildren(scattered(), 'g1')
    const g = at(out, 'g1')
    expect(g.position).toEqual({ x: 500, y: 300 })
    // 2 columns of 100 + one 40 gap, 2 rows of 50 + one 40 gap, padded on every side + header.
    expect(g.width).toBe(240 + GROUP_PAD * 2)
    expect(g.height).toBe(140 + GROUP_PAD * 2 + GROUP_HEADER)
    expect(g.style).toMatchObject({ width: g.width, height: g.height })
    for (const id of ['c1', 'c2', 'c3']) expect(holds(out, 'g1', id)).toBe(true)
  })

  it('GROWS a frame whose content does not fit it', () => {
    // Six children in a column are far taller than the 200-high frame.
    const nodes = [frame('g1', 0, 0, 300, 200), ...[0, 1, 2, 3, 4, 5].map((i) => child(`c${i}`, 'g1', 10, 10 + i * 5))]
    const out = arrangeGroupChildren(nodes, 'g1', { layout: 'column' })
    expect(at(out, 'g1').height).toBe(6 * 50 + 5 * 40 + GROUP_PAD * 2 + GROUP_HEADER)
    expect((at(out, 'g1').height as number) > 200).toBe(true)
    for (let i = 0; i < 6; i++) expect(holds(out, 'g1', `c${i}`)).toBe(true)
  })

  it('SHRINKS a frame that was sized to where its children used to be', () => {
    const nodes = [frame('g1', 0, 0, 2000, 1500), child('c1', 'g1', 1700, 1300), child('c2', 'g1', 50, 80)]
    const out = arrangeGroupChildren(nodes, 'g1', { layout: 'row' })
    expect(at(out, 'g1').width).toBe(240 + GROUP_PAD * 2)
    expect(at(out, 'g1').position).toEqual({ x: 0, y: 0 })
  })

  it('honours --cols', () => {
    const nodes = [frame('g1', 0, 0), ...[0, 1, 2, 3].map((i) => child(`c${i}`, 'g1', 10 + i * 5, 10))]
    const out = arrangeGroupChildren(nodes, 'g1', { layout: 'grid', cols: 4 })
    expect(new Set(['c0', 'c1', 'c2', 'c3'].map((id) => at(out, id).position.y)).size).toBe(1)
  })

  it('moves a nested frame as one rigid unit', () => {
    const nodes = [frame('g1', 0, 0, 900, 700), child('t', 'g1', 600, 400), inner('in', 'g1', 500, 20), child('k', 'in', 33, 44)]
    const out = arrangeGroupChildren(nodes, 'g1', { layout: 'row' })
    // `in` is a member and is placed; what is inside it is not the outer frame's to touch.
    expect(at(out, 'in').position).toEqual({ x: GROUP_PAD, y: GROUP_PAD + GROUP_HEADER })
    expect(at(out, 'in').width).toBe(300)
    expect(at(out, 'k').position).toEqual({ x: 33, y: 44 })
    expect(at(out, 't').position.x).toBe(GROUP_PAD + 300 + 40)
  })

  it('re-fits EVERY ancestor frame, so a nested frame never overflows its parent', () => {
    // top ⊃ mid ⊃ g1. Arranging g1's six children as a row makes it far wider than both.
    const nodes = [
      frame('top', 100, 100, 500, 400),
      inner('mid', 'top', GROUP_PAD, GROUP_PAD + GROUP_HEADER, 400, 300),
      inner('g1', 'mid', GROUP_PAD, GROUP_PAD + GROUP_HEADER, 300, 200),
      ...[0, 1, 2, 3, 4, 5].map((i) => child(`c${i}`, 'g1', 10, 10 + i * 5))
    ]
    const out = arrangeGroupChildren(nodes, 'g1', { layout: 'row' })
    expect(at(out, 'g1').width).toBe(6 * 100 + 5 * 40 + GROUP_PAD * 2)
    expect(holds(out, 'mid', 'g1')).toBe(true)
    expect(holds(out, 'top', 'mid')).toBe(true)
    // Nothing jumped: the outermost frame is where it was, and so is everything's root position.
    expect(at(out, 'top').position).toEqual({ x: 100, y: 100 })
    expect(at(out, 'mid').position).toEqual({ x: GROUP_PAD, y: GROUP_PAD + GROUP_HEADER })
    expect(at(out, 'g1').position).toEqual({ x: GROUP_PAD, y: GROUP_PAD + GROUP_HEADER })
  })

  it('fitting only the frame itself is NOT enough (the mutation this guards)', () => {
    // The same tree, fitted without the walk up: g1 ends up wider than the frame holding it.
    const nodes = [
      frame('top', 100, 100, 500, 400),
      inner('g1', 'top', GROUP_PAD, GROUP_PAD + GROUP_HEADER, 300, 200),
      ...[0, 1, 2, 3, 4, 5].map((i) => child(`c${i}`, 'g1', 10, 10 + i * 5))
    ]
    const ids = ['c0', 'c1', 'c2', 'c3', 'c4', 'c5']
    const onlyOwn = fitGroupToChildren(arrangeNodes(nodes, ids, { layout: 'row' }), 'g1')
    expect(holds(onlyOwn, 'top', 'g1')).toBe(false)
    expect(holds(arrangeGroupChildren(nodes, 'g1', { layout: 'row' }), 'top', 'g1')).toBe(true)
  })

  it('lays the children out as lineage bands and sizes the frame to them', () => {
    const nodes = [frame('g1', 40, 40, 300, 200), child('a2', 'g1', 250, 10), child('a1', 'g1', 10, 300), child('a3', 'g1', 400, 10)]
    const out = arrangeGroupChildren(nodes, 'g1', {
      layout: 'lineage',
      edges: [
        { source: 'a1', target: 'a2' },
        { source: 'a1', target: 'a3' }
      ]
    })
    const top = GROUP_PAD + GROUP_HEADER
    expect(at(out, 'a1').position).toEqual({ x: GROUP_PAD, y: top })
    expect(at(out, 'a2').position).toEqual({ x: GROUP_PAD, y: top + 50 + 40 })
    expect(at(out, 'a3').position).toEqual({ x: GROUP_PAD + 100 + 40, y: top + 50 + 40 })
    expect(at(out, 'g1').position).toEqual({ x: 40, y: 40 })
    for (const id of ['a1', 'a2', 'a3']) expect(holds(out, 'g1', id)).toBe(true)
  })

  it('with snapping on, keeps a frame that is on the grid on it', () => {
    const GRID = 40
    const nodes = [frame('g1', 400, 200, 320, 200), child('c1', 'g1', 200, 150), child('c2', 'g1', 10, 20)]
    const out = arrangeGroupChildren(nodes, 'g1', { layout: 'row', grid: GRID })
    const g = at(out, 'g1')
    expect(g.position).toEqual({ x: 400, y: 200 })
    expect((g.width as number) % GRID).toBe(0)
    expect((g.height as number) % GRID).toBe(0)
    expect(holds(out, 'g1', 'c1') && holds(out, 'g1', 'c2')).toBe(true)
  })

  describe('returns the SAME array when there is nothing to do', () => {
    it('a missing id, a non-group id and an empty frame', () => {
      const nodes = [frame('g1', 0, 0), n('t', 500, 0)]
      expect(arrangeGroupChildren(nodes, 'ghost')).toBe(nodes)
      expect(arrangeGroupChildren(nodes, 't')).toBe(nodes)
      expect(arrangeGroupChildren(nodes, 'g1')).toBe(nodes)
    })

    it('a lineage layout with no rope joining two of the children', () => {
      const nodes = [n('coord', 0, 0), frame('g1', 500, 0), child('a1', 'g1'), child('a2', 'g1', 200)]
      // The only rope comes from outside the frame.
      expect(
        arrangeGroupChildren(nodes, 'g1', { layout: 'lineage', edges: [{ source: 'coord', target: 'a1' }] })
      ).toBe(nodes)
    })

    it('a frame that is already arranged — a second run moves nothing', () => {
      // No undo entry and no project.json write for a click that visibly did nothing.
      const once = arrangeGroupChildren(
        [frame('g1', 500, 300, 300, 200), child('c1', 'g1', 200, 150), child('c2', 'g1', 10, 20)],
        'g1'
      )
      expect(arrangeGroupChildren(once, 'g1')).toBe(once)
    })
  })
})

describe('groupArrangeRefusal', () => {
  const nodes = [n('t', 0, 0), frame('empty', 0, 0), frame('g1', 500, 0), child('a1', 'g1'), child('a2', 'g1', 200)]
  it('names each reason, and is null when the layout can run', () => {
    expect(groupArrangeRefusal(nodes, 'ghost', 'grid')).toBe('no group frame has the id ghost')
    expect(groupArrangeRefusal(nodes, 't', 'grid')).toBe('no group frame has the id t')
    expect(groupArrangeRefusal(nodes, 'empty', 'grid')).toBe('this group is empty')
    expect(groupArrangeRefusal(nodes, 'g1', 'grid')).toBeNull()
    expect(groupArrangeRefusal(nodes, 'g1', 'lineage')).toBe('nothing in this group was opened by another node in it')
    expect(groupArrangeRefusal(nodes, 'g1', 'lineage', [{ source: 'a1', target: 'a2' }])).toBeNull()
  })

  it('agrees with the transform: a refusal is exactly a same-array result', () => {
    for (const id of ['ghost', 't', 'empty']) expect(arrangeGroupChildren(nodes, id)).toBe(nodes)
    expect(arrangeGroupChildren(nodes, 'g1')).not.toBe(nodes)
  })
})
