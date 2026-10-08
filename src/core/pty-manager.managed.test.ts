import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fakePlatform } from './platform-fake'
import { initPlatform, resetPlatformForTests } from './platform'
import { DEFAULT_SETTINGS, type PtyCreateOptions } from '../shared/types'
import { paneOwnerProject, resetPaneOwnershipForTests } from './agents/pane-ownership'
import type { ManagedPaneReceipt } from '../shared/managed-terminal'

const receipt: ManagedPaneReceipt = {
  version: 1, creationId: '1e8dd6ac-050b-4e63-a331-9f6e9df8b7fb', nodeId: 'term-test-1234', projectId: 'local-project',
  socket: 'node-terminal', session: 'nt-term-test-1234', paneId: '%42', panePid: 1234,
  paneBirth: 'linux:12345678-1234-1234-1234-123456789012:123', sessionCreated: '1770000000'
}

const native = vi.hoisted(() => ({ spawn: vi.fn((_file: string, _args: string[], _options: unknown) => ({ pid: 4321, onData() {}, onExit() {}, write() {}, resize() {}, kill() {}, pause() {}, resume() {} })) }))
vi.mock('node-pty', () => native)
vi.mock('./exec-path', async (original) => ({
  ...(await original<typeof import('./exec-path')>()), shellPathNow: () => '/usr/bin:/bin', resolveShellPath: async () => '/usr/bin:/bin'
}))
vi.mock('./codex-accounts-core', async (original) => ({
  ...(await original<typeof import('./codex-accounts-core')>()),
  resolveCodexSessionScope: () => ({ CODEX_HOME: '/fixture-managed-codex', NODETERM_CODEX_ACCOUNT_ID: 'personal' }),
  codexSessionEnv: () => ({ CODEX_HOME: '/fixture-managed-codex', NODETERM_CODEX_ACCOUNT_ID: 'personal' })
}))

let root: string
async function manager() {
  const { PtyManager } = await import('./pty-manager')
  const m = new PtyManager() as any
  m.tmuxPath = '/usr/bin/tmux'
  m.confPath = '/dev/null'
  m.getSettings = () => ({ ...DEFAULT_SETTINGS, tmuxEnabled: true })
  m.ensureSnapshotTimer = vi.fn()
  m.ensureReapTimer = vi.fn()
  return m
}
function options(): PtyCreateOptions { return { persistKey: receipt.nodeId, ownerProjectId: receipt.projectId, cwd: root, cols: 80, rows: 24 } }

