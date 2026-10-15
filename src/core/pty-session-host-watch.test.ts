// Live links on a SESSION-HOST node (Windows, or no tmux): a join-only create — a live link watcher or
// a hosted-relay viewer — joins a generation the host CONFIRMED through a read-only `watch-attach`
// attachment, and is refused for every other answer; the keyframe and the pane cwd come from the
// host's own negotiated reads. Harness mirrors pty-session-host.test.ts: no local tmux, so the
// session host is the selected backend, and every backend export this file reaches is mocked.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IPC } from '../shared/ipc'
import { initPlatform, resetPlatformForTests } from './platform'
import { fakePlatform, type FakePlatform } from './platform-fake'
import { sessionName } from './tmux-naming'
import type { PtyCreateResult } from '../shared/types'

const backend = vi.hoisted(() => ({
  supported: vi.fn(() => true),
  create: vi.fn(),
  attachExisting: vi.fn(),
  watch: vi.fn(),
  hasSession: vi.fn(async (_name: string): Promise<boolean> => true),
  supportsWatch: vi.fn(async (): Promise<boolean> => true),
  captureVisible: vi.fn(
    async (
      _name: string
    ): Promise<{ screen: string; cursor: { x: number; y: number } | null; altScreen: boolean } | null> =>
      null
  ),
  paneCwd: vi.fn(async (_name: string): Promise<string | null> => null),
  capture: vi.fn(async () => 'HISTORY'),
  kill: vi.fn(async () => {}),
  list: vi.fn(async () => []),
  paneCommand: vi.fn(async () => null),
  sendKeys: vi.fn(async () => false)
}))

