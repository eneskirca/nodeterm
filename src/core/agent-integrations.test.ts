// The agent-integration consent lifecycle (issue #744), against a real scratch $HOME.
//
// Each case is a promise to the user about their OWN files: nothing is written for an agent they
// did not enable, a decline removes exactly what nodeterm wrote (a file they edited is kept and
// reported), and every agent that has canvas control / context link still discovers them.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs'
import os from 'os'
import path from 'path'
import { initPlatform, resetPlatformForTests } from './platform'
import { fakePlatform } from './platform-fake'
import { DEFAULT_SETTINGS, type Settings } from '../shared/types'
import {
  CANVAS_SKILL,
  CONTEXT_SKILL,
  createIntegrationLifecycle,
  detectExistingIntegrations,
  resolveIntegrationConsentAtBoot
} from './agent-integrations'
import { buildCanvasSkillBody, frameCanvasControlBlock } from './canvas-control-core'
import { buildContextLinkSkillBody, frameInstructionsBlock } from './context-link-core'
import { MAX_RETAINED } from './integration-files'
import { registerClaudeAccountsSource, resetClaudeAccountsSourceForTests } from './claude-config-dir'
import { accountConfigDir } from './claude-accounts-core'
import type { ClaudeAccount } from '../shared/types'

const ENV_KEYS = ['HOME', 'USERPROFILE', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'GROK_HOME', 'COPILOT_HOME', 'XDG_CONFIG_HOME', 'GEMINI_CLI_HOME']
let saved: Record<string, string | undefined>
let home: string
let userData: string

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
  for (const k of ENV_KEYS) delete process.env[k]
  home = mkdtempSync(path.join(os.tmpdir(), 'nt-integrations-'))
  userData = path.join(home, 'userData')
  mkdirSync(userData, { recursive: true })
  process.env.HOME = home
  process.env.USERPROFILE = home
  initPlatform(fakePlatform({ userDataDir: userData }))
})
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  resetPlatformForTests()
  resetClaudeAccountsSourceForTests()
  rmSync(home, { recursive: true, force: true })
})

const SHIMS = () => ({
  canvas: path.join(userData, 'canvas-control', 'nodeterm.sh'),
  context: path.join(userData, 'context-links', 'context.sh')
})
const withAgents = (agents: Record<string, 'enabled' | 'declined'>, extra: Partial<Settings> = {}): Settings => ({
  ...DEFAULT_SETTINGS,
  ...extra,
  agentIntegrations: { agents, origin: 'asked' }
})
const read = (p: string) => readFileSync(p, 'utf8')
const put = (p: string, body: string) => {
  mkdirSync(path.dirname(p), { recursive: true })
  writeFileSync(p, body)
}
/** Every file under home, relative — minus our own userData. */
function filesUnder(root: string): string[] {
  const out: string[] = []
  const walk = (d: string) => {
    for (const n of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, n.name)
      if (p === userData) continue
      if (n.isDirectory()) walk(p)
      else out.push(path.relative(root, p))
    }
  }
  walk(root)
  return out.sort()
}

function lifecycle(settings: () => Settings, opts: { veto?: boolean; realHooks?: boolean } = {}) {
  const hookCalls: { install: string[][]; remove: string[][] } = { install: [], remove: [] }
  const lc = createIntegrationLifecycle({
    settings,
    userDataDir: () => userData,
    shims: SHIMS,
    veto: opts.veto,
    ...(opts.realHooks
      ? {}
      : {
          installHooks: (a) => void hookCalls.install.push([...a].sort()),
          removeHooks: (a) => void hookCalls.remove.push([...a].sort())
        })
  })
  return { lc, hookCalls }
}

