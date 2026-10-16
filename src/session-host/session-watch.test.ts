// HostSession's `watch-attach` transaction and its reported cwd, at unit level (the real-protocol
// wiring is live-links-host.test.ts). A watch attachment must never contribute a geometry claim or
// a pause ticket, and must give up any claim its connection held.
import { describe, expect, it, vi } from 'vitest'
import type { Socket } from 'net'
import type { IPty } from 'node-pty'
import { HostSession } from './session'
import type { TerminalEmulator } from './terminal-emulator'
import type { SessionHostSpawnOptions } from './protocol'

const SPAWN: SessionHostSpawnOptions = { shell: 'unused', args: [], cwd: '.', env: {}, cols: 80, rows: 24 }

function fixture(): { session: HostSession; resize: ReturnType<typeof vi.fn>; pause: ReturnType<typeof vi.fn> } {
  const resize = vi.fn()
  const pause = vi.fn()
  const proc = { pid: 1, pause, resume: vi.fn(), resize } as unknown as IPty
  const term = {
    write: vi.fn(async () => {}),
    serialize: vi.fn(() => ''),
    resize: vi.fn(),
    dispose: vi.fn()
  } as unknown as TerminalEmulator
  return { session: new HostSession('watch', SPAWN, 100, { proc, term }), resize, pause }
}

describe('HostSession watch attachments', () => {
  it('casts no claim: the owner alone sizes the pty, up as well as down', async () => {
    const { session, resize } = fixture()
    const owner = {} as Socket
    const viewer = {} as Socket
    ;(await session.prepareAttachment(owner, 100, 30, false)).commit()
    expect(resize).toHaveBeenLastCalledWith(100, 30)
    const watch = await session.prepareWatchAttachment(viewer)
    expect(watch.commit()).toBe(true)
    expect(session.subscribers.has(viewer)).toBe(true)
    expect(session.isWatching(viewer)).toBe(true)
    await session.resizeFor(owner, 140, 50)
    expect(resize).toHaveBeenLastCalledWith(140, 50)
    // A viewer cannot resize, and never takes a pause ticket.
    await expect(session.resizeFor(viewer, 10, 5)).rejects.toThrow(/watch attachment/)
    session.pauseFor(viewer)
    expect(session.geometry).toEqual({ cols: 140, rows: 50 })
  })

  it('withdraws the claim a connection held, and the pty keeps its size when no claim is left', async () => {
    const { session, resize } = fixture()
    const socket = {} as Socket
    ;(await session.prepareAttachment(socket, 90, 20, false)).commit()
    resize.mockClear()
    ;(await session.prepareWatchAttachment(socket)).commit()
    expect(session.isWatching(socket)).toBe(true)
    expect(resize).not.toHaveBeenCalled()
    expect(session.geometry).toEqual({ cols: 90, rows: 20 })
    // A claim-carrying attach upgrades it again.
    ;(await session.prepareAttachment(socket, 70, 20, false)).commit()
    expect(session.isWatching(socket)).toBe(false)
    expect(resize).toHaveBeenLastCalledWith(70, 20)
  })

  it('never holds a pause ticket, and returns one the connection held', async () => {
    const { session, pause } = fixture()
    const socket = {} as Socket
    ;(await session.prepareAttachment(socket, 80, 24, true)).commit()
    expect(pause).toHaveBeenCalledTimes(1)
    const resume = (session.proc as unknown as { resume: ReturnType<typeof vi.fn> }).resume
    ;(await session.prepareWatchAttachment(socket)).commit()
    expect(resume).toHaveBeenCalledTimes(1)
  })

  it('a rolled-back watch attach restores the previous claim and mode exactly', async () => {
    const { session, resize } = fixture()
    const socket = {} as Socket
    ;(await session.prepareAttachment(socket, 100, 40, false)).commit()
    const watch = await session.prepareWatchAttachment(socket)
    await watch.rollback()
    expect(session.isWatching(socket)).toBe(false)
    await session.resizeFor(socket, 110, 40)
    expect(resize).toHaveBeenLastCalledWith(110, 40)
  })

  it('detach clears watch mode', async () => {
    const { session } = fixture()
    const socket = {} as Socket
    ;(await session.prepareWatchAttachment(socket)).commit()
    await session.detach(socket)
    expect(session.isWatching(socket)).toBe(false)
    expect(session.subscribers.has(socket)).toBe(false)
  })
})

describe('HostSession reported cwd', () => {
  it('is null until the pane reports one, then follows the latest report across chunks', () => {
    const { session } = fixture()
    expect(session.paneCwd).toBeNull()
    session.noteOutput('PS> \x1b]9;9;"C:\\a"')
    expect(session.paneCwd).toBeNull()
    session.noteOutput('\x07')
    expect(session.paneCwd).toBe('C:\\a')
    session.noteOutput('\x1b]7;file://pc/C:/b\x1b\\')
    expect(session.paneCwd).toBe('C:\\b')
    session.noteOutput('plain output')
    expect(session.paneCwd).toBe('C:\\b')
  })
})
