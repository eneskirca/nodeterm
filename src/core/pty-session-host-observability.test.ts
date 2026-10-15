// PtyManager's two session-host observability seams: `sessionHostListing()` (session memory,
// dev-server ports) and `sessionHostReaperBackend()` (the session reaper). The backend facade is
// mocked, as in pty-session-host.test.ts; the rules pinned are the manager's own.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IPC } from '../shared/ipc'
import { initPlatform, resetPlatformForTests } from './platform'
import { fakePlatform, type FakePlatform } from './platform-fake'
import type { SessionHostListing } from './session-host-client'

const backend = vi.hoisted(() => ({
  supported: vi.fn(() => true),
  create: vi.fn(),
  listDetailed: vi.fn(async (): Promise<unknown> => null),
  kill: vi.fn(async (_name: string, _options: { expectedGeneration?: string } = {}): Promise<void> => {})
}))

vi.mock('./session-host-backend', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./session-host-backend')>()),
  sessionHostSupported: backend.supported,
  createSessionHostPty: backend.create,
  sessionHostListSessionsDetailed: backend.listDetailed,
  sessionHostKillSession: backend.kill
}))

vi.mock('node-pty', () => ({
  spawn: vi.fn(() => {
    throw new Error('direct node-pty spawn must not run in the session-host suite')
  })
}))

vi.mock('./pty-devices', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./pty-devices')>()),
  readPtyDevices: () => ({ ceiling: 511, inUse: 8 })
}))

function fakeSessionHostPty() {
  return {
    ready: Promise.resolve({ fresh: true }),
    onSize: vi.fn(),
    onData: vi.fn(),
    onExit: vi.fn(),
    onAttachError: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    kill: vi.fn(),
    destroy: vi.fn()
  }
}

const row = (name: string, subscribers: number, generation: string) => ({
  name,
  pid: 100,
  subscribers,
  lastOutputMs: 3_600_000,
  createdMs: 0,
  generation
})

describe('PtyManager session-host observability', () => {
  let manager: import('./pty-manager').PtyManager | undefined
  let host: FakePlatform

  beforeEach(() => {
    host = fakePlatform()
    initPlatform(host)
    backend.supported.mockReset().mockReturnValue(true)
    backend.create.mockReset().mockImplementation(() => fakeSessionHostPty())
    backend.listDetailed.mockReset().mockResolvedValue(null)
    backend.kill.mockReset().mockResolvedValue(undefined)
  })

  afterEach(async () => {
    await manager?.killAll()
    manager = undefined
    resetPlatformForTests()
    vi.restoreAllMocks()
  })

  async function makeManager() {
    const { PtyManager } = await import('./pty-manager')
    manager = new PtyManager()
    return manager
  }

  it('both seams are undefined where the session host is not the backend', async () => {
    backend.supported.mockReturnValue(false)
    const m = await makeManager()
    expect(m.sessionHostListing()).toBeUndefined()
    expect(m.sessionHostReaperBackend()).toBeUndefined()
    expect(backend.listDetailed).not.toHaveBeenCalled()
  })

  it('the listing is the backend\'s detailed read', async () => {
    const listing: SessionHostListing = { running: true, names: ['nt-a'], sessions: [row('nt-a', 0, 'gen-aaaaaaaa')] }
    backend.listDetailed.mockResolvedValue(listing)
    const m = await makeManager()
    await expect(m.sessionHostListing()).resolves.toBe(listing)
  })

  it('reaper rows: subscribers are clients, the output clock is in seconds', async () => {
    backend.listDetailed.mockResolvedValue({
      running: true,
      names: ['nt-a', 'nt-b'],
      sessions: [row('nt-a', 0, 'gen-aaaaaaaa'), row('nt-b', 2, 'gen-bbbbbbbb')]
    })
    const m = await makeManager()
    expect(await m.sessionHostReaperBackend()?.list()).toEqual([
      { name: 'nt-a', clients: 0, activitySec: 3600, outputSec: 3600 },
      { name: 'nt-b', clients: 2, activitySec: 3600, outputSec: 3600 }
    ])
  })

  it('a failed read, or a host that cannot describe its sessions, yields no candidates (null)', async () => {
    const m = await makeManager()
    const reaper = m.sessionHostReaperBackend()
    expect(await reaper?.list()).toBeNull()
    backend.listDetailed.mockResolvedValue({ running: true, names: ['nt-a'], sessions: null })
    expect(await reaper?.list()).toBeNull()
    backend.listDetailed.mockResolvedValue({ running: false, names: [], sessions: [] })
    expect(await reaper?.list()).toEqual([])
  })

  it('a node this process has a live session for counts as watched, whatever the host says', async () => {
    backend.listDetailed.mockResolvedValue({
      running: true,
      names: ['nt-live'],
      sessions: [row('nt-live', 0, 'gen-llllllll')]
    })
    const m = await makeManager()
    m.registerIpc()
    await host.handlers[IPC.ptyCreate](7, { cols: 80, rows: 24, persistKey: 'live' })
    expect((await m.sessionHostReaperBackend()?.list())?.[0].clients).toBe(1)
  })

  it('the kill targets the generation the latest listing observed, and only a listed name', async () => {
    backend.listDetailed.mockResolvedValue({
      running: true,
      names: ['nt-a'],
      sessions: [row('nt-a', 0, 'gen-aaaaaaaa')]
    })
    const m = await makeManager()
    const reaper = m.sessionHostReaperBackend()
    expect(await reaper?.kill('nt-a')).toBe(false) // never listed yet: no generation, no kill
    expect(backend.kill).not.toHaveBeenCalled()
    await reaper?.list()
    expect(await reaper?.kill('nt-a')).toBe(true)
    expect(backend.kill).toHaveBeenCalledWith('nt-a', { expectedGeneration: 'gen-aaaaaaaa' })
    backend.kill.mockRejectedValueOnce(new Error('unconfirmed'))
    await expect(reaper?.kill('nt-a')).rejects.toThrow('unconfirmed')
  })

  it('a node opened AFTER the listing is spared at kill time, not killed off the stale plan', async () => {
    backend.listDetailed.mockResolvedValue({
      running: true,
      names: ['nt-late'],
      sessions: [row('nt-late', 0, 'gen-llllllll')]
    })
    const m = await makeManager()
    m.registerIpc()
    const reaper = m.sessionHostReaperBackend()
    expect((await reaper?.list())?.[0].clients).toBe(0)
    await host.handlers[IPC.ptyCreate](7, { cols: 80, rows: 24, persistKey: 'late' })
    expect(await reaper?.kill('nt-late')).toBe(false)
    expect(backend.kill).not.toHaveBeenCalled()
  })

  it('watched-ness maps node ids through sessionName(), so a sanitized id is still recognised', async () => {
    // `sessionName('a.b')` is `nt-a_b`: slicing the prefix back off would ask about node `a_b`.
    backend.listDetailed.mockResolvedValue({
      running: true,
      names: ['nt-a_b'],
      sessions: [row('nt-a_b', 0, 'gen-dddddddd')]
    })
    const m = await makeManager()
    m.registerIpc()
    await host.handlers[IPC.ptyCreate](7, { cols: 80, rows: 24, persistKey: 'a.b' })
    expect((await m.sessionHostReaperBackend()?.list())?.[0].clients).toBe(1)
  })
})
