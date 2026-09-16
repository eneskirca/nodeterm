// The Antigravity installer and its Windows wrapper.
//
// Every case here writes into a TEMP directory. The real `~/.gemini/config/hooks.json` is global —
// a mistake there denies tools in every `agy` on the machine — so nothing in this file may default
// to it: the installer is called with `hooksJson`/`scriptPath`, or with its defaults under a spied
// `os.homedir` pointing at a temp dir (and that case also checks the real file was not touched).
import { describe, it, expect, afterAll, afterEach, beforeAll, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import osDefault from 'os'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ANTIGRAVITY_BUNDLE_KEY,
  ANTIGRAVITY_HOOK_TIMEOUT,
  agyFallbackPaths,
  antigravityCommandFor,
  findAgy,
  antigravityHooksJsonPath,
  applyAntigravityBundle,
  buildAntigravityBundle,
  installAntigravityHooks,
  installAntigravityHooksWithProbe,
  isAntigravityManagedCommand,
  removeAntigravityHooks
} from './antigravity'
import {
  ANTIGRAVITY_WINDOWS_WRAPPER_FILE,
  buildAntigravityWindowsCommand,
  buildAntigravityWindowsWrapper
} from './antigravity-windows-wrapper'
import { buildCodexWindowsWrapper } from './codex-windows-wrapper'
import { defaultWindowsCmdExe } from './codex'
import { buildManagedScript } from './managed-script'
import { ANTIGRAVITY_EVENTS, antigravityDecisionFor } from './antigravity-decision'
import { ANTIGRAVITY_HOOK_EVENTS } from '@shared/agents/hook-events'
import type { CmdAutoRunCheck } from './antigravity-autorun'

const T = 60_000
const root = mkdtempSync(join(tmpdir(), 'nt agy install '))
// BEST EFFORT on purpose. On Windows the dispatch cases leave the hook's backgrounded POST running
// under Git's `bin\sh.exe` launcher with its cwd inside this tree, and that holds a directory until
// the worker exits (measured: the same rmSync succeeds right after the run). A leftover temp dir is
// not a test failure.
afterAll(() => {
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 })
  } catch {
    /* left in the OS temp dir */
  }
})
let seq = 0
const fresh = (): string => {
  const d = join(root, `c${++seq}`)
  mkdirSync(d, { recursive: true })
  return d
}

const POSIX_SCRIPT = '/home/u/.nodeterm/agent-hooks/antigravity.sh'
// The registry is never read by these tests: every Windows install gets an injected AutoRun verdict.
const CLEAR = (): CmdAutoRunCheck => ({ kind: 'clear' })
// Every install here happens on a machine that HAS agy (the no-agy refusal has its own tests).
const HAS_AGY = (): string => 'C:/fake/agy.exe'
const read = (f: string): Record<string, unknown> => JSON.parse(readFileSync(f, 'utf8'))
const install = (hooksJson: string, platform = 'linux') =>
  installAntigravityHooks({ findAgy: HAS_AGY, hooksJson, platform, scriptPath: POSIX_SCRIPT, writeScript: false })

describe('where it writes', () => {
  it('targets ~/.gemini/config/hooks.json — never settings.json or GEMINI.md', () => {
    expect(antigravityHooksJsonPath('/h')).toBe(join('/h', '.gemini', 'config', 'hooks.json'))
  })
})

