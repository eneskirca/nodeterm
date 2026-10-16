// The repair issue #558 actually owes the user: their settings.json ON DISK must come back to one
// managed entry per event at the next launch, not just a fresh install. `installManagedAgentHooks`
// runs `installHooksInto` for every agent at boot, so proving it here proves the repair.
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// `installManagedHookScript` writes into homedir()/.nodeterm — point that at a temp dir so the
// test never touches the machine's real home.
let home = ''
vi.mock('os', async (orig) => {
  const actual = await orig<typeof import('os')>()
  return { ...actual, default: { ...actual, homedir: () => home }, homedir: () => home }
})

import { installHooksInto, removeHooksFrom } from './install-helper'
import { CLAUDE_HOOK_EVENTS, managedEventName } from '@shared/agents/hook-events'

const WIN_CMD =
  "if [ -r 'C:\\Users\\u\\.nodeterm\\agent-hooks\\claude.sh' ]; then sh 'C:\\Users\\u\\.nodeterm\\agent-hooks\\claude.sh'; else cat >/dev/null 2>&1 || :; fi"
const FOREIGN = { hooks: [{ type: 'command', command: 'sh "C:\\tools\\agent-hooks\\other.sh"' }] }

let dir = ''
const configPath = () => path.join(dir, '.claude', 'settings.json')
const readConfig = () => JSON.parse(readFileSync(configPath(), 'utf8'))
const install = () =>
  installHooksInto({
    agentId: 'claude',
    scriptFileName: 'claude.sh',
    configPath: configPath(),
    events: CLAUDE_HOOK_EVENTS
  })

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'nt-hooks-'))
  home = dir
  mkdirSync(path.join(dir, '.claude'), { recursive: true })
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('installHooksInto — heals an already-broken settings.json (issue #558)', () => {
  it('collapses 9 accumulated duplicates per event to 1 and keeps the user`s own hooks', () => {
    const hooks: Record<string, unknown[]> = { PreCompact: [FOREIGN] }
    for (const ev of CLAUDE_HOOK_EVENTS.map(managedEventName)) {
      hooks[ev] = [FOREIGN, ...Array.from({ length: 9 }, () => ({ hooks: [{ type: 'command', command: WIN_CMD }] }))]
    }
    writeFileSync(configPath(), JSON.stringify({ model: 'opus', hooks }, null, 2), 'utf8')

    install()

    const after = readConfig()
    for (const ev of CLAUDE_HOOK_EVENTS.map(managedEventName)) {
      const defs = after.hooks[ev]
      expect(defs, ev).toHaveLength(2)
      expect(defs[0], ev).toEqual(FOREIGN)
      expect(defs[1].hooks[0].command, ev).toContain('agent-hooks')
    }
    // An event we do not manage keeps the foreign hook untouched, and unrelated settings survive.
    expect(after.hooks.PreCompact).toEqual([FOREIGN])
    expect(after.model).toBe('opus')
  })

  it('is idempotent — a second and third run change nothing', () => {
    install()
    const once = readFileSync(configPath(), 'utf8')
    install()
    install()
    expect(readFileSync(configPath(), 'utf8')).toBe(once)
  })
})

describe('removeHooksFrom — uninstall also matched raw before the fix', () => {
  it('removes a windows-path managed entry and keeps a foreign one', () => {
    writeFileSync(
      configPath(),
      JSON.stringify({ hooks: { Stop: [FOREIGN, { hooks: [{ type: 'command', command: WIN_CMD }] }] } }),
      'utf8'
    )
    removeHooksFrom({ configPath: configPath(), events: CLAUDE_HOOK_EVENTS, scriptFileName: 'claude.sh' })
    expect(readConfig().hooks.Stop).toEqual([FOREIGN])
  })
})

describe('issue #851: shared settings are never healed by replacing user data', () => {
  it.each(['{broken', 'null', '[]', '{"model":"keep","hooks":{"Stop":{}}}'])('preserves %s through install and uninstall', (raw) => {
    writeFileSync(configPath(), raw)
    install()
    expect(readFileSync(configPath(), 'utf8')).toBe(raw)
    removeHooksFrom({ configPath: configPath(), events: CLAUDE_HOOK_EVENTS, scriptFileName: 'claude.sh' })
    expect(readFileSync(configPath(), 'utf8')).toBe(raw)
  })
})


describe('owned Grok config repair', () => {
  it.each(['{broken', '{"hooks":[]}', '{"hooks":{"Stop":"x"}}', 'null'])('heals %s only for an owned config', (raw) => {
    writeFileSync(configPath(), raw)
    installHooksInto({ agentId: 'grok', scriptFileName: 'grok.sh', configPath: configPath(), events: ['Stop'], atomicConfig: true })
    expect(readConfig().hooks.Stop[0].hooks[0].command).toContain('grok.sh')
  })
})

describe('installHooksInto — Windows wrapper for PowerShell-run hooks (gemini, grok)', () => {
  const CMD = 'C:\\WINDOWS\\System32\\cmd.exe'
  const geminiInstall = (platform: string) =>
    installHooksInto({
      agentId: 'gemini',
      scriptFileName: 'gemini.sh',
      configPath: configPath(),
      events: ['AfterTool', 'Notification'],
      windowsWrapper: true,
      platform,
      cmdExe: CMD
    })
  const wrapperPath = () => path.join(dir, '.nodeterm', 'agent-hooks', 'gemini-hook.cmd')

  it('win32: writes the CRLF wrapper beside the script and points every event at it', () => {
    geminiInstall('win32')
    const wrapper = readFileSync(wrapperPath(), 'utf8')
    expect(wrapper).toContain('set "NT_SCRIPT=%~dp0gemini.sh"')
    expect(wrapper).toContain('\r\n')
    const command = readConfig().hooks.AfterTool[0].hooks[0].command
    expect(command).toBe(`${CMD} /d /c call "${wrapperPath()} "`)
    expect(readConfig().hooks.Notification[0].hooks[0].command).toBe(command)
  })

  it('win32: replaces the POSIX entry an older build left (no duplicate per event)', () => {
    geminiInstall('linux')
    geminiInstall('win32')
    expect(readConfig().hooks.AfterTool).toHaveLength(1)
    expect(readConfig().hooks.AfterTool[0].hooks[0].command).toContain('gemini-hook.cmd')
  })

  it('win32: a wrapper that cannot be written leaves the config untouched (wrapper BEFORE config)', () => {
    // A directory where the wrapper file must go makes the atomic publish fail.
    mkdirSync(wrapperPath(), { recursive: true })
    writeFileSync(configPath(), '{"model":"keep"}')
    geminiInstall('win32')
    expect(readFileSync(configPath(), 'utf8')).toBe('{"model":"keep"}')
  })

  it('other platforms: no wrapper, and the command is the POSIX guard', () => {
    geminiInstall('darwin')
    expect(existsSync(wrapperPath())).toBe(false)
    expect(readConfig().hooks.AfterTool[0].hooks[0].command).toMatch(/^if \[ -r /)
  })

  it('claude never gets a wrapper, even on win32 (its hooks run in Git Bash)', () => {
    installHooksInto({ agentId: 'claude', scriptFileName: 'claude.sh', configPath: configPath(), events: ['Stop'], platform: 'win32' })
    expect(existsSync(path.join(dir, '.nodeterm', 'agent-hooks', 'claude-hook.cmd'))).toBe(false)
    expect(readConfig().hooks.Stop[0].hooks[0].command).toMatch(/^if \[ -r /)
  })
})
