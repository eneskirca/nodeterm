import { describe, expect, it } from 'vitest'
import { mediaRange } from './media-range'

describe('media byte ranges', () => {
  it.each([
    ['bytes=0-99', { start: 0, end: 99 }],
    ['bytes=100-', { start: 100, end: 999 }],
    ['bytes=-100', { start: 900, end: 999 }],
    ['bytes=-2000', { start: 0, end: 999 }],
    ['bytes=900-2000', { start: 900, end: 999 }],
    ['bytes=1000-', 'unsatisfiable'], ['bytes=100-99', 'unsatisfiable'],
    ['bytes=-0', 'unsatisfiable'], ['bytes=-', null],
    ['bytes=1-2,4-5', null], ['junk bytes=1-2', null]
  ])('%s', (header, expected) => expect(mediaRange(header, 1000)).toEqual(expected))
  it('rejects ranges on empty files', () => expect(mediaRange('bytes=0-', 0)).toBe('unsatisfiable'))
})
