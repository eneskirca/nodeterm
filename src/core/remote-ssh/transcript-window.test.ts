import { describe, expect, it } from 'vitest'
import { parseTranscriptWindow, transcriptWindowCommand } from './transcript-window'

const frame = (payload: string, status = 0): string => Buffer.from(payload + `\nNODETERM_READ_STATUS:${status}\n`).toString('base64')
describe('strict transcript window framing', () => {
  it('preserves bytes rather than re-encoding UTF-8 and trims block alignment', () => {
    const r = parseTranscriptWindow('1 1 3 0\n' + frame('aé'), 2)
    expect(r.data).toEqual(Buffer.from([0xc3]))
    expect(r.newOffset).toBe(2)
  })
  it.each([
    'bad\n', '0 5 4 0\n', '0 5 5 0\n', '0 0 0 1\nAAAA',
    '0 1 1 0\n' + frame('a', 1), '0 1 1 0\n' + frame(''),
    '0 1 1 0\n' + frame('a') + '!', '0 1 1 0\n' + Buffer.from('a').toString('base64')
  ])('rejects malformed, oversized, failed or short responses: %s', response => {
    expect(() => parseTranscriptWindow(response, 4)).toThrow()
  })
  it.each([-1, 1.5, NaN, Infinity])('rejects an invalid offset %s before invoking a shell', offset => {
    expect(() => transcriptWindowCommand('/fixture', offset, 1024)).toThrow()
  })
  it.each([0, -1, 1.5, Infinity, 1024 * 1024 + 1])('rejects an invalid cap %s', cap => {
    expect(() => transcriptWindowCommand('/fixture', null, cap)).toThrow()
  })
})
