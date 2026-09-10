import { describe, it, expect } from 'vitest'
import {
  addSelectionToGroup,
  alignNodes,
  arrangeNodes,
  commonParentId,
  createAccountLoginNode,
  createCodexAccountLoginNode,
  createAgentNode,
  createDinoNode,
  createSystemLoginNode,
  isAccountLoginNode,
  fitGroupToChildren,
  flowToNodeStates,
  groupSelectedNodes,
  nodeStatesToFlow,
  nodeSshFor,
  reorderGroupWithinParent,
  reorderNodeBefore,
  reparentNode,
  resolveNewNodeAccount,
  selectedRootIds,
  ungroupNodes
} from './workspace'
import type { CanvasNode } from './workspace'
import type { Project } from '@shared/types'

const term = (id: string, pos: { x: number; y: number }, parentId?: string): CanvasNode =>
  ({
    id,
    type: 'terminal',
    position: pos,
    width: 320,
    height: 240,
    data: { title: id, color: '#888', group: null },
    ...(parentId ? { parentId, extent: 'parent' as const } : {})
  }) as unknown as CanvasNode

const grp = (id: string, pos: { x: number; y: number }, parentId?: string): CanvasNode =>
  ({
    id,
    type: 'group',
    position: pos,
    width: 400,
    height: 300,
    data: { title: id, color: '#fff', group: null },
    ...(parentId ? { parentId, extent: 'parent' as const } : {})
  }) as unknown as CanvasNode

describe('reparentNode', () => {
  it('adds a top-level node to a group with a group-relative position', () => {
    const nodes = [term('t1', { x: 200, y: 150 }), grp('g1', { x: 50, y: 50 })]
    const out = reparentNode(nodes, 't1', 'g1')
    const t1 = out.find((n) => n.id === 't1')!
    expect(t1.parentId).toBe('g1')
    expect(t1.extent).toBe('parent')
    expect(t1.position).toEqual({ x: 150, y: 100 })
  })

  it('removes a node from its group, restoring the absolute position', () => {
    const nodes = [grp('g1', { x: 50, y: 50 }), term('t1', { x: 10, y: 10 }, 'g1')]
    const out = reparentNode(nodes, 't1', null)
    const t1 = out.find((n) => n.id === 't1')!
    expect(t1.parentId).toBeUndefined()
    expect(t1.extent).toBeUndefined()
    expect(t1.position).toEqual({ x: 60, y: 60 })
  })

  it('orders group nodes before their children', () => {
    const nodes = [term('t1', { x: 200, y: 150 }), grp('g1', { x: 50, y: 50 })]
    const out = reparentNode(nodes, 't1', 'g1')
    expect(out.findIndex((n) => n.id === 'g1')).toBeLessThan(out.findIndex((n) => n.id === 't1'))
  })

  it('is a no-op when the node is already in the target group', () => {
    const nodes = [grp('g1', { x: 50, y: 50 }), term('t1', { x: 10, y: 10 }, 'g1')]
    expect(reparentNode(nodes, 't1', 'g1')).toBe(nodes)
  })

  it('is a no-op when the node is missing or the target is not a group', () => {
    const nodes = [grp('g1', { x: 50, y: 50 }), term('t1', { x: 10, y: 10 })]
    expect(reparentNode(nodes, 'nope', 'g1')).toBe(nodes)
    expect(reparentNode(nodes, 't1', 't1')).toBe(nodes) // target is a terminal, not a group
  })

  it('moves a whole group subtree between nested containers without moving it in root space', () => {
    const nodes = [
      grp('outer', { x: 100, y: 80 }),
      grp('inner', { x: 30, y: 40 }, 'outer'),
      term('leaf', { x: 10, y: 12 }, 'inner'),
      grp('target', { x: 500, y: 200 })
    ]
    const out = reparentNode(nodes, 'inner', 'target')
    const inner = out.find((node) => node.id === 'inner')!
    expect(inner.parentId).toBe('target')
    expect(inner.position).toEqual({ x: -370, y: -80 })
    expect(out.find((node) => node.id === 'leaf')!.position).toEqual({ x: 10, y: 12 })
    expect(out.findIndex((node) => node.id === 'target')).toBeLessThan(
      out.findIndex((node) => node.id === 'inner')
    )
  })

  it('rejects parenting a group into itself or one of its descendants', () => {
    const nodes = [grp('outer', { x: 0, y: 0 }), grp('inner', { x: 20, y: 20 }, 'outer')]
    expect(reparentNode(nodes, 'outer', 'outer')).toBe(nodes)
    expect(reparentNode(nodes, 'outer', 'inner')).toBe(nodes)
  })
})

describe('addSelectionToGroup', () => {
  it('adds selected sibling objects to the already selected group', () => {
    const nodes = [
      grp('target', { x: 100, y: 80 }),
      term('a', { x: 500, y: 200 }),
      term('b', { x: 700, y: 300 })
    ]
    const out = addSelectionToGroup(nodes, ['target', 'a', 'b'], 'target')
    expect(out.find((node) => node.id === 'a')!.parentId).toBe('target')
    expect(out.find((node) => node.id === 'b')!.parentId).toBe('target')
    // Root-space positions are unchanged: the frame was re-fitted around its new children, so
    // frame origin + child offset still lands on the node's old absolute position.
    const target = out.find((node) => node.id === 'target')!
    const a = out.find((node) => node.id === 'a')!
    expect(target.position.x + a.position.x).toBe(500)
    expect(target.position.y + a.position.y).toBe(200)
  })

  it('moves only a selected subtree root and rejects cycles through reparenting', () => {
    const nodes = [
      grp('target', { x: 500, y: 200 }),
      grp('outer', { x: 100, y: 80 }),
      term('leaf', { x: 10, y: 12 }, 'outer')
    ]
    const out = addSelectionToGroup(nodes, ['target', 'outer', 'leaf'], 'target')
    expect(out.find((node) => node.id === 'outer')!.parentId).toBe('target')
    expect(out.find((node) => node.id === 'leaf')!.parentId).toBe('outer')
    const nested = [grp('outer', { x: 0, y: 0 }), grp('target', { x: 20, y: 20 }, 'outer')]
    expect(addSelectionToGroup(nested, ['outer', 'target'], 'target')).toBe(nested)
  })

  it('is a no-op without a valid target or movable selected object', () => {
    const nodes = [grp('target', { x: 0, y: 0 }), term('inside', { x: 10, y: 10 }, 'target')]
    expect(addSelectionToGroup(nodes, ['target', 'inside'], 'target')).toBe(nodes)
    expect(addSelectionToGroup(nodes, ['target'], 'missing')).toBe(nodes)
  })
})

