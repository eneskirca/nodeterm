import { describe, expect, it } from 'vitest'
import {
  MAX_CANON_BYTES,
  MAX_LAUNCH_LINE_BYTES,
  fitsLaunchLine,
  lineBytes
} from './canonical-line'

describe('the canonical-mode line budget', () => {
  it('is macOS MAX_CANON, with a byte reserved for the submitting CR', () => {
    // Measured on a real pty (see the module header): a 4000-byte payload plus its newline fit a
    // 4096-byte Linux buffer, 5000 did not. macOS caps at 1024, and the renderer cannot know
    // which machine the pane is on — so the smallest cap is the one that must hold.
    expect(MAX_CANON_BYTES).toBe(1024)
    expect(MAX_LAUNCH_LINE_BYTES).toBe(1023)
  })

  it('measures BYTES, not characters — a prompt is rarely pure ASCII', () => {
    // '—' is 3 UTF-8 bytes. Counting characters would let a 400-em-dash line through a 1023-byte
    // buffer that will truncate it.
    expect(lineBytes('—')).toBe(3)
    expect(lineBytes('a')).toBe(1)
    const emDashes = '—'.repeat(400)
    expect(emDashes.length).toBeLessThan(MAX_LAUNCH_LINE_BYTES)
    expect(fitsLaunchLine(emDashes)).toBe(false)
  })

  it('fits a line at the budget and refuses one past it', () => {
    expect(fitsLaunchLine('x'.repeat(MAX_LAUNCH_LINE_BYTES))).toBe(true)
    expect(fitsLaunchLine('x'.repeat(MAX_LAUNCH_LINE_BYTES + 1))).toBe(false)
  })
})