describe('the bundle', () => {
  it('subscribes exactly the four events, in the two shapes agy expects', () => {
    const bundle = buildAntigravityBundle((ev) => `cmd-${ev}`)
    expect(Object.keys(bundle)).toEqual(['PreInvocation', 'PreToolUse', 'PostToolUse', 'Stop'])
    expect(bundle.PreInvocation).toEqual([{ type: 'command', command: 'cmd-PreInvocation', timeout: 5 }])
    expect(bundle.Stop).toEqual([{ type: 'command', command: 'cmd-Stop', timeout: 5 }])
    expect(bundle.PreToolUse).toEqual([
      { matcher: '*', hooks: [{ type: 'command', command: 'cmd-PreToolUse', timeout: 5 }] }
    ])
    expect(bundle.PostToolUse).toEqual([
      { matcher: '*', hooks: [{ type: 'command', command: 'cmd-PostToolUse', timeout: 5 }] }
    ])
    expect(ANTIGRAVITY_HOOK_TIMEOUT).toBe(5)
    // PostInvocation is deliberately not subscribed.
    expect(ANTIGRAVITY_HOOK_EVENTS.map((e) => (typeof e === 'string' ? e : e.event))).not.toContain('PostInvocation')
  })

  it('POSIX command: exports the event and carries the table answer as its fallback', () => {
    for (const ev of ['PreInvocation', 'PreToolUse', 'PostToolUse', 'Stop']) {
      const c = antigravityCommandFor(POSIX_SCRIPT, ev, 'linux')
      expect(c.startsWith(`NODETERM_AGY_EVENT='${ev}'; export NODETERM_AGY_EVENT; `)).toBe(true)
      expect(c).toContain(`printf '%s\\n' '${antigravityDecisionFor(ev)}'; cat >/dev/null`)
      expect(isAntigravityManagedCommand(c)).toBe(true)
    }
  })

  it('Windows command: relative to the hooks.json dir, guarded, no quotes, then the event', () => {
    const c = antigravityCommandFor(
      'C:\\Users\\John Doe\\.nodeterm\\agent-hooks\\antigravity.sh',
      'Stop',
      'win32',
      'C:\\Users\\John Doe\\.gemini\\config\\hooks.json'
    )
    expect(c).toBe(
      'if exist ..\\..\\.nodeterm\\agent-hooks\\antigravity-hook.cmd ' +
        '(call ..\\..\\.nodeterm\\agent-hooks\\antigravity-hook.cmd Stop) & exit 0'
    )
    expect(c).not.toContain('"')
    expect(c).not.toContain('John Doe')
    expect(isAntigravityManagedCommand(c)).toBe(true)
  })

  it('Windows command: refuses anything that would need quoting', () => {
    const rel = '..\\..\\.nodeterm\\agent-hooks'
    expect(() => buildAntigravityWindowsCommand(rel, 'Stop & calc')).toThrow()
    expect(() => buildAntigravityWindowsCommand(rel, '')).toThrow()
    for (const bad of ['..\\Other Dir\\agent-hooks', 'D:\\x\\agent-hooks', '..\\a"b', '..\\a&b', '..\\a(b)', '..\\%x%', '']) {
      expect(() => buildAntigravityWindowsCommand(bad, 'Stop'), bad).toThrow()
    }
    // A different drive has no relative path at all: path.win32.relative answers absolute.
    expect(() =>
      antigravityCommandFor('D:\\nt\\agent-hooks\\antigravity.sh', 'Stop', 'win32', 'C:\\h\\.gemini\\config\\hooks.json')
    ).toThrow()
  })

  it('recognizes both leaves on every platform, and nothing foreign', () => {
    expect(isAntigravityManagedCommand('sh /x/agent-hooks/antigravity.sh')).toBe(true)
    expect(isAntigravityManagedCommand('C:\\x\\agent-hooks\\antigravity-hook.cmd Stop')).toBe(true)
    expect(isAntigravityManagedCommand('sh /x/agent-hooks/gemini.sh')).toBe(false)
    expect(isAntigravityManagedCommand('/opt/other-tool/antigravity.sh')).toBe(false)
    expect(isAntigravityManagedCommand(undefined)).toBe(false)
    expect(isAntigravityManagedCommand(7)).toBe(false)
  })
})

