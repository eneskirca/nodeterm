import { describe, it, expect, vi } from 'vitest'
import {
  classifyPtyPressure,
  createPtyPressureMonitor,
  readPtyPressure,
  PTY_PRESSURE_ELEVATED_RATIO,
  PTY_PRESSURE_INTERVAL_MS,
  PTY_PRESSURE_RE_ANNOUNCE_MS
} from './pty-pressure'
import { PTY_DEVICE_HEADROOM } from './pty-devices'

const devices = (inUse: number | null, ceiling: number | null = 500) => ({
  ceiling,
  inUse
})

describe('pty pressure classification', () => {
  it('is none well below the ceiling', () => {
    expect(classifyPtyPressure(devices(100))).toBe('none')
    expect(classifyPtyPressure(devices(399))).toBe('none')
  })

  it('turns elevated exactly at the documented ratio of the ceiling', () => {
    expect(PTY_PRESSURE_ELEVATED_RATIO).toBe(0.8)
    expect(classifyPtyPressure(devices(400))).toBe('elevated') // 0.8 × 500
    expect(classifyPtyPressure(devices(401))).toBe('elevated')
  })

  it('turns critical at the SAME line the spawn diagnosis calls exhausted', () => {
    expect(classifyPtyPressure(devices(500 - PTY_DEVICE_HEADROOM))).toBe('critical')
    expect(classifyPtyPressure(devices(500 - PTY_DEVICE_HEADROOM - 1))).toBe('elevated')
    expect(classifyPtyPressure(devices(600))).toBe('critical') // already past it
  })

  it('critical wins on a ceiling so small the two bands overlap', () => {
    // ceiling 10: elevated line is 8, critical line is 6 — 8 is BOTH, and the worse one must win.
    expect(classifyPtyPressure(devices(8, 10))).toBe('critical')
  })

  it('an unmeasured ceiling or count is none, never a guess', () => {
    expect(classifyPtyPressure(devices(400, null))).toBe('none')
    expect(classifyPtyPressure(devices(null, 500))).toBe('none')
    expect(classifyPtyPressure(devices(null, null))).toBe('none')
  })

  it('readPtyPressure carries the numbers the banner prints alongside the level', () => {
    expect(readPtyPressure(() => devices(450))).toEqual({
      level: 'elevated',
      usage: 450,
      ceiling: 500
    })
    expect(readPtyPressure(() => devices(null, null))).toEqual({
      level: 'none',
      usage: null,
      ceiling: null
    })
  })
})

describe('pty pressure monitor', () => {
  const monitor = (readings: Array<ReturnType<typeof devices>>, onLevel: (p: any) => void) => {
    let i = 0
    return createPtyPressureMonitor({
      read: () => readings[Math.min(i++, readings.length - 1)],
      intervalMs: 1000,
      onLevel
    })
  }

  it('says nothing while the machine is healthy', () => {
    vi.useFakeTimers()
    const on = vi.fn()
    const m = monitor([devices(100)], on)
    m.start()
    vi.advanceTimersByTime(10_000)
    expect(on).not.toHaveBeenCalled()
    m.stop()
    vi.useRealTimers()
  })

  it('broadcasts on the transition into a level, then stays quiet while it holds', () => {
    vi.useFakeTimers()
    const on = vi.fn()
    const m = monitor([devices(450)], on)
    m.start()
    vi.advanceTimersByTime(5000)
    expect(on).toHaveBeenCalledTimes(1)
    expect(on).toHaveBeenCalledWith({
      level: 'elevated',
      usage: 450,
      ceiling: 500
    })
    m.stop()
    vi.useRealTimers()
  })

  it('re-announces a held level at most once per re-announce window', () => {
    vi.useFakeTimers()
    const on = vi.fn()
    const m = monitor([devices(450)], on)
    m.start()
    vi.advanceTimersByTime(1000)
    expect(on).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(PTY_PRESSURE_RE_ANNOUNCE_MS - 2000)
    expect(on).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(2000)
    expect(on).toHaveBeenCalledTimes(2)
    m.stop()
    vi.useRealTimers()
  })

  it('a worsening level is reported immediately, not held for the window', () => {
    vi.useFakeTimers()
    const on = vi.fn()
    const m = monitor([devices(450), devices(497)], on)
    m.start()
    vi.advanceTimersByTime(1000)
    vi.advanceTimersByTime(1000)
    expect(on).toHaveBeenCalledTimes(2)
    expect(on).toHaveBeenLastCalledWith({
      level: 'critical',
      usage: 497,
      ceiling: 500
    })
    m.stop()
    vi.useRealTimers()
  })

  it('reports the drop back to none ONCE so the banner clears, then holds its tongue', () => {
    vi.useFakeTimers()
    const on = vi.fn()
    const m = monitor([devices(497), devices(100)], on)
    m.start()
    vi.advanceTimersByTime(1000)
    vi.advanceTimersByTime(1000)
    expect(on).toHaveBeenCalledTimes(2)
    expect(on).toHaveBeenLastCalledWith({
      level: 'none',
      usage: 100,
      ceiling: 500
    })
    vi.advanceTimersByTime(PTY_PRESSURE_RE_ANNOUNCE_MS * 2)
    expect(on).toHaveBeenCalledTimes(2) // "none" is never re-announced
    m.stop()
    vi.useRealTimers()
  })

  it('announce() force-fires a reading and takes over the dedupe state', () => {
    vi.useFakeTimers()
    const on = vi.fn()
    const m = monitor([devices(497)], on)
    m.start()
    vi.advanceTimersByTime(1000)
    expect(on).toHaveBeenCalledTimes(1)
    // The fix handler re-broadcasts through the SAME funnel, so the next tick must not repeat it.
    m.announce({ level: 'none', usage: 497, ceiling: 4096 })
    expect(on).toHaveBeenCalledTimes(2)
    expect(on).toHaveBeenLastCalledWith({
      level: 'none',
      usage: 497,
      ceiling: 4096
    })
    vi.advanceTimersByTime(1000)
    // The reader still says critical, which is now a CHANGE from the adopted 'none' → one fire.
    expect(on).toHaveBeenCalledTimes(3)
    vi.advanceTimersByTime(1000)
    expect(on).toHaveBeenCalledTimes(3) // …and then it holds again
    m.stop()
    vi.useRealTimers()
  })

  it('a throwing consumer does not break the monitor', () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let calls = 0
    const m = createPtyPressureMonitor({
      read: () => devices(497),
      intervalMs: 1000,
      onLevel: () => {
        calls++
        throw new Error('destroyed window')
      }
    })
    m.start()
    expect(() => vi.advanceTimersByTime(1000)).not.toThrow()
    vi.advanceTimersByTime(PTY_PRESSURE_RE_ANNOUNCE_MS)
    expect(calls).toBe(2) // still firing after the throw
    m.stop()
    warn.mockRestore()
    vi.useRealTimers()
  })

  it('stop() ends the checks for good', () => {
    vi.useFakeTimers()
    const on = vi.fn()
    const m = monitor([devices(497)], on)
    m.start()
    vi.advanceTimersByTime(1000)
    m.stop()
    vi.advanceTimersByTime(600_000)
    expect(on).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })

  it('defaults to a one-minute cadence', () => {
    expect(PTY_PRESSURE_INTERVAL_MS).toBe(60_000)
    expect(PTY_PRESSURE_RE_ANNOUNCE_MS).toBe(300_000)
  })
})
