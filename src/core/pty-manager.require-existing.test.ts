import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { initPlatform, resetPlatformForTests } from './platform'
import { fakePlatform, type FakePlatform } from './platform-fake'
import { IPC } from '../shared/ipc'
import type { PtyCreateOptions, PtyCreateResult } from '../shared/types'

/**
 * `requireExisting`: a cross-project PROJECTION (`open-agent --project <B>`) is a VIEWER of B's
 * tmux session, never its owner. Its `transport.create` carries `requireExisting: true`, and
 * `create()` must REFUSE — return `unavailable: 'no-session'` — rather than spawn a session for a
 * node it does not own. Spawning would steal pane ownership and run under the wrong project's
 * resolved cwd/account, which is exactly the `requireRemote` precedent (a create that would
 * silently land in the wrong context is refused) — only `requireExisting` is the stronger
 * "join OR refuse": there is no valid spawn branch for it at all, so the guard sits in `create`
 * after the join attempts are exhausted, not in `spawnNew` like `requireRemote`.
 *
 * This file is the sibling of `pty-require-remote.test.ts`: the same harness, the same IPC path,
 * asserting the refusal (never spawns) and the one ordering rule — a live session is still JOINED
 * (only a fresh spawn is refused), so a projection racing B's own spawn attaches rather than errors.
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

/**
 * A machine with pty devices to spare, always — same guard as `pty-require-remote.test.ts`. Without
 * it the real probe runs a `readdir('/dev')` against the developer's host and the pre-flight refuses
 * every create once that host nears its `kern.tty.ptmx_max` (511 on macOS; a dev box running this app
 * all day genuinely reaches the 480s). Nothing here is about device pressure.
 */
vi.mock('./pty-devices', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./pty-devices')>()),
  readPtyDevices: () => ({ ceiling: 511, inUse: 8 })
}))

const ALICE = 1
const BOB = 2

describe('pty create: requireExisting never spawns (only joins a live session)', () => {
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

  it('refuses (spawning nothing) when no live session exists', async () => {
    const res = await create(ALICE, { requireExisting: true, cwd: '/srv/app' })

    expect(spawned).toHaveLength(0) // ← the whole point: a projection never owns the session
    expect(res.unavailable).toBe('no-session')
    expect(res.sessionId).toBe('')
    expect(res.fresh).toBe(false) // nothing was created, so nothing is "cold"
  })

  it('distinguishes no-session from the ssh refusal (a different unavailable reason)', async () => {
    // The two `unavailable` values mean different things to the caller: 'ssh' is "the remote master
    // is down" (reconnect), 'no-session' is "the session is simply not live yet" (wait for B to
    // mount). A projection's plate branches on exactly this distinction.
    const res = await create(ALICE, { requireExisting: true, cwd: '/srv/app' })
    expect(res.unavailable).toBe('no-session')
    expect(res.unavailable).not.toBe('ssh')
  })

  it('still JOINS a live session for that node — only a fresh spawn is refused', async () => {
    // The session already runs (B mounted and spawned it). A second view — the projection in A — must
    // attach to it: refusing the join would make a perfectly healthy B terminal invisible in A.
    const first = await create(ALICE, {})
    const joined = await create(BOB, { requireExisting: true })

    expect(spawned).toHaveLength(1) // the first create spawned once; the projection joined, not spawned
    expect(joined.unavailable).toBeUndefined()
    expect(joined.sessionId).toBe(first.sessionId)
  })

  it('without the flag the same options DO spawn locally (what requireExisting prevents)', async () => {
    const res = await create(ALICE, { cwd: '/srv/app' })

    expect(spawned).toHaveLength(1)
    expect(res.unavailable).toBeUndefined()
    expect(res.sessionId).not.toBe('')
  })
})