describe('selectedRootIds', () => {
  it('normalizes box-selected group subtrees to their selected roots', () => {
    const nodes = [
      grp('outer', { x: 0, y: 0 }),
      grp('inner', { x: 10, y: 10 }, 'outer'),
      term('leaf', { x: 5, y: 5 }, 'inner'),
      grp('sibling', { x: 500, y: 0 })
    ]
    expect(selectedRootIds(nodes, ['outer', 'inner', 'leaf', 'sibling'])).toEqual([
      'outer',
      'sibling'
    ])
  })

  it('drops unknown ids and preserves independent selection order', () => {
    const nodes = [term('a', { x: 0, y: 0 }), term('b', { x: 10, y: 10 })]
    expect(selectedRootIds(nodes, ['missing', 'b', 'a'])).toEqual(['b', 'a'])
  })
})

describe('commonParentId', () => {
  it('is null when every id is top-level', () => {
    const nodes = [term('t1', { x: 0, y: 0 }), grp('g1', { x: 5, y: 5 })]
    expect(commonParentId(nodes, ['t1', 'g1'])).toBeNull()
  })
  it('is the group id when every id is a child of the same group', () => {
    const nodes = [grp('g1', { x: 0, y: 0 }), term('t1', { x: 10, y: 10 }, 'g1'), term('t2', { x: 20, y: 20 }, 'g1')]
    expect(commonParentId(nodes, ['t1', 't2'])).toBe('g1')
  })
  it('is undefined for a mixed set (framed + loose, or two frames) or no matching ids', () => {
    const nodes = [
      grp('g1', { x: 0, y: 0 }),
      term('t1', { x: 10, y: 10 }, 'g1'),
      term('loose', { x: 500, y: 0 })
    ]
    expect(commonParentId(nodes, ['t1', 'loose'])).toBeUndefined()
    expect(commonParentId(nodes, ['nope'])).toBeUndefined()
  })
})

describe('arrange/align inside a frame', () => {
  // Children of one frame arrange in the frame's coordinate space — the gap this closes: after
  // grouping, the frame's contents could not be tidied from the canvas-control CLI.
  const framed = () => [
    grp('g1', { x: 100, y: 100 }),
    term('a', { x: 5, y: 5 }, 'g1'),
    term('b', { x: 400, y: 300 }, 'g1'), // scattered inside the frame
    term('c', { x: 900, y: 40 }, 'g1')
  ]

  it('arranges a frame\'s children in a row without touching the frame or top-level nodes', () => {
    const out = arrangeNodes(framed(), ['a', 'b', 'c'], { layout: 'row', gap: 40 })
    const pos = (id: string) => out.find((n) => n.id === id)!.position
    // Row starts at the bounding-box top-left of the children (relative coords), y shared.
    expect(pos('a')).toEqual({ x: 5, y: 5 })
    expect(pos('b')).toEqual({ x: 5 + 320 + 40, y: 5 })
    expect(pos('c')).toEqual({ x: 5 + (320 + 40) * 2, y: 5 })
  })

  it('refuses a set spanning two containers (no-op)', () => {
    const nodes = [
      grp('g1', { x: 0, y: 0 }),
      term('a', { x: 10, y: 10 }, 'g1'),
      term('loose', { x: 800, y: 0 })
    ]
    expect(arrangeNodes(nodes, ['a', 'loose'], { layout: 'row' })).toBe(nodes)
    expect(alignNodes(nodes, ['a', 'loose'], 'left')).toBe(nodes)
  })

  it('aligns a frame\'s children to a shared left edge', () => {
    const out = alignNodes(framed(), ['a', 'b', 'c'], 'left')
    const xs = ['a', 'b', 'c'].map((id) => out.find((n) => n.id === id)!.position.x)
    expect(new Set(xs)).toEqual(new Set([5])) // all snapped to the leftmost (a.x = 5)
  })
})

describe('fitGroupToChildren', () => {
  it('shrinks the frame to hug its children and keeps them fixed on canvas', () => {
    // Frame is oversized (400×300) but its two children sit in a small cluster.
    const nodes = [
      grp('g1', { x: 100, y: 100 }),
      term('a', { x: 20, y: 40 }, 'g1'), // abs (120,140), 320×240
      term('b', { x: 60, y: 20 }, 'g1') // abs (160,120)
    ]
    const out = fitGroupToChildren(nodes, 'g1')
    const g = out.find((n) => n.id === 'g1')!
    const a = out.find((n) => n.id === 'a')!
    const b = out.find((n) => n.id === 'b')!
    // Children keep their ABSOLUTE canvas positions (frame origin + relative pos unchanged).
    expect({ x: g.position.x + a.position.x, y: g.position.y + a.position.y }).toEqual({ x: 120, y: 140 })
    expect({ x: g.position.x + b.position.x, y: g.position.y + b.position.y }).toEqual({ x: 160, y: 120 })
    // Frame hugs the child bbox with the standard pad (28) + header (34) on top.
    const GROUP_PAD = 28
    const GROUP_HEADER = 34
    const minX = 120, minY = 120
    const maxX = 160 + 320, maxY = 140 + 240
    expect(g.position).toEqual({ x: minX - GROUP_PAD, y: minY - GROUP_PAD - GROUP_HEADER })
    expect(g.width).toBe(maxX - minX + GROUP_PAD * 2)
    expect(g.height).toBe(maxY - minY + GROUP_PAD * 2 + GROUP_HEADER)
  })

  it('is a no-op for a missing id, a non-group, or an empty frame', () => {
    const nodes = [grp('g1', { x: 0, y: 0 }), term('t1', { x: 0, y: 0 })]
    expect(fitGroupToChildren(nodes, 'nope')).toBe(nodes)
    expect(fitGroupToChildren(nodes, 't1')).toBe(nodes)
    expect(fitGroupToChildren(nodes, 'g1')).toBe(nodes) // g1 has no children
  })
})

