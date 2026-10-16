import { describe, expect, it } from 'vitest'
import { boardVerbReply } from './boardVerb'
import type { ProjectKanban } from '@shared/types'

const board: ProjectKanban = {
  columns: [
    { id: 'c1', title: 'To Do' },
    { id: 'c2', title: 'Done' }
  ],
  assignments: [
    { nodeId: 'a', columnId: 'c2' },
    { nodeId: 'gone', columnId: 'c1' }
  ]
} as ProjectKanban

describe('boardVerbReply', () => {
  it('lists each column with its live session cards and the rest as Ungrouped', () => {
    const r = boardVerbReply(board, [
      { id: 'a', title: 'Alpha' },
      { id: 'b', title: '' }
    ])
    expect(r.result).toEqual({
      columns: [
        { id: 'c1', title: 'To Do', cards: [] },
        { id: 'c2', title: 'Done', cards: ['a'] }
      ],
      ungrouped: ['b']
    })
    expect(r.message).toContain('Done (1) [column id: c2]:\n  - Alpha (id: a)')
    expect(r.message).toContain('Ungrouped (1):\n  - Untitled (id: b)')
    expect(r.message.startsWith('Kanban board:')).toBe(true)
  })

  it('a board-less project puts every session in Ungrouped', () => {
    const r = boardVerbReply(undefined, [{ id: 'a', title: 'Alpha' }])
    expect(r.result).toEqual({ columns: [], ungrouped: ['a'] })
    expect(r.message).toMatch(/no columns yet/)
  })

  it('names the project when reading another project (board --project)', () => {
    expect(boardVerbReply(undefined, [], 'Other').message).toMatch(/^Kanban board of project "Other"/)
  })
})
