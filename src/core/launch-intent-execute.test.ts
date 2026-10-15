// `pty:execute-launch` — gating, the Windows executable resolver, and the round trip that is the
// point of the whole channel: a prompt full of quote and shell metacharacters must arrive at the
// agent as ONE argv element on every Windows-native dialect. All of it runs on any OS: the planner
// only builds strings, and the argv is recovered here by the same parsers PowerShell and the
// Microsoft CRT apply.
import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFileSync } from 'child_process'
import { describe, expect, it, vi } from 'vitest'
import {
  executeLaunchIntent,
  promptFromFileText,
  readPromptFileBounded,
  resolveWindowsAgentExecutable,
  windowsLaunchDialectForShell,
  windowsPowerShellPath,
  type LaunchIntentDeps,
  type LaunchTarget
} from './launch-intent-execute'
import type { PreparedAgentLaunch } from './agent-launch'
import type { AgentLaunchIntent } from '../shared/types'

const LAUNCH_ID = '123e4567-e89b-42d3-a456-426614174000'
const PS = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
const NPM_DIR = 'C:\\Users\\me\\AppData\\Roaming\\npm'
const NATIVE_DIR = 'C:\\Users\\me\\.local\\bin'

function target(extra: Partial<LaunchTarget> = {}): LaunchTarget {
  return {
    name: 'nt-node-1',
    sessionHost: true,
    remote: false,
    launchDialect: 'pwsh',
    agentId: 'claude',
    pathValue: `${NATIVE_DIR};${NPM_DIR}`,
    ...extra
  }
}

function deps(files: string[], extra: Partial<LaunchIntentDeps> = {}) {
  const plans: Array<{ name: string; launchId: string; plan: PreparedAgentLaunch }> = []
  const set = new Set(files.map((f) => f.toLowerCase()))
  const d: LaunchIntentDeps = {
    platform: 'win32',
    customAgents: () => [],
    sharedIdentityAvailable: async () => false,
    codexCaps: async () => ({ approvalValues: null, noDaemon: null }),
    exists: (candidate) => set.has(candidate.toLowerCase()),
    systemRoot: 'C:\\Windows',
    readPromptFile: async () => {
      throw new Error('no file')
    },
    execute: async (name, launchId, plan) => {
      plans.push({ name, launchId, plan })
      return { status: 'executed' }
    },
    isProtocolIncompatible: () => false,
    ...extra
  }
  return { d, plans }
}

const start = (prompt?: string, extra: Partial<AgentLaunchIntent> = {}): AgentLaunchIntent =>
  ({ kind: 'agent', action: 'start', agentId: 'claude', ...(prompt !== undefined ? { prompt } : {}), ...extra }) as AgentLaunchIntent

/** PowerShell single-quoted string literals, in order. */
function psLiterals(script: string): string[] {
  return [...script.matchAll(/'((?:[^']|'')*)'/gu)].map((m) => m[1].replace(/''/g, "'"))
}

/** CommandLineToArgvW / Microsoft CRT argument parsing for a command line's ARGUMENT part. */
function crtArgv(line: string): string[] {
  const out: string[] = []
  let i = 0
  while (i < line.length) {
    while (line[i] === ' ' || line[i] === '\t') i++
    if (i >= line.length) break
    let arg = ''
    let quoted = false
    for (; i < line.length; i++) {
      const ch = line[i]
      if (!quoted && (ch === ' ' || ch === '\t')) break
      if (ch === '\\') {
        let n = 0
        while (line[i] === '\\') {
          n++
          i++
        }
        if (line[i] === '"') {
          arg += '\\'.repeat(Math.floor(n / 2))
          if (n % 2) arg += '"'
          else quoted = !quoted
        } else {
          arg += '\\'.repeat(n)
          i--
        }
        continue
      }
      if (ch === '"') {
        quoted = !quoted
        continue
      }
      arg += ch
    }
    out.push(arg)
  }
  return out
}