describe('groupSelectedNodes', () => {
  it('wraps the selection in a group frame with group-relative child positions', () => {
    const nodes = [term('t1', { x: 100, y: 100 }), term('t2', { x: 500, y: 300 })]
    const out = groupSelectedNodes(nodes, ['t1', 't2'], 0)
    const group = out[0]
    expect(group.type).toBe('group') // parent placed first (React Flow requirement)
    const t1 = out.find((n) => n.id === 't1')!
    expect(t1.parentId).toBe(group.id)
    expect(t1.extent).toBe('parent')
    // absolute position preserved: group position + relative child position
    expect(group.position.x + t1.position.x).toBe(100)
    expect(group.position.y + t1.position.y).toBe(100)
    // frame encloses both members (t2 spans to x=820, y=540)
    expect(group.position.x + (group.width as number)).toBeGreaterThanOrEqual(820)
    expect(group.position.y + (group.height as number)).toBeGreaterThanOrEqual(540)
  })

  it('groups a single node', () => {
    const out = groupSelectedNodes([term('t1', { x: 100, y: 100 })], ['t1'], 0)
    expect(out[0].type).toBe('group')
    expect(out.find((n) => n.id === 't1')!.parentId).toBe(out[0].id)
  })

  it('refuses an ancestor together with its descendant', () => {
    const nodes = [grp('g1', { x: 0, y: 0 }), term('t1', { x: 10, y: 10 }, 'g1')]
    expect(groupSelectedNodes(nodes, ['g1', 't1'], 1)).toBe(nodes)
  })

  it('refuses members that live in different containers', () => {
    const nodes = [
      grp('g1', { x: 0, y: 0 }),
      term('inside', { x: 10, y: 10 }, 'g1'),
      term('loose', { x: 900, y: 900 })
    ]
    expect(groupSelectedNodes(nodes, ['inside', 'loose'], 1)).toBe(nodes)
  })

  it('wraps sibling groups in a nested group while preserving root-space positions', () => {
    const nodes = [grp('a', { x: 100, y: 120 }), grp('b', { x: 600, y: 180 })]
    const out = groupSelectedNodes(nodes, ['a', 'b'], 2)
    const wrapper = out.find((node) => !nodes.some((old) => old.id === node.id))!
    const a = out.find((node) => node.id === 'a')!
    expect(wrapper.type).toBe('group')
    expect(a.parentId).toBe(wrapper.id)
    expect(wrapper.position.x + a.position.x).toBe(100)
    expect(wrapper.position.y + a.position.y).toBe(120)
    expect(out.indexOf(wrapper)).toBeLessThan(out.indexOf(a))
  })

  it("creates the wrapper inside the siblings' existing parent", () => {
    const nodes = [
      grp('outer', { x: 100, y: 80 }),
      grp('a', { x: 20, y: 30 }, 'outer'),
      grp('b', { x: 500, y: 60 }, 'outer')
    ]
    const out = groupSelectedNodes(nodes, ['a', 'b'], 3)
    const wrapper = out.find((node) => !nodes.some((old) => old.id === node.id))!
    const outer = out.find((node) => node.id === 'outer')!
    const a = out.find((node) => node.id === 'a')!
    expect(wrapper.parentId).toBe('outer')
    expect(a.parentId).toBe(wrapper.id)
    // Root space is unchanged: 'a' sat at (120, 110) before and must still sit there.
    expect(outer.position.x + wrapper.position.x + a.position.x).toBe(120)
    expect(outer.position.y + wrapper.position.y + a.position.y).toBe(110)
  })

  /**
   * The pure arithmetic above can be perfectly right while the canvas is wrong: a wrapper is
   * created at (minX - 28, minY - 62) RELATIVE to its new parent — routinely negative — and
   * carries `extent: 'parent'`. React Flow then clamps it into `[0, parentSize - wrapperSize]`,
   * which for a wrapper bigger than its parent is an inverted range: the frame snaps hundreds of
   * px away and drags the whole wrapped subtree with it. So assert the FRAME FITS, not just that
   * the offsets add up. Fails without the ancestor re-fit.
   */
  it('grows the parent frame so the new wrapper fits inside it', () => {
    const nodes = [
      grp('outer', { x: 100, y: 80 }),
      grp('a', { x: 20, y: 30 }, 'outer'),
      grp('b', { x: 500, y: 60 }, 'outer')
    ]
    const out = groupSelectedNodes(nodes, ['a', 'b'], 3)
    const outer = out.find((node) => node.id === 'outer')!
    const wrapper = out.find((node) => !nodes.some((old) => old.id === node.id))!
    expect(wrapper.position.x).toBeGreaterThanOrEqual(0)
    expect(wrapper.position.y).toBeGreaterThanOrEqual(0)
    expect(wrapper.position.x + (wrapper.width as number)).toBeLessThanOrEqual(
      outer.width as number
    )
    expect(wrapper.position.y + (wrapper.height as number)).toBeLessThanOrEqual(
      outer.height as number
    )
  })

  it('grows every ancestor frame, not just the immediate parent', () => {
    const nodes = [
      grp('root', { x: 0, y: 0 }),
      grp('outer', { x: 10, y: 10 }, 'root'),
      grp('a', { x: 20, y: 30 }, 'outer'),
      grp('b', { x: 500, y: 60 }, 'outer')
    ]
    const out = groupSelectedNodes(nodes, ['a', 'b'], 4)
    const root = out.find((node) => node.id === 'root')!
    const outer = out.find((node) => node.id === 'outer')!
    expect(outer.position.x).toBeGreaterThanOrEqual(0)
    expect(outer.position.x + (outer.width as number)).toBeLessThanOrEqual(root.width as number)
    expect(outer.position.y + (outer.height as number)).toBeLessThanOrEqual(root.height as number)
  })
})

