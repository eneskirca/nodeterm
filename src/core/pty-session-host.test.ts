import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IPC } from '../shared/ipc'
import { initPlatform, resetPlatformForTests } from './platform'
import { fakePlatform, type FakePlatform } from './platform-fake'
import { hookServer } from './agents/hook-server'
import { paneOwnerProject, resetPaneOwnershipForTests } from './agents/pane-ownership'

const backend = vi.hoisted(() => ({
  supported: vi.fn(() => true),
  create: vi.fn(),
  attachExisting: vi.fn(),
  capture: vi.fn(async () => ''),
  hasSession: vi.fn(async () => false),
  // Mirrors `sessionHostKillSession(name, options)`. The parameters are load-bearing even though
  // this default body ignores them: several tests assert on the options the caller passed, and a
  // zero-arg mock infers `() => Promise<void>`, which makes every one of those
  // `mockImplementationOnce((name, options) => …)` a type error.
  kill: vi.fn(
    async (
      _name: string,
      _options: {
        reserveReplacement?: boolean
        requireV2?: boolean
        expectedAbsent?: boolean
      } = {}
    ): Promise<void> => {}
  ),
  list: vi.fn(async () => []),
  paneCommand: vi.fn(async () => null),
  sendKeys: vi.fn(async () => false)
}))