/** The agent argv a prepared PowerShell script runs (native via Start-Process, or a `.ps1`). */
function scriptArgv(script: string): { executable: string; args: string[] } {
  const literals = psLiterals(script)
  if (script.startsWith('& ')) return { executable: literals[0], args: literals.slice(1) }
  expect(script).toMatch(/^\$ntAgent = Start-Process -FilePath '/u)
  return { executable: literals[0], args: literals[1] === undefined ? [] : crtArgv(literals[1]) }
}

function decodeCmd(command: string): string {
  const payload = command.match(/-EncodedCommand ([A-Za-z0-9+/]+=*)$/u)?.[1]
  expect(payload).toBeTruthy()
  return Buffer.from(payload as string, 'base64').toString('utf16le')
}

const NASTY = `it's "quoted" & 100% ^caret | <x> !bang $env:HOME \`tick; 開発`

describe('windowsLaunchDialectForShell', () => {
  it('names only the three Windows-native parsers, by basename, on win32', () => {
    expect(windowsLaunchDialectForShell('C:\\Program Files\\PowerShell\\7\\pwsh.exe', 'win32')).toBe('pwsh')
    expect(windowsLaunchDialectForShell('pwsh', 'win32')).toBe('pwsh')
    expect(windowsLaunchDialectForShell('"C:\\Program Files\\PowerShell\\7\\PWSH.EXE"', 'win32')).toBe('pwsh')
    expect(windowsLaunchDialectForShell(PS, 'win32')).toBe('windows-powershell')
    expect(windowsLaunchDialectForShell('powershell.exe', 'win32')).toBe('windows-powershell')
    expect(windowsLaunchDialectForShell('C:\\Windows\\System32\\cmd.exe', 'win32')).toBe('cmd')
    // Git Bash / WSL / anything else keep the host's dialect UNSET, exactly as before.
    expect(windowsLaunchDialectForShell('C:\\Program Files\\Git\\bin\\bash.exe', 'win32')).toBeUndefined()
    expect(windowsLaunchDialectForShell('wsl.exe', 'win32')).toBeUndefined()
    expect(windowsLaunchDialectForShell('nu.exe', 'win32')).toBeUndefined()
    expect(windowsLaunchDialectForShell(undefined, 'win32')).toBeUndefined()
  })

  it('is always undefined off win32, so a POSIX spawn request is unchanged', () => {
    for (const p of ['darwin', 'linux']) {
      expect(windowsLaunchDialectForShell('pwsh', p)).toBeUndefined()
      expect(windowsLaunchDialectForShell('/bin/zsh', p)).toBeUndefined()
    }
  })
})

describe('resolveWindowsAgentExecutable', () => {
  it('walks PATH in order, preferring a native image, then .ps1, then a batch shim', () => {
    const exists = (files: string[]) => (c: string) => files.includes(c)
    const path = `${NATIVE_DIR};"${NPM_DIR}"`
    expect(
      resolveWindowsAgentExecutable('claude', path, exists([`${NPM_DIR}\\claude.ps1`, `${NPM_DIR}\\claude.cmd`]))
    ).toEqual({ kind: 'powershell-script', executable: `${NPM_DIR}\\claude.ps1` })
    expect(
      resolveWindowsAgentExecutable('claude', path, exists([`${NATIVE_DIR}\\claude.exe`, `${NPM_DIR}\\claude.ps1`]))
    ).toEqual({ kind: 'native', executable: `${NATIVE_DIR}\\claude.exe` })
    expect(resolveWindowsAgentExecutable('claude', path, exists([`${NPM_DIR}\\claude.cmd`]))).toEqual({
      kind: 'cmd-script',
      executable: `${NPM_DIR}\\claude.cmd`
    })
    expect(resolveWindowsAgentExecutable('claude', path, exists([]))).toBeNull()
  })

  it('accepts an absolute path only when it exists, and never a relative one or a UNC dir', () => {
    const exe = 'C:\\Tools\\agent.exe'
    expect(resolveWindowsAgentExecutable(exe, '', (c) => c === exe)).toEqual({ kind: 'native', executable: exe })
    expect(resolveWindowsAgentExecutable('C:\\Tools\\agent', '', (c) => c === exe)).toEqual({ kind: 'native', executable: exe })
    expect(resolveWindowsAgentExecutable('.\\agent.exe', '', () => true)).toBeNull()
    expect(resolveWindowsAgentExecutable('agent', '\\\\server\\share', () => true)).toBeNull()
  })

  it('finds the inbox Windows PowerShell by its fixed system path', () => {
    expect(windowsPowerShellPath('C:\\Windows', (c) => c === PS)).toBe(PS)
    expect(windowsPowerShellPath('C:\\Windows', () => false)).toBeUndefined()
  })
})

describe('executeLaunchIntent gating', () => {
  const request = { launchId: LAUNCH_ID, intent: start('hi') }

  it.each([
    ['a POSIX core', { platform: 'darwin' }, {}],
    ['a Linux core', { platform: 'linux' }, {}],
    ['a tmux session', {}, { sessionHost: false }],
    ['an SSH session', {}, { remote: true }],
    ['a generation with no recorded dialect', {}, { launchDialect: undefined }],
    ['a Git Bash / WSL pane', {}, { launchDialect: 'posix' as const }]
  ])('answers unsupported-shell for %s and never reaches the host', async (_n, d, t) => {
    const { d: base, plans } = deps([`${NATIVE_DIR}\\claude.exe`], d as Partial<LaunchIntentDeps>)
    const execute = vi.fn(base.execute)
    const result = await executeLaunchIntent(target(t), request, { ...base, execute })
    expect(result).toMatchObject({ ok: false, reason: 'unsupported-shell' })
    expect(execute).not.toHaveBeenCalled()
    expect(plans).toHaveLength(0)
  })

  it('answers session-unavailable with no live session', async () => {
    const { d } = deps([])
    expect(await executeLaunchIntent(undefined, request, d)).toMatchObject({ ok: false, reason: 'session-unavailable' })
  })

  it('refuses a malformed request or a foreign owner before anything is resolved', async () => {
    const { d, plans } = deps([`${NATIVE_DIR}\\claude.exe`])
    expect(await executeLaunchIntent(target(), { ...request, launchId: 'x' }, d)).toMatchObject({ reason: 'invalid-intent' })
    expect(await executeLaunchIntent(target(), null, d)).toMatchObject({ reason: 'invalid-intent' })
    expect(await executeLaunchIntent(target({ agentId: undefined }), request, d)).toMatchObject({ reason: 'agent-unavailable' })
    expect(await executeLaunchIntent(target({ agentId: 'codex' }), request, d)).toMatchObject({ reason: 'agent-unavailable' })
    // A raw newline is a command boundary to every Windows parser; the planner refuses it.
    expect(await executeLaunchIntent(target(), { launchId: LAUNCH_ID, intent: start('a\nb') }, d)).toMatchObject({
      reason: 'invalid-intent'
    })
    expect(plans).toHaveLength(0)
  })

  it('reports a .cmd-only install as a pre-delivery refusal (the caller falls back)', async () => {
    const { d, plans } = deps([`${NPM_DIR}\\claude.cmd`])
    expect(await executeLaunchIntent(target(), request, d)).toMatchObject({ ok: false, reason: 'unsupported-shell' })
    expect(plans).toHaveLength(0)
  })

  it('splits host failures: protocol-incompatible is a refusal, anything else may have typed', async () => {
    const files = [`${NATIVE_DIR}\\claude.exe`]
    const v1 = deps(files, { execute: async () => { throw new Error('v1') }, isProtocolIncompatible: () => true })
    expect(await executeLaunchIntent(target(), request, v1.d)).toMatchObject({ reason: 'unsupported-shell' })
    const lost = deps(files, { execute: async () => { throw new Error('lost') } })
    const result = await executeLaunchIntent(target(), request, lost.d)
    expect(result).toEqual({ ok: false, reason: 'delivery-failed', message: expect.any(String) })
    // Never reflects launch material.
    expect(JSON.stringify(result)).not.toContain('claude.exe')
  })
})

describe('executeLaunchIntent round trip', () => {
  it('pwsh + native: the prompt is ONE argv element, byte for byte', async () => {
    const { d, plans } = deps([`${NATIVE_DIR}\\claude.exe`])
    const result = await executeLaunchIntent(
      target(),
      { launchId: LAUNCH_ID, intent: start(NASTY, { permissionMode: 'acceptEdits' }) },
      d
    )
    expect(result).toEqual({ ok: true })
    expect(plans).toHaveLength(1)
    expect(plans[0]).toMatchObject({ name: 'nt-node-1', launchId: LAUNCH_ID })
    expect(scriptArgv(plans[0].plan.command)).toEqual({
      executable: `${NATIVE_DIR}\\claude.exe`,
      args: [NASTY, '--permission-mode', 'acceptEdits']
    })
  })

  it('windows-powershell + .ps1 shim: quoted with doubled apostrophes, never POSIX quoting', async () => {
    const { d, plans } = deps([`${NPM_DIR}\\claude.ps1`])
    await executeLaunchIntent(target({ launchDialect: 'windows-powershell' }), { launchId: LAUNCH_ID, intent: start(NASTY) }, d)
    const { command } = plans[0].plan
    expect(command).not.toContain(`'\\''`)
    expect(scriptArgv(command)).toEqual({ executable: `${NPM_DIR}\\claude.ps1`, args: [NASTY] })
  })

  it('cmd: an ASCII-only outer line whose -EncodedCommand decodes to the same argv', async () => {
    const { d, plans } = deps([`${NATIVE_DIR}\\claude.exe`, PS])
    await executeLaunchIntent(target({ launchDialect: 'cmd' }), { launchId: LAUNCH_ID, intent: start(NASTY) }, d)
    const { command } = plans[0].plan
    expect(command.startsWith(`"${PS}" -NoLogo -NoProfile -EncodedCommand `)).toBe(true)
    expect([...command].every((ch) => ch.charCodeAt(0) <= 0x7f)).toBe(true)
    expect(command).not.toContain('%')
    expect(scriptArgv(decodeCmd(command))).toEqual({ executable: `${NATIVE_DIR}\\claude.exe`, args: [NASTY] })
  })

  it('cmd without the inbox PowerShell refuses rather than interpolating into cmd', async () => {
    const { d, plans } = deps([`${NATIVE_DIR}\\claude.exe`])
    expect(
      await executeLaunchIntent(target({ launchDialect: 'cmd' }), { launchId: LAUNCH_ID, intent: start(NASTY) }, d)
    ).toMatchObject({ reason: 'unsupported-shell' })
    expect(plans).toHaveLength(0)
  })

  it('reads a --prompt-file in core and flattens it to one argument (no `$(cat …)` anywhere)', async () => {
    const file = 'C:\\briefs\\task.md'
    const read = vi.fn(async () => `\uFEFF# Task\r\n\r\nFix it's "bug" & 50%\n`)
    const { d, plans } = deps([`${NATIVE_DIR}\\claude.exe`], { readPromptFile: read })
    expect(await executeLaunchIntent(target(), { launchId: LAUNCH_ID, intent: start(), promptFile: file }, d)).toEqual({ ok: true })
    expect(read).toHaveBeenCalledWith(file, 128 * 1024)
    expect(plans[0].plan.command).not.toContain('$(cat')
    expect(scriptArgv(plans[0].plan.command).args).toEqual([`# Task Fix it's "bug" & 50%`])
  })

  it('refuses a prompt file beside an inline prompt, a relative path, or an unreadable file', async () => {
    const { d, plans } = deps([`${NATIVE_DIR}\\claude.exe`], { readPromptFile: async () => 'x' })
    expect(
      await executeLaunchIntent(target(), { launchId: LAUNCH_ID, intent: start('a'), promptFile: 'C:\\x.md' }, d)
    ).toMatchObject({ reason: 'invalid-intent' })
    expect(
      await executeLaunchIntent(target(), { launchId: LAUNCH_ID, intent: start(), promptFile: 'x.md' }, d)
    ).toMatchObject({ reason: 'invalid-intent' })
    const unreadable = deps([`${NATIVE_DIR}\\claude.exe`])
    expect(
      await executeLaunchIntent(target(), { launchId: LAUNCH_ID, intent: start(), promptFile: 'C:\\x.md' }, unreadable.d)
    ).toMatchObject({ reason: 'invalid-intent' })
    expect(plans).toHaveLength(0)
    expect(unreadable.plans).toHaveLength(0)
  })

  it('collapses prompt-file whitespace like the legacy PowerShell `cat` join did', () => {
    expect(promptFromFileText('\uFEFFa\r\n\tb  c\n')).toBe('a b c')
  })
})

describe('readPromptFileBounded (one descriptor for the check and the read)', () => {
  const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'nt-prompt-'))

  it('reads a regular file within the cap', async () => {
    const dir = tmp()
    const f = path.join(dir, 'p.txt')
    fs.writeFileSync(f, 'hello "world" $x')
    await expect(readPromptFileBounded(f, 1024)).resolves.toBe('hello "world" $x')
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('refuses a file over the cap', async () => {
    const dir = tmp()
    const f = path.join(dir, 'p.txt')
    fs.writeFileSync(f, 'x'.repeat(65))
    await expect(readPromptFileBounded(f, 64)).rejects.toThrow()
    await expect(readPromptFileBounded(f, 65)).resolves.toBe('x'.repeat(65))
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('refuses a directory and a missing file', async () => {
    const dir = tmp()
    await expect(readPromptFileBounded(dir, 64)).rejects.toThrow()
    await expect(readPromptFileBounded(path.join(dir, 'nope'), 64)).rejects.toThrow()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it.skipIf(process.platform === 'win32')('refuses a FIFO without hanging on the open (POSIX only: mkfifo)', async () => {
    const dir = tmp()
    const f = path.join(dir, 'fifo')
    execFileSync('mkfifo', [f])
    await expect(readPromptFileBounded(f, 64)).rejects.toThrow()
    fs.rmSync(dir, { recursive: true, force: true })
  })
})
