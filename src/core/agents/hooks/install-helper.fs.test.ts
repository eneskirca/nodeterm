// The repair issue #558 actually owes the user: their settings.json ON DISK must come back to one
// managed entry per event at the next launch, not just a fresh install. `installManagedAgentHooks`
// runs `installHooksInto` for every agent at boot, so proving it here proves the repair.
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'fs'
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
import { CLAUDE_HOOK_EVENTS } from '@shared/agents/hook-events'

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
    for (const ev of CLAUDE_HOOK_EVENTS) {
      hooks[ev as string] = [FOREIGN, ...Array.from({ length: 9 }, () => ({ hooks: [{ type: 'command', command: WIN_CMD }] }))]
    }
    writeFileSync(configPath(), JSON.stringify({ model: 'opus', hooks }, null, 2), 'utf8')

    install()

    const after = readConfig()
    for (const ev of CLAUDE_HOOK_EVENTS) {
      const defs = after.hooks[ev as string]
      expect(defs, ev as string).toHaveLength(2)
      expect(defs[0], ev as string).toEqual(FOREIGN)
      expect(defs[1].hooks[0].command, ev as string).toContain('agent-hooks')
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