vi.mock('./session-host-backend', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./session-host-backend')>()),
  sessionHostSupported: backend.supported,
  createSessionHostPty: backend.create,
  attachExistingSessionHostPty: backend.attachExisting,
  sessionHostCapture: backend.capture,
  sessionHostHasSession: backend.hasSession,
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

function fakeSessionHostPty(ready = Promise.resolve({ fresh: true })) {
  let dataCb: ((data: string) => void) | undefined
  let exitCb: ((e: { exitCode: number }) => void) | undefined
  let attachErrorCb: ((error: Error) => void) | undefined
  return {
    ready,
    onData: vi.fn((cb: (data: string) => void) => {
      dataCb = cb
    }),
    onExit: vi.fn((cb: (e: { exitCode: number }) => void) => {
      exitCb = cb
    }),
    onAttachError: vi.fn((cb: (error: Error) => void) => {
      attachErrorCb = cb
    }),
    emitData: (data: string) => dataCb?.(data),
    emitExit: (exitCode: number) => exitCb?.({ exitCode }),
    emitAttachError: (error: Error) => attachErrorCb?.(error),
    write: vi.fn(),
    resize: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    kill: vi.fn(),
    destroy: vi.fn()
  }
}

describe('PtyManager session-host contracts', () => {
  let manager: import('./pty-manager').PtyManager | undefined
  let host: FakePlatform

  beforeEach(() => {
    resetPaneOwnershipForTests()
    hookServer.clearNodeAuthSecretForTests()
    host = fakePlatform()
    initPlatform(host)
    backend.supported.mockReturnValue(true)
    backend.create.mockReset().mockImplementation(() => fakeSessionHostPty())
    backend.attachExisting
      .mockReset()
      .mockImplementation(() => fakeSessionHostPty(Promise.resolve({ fresh: false })))
    backend.capture.mockReset().mockResolvedValue('')
    backend.hasSession.mockReset().mockResolvedValue(false)
    backend.kill.mockReset().mockResolvedValue(undefined)
  })

  afterEach(async () => {
    await manager?.killAll()
    manager = undefined
    resetPaneOwnershipForTests()
    hookServer.clearNodeAuthSecretForTests()
    resetPlatformForTests()
    vi.restoreAllMocks()
  })

  async function makeManager() {
    const { PtyManager } = await import('./pty-manager')
    manager = new PtyManager()
    return manager
  }

  it('asks the session host whether a no-tmux persisted session exists', async () => {
    const m = await makeManager()
    backend.hasSession.mockResolvedValue(true)

    await expect(m.sessionExists('node-a')).resolves.toBe(true)
    expect(backend.hasSession).toHaveBeenCalledWith('nt-node-a')
  })

  it('treats an unprobeable session host as possibly warm instead of cold-restoring on a guess', async () => {
    const m = await makeManager()
    backend.hasSession.mockRejectedValue(new Error('host connection unavailable'))

    await expect(m.sessionExists('node-a')).resolves.toBe(true)
  })

  it('captures a relay snapshot from the session host when tmux is absent', async () => {
    const m = await makeManager()
    backend.capture.mockResolvedValue('painted screen')

    await expect(m.captureSnapshot('node-a')).resolves.toBe('painted screen')
    expect(backend.capture).toHaveBeenCalledWith('nt-node-a', false)
  })

  it('passes the platform-resolved local shell into a session-host spawn', async () => {
    const m = await makeManager()
    m.createDetached({ cols: 80, rows: 24, persistKey: 'node-shell' }, { onData: () => {}, onExit: () => {} })

    expect(backend.create).toHaveBeenCalledTimes(1)
    const spawn = backend.create.mock.calls[0][1] as {
      shell: string
      args: string[]
    }
    if (process.platform === 'win32') {
      expect(spawn.shell).not.toBe('bash')
      expect(spawn.shell.toLowerCase()).toMatch(/(?:pwsh|powershell|cmd)(?:\.exe)?$/)
    } else {
      expect(spawn.shell).toBe(process.env.SHELL || 'bash')
    }
    expect(spawn.args).toEqual([])
  })

  it('fails a create closed, parks racing followers, and publishes only the recovered generation', async () => {
    let rejectReady!: (error: Error) => void
    const pendingReady = new Promise<{ fresh: boolean }>((_, reject) => {
      rejectReady = reject
    })
    const failed = fakeSessionHostPty(pendingReady)
    const recovered = fakeSessionHostPty()
    backend.create.mockImplementationOnce(() => failed).mockImplementationOnce(() => recovered)
    const m = await makeManager()
    m.registerIpc()
    const create = host.handlers[IPC.ptyCreate]
    const options = { cols: 80, rows: 24, persistKey: 'node-retry' }

    const first = create(7, options) as Promise<unknown>
    const firstFailure = expect(first).rejects.toThrow('attach refused after connect')
    await vi.waitFor(() => expect(backend.create).toHaveBeenCalledTimes(1))
    // Both followers arrive while the failed shim is indexed. They must wait for `ready`, not join
    // the provisional generation and receive a plausible session id whose writes disappear.
    const followerA = create(8, options) as Promise<unknown>
    const followerB = create(9, options) as Promise<unknown>
    failed.emitData('queued before the attach failure')
    rejectReady(new Error('attach refused after connect'))

    await firstFailure
    expect(failed.resume).not.toHaveBeenCalled()
    expect(failed.destroy).toHaveBeenCalledTimes(1)

    const [a, b] = (await Promise.all([followerA, followerB])) as Array<{
      sessionId: string
      fresh: boolean
      persistent: boolean
    }>
    expect(a.sessionId).toBe('pty-2')
    expect(b.sessionId).toBe('pty-2')
    expect([a.fresh, b.fresh].sort()).toEqual([false, true])
    expect(a.persistent).toBe(true)
    expect(b.persistent).toBe(true)
    expect(backend.create).toHaveBeenCalledTimes(2)

    // Rollback cancels queued bytes, and late callbacks from the discarded generation are inert.
    failed.emitData('late bytes')
    failed.emitExit(1)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(host.sent.some((m) => m.channel === IPC.ptyData('pty-1'))).toBe(false)
    expect(host.sent.some((m) => m.channel === IPC.ptyExit('pty-1'))).toBe(false)
  })

  it('does not resolve the create as persistent until the provisional attach succeeds', async () => {
    let resolveReady!: (info: { fresh: boolean; screen?: string }) => void
    const pendingReady = new Promise<{ fresh: boolean; screen?: string }>((resolve) => {
      resolveReady = resolve
    })
    backend.create.mockReturnValue(fakeSessionHostPty(pendingReady))
    const m = await makeManager()
    m.registerIpc()
    const create = host.handlers[IPC.ptyCreate]
    let settled = false

    const resultPromise = (create(7, {
      cols: 80,
      rows: 24,
      persistKey: 'node-pending'
    }) as Promise<unknown>).then((result) => {
      settled = true
      return result
    })
    await vi.waitFor(() => expect(backend.create).toHaveBeenCalledTimes(1))
    await Promise.resolve()
    expect(settled).toBe(false)

    resolveReady({ fresh: false, screen: 'still alive' })
    await expect(resultPromise).resolves.toMatchObject({
      sessionId: 'pty-1',
      fresh: false,
      persistent: true,
      screen: 'still alive'
    })
  })

  it('does not let a warm Session Host attach claim pane ownership from placeholder freshness', async () => {
    backend.create.mockReturnValue(fakeSessionHostPty(Promise.resolve({ fresh: false })))
    const m = await makeManager()
    m.registerIpc()

    await expect(
      host.handlers[IPC.ptyCreate](7, {
        cols: 80,
        rows: 24,
        persistKey: 'node-warm-owner',
        ownerProjectId: 'project-clone'
      })
    ).resolves.toMatchObject({ fresh: false })
    expect(paneOwnerProject('node-warm-owner')).toBeUndefined()
  })

  it('keeps a deletion tombstone when its owner recovery attach fails', async () => {
    let rejectReady!: (error: Error) => void
    const pendingReady = new Promise<{ fresh: boolean }>((_, reject) => {
      rejectReady = reject
    })
    const failed = fakeSessionHostPty(pendingReady)
    backend.create.mockReturnValue(failed)
    const m = await makeManager()
    m.registerIpc()
    const create = host.handlers[IPC.ptyCreate]
    const options = { cols: 80, rows: 24, persistKey: 'node-protected' }

    // A confirmed delete leaves the owner able to recover, while other clients remain refused.
    await m.destroySession(7, 'node-protected')
    const ownerRecovery = create(7, options) as Promise<unknown>
    const recoveryFailure = expect(ownerRecovery).rejects.toThrow('recovery attach refused')
    await vi.waitFor(() => expect(backend.create).toHaveBeenCalledTimes(1))
    rejectReady(new Error('recovery attach refused'))
    await recoveryFailure

    await expect(create(8, options)).resolves.toEqual({
      sessionId: '',
      fresh: false,
      closed: { by: 7 }
    })
    expect(backend.create).toHaveBeenCalledTimes(1)
  })

  it('fences an exit-before-rejection generation until a retry confirms the destroy', async () => {
    const proc = fakeSessionHostPty()
    backend.create.mockReturnValue(proc)
    let rejectKill!: (error: Error) => void
    backend.kill.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectKill = reject
        })
    )
    const m = await makeManager()
    m.registerIpc()
    const ended = vi.fn()
    m.onSessionEnded(ended)
    const create = host.handlers[IPC.ptyCreate]
    const destroy = host.handlers[IPC.ptyDestroy]
    const options = { cols: 80, rows: 24, persistKey: 'node-kill-ack' }

    const first = (await create(7, options)) as { sessionId: string; fresh: boolean }
    const second = (await create(8, options)) as { sessionId: string; fresh: boolean }
    expect(second).toMatchObject({ sessionId: first.sessionId, fresh: false })

    const pendingDestroy = destroy(7, 'node-kill-ack') as Promise<void>
    const rejectedDestroy = expect(pendingDestroy).rejects.toThrow('kill acknowledgement lost')
    await vi.waitFor(() => expect(backend.kill).toHaveBeenCalledTimes(1))

    // A create arriving while the host result is unknown waits behind the end barrier. It must
    // neither join a session that may be dying nor spawn a replacement before the outcome lands.
    let followerSettled = false
    const follower = (create(9, options) as Promise<unknown>).finally(() => {
      followerSettled = true
    })
    const followerFailure = expect(follower).rejects.toThrow(
      'session end outcome unknown; retry the close before reopening this node'
    )
    await Promise.resolve()
    expect(followerSettled).toBe(false)
    expect(backend.create).toHaveBeenCalledTimes(1)

    // The host may have acted and emitted exit before its correlated reply is lost. Exit is not a
    // kill acknowledgement: allowing the waiting create to spawn here resurrects an unknown delete.
    proc.emitExit(0)
    rejectKill(new Error('kill acknowledgement lost'))
    await rejectedDestroy
    await followerFailure

    // Nothing local claimed a confirmed close, and no replacement generation was spawned. The
    // exact same idempotent destroy remains available to establish absence.
    expect(backend.create).toHaveBeenCalledTimes(1)
    expect(proc.destroy).not.toHaveBeenCalled()
    expect(host.sent.some((message) => message.channel === IPC.ptyClosed(first.sessionId))).toBe(false)
    expect(ended).not.toHaveBeenCalled()

    backend.kill.mockResolvedValueOnce(undefined)
    await expect(destroy(7, 'node-kill-ack')).resolves.toBeUndefined()
    expect(backend.kill).toHaveBeenCalledTimes(2)
    expect(ended).toHaveBeenCalledWith('node-kill-ack')
    await expect(create(9, options)).resolves.toEqual({
      sessionId: '',
      fresh: false,
      closed: { by: 7 }
    })
  })

  it('contains a failed legacy destroy cast without local teardown or an unhandled rejection', async () => {
    const proc = fakeSessionHostPty()
    backend.create.mockReturnValue(proc)
    backend.kill.mockRejectedValueOnce(new Error('legacy reply path unavailable'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const m = await makeManager()
    m.registerIpc()
    const ended = vi.fn()
    m.onSessionEnded(ended)
    const created = (await host.handlers[IPC.ptyCreate](7, {
      cols: 80,
      rows: 24,
      persistKey: 'legacy-node'
    })) as { sessionId: string }

    host.senderListeners[IPC.ptyDestroy](7, 'legacy-node')
    await vi.waitFor(() => expect(backend.kill).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(warn).toHaveBeenCalled())

    expect(proc.destroy).not.toHaveBeenCalled()
    expect(ended).not.toHaveBeenCalled()
    expect(host.sent.some((message) => message.channel === IPC.ptyClosed(created.sessionId))).toBe(false)
  })

  it('rejects recycle before changing local generation state when the host kill fails', async () => {
    const proc = fakeSessionHostPty()
    backend.create.mockReturnValue(proc)
    backend.kill.mockRejectedValueOnce(new Error('recycle outcome unknown'))
    const m = await makeManager()
    m.registerIpc()
    const ended = vi.fn()
    m.onSessionEnded(ended)
    const created = (await host.handlers[IPC.ptyCreate](7, {
      cols: 80,
      rows: 24,
      persistKey: 'recycle-node'
    })) as { sessionId: string }

    await expect(host.handlers[IPC.ptyRecycle](7, 'recycle-node')).rejects.toThrow(
      'recycle outcome unknown'
    )
    expect(proc.destroy).not.toHaveBeenCalled()
    expect(ended).not.toHaveBeenCalled()
    expect(host.sent.some((message) => message.channel === IPC.ptyRecycled(created.sessionId))).toBe(false)
  })

  it('kills a live host-owned session even if tmux becomes available later', async () => {
    const proc = fakeSessionHostPty()
    backend.create.mockReturnValue(proc)
    const m = await makeManager()
    m.registerIpc()
    await host.handlers[IPC.ptyCreate](7, {
      cols: 80,
      rows: 24,
      persistKey: 'host-before-tmux'
    })
    ;(m as unknown as { tmuxPath: string }).tmuxPath = 'missing-test-tmux'

    await expect(host.handlers[IPC.ptyDestroy](7, 'host-before-tmux')).resolves.toBeUndefined()
    expect(backend.kill).toHaveBeenCalledWith('nt-host-before-tmux')
    expect(proc.destroy).toHaveBeenCalledTimes(1)
  })

  it('does not route an unheld tmux-session delete through the session host', async () => {
    const m = await makeManager()
    ;(m as unknown as { tmuxPath: string }).tmuxPath = 'missing-test-tmux'

    await expect(m.destroySession(7, 'tmux-orphan')).resolves.toBeUndefined()
    expect(backend.kill).not.toHaveBeenCalled()
  })

  it('does not publish a session that exits in the same turn its ready resolves', async () => {
    let resolveReady!: (info: { fresh: boolean }) => void
    const pendingReady = new Promise<{ fresh: boolean }>((resolve) => {
      resolveReady = resolve
    })
    const exited = fakeSessionHostPty(pendingReady)
    backend.create.mockReturnValue(exited)
    const m = await makeManager()
    m.registerIpc()
    const create = host.handlers[IPC.ptyCreate]

    const result = create(7, {
      cols: 80,
      rows: 24,
      persistKey: 'node-exited-during-attach'
    }) as Promise<unknown>
    // This suite mocks './session-host-backend', so the create path exercised here is
    // pty-manager.ts's own ready-vs-exit race (the message below is its literal text, line
    // ~1998) — not session-host-client.ts's SessionHostPty class, which is a different,
    // unmocked implementation this harness never reaches. Matches the sibling test "rejects a
    // create whose provisional generation exits before ready resolves" below.
    const failure = expect(result).rejects.toThrow('exited before it became ready')
    await vi.waitFor(() => expect(backend.create).toHaveBeenCalledTimes(1))
    resolveReady({ fresh: true })
    exited.emitExit(0)

    await failure
  })

  it('retires a detached session-host shim and signals its sink when ready rejects', async () => {
    let rejectReady!: (error: Error) => void
    const pendingReady = new Promise<{ fresh: boolean }>((_, reject) => {
      rejectReady = reject
    })
    const failed = fakeSessionHostPty(pendingReady)
    backend.create.mockReturnValue(failed)
    const m = await makeManager()
    const onData = vi.fn()
    const onExit = vi.fn()

    expect(
      m.createDetached(
        { cols: 80, rows: 24, persistKey: 'relay-node' },
        { onData, onExit }
      )
    ).toBe('pty-1')
    rejectReady(new Error('relay attach failed'))
    await vi.waitFor(() => expect(failed.destroy).toHaveBeenCalledTimes(1))

    expect(onExit).toHaveBeenCalledWith(1)
    failed.emitData('late relay bytes')
    failed.emitExit(9)
    expect(onData).not.toHaveBeenCalled()
    expect(onExit).toHaveBeenCalledTimes(1)
  })

  it('treats confirmed absence as recovered while invalid, uncertain, and rate-limited requests reject', async () => {
    const m = await makeManager()
    backend.supported.mockReturnValue(true)

    await expect(m.recycleSessionFromClient(7, '')).rejects.toThrow('invalid node id')
    expect(backend.kill).not.toHaveBeenCalled()

    backend.hasSession.mockResolvedValue(false)
    await expect(m.recycleSessionFromClient(7, 'node-missing')).resolves.toBeUndefined()
    expect(backend.kill).toHaveBeenCalledWith('nt-node-missing', {
      reserveReplacement: true,
      requireV2: true,
      expectedAbsent: true
    })
    backend.kill.mockClear()

    backend.hasSession.mockRejectedValueOnce(new Error('host probe unavailable'))
    await expect(m.recycleSessionFromClient(7, 'node-uncertain')).rejects.toThrow(
      'Could not confirm the terminal session'
    )
    expect(backend.kill).not.toHaveBeenCalled()

    const { PTY_END_BUDGET } = await import('./pty-manager')
    backend.hasSession.mockResolvedValue(true)
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-16T00:00:00Z'))
    try {
      for (let i = 0; i < PTY_END_BUDGET.burst; i += 1)
        await m.recycleSessionFromClient(8, 'node-budget')
      await expect(m.recycleSessionFromClient(8, 'node-budget')).rejects.toThrow(
        'Too many terminal restart requests'
      )
      expect(backend.kill).toHaveBeenCalledTimes(PTY_END_BUDGET.burst)
    } finally {
      vi.useRealTimers()
    }
  })

  it('binds an honestly absent host reservation to expected absence', async () => {
    const m = await makeManager()
    backend.hasSession.mockResolvedValueOnce(false).mockResolvedValue(true)
    backend.kill.mockImplementationOnce(async (_name, options) => {
      expect(options).toEqual({
        reserveReplacement: true,
        requireV2: true,
        expectedAbsent: true
      })
      throw new Error('another client created the name before reservation')
    })

    await expect(m.recycleSessionFromClient(7, 'node-absence-race')).rejects.toThrow(
      'another client created the name before reservation'
    )
    expect(backend.kill).toHaveBeenCalledTimes(1)
  })

  it('requires protocol v2 for a confirmed host teardown even when the replacement is direct', async () => {
    const active = fakeSessionHostPty()
    backend.create.mockReturnValue(active)
    const m = await makeManager()
    m.registerIpc()
    const create = host.handlers[IPC.ptyCreate]
    const options = { cols: 80, rows: 24, persistKey: 'node-v1-direct-target' }
    await create(7, options)
    m.init(() => ({
      tmuxEnabled: false
    }) as never)
    backend.hasSession.mockResolvedValue(true)
    const { SessionHostProtocolCompatibilityError } = await import('./session-host-backend')
    backend.kill.mockImplementationOnce(async (_name, killOptions) => {
      if (killOptions?.requireV2)
        throw new SessionHostProtocolCompatibilityError('restart this terminal')
      active.emitExit(0)
    })

    await expect(m.recycleSessionFromClient(7, options.persistKey)).rejects.toBeInstanceOf(
      SessionHostProtocolCompatibilityError
    )
    expect(backend.kill).toHaveBeenCalledWith('nt-node-v1-direct-target', {
      reserveReplacement: false,
      requireV2: true
    })
    await expect(create(8, options)).resolves.toMatchObject({ sessionId: 'pty-1', fresh: false })
    expect(backend.create).toHaveBeenCalledTimes(1)
  })

  it('leaves the live generation joinable when the confirmed backend kill rejects', async () => {
    const active = fakeSessionHostPty()
    backend.create.mockReturnValue(active)
    const m = await makeManager()
    m.registerIpc()
    const create = host.handlers[IPC.ptyCreate]
    const options = { cols: 80, rows: 24, persistKey: 'node-kill-reject' }

    await expect(create(7, options)).resolves.toMatchObject({
      sessionId: 'pty-1',
      persistent: true
    })
    backend.kill.mockImplementationOnce(async () => {
      throw new Error('kill acknowledgement lost')
    })
    backend.hasSession.mockResolvedValue(true)

    await expect(m.recycleSessionFromClient(7, options.persistKey)).rejects.toThrow(
      'kill acknowledgement lost'
    )
    expect(active.resume).not.toHaveBeenCalled()
    expect(active.kill).not.toHaveBeenCalled()
    expect(active.destroy).not.toHaveBeenCalled()

    // The original index and subscriber ledger remain intact: another client joins the same
    // generation, and no replacement host attach is attempted.
    await expect(create(8, options)).resolves.toMatchObject({
      sessionId: 'pty-1',
      fresh: false,
      persistent: true
    })
    expect(backend.create).toHaveBeenCalledTimes(1)
  })

  it('commits an exact early exit when the host response is lost and preserves the replacement lease', async () => {
    const active = fakeSessionHostPty()
    const replacement = fakeSessionHostPty()
    backend.create.mockImplementationOnce(() => active).mockImplementationOnce(() => replacement)
    const m = await makeManager()
    m.registerIpc()
    const create = host.handlers[IPC.ptyCreate]
    const options = { cols: 80, rows: 24, persistKey: 'node-exit-then-reject' }

    await create(7, options)
    backend.kill.mockImplementationOnce(async () => {
      // This is the real host order: exit broadcast first, then a response that may be lost.
      active.emitExit(23)
      throw new Error('kill response lost after exit')
    })

    await expect(m.recycleSessionFromClient(7, options.persistKey)).resolves.toBeUndefined()
    expect(backend.kill).toHaveBeenNthCalledWith(2, 'nt-node-exit-then-reject', {
      reserveReplacement: true,
      requireV2: true
    })
    expect(
      host.sent.some(
        (message) =>
          message.channel === IPC.ptyExit('pty-1') && message.args[0] === 23
      )
    ).toBe(false)
    expect(host.sent.some((message) => message.channel === IPC.ptyRecycled('pty-1'))).toBe(false)

    // The committed transaction reserved replacement creation for its primary owner. Its create
    // establishes the fresh generation; no ordinary exit/rejected-switch path intervenes.
    await expect(create(7, options)).resolves.toMatchObject({ sessionId: 'pty-2', fresh: true })
    expect(backend.create).toHaveBeenCalledTimes(2)
  })

  it('does not retain a replacement lease for generic node deletion', async () => {
    const active = fakeSessionHostPty()
    backend.create.mockReturnValue(active)
    const m = await makeManager()
    m.registerIpc()
    const options = { cols: 80, rows: 24, persistKey: 'node-generic-delete' }
    await host.handlers[IPC.ptyCreate](7, options)
    backend.kill.mockClear()

    await m.destroySession(7, options.persistKey)

    expect(backend.kill).toHaveBeenCalledTimes(1)
    expect(backend.kill.mock.calls[0]).toEqual(['nt-node-generic-delete'])
  })

  it('waits for backend kill acknowledgement before cleaning the confirmed generation', async () => {
    const order: string[] = []
    const active = fakeSessionHostPty()
    const replacement = fakeSessionHostPty()
    active.resume.mockImplementation(() => order.push('cleanup-resume'))
    active.destroy.mockImplementation(() => order.push('cleanup-destroy'))
    backend.create.mockImplementationOnce(() => active).mockImplementationOnce(() => replacement)
    backend.kill.mockImplementationOnce(async () => {
      order.push('host-exit')
      active.emitExit(0)
      order.push('kill-ack')
    })
    const m = await makeManager()
    m.registerIpc()
    const create = host.handlers[IPC.ptyCreate]
    const options = { cols: 80, rows: 24, persistKey: 'node-kill-order' }

    await create(7, options)
    await create(8, options)
    await m.recycleSessionFromClient(7, options.persistKey)

    expect(order).toEqual(['host-exit', 'kill-ack', 'cleanup-resume', 'cleanup-destroy'])
    expect(host.sent.some((message) => message.channel === IPC.ptyExit('pty-1'))).toBe(false)

    // The co-viewer's subscriber ledger survived until the acknowledged cleanup, so registering
    // the replacement releases it through the recycle event rather than losing it to early exit.
    await create(7, options)
    expect(
      host.sent.some((message) => message.channel === IPC.ptyRecycled('pty-1'))
    ).toBe(true)
  })

  it('rejects a create whose provisional generation exits before ready resolves', async () => {
    let resolveReady!: (info: { fresh: boolean }) => void
    const pendingReady = new Promise<{ fresh: boolean }>((resolve) => {
      resolveReady = resolve
    })
    const exited = fakeSessionHostPty(pendingReady)
    const replacement = fakeSessionHostPty()
    backend.create.mockImplementationOnce(() => exited).mockImplementationOnce(() => replacement)
    const m = await makeManager()
    m.registerIpc()
    const create = host.handlers[IPC.ptyCreate]
    const options = { cols: 80, rows: 24, persistKey: 'node-exit-before-ready' }

    const first = create(7, options) as Promise<unknown>
    await vi.waitFor(() => expect(backend.create).toHaveBeenCalledTimes(1))
    exited.emitExit(17)
    resolveReady({ fresh: true })

    await expect(first).rejects.toThrow('exited before it became ready')
    expect(
      host.sent.some(
        (message) => message.channel === IPC.ptyExit('pty-1') && message.args[0] === 17
      )
    ).toBe(true)
    await expect(create(8, options)).resolves.toMatchObject({ sessionId: 'pty-2', fresh: true })
  })

  it('retains a deletion tombstone when the owner recovery attach rejects', async () => {
    const original = fakeSessionHostPty()
    let rejectRecovery!: (error: Error) => void
    const recoveryReady = new Promise<{ fresh: boolean }>((_, reject) => {
      rejectRecovery = reject
    })
    const failedRecovery = fakeSessionHostPty(recoveryReady)
    const forbiddenFollower = fakeSessionHostPty()
    backend.create
      .mockImplementationOnce(() => original)
      .mockImplementationOnce(() => failedRecovery)
      .mockImplementationOnce(() => forbiddenFollower)
    const m = await makeManager()
    m.registerIpc()
    const create = host.handlers[IPC.ptyCreate]
    const options = { cols: 80, rows: 24, persistKey: 'node-deleted-recovery' }

    await create(7, options)
    await m.destroySession(7, options.persistKey)
    const ownerRecovery = create(7, options) as Promise<unknown>
    await vi.waitFor(() => expect(backend.create).toHaveBeenCalledTimes(2))
    const follower = create(8, options) as Promise<unknown>
    rejectRecovery(new Error('recovery attach refused'))

    await expect(ownerRecovery).rejects.toThrow('recovery attach refused')
    await expect(follower).resolves.toMatchObject({
      sessionId: '',
      fresh: false,
      closed: { by: 7 }
    })
    expect(backend.create).toHaveBeenCalledTimes(2)
  })

  it('retires only the exact generation when reconnect replay is rejected', async () => {
    const original = fakeSessionHostPty()
    const replacement = fakeSessionHostPty()
    backend.create.mockImplementationOnce(() => original).mockImplementationOnce(() => replacement)
    const m = await makeManager()
    m.registerIpc()
    const create = host.handlers[IPC.ptyCreate]
    const options = { cols: 80, rows: 24, persistKey: 'node-replay-reject' }

    await create(7, options)
    original.emitAttachError(new Error("no existing session 'nt-node-replay-reject'"))
    expect(
      host.sent.some(
        (message) => message.channel === IPC.ptyExit('pty-1') && message.args[0] === 1
      )
    ).toBe(true)
    await expect(create(7, options)).resolves.toMatchObject({ sessionId: 'pty-2', fresh: true })

    // A delayed duplicate callback from the retired shim cannot forget the replacement.
    original.emitAttachError(new Error('late replay failure'))
    await expect(create(8, options)).resolves.toMatchObject({ sessionId: 'pty-2', fresh: false })
    expect(backend.create).toHaveBeenCalledTimes(2)
  })

  it('reserves a recycled replacement for its owner and releases parked co-viewers on failure', async () => {
    const original = fakeSessionHostPty()
    let rejectReplacement!: (error: Error) => void
    const replacementReady = new Promise<{ fresh: boolean }>((_, reject) => {
      rejectReplacement = reject
    })
    const failedReplacement = fakeSessionHostPty(replacementReady)
    backend.create
      .mockImplementationOnce(() => original)
      .mockImplementationOnce(() => failedReplacement)
    const m = await makeManager()
    m.registerIpc()
    const create = host.handlers[IPC.ptyCreate]
    const options = { cols: 80, rows: 24, persistKey: 'node-owner-reservation' }

    await create(7, options)
    await create(8, options)
    await m.recycleSessionFromClient(7, options.persistKey)
    const parkedFollower = create(8, options) as Promise<unknown>
    const ownerReplacement = create(7, options) as Promise<unknown>
    await vi.waitFor(() => expect(backend.create).toHaveBeenCalledTimes(2))
    rejectReplacement(new Error('selected replacement failed'))

    await expect(ownerReplacement).rejects.toThrow('selected replacement failed')
    await expect(parkedFollower).rejects.toThrow('replacement terminal did not become ready')
    expect(backend.create).toHaveBeenCalledTimes(2)
    expect(
      host.sent.some(
        (message) =>
          message.to === 8 &&
          message.channel === IPC.ptyRecycled('pty-1') &&
          (message.args[0] as { ready: boolean }).ready === false
      )
    ).toBe(true)
  })

  it('reserves a solo session replacement from an inactive co-viewer', async () => {
    const original = fakeSessionHostPty()
    let rejectReplacement!: (error: Error) => void
    const replacementReady = new Promise<{ fresh: boolean }>((_, reject) => {
      rejectReplacement = reject
    })
    backend.create
      .mockImplementationOnce(() => original)
      .mockImplementationOnce(() => fakeSessionHostPty(replacementReady))
    const m = await makeManager()
    m.registerIpc()
    const create = host.handlers[IPC.ptyCreate]
    const options = { cols: 80, rows: 24, persistKey: 'node-solo-reservation' }
    await create(7, options)
    await m.recycleSessionFromClient(7, options.persistKey)

    const inactiveViewer = create(9, options) as Promise<unknown>
    const owner = create(7, options) as Promise<unknown>
    await vi.waitFor(() => expect(backend.create).toHaveBeenCalledTimes(2))
    rejectReplacement(new Error('owner replacement rejected'))

    await expect(owner).rejects.toThrow('owner replacement rejected')
    await expect(inactiveViewer).rejects.toThrow('replacement terminal did not become ready')
    expect(backend.create).toHaveBeenCalledTimes(2)
  })

  it('parks a same-client modal behind the primary replacement owner', async () => {
    const original = fakeSessionHostPty()
    const replacement = fakeSessionHostPty()
    backend.create.mockImplementationOnce(() => original).mockImplementationOnce(() => replacement)
    const m = await makeManager()
    m.registerIpc()
    const create = host.handlers[IPC.ptyCreate]
    const options = { cols: 80, rows: 24, persistKey: 'node-primary-view-owner' }

    await create(7, options)
    await m.recycleSessionFromClient(7, options.persistKey)

    let modalSettled = false
    const modal = (create(7, { ...options, viewerId: 'kanban-modal' }) as Promise<unknown>).then(
      (result) => {
        modalSettled = true
        return result
      }
    )
    await Promise.resolve()
    expect(modalSettled).toBe(false)
    expect(backend.create).toHaveBeenCalledTimes(1)

    await expect(create(7, options)).resolves.toMatchObject({ sessionId: 'pty-2', fresh: true })
    await expect(modal).resolves.toMatchObject({ sessionId: 'pty-2', fresh: false })
    expect(backend.create).toHaveBeenCalledTimes(2)
  })

  it('reserves an honestly absent session until the owner establishes its replacement', async () => {
    backend.hasSession.mockResolvedValue(false)
    backend.create.mockReturnValue(fakeSessionHostPty())
    const m = await makeManager()
    m.registerIpc()
    const create = host.handlers[IPC.ptyCreate]
    const options = { cols: 80, rows: 24, persistKey: 'node-absent-reservation' }

    await expect(m.recycleSessionFromClient(7, options.persistKey)).resolves.toBeUndefined()
    const inactiveViewer = create(9, options) as Promise<unknown>
    const owner = create(7, options) as Promise<unknown>

    await expect(owner).resolves.toMatchObject({ sessionId: 'pty-1', fresh: true })
    await expect(inactiveViewer).resolves.toMatchObject({ sessionId: 'pty-1', fresh: false })
    expect(backend.create).toHaveBeenCalledTimes(1)
  })

  it('rejects a duplicate confirmed recycle while the first kill is in flight', async () => {
    let acknowledgeKill!: () => void
    const killPending = new Promise<void>((resolve) => {
      acknowledgeKill = resolve
    })
    backend.kill.mockReturnValue(killPending)
    const m = await makeManager()
    m.registerIpc()
    const create = host.handlers[IPC.ptyCreate]
    const options = { cols: 80, rows: 24, persistKey: 'node-double-recycle' }
    await create(7, options)

    const first = m.recycleSessionFromClient(7, options.persistKey)
    await vi.waitFor(() => expect(backend.kill).toHaveBeenCalledTimes(1))
    await expect(m.recycleSessionFromClient(7, options.persistKey)).rejects.toThrow(
      'already restarting'
    )
    acknowledgeKill()
    await expect(first).resolves.toBeUndefined()
    expect(backend.kill).toHaveBeenCalledTimes(1)
  })

  it('rejects parked create waiters when the manager shuts down', async () => {
    const original = fakeSessionHostPty()
    backend.create.mockReturnValue(original)
    const m = await makeManager()
    m.registerIpc()
    const create = host.handlers[IPC.ptyCreate]
    const options = { cols: 80, rows: 24, persistKey: 'node-shutdown-waiter' }
    await create(7, options)
    await create(8, options)
    await m.recycleSessionFromClient(7, options.persistKey)
    const parked = create(8, options) as Promise<unknown>

    await m.killAll()
    await expect(parked).rejects.toThrow('shut down before the replacement became ready')
  })
})

