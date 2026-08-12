import { describe, expect, it } from 'vitest'
import os from 'os'
import {
  PTY_DEVICE_HEADROOM,
  invalidatePtyCeiling,
  ptyDevicesExhausted,
  readPtyDevices,
  spawnFailureHint
} from './pty-devices'

/**
 * The 2026-08-11 report: every new terminal spawned black with `posix_spawnp failed.` while the
 * spawn-helper's architecture was fine and the process was nowhere near its descriptor limit. What
 * was actually full was the MACHINE: `kern.tty.ptmx_max` is 511 and there were 515 `/dev/ttys*`
 * devices. The message named the architecture anyway — the one hint that could not be the cause —
 * and the user rebuilt node-pty for the third time.
 *
 * What is pinned here is the ORDER of the hints and the fact that the pty-device hint is only
 * spoken when the two numbers say so.
 */
const GENERIC = 'If this persists, restart the app.'

describe('ptyDevicesExhausted', () => {
  it('is true when the device count has reached the ceiling', () => {
    expect(ptyDevicesExhausted({ ceiling: 511, inUse: 515 })).toBe(true)
    expect(ptyDevicesExhausted({ ceiling: 511, inUse: 511 })).toBe(true)
  })

  it('counts "a handful below the ceiling" as full', () => {
    // A terminal needs a device to spare; the failure lands before the count is literally equal.
    expect(ptyDevicesExhausted({ ceiling: 511, inUse: 511 - PTY_DEVICE_HEADROOM })).toBe(true)
    expect(ptyDevicesExhausted({ ceiling: 511, inUse: 511 - PTY_DEVICE_HEADROOM - 1 })).toBe(false)
  })

  it('is false on a machine with room, and on one it could not measure', () => {
    expect(ptyDevicesExhausted({ ceiling: 511, inUse: 62 })).toBe(false)
    expect(ptyDevicesExhausted({ ceiling: null, inUse: 515 })).toBe(false)
    expect(ptyDevicesExhausted({ ceiling: 511, inUse: null })).toBe(false)
    expect(ptyDevicesExhausted({ ceiling: null, inUse: null })).toBe(false)
  })
})

describe('spawnFailureHint', () => {
  it('names the pty-device limit — with both numbers — when the machine is out of devices', () => {
    const hint = spawnFailureHint(null, { ceiling: 511, inUse: 515 }, GENERIC)
    expect(hint).toContain('511')
    expect(hint).toContain('515')
    expect(hint).toContain('kern.tty.ptmx_max')
    expect(hint).toContain('close some terminals')
    // INSTEAD of, not in addition to: the generic advice is what sent the last report chasing a
    // rebuild, and it is exactly as wrong here as the architecture hint would be.
    expect(hint).not.toContain(GENERIC)
  })

  it('lets the architecture mismatch win — it is the one thing we MEASURED about this build', () => {
    const arch = "node-pty's spawn-helper is x86_64 but this app is arm64"
    const hint = spawnFailureHint(arch, { ceiling: 511, inUse: 515 }, GENERIC)
    expect(hint).toBe(arch)
  })

  it('falls back to the generic text when neither check fires', () => {
    expect(spawnFailureHint(null, { ceiling: 511, inUse: 62 }, GENERIC)).toBe(GENERIC)
    expect(spawnFailureHint(null, { ceiling: null, inUse: null }, GENERIC)).toBe(GENERIC)
  })
})

describe('readPtyDevices', () => {
  it('measures this machine without throwing', () => {
    // It runs INSIDE an error path: a diagnostic that throws replaces a bad error message with no
    // error message at all. The numbers are the machine's, so only their shape is asserted.
    const d = readPtyDevices()
    expect(d.inUse === null || d.inUse > 0).toBe(true)
    expect(d.ceiling === null || d.ceiling > 0).toBe(true)
    // Off darwin there is no `kern.tty.ptmx_max` and no `/dev/ttys*` convention to count: the
    // diagnostic says nothing rather than counting the wrong thing.
    if (os.platform() !== 'darwin') expect(d).toEqual({ ceiling: null, inUse: null })
  })

  it('invalidatePtyCeiling makes the next read re-measure instead of trusting the cache', () => {
    // The "Fix automatically…" button changes `kern.tty.ptmx_max` under us; the cached value would
    // otherwise keep the banner up for another minute after the machine was already fixed.
    expect(() => invalidatePtyCeiling()).not.toThrow()
    const d = readPtyDevices()
    expect(d.ceiling === null || d.ceiling > 0).toBe(true)
  })
})
