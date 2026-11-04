import { describe, expect, it } from 'vitest'
import { suggestionOf, withSuggestion } from './pull-suggestion'

describe('suggestionOf', () => {
  it('reads the first suggestion block, an empty one as a delete, and none as null', () => {
    expect(suggestionOf('Try:\r\n```suggestion\r\nconst a = 1\r\n  b()\r\n```\nthanks')).toEqual(['const a = 1', '  b()'])
    expect(suggestionOf('```suggestion\n```')).toEqual([])
    expect(suggestionOf('```suggestion\n\n```')).toEqual([''])
    expect(suggestionOf('```ts\nx\n```')).toBeNull()
    expect(suggestionOf('```suggestion\nnever closed')).toBeNull()
  })
})

describe('withSuggestion', () => {
  it('replaces the line range and keeps the line ending and the last newline', () => {
    expect(withSuggestion('a\nb\nc\n', 2, 2, ['B'])).toBe('a\nB\nc\n')
    expect(withSuggestion('a\r\nb\r\nc', 1, 2, ['X', 'Y', 'Z'])).toBe('X\r\nY\r\nZ\r\nc')
    expect(withSuggestion('a\nb\nc\n', 2, 3, [])).toBe('a\n')
  })

  it('answers null for a range the file does not have', () => {
    expect(withSuggestion('a\nb\n', 3, 3, ['x'])).toBeNull()
    expect(withSuggestion('a\nb\n', 2, 1, ['x'])).toBeNull()
    expect(withSuggestion('a\nb\n', 0, 1, ['x'])).toBeNull()
  })
})