describe('installAntigravityHooks / removeAntigravityHooks', () => {
  it('creates a missing hooks.json (and its directory) with exactly our bundle', () => {
    const f = join(fresh(), 'config', 'hooks.json')
    install(f)
    const data = read(f)
    expect(Object.keys(data)).toEqual([ANTIGRAVITY_BUNDLE_KEY])
    expect(data[ANTIGRAVITY_BUNDLE_KEY]).toEqual(buildAntigravityBundle((ev) => antigravityCommandFor(POSIX_SCRIPT, ev, 'linux')))
  })

  it('installing twice leaves ONE entry per event (#558)', () => {
    const f = join(fresh(), 'hooks.json')
    install(f)
    install(f)
    const bundle = read(f)[ANTIGRAVITY_BUNDLE_KEY] as Record<string, unknown[]>
    for (const ev of Object.keys(bundle)) expect(bundle[ev], ev).toHaveLength(1)
    expect(JSON.stringify(read(f)).match(/agent-hooks\/antigravity\.sh/g)).toHaveLength(8)
  })

  it('keeps every foreign bundle exactly as it was, another tool\'s included', () => {
    const f = join(fresh(), 'hooks.json')
    const otherTool = {
      PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'C:\\other-tool\\PreToolUse.cmd' }] }],
      Stop: [{ type: 'command', command: 'C:\\other-tool\\Stop.cmd' }]
    }
    const mine = { enabled: false, PreInvocation: [{ type: 'command', command: 'echo hi', timeout: 30 }] }
    writeFileSync(f, JSON.stringify({ 'other-tool': otherTool, 'my-bundle': mine, weird: 42 }), 'utf8')
    install(f)
    const data = read(f)
    expect(data['other-tool']).toEqual(otherTool)
    expect(data['my-bundle']).toEqual(mine)
    expect(data.weird).toBe(42)
    expect(Object.keys(data)).toEqual(['other-tool', 'my-bundle', 'weird', ANTIGRAVITY_BUNDLE_KEY])
  })

  it('sweeps a stray entry of ours out of another bundle, keeping its neighbours', () => {
    const f = join(fresh(), 'hooks.json')
    writeFileSync(
      f,
      JSON.stringify({
        other: {
          Stop: [
            { type: 'command', command: 'C:\\Users\\u\\.nodeterm\\agent-hooks\\antigravity-hook.cmd Stop' },
            { type: 'command', command: 'keep-me' }
          ],
          PreToolUse: [
            { matcher: '*', hooks: [{ type: 'command', command: "sh '/u/.nodeterm/agent-hooks/antigravity.sh'" }] }
          ]
        }
      }),
      'utf8'
    )
    install(f)
    expect(read(f).other).toEqual({ Stop: [{ type: 'command', command: 'keep-me' }] })
  })

  it('a malformed or non-object hooks.json is left byte-for-byte alone and nothing throws', () => {
    for (const body of ['{ not json', '[1,2,3]', '"a string"', 'null']) {
      const f = join(fresh(), 'hooks.json')
      writeFileSync(f, body, 'utf8')
      expect(() => install(f)).not.toThrow()
      expect(readFileSync(f, 'utf8')).toBe(body)
      expect(() => removeAntigravityHooks({ hooksJson: f })).not.toThrow()
      expect(readFileSync(f, 'utf8')).toBe(body)
    }
  })

  it('a foreign value it cannot interpret survives untouched', () => {
    const f = join(fresh(), 'hooks.json')
    const odd = { Stop: 'not-an-array', PreToolUse: [null, 3, { matcher: '*', hooks: 'x' }] }
    writeFileSync(f, JSON.stringify({ odd }), 'utf8')
    install(f)
    expect(read(f).odd).toEqual(odd)
  })

  it('remove leaves everything of the user and nothing of ours', () => {
    const f = join(fresh(), 'hooks.json')
    const mine = { Stop: [{ type: 'command', command: 'keep-me' }] }
    writeFileSync(f, JSON.stringify({ mine }), 'utf8')
    install(f)
    removeAntigravityHooks({ hooksJson: f })
    expect(read(f)).toEqual({ mine })
    // Removing again, or from a file that does not exist, is a no-op.
    removeAntigravityHooks({ hooksJson: f })
    const missing = join(fresh(), 'hooks.json')
    removeAntigravityHooks({ hooksJson: missing })
    expect(existsSync(missing)).toBe(false)
  })

  it('a top-level "__proto__" key survives install AND withdrawal (a plain assignment would set the prototype and drop it)', () => {
    const f = join(fresh(), 'hooks.json')
    writeFileSync(f, '{"__proto__":{"Stop":[{"type":"command","command":"keep"}]},"mine":{"enabled":false}}', 'utf8')
    const own = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k)
    install(f)
    const installed = read(f)
    expect(own(installed, '__proto__')).toBe(true)
    expect(Object.getOwnPropertyDescriptor(installed, '__proto__')?.value).toEqual({
      Stop: [{ type: 'command', command: 'keep' }]
    })
    expect(own(installed, ANTIGRAVITY_BUNDLE_KEY)).toBe(true)
    expect(removeAntigravityHooks({ hooksJson: f })).toBe('withdrawn')
    const removed = read(f)
    expect(Object.keys(removed)).toEqual(['__proto__', 'mine'])
    expect(own(removed, ANTIGRAVITY_BUNDLE_KEY)).toBe(false)
  })

  it('a "__proto__" key inside a foreign bundle survives the sweep of a stray entry of ours', () => {
    const out = applyAntigravityBundle(
      JSON.parse(
        '{"other":{"__proto__":[{"type":"command","command":"keep"}],"Stop":[{"type":"command","command":"sh /u/agent-hooks/antigravity.sh"}]}}'
      ),
      null
    )
    expect(JSON.stringify(out)).toBe('{"other":{"__proto__":[{"type":"command","command":"keep"}]}}')
  })

  it('a file with nothing of ours but a "__proto__" key is left byte-for-byte on withdrawal', () => {
    const f = join(fresh(), 'hooks.json')
    const body = '{"__proto__":{"x":1},   "mine":{}}'
    writeFileSync(f, body, 'utf8')
    expect(removeAntigravityHooks({ hooksJson: f })).toBe('absent')
    expect(readFileSync(f, 'utf8')).toBe(body)
  })

  it('applyAntigravityBundle returns an untouched foreign bundle by identity', () => {
    const foreign = { Stop: [{ type: 'command', command: 'x' }], PreToolUse: [] }
    expect(applyAntigravityBundle({ foreign }, null).foreign).toBe(foreign)
  })

  it("keeps a foreign event that was already empty when it sweeps another of that bundle's events", () => {
    const out = applyAntigravityBundle(
      { foreign: { PostToolUse: [], Stop: [{ type: 'command', command: 'sh /u/agent-hooks/antigravity.sh' }] } },
      null
    )
    expect(out.foreign).toEqual({ PostToolUse: [] })
  })

  it('the default hooks.json path follows a spied os.homedir, so a registry test cannot reach the real file', () => {
    const fake = fresh()
    const spy = vi.spyOn(osDefault, 'homedir').mockReturnValue(fake)
    try {
      expect(antigravityHooksJsonPath()).toBe(join(fake, '.gemini', 'config', 'hooks.json'))
    } finally {
      spy.mockRestore()
    }
  })

  it('on win32 every event points at the one wrapper, relative and guarded, with the event as its argument', () => {
    const home = join(fresh(), 'John Doe')
    const f = join(home, '.gemini', 'config', 'hooks.json')
    installAntigravityHooks({ findAgy: HAS_AGY,
      hooksJson: f,
      platform: 'win32',
      readAutoRun: CLEAR,
      scriptPath: join(home, '.nodeterm', 'agent-hooks', 'antigravity.sh'),
      writeScript: false
    })
    const data = read(f)
    const text = JSON.stringify(data)
    for (const ev of ['PreInvocation', 'PreToolUse', 'PostToolUse', 'Stop']) {
      expect(text).toContain(
        JSON.stringify(
          `if exist ..\\..\\.nodeterm\\agent-hooks\\antigravity-hook.cmd (call ..\\..\\.nodeterm\\agent-hooks\\antigravity-hook.cmd ${ev}) & exit 0`
        )
      )
    }
    // No profile name (and so no space) and no quote anywhere in a command.
    for (const cmd of text.match(/"command":"[^"\\]*(?:\\.[^"\\]*)*"/g) ?? []) {
      expect(cmd).not.toContain('John Doe')
      expect(JSON.parse(`{${cmd}}`).command).not.toContain('"')
    }
    expect(text).not.toContain('[ -r')
  })

  it('on win32 a layout that would need quotes installs NOTHING (a quoted command is a DENY)', () => {
    const f = join(fresh(), 'hooks.json')
    // The script dir is outside the hooks.json tree through a directory with a space.
    installAntigravityHooks({ findAgy: HAS_AGY,
      hooksJson: f,
      platform: 'win32',
      readAutoRun: CLEAR,
      scriptPath: join(fresh(), 'Other Dir', 'agent-hooks', 'antigravity.sh'),
      writeScript: false
    })
    expect(existsSync(f)).toBe(false)
  })
})