describe('groupSelectedNodes with snapping on', () => {
  const GRID = 20
  const GROUP_PAD = 28
  const GROUP_HEADER = 34

  it('places the frame on the grid, all four edges', () => {
    const nodes = [term('t1', { x: 100, y: 100 }), term('t2', { x: 500, y: 300 })]
    const group = groupSelectedNodes(nodes, ['t1', 't2'], 0, GRID)[0]
    expect(group.position.x % GRID).toBe(0)
    expect(group.position.y % GRID).toBe(0)
    expect((group.position.x + (group.width as number)) % GRID).toBe(0)
    expect((group.position.y + (group.height as number)) % GRID).toBe(0)
  })

  it('keeps at least the unsnapped clearance on every side', () => {
    // Snapping may only push the frame outward. The members span (100,100)-(820,540).
    const nodes = [term('t1', { x: 100, y: 100 }), term('t2', { x: 500, y: 300 })]
    const group = groupSelectedNodes(nodes, ['t1', 't2'], 0, GRID)[0]
    const pad = Math.max(GROUP_PAD, GRID)
    expect(group.position.x).toBeLessThanOrEqual(100 - pad)
    expect(group.position.y).toBeLessThanOrEqual(100 - pad - GROUP_HEADER)
    expect(group.position.x + (group.width as number)).toBeGreaterThanOrEqual(820 + pad)
    expect(group.position.y + (group.height as number)).toBeGreaterThanOrEqual(540 + pad)
  })

  it('honours a grid coarser than the fixed padding', () => {
    const coarse = 64
    const nodes = [term('t1', { x: 200, y: 200 })]
    const group = groupSelectedNodes(nodes, ['t1'], 0, coarse)[0]
    expect(group.position.x).toBeLessThanOrEqual(200 - coarse)
    expect(group.position.x % coarse).toBe(0)
  })

  it('leaves every member where it was on canvas', () => {
    const nodes = [term('t1', { x: 100, y: 100 }), term('t2', { x: 500, y: 300 })]
    const out = groupSelectedNodes(nodes, ['t1', 't2'], 0, GRID)
    const group = out[0]
    for (const [id, pos] of [['t1', { x: 100, y: 100 }], ['t2', { x: 500, y: 300 }]] as const) {
      const child = out.find((n) => n.id === id)!
      expect(group.position.x + child.position.x).toBe(pos.x)
      expect(group.position.y + child.position.y).toBe(pos.y)
    }
  })

  it('snaps a nested frame onto the CANVAS grid, not its parent frame grid', () => {
    // An off-grid frame origin is the normal case, so a parent-relative snap would land the
    // wrapper on a grid offset by (-28, -62) from the one React Flow drags against.
    const nodes = [
      grp('outer', { x: -28, y: -62 }),
      term('a', { x: 100, y: 100 }, 'outer'),
      term('b', { x: 400, y: 260 }, 'outer')
    ]
    const out = groupSelectedNodes(nodes, ['a', 'b'], 1, GRID)
    const outer = out.find((n) => n.id === 'outer')!
    const wrapper = out.find((n) => !nodes.some((old) => old.id === n.id))!
    expect(wrapper.parentId).toBe('outer')
    // Math.abs: a negative multiple modulo the grid is -0, which toBe distinguishes from 0.
    expect(Math.abs((outer.position.x + wrapper.position.x) % GRID)).toBe(0)
    expect(Math.abs((outer.position.y + wrapper.position.y) % GRID)).toBe(0)
  })

  it('is byte-identical to the unsnapped box when snapping is off', () => {
    const nodes = [term('t1', { x: 103, y: 107 }), term('t2', { x: 511, y: 313 })]
    const group = groupSelectedNodes(nodes, ['t1', 't2'], 0, 0)[0]
    expect(group.position).toEqual({ x: 103 - GROUP_PAD, y: 107 - GROUP_PAD - GROUP_HEADER })
    expect(group.width).toBe(511 + 320 - 103 + GROUP_PAD * 2)
    expect(group.height).toBe(313 + 240 - 107 + GROUP_PAD * 2 + GROUP_HEADER)
    expect(groupSelectedNodes(nodes, ['t1', 't2'], 0)[0].position).toEqual(group.position)
  })

  it('keeps a re-fit frame on the grid, so a later fit cannot undo the placement', () => {
    const nodes = [
      grp('g1', { x: 100, y: 100 }),
      term('a', { x: 23, y: 41 }, 'g1'),
      term('b', { x: 61, y: 19 }, 'g1')
    ]
    const out = fitGroupToChildren(nodes, 'g1', GRID)
    const g = out.find((n) => n.id === 'g1')!
    expect(g.position.x % GRID).toBe(0)
    expect(g.position.y % GRID).toBe(0)
    // Children still sit where they were on canvas.
    const a = out.find((n) => n.id === 'a')!
    expect(g.position.x + a.position.x).toBe(123)
    expect(g.position.y + a.position.y).toBe(141)
  })
})

describe('ungroupNodes', () => {
  it('removes the frame and restores children to absolute positions', () => {
    const nodes = [grp('g1', { x: 50, y: 50 }), term('t1', { x: 10, y: 10 }, 'g1')]
    const out = ungroupNodes(nodes, 'g1')
    expect(out.find((n) => n.id === 'g1')).toBeUndefined()
    const t1 = out.find((n) => n.id === 't1')!
    expect(t1.parentId).toBeUndefined()
    expect(t1.extent).toBeUndefined()
    expect(t1.position).toEqual({ x: 60, y: 60 })
  })

  it('round-trips with groupSelectedNodes', () => {
    const nodes = [term('t1', { x: 100, y: 100 }), term('t2', { x: 500, y: 300 })]
    const grouped = groupSelectedNodes(nodes, ['t1', 't2'], 0)
    const out = ungroupNodes(grouped, grouped[0].id)
    expect(out.find((n) => n.id === 't1')!.position).toEqual({ x: 100, y: 100 })
    expect(out.find((n) => n.id === 't2')!.position).toEqual({ x: 500, y: 300 })
  })

  it("promotes direct children into the removed group's parent without moving them", () => {
    const nodes = [
      grp('outer', { x: 100, y: 80 }),
      grp('inner', { x: 30, y: 40 }, 'outer'),
      term('leaf', { x: 10, y: 12 }, 'inner')
    ]
    const out = ungroupNodes(nodes, 'inner')
    const leaf = out.find((node) => node.id === 'leaf')!
    expect(leaf.parentId).toBe('outer')
    expect(leaf.position).toEqual({ x: 40, y: 52 })
  })

  it('is a no-op when the group is missing', () => {
    const nodes = [term('t1', { x: 0, y: 0 })]
    expect(ungroupNodes(nodes, 'nope')).toBe(nodes)
  })
})

describe('nested group persistence order', () => {
  it('hydrates every parent group before its descendants even from reversed persisted order', () => {
    const live = [
      grp('outer', { x: 100, y: 80 }),
      grp('inner', { x: 30, y: 40 }, 'outer'),
      term('leaf', { x: 10, y: 12 }, 'inner')
    ]
    const hydrated = nodeStatesToFlow(flowToNodeStates(live).reverse())
    expect(hydrated.findIndex((node) => node.id === 'outer')).toBeLessThan(
      hydrated.findIndex((node) => node.id === 'inner')
    )
    expect(hydrated.findIndex((node) => node.id === 'inner')).toBeLessThan(
      hydrated.findIndex((node) => node.id === 'leaf')
    )
  })

  it('hydrates groups with the label-only drag handle', () => {
    const [group] = nodeStatesToFlow(flowToNodeStates([grp('outer', { x: 0, y: 0 })]))
    expect(group.dragHandle).toBe('.group-node__label')
  })
})

