import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createPowerGuard,
  linuxBatteryPercent,
  parsePmsetBatt,
  type PowerGuardDeps,
  type ThermalState
} from './keep-awake-power'
import { createKeepAwake } from './keep-awake'

function harness(over: Partial<{ onBattery: boolean; thermal: ThermalState; percent: number | null }> = {}) {
  const state = {
    onBattery: over.onBattery ?? false,
    thermal: (over.thermal ?? 'nominal') as ThermalState,
    percent: over.percent === undefined ? 80 : over.percent
  }
  const changes = { count: 0 }
  const logs: string[] = []
  const deps: PowerGuardDeps = {
    onBattery: () => state.onBattery,
    thermal: () => state.thermal,
    readPercent: async () => state.percent,
    onChange: () => void changes.count++,
    log: (m) => void logs.push(m),
    pollMs: 1000
  }
  return { guard: createPowerGuard(deps), state, changes, logs }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('power guard', () => {
  it('allows on AC whatever the battery level', async () => {
    const { guard, state } = harness({ onBattery: false, percent: 3 })
    await guard.refreshBattery()
    expect(guard.allows()).toBe(true)
    state.onBattery = true
    expect(guard.allows()).toBe(false)
  })

  it('blocks on battery below the floor, allows at the floor', async () => {
    const { guard, state } = harness({ onBattery: true, percent: 4 })
    await guard.refreshBattery()
    expect(guard.allows()).toBe(false)
    expect(guard.blockReason()).toMatch(/4%/)
    state.percent = 5
    await guard.refreshBattery()
    expect(guard.allows()).toBe(true)
  })

  it('fails open when the level cannot be read (null or a throwing reader)', async () => {
    const { guard } = harness({ onBattery: true, percent: null })
    await guard.refreshBattery()
    expect(guard.allows()).toBe(true)

    const throwing = createPowerGuard({
      onBattery: () => true,
      thermal: () => 'nominal',
      readPercent: async () => {
        throw new Error('pmset missing')
      },
      onChange: () => {},
      log: () => {}
    })
    await throwing.refreshBattery()
    expect(throwing.allows()).toBe(true)
  })

  it('blocks at critical heat and latches through serious, clearing at fair', () => {
    const { guard, state } = harness({ thermal: 'serious' })
    expect(guard.allows()).toBe(true) // serious alone does not block
    state.thermal = 'critical'
    expect(guard.allows()).toBe(false)
    state.thermal = 'serious'
    expect(guard.allows()).toBe(false) // latched — no flapping on the boundary
    state.thermal = 'fair'
    expect(guard.allows()).toBe(true)
    state.thermal = 'serious'
    expect(guard.allows()).toBe(true)
  })

  it('unknown thermal state never blocks', () => {
    const { guard } = harness({ thermal: 'unknown' })
    expect(guard.allows()).toBe(true)
  })

  it('notifies on refresh and logs only when the verdict changes', async () => {
    const { guard, state, changes, logs } = harness({ onBattery: true, percent: 3 })
    await guard.refreshBattery()
    await guard.refreshBattery()
    expect(changes.count).toBe(2)
    expect(logs.filter((l) => l.includes('letting the machine sleep'))).toHaveLength(1)
    state.onBattery = false
    guard.poke()
    expect(logs.some((l) => l.includes('cleared'))).toBe(true)
  })

  it('polls the level only while holding, and only on battery', async () => {
    vi.useFakeTimers()
    const reads = { count: 0 }
    const state = { onBattery: true }
    const guard = createPowerGuard({
      onBattery: () => state.onBattery,
      thermal: () => 'nominal',
      readPercent: async () => {
        reads.count++
        return 50
      },
      onChange: () => {},
      log: () => {},
      pollMs: 1000
    })
    vi.advanceTimersByTime(5000)
    expect(reads.count).toBe(0)
    guard.setHolding(true)
    expect(reads.count).toBe(1) // immediate read at hold start
    vi.advanceTimersByTime(2000)
    expect(reads.count).toBe(3)
    state.onBattery = false
    vi.advanceTimersByTime(2000)
    expect(reads.count).toBe(3) // on AC: no reads
    guard.setHolding(false)
    state.onBattery = true
    vi.advanceTimersByTime(5000)
    expect(reads.count).toBe(3)
    guard.dispose()
  })

  it('a disposed guard notifies nobody', async () => {
    const { guard, changes } = harness({ onBattery: true })
    guard.dispose()
    await guard.refreshBattery()
    guard.poke()
    expect(changes.count).toBe(0)
  })
})

describe('tracker + power guard', () => {
  it('releases the assertion when power stops allowing it, and re-holds when it allows again', () => {
    const calls = { start: 0, stop: 0 }
    const power = { ok: true }
    const tracker = createKeepAwake({
      blocker: { start: () => void calls.start++, stop: () => void calls.stop++ },
      enabled: () => true,
      isRemoteNode: () => false,
      powerAllows: () => power.ok,
      log: () => {}
    })
    tracker.onChange({ nodeId: 'a', event: 'start', state: 'working' })
    expect(tracker.holding()).toBe(true)
    power.ok = false
    tracker.refresh()
    expect(tracker.holding()).toBe(false)
    expect(calls.stop).toBe(1)
    // Still working: plugging in re-holds without a new edge.
    power.ok = true
    tracker.refresh()
    expect(tracker.holding()).toBe(true)
    expect(calls.start).toBe(2)
  })

  it('never asks power when nothing is working', () => {
    const asked = { count: 0 }
    const tracker = createKeepAwake({
      blocker: { start: () => {}, stop: () => {} },
      enabled: () => true,
      isRemoteNode: () => false,
      powerAllows: () => {
        asked.count++
        return true
      },
      log: () => {}
    })
    tracker.refresh()
    expect(asked.count).toBe(0)
  })
})

describe('parsePmsetBatt', () => {
  it('reads the internal battery percent', () => {
    const out = "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1234567)\t54%; discharging; 4:12 remaining present: true\n"
    expect(parsePmsetBatt(out)).toBe(54)
  })
  it('null on a desktop Mac (no internal battery line)', () => {
    expect(parsePmsetBatt("Now drawing from 'AC Power'\n")).toBeNull()
  })
  it('ignores a UPS line and reads only the internal battery', () => {
    const out = " -CP1500PFCLCD (id=1)\t100%; AC attached; not charging present: true\n -InternalBattery-0 (id=2)\t7%; discharging\n"
    expect(parsePmsetBatt(out)).toBe(7)
  })
})

describe('linuxBatteryPercent', () => {
  it('ignores peripheral batteries', () => {
    expect(
      linuxBatteryPercent([
        { type: 'Battery\n', scope: 'Device\n', capacity: '5\n' },
        { type: 'Mains\n' }
      ])
    ).toBeNull()
  })
  it('combines two system batteries by energy', () => {
    expect(
      linuxBatteryPercent([
        { type: 'Battery', energyNow: '10000000', energyFull: '40000000', capacity: '25' },
        { type: 'Battery', energyNow: '30000000', energyFull: '40000000', capacity: '75' }
      ])
    ).toBe(50)
  })
  it('averages capacity when energy is not reported', () => {
    expect(linuxBatteryPercent([{ type: 'Battery', capacity: '42\n' }])).toBe(42)
  })
  it('null when nothing usable', () => {
    expect(linuxBatteryPercent([{ type: 'Battery' }])).toBeNull()
    expect(linuxBatteryPercent([])).toBeNull()
  })
})