describe('nothing global is written without consent', () => {
  it('a new install that has not answered writes NOTHING and removes nothing', () => {
    put(path.join(home, '.codex', 'AGENTS.md'), '# mine\n')
    const { lc, hookCalls } = lifecycle(() => DEFAULT_SETTINGS, { realHooks: true })
    lc.reconcile()
    expect(filesUnder(home)).toEqual(['.codex/AGENTS.md'])
    expect(read(path.join(home, '.codex', 'AGENTS.md'))).toBe('# mine\n')
    expect(hookCalls.install).toEqual([])
  })

  it('only the enabled agents get hooks — the undecided ones are left alone', () => {
    const { lc } = lifecycle(() => withAgents({ claude: 'enabled' }), { realHooks: true })
    lc.reconcile()
    expect(JSON.stringify(JSON.parse(read(path.join(home, '.claude', 'settings.json'))))).toContain('agent-hooks/claude.sh')
    expect(existsSync(path.join(home, '.gemini'))).toBe(false)
    expect(existsSync(path.join(home, '.codex'))).toBe(false)
    expect(existsSync(path.join(home, '.nodeterm', 'agent-hooks', 'claude.sh'))).toBe(true)
    expect(existsSync(path.join(home, '.nodeterm', 'agent-hooks', 'codex.sh'))).toBe(false)
  })

  it('the Server Edition veto (installHooks: false) outranks every choice', () => {
    const { lc, hookCalls } = lifecycle(() => withAgents({ claude: 'enabled', codex: 'enabled' }), { veto: true })
    expect(lc.reconcile().vetoed).toBe(true)
    expect(filesUnder(home)).toEqual([])
    expect(hookCalls.install).toEqual([])
  })
})

describe('discovery: every capable agent still finds canvas control and context link (no regression)', () => {
  it('each agent gets the skills in ITS OWN skills dir — and nothing in AGENTS.md / GEMINI.md', () => {
    process.env.GROK_HOME = path.join(home, 'grok-home')
    process.env.COPILOT_HOME = path.join(home, 'copilot-home')
    process.env.XDG_CONFIG_HOME = path.join(home, 'xdg')
    process.env.CODEX_HOME = path.join(home, 'codex-home')
    const all = { claude: 'enabled', codex: 'enabled', gemini: 'enabled', grok: 'enabled', copilot: 'enabled', opencode: 'enabled' } as const
    const { lc, hookCalls } = lifecycle(() => withAgents(all))
    lc.reconcile()
    const canvas = buildCanvasSkillBody(SHIMS().canvas)
    const context = buildContextLinkSkillBody(SHIMS().context)
    const dirs: Record<string, [boolean, boolean]> = {
      [path.join(home, '.claude', 'skills')]: [true, true],
      [path.join(home, 'codex-home', 'skills')]: [true, true],
      [path.join(home, '.gemini', 'skills')]: [true, true],
      [path.join(home, 'grok-home', 'skills')]: [true, true],
      [path.join(home, 'copilot-home', 'skills')]: [true, false], // copilot: canvas control only
      [path.join(home, 'xdg', 'opencode', 'skills')]: [true, true]
    }
    for (const [dir, [hasCanvas, hasContext]] of Object.entries(dirs)) {
      const c = path.join(dir, CANVAS_SKILL, 'SKILL.md')
      const x = path.join(dir, CONTEXT_SKILL, 'SKILL.md')
      expect(existsSync(c), c).toBe(hasCanvas)
      expect(existsSync(x), x).toBe(hasContext)
      if (hasCanvas) expect(read(c)).toBe(canvas)
      if (hasContext) expect(read(x)).toBe(context)
    }
    for (const f of ['.codex/AGENTS.md', '.gemini/GEMINI.md', 'codex-home/AGENTS.md', 'copilot-home/copilot-instructions.md', 'xdg/opencode/AGENTS.md']) {
      expect(existsSync(path.join(home, f)), f).toBe(false)
    }
    expect(hookCalls.install).toEqual([['claude', 'codex', 'copilot', 'gemini', 'grok', 'opencode']])
  })

  it('respects $CLAUDE_CONFIG_DIR — never a hardcoded ~/.claude', () => {
    process.env.CLAUDE_CONFIG_DIR = path.join(home, 'claude-elsewhere')
    const { lc } = lifecycle(() => withAgents({ claude: 'enabled' }), { realHooks: true })
    lc.reconcile()
    expect(existsSync(path.join(home, 'claude-elsewhere', 'skills', CANVAS_SKILL, 'SKILL.md'))).toBe(true)
    expect(read(path.join(home, 'claude-elsewhere', 'settings.json'))).toContain('agent-hooks/claude.sh')
    expect(existsSync(path.join(home, '.claude'))).toBe(false)
  })

  it('every local managed and linked Claude account gets BOTH skills and the hook', () => {
    const linked = path.join(home, '.claude-2')
    mkdirSync(linked, { recursive: true })
    const accounts = [
      { id: 'acc-1', label: 'a', createdAt: 0 },
      { id: 'linked', label: 'l', configDir: linked, createdAt: 0 },
      { id: 'remote', label: 'r', host: 'u@h', createdAt: 0 },
      { id: 'pending', label: 'p', pending: true, createdAt: 0 }
    ] as ClaudeAccount[]
    registerClaudeAccountsSource(() => accounts)
    const { lc } = lifecycle(() => withAgents({ claude: 'enabled' }, { claudeAccounts: accounts }), { realHooks: true })
    lc.reconcile()
    for (const dir of [accountConfigDir(userData, 'acc-1'), linked]) {
      expect(existsSync(path.join(dir, 'skills', CANVAS_SKILL, 'SKILL.md')), dir).toBe(true)
      expect(existsSync(path.join(dir, 'skills', CONTEXT_SKILL, 'SKILL.md')), dir).toBe(true)
      expect(read(path.join(dir, 'settings.json'))).toContain('agent-hooks/claude.sh')
    }
    expect(existsSync(accountConfigDir(userData, 'remote'))).toBe(false)
    expect(existsSync(accountConfigDir(userData, 'pending'))).toBe(false)
  })
})

