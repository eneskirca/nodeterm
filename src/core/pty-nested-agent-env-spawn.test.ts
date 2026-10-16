/**
 * A launcher's Claude Code session markers must not reach the panes nodeterm spawns
 * (`NESTED_AGENT_ENV_STRIP`). Started from a Claude Code terminal, the app inherits
 * CLAUDE_CODE_CHILD_SESSION and friends; every pane then believed it was a nested child session and
 * the Claude CLI there turned transcript saving off.
 *
 * Asserted on the environment node-pty is actually handed, not on the list: the list alone stays
 * green when the deletion in `buildPtyEnv` is removed.
 *
 * MUTATION: delete the `for (const k of NESTED_AGENT_ENV_STRIP) delete env[k]` line in
 * pty-manager.ts → the fresh-spawn case reddens. Drop `...NESTED_AGENT_ENV_STRIP` from
 * `ACCOUNT_SCOPE_UPDATE_ENV` → the tmux.conf case reddens.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'fs'
import os from 'os'
import path from 'path'
import { initPlatform, resetPlatformForTests } from './platform'
import { fakePlatform, type FakePlatform } from './platform-fake'
import { IPC } from '../shared/ipc'
import { DEFAULT_SETTINGS } from '../shared/types'
import type { PtyCreateOptions, PtyCreateResult, Settings } from '../shared/types'
import { accountConfigDir } from './claude-accounts-core'
import { NESTED_AGENT_ENV_STRIP } from './nested-agent-env'

const spawned: Array<{ file: string; args: string[]; env: Record<string, string> }> = []
/** Every tmux side-call and every spawn, in order — the long-lived-server case is about ORDER. */
const events: string[] = []

vi.mock('node-pty', () => ({
  spawn: (file: string, args: string[], options: { env: Record<string, string> }) => {
    spawned.push({ file, args, env: options?.env ?? {} })
    events.push(`spawn ${args.includes('new-session') ? 'new-session' : file}`)
    return {
      onData: () => {}, onExit: () => {}, write: () => {}, resize: () => {},
      pause: () => {}, resume: () => {}, kill: () => {}, pid: 4321
    }
  }
}))
// A tmux server that is ALREADY running, started by a build that predates the marker list: its
// `update-environment` array lacks every marker, and it does not reread the conf.
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>()
  type Cb = (err: Error | null, res?: { stdout: string; stderr: string }) => void
  return {
    ...actual,
    execFile: (_file: string, _args: string[], a?: unknown, b?: unknown): unknown => {
      const cb = (typeof a === 'function' ? a : b) as Cb | undefined
      cb?.(null, { stdout: '', stderr: '' })
      return {}
    },
    execFileSync: (_file: string, args: string[]): string => {
      if (args.includes('show-options')) return 'update-environment[0] DISPLAY\n'
      if (args.includes('set-option')) events.push(`set-option ${args[args.length - 1]}`)
      return ''
    }
  }
})
vi.mock('./pty-devices', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./pty-devices')>()),
  readPtyDevices: () => ({ ceiling: 511, inUse: 8 })
}))

const ALICE = 1
const CLAUDE_ACCT = 'claudeacct1'

describe('launcher session markers are stripped from spawned panes', () => {
  let fake: FakePlatform
  let userDataDir: string

  beforeEach(async () => {
    spawned.length = 0
    events.length = 0
    userDataDir = mkdtempSync(path.join(os.tmpdir(), 'nodeterm-nested-env-'))
    fake = fakePlatform({ userDataDir })
    initPlatform(fake)
    for (const name of NESTED_AGENT_ENV_STRIP) vi.stubEnv(name, `launcher-${name}`)
    vi.stubEnv('NODETERM_TEST_UNRELATED', 'kept')
    const { PtyManager } = await import('./pty-manager')
    // The plain in-process backend, on every platform: it runs the same `buildPtyEnv` as tmux and
    // the Windows session host, and is the one whose spawn env node-pty receives in this process.
    const settings: Settings = { ...DEFAULT_SETTINGS, tmuxEnabled: false }
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
      cols: 80, rows: 24, persistKey: 'node-1', cwd: os.tmpdir(), ...options
    }) as Promise<PtyCreateResult>

  it('a fresh pane gets none of them, and keeps the account selector and unrelated env', async () => {
    mkdirSync(accountConfigDir(userDataDir, CLAUDE_ACCT), { recursive: true })
    const res = await create({ agentId: 'claude', accountId: CLAUDE_ACCT })
    expect(res.unavailable).toBeUndefined()
    expect(spawned).toHaveLength(1)
    const env = spawned[0].env
    for (const name of NESTED_AGENT_ENV_STRIP) expect(env[name], name).toBeUndefined()
    // An explicit list, never a CLAUDE* sweep: the managed-account binding rides CLAUDE_CONFIG_DIR.
    expect(env.CLAUDE_CONFIG_DIR).toContain(CLAUDE_ACCT)
    expect(env.NODETERM_TEST_UNRELATED).toBe('kept')
  })

  it('the local tmux.conf lists them for update-environment, so a seeded server drops them too', async () => {
    const { tmuxConf } = await import('./pty-manager')
    const line = tmuxConf(10_000)
      .split('\n')
      .find((l) => /^\s*set .*update-environment/.test(l))
    expect(line).toBeDefined()
    for (const name of NESTED_AGENT_ENV_STRIP) expect(line, name).toContain(name)
  })

  it('retrofits an ALREADY-RUNNING tmux server before the session is created', async () => {
    // The conf above is read once, at server start. A server started earlier keeps its old
    // update-environment array, so the names are appended at runtime — and they must land BEFORE
    // new-session, or the session is created from the server's seeded environment.
    const { PtyManager } = await import('./pty-manager')
    const mgr = new PtyManager()
    ;(mgr as unknown as { tmuxPath: string | null }).tmuxPath = '/usr/bin/tmux'
    mgr.init(() => ({ ...DEFAULT_SETTINGS, tmuxEnabled: true }))
    mgr.registerIpc()
    const res = await create({ persistKey: 'node-tmux' })
    expect(res.unavailable).toBeUndefined()
    const created = events.indexOf('spawn new-session')
    expect(created).toBeGreaterThan(-1)
    for (const name of NESTED_AGENT_ENV_STRIP) {
      const appended = events.indexOf(`set-option ${name}`)
      expect(appended, name).toBeGreaterThan(-1)
      expect(appended, name).toBeLessThan(created)
    }
    // And the tmux client itself does not carry them: with update-environment listing a name the
    // client LACKS, tmux removes it from the new session (the #419 removal semantics).
    const client = spawned.find((s) => s.args.includes('new-session'))!
    for (const name of NESTED_AGENT_ENV_STRIP) expect(client.env[name], name).toBeUndefined()
  })
})
