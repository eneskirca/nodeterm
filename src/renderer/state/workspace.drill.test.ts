import { describe, it, expect } from 'vitest'
import {
  drillGroupChildren,
  drillSingleNode,
  flowToNodeStates,
  mergeSingleNode,
  nodeStatesToFlow,
  remergeDrilledNodes,
  rootPosition
} from './workspace'
import type { CanvasNode } from './workspace'

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

describe('rootPosition (exported for the isomorphism)', () => {
  it('sums a node position with every ancestor frame origin', () => {
    const nodes = [
      grp('outer', { x: 100, y: 100 }),
      grp('inner', { x: 50, y: 50 }, 'outer'),
      term('leaf', { x: 10, y: 10 }, 'inner')
    ]
    expect(rootPosition(nodes[2], nodes)).toEqual({ x: 160, y: 160 })
  })
})

describe('drillGroupChildren', () => {
  it("promotes a group's direct children to root-space and strips parentId/extent", () => {
    const nodes = [
      grp('g', { x: 200, y: 100 }),
      term('a', { x: 10, y: 20 }, 'g'),
      term('b', { x: 30, y: 40 }, 'g'),
      term('sibling', { x: 500, y: 500 }) // a sibling at top level — must NOT appear in the drilled view
    ]
    const { flow, childIds } = drillGroupChildren(nodes, 'g')

    expect(childIds).toEqual(new Set(['a', 'b']))
    expect(flow.map((n) => n.id).sort()).toEqual(['a', 'b'])
    // a was at (10,20) nested under g at (200,100) → root-space (210,120)
    const a = flow.find((n) => n.id === 'a')!
    expect(a.position).toEqual({ x: 210, y: 120 })
    expect(a.parentId).toBeUndefined()
    expect(a.extent).toBeUndefined()
    // sibling is excluded
    expect(flow.some((n) => n.id === 'sibling')).toBe(false)
  })

  it('keeps nested groups nested — only the drilled group’s DIRECT children are promoted', () => {
    const nodes = [
      grp('g', { x: 100, y: 100 }),
      grp('inner', { x: 20, y: 20 }, 'g'),
      term('leaf', { x: 5, y: 5 }, 'inner')
    ]
    const { flow, childIds } = drillGroupChildren(nodes, 'g')
    // direct child is `inner`; `leaf` is a grandchild, NOT a direct child of g
    expect(childIds).toEqual(new Set(['inner']))
    expect(flow.map((n) => n.id)).toEqual(['inner'])
    // inner keeps its own parentId? No — it is promoted to the sub-canvas top level, so parentId
    // stripped, position promoted to root-space (100+20, 100+20) = (120,120).
    const inner = flow[0]
    expect(inner.parentId).toBeUndefined()
    expect(inner.position).toEqual({ x: 120, y: 120 })
  })

  it('returns an empty flow for a group with no children', () => {
    const nodes = [grp('g', { x: 0, y: 0 }), term('x', { x: 9, y: 9 })]
    const { flow, childIds } = drillGroupChildren(nodes, 'g')
    expect(flow).toEqual([])
    expect(childIds.size).toBe(0)
  })
})

