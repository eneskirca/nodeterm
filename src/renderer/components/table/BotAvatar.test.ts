import { describe, expect, it } from 'vitest'
import { presenceOf } from './BotAvatar'

describe('presenceOf', () => {
  it('uses avatar motion instead of a status chip', () => {
    expect(presenceOf(undefined)).toBe('idle')
    expect(presenceOf('working')).toBe('working')
    expect(presenceOf('waiting')).toBe('waiting')
    expect(presenceOf('blocked')).toBe('blocked')
    expect(presenceOf('done')).toBe('done')
  })

  it('an armed synthesizer waits until workers finish', () => {
    expect(presenceOf(undefined, true)).toBe('waiting')
    expect(presenceOf('done', true)).toBe('done')
    expect(presenceOf('working', true)).toBe('working')
  })
})
