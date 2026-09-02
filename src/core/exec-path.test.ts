import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  directExecutableInvocation,
  executableCandidates,
  findInPathString,
  unquotePathEntry
} from './exec-path'

describe('executableCandidates', () => {
  it('leaves a bare name alone off win32 — POSIX has no PATHEXT', () => {
    expect(executableCandidates('gh', 'darwin', undefined)).toEqual(['gh'])
    expect(executableCandidates('gh', 'linux', '.EXE')).toEqual(['gh'])
  })

  it('appends PATHEXT on win32, extensions first and the bare name last', () => {
    // The regression this closes: `gh` on Windows is `gh.exe`, so a bare-name-only walk found
    // nothing and every caller fell through to its POSIX fallbacks. The ORDER is load-bearing too
    // — see the shim test below.
    expect(executableCandidates('gh', 'win32', '.COM;.EXE;.CMD')).toEqual([
      'gh.COM',
      'gh.EXE',
      'gh.CMD',
      'gh'
    ])
  })

  it('falls back to the stock PATHEXT when the variable is missing or empty', () => {
    expect(executableCandidates('ssh', 'win32', undefined)).toEqual([
      'ssh.COM',
      'ssh.EXE',
      'ssh.BAT',
      'ssh.CMD',
      'ssh'
    ])
    expect(executableCandidates('ssh', 'win32', '')).toEqual(
      executableCandidates('ssh', 'win32', undefined)
    )
  })

  it('tolerates whitespace and empty entries in PATHEXT', () => {
    expect(executableCandidates('gh', 'win32', ' .EXE ; ; .CMD ')).toEqual([
      'gh.EXE',
      'gh.CMD',
      'gh'
    ])
  })

  it('does not double up on a name that already carries an extension', () => {
    expect(executableCandidates('gh.exe', 'win32', '.COM;.EXE')).toEqual(['gh.exe'])
    // Case-insensitively: Windows does not care, and neither should the guard.
    expect(executableCandidates('claude.CMD', 'win32', '.EXE;.cmd')).toEqual(['claude.CMD'])
  })
})

describe('unquotePathEntry', () => {
  it('strips the quotes Windows tolerates around a PATH entry', () => {
    expect(unquotePathEntry('"C:\\Program Files\\GitHub CLI"')).toBe('C:\\Program Files\\GitHub CLI')
  })

  it('leaves an unquoted entry and a lone quote untouched', () => {
    expect(unquotePathEntry('/usr/bin')).toBe('/usr/bin')
    expect(unquotePathEntry('"C:\\half')).toBe('"C:\\half')
  })
})

describe('directExecutableInvocation', () => {
  const systemRoot = 'C:\\Windows'
  const powershell = `${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`

  it('leaves native and non-Windows executables unchanged', () => {
    expect(
      directExecutableInvocation('C:\\Tools\\agent.exe', ['--version'], {
        platform: 'win32',
        systemRoot,
        exists: () => false
      })
    ).toEqual({ executable: 'C:\\Tools\\agent.exe', args: ['--version'] })
    expect(
      directExecutableInvocation('/usr/bin/agent.cmd', ['--version'], { platform: 'linux' })
    ).toEqual({ executable: '/usr/bin/agent.cmd', args: ['--version'] })
  })

  it('runs a Windows npm cmd shim through its sibling PowerShell shim', () => {
    const existing = new Set([powershell.toLowerCase(), 'c:\\tools\\agent.ps1'])
    expect(
      directExecutableInvocation('C:\\Tools\\agent.CMD', ['--flag', 'value & untouched'], {
        platform: 'win32',
        systemRoot,
        exists: (candidate) => existing.has(candidate.toLowerCase())
      })
    ).toEqual({
      executable: powershell,
      args: [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        'C:\\Tools\\agent.ps1',
        '--flag',
        'value & untouched'
      ]
    })
  })

  it('fails closed when a Windows script has no safe direct entry point', () => {
    expect(
      directExecutableInvocation('C:\\Tools\\agent.cmd', [], {
        platform: 'win32',
        systemRoot,
        exists: (candidate) => candidate.toLowerCase() === powershell.toLowerCase()
      })
    ).toBeNull()
    expect(
      directExecutableInvocation('C:\\Tools\\agent.bat', [], {
        platform: 'win32',
        systemRoot,
        exists: () => true
      })
    ).toBeNull()
  })
})

