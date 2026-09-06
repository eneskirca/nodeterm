import { describe, expect, it } from 'vitest'
import type { ProjectKanban } from '@shared/types'
import { KANBAN_SOURCES, byLane, kanbanSource, sourceVisible } from './kanbanSources'

const board = (github?: ProjectKanban['github']): ProjectKanban =>
  ({ columns: [], assignments: [], github }) as ProjectKanban

describe('kanban source registry', () => {
  it('declares each source once, with a unique lane', () => {
    const ids = KANBAN_SOURCES.map((s) => s.id)
    const lanes = KANBAN_SOURCES.map((s) => s.lane)
    expect(new Set(ids).size).toBe(ids.length)
    expect(new Set(lanes).size).toBe(lanes.length)
  })

  it('stacks sessions above provider-placed cards in a column', () => {
    const ordered = byLane([
      { sourceId: 'pulls' as const },
      { sourceId: 'github' as const },
      { sourceId: 'sessions' as const }
    ])
    expect(ordered.map((lane) => lane.sourceId)).toEqual(['sessions', 'github', 'pulls'])
  })

  it('marks only the sources the board can never write', () => {
    expect(kanbanSource('pulls').readOnly).toBe(true)
    expect(kanbanSource('github').readOnly).toBeFalsy()
    expect(kanbanSource('sessions').readOnly).toBeFalsy()
  })

  it('keeps the board out of a provider-placed card’s column', () => {
    expect(kanbanSource('github').placement).toBe('provider')
    expect(kanbanSource('pulls').placement).toBe('provider')
    expect(kanbanSource('sessions').placement).toBe('assignment')
  })

  it('offers the GitHub sources only on a board configured for them; sessions always', () => {
    expect(kanbanSource('github').configured(board())).toBe(false)
    expect(kanbanSource('pulls').configured(board())).toBe(false)
    expect(kanbanSource('github').configured(board({ repository: 'owner/repo', columnMappings: [] }))).toBe(true)
    expect(kanbanSource('pulls').configured(board({ repository: 'owner/repo', columnMappings: [] }))).toBe(true)
    expect(kanbanSource('sessions').configured(board())).toBe(true)
  })

  it('shows one source under its own filter, every source under "all"', () => {
    expect(sourceVisible('all', 'github')).toBe(true)
    expect(sourceVisible('all', 'sessions')).toBe(true)
    expect(sourceVisible('sessions', 'github')).toBe(false)
    expect(sourceVisible('github', 'sessions')).toBe(false)
    expect(sourceVisible('github', 'github')).toBe(true)
    expect(sourceVisible('github', 'pulls')).toBe(false)
    expect(sourceVisible('pulls', 'pulls')).toBe(true)
  })

  it('rejects an unknown source id rather than answering for it', () => {
    expect(() => kanbanSource('nope' as never)).toThrow()
  })
})