// Managed V1 requires a real POSIX tmux pane and kernel process birth. Windows keeps the
// existing session-host New path; never fabricate a tmux receipt for that backend.
describe.skipIf(process.platform !== 'linux' && process.platform !== 'darwin')('PtyManager managed creation runtime ownership', () => {
  beforeEach(() => {
    native.spawn.mockClear(); resetPaneOwnershipForTests()
    const platform = fakePlatform(); root = platform.userDataDir; initPlatform(platform)
  })
  afterEach(() => { resetPlatformForTests(); fs.rmSync(root, { recursive: true, force: true }) })
  it('passes create-only flags through normal local spawn and marks the session environment', async () => {
    const m = await manager()
    m.spawnSession(options(), 0, undefined, undefined, null, receipt.creationId)
    expect(native.spawn).toHaveBeenCalledOnce()
    const args = native.spawn.mock.calls[0][1] as string[]
    expect(args).toContain('new-session')
    expect(args).toContain('NODETERM_MANAGED_CREATION_ID=' + receipt.creationId)
    expect(args).not.toContain('-A')
    expect(args).not.toContain('-D')
    expect(args).toContain(root)
    expect(paneOwnerProject(receipt.nodeId)).toBeUndefined()
  })
  it('records ownership only after the exact creation receipt and runtime generation are confirmed', async () => {
    const m = await manager(); const session = { nodeId: receipt.nodeId }
    m.spawnNew = vi.fn(async (_client, _opts, exclusive) => {
      expect(exclusive.creationId).toBe(receipt.creationId)
      expect(exclusive.current()).toBe(true)
      m.sessions.set('fresh', session); m.byPersistKey.set(receipt.nodeId, 'fresh')
      return { sessionId: 'fresh', fresh: true, persistent: true }
    })
    m.readManagedPane = vi.fn(async () => receipt)
    expect(await m.createManagedHeadless(options(), receipt.creationId, () => true)).toEqual(receipt)
    expect(paneOwnerProject(receipt.nodeId)).toBe(receipt.projectId)
    expect(await m.verifyManagedPane({ ...receipt, paneBirth: 'other' }, () => true)).toBe(false)
    m.sessions.set('fresh', { nodeId: receipt.nodeId })
    expect(await m.verifyManagedPane(receipt, () => true)).toBe(false)
  })
  it('normal cold spawn with an exclusive request stays unproven until receipt readiness', async () => {
    const m = await manager()
    m.tmuxSessionExists = async () => false
    m.projectSpawnOverrides = async () => null
    const result = await m.spawnNew(0, options(), { creationId: receipt.creationId, current: () => true })
    expect(result.fresh).toBe(true)
    expect(result.persistent).toBe(true)
    expect(paneOwnerProject(receipt.nodeId)).toBeUndefined()
    expect(native.spawn.mock.calls[0][1]).not.toContain('-A')
  })
  it('a warm backend probe and a stopped service before synchronous spawn both refuse without a PTY', async () => {
    const m = await manager(); m.tmuxSessionExists = async () => true
    await expect(m.spawnNew(0, options(), { creationId: receipt.creationId, current: () => true })).rejects.toThrow(/exists/)
    expect(native.spawn).not.toHaveBeenCalled()
    let current = true
    m.tmuxSessionExists = async () => false
    m.projectSpawnOverrides = async () => { current = false; return null }
    await expect(m.spawnNew(0, options(), { creationId: receipt.creationId, current: () => current })).rejects.toThrow(/current/)
    expect(native.spawn).not.toHaveBeenCalled()
    expect(paneOwnerProject(receipt.nodeId)).toBeUndefined()
  })
  it('refuses a folder removed or replaced during preparation instead of opening Home', async () => {
    for (const replace of [false, true]) {
      const m = await manager(); const cwd = path.join(root, 'project-' + replace)
      fs.mkdirSync(cwd); m.tmuxSessionExists = async () => false
      m.projectSpawnOverrides = async () => {
        fs.renameSync(cwd, cwd + '-original')
        if (replace) fs.mkdirSync(cwd)
        return null
      }
      await expect(m.createManagedHeadless({ ...options(), cwd }, receipt.creationId, () => true)).rejects.toThrow(/folder changed/)
      expect(native.spawn).not.toHaveBeenCalled()
      expect(paneOwnerProject(receipt.nodeId)).toBeUndefined()
    }
  })
  it('refuses an account removed or made pending during preparation even if its old directory remains', async () => {
    const accountDir = path.join(root, 'claude-accounts', 'personal'); fs.mkdirSync(accountDir, { recursive: true })
    for (const pending of [false, true]) {
      const m = await manager(); m.tmuxSessionExists = async () => false
      let accounts: any[] = [{ id: 'personal', label: 'Personal' }]
      m.getSettings = () => ({ ...DEFAULT_SETTINGS, tmuxEnabled: true, claudeAccounts: accounts })
      m.projectSpawnOverrides = async () => { accounts = pending ? [{ ...accounts[0], pending: true }] : []; return null }
      await expect(m.createManagedHeadless({ ...options(), agentId: 'claude', accountId: 'personal' }, receipt.creationId, () => true)).rejects.toThrow(/account.*available/)
      expect(native.spawn).not.toHaveBeenCalled()
    }
  })
  it('keeps the ordinary stale-folder fallback for historical renderer attaches', async () => {
    const m = await manager()
    m.spawnSession({ ...options(), cwd: path.join(root, 'missing') }, 0, undefined, undefined, null)
    expect(native.spawn).toHaveBeenCalledOnce()
    expect(native.spawn.mock.calls[0][1]).toContain((await import('node:os')).homedir())
  })
  it('scopes managed Codex through its own account without demanding a Claude directory', async () => {
    const m = await manager()
    m.getSettings = () => ({ ...DEFAULT_SETTINGS, tmuxEnabled: true, codexAccounts: [{ id: 'personal', label: 'Personal' }] })
    let id: string | undefined
    expect(() => { id = m.spawnSession({ ...options(), agentId: 'codex', accountId: 'personal' }, 0, undefined, undefined, null, receipt.creationId) }).not.toThrow()
    expect(native.spawn).toHaveBeenCalledOnce()
    expect(m.sessions.get(id).accountFallback).toBe(false)
    const env = (native.spawn.mock.calls[0][2] as { env: Record<string, string> }).env
    expect(env.CODEX_HOME).toBe('/fixture-managed-codex')
    expect(env.CLAUDE_CONFIG_DIR).toBeUndefined()
  })
  it('refuses occupied names without spawning or acquiring ownership', async () => {
    const m = await manager(); m.spawnNew = vi.fn()
    m.sessions.set('warm', { nodeId: receipt.nodeId }); m.byPersistKey.set(receipt.nodeId, 'warm')
    await expect(m.createManagedHeadless(options(), receipt.creationId, () => true)).rejects.toThrow()
    expect(m.spawnNew).not.toHaveBeenCalled()
    expect(paneOwnerProject(receipt.nodeId)).toBeUndefined()
  })
  it('a generation replaced during proof is left alone, never cleaned up by a reused id', async () => {
    const m = await manager(); const session = { nodeId: receipt.nodeId }
    m.spawnNew = vi.fn(async () => { m.sessions.set('fresh', session); m.byPersistKey.set(receipt.nodeId, 'fresh'); return { sessionId: 'fresh', fresh: true, persistent: true } })
    m.readManagedPane = vi.fn(async () => { m.sessions.set('fresh', { nodeId: receipt.nodeId }); return receipt })
    m.kill = vi.fn(); m.destroySession = vi.fn()
    await expect(m.createManagedHeadless(options(), receipt.creationId, () => true)).rejects.toThrow(/confirmed/)
    expect(m.kill).not.toHaveBeenCalled()
    expect(m.destroySession).not.toHaveBeenCalled()
    expect(paneOwnerProject(receipt.nodeId)).toBeUndefined()
  })
  it('consumes a launch permit before proof so a changed/uncertain generation is never retried', async () => {
    const m = await manager(); const session = { nodeId: receipt.nodeId }
    m.sessions.set('fresh', session); m.byPersistKey.set(receipt.nodeId, 'fresh')
    m.managedPanes.set(receipt.creationId, { receipt, sessionId: 'fresh', session, attempted: false })
    m.paneOwner = vi.fn(async () => ({ paneId: receipt.paneId, panePid: receipt.panePid, pids: [receipt.panePid], command: 'bash' }))
    m.readManagedPane = vi.fn(async () => ({ ...receipt, paneBirth: 'replacement' }))
    expect(await m.deliverManagedLaunch(receipt, 'claude', () => true)).toBe(false)
    expect(await m.deliverManagedLaunch(receipt, 'claude', () => true)).toBe(false)
    expect(m.readManagedPane).toHaveBeenCalledOnce()
    expect(m.paneOwner).toHaveBeenCalledOnce()
  })
  it('retires proof with its exact runtime generation and releases the retained session object', async () => {
    const m = await manager(); const session = { nodeId: receipt.nodeId, indexKey: receipt.nodeId }
    m.sessions.set('fresh', session); m.byPersistKey.set(receipt.nodeId, 'fresh')
    m.managedPanes.set(receipt.creationId, { receipt, sessionId: 'fresh', session, attempted: true })
    m.forget('fresh', session)
    expect(m.managedPanes.size).toBe(0)
    expect(await m.verifyManagedPane(receipt, () => true)).toBe(false)
  })
  it('drops all managed launch proof at manager shutdown', async () => {
    const m = await manager()
    m.managedPanes.set(receipt.creationId, { receipt, sessionId: 'fresh', session: {}, attempted: false })
    await m.killAll()
    expect(m.managedPanes.size).toBe(0)
    expect(await m.deliverManagedLaunch(receipt, 'claude', () => true)).toBe(false)
  })
  it('rechecks the service fence and runtime after final proof, before typing', async () => {
    const m = await manager(); const session = { nodeId: receipt.nodeId }; let current = true
    m.sessions.set('fresh', session); m.byPersistKey.set(receipt.nodeId, 'fresh')
    m.managedPanes.set(receipt.creationId, { receipt, sessionId: 'fresh', session, attempted: false })
    m.paneOwner = vi.fn(async () => ({ paneId: receipt.paneId, panePid: receipt.panePid, pids: [receipt.panePid], command: 'bash' }))
    m.readManagedPane = vi.fn(async () => { current = false; return receipt })
    m.managedLaunchRun = vi.fn(async () => ({ stdout: 'nt-managed-delivered' }))
    expect(await m.deliverManagedLaunch(receipt, 'claude', () => current)).toBe(false)
    expect(m.managedLaunchRun).not.toHaveBeenCalled()
  })
  it('submits once only after shell and final birth proof, with the command on stdin', async () => {
    const m = await manager(); const session = { nodeId: receipt.nodeId }
    m.sessions.set('fresh', session); m.byPersistKey.set(receipt.nodeId, 'fresh')
    m.managedPanes.set(receipt.creationId, { receipt, sessionId: 'fresh', session, attempted: false })
    m.paneOwner = vi.fn(async () => ({ paneId: receipt.paneId, panePid: receipt.panePid, pids: [receipt.panePid], command: 'bash' }))
    m.readManagedPane = vi.fn(async () => receipt)
    m.managedLaunchRun = vi.fn(async () => ({ stdout: 'nt-managed-delivered' }))
    expect(await m.deliverManagedLaunch(receipt, 'claude', () => true)).toBe(true)
    expect(await m.deliverManagedLaunch(receipt, 'claude', () => true)).toBe(false)
    expect(m.managedLaunchRun).toHaveBeenCalledOnce()
    const [file, args, body] = m.managedLaunchRun.mock.calls[0]
    expect(file).toBe('/usr/bin/tmux'); expect(args.join(' ')).not.toContain('claude'); expect(body).toBe('claude')
  })
})
