import { describe, it, expect } from 'vitest'
import { pushEntry, popEntry, dropClosedSessionRef, HISTORY_CAP, type ReopenEntry } from './reopenHistory'
import type { ReopenNodeSnapshot } from '@renderer/lib/reopenNode'

const proj = (id: string, closedAt: number): ReopenEntry => ({ kind: 'project', projectId: id, closedAt })

const snap = (over: Partial<ReopenNodeSnapshot> = {}): ReopenNodeSnapshot =>
  ({
    type: 'terminal', position: { x: 0, y: 0 }, absolutePosition: { x: 0, y: 0 },
    data: { title: 't', color: '#fff', group: null },
    ...over
  }) as ReopenNodeSnapshot

const nodesEntry = (projectId: string, snapshots: ReopenNodeSnapshot[]): ReopenEntry => ({
  kind: 'nodes', projectId, closedAt: 1, nodes: snapshots
})

describe('pushEntry', () => {
  it('appends to the end (most recent last)', () => {
    const out = pushEntry([proj('a', 1)], proj('b', 2), 10)
    expect(out.map((e) => (e as { projectId: string }).projectId)).toEqual(['a', 'b'])
  })

  it('caps the stack, dropping the OLDEST entries', () => {
    const stack = [proj('a', 1), proj('b', 2)]
    const out = pushEntry(stack, proj('c', 3), 2)
    expect(out.map((e) => (e as { projectId: string }).projectId)).toEqual(['b', 'c'])
  })

  it('HISTORY_CAP is 10', () => {
    expect(HISTORY_CAP).toBe(10)
  })
})

describe('popEntry', () => {
  it('removes and returns the LAST (most recent) entry', () => {
    const stack = [proj('a', 1), proj('b', 2)]
    const { entry, rest } = popEntry(stack)
    expect(entry).toEqual(proj('b', 2))
    expect(rest).toEqual([proj('a', 1)])
  })

  it('returns undefined entry and an empty rest for an empty stack', () => {
    const { entry, rest } = popEntry([])
    expect(entry).toBeUndefined()
    expect(rest).toEqual([])
  })
})

describe('dropClosedSessionRef', () => {
  it('drops the one matching snapshot, keeping the rest of the batch', () => {
    const stack = [
      nodesEntry('p1', [
        snap({ closedSessionId: 'e1' }),
        snap({ closedSessionId: 'e2' })
      ])
    ]
    const out = dropClosedSessionRef(stack, 'p1', 'e1')
    expect(out).toHaveLength(1)
    expect((out[0] as { nodes: ReopenNodeSnapshot[] }).nodes.map((n) => n.closedSessionId)).toEqual(['e2'])
  })

  it('drops the whole entry once its last matching snapshot is removed — an empty batch is a dead stack slot', () => {
    const stack = [nodesEntry('p1', [snap({ closedSessionId: 'e1' })])]
    expect(dropClosedSessionRef(stack, 'p1', 'e1')).toEqual([])
  })

  it('only matches the same projectId — a foreign project with the same entry id is untouched', () => {
    const stack = [nodesEntry('other', [snap({ closedSessionId: 'e1' })])]
    expect(dropClosedSessionRef(stack, 'p1', 'e1')).toEqual(stack)
  })

  it('leaves kind:"project" entries and snapshots with no closedSessionId untouched', () => {
    const stack = [proj('p1', 1), nodesEntry('p1', [snap()])]
    expect(dropClosedSessionRef(stack, 'p1', 'e1')).toEqual(stack)
  })
})
