import { describe, expect, it } from 'vitest'
import { DRAG_MIN_PX, copiedLabel, decideDragOutcome } from './copy-feedback'

describe('copiedLabel', () => {
  it('counts characters for a single line', () => {
    expect(copiedLabel('hello')).toBe('Copied 5 chars')
  })
  it('singularizes one character', () => {
    expect(copiedLabel('x')).toBe('Copied 1 char')
  })
  it('counts lines for multi-line text', () => {
    expect(copiedLabel('a\nb\nc')).toBe('Copied 3 lines')
  })
  it('does not count a trailing newline as an extra line', () => {
    expect(copiedLabel('a\nb\n')).toBe('Copied 2 lines')
  })
  it('does not count a trailing newline as an extra character', () => {
    expect(copiedLabel('hello\n')).toBe('Copied 5 chars')
  })
  it('returns null for empty text — nothing was copied, so no pill', () => {
    expect(copiedLabel('')).toBeNull()
  })
  it('returns null for a bare newline — the strip leaves nothing to claim', () => {
    expect(copiedLabel('\n')).toBeNull()
  })
})

describe('decideDragOutcome', () => {
  const base = {
    movedPx: 40,
    sawOsc52: false,
    hasXtermSelection: false,
    hintSeen: false,
    isMac: true
  }
  it('hints when a real drag produced neither a copy nor a selection', () => {
    expect(decideDragOutcome(base)).toEqual({ kind: 'hint', label: 'Hold ⌥ to select text' })
  })
  it('says Shift off macOS', () => {
    expect(decideDragOutcome({ ...base, isMac: false })).toEqual({
      kind: 'hint',
      label: 'Hold Shift to select text'
    })
  })
  it('stays silent below the drag threshold — a click is not a drag', () => {
    expect(decideDragOutcome({ ...base, movedPx: DRAG_MIN_PX - 1 })).toBeNull()
  })
  it('hints at exactly the threshold — the boundary counts as a drag', () => {
    expect(decideDragOutcome({ ...base, movedPx: DRAG_MIN_PX })).toEqual({
      kind: 'hint',
      label: 'Hold ⌥ to select text'
    })
  })
  it('stays silent when an OSC 52 landed — the handler already put its pill up', () => {
    expect(decideDragOutcome({ ...base, sawOsc52: true })).toBeNull()
  })
  it('never nags the user who already held the modifier', () => {
    expect(decideDragOutcome({ ...base, hasXtermSelection: true })).toBeNull()
  })
  it('fires at most once per installation', () => {
    expect(decideDragOutcome({ ...base, hintSeen: true })).toBeNull()
  })
})