vi.mock('./session-host-backend', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./session-host-backend')>()),
  sessionHostSupported: backend.supported,
  createSessionHostPty: backend.create,
  attachExistingSessionHostPty: backend.attachExisting,
  watchExistingSessionHostPty: backend.watch,
  sessionHostHasSession: backend.hasSession,
  sessionHostSupportsWatch: backend.supportsWatch,
  sessionHostWatchKnown: () => undefined,
  sessionHostCaptureVisible: backend.captureVisible,
  sessionHostPaneCwd: backend.paneCwd,
  sessionHostCapture: backend.capture,
  sessionHostKillSession: backend.kill,
  sessionHostListSessions: backend.list,
  sessionHostPaneCommand: backend.paneCommand,
  sessionHostSendKeys: backend.sendKeys
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

function fakeSessionHostPty(ready: Promise<unknown> = Promise.resolve({ fresh: false })) {
  let sizeCb: ((size: { cols: number; rows: number }) => void) | undefined
  return {
    ready,
    onSize: vi.fn((cb: (size: { cols: number; rows: number }) => void) => {
      sizeCb = cb
    }),
    emitSize: (cols: number, rows: number) => sizeCb?.({ cols, rows }),
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

const NODE = 'node-w'
const VIEWER = 9
const OWNER = 7

describe('PtyManager: join-only creates on the session host', () => {
  let manager: import('./pty-manager').PtyManager | undefined
  let host: FakePlatform

  beforeEach(() => {
    host = fakePlatform()
    initPlatform(host)
    backend.supported.mockReturnValue(true)
    backend.create.mockReset().mockImplementation(() => fakeSessionHostPty(Promise.resolve({ fresh: true })))
    backend.attachExisting.mockReset().mockImplementation(() => fakeSessionHostPty())
    backend.watch.mockReset().mockImplementation(() => fakeSessionHostPty())
    backend.hasSession.mockReset().mockResolvedValue(true)
    backend.supportsWatch.mockReset().mockResolvedValue(true)
    backend.captureVisible.mockReset().mockResolvedValue(null)
    backend.paneCwd.mockReset().mockResolvedValue(null)
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
    manager.registerIpc()
    return manager
  }

  /** The option shape the relay access policy forwards for a viewer (`viewerCreateOptions`). */
  function viewerCreate(): Promise<PtyCreateResult> {
    return host.handlers[IPC.ptyCreate](VIEWER, {
      persistKey: NODE,
      cols: 50,
      rows: 20,
      joinOnly: true,
      sizeVote: false
    }) as Promise<PtyCreateResult>
  }

  it('joins a confirmed generation read-only: no spawn plan, no size claim', async () => {
    const shim = fakeSessionHostPty()
    backend.watch.mockReturnValue(shim)
    await makeManager()
    const res = await viewerCreate()
    expect(res.unavailable).toBeUndefined()
    expect(res.sessionId).toBeTruthy()
    expect(res.fresh).toBe(false)
    expect(backend.hasSession).toHaveBeenCalledWith(sessionName(NODE))
    expect(backend.watch).toHaveBeenCalledWith(sessionName(NODE))
    expect(backend.create).not.toHaveBeenCalled()
    expect(backend.attachExisting).not.toHaveBeenCalled()
    expect(shim.resize).not.toHaveBeenCalled()
  })

  it.each([
    ['the session is absent', () => backend.hasSession.mockResolvedValue(false)],
    ['the existence probe failed', () => backend.hasSession.mockRejectedValue(new Error('EPIPE'))],
    ['the host predates watch-attach', () => backend.supportsWatch.mockResolvedValue(false)]
  ])('refuses join-only when %s, and spawns nothing', async (_label, arrange) => {
    arrange()
    await makeManager()
    await expect(viewerCreate()).resolves.toMatchObject({ sessionId: '', unavailable: 'join-only' })
    expect(backend.watch).not.toHaveBeenCalled()
    expect(backend.create).not.toHaveBeenCalled()
    expect(backend.attachExisting).not.toHaveBeenCalled()
  })

  it('a live link watcher (joinAsWatcher) takes the same route and has no typing path', async () => {
    const m = await makeManager()
    const res = await m.joinAsWatcher(VIEWER, { persistKey: NODE, viewerId: 'link-a' })
    expect(res.unavailable).toBeUndefined()
    expect(backend.watch).toHaveBeenCalledTimes(1)
    expect(m.watcherInputRoute(res.sessionId)).toBe('none')
    // A session-host watch has no tmux window to read; the host pushes its size itself.
    await expect(m.syncWatcherClientSize(res.sessionId)).resolves.toBe(true)
  })

  it('an owner opening the node afterwards gets its OWN attachment, never the viewer one', async () => {
    await makeManager()
    const viewer = await viewerCreate()
    const owner = (await host.handlers[IPC.ptyCreate](OWNER, {
      persistKey: NODE,
      cols: 100,
      rows: 30
    })) as PtyCreateResult
    expect(owner.sessionId).toBeTruthy()
    expect(owner.sessionId).not.toBe(viewer.sessionId)
    expect(backend.create).toHaveBeenCalledTimes(1)
  })

  it('an owner create is untouched: no existence probe, no watch route', async () => {
    await makeManager()
    await host.handlers[IPC.ptyCreate](OWNER, { persistKey: NODE, cols: 100, rows: 30 })
    expect(backend.watch).not.toHaveBeenCalled()
    expect(backend.supportsWatch).not.toHaveBeenCalled()
    expect(backend.create).toHaveBeenCalledTimes(1)
  })
})

describe('PtyManager: session-host keyframe and pane cwd', () => {
  let manager: import('./pty-manager').PtyManager | undefined
  let host: FakePlatform

  beforeEach(() => {
    host = fakePlatform()
    initPlatform(host)
    backend.supported.mockReturnValue(true)
    backend.create.mockReset().mockImplementation(() => fakeSessionHostPty(Promise.resolve({ fresh: true })))
    backend.captureVisible.mockReset().mockResolvedValue(null)
    backend.paneCwd.mockReset().mockResolvedValue(null)
    backend.capture.mockClear()
  })

  afterEach(async () => {
    await manager?.killAll()
    manager = undefined
    resetPlatformForTests()
    vi.restoreAllMocks()
  })

  async function owned(): Promise<{ m: import('./pty-manager').PtyManager; sessionId: string }> {
    const { PtyManager } = await import('./pty-manager')
    manager = new PtyManager()
    manager.registerIpc()
    const res = (await host.handlers[IPC.ptyCreate](OWNER, {
      persistKey: NODE,
      cols: 80,
      rows: 24
    })) as PtyCreateResult
    return { m: manager, sessionId: res.sessionId }
  }

  it("returns the host's visible capture, with the emulator's own buffer as altScreen", async () => {
    backend.captureVisible.mockResolvedValue({ screen: 'a\nb\n', cursor: { x: 1, y: 1 }, altScreen: true })
    const { m, sessionId } = await owned()
    await expect(m.captureVisible(sessionId)).resolves.toEqual({
      screen: 'a\nb\n',
      cursor: { x: 1, y: 1 },
      altScreen: true
    })
    expect(backend.captureVisible).toHaveBeenCalledWith(sessionName(NODE))
  })

  it('maps no capture (older host, gone session) to unavailable — never the scrollback capture', async () => {
    const { m, sessionId } = await owned()
    await expect(m.captureVisible(sessionId)).resolves.toMatchObject({ unavailable: true })
    backend.captureVisible.mockRejectedValue(new Error('boom'))
    await expect(m.captureVisible(sessionId)).resolves.toMatchObject({ unavailable: true })
    expect(backend.capture).not.toHaveBeenCalled()
  })

  it('routes paneCwd to the host for a session-host node, live or not', async () => {
    backend.paneCwd.mockResolvedValue('C:\\work')
    const { m } = await owned()
    await expect(m.paneCwd(NODE)).resolves.toBe('C:\\work')
    expect(backend.paneCwd).toHaveBeenCalledWith(sessionName(NODE))
    // A node this process never attached: the session host is still this machine's backend.
    await expect(m.paneCwd('node-other')).resolves.toBe('C:\\work')
    backend.paneCwd.mockRejectedValue(new Error('gone'))
    await expect(m.paneCwd(NODE)).resolves.toBeNull()
  })
})
