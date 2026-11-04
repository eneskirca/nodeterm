import { describe, expect, it } from 'vitest'
import type { ChatMessage, ChatPart } from '@shared/types'
import { latestTodoIndex, staleTodo } from './chatTodo'

const todo = (body?: string): ChatPart => ({ kind: 'tool', name: 'TodoWrite', arg: '', ...(body ? { body } : {}) })
const msg = (...parts: ChatPart[]): ChatMessage => ({ role: 'assistant', parts })

describe('latestTodoIndex', () => {
  it('is the LAST message holding a TodoWrite card, else -1', () => {
    expect(latestTodoIndex([])).toBe(-1)
    expect(latestTodoIndex([msg({ kind: 'text', text: 'hi' })])).toBe(-1)
    expect(
      latestTodoIndex([
        msg(todo('- [ ] a')),
        msg({ kind: 'text', text: 'x' }),
        msg({ kind: 'tool', name: 'Bash', arg: 'ls' }, todo('- [x] a')),
        msg({ kind: 'text', text: 'done' })
      ])
    ).toBe(2)
  })

  it('ignores a TodoWrite without a body (a plain read, or an input that did not parse)', () => {
    expect(latestTodoIndex([msg(todo('- [ ] a')), msg(todo())])).toBe(0)
    expect(latestTodoIndex([msg(todo())])).toBe(-1)
  })
})

describe('staleTodo', () => {
  it('is a TodoWrite card that is not the latest one', () => {
    expect(staleTodo(todo('- [ ] a'), 0, 3)).toBe(true)
    expect(staleTodo(todo('- [ ] a'), 3, 3)).toBe(false)
    expect(staleTodo({ kind: 'tool', name: 'ExitPlanMode', arg: '', body: 'plan' }, 0, 3)).toBe(false)
    expect(staleTodo({ kind: 'text', text: 'TodoWrite' }, 0, 3)).toBe(false)
  })
})
