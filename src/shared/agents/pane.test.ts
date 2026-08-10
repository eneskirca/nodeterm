import { describe, it, expect } from 'vitest'
import { isShellCommand } from './pane'

describe('isShellCommand', () => {
  it('recognises plain and login shells', () => {
    expect(isShellCommand('zsh')).toBe(true)
    expect(isShellCommand('-zsh')).toBe(true)
    expect(isShellCommand('bash')).toBe(true)
    expect(isShellCommand('/bin/sh')).toBe(true)
    expect(isShellCommand('/usr/bin/fish')).toBe(true)
  })

  it('does not mistake an agent CLI for a shell', () => {
    expect(isShellCommand('claude')).toBe(false)
    expect(isShellCommand('codex')).toBe(false)
    expect(isShellCommand('node')).toBe(false)
  })

  it('treats an unknown answer as not-a-shell', () => {
    expect(isShellCommand(null)).toBe(false)
    expect(isShellCommand(undefined)).toBe(false)
    expect(isShellCommand('')).toBe(false)
  })
})