describe('the Windows wrapper (content)', () => {
  const w = buildAntigravityWindowsWrapper()

  it('is CRLF, disables delayed expansion, exports the event, and always exits 0', () => {
    expect(w).toContain('\r\n')
    expect(w.replace(/\r\n/g, '')).not.toContain('\n')
    expect(w).toContain('setlocal EnableExtensions DisableDelayedExpansion')
    expect(w).toContain('set "NODETERM_AGY_EVENT=%~1"')
    expect(w).not.toMatch(/exit \/b %ERRORLEVEL%|exit \/b [1-9]/)
    expect(w).not.toContain('powershell')
  })

  it('answers from the shared table on the bail path, then drains stdin', () => {
    for (const ev of ANTIGRAVITY_EVENTS) {
      expect(w).toContain(`if "%NODETERM_AGY_EVENT%"=="${ev}" echo ${antigravityDecisionFor(ev)}`)
    }
    expect(w.indexOf('findstr /r ".*" >nul 2>&1')).toBeGreaterThan(w.indexOf(':nt_bail'))
  })

  it('shares the shell search with the codex wrapper, which stays unchanged', () => {
    const codex = buildCodexWindowsWrapper()
    for (const line of codex.split('\r\n').filter((l) => l.startsWith('if not defined NT_SH'))) {
      if (line === 'if not defined NT_SH goto :nt_drain') continue
      expect(w).toContain(line)
    }
    // Pinned bytes of the codex wrapper as it was before the probe lines were shared.
    expect(codex).toBe(
      [
        '@echo off',
        'rem Managed by nodeterm (agent-hooks). Regenerated on every app launch; edits are lost.',
        'setlocal EnableExtensions',
        'set "NT_SCRIPT=%~dp0codex.sh"',
        'if not exist "%NT_SCRIPT%" goto :nt_drain',
        'set "NT_SH="',
        'if not defined NT_SH if exist "%ProgramFiles%\\Git\\bin\\sh.exe" set "NT_SH=%ProgramFiles%\\Git\\bin\\sh.exe"',
        'if not defined NT_SH if exist "%ProgramFiles%\\Git\\usr\\bin\\sh.exe" set "NT_SH=%ProgramFiles%\\Git\\usr\\bin\\sh.exe"',
        'if not defined NT_SH if exist "%ProgramFiles(x86)%\\Git\\bin\\sh.exe" set "NT_SH=%ProgramFiles(x86)%\\Git\\bin\\sh.exe"',
        'if not defined NT_SH if exist "%ProgramFiles(x86)%\\Git\\usr\\bin\\sh.exe" set "NT_SH=%ProgramFiles(x86)%\\Git\\usr\\bin\\sh.exe"',
        'if not defined NT_SH if exist "%LOCALAPPDATA%\\Programs\\Git\\bin\\sh.exe" set "NT_SH=%LOCALAPPDATA%\\Programs\\Git\\bin\\sh.exe"',
        'if not defined NT_SH if exist "%LOCALAPPDATA%\\Programs\\Git\\usr\\bin\\sh.exe" set "NT_SH=%LOCALAPPDATA%\\Programs\\Git\\usr\\bin\\sh.exe"',
        'if not defined NT_SH for %%I in (sh.exe) do if not defined NT_SH set "NT_SH=%%~$PATH:I"',
        'if not defined NT_SH goto :nt_drain',
        'set "NT_ARG=%NT_SCRIPT:\\=/%"',
        '"%NT_SH%" "%NT_ARG%"',
        'exit /b %ERRORLEVEL%',
        ':nt_drain',
        'rem No shell or no script: consume the payload codex wrote to our stdin, then succeed.',
        'rem Bailing without reading can EPIPE the writer mid-payload (#186/#187).',
        'findstr /r ".*" >nul 2>&1',
        'exit /b 0',
        ''
      ].join('\r\n')
    )
  })
})

