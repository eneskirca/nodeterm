import { afterEach, describe, expect, it, vi } from 'vitest'
import { PtyManager } from './pty-manager'
import { NativeWindowsPane } from './native-windows-pane'
import type { NativeScrollResult } from '../shared/history-scroll'

vi.mock('node-pty', () => ({ spawn: () => { throw new Error('this route test never creates a PTY') } }))
const cleanup: Array<() => void> = []
afterEach(() => { cleanup.splice(0).forEach((close) => close()); vi.restoreAllMocks() })
function fixture() {
  const write = vi.fn(), background = vi.fn()
  const sessions = new Map<string, object>()
  // The manager's real dispatch is exercised on admitted session objects; the OS spawn leaf is
  // deliberately absent. No actual ConPTY, foreground application or tmux process is claimed.
  const manager = Object.create(PtyManager.prototype) as PtyManager
  Object.assign(manager, { sessions, backgroundWrite: background })
  const session = { proc: { write }, tmuxBacked: false, persistKey: undefined as string | undefined,
    sessionHost: false, nodeId: undefined, peers: new Map(), sshRemote: false,
    nativeWindowsPane: undefined as NativeWindowsPane | undefined }
  sessions.set('viewer', session)
  return { manager, sessions, session, write, background }
}

describe('PtyManager scrolling on its exact attached backend', () => {
  it('reads the direct pane actual emulator with mouse off and sends requested wheel encoding only after output', async () => {
    const f = fixture(), pane = new NativeWindowsPane({ pid: 42, write: f.write }, { cols: 20, rows: 5, scrollback: 100 })
    cleanup.push(() => pane.dispose()); f.session.nativeWindowsPane = pane
    pane.recordOutput('pre-attach history\r\n' + 'more history\r\n'.repeat(12))
    const history = await f.manager.scrollAttached(null, 'viewer', true, 2, true, () => true)
    expect(history.status).toBe('history')
    if (history.status === 'history') expect(history.capture?.rows.some((row) => row.text.includes('pre-attach'))).toBe(true)
    expect(f.write).not.toHaveBeenCalled()
    pane.recordOutput('\x1b[?1000h\x1b[?1006l')
    expect(await f.manager.scrollAttached(null, 'viewer', false, 2, false, () => true)).toEqual({ status: 'input' })
    expect(f.write.mock.calls).toEqual([['\x1b[Ma!!'], ['\x1b[Ma!!']])
    expect(f.background).not.toHaveBeenCalled()
  })
  it('binds a queued backend action to the captured session object, not a replacement under the same id', async () => {
    const f = fixture(); f.session.sessionHost = true
    let release!: () => void, entered!: () => void
    const gate = new Promise<void>((done) => { release = done }), admitted = new Promise<void>((done) => { entered = done })
    const scroll = vi.fn(async (up, lines, capture, current): Promise<NativeScrollResult> => {
      expect([up, lines, capture]).toEqual([true, 3, true]); entered(); await gate
      return current() ? { status: 'input' } : { status: 'refused', message: 'retired captured owner' }
    })
    Object.assign(f.session.proc, { scrollForHistory: scroll })
    const action = f.manager.scrollAttached(null, 'viewer', true, 3, true, () => true)
    await admitted; const replacement = { ...f.session, proc: { write: vi.fn(), scrollForHistory: vi.fn() } }
    f.sessions.set('viewer', replacement); release()
    expect((await action).status).toBe('refused')
    expect(scroll).toHaveBeenCalledTimes(1); expect(replacement.proc.scrollForHistory).not.toHaveBeenCalled()
    expect(f.write).not.toHaveBeenCalled(); expect(f.background).not.toHaveBeenCalled()
  })
  it('preserves local and SSH-project tmux viewer wheel bytes without a background/name-only route', async () => {
    for (const sshRemote of [false, true]) {
      const f = fixture(); Object.assign(f.session, { tmuxBacked: true, persistKey: 'exact-retained-node', sshRemote })
      expect(await f.manager.scrollAttached(null, 'viewer', true, 2, true, () => true)).toEqual({ status: 'input' })
      expect(await f.manager.scrollAttached(null, 'viewer', false, 1, false, () => true)).toEqual({ status: 'input' })
      expect(f.write.mock.calls).toEqual([['\x1b[<64;1;1M'], ['\x1b[<64;1;1M'], ['\x1b[<65;1;1M']])
      expect(f.background).not.toHaveBeenCalled()
    }
  })
  it('refuses released, unclassified, partial-tmux and old session-host routes before any bytes', async () => {
    const f = fixture()
    expect((await f.manager.scrollAttached(null, 'released', true, 1, false, () => true)).status).toBe('refused')
    for (const flags of [{}, { tmuxBacked: true }, { tmuxBacked: false, persistKey: 'node' }, { sessionHost: true }]) {
      Object.assign(f.session, { tmuxBacked: false, persistKey: undefined, sessionHost: false }, flags)
      expect((await f.manager.scrollAttached(null, 'viewer', true, 1, false, () => true)).status).toBe('refused')
    }
    expect(f.write).not.toHaveBeenCalled(); expect(f.background).not.toHaveBeenCalled()
  })
  it('refuses malformed distances and stale stream ownership before dispatching tmux input', async () => {
    const f = fixture(); Object.assign(f.session, { tmuxBacked: true, persistKey: 'node' })
    for (const lines of [0, 21, 1.5, NaN]) expect((await f.manager.scrollAttached(null, 'viewer', true, lines, true, () => true)).status).toBe('refused')
    expect((await f.manager.scrollAttached(null, 'viewer', true, 1, true, () => false)).status).toBe('refused')
    expect(f.write).not.toHaveBeenCalled()
  })
  it('stops tmux wheel repetition after retirement or a possible write and keeps the result uncertain', async () => {
    for (const failure of ['retire', 'throw'] as const) {
      const f = fixture(); Object.assign(f.session, { tmuxBacked: true, persistKey: 'node' }); let current = true
      f.write.mockImplementationOnce(() => { if (failure === 'throw') throw new Error('possible accepted wheel'); current = false })
      expect((await f.manager.scrollAttached(null, 'viewer', true, 3, false, () => current)).status).toBe('uncertain')
      expect(f.write.mock.calls).toEqual([['\x1b[<64;1;1M']]); expect(f.background).not.toHaveBeenCalled()
    }
  })
})
