import { describe, it, expect } from 'vitest'
import { isLaunchShell, isShellCommand } from './pane'

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

  it('recognises the Windows session host\'s image names (any case, .exe, full path)', () => {
    expect(isShellCommand('pwsh.exe')).toBe(true)
    expect(isShellCommand('pwsh')).toBe(true)
    expect(isShellCommand('PowerShell.EXE')).toBe(true)
    expect(isShellCommand('C:\\Windows\\System32\\cmd.exe')).toBe(true)
    expect(isShellCommand('C:\\Program Files\\Git\\bin\\bash.exe')).toBe(true)
    expect(isShellCommand('nu')).toBe(true)
  })

  it('still rejects agent CLIs and other programs under the Windows normalisation', () => {
    expect(isShellCommand('node.exe')).toBe(false)
    expect(isShellCommand('claude.exe')).toBe(false)
    expect(isShellCommand('C:\\Users\\me\\AppData\\Roaming\\npm\\codex.cmd')).toBe(false)
    expect(isShellCommand('vim')).toBe(false)
    expect(isShellCommand('ssh')).toBe(false)
  })

  it('isLaunchShell is the same predicate', () => {
    for (const c of ['zsh', '-bash', 'pwsh.exe', 'cmd', 'POWERSHELL.EXE', 'node', null, ''])
      expect(isLaunchShell(c)).toBe(isShellCommand(c))
  })
})
