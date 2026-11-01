import { describe, expect, it } from 'vitest'
import { thinkingLabel } from './chatThinking'

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