/**
 * AS AGY DISPATCHES IT. `agy` (a Go binary) passes the hooks.json command to `cmd /c` as ONE
 * argument, escaped the MSVCRT way: wrapped in quotes, inner `"` written as `\"`, with the hook's
 * cwd set to the directory holding hooks.json. Node's default (non-verbatim) spawn uses the same
 * escaping, and it reproduced agy 1.2.3's behaviour byte for byte on Windows 11 — so these cases run
 * the real command WITHOUT `windowsVerbatimArguments`, from the hooks.json directory, under a home
 * with a space in its name (a profile like `C:\Users\John Doe`).
 *
 * The POST is observed on a REAL loopback listener, not a fake curl: the wrapper picks Git's
 * `bin\sh.exe`, a launcher that puts Git's own curl first on PATH, so a PATH-planted stand-in is
 * never reached. (The real-agy runs posted to a listener the same way.)
 */
describe.skipIf(process.platform !== 'win32')('the Windows command as agy dispatches it', () => {
  const received: Record<string, string>[] = []
  let port = 0
  let server: Server | undefined
  beforeAll(async () => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => {
        received.push(Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString('utf8'))))
        res.writeHead(204)
        res.end()
      })
    })
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
    port = (server.address() as AddressInfo).port
  })
  afterAll(() => {
    server?.close()
  })

  let nodeSeq = 0
  interface Layout {
    home: string
    configDir: string
    hooksDir: string
    nodeId: string
    command: (ev: string) => string
  }
  const layout = (opts: { wrapper: boolean; script: boolean }): Layout => {
    const home = join(fresh(), 'John Doe')
    const configDir = join(home, '.gemini', 'config')
    const hooksDir = join(home, '.nodeterm', 'agent-hooks')
    mkdirSync(configDir, { recursive: true })
    mkdirSync(hooksDir, { recursive: true })
    const script = join(hooksDir, 'antigravity.sh')
    if (opts.wrapper) writeFileSync(join(hooksDir, ANTIGRAVITY_WINDOWS_WRAPPER_FILE), buildAntigravityWindowsWrapper(), 'utf8')
    if (opts.script) writeFileSync(script, buildManagedScript('antigravity', null), 'utf8')
    writeFileSync(
      join(home, '.nodeterm', 'hook-endpoint.env'),
      `NODETERM_HOOK_PORT=${port}\nNODETERM_HOOK_TOKEN=t\nNODETERM_HOOK_VERSION=2\n`,
      'utf8'
    )
    const hooksJson = join(configDir, 'hooks.json')
    const nodeId = `term-agy-dispatch-${++nodeSeq}`
    return { home, configDir, hooksDir, nodeId, command: (ev) => antigravityCommandFor(script, ev, 'win32', hooksJson) }
  }
  const dispatch = (l: Layout, command: string, input = '{"conversationId":"c"}') => {
    const env: Record<string, string | undefined> = {
      ...process.env,
      HOME: l.home,
      USERPROFILE: l.home,
      NODETERM_NODE_ID: l.nodeId,
      NODETERM_HOOK_ENDPOINT: join(l.home, '.nodeterm', 'hook-endpoint.env')
    }
    delete env.NODETERM_AGY_EVENT
    // NO windowsVerbatimArguments: Node escapes the command exactly as agy does.
    return spawnSync(process.env.ComSpec || 'cmd.exe', ['/c', command], { input, env, cwd: l.configDir, timeout: T })
  }
  const out = (r: ReturnType<typeof dispatch>): string => r.stdout.toString().replace(/\r\n/g, '\n')
  /** One node's POSTs, waiting ASYNCHRONOUSLY so the listener gets to run. */
  const posts = async (nodeId: string, count: number): Promise<Record<string, string>[]> => {
    const deadline = Date.now() + 15_000
    for (;;) {
      const mine = received.filter((r) => r.nodeId === nodeId)
      if (mine.length >= count || Date.now() > deadline) return mine
      await new Promise((r) => setTimeout(r, 100))
    }
  }

  it('wrapper and script present: every event answers its table row, exit 0, and is POSTed', async () => {
    for (const ev of ANTIGRAVITY_EVENTS) {
      const l = layout({ wrapper: true, script: true })
      const r = dispatch(l, l.command(ev))
      expect(r.status, ev).toBe(0)
      expect(out(r), ev).toBe(`${antigravityDecisionFor(ev)}\n`)
      const p = await posts(l.nodeId, 1)
      expect(p, ev).toHaveLength(1)
      expect(p[0].nodeterm_hook_event, ev).toBe(ev)
      expect(JSON.parse(p[0].payload), ev).toEqual({ conversationId: 'c' })
    }
  }, T)

  it('wrapper ABSENT: stdout empty, exit 0, no POST — silence, never a DENY', async () => {
    for (const ev of ANTIGRAVITY_EVENTS) {
      const l = layout({ wrapper: false, script: true })
      const r = dispatch(l, l.command(ev))
      expect(r.status, ev).toBe(0)
      expect(out(r), ev).toBe('')
      expect(r.stderr.toString(), ev).toBe('')
      await new Promise((res) => setTimeout(res, 300))
      expect(received.filter((x) => x.nodeId === l.nodeId), ev).toHaveLength(0)
    }
  }, T)

  it('script ABSENT: the wrapper answers the table row itself, exit 0', () => {
    for (const ev of ANTIGRAVITY_EVENTS) {
      const l = layout({ wrapper: true, script: false })
      const r = dispatch(l, l.command(ev))
      expect(r.status, ev).toBe(0)
      expect(out(r), ev).toBe(`${antigravityDecisionFor(ev)}\n`)
    }
  }, T)

  it('an unknown event prints nothing, exit 0', () => {
    const l = layout({ wrapper: true, script: true })
    const r = dispatch(l, buildAntigravityWindowsCommand('..\\..\\.nodeterm\\agent-hooks', 'Bogus'))
    expect(r.status).toBe(0)
    expect(out(r)).toBe('')
  }, T)

  it('a 200 KB stdin neither blocks nor breaks the answer', () => {
    const l = layout({ wrapper: true, script: true })
    const r = dispatch(l, l.command('PreToolUse'), JSON.stringify({ blob: 'x'.repeat(200_000) }))
    expect(r.status).toBe(0)
    expect(out(r)).toBe('{"decision":"ask"}\n')
  }, T)

  it('NEVER GO BACK: the codex-style quoted command fails under this dispatch (exit 1 = DENY)', () => {
    // The form first adopted from codex.ts. Against the real agy 1.2.3 it failed with
    // `'\"C:\...\antigravity-hook.cmd \"' is not recognized`, exit 1, denying every tool. Pinned so
    // nobody "fixes" the command back to it.
    const l = layout({ wrapper: true, script: true })
    const quoted = `${defaultWindowsCmdExe()} /d /c call "${l.hooksDir}\\${ANTIGRAVITY_WINDOWS_WRAPPER_FILE} " PreToolUse`
    const r = dispatch(l, quoted)
    expect(r.status).toBe(1)
    expect(out(r)).toBe('')
    expect(r.stderr.toString()).toContain('\\"')
  }, T)
})

