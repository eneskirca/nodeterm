// applyMutationToFlow — a peer's canvas-sync mutation applied to the LIVE React Flow array.
//
// The first cut round-tripped the whole canvas through the serializers on every peer mutation
// (nodeStatesToFlow(applyCanvasMutation(flowToNodeStates(nodes), m))). The serializers are lossy BY
// DESIGN, so that destroyed live state ~20 times a second while a teammate dragged. Each `it` below
// is one of the things it destroyed.

import { describe, it, expect } from 'vitest'
import { applyMutationToFlow, flowToNodeStates, type CanvasNode } from './workspace'
import type { CanvasMutation, CanvasNodeState } from '@shared/types'

const flowNode = (id: string, x: number, extra: Partial<CanvasNode> = {}): CanvasNode =>
  ({
    id,
    type: 'terminal',
    position: { x, y: 0 },
    width: 400,
    height: 300,
    style: { width: 400, height: 300 },
    data: { title: id, color: '#fff', group: null, tags: [] },
    ...extra
  }) as CanvasNode

const state = (id: string, x: number, over: Partial<CanvasNodeState> = {}): CanvasNodeState =>
  ({
    id,
    kind: 'terminal',
    position: { x, y: 0 },
    size: { width: 400, height: 300 },
    title: id,
    color: '#fff',
    group: null,
    tags: [],
    ...over
  }) as CanvasNodeState

const upsert = (n: CanvasNodeState): CanvasMutation => ({ op: 'upsert', node: n })
const remove = (id: string): CanvasMutation => ({ op: 'remove', id })

describe('applyMutationToFlow', () => {
  it('patches the addressed node and leaves every other node OBJECT untouched (no re-render)', () => {
    const nodes = [flowNode('a', 0), flowNode('b', 10)]
    const out = applyMutationToFlow(nodes, upsert(state('b', 99)))
    expect(out[0]).toBe(nodes[0]) // same reference → React.memo holds → `a` does not re-render
    expect(out[1]).not.toBe(nodes[1])
    expect(out[1].position).toEqual({ x: 99, y: 0 })
  })

  // While a teammate drags, mutations land at ~20 Hz. Round-tripping wiped `selected` every time,
  // so you could not hold a box-select / shift-click long enough to group anything.
  it('preserves YOUR selection on the node the peer touched', () => {
    const nodes = [flowNode('a', 0, { selected: true })]
    const out = applyMutationToFlow(nodes, upsert(state('a', 50)))
    expect(out[0].selected).toBe(true)
    expect(out[0].position).toEqual({ x: 50, y: 0 })
  })

  // initialCommand / respawnNonce are deliberately not serialized. A peer's rename must
  // not silently drop them from a node that has not consumed them yet.
  it('keeps local-only node data (initialCommand) while applying the peer\'s fields', () => {
    const nodes = [
      flowNode('a', 0, {
        data: { title: 'old', color: '#fff', group: null, initialCommand: 'claude\r' }
      } as Partial<CanvasNode>)
    ]
    const out = applyMutationToFlow(nodes, upsert(state('a', 0, { title: 'renamed by peer' })))
    expect(out[0].data.initialCommand).toBe('claude\r')
    expect(out[0].data.title).toBe('renamed by peer')
  })

  it('applies a peer CLEARING a serialized field (tags removed, not merged back in)', () => {
    const nodes = [flowNode('a', 0, { data: { title: 'a', color: '#fff', group: null, tags: ['x'] } } as Partial<CanvasNode>)]
    const out = applyMutationToFlow(nodes, upsert(state('a', 0, { tags: undefined })))
    expect(out[0].data.tags).toBeUndefined()
  })

  // React Flow's `measured` wins over width/height when we serialize. Carrying a stale one would
  // make us re-publish the OLD size right back at the peer who just resized the node.
  it('drops the stale measured size so a peer resize is not fought', () => {
    const nodes = [flowNode('a', 0, { measured: { width: 400, height: 300 } } as Partial<CanvasNode>)]
    const out = applyMutationToFlow(nodes, upsert(state('a', 0, { size: { width: 900, height: 700 } })))
    expect(out[0].measured).toBeUndefined()
    expect(flowToNodeStates(out)[0].size).toEqual({ width: 900, height: 700 })
  })

  it('appends a node the peer created', () => {
    const nodes = [flowNode('a', 0)]
    const out = applyMutationToFlow(nodes, upsert(state('b', 20)))
    expect(out.map((n) => n.id)).toEqual(['a', 'b'])
  })

  it('removes a node the peer deleted, and is a no-op (same array) for one we do not have', () => {
    const nodes = [flowNode('a', 0), flowNode('b', 0)]
    expect(applyMutationToFlow(nodes, remove('b')).map((n) => n.id)).toEqual(['a'])
    expect(applyMutationToFlow(nodes, remove('zz'))).toBe(nodes) // identity → no setNodes churn
  })

  // React Flow REQUIRES a parent to appear before its children. A peer grouping nodes sends the new
  // group frame plus the (already present) children, so the frame arrives as an append.
  // Edges live in their own state; an edge op must come back as the SAME array, so the peer path's
  // `flow === nodesRef.current` short-circuit fires instead of a setNodes + adopt + markDirty.
  it('is a no-op (same array) for an edge mutation', () => {
    const nodes = [flowNode('a', 0)]
    expect(applyMutationToFlow(nodes, { op: 'edge-remove', kind: 'bridge', id: 'x' })).toBe(nodes)
    expect(
      applyMutationToFlow(nodes, { op: 'edge-upsert', kind: 'rope', edge: { id: 'x', source: 'a', target: 'a' } })
    ).toBe(nodes)
  })

  it('keeps parents before children when a peer creates a group around existing nodes', () => {
    const nodes = [flowNode('a', 0), flowNode('b', 0)]
    const withGroup = applyMutationToFlow(
      nodes,
      upsert(state('g1', 0, { kind: 'group' }))
    )
    const parented = applyMutationToFlow(
      withGroup,
      upsert(state('a', 0, { parentId: 'g1' }))
    )
    expect(parented.map((n) => n.id)).toEqual(['g1', 'a', 'b'])
    expect(parented.find((n) => n.id === 'a')!.parentId).toBe('g1')
  })
})