describe('remergeDrilledNodes (commit-while-drilled round-trip)', () => {
  it('merges edited drilled children back into the full array, re-nested, and preserves siblings', () => {
    // Full canvas: group g at (200,100) with children a (10,20) and b (30,40), plus a top-level
    // sibling `sib` that must survive the commit untouched.
    const fullFlow: CanvasNode[] = [
      grp('g', { x: 200, y: 100 }),
      term('a', { x: 10, y: 20 }, 'g'),
      term('b', { x: 30, y: 40 }, 'g'),
      term('sib', { x: 500, y: 500 })
    ]
    const fullStored = flowToNodeStates(fullFlow)

    // Drill → the active node-set is the children at root-space.
    const { flow: drilledFlow } = drillGroupChildren(fullFlow, 'g')
    // The user edits `a` while drilled: drags it to root-space (300,150).
    const editedDrilled = drilledFlow.map((n) =>
      n.id === 'a' ? { ...n, position: { x: 300, y: 150 } } : n
    )
    const drilledStates = flowToNodeStates(editedDrilled)

    const committed = remergeDrilledNodes(fullStored, drilledStates, 'g', fullFlow)

    // `a` is re-nested: root (300,150) minus g origin (200,100) = (100,50), parentId restored.
    const a = committed.find((s) => s.id === 'a')!
    expect(a.parentId).toBe('g')
    expect(a.position).toEqual({ x: 100, y: 50 })
    // `b` (un-edited) re-nests back to its original nested position (30,40).
    const b = committed.find((s) => s.id === 'b')!
    expect(b.parentId).toBe('g')
    expect(b.position).toEqual({ x: 30, y: 40 })
    // `sib` and the group frame `g` are untouched.
    const sib = committed.find((s) => s.id === 'sib')!
    expect(sib.parentId).toBeUndefined()
    expect(sib.position).toEqual({ x: 500, y: 500 })
    expect(committed.some((s) => s.id === 'g')).toBe(true)
    // No nodes lost or duplicated.
    expect(committed.map((s) => s.id).sort()).toEqual(['a', 'b', 'g', 'sib'])
  })

  it('round-trips an un-edited drill through remerge with positions unchanged', () => {
    const fullFlow: CanvasNode[] = [
      grp('g', { x: 200, y: 100 }),
      term('a', { x: 10, y: 20 }, 'g')
    ]
    const fullStored = flowToNodeStates(fullFlow)
    const { flow: drilledFlow } = drillGroupChildren(fullFlow, 'g')
    const committed = remergeDrilledNodes(fullStored, flowToNodeStates(drilledFlow), 'g', fullFlow)
    // a promoted to (210,120) then re-nested back to (10,20).
    expect(committed.find((s) => s.id === 'a')!.position).toEqual({ x: 10, y: 20 })
  })

  it('survives a full load round-trip through nodeStatesToFlow', () => {
    // The persisted states must re-flow to the same nested structure after a reload.
    const fullFlow: CanvasNode[] = [
      grp('g', { x: 200, y: 100 }),
      term('a', { x: 10, y: 20 }, 'g')
    ]
    const fullStored = flowToNodeStates(fullFlow)
    const { flow: drilledFlow } = drillGroupChildren(fullFlow, 'g')
    const editedDrilled = drilledFlow.map((n) =>
      n.id === 'a' ? { ...n, position: { x: 300, y: 150 } } : n
    )
    const committed = remergeDrilledNodes(fullStored, flowToNodeStates(editedDrilled), 'g', fullFlow)
    // Reload: re-flow the committed states.
    const reloaded = nodeStatesToFlow(committed)
    const a = reloaded.find((n) => n.id === 'a')!
    expect(a.parentId).toBe('g')
    expect(a.position).toEqual({ x: 100, y: 50 })
  })

  it('appends a NEW child created while drilled, re-nested under the group (08 hazard)', () => {
    // Full canvas: group g at (200,100) with child a; sib is a top-level sibling.
    const fullFlow: CanvasNode[] = [
      grp('g', { x: 200, y: 100 }),
      term('a', { x: 10, y: 20 }, 'g'),
      term('sib', { x: 500, y: 500 })
    ]
    const fullStored = flowToNodeStates(fullFlow)
    // Drill → drilled view has `a` at root-space (210,120). The user creates a NEW terminal `c`
    // while drilled, dropping it at root-space (300,300). `c` is in the drilled view but NOT in
    // fullStored (it didn't exist at drill entry).
    const drilledStates = flowToNodeStates([
      { ...fullFlow[1], parentId: undefined, extent: undefined, position: { x: 210, y: 120 } },
      term('c', { x: 300, y: 300 })
    ])

    const committed = remergeDrilledNodes(fullStored, drilledStates, 'g', fullFlow)

    // `c` is appended, re-nested: root (300,300) minus g origin (200,100) = (100,200), parentId = g.
    const c = committed.find((s) => s.id === 'c')!
    expect(c.parentId).toBe('g')
    expect(c.position).toEqual({ x: 100, y: 200 })
    // Sibling + group frame + original child all preserved.
    expect(committed.map((s) => s.id).sort()).toEqual(['a', 'c', 'g', 'sib'])
    // On reload, `c` re-flows nested under g (parentId → extent:'parent' on reflow).
    const reloaded = nodeStatesToFlow(committed)
    const cFlow = reloaded.find((n) => n.id === 'c')!
    expect(cFlow.parentId).toBe('g')
    expect(cFlow.extent).toBe('parent')
  })

  it('drops a child deleted while drilled from the committed array', () => {
    const fullFlow: CanvasNode[] = [
      grp('g', { x: 200, y: 100 }),
      term('a', { x: 10, y: 20 }, 'g'),
      term('b', { x: 30, y: 40 }, 'g')
    ]
    const fullStored = flowToNodeStates(fullFlow)
    // Drill → delete `a` while drilled: the drilled view now has only `b`.
    const drilledFlow: CanvasNode[] = [
      { ...fullFlow[2], parentId: undefined, extent: undefined, position: { x: 230, y: 140 } }
    ]
    const committed = remergeDrilledNodes(fullStored, flowToNodeStates(drilledFlow), 'g', fullFlow)
    // `a` is gone; `b` and `g` remain.
    expect(committed.map((s) => s.id).sort()).toEqual(['b', 'g'])
  })
})