describe('reorderGroupWithinParent', () => {
  it('moves a nested group subtree before a sibling without changing geometry or parenting', () => {
    const nodes = [
      grp('outer', { x: 0, y: 0 }),
      grp('a', { x: 10, y: 10 }, 'outer'),
      grp('a-child', { x: 5, y: 5 }, 'a'),
      grp('b', { x: 20, y: 20 }, 'outer'),
      term('inside-a', { x: 2, y: 3 }, 'a')
    ]
    const out = reorderGroupWithinParent(nodes, 'b', 'outer', 'a')
    expect(out.map((node) => node.id)).toEqual(['outer', 'b', 'a', 'a-child', 'inside-a'])
    expect(out.find((node) => node.id === 'b')).toMatchObject({
      parentId: 'outer',
      position: { x: 20, y: 20 }
    })
  })

  it('appends a whole group subtree after its last sibling', () => {
    const nodes = [
      grp('a', { x: 0, y: 0 }),
      grp('a-child', { x: 0, y: 0 }, 'a'),
      grp('b', { x: 0, y: 0 }),
      term('inside-a', { x: 0, y: 0 }, 'a')
    ]
    expect(reorderGroupWithinParent(nodes, 'a', null, null).map((node) => node.id)).toEqual([
      'b',
      'a',
      'a-child',
      'inside-a'
    ])
  })

  it('rejects cross-parent and invalid-target reorders', () => {
    const nodes = [
      grp('outer', { x: 0, y: 0 }),
      grp('a', { x: 0, y: 0 }, 'outer'),
      grp('b', { x: 0, y: 0 })
    ]
    expect(reorderGroupWithinParent(nodes, 'a', null, 'b')).toBe(nodes)
    expect(reorderGroupWithinParent(nodes, 'a', 'outer', 'missing')).toBe(nodes)
  })
})

describe('reorderNodeBefore', () => {
  const ids = (out: CanvasNode[]): string[] => out.filter((n) => n.type !== 'group').map((n) => n.id)

  it('reorders within the same container (moves dragged before target)', () => {
    const nodes = [term('a', { x: 0, y: 0 }), term('b', { x: 0, y: 0 }), term('c', { x: 0, y: 0 })]
    expect(ids(reorderNodeBefore(nodes, 'c', 'a'))).toEqual(['c', 'a', 'b'])
    expect(ids(reorderNodeBefore(nodes, 'a', 'c'))).toEqual(['b', 'a', 'c'])
  })

  it('keeps position unchanged for a same-container reorder', () => {
    const nodes = [term('a', { x: 5, y: 5 }), term('b', { x: 9, y: 9 })]
    const out = reorderNodeBefore(nodes, 'b', 'a')
    expect(out.find((n) => n.id === 'b')!.position).toEqual({ x: 9, y: 9 })
  })

  it('moves across containers (joins target group) and lands before the target', () => {
    const nodes = [
      grp('g1', { x: 50, y: 50 }),
      term('t1', { x: 10, y: 10 }, 'g1'),
      term('t2', { x: 200, y: 150 }) // ungrouped
    ]
    const out = reorderNodeBefore(nodes, 't2', 't1')
    const t2 = out.find((n) => n.id === 't2')!
    expect(t2.parentId).toBe('g1')
    expect(t2.position).toEqual({ x: 150, y: 100 }) // 200-50, 150-50
    expect(ids(out)).toEqual(['t2', 't1']) // t2 placed before t1
  })

  it('keeps group nodes first and is a no-op for same/ missing / group drags', () => {
    const nodes = [grp('g1', { x: 0, y: 0 }), term('a', { x: 0, y: 0 }), term('b', { x: 0, y: 0 })]
    expect(reorderNodeBefore(nodes, 'a', 'a')).toBe(nodes)
    expect(reorderNodeBefore(nodes, 'nope', 'a')).toBe(nodes)
    expect(reorderNodeBefore(nodes, 'g1', 'a')).toBe(nodes) // can't drag a group row
    const out = reorderNodeBefore(nodes, 'b', 'a')
    expect(out[0].id).toBe('g1')
  })
})

describe('group worktree serialization', () => {
  it('round-trips data.worktree on a group node', () => {
    const group = {
      id: 'group_1',
      type: 'group',
      position: { x: 0, y: 0 },
      width: 400,
      height: 300,
      data: {
        title: 'G',
        color: '#fff',
        group: null,
        worktree: {
          repoPath: '/repo',
          branch: 'feature/x',
          baseRef: 'main',
          path: '/wt/feature-x',
          createdByApp: true
        }
      }
    } as unknown as CanvasNode

    const states = flowToNodeStates([group])
    expect(states[0].worktree).toEqual(group.data.worktree)

    const back = nodeStatesToFlow(states)
    expect(back[0].data.worktree).toEqual(group.data.worktree)
  })

  it('leaves worktree undefined for unbound groups', () => {
    const group = {
      id: 'group_2', type: 'group', position: { x: 0, y: 0 }, width: 1, height: 1,
      data: { title: 'G', color: '#fff', group: null }
    } as unknown as CanvasNode
    expect(flowToNodeStates([group])[0].worktree).toBeUndefined()
  })
})

describe('node icon serialization', () => {
  const withIcon = (icon: unknown): CanvasNode =>
    ({
      id: 't1',
      type: 'terminal',
      position: { x: 0, y: 0 },
      width: 320,
      height: 240,
      data: { title: 'T', color: '#888', group: null, icon }
    }) as unknown as CanvasNode

  const stateWithIcon = (icon: unknown) => ({
    id: 't1',
    kind: 'terminal' as const,
    position: { x: 0, y: 0 },
    size: { width: 320, height: 240 },
    title: 'T',
    color: '#888',
    group: null,
    icon
  })

  it('round-trips an emoji icon', () => {
    const icon = { type: 'emoji', value: '\u{1F680}' }
    const states = flowToNodeStates([withIcon(icon)])
    expect(states[0].icon).toEqual(icon)
    expect(nodeStatesToFlow(states)[0].data.icon).toEqual(icon)
  })

  it('round-trips an image icon', () => {
    const icon = { type: 'image', path: './.nodeterm/images/logo.png' }
    const states = flowToNodeStates([withIcon(icon)])
    expect(states[0].icon).toEqual(icon)
    expect(nodeStatesToFlow(states)[0].data.icon).toEqual(icon)
  })

  it('leaves a node without one undefined, so an untouched canvas serializes as it always did', () => {
    expect(flowToNodeStates([withIcon(undefined)])[0].icon).toBeUndefined()
  })

  // project.json is git-shared and hand-editable, so hydration is a trust boundary. A path that is
  // not an image would otherwise reach `fs.readBinary` on load.
  it('drops a hostile icon on the way IN', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const hydrate = (icon: unknown) => nodeStatesToFlow([stateWithIcon(icon) as any])[0].data.icon
    expect(hydrate({ type: 'image', path: '/home/u/.ssh/id_rsa' })).toBeUndefined()
    expect(hydrate({ type: 'image', path: './../../.ssh/id_rsa.png' })).toBeUndefined()
    expect(hydrate({ type: 'nonsense' })).toBeUndefined()
    expect(hydrate('\u{1F680}')).toBeUndefined()
    expect(hydrate({ type: 'emoji', value: 'abcdef' })).toEqual({ type: 'emoji', value: 'a' })
  })

  // And on the way OUT too: live node data can be reached by a peer canvas mutation, and whatever
  // is written here becomes the next reader's "trusted" file.
  it('drops a hostile icon on the way OUT', () => {
    expect(flowToNodeStates([withIcon({ type: 'image', path: '/etc/passwd' })])[0].icon).toBeUndefined()
    expect(flowToNodeStates([withIcon({ type: 'emoji', value: '' })])[0].icon).toBeUndefined()
  })
})

