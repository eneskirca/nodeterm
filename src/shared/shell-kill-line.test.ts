import { describe, expect, it } from 'vitest'
import {
  KILL_LINE,
  WINDOWS_KILL_LINE,
  shellKillLineSequence
} from './shell-kill-line'

describe('shellKillLineSequence', () => {
  it('returns \\x1b for Windows PowerShell, pwsh, and cmd dialects', () => {
    expect(shellKillLineSequence('windows-powershell')).toBe(WINDOWS_KILL_LINE)
    expect(shellKillLineSequence('pwsh')).toBe(WINDOWS_KILL_LINE)
    expect(shellKillLineSequence('cmd')).toBe(WINDOWS_KILL_LINE)
  })

  it('returns \\x15 for posix dialect even on Windows platform', () => {
    expect(shellKillLineSequence('posix', undefined, 'win32')).toBe(KILL_LINE)
    expect(shellKillLineSequence('posix', 'bash.exe', 'win32')).toBe(KILL_LINE)
  })

  it('infers sequence from bare shell executable name when dialect is omitted', () => {
    expect(shellKillLineSequence(undefined, 'powershell.exe')).toBe(WINDOWS_KILL_LINE)
    expect(shellKillLineSequence(undefined, 'powershell')).toBe(WINDOWS_KILL_LINE)
    expect(shellKillLineSequence(undefined, 'pwsh.exe')).toBe(WINDOWS_KILL_LINE)
    expect(shellKillLineSequence(undefined, 'pwsh')).toBe(WINDOWS_KILL_LINE)
    expect(shellKillLineSequence(undefined, 'cmd.exe')).toBe(WINDOWS_KILL_LINE)
    expect(shellKillLineSequence(undefined, 'cmd')).toBe(WINDOWS_KILL_LINE)
    expect(shellKillLineSequence(undefined, 'bash.exe')).toBe(KILL_LINE)
    expect(shellKillLineSequence(undefined, 'bash')).toBe(KILL_LINE)
    expect(shellKillLineSequence(undefined, 'zsh')).toBe(KILL_LINE)
    expect(shellKillLineSequence(undefined, 'sh')).toBe(KILL_LINE)
    expect(shellKillLineSequence(undefined, 'fish')).toBe(KILL_LINE)
  })

  it('infers sequence from full executable path with forward and backward slashes', () => {
    expect(shellKillLineSequence(undefined, 'C:\\Program Files\\PowerShell\\7\\pwsh.exe')).toBe(
      WINDOWS_KILL_LINE
    )
    expect(shellKillLineSequence(undefined, 'C:\\Windows\\System32\\cmd.exe')).toBe(
      WINDOWS_KILL_LINE
    )
    expect(shellKillLineSequence(undefined, 'C:\\Program Files\\Git\\bin\\bash.exe')).toBe(
      KILL_LINE
    )
    expect(shellKillLineSequence(undefined, '/usr/local/bin/zsh')).toBe(KILL_LINE)
    expect(shellKillLineSequence(undefined, '/bin/bash')).toBe(KILL_LINE)
  })

  it('lets dialect override executable name', () => {
    expect(shellKillLineSequence('posix', 'powershell.exe', 'win32')).toBe(KILL_LINE)
    expect(shellKillLineSequence('pwsh', 'bash.exe', 'linux')).toBe(WINDOWS_KILL_LINE)
  })

  it('falls back based on host platform when dialect and shell executable are unknown', () => {
    expect(shellKillLineSequence(undefined, undefined, 'win32')).toBe(WINDOWS_KILL_LINE)
    expect(shellKillLineSequence(undefined, undefined, 'darwin')).toBe(KILL_LINE)
    expect(shellKillLineSequence(undefined, undefined, 'linux')).toBe(KILL_LINE)
    expect(shellKillLineSequence(undefined, undefined, null)).toBe(KILL_LINE)
  })
})
