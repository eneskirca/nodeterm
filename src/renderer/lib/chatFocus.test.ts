import { describe, expect, it } from 'vitest'
import type { ChatMessage, ChatPart } from '@shared/types'
import { focusHides, latestTodoIndex, staleTodo } from './chatFocus'

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

describe('focusHides', () => {
  const LATEST = 4
  it.each<[string, ChatPart, number, boolean]>([
    ['text', { kind: 'text', text: 'answer' }, 0, false],
    ['an image', { kind: 'image', mediaType: 'image/png', data: 'AAAA' }, 0, false],
    ['thinking', { kind: 'thinking', text: 'hmm', ms: 1000 }, 0, true],
    ['a plain tool chip', { kind: 'tool', name: 'Bash', arg: 'ls', result: 'a' }, 0, true],
    [
      'an Edit diff chip',
      { kind: 'tool', name: 'Edit', arg: '/a', diff: { filePath: '/a', oldText: 'a', newText: 'b' } },
      0,
      true
    ],
    ['a plan card', { kind: 'tool', name: 'ExitPlanMode', arg: '', body: '# Plan' }, 0, false],
    ['a question card', { kind: 'tool', name: 'AskUserQuestion', arg: '', body: 'Q?', questions: [] }, 0, false],
    ['the latest todo card', todo('- [ ] a'), LATEST, false],
    ['an older todo card', todo('- [ ] a'), 1, true],
    ['a todo without a body', todo(), LATEST, true]
  ])('%s → %s', (_label, part, at, hidden) => {
    expect(focusHides(part, at, LATEST)).toBe(hidden)
  })
})