describe('resolveNewNodeAccount', () => {
  const accounts = [{ id: 'a1', label: 'work', createdAt: 0 }]
  it('prefers the explicit pick', () =>
    expect(resolveNewNodeAccount('a1', { defaultAccountId: 'a2' }, accounts)).toBe('a1'))
  it('falls back to the project default', () =>
    expect(resolveNewNodeAccount(undefined, { defaultAccountId: 'a1' }, accounts)).toBe('a1'))
  it('drops ids that no longer exist', () =>
    expect(resolveNewNodeAccount('gone', { defaultAccountId: 'gone' }, accounts)).toBeUndefined())
  it('undefined when nothing set', () =>
    expect(resolveNewNodeAccount(undefined, {}, accounts)).toBeUndefined())
  it('undefined when the project is undefined', () =>
    expect(resolveNewNodeAccount(undefined, undefined, accounts)).toBeUndefined())
  // #419 — the "picked X, ran as Y" legs.
  it('null = the EXPLICIT System pick — it must not resolve to the project default (#419)', () =>
    // Before null existed, the submenu's System row (labelled with the system email) passed
    // "no account", which this resolver read as "apply the project default".
    expect(resolveNewNodeAccount(null, { defaultAccountId: 'a1' }, accounts)).toBeUndefined())
  it('a PENDING default never stamps its id — its dir exists but holds no login (#419)', () =>
    expect(
      resolveNewNodeAccount(
        undefined,
        { defaultAccountId: 'p1' },
        [...accounts, { id: 'p1', label: 'new account', createdAt: 0, pending: true }]
      )
    ).toBeUndefined())
  it("a default pinned to another machine's host never lands on a LOCAL project (#419)", () =>
    // Its config dir exists only on that host, so locally the spawn would fall into the
    // missing-dir fallback — and pre-fix, from there into whatever the shared tmux server held.
    expect(
      resolveNewNodeAccount(
        undefined,
        { defaultAccountId: 'r1' },
        [{ id: 'r1', label: 'server', createdAt: 0, host: 'u@h' }]
      )
    ).toBeUndefined())
  it('an SSH project keeps its own host-matched account', () =>
    expect(
      resolveNewNodeAccount(
        'r1',
        { ssh: { server: { host: 'h', user: 'u' } } },
        [{ id: 'r1', label: 'server', createdAt: 0, host: 'u@h' }]
      )
    ).toBe('r1'))
})

describe('accountId on Claude node factories', () => {
  it('stamps accountId onto a Claude agent node', () => {
    const node = createAgentNode('claude', 0, undefined, undefined, undefined, undefined, 'a1')
    expect(node.data.accountId).toBe('a1')
  })
  it('stamps accountId onto a Codex agent node (S6 per-node account picker)', () => {
    const node = createAgentNode('codex', 0, undefined, undefined, undefined, undefined, 'a1')
    expect(node.data.accountId).toBe('a1')
  })
  it('does not stamp accountId onto a non-account agent node', () => {
    // Accounts bind to the Claude/Codex builtins only — another agent never carries one.
    const node = createAgentNode('gemini', 0, undefined, undefined, undefined, undefined, 'a1')
    expect(node.data.accountId).toBeUndefined()
  })
  it('omits accountId when none is given', () => {
    const node = createAgentNode('claude', 0)
    expect(node.data.accountId).toBeUndefined()
  })
})

describe('model on agent node factory', () => {
  it('stamps agentModel and threads --model into the launch command for a switch-capable agent', () => {
    const node = createAgentNode('claude', 0, undefined, undefined, undefined, undefined, undefined, undefined, undefined, 'claude-sonnet-5')
    expect(node.data.agentModel).toBe('claude-sonnet-5')
    expect(node.data.initialCommand).toContain('--model')
    expect(node.data.initialCommand).toContain('claude-sonnet-5')
  })
  it('omits agentModel and the --model flag when no model is given', () => {
    const node = createAgentNode('claude', 0)
    expect(node.data.agentModel).toBeUndefined()
    expect(node.data.initialCommand).not.toContain('--model')
  })
  it('drops the model (no --model) for a non-switch-capable agent', () => {
    // gemini is not in MODEL_SWITCH_CAPABLE — withAgentModel no-ops, and agentModel is still stamped
    // (it is harmless to persist; the point is the launch line carries no --model).
    const node = createAgentNode('gemini', 0, undefined, undefined, undefined, undefined, undefined, undefined, undefined, 'gemini-2.5')
    expect(node.data.agentModel).toBe('gemini-2.5')
    expect(node.data.initialCommand).not.toContain('--model')
  })
})

describe('accountId serialization', () => {
  it('round-trips data.accountId on a terminal node', () => {
    const node = {
      id: 'term-1',
      type: 'terminal',
      position: { x: 0, y: 0 },
      width: 600,
      height: 400,
      data: {
        title: 'T',
        color: '#888',
        group: null,
        agentId: 'claude',
        agentModel: 'openai/gpt-5',
        accountId: 'a1'
      }
    } as unknown as CanvasNode
    const states = flowToNodeStates([node])
    expect(states[0].accountId).toBe('a1')
    expect(states[0].agentModel).toBe('openai/gpt-5')
    const back = nodeStatesToFlow(states)
    expect(back[0].data.accountId).toBe('a1')
    expect(back[0].data.agentModel).toBe('openai/gpt-5')
  })
  it('leaves accountId undefined when unset', () => {
    const node = {
      id: 'term-2', type: 'terminal', position: { x: 0, y: 0 }, width: 1, height: 1,
      data: { title: 'T', color: '#888', group: null }
    } as unknown as CanvasNode
    expect(flowToNodeStates([node])[0].accountId).toBeUndefined()
  })
})