// End-to-end over the real filesystem: the unit tests above prove the NAME mapping, these prove the
// walk actually resolves those names — the half that was broken. Split by platform because the
// mapping they exercise only exists on one of them.
describe('findInPathString (real filesystem)', () => {
  let dir: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-exec-path-'))
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  /** POSIX needs the exec bit for X_OK; on Windows the mode is ignored and F_OK is what we ask. */
  const writeBin = (name: string): string => {
    const p = path.join(dir, name)
    fs.writeFileSync(p, '', { mode: 0o755 })
    return p
  }

  /** A win32 hit carries PATHEXT's casing (`.EXE`), not the file's own — the same path, since
   *  Windows is case-insensitive. Compare the way the platform does. */
  const expectPath = (got: string | null, want: string): void => {
    expect(process.platform === 'win32' ? got?.toLowerCase() : got).toBe(
      process.platform === 'win32' ? want.toLowerCase() : want
    )
  }

  it('finds an executable that is on the PATH, and answers null for one that is not', () => {
    const bin = process.platform === 'win32' ? 'nt-probe.exe' : 'nt-probe'
    writeBin(bin)
    expectPath(findInPathString(process.platform === 'win32' ? 'nt-probe' : bin, dir), path.join(dir, bin))
    expect(findInPathString('nt-absent', dir)).toBeNull()
  })

  it('skips empty entries and searches later ones', () => {
    const bin = process.platform === 'win32' ? 'nt-probe.exe' : 'nt-probe'
    writeBin(bin)
    const pathStr = ['', path.join(dir, 'nope'), dir].join(path.delimiter)
    expectPath(findInPathString(process.platform === 'win32' ? 'nt-probe' : bin, pathStr), path.join(dir, bin))
  })

  it('tolerates a quoted PATH entry', () => {
    const bin = process.platform === 'win32' ? 'nt-probe.exe' : 'nt-probe'
    writeBin(bin)
    expectPath(
      findInPathString(process.platform === 'win32' ? 'nt-probe' : bin, `"${dir}"`),
      path.join(dir, bin)
    )
  })

  // The regression itself: a bare name must reach `<name>.exe` / `<name>.cmd` on disk. `gh` really
  // is `gh.exe` and an npm shim really is `<name>.cmd`, and resolving neither is what left Windows
  // with no gh, no ssh and a claude probe that never ran.
  describe.skipIf(process.platform !== 'win32')('win32 PATHEXT', () => {
    it('resolves a bare name to its .exe and .cmd on disk', () => {
      writeBin('nt-exe-only.exe')
      writeBin('nt-cmd-only.cmd')
      expectPath(findInPathString('nt-exe-only', dir), path.join(dir, 'nt-exe-only.exe'))
      expectPath(findInPathString('nt-cmd-only', dir), path.join(dir, 'nt-cmd-only.cmd'))
    })

    it('prefers the PATHEXT match over an extensionless shim in the same directory', () => {
      // Exactly what npm lays down for a global CLI on Windows: `<name>` is a POSIX shell shim for
      // Git Bash and `<name>.cmd` is the one cmd/CreateProcess can actually run. Preferring the
      // bare name here returns a file that exists and cannot be spawned.
      writeBin('nt-shim')
      writeBin('nt-shim.cmd')
      expectPath(findInPathString('nt-shim', dir), path.join(dir, 'nt-shim.cmd'))
    })

    it('falls back to an extensionless file when nothing matches PATHEXT', () => {
      // An extensionless PE is executable, so it stays a last resort rather than being ignored.
      writeBin('nt-bare-only')
      expectPath(findInPathString('nt-bare-only', dir), path.join(dir, 'nt-bare-only'))
    })

    it('still finds a name given in full', () => {
      writeBin('nt-full.exe')
      expectPath(findInPathString('nt-full.exe', dir), path.join(dir, 'nt-full.exe'))
    })
  })
})
