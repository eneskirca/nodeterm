import fs from 'fs'
import { describe, expect, it } from 'vitest'
import { WINDOWS_SH_CANDIDATES } from './agents/hooks/codex-windows-wrapper'
import { WINDOWS_SH_LAYOUTS, resolveWindowsSh } from './windows-sh'

const ENV = {
  ProgramFiles: 'C:\\Program Files',
  'ProgramFiles(x86)': 'C:\\Program Files (x86)',
  LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local',
  SystemRoot: 'C:\\Windows'
}

const only = (...hits: string[]) => (p: string) => hits.includes(p)

describe('resolveWindowsSh', () => {
  it('prefers the machine-wide Git layouts in order', () => {
    expect(
      resolveWindowsSh({
        env: ENV,
        exists: only('C:\\Program Files\\Git\\usr\\bin\\sh.exe', 'C:\\Program Files (x86)\\Git\\bin\\sh.exe')
      })
    ).toBe('C:\\Program Files\\Git\\usr\\bin\\sh.exe')
    expect(resolveWindowsSh({ env: ENV, exists: only('C:\\Program Files\\Git\\bin\\sh.exe') })).toBe(
      'C:\\Program Files\\Git\\bin\\sh.exe'
    )
  })

  it('finds the per-user (winget, no admin) install under LOCALAPPDATA', () => {
    expect(
      resolveWindowsSh({ env: ENV, exists: only('C:\\Users\\me\\AppData\\Local\\Programs\\Git\\bin\\sh.exe') })
    ).toBe('C:\\Users\\me\\AppData\\Local\\Programs\\Git\\bin\\sh.exe')
  })

  it('reads env names case-insensitively, as Windows does', () => {
    expect(
      resolveWindowsSh({ env: { PROGRAMFILES: 'D:\\Apps' }, exists: only('D:\\Apps\\Git\\bin\\sh.exe') })
    ).toBe('D:\\Apps\\Git\\bin\\sh.exe')
  })

  it('falls back to PATH last, and never picks a WSL shim under SystemRoot or WindowsApps', () => {
    const pathStr = 'C:\\Windows\\System32;C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps;"D:\\msys\\usr\\bin"'
    const exists = only(
      'C:\\Windows\\System32\\sh.exe',
      'C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\sh.exe',
      'D:\\msys\\usr\\bin\\sh.exe'
    )
    expect(resolveWindowsSh({ env: ENV, exists, pathStr })).toBe('D:\\msys\\usr\\bin\\sh.exe')
    expect(
      resolveWindowsSh({ env: { ...ENV, Path: 'C:\\Windows\\System32' }, exists: only('C:\\Windows\\System32\\sh.exe') })
    ).toBeNull()
  })

  it('answers null when there is no shell anywhere', () => {
    expect(resolveWindowsSh({ env: ENV, exists: () => false, pathStr: 'C:\\tools' })).toBeNull()
  })

  it('is the same list the codex wrapper probes, in the same order', () => {
    expect(WINDOWS_SH_CANDIDATES).toEqual([
      '%ProgramFiles%\\Git\\bin\\sh.exe',
      '%ProgramFiles%\\Git\\usr\\bin\\sh.exe',
      '%ProgramFiles(x86)%\\Git\\bin\\sh.exe',
      '%ProgramFiles(x86)%\\Git\\usr\\bin\\sh.exe',
      '%LOCALAPPDATA%\\Programs\\Git\\bin\\sh.exe',
      '%LOCALAPPDATA%\\Programs\\Git\\usr\\bin\\sh.exe'
    ])
    expect(WINDOWS_SH_CANDIDATES).toHaveLength(WINDOWS_SH_LAYOUTS.length)
  })

  // The windows-latest CI job has Git for Windows: the real env + fs must find its sh.
  it.runIf(process.platform === 'win32')('finds Git Bash on a real Windows machine', () => {
    const sh = resolveWindowsSh({ env: process.env, exists: (p) => fs.existsSync(p) })
    expect(sh).toMatch(/sh\.exe$/i)
  })
})
