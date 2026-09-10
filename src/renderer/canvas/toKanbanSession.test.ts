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

describe('toKanbanSession (terminal spawn)', () => {
  it('carries the live initialCommand so Mesa can type the agent CLI', () => {
    const n = {
      id: 'term-1',
      type: 'terminal',
      position: { x: 0, y: 0 },
      data: { title: 'Grok', agentId: 'grok', initialCommand: "grok --model 'grok-4.6'" }
    } as unknown as CanvasNode
    expect(toKanbanSession(n)?.spawn.initialCommand).toBe("grok --model 'grok-4.6'")
  })

  it('propagates managed swarm launchMode so a viewer cannot start the CLI', () => {
    const n = {
      id: 'term-2',
      type: 'terminal',
      position: { x: 0, y: 0 },
      data: { title: 'O', launchMode: 'runtime', initialCommand: 'mesa-orchestrator' }
    } as unknown as CanvasNode
    expect(toKanbanSession(n)?.spawn.launchMode).toBe('runtime')
  })
})
