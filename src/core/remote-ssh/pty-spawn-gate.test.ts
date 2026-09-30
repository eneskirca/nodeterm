import { describe, it, expect, vi } from 'vitest'
import {
  PtySpawnGate,
  REMOTE_PTY_SPAWN_CONCURRENCY,
  REMOTE_PTY_SPAWN_SETTLE_MS
} from './pty-spawn-gate'

/** A schedule seam whose timers only fire when the test says so. */
function fakeClock() {
  const timers: { fn: () => void; ms: number; cancelled: boolean }[] = []
  return {
    schedule: (fn: () => void, ms: number) => {
      const t = { fn, ms, cancelled: false }
      timers.push(t)
      return {
        cancel: () => {
          t.cancelled = true
        }
      }
    },
    fireAll: () => {
      for (const t of timers) if (!t.cancelled) t.fn()
    },
    pending: () => timers.filter((t) => !t.cancelled).length
  }
}

/** `acquire` awaits internally, so a pending `.then` needs more than one microtask turn. */
const tick = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

describe('PtySpawnGate', () => {
  it('lets the budget through at once and queues the rest', async () => {
    const clock = fakeClock()
    const gate = new PtySpawnGate(2, 5000, clock.schedule)
    const a = await gate.acquire('/cm/p1')
    await gate.acquire('/cm/p1')
    expect(gate.inFlight('/cm/p1')).toBe(2)

    let thirdIn = false
    const third = gate.acquire('/cm/p1').then((r) => {
      thirdIn = true
      return r
    })
    await tick()
    expect(thirdIn).toBe(false)
    expect(gate.queued('/cm/p1')).toBe(1)

    a()
    await third
    expect(thirdIn).toBe(true)
    // The permit is handed straight over: the count never dips below the limit mid-burst.
    expect(gate.inFlight('/cm/p1')).toBe(2)
  })

  it('hands a freed permit to an on-screen waiter before older background ones, FIFO within a class', async () => {
    const clock = fakeClock()
    const gate = new PtySpawnGate(1, 5000, clock.schedule)
    let release = await gate.acquire('/cm/p1')
    const order: string[] = []
    const wait = (name: string, background: boolean) =>
      gate.acquire('/cm/p1', { background }).then((r) => {
        order.push(name)
        return r
      })
    const bg1 = wait('bg1', true)
    const bg2 = wait('bg2', true)
    const vis1 = wait('vis1', false)
    const vis2 = wait('vis2', false)
    await tick()
    for (const p of [vis1, vis2, bg1, bg2]) {
      release()
      release = await p
    }
    expect(order).toEqual(['vis1', 'vis2', 'bg1', 'bg2'])
  })

  it('with no class given, stays the plain FIFO it was', async () => {
    const clock = fakeClock()
    const gate = new PtySpawnGate(1, 5000, clock.schedule)
    let release = await gate.acquire('/cm/p1')
    const order: string[] = []
    const ps = ['a', 'b', 'c'].map((n) => gate.acquire('/cm/p1').then((r) => (order.push(n), r)))
    await tick()
    for (const p of ps) {
      release()
      release = await p
    }
    expect(order).toEqual(['a', 'b', 'c'])
  })

  it('keeps hosts separate — one budget per ControlMaster, like MaxSessions itself', async () => {
    const clock = fakeClock()
    const gate = new PtySpawnGate(1, 5000, clock.schedule)
    await gate.acquire('/cm/p1')
    let second = false
    void gate.acquire('/cm/p2').then(() => (second = true))
    await tick()
    expect(second).toBe(true)
  })

  it('releases on the settle deadline, so a pty that never speaks cannot wedge the queue', async () => {
    // The rule that makes pacing terminals acceptable at all: a gate that can hang is worse than
    // no gate, because the failure it prevents is at least visible.
    const clock = fakeClock()
    const gate = new PtySpawnGate(1, 5000, clock.schedule)
    await gate.acquire('/cm/p1') // never released by the caller
    let next = false
    void gate.acquire('/cm/p1').then(() => (next = true))
    await tick()
    expect(next).toBe(false)
    clock.fireAll()
    await tick()
    expect(next).toBe(true)
  })

  it('release is idempotent — first output and the deadline both call it', async () => {
    const clock = fakeClock()
    const gate = new PtySpawnGate(1, 5000, clock.schedule)
    const release = await gate.acquire('/cm/p1')
    release()
    expect(gate.inFlight('/cm/p1')).toBe(0)
    release() // the deadline losing the race must be a no-op, not a second permit
    clock.fireAll()
    expect(gate.inFlight('/cm/p1')).toBe(0)
    // A released slot cancels its own deadline rather than leaving a timer behind per spawn.
    expect(clock.pending()).toBe(0)
  })

  it('paces a 107-node burst into waves instead of one flood', async () => {
    // The shape of the incident: one project switch, 107 remote sessions created at once.
    const clock = fakeClock()
    const gate = new PtySpawnGate(4, 5000, clock.schedule)
    let peak = 0
    const releases: (() => void)[] = []
    const all = Array.from({ length: 107 }, async () => {
      const r = await gate.acquire('/cm/p1')
      peak = Math.max(peak, gate.inFlight('/cm/p1'))
      releases.push(r)
      // Hand it straight back, as a first-output release would.
      r()
    })
    await Promise.all(all)
    expect(peak).toBe(4)
    expect(gate.queued('/cm/p1')).toBe(0)
  })

  it('ships a budget small enough to leave the host room for the terminals themselves', () => {
    expect(REMOTE_PTY_SPAWN_CONCURRENCY).toBeLessThan(10) // a stock sshd's MaxSessions
    expect(REMOTE_PTY_SPAWN_SETTLE_MS).toBeGreaterThan(1000)
  })
})
