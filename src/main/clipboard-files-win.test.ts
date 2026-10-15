import { execFileSync } from 'child_process'
import { describe, expect, it, vi } from 'vitest'
import {
  WINDOWS_FILE_DROP_READ_PATHS,
  asciiJson,
  WINDOWS_FILE_DROP_SCRIPT,
  WINDOWS_FILE_DROP_TIMEOUT_MS,
  windowsPowerShellPath,
  writeWindowsFileDrop,
  type ExecFileLike
} from './clipboard-files-win'

function fakeExec(error: Error | null = null) {
  const stdin = { end: vi.fn(), on: vi.fn() }
  const calls: Array<{ file: string; args: string[]; options: unknown }> = []
  const run: ExecFileLike = (file, args, options, callback) => {
    calls.push({ file, args, options })
    queueMicrotask(() => callback(error))
    return { stdin }
  }
  return { run, stdin, calls }
}

describe('writeWindowsFileDrop', () => {
  it('runs Windows PowerShell 5.1 in STA and sends the paths on stdin, never argv', async () => {
    const { run, stdin, calls } = fakeExec()
    const paths = ['C:\\a"; Remove-Item x; ".png', 'C:\\b $(evil).txt']
    expect(await writeWindowsFileDrop(paths, { execFile: run, env: { SystemRoot: 'D:\\Win' } })).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0].file).toBe('D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
    expect(calls[0].args).toEqual(['-NoProfile', '-NonInteractive', '-STA', '-Command', WINDOWS_FILE_DROP_SCRIPT])
    for (const arg of calls[0].args) for (const p of paths) expect(arg).not.toContain(p)
    expect(calls[0].options).toEqual({ timeout: WINDOWS_FILE_DROP_TIMEOUT_MS, windowsHide: true })
    expect(stdin.end).toHaveBeenCalledWith(asciiJson(paths))
  })

  it('maps a nonzero exit or a timeout kill to false', async () => {
    expect(await writeWindowsFileDrop(['C:\\a'], { execFile: fakeExec(new Error('exit 1')).run })).toBe(false)
    const killed = Object.assign(new Error('timed out'), { killed: true, signal: 'SIGTERM' })
    expect(await writeWindowsFileDrop(['C:\\a'], { execFile: fakeExec(killed).run })).toBe(false)
  })

  it('fails closed when the process cannot be spawned', async () => {
    const throwing: ExecFileLike = () => {
      throw new Error('ENOENT')
    }
    expect(await writeWindowsFileDrop(['C:\\a'], { execFile: throwing })).toBe(false)
    expect(await writeWindowsFileDrop(['C:\\a'], { execFile: () => ({ stdin: null }) })).toBe(false)
  })

  it('writes a real CF_HDROP through SetFileDropList', () => {
    expect(WINDOWS_FILE_DROP_SCRIPT).toContain('[System.Windows.Forms.Clipboard]::SetFileDropList')
    expect(WINDOWS_FILE_DROP_SCRIPT).toContain('[Console]::In.ReadToEnd()')
  })
})

describe('windowsPowerShellPath', () => {
  it('pins the inbox 5.1 binary and falls back to C:\\Windows', () => {
    expect(windowsPowerShellPath({})).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
    expect(windowsPowerShellPath({ WINDIR: 'E:\\W' })).toBe('E:\\W\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
  })
})

describe('asciiJson', () => {
  it('escapes every non-ASCII unit so an OEM code page cannot mangle it', () => {
    const paths = ['C:\\caf\u00e9\\\u65e5\u672c.png', 'C:\\\ud83d\ude00.txt']
    const wire = asciiJson(paths)
    expect(wire).toMatch(/^[\x00-\x7e]*$/)
    expect(JSON.parse(wire)).toEqual(paths)
  })
})

function hasPwsh(): boolean {
  try {
    execFileSync('pwsh', ['-NoProfile', '-Command', 'exit 0'], { stdio: 'ignore', timeout: 20_000 })
    return true
  } catch {
    return false
  }
}

// The parse half of the real script, run under a real PowerShell. `-NoEnumerate` reproduces
// Windows PowerShell 5.1's ConvertFrom-Json (an array is ONE pipeline object), which is the shape
// that used to fold a multi-file selection into a single space-joined path.
describe.skipIf(!hasPwsh())('WINDOWS_FILE_DROP_READ_PATHS under pwsh', () => {
  const run = (paths: unknown, emulate51: boolean): string[] => {
    const script =
      (emulate51
        ? WINDOWS_FILE_DROP_READ_PATHS.replace('ConvertFrom-Json -InputObject', 'ConvertFrom-Json -NoEnumerate -InputObject')
        : WINDOWS_FILE_DROP_READ_PATHS) +
      '; foreach ($x in $p) { [Console]::Out.Write((($x.ToCharArray() | ForEach-Object { [int]$_ }) -join ",") + ";") }'
    const out = execFileSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', script], {
      input: asciiJson(paths),
      encoding: 'utf8',
      timeout: 30_000
    })
    return out
      .split(';')
      .filter(Boolean)
      .map((codes) => String.fromCharCode(...codes.split(',').map(Number)))
  }

  it.each([false, true])('keeps a multi-file selection as separate paths (5.1 semantics: %s)', (emulate51) => {
    const paths = ['C:\\a b.png', 'C:\\caf\u00e9 $(x) & "q".txt', '\\\\srv\\share\\\ud83d\ude00']
    expect(run(paths, emulate51)).toEqual(paths)
    expect(run(['C:\\only.png'], emulate51)).toEqual(['C:\\only.png'])
  }, 60_000)
})
