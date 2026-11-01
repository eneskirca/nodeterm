import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '@shared/types'
import { thinkingDuration, thinkingLabel } from './chatThinking'

const think = (at?: number): ChatMessage => ({ role: 'assistant', parts: [{ kind: 'thinking', text: 'hmm' }], ...(at === undefined ? {} : { at }) })
const say = (at?: number): ChatMessage => ({ role: 'assistant', parts: [{ kind: 'text', text: 'ok' }], ...(at === undefined ? {} : { at }) })

describe('thinkingDuration', () => {
  it('duration is the gap to the next stamped message', () => {
    expect(thinkingDuration([think(1000), say(13_400)], 0)).toBe(12_400)
  })

  it('a zero gap is a duration, not "unknown"', () => {
    expect(thinkingDuration([think(5000), say(5000)], 0)).toBe(0)
  })

  it('no duration for the last message, an unstamped neighbour, a negative gap, or a mixed message', () => {
    // The last message has no next one to measure against.
    expect(thinkingDuration([say(0), think(1000)], 1)).toBeUndefined()
    // Either stamp missing.
    expect(thinkingDuration([think(), say(13_400)], 0)).toBeUndefined()
    expect(thinkingDuration([think(1000), say()], 0)).toBeUndefined()
    // The next line is stamped EARLIER (another machine's clock): never a negative duration.
    expect(thinkingDuration([think(13_400), say(1000)], 0)).toBeUndefined()
    // A message that also holds text or a tool did not spend the gap thinking alone.
    const mixed: ChatMessage = { role: 'assistant', parts: [{ kind: 'thinking', text: 'hmm' }, { kind: 'text', text: 'ok' }], at: 1000 }
    expect(thinkingDuration([mixed, say(13_400)], 0)).toBeUndefined()
    const withTool: ChatMessage = {
      role: 'assistant',
      parts: [{ kind: 'thinking', text: 'hmm' }, { kind: 'tool', name: 'Bash', arg: 'ls' }],
      at: 1000
    }
    expect(thinkingDuration([withTool, say(13_400)], 0)).toBeUndefined()
  })

  it('no duration for a message that is not thinking at all, or an index out of range', () => {
    expect(thinkingDuration([say(1000), say(13_400)], 0)).toBeUndefined()
    expect(thinkingDuration([{ role: 'assistant', parts: [], at: 1000 }, say(13_400)], 0)).toBeUndefined()
    expect(thinkingDuration([think(1000)], 5)).toBeUndefined()
    expect(thinkingDuration([], 0)).toBeUndefined()
  })
})

describe('thinkingLabel', () => {
  it.each([
    [undefined, 'Thinking'],
    [0, 'Thought for 1s'],
    [400, 'Thought for 1s'],
    [12_400, 'Thought for 12s'],
    [12_600, 'Thought for 13s'],
    [59_400, 'Thought for 59s'],
    // Rounded first, so 59.6 s is a minute, never "60s".
    [59_600, 'Thought for 1m 0s'],
    [60_000, 'Thought for 1m 0s'],
    [95_000, 'Thought for 1m 35s'],
    [3_725_000, 'Thought for 62m 5s']
  ])('%s ms reads %j', (ms, label) => {
    expect(thinkingLabel(ms)).toBe(label)
  })
})
