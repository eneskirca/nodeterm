import { describe, it, expect, vi } from 'vitest'
import { createMemoryPressureMonitor, hostMemReader } from './memory-pressure'
import { readMemInfo } from './session-budget'

const mem = (availableMb: number, totalMb = 16000) => () => ({ availableMb, totalMb })

describe('memory pressure monitor', () => {
  it('classifies warning below 10% available and critical below 5%', () => {
    const on = vi.fn()
    const m = createMemoryPressureMonitor({ readMem: mem(1500), selfRssMb: () => 500, onPressure: on })
    expect(m.check()).toBe('warning')
    const c = createMemoryPressureMonitor({ readMem: mem(700), selfRssMb: () => 500, onPressure: on })
    expect(c.check()).toBe('critical')
  })
  it('a failed mem read is never pressure', () => {
    const m = createMemoryPressureMonitor({ readMem: () => null, selfRssMb: () => 500, onPressure: vi.fn() })
    expect(m.check()).toBeNull()
  })
  it('self-RSS still counts when the host read fails', () => {
    const m = createMemoryPressureMonitor({ readMem: () => null, selfRssMb: () => 9000, onPressure: vi.fn() })
    expect(m.check()).toBe('critical')
  })
  it('self-RSS thresholds fire independently of host memory', () => {
    const m = createMemoryPressureMonitor({ readMem: mem(8000), selfRssMb: () => 5000, onPressure: vi.fn() })
    expect(m.check()).toBe('warning')
    const c = createMemoryPressureMonitor({ readMem: mem(8000), selfRssMb: () => 9000, onPressure: vi.fn() })
    expect(c.check()).toBe('critical')
  })
  it('re-fires a severity at most once per 60s (floor)', () => {
    vi.useFakeTimers()
    const on = vi.fn()
    const m = createMemoryPressureMonitor({ readMem: mem(1500), selfRssMb: () => 0, intervalMs: 1000, onPressure: on })
    m.start()
    vi.advanceTimersByTime(3500)
    expect(on).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(60_000)
    expect(on).toHaveBeenCalledTimes(2)
    m.stop()
    vi.useRealTimers()
  })
  it('stop() ends the sweeps for good', () => {
    vi.useFakeTimers()
    const on = vi.fn()
    const m = createMemoryPressureMonitor({ readMem: mem(700), selfRssMb: () => 0, intervalMs: 1000, onPressure: on })
    m.start()
    vi.advanceTimersByTime(1000)
    expect(on).toHaveBeenCalledTimes(1)
    m.stop()
    vi.advanceTimersByTime(600_000)
    expect(on).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })
  it('the default host reader is SILENT on darwin (os.freemem there is vm_stat free_count)', () => {
    const read = hostMemReader('darwin')
    expect(read()).toBeNull()
    // Host leg silent → a healthy Mac is never classified from "free" memory…
    const quiet = createMemoryPressureMonitor({ readMem: read, selfRssMb: () => 500, onPressure: vi.fn() })
    expect(quiet.check()).toBeNull()
    // …but the self-RSS leg still carries the monitor on its own.
    const loud = createMemoryPressureMonitor({ readMem: read, selfRssMb: () => 9000, onPressure: vi.fn() })
    expect(loud.check()).toBe('critical')
  })
  it('the default host reader is the real one everywhere else', () => {
    expect(hostMemReader('linux')).toBe(readMemInfo)
    expect(hostMemReader('win32')).toBe(readMemInfo)
  })
  it('a throwing consumer does not break the monitor', () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let calls = 0
    const m = createMemoryPressureMonitor({
      readMem: mem(700),
      selfRssMb: () => 0,
      intervalMs: 1000,
      onPressure: () => {
        calls++
        throw new Error('destroyed window')
      }
    })
    m.start()
    expect(() => vi.advanceTimersByTime(1000)).not.toThrow()
    vi.advanceTimersByTime(61_000)
    expect(calls).toBe(2) // still firing after the throw
    m.stop()
    warn.mockRestore()
    vi.useRealTimers()
  })
})