/**
 * The installer-registry test
 * (`index.test.ts`) spies `os.homedir` and calls the installers with their DEFAULTS. Once this
 * installer is registered, that call must land in the fake home — script, wrapper AND the global
 * hooks.json — and never in the real one. This calls the installer the same way, with the same spy.
 */
describe('the default install follows a spied os.homedir (as index.test.ts calls it)', () => {
  it('writes hooks.json, script and wrapper under the fake home, and leaves the real hooks.json alone', () => {
    const realHooks = antigravityHooksJsonPath()
    const before = existsSync(realHooks) ? statSync(realHooks).mtimeMs : null
    const fake = join(fresh(), 'Fake Home')
    mkdirSync(fake, { recursive: true })
    const spy = vi.spyOn(osDefault, 'homedir').mockReturnValue(fake)
    try {
      installAntigravityHooks({ findAgy: HAS_AGY, readAutoRun: CLEAR })
    } finally {
      spy.mockRestore()
    }
    const hooksJson = join(fake, '.gemini', 'config', 'hooks.json')
    expect(existsSync(hooksJson)).toBe(true)
    expect(Object.keys(read(hooksJson))).toEqual([ANTIGRAVITY_BUNDLE_KEY])
    expect(existsSync(join(fake, '.nodeterm', 'agent-hooks', 'antigravity.sh'))).toBe(true)
    expect(existsSync(join(fake, '.nodeterm', 'agent-hooks', ANTIGRAVITY_WINDOWS_WRAPPER_FILE))).toBe(
      process.platform === 'win32'
    )
    const after = existsSync(realHooks) ? statSync(realHooks).mtimeMs : null
    expect(after).toBe(before)
    expect(realHooks.startsWith(fake)).toBe(false)
  })
})

/**
 * The hook exists only where agy does. Without agy there is no gate to install in front of anybody's
 * tools, and nothing of ours should be on disk; an agy installed later gets the hook at the next
 * launch, and a bundle left from a machine that once had agy is withdrawn.
 */
