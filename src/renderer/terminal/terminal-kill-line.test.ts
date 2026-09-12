import { describe, expect, it } from 'vitest'
import { KILL_LINE, WINDOWS_KILL_LINE } from '@shared/shell-kill-line'
import { terminalKillLine, type TerminalKillLineFacts } from './terminal-kill-line'

const facts = (overrides: Partial<TerminalKillLineFacts> = {}): TerminalKillLineFacts => ({
  source: 'local',
  browserRuntime: false,
  viewerWindows: false,
  corePlatform: null,
  remoteSession: false,
  shell: undefined,
  ...overrides
})

describe('terminalKillLine', () => {
  it('uses the local desktop viewer only where viewer and host are the same machine', () => {
    expect(terminalKillLine(facts({ viewerWindows: true }))).toBe(WINDOWS_KILL_LINE)
    expect(terminalKillLine(facts({ viewerWindows: false }))).toBe(KILL_LINE)
  })

  it('uses the Server Edition host rather than the browser OS', () => {
    // Windows browser pointed at a Linux server must NOT write Escape into bash
    expect(
      terminalKillLine(
        facts({ source: 'local', browserRuntime: true, viewerWindows: true, corePlatform: 'linux' })
      )
    ).toBe(KILL_LINE)
    // Non-Windows browser pointed at a Windows Server Edition writes Escape
    expect(
      terminalKillLine(
        facts({ source: 'local', browserRuntime: true, viewerWindows: false, corePlatform: 'win32' })
      )
    ).toBe(WINDOWS_KILL_LINE)
  })

  it('uses the relay host rather than the relay guest OS', () => {
    expect(
      terminalKillLine(facts({ source: 'relay', viewerWindows: true, corePlatform: 'darwin' }))
    ).toBe(KILL_LINE)
    expect(
      terminalKillLine(facts({ source: 'relay', viewerWindows: false, corePlatform: 'win32' }))
    ).toBe(WINDOWS_KILL_LINE)
  })

  it('treats a remote session as POSIX even when desktop core is Windows', () => {
    expect(
      terminalKillLine(facts({ viewerWindows: true, corePlatform: 'win32', remoteSession: true }))
    ).toBe(KILL_LINE)
  })

  it('fails closed to KILL_LINE (\\x15) when core platform read has not completed on server or relay', () => {
    expect(
      terminalKillLine(facts({ source: 'local', browserRuntime: true, viewerWindows: true }))
    ).toBe(KILL_LINE)
    expect(terminalKillLine(facts({ source: 'server', viewerWindows: true }))).toBe(KILL_LINE)
    expect(terminalKillLine(facts({ source: 'relay', viewerWindows: false }))).toBe(KILL_LINE)
  })

  it('respects shell executable on Windows platform (e.g. git-bash uses \\x15)', () => {
    expect(
      terminalKillLine(
        facts({
          viewerWindows: true,
          corePlatform: 'win32',
          shell: 'C:\\Program Files\\Git\\bin\\bash.exe'
        })
      )
    ).toBe(KILL_LINE)
    expect(
      terminalKillLine(
        facts({
          viewerWindows: true,
          corePlatform: 'win32',
          shell: 'bash'
        })
      )
    ).toBe(KILL_LINE)
    expect(
      terminalKillLine(
        facts({
          viewerWindows: true,
          corePlatform: 'win32',
          shell: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
        })
      )
    ).toBe(WINDOWS_KILL_LINE)
    expect(
      terminalKillLine(
        facts({
          viewerWindows: true,
          corePlatform: 'win32',
          shell: 'pwsh.exe'
        })
      )
    ).toBe(WINDOWS_KILL_LINE)
  })
})
