import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import os from 'os'
import { initPlatform, resetPlatformForTests } from './platform'
import { fakePlatform, type FakePlatform } from './platform-fake'
import { IPC } from '../shared/ipc'
import type { PtyDevices } from './pty-devices'
import type { PtyCreateResult } from '../shared/types'

/**
 * THE SPAWN THAT IS NEVER ATTEMPTED.
 *
 * node-pty's darwin spawn path leaks the pty it opened when `posix_spawn` fails: `pty_posix_spawn`
 * (node_modules/node-pty/src/unix/pty.cc) opens the master with `posix_openpt` and the slave with
 * `open()`, and on the error branch `PtyFork` throws without closing either — measured at exactly 2
 * `/dev/ptmx` fds + 1 `/dev/ttys*` fd, i.e. 2 pty DEVICES, per failed spawn.
 *
 * That makes device exhaustion self-amplifying: at the ceiling every spawn fails, every failure
 * eats two more devices, and the ceiling gets further away (a 31-minute-old main held 479 masters
 * against 28 tmux panes). We cannot fix node-pty from here, so the fix is to stop feeding it: when
 * the machine is already out of devices, the spawn is refused BEFORE node-pty is called at all.
 *
 * The refusal is only ever allowed on a MEASURED reading. A wrong block is worse than a leak — it
 * would refuse terminals on a healthy machine — so anything unmeasured spawns as it always did.
 */

/**
 * Every node-pty call is recorded, because "was it called" is the whole subject here. It can also
 * be told to fail, so the one test that needs the CATCH path (proving the arch mock below is real)
 * can have it without a second file.
 */
const spawned: Array<{ file: string }> = []
const nodePty = vi.hoisted(() => ({ throws: false }))
vi.mock('node-pty', () => ({
  spawn: (file: string) => {
    spawned.push({ file })
    if (nodePty.throws) throw new Error('posix_spawnp failed.')
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

/** What the (real) device probe would have measured — set per test. */
const devices = vi.hoisted(() => ({
  current: { ceiling: null, inUse: null } as PtyDevices
}))
vi.mock('./pty-devices', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./pty-devices')>()),
  readPtyDevices: () => devices.current
}))

/**
 * Force `spawnHelperArchMismatch` to find a cross-arch spawn-helper.
 *
 * The arch note OUTRANKS the device note in `spawnFailureHint`, so on an ordinary matching-arch
 * host "the refusal does not mention the architecture" is true no matter what the refusal does —
 * the note is null either way. This makes the note non-null, so the assertion has something to
 * catch. `spawnHelperArchMismatch` is module-private; `./macho-arch` is the seam underneath it.
 */
vi.mock('./macho-arch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./macho-arch')>()),
  machOArch: () => 'x64' as const,
  archMismatch: () => true
}))

const ALICE = 1

describe('pty create: pre-flight device check', () => {
  let fake: FakePlatform

  beforeEach(async () => {
    spawned.length = 0
    nodePty.throws = false
    devices.current = { ceiling: null, inUse: null }
    fake = fakePlatform()
    initPlatform(fake)
    const { PtyManager } = await import('./pty-manager')
    new PtyManager().registerIpc()
  })
  afterEach(() => resetPlatformForTests())

  const create = (): Promise<PtyCreateResult> =>
    fake.handlers[IPC.ptyCreate](ALICE, {
      cols: 80,
      rows: 24,
      persistKey: 'node-1'
    }) as Promise<PtyCreateResult>

  it('never calls node-pty when the machine is out of pty devices', async () => {
    devices.current = { ceiling: 511, inUse: 515 }

    await expect(create()).rejects.toThrow()

    expect(spawned).toHaveLength(0) // ← the leak's only cure: the fd is never opened
  })

  it('still says exactly what is full, with both numbers', async () => {
    devices.current = { ceiling: 511, inUse: 515 }

    // The same sentence the post-failure diagnosis produces — one wording, one code path.
    await expect(create()).rejects.toThrow(/out of pty devices \(515 of 511/)
    await expect(create()).rejects.toThrow(/kern\.tty\.ptmx_max/)
  })

  // Both of these need `spawnHelperArchMismatch` to actually produce a note, which it only does on
  // darwin (it is a macOS-only diagnostic and returns null everywhere else). Skipped together, so
  // a non-darwin run cannot pass the suppression test vacuously while silently losing its guard.
  const onDarwin = os.platform() === 'darwin'

  it.skipIf(!onDarwin)(
    'proves the arch mock is live: a spawn that DID fail still gets the arch note',
    async () => {
      // The control for the test below. Without it, "the refusal omits the arch note" could pass
      // simply because the mock never took effect and there was no note to omit.
      nodePty.throws = true
      devices.current = { ceiling: 511, inUse: 62 } // healthy: the spawn is attempted, and fails

      await expect(create()).rejects.toThrow(/npm run rebuild/)
      expect(spawned).toHaveLength(1)
    }
  )

  it.skipIf(!onDarwin)('never blames the architecture for a refusal it decided itself', async () => {
    nodePty.throws = true // would fail if it were reached — it must not be
    devices.current = { ceiling: 511, inUse: 515 }

    // Same mismatched helper as the control above, but this spawn is refused before node-pty. The
    // arch note outranks the device note in `spawnFailureHint`, so consulting it here would tell a
    // merely-full machine to rebuild node-pty — advice that cannot help, about a helper this path
    // never exec'd.
    await expect(create()).rejects.toThrow(/out of pty devices/)
    await expect(create()).rejects.not.toThrow(/npm run rebuild/)
    await expect(create()).rejects.not.toThrow(/architecture/)
    expect(spawned).toHaveLength(0)
  })

  it('spawns normally on a machine with devices to spare', async () => {
    devices.current = { ceiling: 511, inUse: 62 }

    const res = await create()

    expect(res.sessionId).not.toBe('')
    expect(spawned).toHaveLength(1)
  })

  it('spawns normally when the devices could not be measured at all (non-darwin)', async () => {
    devices.current = { ceiling: null, inUse: null }

    await expect(create()).resolves.toBeTruthy()
    expect(spawned).toHaveLength(1)
  })

  it('spawns normally when only the ceiling is unknown (sysctl failed, or not primed yet)', async () => {
    // The ceiling is read asynchronously and cached; a spawn racing the very first read sees
    // `null` here. Fail-open: an unprimed cache must never look like a full machine.
    devices.current = { ceiling: null, inUse: 500 }

    await expect(create()).resolves.toBeTruthy()
    expect(spawned).toHaveLength(1)
  })
})
