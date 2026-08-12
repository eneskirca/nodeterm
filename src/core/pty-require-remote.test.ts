import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { initPlatform, resetPlatformForTests } from './platform'
import { fakePlatform, type FakePlatform } from './platform-fake'
import { IPC } from '../shared/ipc'
import type { PtyCreateOptions, PtyCreateResult } from '../shared/types'

/**
 * `requireRemote`: a node that belongs to a remote host is never spawned locally.
 *
 * The bug this pins: an SSH project's terminal, created while its ControlMaster was down (no
 * network, host unreachable), used to fall straight through to the LOCAL tmux/plain-shell branch —
 * a local shell in the local `$HOME` carrying the remote node's id, its `SSH user@host` header
 * chip, and (agent nodes) a cold-restore `--resume` typed on the wrong machine. Nothing in the
 * result said so, so it read as "the session reconnected".
 */
const spawned: Array<{ file: string; args: string[] }> = []

vi.mock('node-pty', () => ({
  spawn: (file: string, args: string[]) => {
    spawned.push({ file, args })
    return {
      onData: () => {},
      onExit: () => {},
      write: () => {},
      resize: () => {},
      pause: () => {},
      resume: () => {},
      kill: () => {},
      pid: 4321
    }
  }
}))

const ALICE = 1
const BOB = 2

/**
 * A machine with pty devices to spare, always.
 *
 * Without this the real probe runs a `readdir('/dev')` against the DEVELOPER's host, and
 * `spawnSession`'s pre-flight refuses every create once that host is within `PTY_DEVICE_HEADROOM`
 * of its own `kern.tty.ptmx_max` — which a machine running this app all day genuinely reaches (511
 * on macOS; this one sits in the 480s). Nothing below is about device pressure, so it is pinned
 * healthy rather than left to depend on who is running the suite and how many terminals they have
 * open. The pressure behaviour itself is tested in pty-spawn-preflight.test.ts.
 */
vi.mock('./pty-devices', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./pty-devices')>()),
  readPtyDevices: () => ({ ceiling: 511, inUse: 8 })
}))

describe('pty create: requireRemote never falls back to a local shell', () => {
  let fake: FakePlatform

  beforeEach(async () => {
    spawned.length = 0
    fake = fakePlatform()
    initPlatform(fake)
    const { PtyManager } = await import('./pty-manager')
    new PtyManager().registerIpc()
  })
  afterEach(() => {
    resetPlatformForTests()
  })

  const create = (clientId: number, options: Partial<PtyCreateOptions>) =>
    fake.handlers[IPC.ptyCreate](clientId, {
      cols: 80,
      rows: 24,
      persistKey: 'node-1',
      ...options
    }) as Promise<PtyCreateResult>

  it('refuses (spawning nothing) when the master is gone', async () => {
    const res = await create(ALICE, { requireRemote: true, cwd: '/srv/app' })

    expect(spawned).toHaveLength(0) // ← the whole point: no local shell wearing a remote node's id
    expect(res.unavailable).toBe('ssh')
    expect(res.sessionId).toBe('')
    expect(res.fresh).toBe(false) // nothing was created, so nothing is "cold"
  })

  it('without the flag the same options DO spawn locally (what used to happen silently)', async () => {
    const res = await create(ALICE, { cwd: '/srv/app' })

    expect(spawned).toHaveLength(1)
    expect(res.unavailable).toBeUndefined()
    expect(res.sessionId).not.toBe('')
  })

  it('still JOINS a live session for that node — only a fresh local spawn is refused', async () => {
    // The session is already running (it was created while the master was up). A second view —
    // the kanban card modal, another window — must attach to it: the session runs wherever it
    // runs, and refusing the join would break a perfectly healthy remote terminal.
    const first = await create(ALICE, {})
    const joined = await create(BOB, { requireRemote: true })

    expect(spawned).toHaveLength(1)
    expect(joined.unavailable).toBeUndefined()
    expect(joined.sessionId).toBe(first.sessionId)
  })
})
