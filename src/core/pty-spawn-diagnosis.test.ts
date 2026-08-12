import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { initPlatform, resetPlatformForTests } from './platform'
import { fakePlatform, type FakePlatform } from './platform-fake'
import { IPC } from '../shared/ipc'
import type { PtyDevices } from './pty-devices'

/**
 * WHAT THE SPAWN FAILURE SAYS — the CATCH path, i.e. a spawn node-pty actually attempted and lost.
 *
 * node-pty reports every failure as a bare `posix_spawnp failed.` with the errno discarded, so the
 * error message is assembled from measurements taken after the fact. This pins the wiring: the
 * pty-DEVICE measurement actually reaches the message, and it replaces the generic
 * restart/rebuild advice rather than being appended to it (2026-08-11 — the machine was at
 * `kern.tty.ptmx_max`, and the message talked about architecture).
 *
 * The device numbers below therefore describe the machine AS MEASURED AFTER THE FAILURE. The other
 * way to be told the machine is full — the pre-flight refusing before node-pty is called at all —
 * is a different code path and lives in pty-spawn-preflight.test.ts. Keeping them apart matters:
 * once the pre-flight existed, a fixture that simply reads "exhausted" would be refused up front
 * and these tests would silently stop exercising the catch at all.
 */

/**
 * Every spawn in this file fails: the message is the whole subject. Counted, because "node-pty was
 * reached at all" is the one thing that distinguishes this file's path from the pre-flight's — and
 * a fixture drift that quietly routed these tests through the refusal instead would otherwise
 * still produce a passing, and identical, message.
 */
const attempts = vi.hoisted(() => ({ n: 0 }))
vi.mock('node-pty', () => ({
  spawn: () => {
    attempts.n++
    throw new Error('posix_spawnp failed.')
  }
}))

/** A machine with devices to spare — what the pre-flight must see so the spawn is attempted. */
const HEALTHY: PtyDevices = { ceiling: 511, inUse: 8 }

/** What the (real) device probe would have measured AFTER the failure — set per test. */
const devices = vi.hoisted(() => ({
  current: { ceiling: null, inUse: null } as PtyDevices,
  calls: 0
}))
vi.mock('./pty-devices', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./pty-devices')>()),
  // `spawnSession` reads the devices exactly twice per failing create: once for the pre-flight,
  // before node-pty, and once in the catch, after the failure. These tests are about the SECOND
  // read, so the first always answers "healthy" — otherwise an exhausted fixture would be refused
  // up front and node-pty would never be reached.
  readPtyDevices: () => (devices.calls++ % 2 === 0 ? HEALTHY : devices.current)
}))

const ALICE = 1

describe('spawn failure diagnosis', () => {
  let fake: FakePlatform

  beforeEach(() => {
    devices.current = { ceiling: null, inUse: null }
    devices.calls = 0
    attempts.n = 0
    fake = fakePlatform()
    initPlatform(fake)
  })
  afterEach(() => {
    // Every test here is about what a FAILED spawn says, so every test must have spawned.
    expect(attempts.n).toBeGreaterThan(0)
    resetPlatformForTests()
  })

  async function manager() {
    const { PtyManager } = await import('./pty-manager')
    const m = new PtyManager()
    m.registerIpc()
    return m
  }
  const create = (): Promise<unknown> =>
    fake.handlers[IPC.ptyCreate](ALICE, { cols: 80, rows: 24, persistKey: 'node-1' }) as Promise<
      unknown
    >

  it('still diagnoses a machine that only filled up DURING the spawn', async () => {
    await manager()
    // The pre-flight saw room (HEALTHY, above) and let the spawn through; by the time it failed,
    // the machine was at the wall. That is not a contrived ordering — it is the race the leak
    // creates, and the reason the catch keeps its own measurement instead of trusting the
    // pre-flight's. If the catch ever reused the earlier reading, this is the test that fails.
    devices.current = { ceiling: 511, inUse: 511 }

    await expect(create()).rejects.toThrow(/out of pty devices \(511 of 511/)
  })

  it('names the machine pty-device limit — with both numbers — when that is what is full', async () => {
    await manager()
    devices.current = { ceiling: 511, inUse: 515 }

    await expect(create()).rejects.toThrow(/out of pty devices \(515 of 511/)
  })

  it('says the pty limit INSTEAD of the rebuild advice, not alongside it', async () => {
    await manager()
    devices.current = { ceiling: 511, inUse: 515 }

    await expect(create()).rejects.toThrow(/kern\.tty\.ptmx_max/)
    await expect(create()).rejects.not.toThrow(/npm run rebuild/)
  })

  it('keeps the live-PTY / open-files context either way', async () => {
    await manager()
    devices.current = { ceiling: 511, inUse: 515 }

    await expect(create()).rejects.toThrow(/live PTYs: 0/)
  })

  it('falls back to the unchanged generic advice on a machine with pty devices to spare', async () => {
    await manager()
    devices.current = { ceiling: 511, inUse: 62 }

    await expect(create()).rejects.toThrow(/npm run rebuild/)
    await expect(create()).rejects.not.toThrow(/pty devices/)
  })
})
