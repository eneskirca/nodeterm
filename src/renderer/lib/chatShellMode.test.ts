import { describe, expect, it } from 'vitest'
import { draftFromDisplay, isShellDraft, shellDisplayText, showsShellMode } from './chatShellMode'

describe('chatShellMode', () => {
  it('styles shell mode for claude only', () => {
    expect(showsShellMode('claude')).toBe(true)
    expect(showsShellMode('codex')).toBe(false)
    expect(showsShellMode(undefined)).toBe(false)
  })

  it('is shell mode exactly when the draft starts with `!`', () => {
    expect(isShellDraft('!ls')).toBe(true)
    expect(isShellDraft('!')).toBe(true)
    expect(isShellDraft('ls !')).toBe(false)
    expect(isShellDraft('')).toBe(false)
  })

  it('shows the text after the `!`, and puts it back', () => {
    expect(shellDisplayText('!ls', true)).toBe('ls')
    expect(draftFromDisplay('ls', true)).toBe('!ls')
    expect(shellDisplayText('!ls', false)).toBe('!ls')
    expect(draftFromDisplay('!ls', false)).toBe('!ls')
  })
})
