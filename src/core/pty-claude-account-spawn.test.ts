/**
 * Issue #345 — a managed CLAUDE account must not be mistaken for a Codex one.
 *
 * `needsCodexAccountScope` used to answer `agentId === 'codex' || !!accountId`. The two account
 * lists share an id alphabet, so that `!!accountId` proxy also matched every managed CLAUDE id:
 * the spawn entered the fail-closed Codex gate, looked for `~/.nodeterm/cx/<digest>` (a namespace a
 * Claude account never populates), found nothing and REFUSED. Every node bound to a managed Claude
 * account — agent node and `claude /login` terminal alike — returned `unavailable: 'codex-account'`
 * and spawned nothing.
 *
 * MUTATION: make the resolver in pty-manager's two call sites answer `() => true` (i.e. restore the
 * old "any account id is a Codex one" proxy) → the two Claude cases below redden on both the
 * refusal and the spawn count.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { execFileSync } from 'child_process'
import os from 'os'
import path from 'path'
import { initPlatform, resetPlatformForTests } from './platform'
import { fakePlatform, type FakePlatform } from './platform-fake'
import { IPC } from '../shared/ipc'
import { DEFAULT_SETTINGS } from '../shared/types'
import type { PtyCreateOptions, PtyCreateResult, Settings } from '../shared/types'
import { codexAccountHome } from './codex-accounts-core'
import { accountConfigDir } from './claude-accounts-core'

const spawned: Array<{ file: string; args: string[]; env: Record<string, string> }> = []

vi.mock('node-pty', () => ({
  spawn: (file: string, args: string[], options: { env: Record<string, string> }) => {
    spawned.push({ file, args, env: options?.env ?? {} })
    return {
      onData: () => {}, onExit: () => {}, write: () => {}, resize: () => {},
      pause: () => {}, resume: () => {}, kill: () => {}, pid: 4321
    }
  }
}))
vi.mock('./pty-devices', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./pty-devices')>()),
  readPtyDevices: () => ({ ceiling: 511, inUse: 8 })
}))

const ALICE = 1
const CODEX_ACCT = 'codexacct1'
const CLAUDE_ACCT = 'claudeacct1'

describe('a managed Claude account is not a Codex account (#345)', () => {
  let fake: FakePlatform
  let userDataDir: string

  beforeEach(async () => {
    spawned.length = 0
    userDataDir = mkdtempSync(path.join(os.tmpdir(), 'nodeterm-claude-acct-'))
    fake = fakePlatform({ userDataDir })
    initPlatform(fake)
    const { PtyManager } = await import('./pty-manager')
    // Only the CODEX account is in codexAccounts — the Claude id is deliberately absent, which is
    // exactly what tells the two apart.
    const settings: Settings = {
      ...DEFAULT_SETTINGS,
      codexAccounts: [{ id: CODEX_ACCT, label: 'work' }]
    }
    const mgr = new PtyManager()
    mgr.init(() => settings)
    mgr.registerIpc()
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    resetPlatformForTests()
    rmSync(userDataDir, { recursive: true, force: true })
  })

  const create = (options: Partial<PtyCreateOptions>) =>
    fake.handlers[IPC.ptyCreate](ALICE, {
      cols: 80, rows: 24, persistKey: 'node-1', cwd: '/srv/app', ...options
    }) as Promise<PtyCreateResult>

  it('a Claude AGENT node bound to a managed Claude account SPAWNS', async () => {
    // The Claude account's config dir exists — the Claude path falls back with a warning chip
    // when it does not, which would hide the refusal this test is about.
    mkdirSync(accountConfigDir(userDataDir, CLAUDE_ACCT), { recursive: true })
    const res = await create({ agentId: 'claude', accountId: CLAUDE_ACCT })
    expect(res.unavailable).toBeUndefined()
    expect(spawned).toHaveLength(1)
    // It is a Claude scope, not a Codex one.
    expect(spawned[0].env.CLAUDE_CONFIG_DIR).toContain(CLAUDE_ACCT)
    expect(spawned[0].env.CODEX_HOME).toBe(process.env.CODEX_HOME)
  })

  it('the agent-less `claude /login` terminal SPAWNS', async () => {
    const res = await create({ accountId: CLAUDE_ACCT, persistKey: 'node-2' })
    expect(res.unavailable).toBeUndefined()
    expect(spawned).toHaveLength(1)
    expect(spawned[0].env.CODEX_HOME).toBe(process.env.CODEX_HOME)
  })

  it('the agent-less `codex login` terminal STILL gets the managed Codex scope', async () => {
    mkdirSync(codexAccountHome(userDataDir, CODEX_ACCT), { recursive: true })
    const res = await create({ accountId: CODEX_ACCT, persistKey: 'node-3' })
    expect(res.unavailable).toBeUndefined()
    expect(spawned).toHaveLength(1)
    expect(spawned[0].env.CODEX_HOME).toBe(codexAccountHome(userDataDir, CODEX_ACCT))
    expect(spawned[0].env.NODETERM_CODEX_ACCOUNT_ID).toBe(CODEX_ACCT)
  })

  it('a Codex AGENT node still fails closed on a missing managed home', async () => {
    const res = await create({ agentId: 'codex', accountId: CODEX_ACCT, persistKey: 'node-4' })
    expect(res.unavailable).toBe('codex-account')
    expect(spawned).toHaveLength(0)
  })

  it('login writes only the managed credential and strips inherited API keys (#683)', async () => {
    const systemHome = path.join(userDataDir, 'system-codex')
    mkdirSync(systemHome)
    writeFileSync(path.join(systemHome, 'auth.json'), 'system-fixture-unchanged')
    vi.stubEnv('CODEX_HOME', systemHome)
    vi.stubEnv('OPENAI_API_KEY', 'fixture-openai-key')
    vi.stubEnv('CODEX_API_KEY', 'fixture-codex-key')
    const home = codexAccountHome(userDataDir, CODEX_ACCT)
    mkdirSync(home, { recursive: true })
    try {
      const res = await create({ accountId: CODEX_ACCT, persistKey: 'fixture-login' })
      expect(res.unavailable).toBeUndefined()
      const env = spawned[0].env
      expect(env.CODEX_HOME).toBe(home)
      expect(env.OPENAI_API_KEY).toBeUndefined()
      expect(env.CODEX_API_KEY).toBeUndefined()
      // A disposable fake CLI consumes the actual spawn environment. No Codex login/network.
      execFileSync(process.execPath, ['-e',
        "require('fs').writeFileSync(require('path').join(process.env.CODEX_HOME, 'auth.json'), 'managed-fixture')"
      ], { env })
      expect(readFileSync(path.join(home, 'auth.json'), 'utf8')).toBe('managed-fixture')
      expect(readFileSync(path.join(systemHome, 'auth.json'), 'utf8')).toBe('system-fixture-unchanged')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