describe('nodeSshFor', () => {
  const projectSsh = {
    server: { host: 'h', user: 'u' },
    remoteCwd: '/srv/app'
  } as unknown as NonNullable<Parameters<typeof nodeSshFor>[0]>

  it('is undefined for a local project, so nothing changes there', () => {
    expect(nodeSshFor(undefined)).toBeUndefined()
    expect(nodeSshFor(undefined, '/some/dir')).toBeUndefined()
  })

  it('threads the caller cwd through remoteCwd — the factories read a node cwd from there', () => {
    // Passing the project's ssh unchanged would silently replace an explicit --cwd with the
    // project root, which is the second half of this bug.
    expect(nodeSshFor(projectSsh, '/srv/app/sub')).toEqual({
      server: projectSsh.server,
      remoteCwd: '/srv/app/sub'
    })
  })

  it('falls back to the project root when no cwd is given', () => {
    expect(nodeSshFor(projectSsh)).toEqual({ server: projectSsh.server, remoteCwd: '/srv/app' })
    expect(nodeSshFor(projectSsh, '')).toEqual({ server: projectSsh.server, remoteCwd: '/srv/app' })
  })

  it('produces a node that actually runs on the host (remote tmux, remote cwd)', () => {
    const node = createAgentNode('claude', 0, undefined, undefined, undefined, nodeSshFor(projectSsh, '/srv/app/sub'))
    expect(node.data.sshRemoteTmux).toBe(true)
    expect(node.data.ssh).toEqual(projectSsh.server)
    expect(node.data.cwd).toBe('/srv/app/sub')
  })
})

describe('pendingLaunch round-trip', () => {
  // Unlike initialCommand (one-shot, deliberately NOT persisted), an armed node's held launch
  // must survive a reload — the station it waits on can take hours, and a restart in between
  // must not silently turn the node into an idle shell that never runs anything.
  it('persists the held launch and its dependencies', () => {
    const node = {
      id: 'term-3',
      type: 'terminal',
      position: { x: 0, y: 0 },
      width: 600,
      height: 400,
      data: {
        title: 'T',
        color: '#888',
        group: null,
        agentId: 'claude',
        pendingLaunch: { after: ['term-1', 'term-2'], command: 'claude "go"' }
      }
    } as unknown as CanvasNode
    const states = flowToNodeStates([node])
    expect(states[0].pendingLaunch).toEqual({ after: ['term-1', 'term-2'], command: 'claude "go"' })
    expect(nodeStatesToFlow(states)[0].data.pendingLaunch).toEqual({
      after: ['term-1', 'term-2'],
      command: 'claude "go"'
    })
  })

  it('stays undefined for an ordinary node', () => {
    const node = {
      id: 'term-4', type: 'terminal', position: { x: 0, y: 0 }, width: 1, height: 1,
      data: { title: 'T', color: '#888', group: null, initialCommand: 'claude' }
    } as unknown as CanvasNode
    const states = flowToNodeStates([node])
    expect(states[0].pendingLaunch).toBeUndefined()
    // initialCommand is still not persisted — arming is what makes a launch durable.
    expect((states[0] as { initialCommand?: string }).initialCommand).toBeUndefined()
  })
})

describe('createAccountLoginNode', () => {
  it('produces a terminal node that logs the given account in', () => {
    const node = createAccountLoginNode('acct-1', 0)
    expect(node.type).toBe('terminal')
    expect(node.data.title).toBe('Claude login')
    expect(node.data.accountId).toBe('acct-1')
    expect(node.data.initialCommand).toBe('claude /login')
  })

  // Issue #553: a login node with no cwd starts in $HOME, and Claude Code's trust check is keyed
  // on the cwd — so the user was asked to trust their entire home directory before an OAuth round
  // trip that touches no files.
  it('roots the login shell in the cwd it is given', () => {
    expect(createAccountLoginNode('acct-1', 0, undefined, undefined, '/work/repo').data.cwd).toBe(
      '/work/repo'
    )
  })

  it('roots a REMOTE login at the host cwd, never at a local path', () => {
    // The local cwd belongs to whichever project was active when Settings fired the event; the
    // session runs on the host, where that path names nothing (or, worse, something else).
    const ssh = {
      server: { host: 'h', user: 'u' },
      remoteCwd: '/srv/app'
    } as unknown as NonNullable<Project['ssh']>
    const node = createAccountLoginNode('acct-1', 0, undefined, ssh, '/local/repo')
    expect(node.data.cwd).toBe('/srv/app')
    expect(node.data.sshRemoteTmux).toBe(true)
  })

  it('still opens with no cwd when the caller has none to offer', () => {
    // An SSH project has no local `cwd`, so a LOCAL account added from one falls back to $HOME —
    // unchanged behavior, and the honest answer: that project owns no local directory.
    expect(createAccountLoginNode('acct-1', 0).data.cwd).toBeUndefined()
  })
})

describe('createCodexAccountLoginNode', () => {
  it('produces a terminal node that logs the given Codex account in', () => {
    const node = createCodexAccountLoginNode('acct-2', 0)
    expect(node.type).toBe('terminal')
    expect(node.data.title).toBe('Codex login')
    expect(node.data.accountId).toBe('acct-2')
    expect(node.data.initialCommand).toBe('codex login')
  })

  it('carries NO agentId — the agent-less shape is what the Codex scope gate keys on', () => {
    // With an agentId of 'codex' this would be an agent node and take the agent paths; the login
    // terminal is scoped purely because its account id is a managed CODEX one (see #345/#346).
    expect(createCodexAccountLoginNode('acct-2', 0).data.agentId).toBeUndefined()
  })

  it('roots the login shell in the cwd it is given (issue #553)', () => {
    expect(createCodexAccountLoginNode('acct-2', 0, undefined, '/work/repo').data.cwd).toBe(
      '/work/repo'
    )
    expect(createCodexAccountLoginNode('acct-2', 0).data.cwd).toBeUndefined()
  })
})