describe('drillSingleNode (F11 focus, ticket 10)', () => {
  it('promotes a NESTED node to root-space and strips parentId/extent', () => {
    const nodes = [
      grp('g', { x: 200, y: 100 }),
      term('a', { x: 10, y: 20 }, 'g'),
      term('sib', { x: 500, y: 500 })
    ]
    const { flow, found } = drillSingleNode(nodes, 'a')
    expect(found).toBe(true)
    expect(flow.map((n) => n.id)).toEqual(['a'])
    // a nested under g at (200,100) → root-space (210,120)
    const a = flow[0]
    expect(a.position).toEqual({ x: 210, y: 120 })
    expect(a.parentId).toBeUndefined()
    expect(a.extent).toBeUndefined()
  })

  it('leaves a top-level node in place (no parent offset to strip)', () => {
    const nodes = [term('top', { x: 300, y: 150 })]
    const { flow, found } = drillSingleNode(nodes, 'top')
    expect(found).toBe(true)
    expect(flow[0].position).toEqual({ x: 300, y: 150 })
    expect(flow[0].parentId).toBeUndefined()
  })

  it('reports found:false for a missing node and returns an empty flow', () => {
    const { flow, found } = drillSingleNode([term('a', { x: 0, y: 0 })], 'nope')
    expect(found).toBe(false)
    expect(flow).toEqual([])
  })
})

describe('mergeSingleNode (commit-while-focused, ticket 10)', () => {
  it('re-nests an edited focused node under its original parent, preserving siblings', () => {
    // a nested under g at (200,100); sib is a top-level sibling that must survive untouched.
    const fullFlow: CanvasNode[] = [
      grp('g', { x: 200, y: 100 }),
      term('a', { x: 10, y: 20 }, 'g'),
      term('sib', { x: 500, y: 500 })
    ]
    const fullStored = flowToNodeStates(fullFlow)
    // Focus a → promoted to root-space (210,120) → user drags it to (400,300).
    const { flow: focusedFlow } = drillSingleNode(fullFlow, 'a')
    const editedFocused = { ...focusedFlow[0], position: { x: 400, y: 300 } }
    const focusedState = flowToNodeStates([editedFocused])[0]

    const committed = mergeSingleNode(fullStored, focusedState, fullFlow)

    // a re-nested: root (400,300) minus g origin (200,100) = (200,200), parentId restored.
    const a = committed.find((s) => s.id === 'a')!
    expect(a.parentId).toBe('g')
    expect(a.position).toEqual({ x: 200, y: 200 })
    // sib and g untouched.
    const sib = committed.find((s) => s.id === 'sib')!
    expect(sib.parentId).toBeUndefined()
    expect(sib.position).toEqual({ x: 500, y: 500 })
    expect(committed.some((s) => s.id === 'g')).toBe(true)
    expect(committed.map((s) => s.id).sort()).toEqual(['a', 'g', 'sib'])
  })

  it('keeps a top-level focused node top-level (no re-nest)', () => {
    const fullFlow: CanvasNode[] = [term('top', { x: 300, y: 150 })]
    const fullStored = flowToNodeStates(fullFlow)
    const { flow: focusedFlow } = drillSingleNode(fullFlow, 'top')
    const editedFocused = { ...focusedFlow[0], position: { x: 600, y: 400 } }
    const committed = mergeSingleNode(fullStored, flowToNodeStates([editedFocused])[0], fullFlow)
    expect(committed.find((s) => s.id === 'top')!.position).toEqual({ x: 600, y: 400 })
    expect(committed.find((s) => s.id === 'top')!.parentId).toBeUndefined()
  })

  it('drops a focused node deleted from the full set (no resurrection)', () => {
    const fullFlow: CanvasNode[] = [term('a', { x: 0, y: 0 })]
    const fullStored = flowToNodeStates(fullFlow)
    const { flow: focusedFlow } = drillSingleNode(fullFlow, 'a')
    const focusedState = flowToNodeStates(focusedFlow)[0]
    // The full set no longer holds `a` (deleted while focused).
    const committed = mergeSingleNode([], focusedState, [])
    expect(committed).toEqual([])
  })

  it('round-trips through nodeStatesToFlow after a focus + edit + merge', () => {
    const fullFlow: CanvasNode[] = [
      grp('g', { x: 200, y: 100 }),
      term('a', { x: 10, y: 20 }, 'g')
    ]
    const fullStored = flowToNodeStates(fullFlow)
    const { flow: focusedFlow } = drillSingleNode(fullFlow, 'a')
    const editedFocused = { ...focusedFlow[0], position: { x: 400, y: 300 } }
    const committed = mergeSingleNode(fullStored, flowToNodeStates([editedFocused])[0], fullFlow)
    const reloaded = nodeStatesToFlow(committed)
    const a = reloaded.find((n) => n.id === 'a')!
    expect(a.parentId).toBe('g')
    expect(a.position).toEqual({ x: 200, y: 200 })
    // extent is derived from parentId on reflow.
    expect(a.extent).toBe('parent')
  })
})
