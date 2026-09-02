import { describe, expect, it } from 'vitest'
import { toKanbanSession } from './toKanbanSession'
import type { CanvasNode } from '../state/workspace'

const sticky = (text: string): CanvasNode =>
  ({
    id: 'n1',
    type: 'sticky',
    position: { x: 0, y: 0 },
    data: { text }
  }) as unknown as CanvasNode

describe('toKanbanSession (sticky)', () => {
  // Issue #285: the card modal's textarea is CONTROLLED by session.text. If the projection trims,
  // every space/newline typed at the end of the note is stripped on the round-trip — the space key
  // looks dead in the kanban note editor.
  it('passes the note body through untrimmed (a trailing space survives the round-trip)', () => {
    expect(toKanbanSession(sticky('hello '))?.text).toBe('hello ')
  })

  it('passes a trailing newline through (Enter at the end of a note)', () => {
    expect(toKanbanSession(sticky('line one\n'))?.text).toBe('line one\n')
  })

  it('still derives the card label from the trimmed first line', () => {
    expect(toKanbanSession(sticky('  hello world  \nsecond'))?.title).toBe('hello world')
  })

  it('labels an all-whitespace note "Note"', () => {
    expect(toKanbanSession(sticky('   '))?.title).toBe('Note')
  })
})

describe('toKanbanSession (sticky, markdown label)', () => {
  it('strips a leading heading marker from the card label', () => {
    expect(toKanbanSession(sticky('## Plan \nbody'))?.title).toBe('Plan')
  })
})

describe('toKanbanSession (github links)', () => {
  const node = (type: string): CanvasNode =>
    ({
      id: 'n1',
      type,
      position: { x: 0, y: 0 },
      data: { text: 'note', github: [{ kind: 'issue', number: 12, title: 'Board' }] }
    }) as unknown as CanvasNode

  for (const type of ['terminal', 'sticky', 'browser']) {
    it(`copies the links onto a ${type} card`, () => {
      expect(toKanbanSession(node(type))?.github).toEqual([
        { kind: 'issue', number: 12, title: 'Board' }
      ])
    })
  }
})