describe('upgrade: the legacy instruction blocks go, the user text stays', () => {
  it("strips both blocks (the ~17 KB that crowded codex's AGENTS.md) and nothing else", () => {
    const user = '# my repo rules\n\nAlways run the tests.\n'
    const legacy =
      `${user}\n${frameCanvasControlBlock('X'.repeat(12_000))}\n\n${frameInstructionsBlock('Y'.repeat(5_000))}\n`
    put(path.join(home, '.codex', 'AGENTS.md'), legacy)
    put(path.join(home, '.gemini', 'GEMINI.md'), `${frameInstructionsBlock('Z')}\n`)
    const { lc } = lifecycle(() => withAgents({ codex: 'enabled', gemini: 'declined' }))
    lc.reconcile()
    expect(read(path.join(home, '.codex', 'AGENTS.md'))).toBe(user)
    // A file that held NOTHING but our block was ours: it goes, rather than staying behind empty.
    expect(existsSync(path.join(home, '.gemini', 'GEMINI.md'))).toBe(false)
  })

  it('an undecided agent\'s instruction file is not touched at all', () => {
    const legacy = `# mine\n\n${frameCanvasControlBlock('X')}\n`
    put(path.join(home, '.gemini', 'GEMINI.md'), legacy)
    const { lc } = lifecycle(() => withAgents({ codex: 'enabled' }))
    lc.reconcile()
    expect(read(path.join(home, '.gemini', 'GEMINI.md'))).toBe(legacy)
  })
})

