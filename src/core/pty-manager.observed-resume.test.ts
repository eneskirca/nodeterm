import { beforeAll, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { prepareRemoteCodexLaunch, restoreRemoteCodexLaunch, type PreparedRemoteCodexLaunch } from './remote-ssh/codex-provider-observer'
import { CODEX_PROVIDER_OBSERVER_RUNTIME } from './remote-ssh/codex-provider-observer-runtime'
import type { NativeSshTransport } from './remote-ssh/native/existing-transport'
vi.mock('node-pty', () => ({ spawn: () => { throw new Error('no physical PTY in dispatch unit test') } }))
vi.mock('./session-host-backend', async () => (await import('./__fixtures__/no-session-host')).noSessionHost())
let PtyManager: typeof import('./pty-manager').PtyManager
beforeAll(async () => { ({ PtyManager } = await import('./pty-manager')) }, 60000)
async function fixture() {
  let valid = true, scope = true
  const writes: string[] = []
  const transport: NativeSshTransport = {
    identity: Object.freeze({ backend: 'native-ssh2', generation: 'fresh-generation', hostname: 'synthetic.invalid', user: 'synthetic', port: 22, serverKeySha256: 'b'.repeat(64) }),
    isCurrent: () => valid,
    exec: vi.fn(async (command, io) => {
      let stdout = ''
      if (command.endsWith(' prepare')) {
        const p = JSON.parse(String(io?.stdin))
        stdout = JSON.stringify({ launchId: p.launchId, directory: `${p.root}/${p.launchId}`, planSha256: 'a'.repeat(64),
          runtimeSha256: createHash('sha256').update(CODEX_PROVIDER_OBSERVER_RUNTIME).digest('hex') })
      } else { writes.push(command); stdout = '%7\n' }
      return { code: 0, signal: null, timedOut: false, stdout: Buffer.from(stdout), stderr: Buffer.alloc(0) }
    })
  }
  const prepared = await prepareRemoteCodexLaunch(transport, { context: { nodeId: 'n', projectId: 'p', agentId: 'codex', sessionId: 'thread' },
    accountId: 'system', root: '/synthetic/private', cwd: '/synthetic/project', codeHome: '/synthetic/home',
    upstreamSocket: '/synthetic/socket', providerExecutable: '/synthetic/codex', providerSha256: 'a'.repeat(64), daemonSha256: 'a'.repeat(64) })
  const mgr = new PtyManager({ runtimePlatform: 'linux' })
  mgr.setRemoteNodeOwner(() => ({ projectId: 'p', hostKey: 'synthetic' }))
  const access = { contextCurrent: () => scope, beforeWrite: vi.fn(async () => true) }
  return { mgr, prepared, transport, access, writes, scopeOff: () => { scope = false }, disconnect: () => { valid = false } }
}
it('the nominal main capability starts one fresh session and returns submitted, never provider success', async () => {
  const f = await fixture()
  const result = await f.mgr.executeObservedRemoteResume(f.prepared,f.transport,f.access)
  expect(result).toEqual({ ok: true, status: 'submitted' })
  expect(f.writes).toHaveLength(1)
  expect(f.writes[0]).toContain('new-session -d -P')
  expect(f.writes[0]).not.toMatch(/(?:new-session -A|respawn-pane|send-keys|paste-buffer|kill-)/)
  await f.mgr.executeObservedRemoteResume(f.prepared,f.transport,f.access)
  expect(f.writes).toHaveLength(1)
})
it('a lookalike object is not a prepared main capability', async () => {
  const f = await fixture()
  expect(await f.mgr.executeObservedRemoteResume({ ...f.prepared },f.transport,f.access)).toMatchObject({ ok: false, reason: 'not-permitted' })
  expect(f.writes).toEqual([])
})
it.each(['scope','transport','closure','owner'] as const)('%s refusal yields zero physical commands', async mode => {
  const f = await fixture()
  if (mode === 'scope') f.scopeOff()
  if (mode === 'transport') f.disconnect()
  if (mode === 'closure') f.access.beforeWrite.mockResolvedValue(false)
  if (mode === 'owner') f.mgr.setRemoteNodeOwner(() => ({ projectId: 'foreign', hostKey: 'synthetic' }))
  expect((await f.mgr.executeObservedRemoteResume(f.prepared,f.transport,f.access)).ok).toBe(false)
  expect(f.writes).toEqual([])
})
it('an existing live terminal, including a shell, is neither typed into nor replaced', async () => {
  const f = await fixture()
  vi.spyOn(f.mgr as unknown as { liveSessionForPersistKey(): unknown },'liveSessionForPersistKey').mockReturnValue({ shell: true })
  expect(await f.mgr.executeObservedRemoteResume(f.prepared,f.transport,f.access)).toMatchObject({ ok: false, reason: 'terminal-exists' })
  expect(f.writes).toEqual([]); expect(f.access.beforeWrite).not.toHaveBeenCalled()
})
it('a grant change while queued in the actual pane-write lock is checked inside the lock', async () => {
  const f = await fixture()
  const internal = f.mgr as unknown as { serializePaneWrite<T>(node: string, fn: () => Promise<T>): Promise<T> }
  let release!: () => void
  const barrier = new Promise<void>(r => { release = r })
  const previous = internal.serializePaneWrite('n',() => barrier)
  const resume = f.mgr.executeObservedRemoteResume(f.prepared,f.transport,f.access)
  f.scopeOff(); release(); await previous
  expect((await resume).ok).toBe(false); expect(f.writes).toEqual([])
})
it('a context change across the final asynchronous write closure is not submitted', async () => {
  const f = await fixture()
  f.access.beforeWrite.mockImplementationOnce(async () => { f.scopeOff(); return true })
  expect((await f.mgr.executeObservedRemoteResume(f.prepared,f.transport,f.access)).ok).toBe(false)
  expect(f.writes).toEqual([])
})
it('restored descriptors are read-only: restoration cannot replay a launch', async () => {
  const f = await fixture(), restored = restoreRemoteCodexLaunch(f.transport,f.prepared.descriptor)
  expect((await f.mgr.executeObservedRemoteResume(restored,f.transport,f.access)).ok).toBe(false)
  expect(f.writes).toEqual([])
})
it('a failed physical start is uncertain and the same capability never retries it', async () => {
  const f = await fixture()
  vi.mocked(f.transport.exec).mockResolvedValue({ code: 255, signal: null, timedOut: true, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) })
  expect((await f.mgr.executeObservedRemoteResume(f.prepared,f.transport,f.access)).ok).toBe(false)
  const count = vi.mocked(f.transport.exec).mock.calls.length
  await f.mgr.executeObservedRemoteResume(f.prepared,f.transport,f.access)
  expect(vi.mocked(f.transport.exec).mock.calls.length).toBe(count)
})
it('renderer creation is fenced during the observed start and later restricted to join-only', async () => {
  const f = await fixture()
  const internal = f.mgr as unknown as {
    create(client: number, options: { persistKey: string; agentId: string }): Promise<unknown>
    spawnNew(client: number, options: Record<string | symbol,unknown>): Promise<unknown>
  }
  const spawn = vi.spyOn(internal,'spawnNew').mockResolvedValue({ sessionId: 'joined',fresh:false })
  f.access.beforeWrite.mockImplementationOnce(async () => {
    expect(await internal.create(1,{ persistKey:'n',agentId:'codex' })).toMatchObject({ fresh:false,unavailable:'join-only' })
    return true
  })
  expect((await f.mgr.executeObservedRemoteResume(f.prepared,f.transport,f.access)).ok).toBe(true)
  await internal.create(1,{ persistKey:'n',agentId:'codex' })
  expect(spawn).toHaveBeenCalledTimes(1)
  expect(spawn.mock.calls[0][1].joinOnly).toBe(true)
  expect(Object.getOwnPropertySymbols(spawn.mock.calls[0][1])).toHaveLength(1)
})

it('pending or failed private restoration refuses remote creation without local fallback', async () => {
  const f = await fixture()
  const internal = f.mgr as unknown as {
    create(client: number, options: { persistKey: string; requireRemote?: boolean }): Promise<unknown>
    spawnNew(client: number, options: unknown): Promise<unknown>
  }
  const spawn = vi.spyOn(internal,'spawnNew').mockResolvedValue({ sessionId: 'synthetic',fresh: true })
  f.mgr.setObservedRemoteRestoreGuard(() => false)
  expect(await internal.create(1,{ persistKey: 'remote-node',requireRemote: true })).toMatchObject({ fresh: false,unavailable: 'join-only' })
  expect(spawn).not.toHaveBeenCalled()
  f.mgr.setObservedRemoteRestoreGuard(() => { throw new Error('unreadable private store') })
  expect(await internal.create(1,{ persistKey: 'remote-node',requireRemote: true })).toMatchObject({ unavailable: 'join-only' })
  expect(spawn).not.toHaveBeenCalled()
  f.mgr.setRemoteNodeOwner(() => null)
  f.mgr.setObservedRemoteRestoreGuard(() => false)
  await internal.create(1,{ persistKey: 'local-node' })
  expect(spawn).toHaveBeenCalledTimes(1)
})
