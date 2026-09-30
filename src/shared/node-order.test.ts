import { describe, it, expect } from 'vitest'
import { groupsFirst, groupsFirstBy } from './node-order'
import type { CanvasNodeState } from './types'

const s = (id: string, kind: CanvasNodeState['kind'], parentId?: string): CanvasNodeState =>
  ({
    id, kind, title: id, color: '#fff', position: { x: 0, y: 0 }, size: { width: 1, height: 1 },
    ...(parentId ? { parentId } : {})
  }) as CanvasNodeState
const ids = (nodes: Array<{ id: string }>): string[] => nodes.map((n) => n.id)

describe('groupsFirst — one parent-first order for every node shape', () => {
  it('emits frames depth-first from the root, then every other node in its own order', () => {
    const out = groupsFirst([s('x', 'terminal', 'I'), s('I', 'group', 'O'), s('y', 'sticky'), s('O', 'group')])
    expect(ids(out)).toEqual(['O', 'I', 'x', 'y'])
  })

  it('a cyclic parentId chain is emitted once; a missing parent is not followed', () => {
    expect(ids(groupsFirst([s('A', 'group', 'B'), s('B', 'group', 'A'), s('C', 'group', 'gone')]))).toEqual(['B', 'A', 'C'])
  })

  it('reads the group test it is given (a React Flow node says `type`)', () => {
    const rf = [
      { id: 'a', type: 'terminal', parentId: 'G' },
      { id: 'G', type: 'group' }
    ]
    expect(ids(groupsFirstBy(rf, (n) => n.type === 'group'))).toEqual(['G', 'a'])
  })
})