describe('resolveLocalSessionShell', () => {
  it('uses the Windows resolver when both explicit and configured shells are empty', async () => {
    const { resolveLocalSessionShell } = await import('./pty-manager')
    const windowsShell = vi.fn(() => String.raw`C:\Windows\System32\cmd.exe`)

    expect(
      resolveLocalSessionShell(undefined, '', {
        platform: 'win32',
        windowsShell,
        posixShell: '/bin/should-not-win'
      })
    ).toBe(String.raw`C:\Windows\System32\cmd.exe`)
    expect(windowsShell).toHaveBeenCalledTimes(1)
  })

  it('keeps an explicit program above a configured shell and every platform fallback', async () => {
    const { resolveLocalSessionShell } = await import('./pty-manager')
    const windowsShell = vi.fn(() => 'cmd.exe')

    expect(
      resolveLocalSessionShell('/opt/custom-shell', '/bin/configured', {
        platform: 'win32',
        windowsShell
      })
    ).toBe('/opt/custom-shell')
    expect(windowsShell).not.toHaveBeenCalled()
  })

  it('keeps a configured compatibility shell above platform fallback', async () => {
    const { resolveLocalSessionShell } = await import('./pty-manager')
    const windowsShell = vi.fn(() => 'cmd.exe')

    expect(
      resolveLocalSessionShell(undefined, String.raw`C:\Tools\My Shell\shell.exe`, {
        platform: 'win32',
        windowsShell
      })
    ).toBe(String.raw`C:\Tools\My Shell\shell.exe`)
    expect(windowsShell).not.toHaveBeenCalled()
  })

  it('uses the POSIX shell, then bash, outside Windows', async () => {
    const { resolveLocalSessionShell } = await import('./pty-manager')

    expect(
      resolveLocalSessionShell(undefined, '', { platform: 'linux', posixShell: '/bin/zsh' })
    ).toBe('/bin/zsh')
    expect(resolveLocalSessionShell(undefined, '', { platform: 'linux', posixShell: '' })).toBe(
      'bash'
    )
  })
})