describe('createSystemLoginNode (issue #420)', () => {
  it('produces a SYSTEM-scoped login terminal: no accountId, no agentId, its own title', () => {
    const node = createSystemLoginNode(0)
    expect(node.type).toBe('terminal')
    expect(node.data.title).toBe('Switch Claude account')
    // No accountId = the plain-terminal spawn env, so `claude /login` writes ~/.claude — the
    // whole point of the switch. Agent-less like the managed login nodes.
    expect(node.data.accountId).toBeUndefined()
    expect(node.data.agentId).toBeUndefined()
    expect(node.data.initialCommand).toBe('claude /login')
  })

  it('is never swept by account removal, and a serialized copy sheds the login signature', () => {
    const node = createSystemLoginNode(0)
    // Live (pre-first-open) data matches isAccountLoginNode via initialCommand — harmless,
    // because both destroy paths (Canvas + AccountsSection) additionally require accountId
    // equality with the removed account, and this node has none.
    expect(isAccountLoginNode(node.data)).toBe(true)
    expect(node.data.accountId).toBeUndefined()
    // The durable half: initialCommand never survives a serialize, and the title is NOT the
    // managed factory's 'Claude login' — so a persisted copy fails isAccountLoginNode outright.
    // That is also the anti-respawn guarantee: a restarted app rehydrates this node with no
    // command at all, so `claude /login` can only ever run the once the user clicked for.
    const persisted = flowToNodeStates([node])[0]
    expect((persisted as { initialCommand?: string }).initialCommand).toBeUndefined()
    const back = nodeStatesToFlow([persisted])[0]
    expect(isAccountLoginNode(back.data)).toBe(false)
  })

  it('roots the login shell in the cwd it is given (issue #553)', () => {
    // The reported case: the popover's Switch account button opened in $HOME, so Claude Code's
    // trust prompt stood between the click and the OAuth flow.
    expect(createSystemLoginNode(0, undefined, '/work/repo').data.cwd).toBe('/work/repo')
    expect(createSystemLoginNode(0).data.cwd).toBeUndefined()
  })
})

describe('dino node serialization', () => {
  it('round-trips a dino node and its highScore', () => {
    const dino = {
      id: 'dino-1',
      type: 'dino',
      position: { x: 10, y: 20 },
      width: 600,
      height: 200,
      data: { title: 'Dino', color: '#a2a2a2', group: null, highScore: 1337 }
    } as unknown as CanvasNode

    const states = flowToNodeStates([dino])
    expect(states[0].kind).toBe('dino')
    expect(states[0].highScore).toBe(1337)

    const back = nodeStatesToFlow(states)
    expect(back[0].type).toBe('dino')
    expect(back[0].data.highScore).toBe(1337)
  })

  it('createDinoNode produces a dino node with highScore 0', () => {
    const node = createDinoNode(0)
    expect(node.type).toBe('dino')
    expect(node.data.highScore).toBe(0)
    expect(node.width).toBe(600)
  })
})

describe('chat node tombstone', () => {
  it('converts a persisted chat node into a sticky with the resume hint', () => {
    const flow = nodeStatesToFlow([
      {
        id: 'chat-1', kind: 'chat', x: 10, y: 20, width: 420, height: 520,
        title: 'API brainstorm', color: '#8b5cf6', chatSessionId: 'sess-abc123'
      } as any
    ])
    expect(flow).toHaveLength(1)
    const n = flow[0]
    expect(n.type).toBe('sticky')
    expect(n.position).toEqual({ x: 10, y: 20 })
    expect(n.data.title).toBe('API brainstorm')
    expect(String(n.data.text)).toContain('claude --resume sess-abc123')
  })
  it('converts a chat node without a session id into a plain explanatory sticky', () => {
    const flow = nodeStatesToFlow([{ id: 'chat-2', kind: 'chat', x: 0, y: 0 } as any])
    expect(flow[0].type).toBe('sticky')
    expect(String(flow[0].data.text)).toContain('removed')
    expect(String(flow[0].data.text)).not.toContain('--resume')
  })
})

describe('createAgentNode permission mode', () => {
  it('appends the flag for claude', () => {
    const node = createAgentNode('claude', 0, undefined, undefined, undefined, undefined, undefined, 'auto')
    expect(node.data.initialCommand).toBe('claude --permission-mode auto')
  })

  it('stays bare in manual mode (legacy parity)', () => {
    const node = createAgentNode('claude', 0, undefined, undefined, undefined, undefined, undefined, 'manual')
    expect(node.data.initialCommand).toBe('claude')
  })

  it('stays bare when no mode is passed at all (legacy parity)', () => {
    const node = createAgentNode('claude', 0)
    expect(node.data.initialCommand).toBe('claude')
  })

  it('keeps the flag after the initial prompt so the prompt stays claude argv', () => {
    const node = createAgentNode('claude', 0, undefined, undefined, 'fix the bug', undefined, undefined, 'auto')
    expect(node.data.initialCommand).toBe("claude 'fix the bug' --permission-mode auto")
  })

  // opencode has no approval flag at all, and a custom agent is in no capability list. codex and
  // gemini DO have one, each spelled its own way — those composed commands are pinned in
  // workspace.agent-prompt.test.ts, next to grok's separator rule.
  it('never flags a non-capable agent', () => {
    const node = createAgentNode('opencode', 0, undefined, undefined, undefined, undefined, undefined, 'auto')
    expect(node.data.initialCommand).toBe('opencode')
    const custom = createAgentNode('custom:x', 0, undefined, undefined, undefined, undefined, undefined, 'auto')
    expect(custom.data.initialCommand).toBe('custom:x')
  })
})

describe('createAgentNode prompt injection', () => {
  it('uses --prompt for flag-prompt agents (opencode)', () => {
    const n = createAgentNode('opencode', 0, undefined, undefined, "rerank the results")
    expect(n.data.initialCommand).toBe("opencode --prompt 'rerank the results'")
  })
  it('uses --interactive for Copilot so the prompted session stays open', () => {
    const n = createAgentNode('copilot', 0, undefined, undefined, 'fix the bug')
    expect(n.data.initialCommand).toContain("copilot --interactive 'fix the bug'")
    expect(n.data.initialCommand).toContain('--session-id=')
    expect(n.data.initialCommand).not.toContain('--prompt')
  })
  it('shell-quotes a flag-prompt safely', () => {
    const n = createAgentNode('opencode', 0, undefined, undefined, "it's tricky")
    expect(n.data.initialCommand).toBe("opencode --prompt 'it'\\''s tricky'")
  })
  it('keeps argv injection byte-identical for codex and gemini', () => {
    expect(createAgentNode('codex', 0, undefined, undefined, 'do X').data.initialCommand).toBe("codex 'do X'")
    expect(createAgentNode('gemini', 0, undefined, undefined, 'do X').data.initialCommand).toBe("gemini 'do X'")
  })
  it('launches AGY, Pi, and Goose with their interactive prompt forms', () => {
    expect(createAgentNode('agy', 0, undefined, undefined, 'do X').data.initialCommand).toBe(
      "agy --prompt-interactive 'do X'"
    )
    expect(createAgentNode('pi', 0, undefined, undefined, 'do X').data.initialCommand).toBe("pi 'do X'")
    expect(createAgentNode('goose', 0).data.initialCommand).toBe('goose session')
    expect(createAgentNode('goose', 0, undefined, undefined, 'do X').data.initialCommand).toBe(
      "goose run --interactive --text 'do X'"
    )
  })
})
