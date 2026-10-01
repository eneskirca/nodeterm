import { describe, it, expect, vi } from 'vitest'
import { createWatchPty, type WatchPtyManager } from './pty-seam'
import type { PtyCreateResult } from '../../shared/types'

function fakeManager(over: Partial<Record<keyof WatchPtyManager, unknown>> = {}) {
  const m = {
    joinAsWatcher: vi.fn(async (_c: number, _o: object): Promise<PtyCreateResult> => ({ sessionId: 's1', tmuxClient: true }) as PtyCreateResult),
    sessionSize: vi.fn((_s: string): { cols: number; rows: number } | null => ({ cols: 120, rows: 40 })),
    kill: vi.fn(),
    captureVisible: vi.fn(async () => ({ screen: 'x', cursor: { x: 1, y: 2 } })),
    syncWatcherClientSize: vi.fn(async () => true),
    hasSession: vi.fn(() => true)
  }
  return Object.assign(m, over) as typeof m
}

describe('createWatchPty — the WatchPty seam both shells wire (R39)', () => {
  it('joins with the host ids only (never a size), and reports the JOINED session size and tmux-ness', async () => {
    const m = fakeManager()
    const pty = createWatchPty(m as unknown as WatchPtyManager)
    expect(await pty.join(7, 'n1', 'v-1')).toEqual({ sessionId: 's1', cols: 120, rows: 40, altScreen: true })
    expect(m.joinAsWatcher).toHaveBeenCalledWith(7, { persistKey: 'n1', viewerId: 'v-1' })
    expect(m.sessionSize).toHaveBeenCalledWith('s1')
    expect(m.kill).not.toHaveBeenCalled()
  })

  it('altScreen is true only for a tmux client', async () => {
    const m = fakeManager({ joinAsWatcher: vi.fn(async () => ({ sessionId: 's1' })) })
    expect(await createWatchPty(m as unknown as WatchPtyManager).join(7, 'n1', 'v-1')).toMatchObject({ altScreen: false })
  })

  it('no session: null, nothing to leave', async () => {
    const m = fakeManager({ joinAsWatcher: vi.fn(async () => ({ sessionId: '', unavailable: 'join-only' })) })
    expect(await createWatchPty(m as unknown as WatchPtyManager).join(7, 'n1', 'v-1')).toBeNull()
    expect(m.kill).not.toHaveBeenCalled()
  })

  it('a joined session whose size is unknown is REFUSED — never an 80x24 guess — and left, not leaked', async () => {
    const m = fakeManager({ sessionSize: vi.fn(() => null) })
    expect(await createWatchPty(m as unknown as WatchPtyManager).join(7, 'n1', 'v-1')).toBeNull()
    expect(m.kill).toHaveBeenCalledWith(7, 's1', 'v-1')
  })

  it('an unavailable answer that still names a session is refused and left', async () => {
    const m = fakeManager({ joinAsWatcher: vi.fn(async () => ({ sessionId: 's1', unavailable: 'ssh' })) })
    expect(await createWatchPty(m as unknown as WatchPtyManager).join(7, 'n1', 'v-1')).toBeNull()
    expect(m.kill).toHaveBeenCalledWith(7, 's1', 'v-1')
    expect(m.sessionSize).not.toHaveBeenCalled()
  })

  it("a remote node's fields come from the shell's own records, requireRemote included", async () => {
    const m = fakeManager()
    const sshRemote = { conn: { host: 'h' } as never, controlPath: '/cp', remoteCwd: '~' }
    const pty = createWatchPty(m as unknown as WatchPtyManager, (nodeId) =>
      nodeId === 'r1' ? { requireRemote: true, sshRemote } : nodeId === 'r2' ? { requireRemote: true } : {}
    )
    await pty.join(7, 'r1', 'v-1')
    await pty.join(7, 'r2', 'v-2')
    expect(m.joinAsWatcher.mock.calls).toEqual([
      [7, { persistKey: 'r1', viewerId: 'v-1', sshRemote, requireRemote: true }],
      [7, { persistKey: 'r2', viewerId: 'v-2', requireRemote: true }]
    ])
  })

  it('leave, capture, size sync and liveness go to the matching PtyManager member', async () => {
    const m = fakeManager()
    const pty = createWatchPty(m as unknown as WatchPtyManager)
    pty.leave(7, 's1', 'v-1')
    expect(m.kill).toHaveBeenCalledWith(7, 's1', 'v-1')
    expect(await pty.captureVisible('s1')).toEqual({ screen: 'x', cursor: { x: 1, y: 2 } })
    expect(await pty.syncSize('s1')).toBe(true)
    expect(m.syncWatcherClientSize).toHaveBeenCalledWith('s1')
    expect(pty.alive('s1')).toBe(true)
    m.hasSession.mockReturnValue(false)
    expect(pty.alive('s1')).toBe(false)
  })
})
