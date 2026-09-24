import { describe, expect, it } from 'vitest'
import { mediaRange } from './media-range'

describe('media byte ranges', () => {
  it.each([
    ['bytes=2-5', 2, 5], ['bytes=2-', 2, 9], ['bytes=2-99', 2, 9],
    ['bytes=-3', 7, 9], ['bytes=-99', 0, 9]
  ])('%s selects the intended bytes', (header, start, end) => {
    expect(mediaRange(header as string, 10)).toEqual({ kind: 'partial', start, end })
  })
  it.each(['bytes=10-', 'bytes=-0'])('%s cannot be satisfied', (header) => {
    expect(mediaRange(header, 10)).toEqual({ kind: 'unsatisfiable' })
  })
  it('an empty file cannot satisfy a range', () => {
    expect(mediaRange('bytes=0-', 0)).toEqual({ kind: 'unsatisfiable' })
  })
  it.each([null, 'bytes=8-2', 'bytes=-', 'bytes=0-1,3-4', 'xbytes=1-3', 'bytes=99999999999999999-'])('ignores malformed/unsupported %s', (header) => {
    expect(mediaRange(header, 10)).toEqual({ kind: 'full' })
  })
})
