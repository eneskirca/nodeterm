import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFileSync } from 'child_process'
import {
  directExecutableInvocation,
  envPathKey,
  executableCandidates,
  findInPathString,
  unquotePathEntry
} from './exec-path'

const shellProbe = vi.hoisted(() => ({ execFile: vi.fn() }))
vi.mock('child_process', async (original) => ({
  ...(await original<typeof import('child_process')>()),
  execFile: shellProbe.execFile
}))

describe('login-shell probe completion', () => {
  type Callback = (error: Error | null, stdout: string, stderr: string) => void
  let probes: Array<{
    callback: Callback
    child: {
      exitCode: number | null
      signalCode: NodeJS.Signals | null
      kill: ReturnType<typeof vi.fn>
      stdin: { destroy: ReturnType<typeof vi.fn> }
      stdout: { destroy: ReturnType<typeof vi.fn> }
      stderr: { destroy: ReturnType<typeof vi.fn> }
    }
  }>

  beforeEach(() => {
    vi.resetModules()
    vi.useFakeTimers()
    vi.spyOn(os, 'platform').mockReturnValue('linux')
    vi.stubEnv('SHELL', '/controlled/login-shell')
    probes = []
    shellProbe.execFile.mockReset()
    shellProbe.execFile.mockImplementation((_file, _args, _options, callback: Callback) => {
      const child = {
        exitCode: null as number | null,
        signalCode: null as NodeJS.Signals | null,
        kill: vi.fn(() => true),
        stdin: { destroy: vi.fn() },
        stdout: { destroy: vi.fn() },
        stderr: { destroy: vi.fn() }
      }
      probes.push({ callback, child })
      return child
    })
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
  })

  it('parses profile noise and caches a successful PATH without another shell', async () => {
    const api = await import('./exec-path')
    const pending = api.resolveShellPath()
    expect(shellProbe.execFile).toHaveBeenCalledWith(
      '/controlled/login-shell',
      ['-ilc', expect.stringContaining('"$PATH"')],
      expect.objectContaining({ encoding: 'utf-8', timeout: 5000 }),
      expect.any(Function)
    )
    probes[0].callback(null, 'profile noise\n__NT_PATH_START__ /tools:/bin __NT_PATH_END__\nprompt', '')
    await expect(pending).resolves.toBe('/tools:/bin')
    expect(api.shellPathNow()).toBe('/tools:/bin')
    await vi.advanceTimersByTimeAsync(10000)
    await expect(api.resolveShellPath()).resolves.toBe('/tools:/bin')
    expect(probes).toHaveLength(1)
    expect(probes[0].child.kill).not.toHaveBeenCalled()
  })

  it('bounds a never-completing PATH probe, shares its fallback and ignores late success', async () => {
    const api = await import('./exec-path')
    const first = api.resolveShellPath()
    const second = api.resolveShellPath()
    expect(first).toBe(second)
    let completed = false
    void first.then(() => { completed = true })
    await vi.advanceTimersByTimeAsync(4999)
    expect(completed).toBe(false)
    expect(api.shellPathNow()).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1)
    // Assert completion before awaiting: deleting the real deadline must fail an assertion,
    // rather than being mistaken for an infrastructure/test timeout.
    expect(completed).toBe(true)
    await expect(first).resolves.toBeNull()
    await expect(second).resolves.toBeNull()
    expect(api.shellPathNow()).toBeNull()
    expect(probes[0].child.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL')
    for (const stream of ['stdin', 'stdout', 'stderr'] as const) {
      expect(probes[0].child[stream].destroy).toHaveBeenCalledOnce()
    }
    probes[0].callback(null, '__NT_PATH_START__/late/tools__NT_PATH_END__', '')
    await vi.advanceTimersByTimeAsync(10000)
    await expect(api.resolveShellPath()).resolves.toBeNull()
    expect(api.shellPathNow()).toBeNull()
    expect(probes).toHaveLength(1)
  })

  it('uses inherited PATH after the deadline instead of blocking executable lookup', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-shell-fallback-'))
    try {
      const bin = path.join(dir, 'owned-probe')
      fs.writeFileSync(bin, '', { mode: 0o755 })
      vi.stubEnv('PATH', dir)
      const api = await import('./exec-path')
      const lookup = api.findInLoginPath('owned-probe')
      let result: string | null | undefined
      void lookup.then((value) => { result = value })
      await vi.advanceTimersByTimeAsync(5000)
      expect(result).toBe(bin)
      await expect(lookup).resolves.toBe(bin)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('bounds each variable independently, coalesces callers and never adopts a late value', async () => {
    const api = await import('./exec-path')
    const first = api.resolveShellEnvVar('OWNED_TEST_VAR')
    expect(api.resolveShellEnvVar('OWNED_TEST_VAR')).toBe(first)
    const other = api.resolveShellEnvVar('OTHER_TEST_VAR')
    probes[1].callback(null, 'noise__NT_VAR_START__ live value __NT_VAR_END__', '')
    await expect(other).resolves.toBe('live value')
    let completed = false
    void first.then(() => { completed = true })
    await vi.advanceTimersByTimeAsync(5000)
    expect(completed).toBe(true)
    await expect(first).resolves.toBeNull()
    probes[0].callback(null, '__NT_VAR_START__late value__NT_VAR_END__', '')
    await vi.advanceTimersByTimeAsync(1)
    await expect(api.resolveShellEnvVar('OWNED_TEST_VAR')).resolves.toBeNull()
    await expect(api.resolveShellEnvVar('OTHER_TEST_VAR')).resolves.toBe('live value')
    expect(probes).toHaveLength(2)
    expect(probes[0].child.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL')
    expect(probes[1].child.kill).not.toHaveBeenCalled()
  })

  it.each([
    { exitCode: 0, signalCode: null },
    { exitCode: null, signalCode: 'SIGTERM' as const }
  ])('releases held pipes without signalling an exited child (%j)', async (exit) => {
    const api = await import('./exec-path')
    const pending = api.resolveShellPath()
    Object.assign(probes[0].child, exit)
    let completed = false
    void pending.then(() => { completed = true })
    await vi.advanceTimersByTimeAsync(5000)
    expect(completed).toBe(true)
    await expect(pending).resolves.toBeNull()
    expect(probes[0].child.kill).not.toHaveBeenCalled()
    expect(probes[0].child.stdout.destroy).toHaveBeenCalledOnce()
    expect(probes[0].child.stderr.destroy).toHaveBeenCalledOnce()
  })

  it('settles even when owned-child cleanup throws, and releases the remaining pipes', async () => {
    const api = await import('./exec-path')
    const pending = api.resolveShellPath()
    probes[0].child.kill.mockImplementation(() => { throw new Error('owned child unavailable') })
    probes[0].child.stdin.destroy.mockImplementation(() => { throw new Error('already closed') })
    let completed = false
    void pending.then(() => { completed = true })
    await vi.advanceTimersByTimeAsync(5000)
    expect(completed).toBe(true)
    await expect(pending).resolves.toBeNull()
    expect(probes[0].child.stdout.destroy).toHaveBeenCalledOnce()
    expect(probes[0].child.stderr.destroy).toHaveBeenCalledOnce()
  })

  it('falls back immediately on callback errors and synchronous spawn errors', async () => {
    const api = await import('./exec-path')
    const failed = api.resolveShellPath()
    probes[0].callback(new Error('profile failed'), '', '')
    await expect(failed).resolves.toBeNull()
    shellProbe.execFile.mockImplementationOnce(() => { throw new Error('cannot spawn') })
    await expect(api.resolveShellEnvVar('OWNED_TEST_VAR')).resolves.toBeNull()
    await vi.advanceTimersByTimeAsync(10000)
    expect(probes[0].child.kill).not.toHaveBeenCalled()
  })

  it('admits an early callback before execFile returns the child', async () => {
    const normalSpawn = shellProbe.execFile.getMockImplementation()!
    shellProbe.execFile.mockImplementationOnce((file, args, options, callback: Callback) => {
      const child = normalSpawn(file, args, options, callback)
      callback(null, '__NT_PATH_START__/early/tools__NT_PATH_END__', '')
      return child
    })
    const api = await import('./exec-path')
    await expect(api.resolveShellPath()).resolves.toBe('/early/tools')
    await vi.advanceTimersByTimeAsync(10000)
    expect(probes[0].child.kill).not.toHaveBeenCalled()
    expect(probes[0].child.stdout.destroy).not.toHaveBeenCalled()
  })

  it('keeps Windows and invalid variable names subprocess-free', async () => {
    const api = await import('./exec-path')
    await expect(api.resolveShellEnvVar('UNSAFE;COMMAND')).resolves.toBeNull()
    expect(probes).toHaveLength(0)
    vi.spyOn(os, 'platform').mockReturnValue('win32')
    await expect(api.resolveShellPath()).resolves.toBeNull()
    await expect(api.resolveShellEnvVar('OWNED_TEST_VAR')).resolves.toBeNull()
    expect(api.shellPathNow()).toBeNull()
    expect(probes).toHaveLength(0)
  })
})

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
  const cmd = `${systemRoot}\\System32\\cmd.exe`

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

  it('runs a Windows cmd shim through hidden cmd.exe with escaped verbatim arguments', () => {
    expect(
      directExecutableInvocation('C:\\Tools\\agent.CMD', ['--flag', 'value & untouched'], {
        platform: 'win32',
        systemRoot,
        exists: (candidate) => candidate.toLowerCase() === cmd.toLowerCase()
      })
    ).toEqual({
      executable: cmd,
      args: [
        '/d',
        '/s',
        '/v:off',
        '/c',
        '"C:\\Tools\\agent.CMD ^^^"--flag^^^" ^^^"value^^^ ^^^&^^^ untouched^^^""'
      ],
      options: { windowsHide: true, windowsVerbatimArguments: true }
    })
  })

  it('fails closed without cmd.exe and for unsupported Windows script kinds', () => {
    expect(
      directExecutableInvocation('C:\\Tools\\agent.cmd', [], {
        platform: 'win32',
        systemRoot,
        exists: () => false
      })
    ).toBeNull()
    expect(
      directExecutableInvocation('C:\\Tools\\agent.bat', [], {
        platform: 'win32',
        systemRoot,
        exists: () => true
      })
    ).toBeNull()
    expect(
      directExecutableInvocation('C:\\Tools\\agent.ps1', [], {
        platform: 'win32',
        systemRoot,
        exists: () => true
      })
    ).toBeNull()
  })

  it('fails closed when cmd.exe cannot preserve argv or the command exceeds its limit', () => {
    const options = { platform: 'win32' as const, systemRoot, exists: () => true }
    expect(directExecutableInvocation('C:\\Tools\\agent.cmd', ['line 1\nline 2'], options)).toBeNull()
    expect(directExecutableInvocation('C:\\Tools\\agent.cmd', ['line 1\rline 2'], options)).toBeNull()
    expect(directExecutableInvocation('C:\\Tools\\agent.cmd', ['nul\0byte'], options)).toBeNull()
    expect(directExecutableInvocation('C:\\Tools\\agent.cmd', ['x'.repeat(8100)], options)).toBeNull()
  })
})

describe.skipIf(process.platform !== 'win32')('directExecutableInvocation - real cmd shim', () => {
  it('preserves npm-shim argv boundaries and cmd metacharacters', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-exec-shim-'))
    try {
      const shimDir = path.join(dir, 'shims & !tools!')
      fs.mkdirSync(shimDir)
      const script = path.join(shimDir, 'capture.js')
      const cmd = path.join(shimDir, 'capture args.cmd')
      fs.writeFileSync(script, 'process.stdout.write(JSON.stringify(process.argv.slice(2)))\n')
      fs.writeFileSync(cmd, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`)
      const args = [
        '',
        'plain',
        'space value',
        'embedded "quote"',
        'trailing\\',
        'before\\"after',
        '&|<>()@^',
        '%PATH%',
        '!delayed!',
        'café 日本語'
      ]
      const invocation = directExecutableInvocation(cmd, args)
      expect(invocation).not.toBeNull()

      const output = execFileSync(invocation!.executable, invocation!.args, {
        ...invocation!.options,
        encoding: 'utf8'
      })
      expect(JSON.parse(output)).toEqual(args)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
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

  it('resolves an absolute executable without requiring its directory on PATH', () => {
    const bin = writeBin(process.platform === 'win32' ? 'nt-absolute.exe' : 'nt-absolute')
    expectPath(findInPathString(bin, ''), bin)
    expectPath(findInPathString(bin, path.join(dir, 'unrelated')), bin)
  })

  it('rejects an absent absolute executable', () => {
    const bin = path.join(dir, 'absent', process.platform === 'win32' ? 'nt-absent.exe' : 'nt-absent')
    expect(findInPathString(bin, dir)).toBeNull()
  })

  it.skipIf(process.platform === 'win32')('rejects an absent absolute executable even if PATH contains a joined shadow', () => {
    // Windows cannot represent the old joined result with a second drive letter in the middle.
    const bin = path.join(dir, 'absent', process.platform === 'win32' ? 'nt-shadow.exe' : 'nt-shadow')
    const pathEntry = path.join(dir, 'path-entry')
    // The old lookup joined even absolute programs to PATH, admitting this unrelated file.
    const shadow = path.join(pathEntry, bin)
    fs.mkdirSync(path.dirname(shadow), { recursive: true })
    fs.writeFileSync(shadow, '', { mode: 0o755 })
    expect(findInPathString(bin, pathEntry)).toBeNull()
  })

  it('rejects a directory supplied as an absolute executable', () => {
    expect(findInPathString(dir, '')).toBeNull()
  })

  it.skipIf(process.platform === 'win32')('rejects a non-executable absolute file', () => {
    // Windows checks existence instead of POSIX executable permissions.
    const bin = path.join(dir, 'nt-no-exec')
    fs.writeFileSync(bin, '', { mode: 0o644 })
    expect(findInPathString(bin, '')).toBeNull()
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

describe('envPathKey', () => {
  it('uses the key the environment already has', () => {
    expect(envPathKey({ PATH: '/bin' })).toBe('PATH')
    expect(envPathKey({ Path: 'C:\\Windows' })).toBe('Path')
    expect(envPathKey({ path: 'x' })).toBe('path')
  })
  it('prefers an exact PATH and defaults to PATH', () => {
    expect(envPathKey({ Path: 'a', PATH: 'b' })).toBe('PATH')
    expect(envPathKey({})).toBe('PATH')
  })
})