describe('decline: remove exactly what we wrote', () => {
  it("removes our hook (keeping the user's own), our skills and our script; keeps a skill the user edited and reports it", () => {
    let settings = withAgents({ claude: 'enabled', codex: 'enabled' })
    const { lc } = lifecycle(() => settings, { realHooks: true })
    lc.reconcile()
    // The user adds their own hook beside ours and edits one of our skills.
    const settingsFile = path.join(home, '.claude', 'settings.json')
    const cfg = JSON.parse(read(settingsFile)) as { hooks: Record<string, { hooks: { type: string; command: string }[] }[]> }
    cfg.hooks.Stop.push({ hooks: [{ type: 'command', command: 'my-own-hook' }] })
    writeFileSync(settingsFile, JSON.stringify(cfg))
    const edited = path.join(home, '.claude', 'skills', CONTEXT_SKILL, 'SKILL.md')
    writeFileSync(edited, `${read(edited)}\nmy note\n`)

    settings = withAgents({ claude: 'declined', codex: 'enabled' })
    lc.onSettingsChanged(settings)
    const after = read(settingsFile)
    expect(after).not.toContain('agent-hooks/claude.sh')
    expect(after).toContain('my-own-hook')
    expect(existsSync(path.join(home, '.claude', 'skills', CANVAS_SKILL))).toBe(false)
    expect(existsSync(edited)).toBe(true)
    expect(lc.lastReport()?.retained).toEqual([edited])
    expect(existsSync(path.join(home, '.nodeterm', 'agent-hooks', 'claude.sh'))).toBe(false)
    // codex is still enabled: untouched.
    expect(existsSync(path.join(home, '.codex', 'skills', CANVAS_SKILL, 'SKILL.md'))).toBe(true)
  })

  it('never overwrites a skill the user edited while still enabled', () => {
    const { lc } = lifecycle(() => withAgents({ gemini: 'enabled' }))
    lc.reconcile()
    const f = path.join(home, '.gemini', 'skills', CANVAS_SKILL, 'SKILL.md')
    writeFileSync(f, 'my own version\n')
    lc.reconcile()
    expect(read(f)).toBe('my own version\n')
    expect(lc.lastReport()?.retained).toEqual([f])
  })

  it('the retained list is bounded', () => {
    const accounts = Array.from({ length: 30 }, (_, i) => ({ id: `acc-${i}`, label: 'x', createdAt: 0 })) as ClaudeAccount[]
    registerClaudeAccountsSource(() => accounts)
    let settings = withAgents({ claude: 'enabled' }, { claudeAccounts: accounts })
    const { lc } = lifecycle(() => settings)
    lc.reconcile()
    for (const a of accounts) {
      const f = path.join(accountConfigDir(userData, a.id), 'skills', CANVAS_SKILL, 'SKILL.md')
      writeFileSync(f, 'edited\n')
    }
    settings = withAgents({ claude: 'declined' }, { claudeAccounts: accounts })
    lc.onSettingsChanged(settings)
    expect(lc.lastReport()?.retained.length).toBe(MAX_RETAINED)
  })
})

describe('reconcile cadence', () => {
  it('re-runs only when the consent or the local account list changes', () => {
    let settings = withAgents({ codex: 'enabled' })
    const { lc, hookCalls } = lifecycle(() => settings)
    lc.reconcile()
    lc.onSettingsChanged({ ...settings, fontSize: 20 })
    expect(hookCalls.install).toHaveLength(1)
    settings = withAgents({ codex: 'enabled', gemini: 'enabled' })
    lc.onSettingsChanged(settings)
    expect(hookCalls.install).toHaveLength(2)
  })
})

describe('the existing-vs-new default', () => {
  it('an install whose own hook scripts are on disk is grandfathered as enabled — every agent and every host', () => {
    mkdirSync(path.join(home, '.nodeterm', 'agent-hooks'), { recursive: true })
    writeFileSync(path.join(home, '.nodeterm', 'agent-hooks', 'claude.sh'), '#!/bin/sh\n')
    const existing = detectExistingIntegrations(userData, home)
    expect(existing).toBe(true)
    const next = resolveIntegrationConsentAtBoot(DEFAULT_SETTINGS, existing)
    expect(next?.agentIntegrations?.origin).toBe('grandfathered')
    expect(next?.agentIntegrations?.agents?.codex).toBe('enabled')
    expect(next?.agentIntegrations?.hostDefault).toBe('enabled')
    expect(next?.agentIntegrations?.noticeDismissed).toBeUndefined()
  })

  it('a new install (nothing of ours on disk) is NOT grandfathered — it is asked', () => {
    expect(detectExistingIntegrations(userData, home)).toBe(false)
    expect(resolveIntegrationConsentAtBoot(DEFAULT_SETTINGS, false)).toBeNull()
  })

  it('an answered record is never rewritten at boot', () => {
    const answered = withAgents({ claude: 'declined' })
    expect(resolveIntegrationConsentAtBoot(answered, true)).toBeNull()
  })
})