describe('install only where agy is installed', () => {
  const NO_AGY = (): null => null
  const layout = () => {
    const home = join(fresh(), 'John Doe')
    const hooksJson = join(home, '.gemini', 'config', 'hooks.json')
    const script = join(home, '.nodeterm', 'agent-hooks', 'antigravity.sh')
    return {
      hooksJson,
      script,
      wrapper: join(home, '.nodeterm', 'agent-hooks', ANTIGRAVITY_WINDOWS_WRAPPER_FILE)
    }
  }

  it.each(['win32', 'linux'])('no agy, no file (%s) → nothing written, nothing logged, registry never read', (platform) => {
    const l = layout()
    let registryReads = 0
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      installAntigravityHooks({
        hooksJson: l.hooksJson,
        platform,
        scriptPath: l.script,
        findAgy: NO_AGY,
        readAutoRun: () => {
          registryReads++
          return { kind: 'clear' }
        }
      })
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
    expect(existsSync(l.hooksJson)).toBe(false)
    expect(existsSync(l.script)).toBe(false)
    expect(existsSync(l.wrapper)).toBe(false)
    expect(registryReads).toBe(0)
  })

  it('no agy, our bundle present → withdrawn, foreign keys intact, and the log says why', () => {
    const l = layout()
    mkdirSync(join(l.hooksJson, '..'), { recursive: true })
    writeFileSync(l.hooksJson, JSON.stringify({ mine: { enabled: false } }), 'utf8')
    installAntigravityHooks({ hooksJson: l.hooksJson, platform: 'win32', scriptPath: l.script, findAgy: HAS_AGY, readAutoRun: CLEAR })
    expect(read(l.hooksJson)[ANTIGRAVITY_BUNDLE_KEY]).toBeDefined()

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      installAntigravityHooks({ hooksJson: l.hooksJson, platform: 'win32', scriptPath: l.script, findAgy: NO_AGY, readAutoRun: CLEAR })
      const text = warn.mock.calls.map((c) => String(c[0])).join('\n')
      expect(text).toContain('agy is not installed')
      expect(text).toContain('was withdrawn')
    } finally {
      warn.mockRestore()
    }
    expect(read(l.hooksJson)).toEqual({ mine: { enabled: false } })
  })

  it('a detector that throws counts as "not installed"', () => {
    const l = layout()
    installAntigravityHooks({
      hooksJson: l.hooksJson,
      platform: 'linux',
      scriptPath: l.script,
      findAgy: () => {
        throw new Error('EACCES')
      }
    })
    expect(existsSync(l.hooksJson)).toBe(false)
  })

  it('agy present → installs exactly as before', () => {
    const l = layout()
    installAntigravityHooks({ hooksJson: l.hooksJson, platform: 'win32', scriptPath: l.script, findAgy: HAS_AGY, readAutoRun: CLEAR })
    expect(Object.keys(read(l.hooksJson))).toEqual([ANTIGRAVITY_BUNDLE_KEY])
    expect(existsSync(l.script)).toBe(true)
    expect(existsSync(l.wrapper)).toBe(true)
  })

  it('the vendor install locations, per platform', () => {
    expect(agyFallbackPaths('win32', 'C:\\Users\\John Doe', { LOCALAPPDATA: 'D:\\Local' })).toEqual([
      'D:\\Local\\agy\\bin\\agy.exe'
    ])
    expect(agyFallbackPaths('win32', 'C:\\Users\\John Doe', {})).toEqual([
      'C:\\Users\\John Doe\\AppData\\Local\\agy\\bin\\agy.exe'
    ])
    expect(agyFallbackPaths('darwin', '/Users/jd', {})).toEqual(['/Users/jd/.local/bin/agy'])
    expect(agyFallbackPaths('linux', '/home/jd', { LOCALAPPDATA: 'ignored' })).toEqual(['/home/jd/.local/bin/agy'])
  })

  describe('findAgy against a fake machine (a file lookup, never a spawn)', () => {
    const saved = { PATH: process.env.PATH, LOCALAPPDATA: process.env.LOCALAPPDATA }
    afterEach(() => {
      process.env.PATH = saved.PATH
      if (saved.LOCALAPPDATA === undefined) delete process.env.LOCALAPPDATA
      else process.env.LOCALAPPDATA = saved.LOCALAPPDATA
      vi.restoreAllMocks()
    })
    const binName = process.platform === 'win32' ? 'agy.exe' : 'agy'
    const plant = (dir: string): string => {
      mkdirSync(dir, { recursive: true })
      const file = join(dir, binName)
      writeFileSync(file, '', { mode: 0o755 })
      return file
    }
    const same = (a: string | null, b: string) => expect(a?.toLowerCase()).toBe(b.toLowerCase())

    it('finds agy on the PATH', () => {
      const dir = join(fresh(), 'path bin')
      const file = plant(dir)
      const emptyHome = fresh()
      vi.spyOn(osDefault, 'homedir').mockReturnValue(emptyHome)
      process.env.LOCALAPPDATA = join(emptyHome, 'nothing-here')
      process.env.PATH = dir
      same(findAgy(), file)
    })

    it('finds agy at the vendor install location when the PATH does not have it', () => {
      const home = fresh()
      vi.spyOn(osDefault, 'homedir').mockReturnValue(home)
      process.env.PATH = join(fresh(), 'empty')
      let file: string
      if (process.platform === 'win32') {
        process.env.LOCALAPPDATA = join(home, 'AppData', 'Local')
        file = plant(join(home, 'AppData', 'Local', 'agy', 'bin'))
      } else {
        file = plant(join(home, '.local', 'bin'))
      }
      same(findAgy(), file)
    })

    it('answers null when neither has it', () => {
      const home = fresh()
      vi.spyOn(osDefault, 'homedir').mockReturnValue(home)
      process.env.LOCALAPPDATA = join(home, 'AppData', 'Local')
      process.env.PATH = join(fresh(), 'empty')
      expect(findAgy()).toBeNull()
    })
  })
})

/**
 * Two passes around the login-shell PATH probe. At boot the lookup may only see a GUI app's minimal
 * PATH, so a miss there must decide nothing; the decision is made once the probe has settled.
 */
