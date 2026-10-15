import { execFileSync } from 'child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { describe, expect, it } from 'vitest'
import {
  buildWindowsHookInvocation,
  buildWindowsHookWrapper,
  buildWindowsShLauncher,
  WINDOWS_SH_CANDIDATES,
  WINDOWS_SH_REQUIRED_MESSAGE,
  windowsHookWrapperFile
} from './windows-hook-wrapper'
import { buildCodexWindowsWrapper } from './codex-windows-wrapper'

// These pin what the generators CONSTRUCT. Whether cmd.exe runs them is a device fact (the codex
// wrapper's was measured for #567/#685; the new agents' rows are in the docs' device checklists).
const CMD = 'C:\\WINDOWS\\System32\\cmd.exe'

describe('windowsHookWrapperFile', () => {
  it('names the wrapper after the script, matching codex-hook.cmd', () => {
    expect(windowsHookWrapperFile('gemini.sh')).toBe('gemini-hook.cmd')
    expect(windowsHookWrapperFile('grok.sh')).toBe('grok-hook.cmd')
    expect(windowsHookWrapperFile('copilot.sh')).toBe('copilot-hook.cmd')
    expect(windowsHookWrapperFile('codex.sh')).toBe('codex-hook.cmd')
  })
})

describe('buildWindowsHookWrapper', () => {
  const w = buildWindowsHookWrapper('gemini.sh', 'gemini')

  it('runs the named script found beside itself, with no absolute path baked in', () => {
    expect(w).toContain('set "NT_SCRIPT=%~dp0gemini.sh"')
    expect(w).not.toMatch(/[A-Za-z]:\\Users/)
    expect(w).not.toContain('curl')
  })

  it('is CRLF throughout', () => {
    expect(w.split('\n').slice(0, -1).every((l) => l.endsWith('\r'))).toBe(true)
  })

  it('drains stdin and exits 0 when there is no shell or no script', () => {
    expect(w).toContain('if not exist "%NT_SCRIPT%" goto :nt_drain')
    expect(w).toContain('if not defined NT_SH goto :nt_drain')
    expect(w.slice(w.indexOf(':nt_drain'))).toContain('findstr /r ".*" >nul 2>&1')
    expect(w.trimEnd().endsWith('exit /b 0')).toBe(true)
  })

  it('keeps the codex wrapper byte-identical (it is the same template)', () => {
    expect(buildWindowsHookWrapper('codex.sh', 'codex')).toBe(buildCodexWindowsWrapper())
  })
})

describe('buildWindowsHookInvocation', () => {
  it('is the measured codex form: absolute cmd.exe, /d, call, trailing space inside the quotes', () => {
    expect(buildWindowsHookInvocation('C:\\Users\\u\\.nodeterm\\agent-hooks\\gemini-hook.cmd', CMD)).toBe(
      `${CMD} /d /c call "C:\\Users\\u\\.nodeterm\\agent-hooks\\gemini-hook.cmd "`
    )
  })
})

describe('buildWindowsShLauncher', () => {
  const l = buildWindowsShLauncher('nodeterm.sh')

  it('passes every argument through %* untouched, after the script path', () => {
    expect(l).toContain('set "NT_SCRIPT=%~dp0nodeterm.sh"')
    expect(l).toContain('"%NT_SH%" "%NT_ARG%" %*')
    // No re-quoting layer of its own: `--cmd=--version` and a quoted value with spaces reach sh as
    // the caller's shell tokenized them.
    expect(l).not.toMatch(/%~?[1-9]/)
    expect(l).toContain('exit /b %ERRORLEVEL%')
  })

  it('searches the same Git for Windows layouts, PATH last', () => {
    for (const c of WINDOWS_SH_CANDIDATES) expect(l).toContain(c)
    const last = Math.max(...WINDOWS_SH_CANDIDATES.map((c) => l.indexOf(c)))
    expect(l.indexOf('%%~$PATH:I')).toBeGreaterThan(last)
  })

  it('fails LOUDLY with exit 1 when no shell exists — an agent ran it on purpose', () => {
    expect(l).toContain('if not defined NT_SH goto :nt_nosh')
    const bail = l.slice(l.indexOf('\r\n:nt_nosh') + 2)
    expect(bail.split('\r\n')[0]).toBe(':nt_nosh')
    expect(bail).toContain(`>&2 echo ${WINDOWS_SH_REQUIRED_MESSAGE}`)
    expect(bail.split('\r\n')[2]).toBe('exit /b 1')
    expect(WINDOWS_SH_REQUIRED_MESSAGE).toContain('Git for Windows (sh.exe) is required')
    // Never a silent drain: that is the hook wrapper's contract, not a CLI's.
    expect(l).not.toContain('findstr')
  })

  it('never puts the message inside a parenthesized block (its `)` would close it early)', () => {
    expect(l).not.toMatch(/^if .*\(echo/m)
  })

  it('keeps `!` literal and is CRLF', () => {
    expect(l).toContain('DisableDelayedExpansion')
    expect(l.split('\n').slice(0, -1).every((x) => x.endsWith('\r'))).toBe(true)
  })
})

// The real thing, on the windows-latest runner: cmd.exe runs the generated batch files against Git
// for Windows' sh.exe. Skipped elsewhere (no cmd.exe) and where no Git sh is installed.
const gitSh = (): boolean =>
  WINDOWS_SH_CANDIDATES.some((c) =>
    existsSync(c.replace(/%([^%]+)%/g, (_, name: string) => process.env[name] ?? `%${name}%`))
  )
describe.skipIf(process.platform !== 'win32' || !gitSh())('Windows wrappers under a real cmd.exe', () => {
  it('the CLI launcher passes every argument through to the POSIX script', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'nt-launcher-real-'))
    try {
      writeFileSync(path.join(dir, 'nodeterm.sh'), 'for a in "$@"; do printf "[%s]" "$a"; done\n')
      writeFileSync(path.join(dir, 'nodeterm.cmd'), buildWindowsShLauncher('nodeterm.sh'))
      const out = execFileSync('cmd.exe', ['/d', '/c', path.join(dir, 'nodeterm.cmd'), 'list', '--cmd=--version', '--node', 'b1'], {
        encoding: 'utf8'
      })
      expect(out).toBe('[list][--cmd=--version][--node][b1]')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('the hook wrapper hands the payload on stdin to the script', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'nt-hookwrap-real-'))
    try {
      const sink = path.join(dir, 'got.txt').replaceAll('\\', '/')
      writeFileSync(path.join(dir, 'gemini.sh'), `cat > '${sink}'\n`)
      writeFileSync(path.join(dir, 'gemini-hook.cmd'), buildWindowsHookWrapper('gemini.sh', 'gemini'))
      execFileSync('cmd.exe', ['/d', '/c', path.join(dir, 'gemini-hook.cmd')], { input: '{"hook_event_name":"AfterTool"}' })
      expect(readFileSync(sink, 'utf8')).toBe('{"hook_event_name":"AfterTool"}')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

