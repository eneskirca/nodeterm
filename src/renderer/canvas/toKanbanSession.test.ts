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

const terminal = (data: Record<string, unknown>): CanvasNode =>
  ({
    id: 'term-1',
    type: 'terminal',
    position: { x: 0, y: 0 },
    data
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

describe('toKanbanSession (terminal launch record)', () => {
  it('projects the model and context window used by every kanban context meter', () => {
    const session = toKanbanSession(
      terminal({
        title: 'Claude',
        agentModel: 'old-model',
        agentLaunchModel: 'new-model[1m]',
        agentLaunchContextWindow: 400_000
      })
    )

    expect(session?.agentModel).toBe('new-model[1m]')
    expect(session?.agentLaunchContextWindow).toBe(400_000)
  })

  it('does not present a requested model as an accepted launch record', () => {
    const session = toKanbanSession(terminal({ agentModel: 'requested-model' }))

    expect(session?.agentModel).toBeUndefined()
  })
})