describe('installAntigravityHooksWithProbe — boot pass, then a final pass after the PATH probe', () => {
  const deferred = () => {
    let resolve!: () => void
    let reject!: (e: Error) => void
    const promise = new Promise<void>((res, rej) => {
      resolve = res
      reject = rej
    })
    return { promise, resolve, reject }
  }
  /** A detector that answers from a script of results, and counts its calls. */
  const detector = (...answers: (string | null)[]) => {
    const d = { calls: 0, find: (): string | null => answers[Math.min(d.calls++, answers.length - 1)] }
    return d
  }
  const setup = () => {
    const home = join(fresh(), 'John Doe')
    return {
      hooksJson: join(home, '.gemini', 'config', 'hooks.json'),
      scriptPath: join(home, '.nodeterm', 'agent-hooks', 'antigravity.sh')
    }
  }
  const base = (l: { hooksJson: string; scriptPath: string }, find: () => string | null) => ({
    ...l,
    platform: 'win32' as const,
    findAgy: find,
    readAutoRun: CLEAR
  })

  it('not found at boot, found after the probe → installed by the final pass', async () => {
    const l = setup()
    const d = detector(null, 'C:/x/agy.exe')
    const probe = deferred()
    const done = installAntigravityHooksWithProbe(base(l, d.find), () => probe.promise)
    expect(existsSync(l.hooksJson)).toBe(false)
    probe.resolve()
    await expect(done).resolves.toBe('installed')
    expect(Object.keys(read(l.hooksJson))).toEqual([ANTIGRAVITY_BUNDLE_KEY])
    expect(d.calls).toBe(2)
  })

  it('not found in either pass, with our bundle → withdrawn ONLY by the final pass', async () => {
    const l = setup()
    installAntigravityHooks({ ...base(l, HAS_AGY) })
    mkdirSync(join(l.hooksJson, '..'), { recursive: true })
    const withOther = { ...read(l.hooksJson), 'other-tool': { enabled: false } }
    writeFileSync(l.hooksJson, JSON.stringify(withOther), 'utf8')
    const before = readFileSync(l.hooksJson, 'utf8')

    const probe = deferred()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const done = installAntigravityHooksWithProbe(base(l, detector(null, null).find), () => probe.promise)
      expect(readFileSync(l.hooksJson, 'utf8')).toBe(before) // the boot pass touched nothing
      expect(warn).not.toHaveBeenCalled()
      probe.resolve()
      await expect(done).resolves.toBe('no-agy')
      expect(read(l.hooksJson)).toEqual({ 'other-tool': { enabled: false } })
      expect(String(warn.mock.calls[0]?.[0])).toContain('agy is not installed')
    } finally {
      warn.mockRestore()
    }
  })

  it('not found in either pass, no bundle → nothing written, nothing logged', async () => {
    const l = setup()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await expect(
        installAntigravityHooksWithProbe(base(l, detector(null, null).find), () => Promise.resolve())
      ).resolves.toBe('no-agy')
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
    expect(existsSync(l.hooksJson)).toBe(false)
    expect(existsSync(l.scriptPath)).toBe(false)
  })

  it('found at boot → installed once; no second pass, nothing rewritten', async () => {
    const l = setup()
    const d = detector('C:/x/agy.exe')
    let probed = 0
    const writes: string[] = []
    const done = installAntigravityHooksWithProbe(
      {
        ...base(l, d.find),
        writeFile: (file, data) => {
          writes.push(file)
          mkdirSync(join(file, '..'), { recursive: true })
          writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
        }
      },
      () => {
        probed++
        return Promise.resolve()
      }
    )
    await expect(done).resolves.toBe('installed')
    await new Promise((r) => setTimeout(r, 20))
    expect(probed).toBe(0)
    expect(d.calls).toBe(1)
    expect(writes).toEqual([l.hooksJson])
    expect(JSON.stringify(read(l.hooksJson)).match(/antigravity-hook\.cmd/g)).toHaveLength(8)
  })

  it('a probe that FAILS still runs the final pass (with the inherited PATH)', async () => {
    const l = setup()
    const done = installAntigravityHooksWithProbe(base(l, detector(null, 'C:/x/agy.exe').find), () =>
      Promise.reject(new Error('login shell hung'))
    )
    await expect(done).resolves.toBe('installed')
    expect(existsSync(l.hooksJson)).toBe(true)
  })

  it('the final pass writes where the boot pass would have, even if os.homedir changed in between', async () => {
    const fake = join(fresh(), 'Fake Home')
    mkdirSync(fake, { recursive: true })
    const realHooks = antigravityHooksJsonPath()
    const realBefore = existsSync(realHooks) ? statSync(realHooks).mtimeMs : null
    const probe = deferred()
    const spy = vi.spyOn(osDefault, 'homedir').mockReturnValue(fake)
    let done: Promise<unknown>
    try {
      done = installAntigravityHooksWithProbe(
        { platform: 'win32', findAgy: detector(null, 'C:/x/agy.exe').find, readAutoRun: CLEAR },
        () => probe.promise
      )
    } finally {
      spy.mockRestore() // the test that spied is over before the probe answers
    }
    probe.resolve()
    await done
    expect(existsSync(join(fake, '.gemini', 'config', 'hooks.json'))).toBe(true)
    const realAfter = existsSync(realHooks) ? statSync(realHooks).mtimeMs : null
    expect(realAfter).toBe(realBefore)
  })
})
