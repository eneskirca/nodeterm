import { describe, it, expect, beforeEach } from 'vitest'
import { WORKING_STALE_MS } from '@shared/agents/stale'
import {
  PARK_MAX,
  PARK_RECHECK_MS,
  armParkExpiry,
  canDisposePark,
  canDisposeParkedEntry,
  disposableParks,
  planParkEviction,
  type ParkedEntryState
} from './park-budget'

describe('planParkEviction', () => {
  it('returns nothing at or under the cap', () => {
    expect(planParkEviction(['a', 'b'], 2)).toEqual([])
    expect(planParkEviction([], 2)).toEqual([])
  })
  it('evicts the oldest entries beyond the cap, oldest first', () => {
    expect(planParkEviction(['a', 'b', 'c', 'd'], 2)).toEqual(['a', 'b'])
  })
  it('default cap is 12', () => {
    expect(PARK_MAX).toBe(12)
    const keys = Array.from({ length: 13 }, (_, i) => `k${i}`)
    expect(planParkEviction(keys, PARK_MAX)).toEqual(['k0'])
  })
  it('skips protected parks and takes the next disposable one instead', () => {
    // 'a' is protected → the cap is still met, by evicting the next-oldest disposable park.
    expect(planParkEviction(['a', 'b', 'c', 'd'], 2, (k) => k !== 'a')).toEqual(['b', 'c'])
  })
  it('lets the cap be exceeded rather than kill protected parks', () => {
    // Nothing disposable left: the plan is empty and the park runs over PARK_MAX. Documented
    // tradeoff — a cache overrun costs RAM, killing a plain shell costs the user's running work.
    expect(planParkEviction(['a', 'b', 'c', 'd'], 2, () => false)).toEqual([])
    expect(planParkEviction(['a', 'b', 'c', 'd'], 2, (k) => k === 'd')).toEqual(['d'])
  })
})

describe('canDisposePark', () => {
  it('protects a NON-tmux park whose agent is working/waiting/blocked', () => {
    for (const agentState of ['working', 'waiting', 'blocked'] as const) {
      expect(canDisposePark({ tmuxBacked: false, agentState })).toBe(false)
    }
  })
  it('disposes a non-tmux park whose agent is done', () => {
    expect(canDisposePark({ tmuxBacked: false, agentState: 'done' })).toBe(true)
  })
  it('disposes a non-tmux park with no agent at all (a plain terminal)', () => {
    expect(canDisposePark({ tmuxBacked: false })).toBe(true)
  })
  it('disposes a TMUX-backed park even while its agent works — the kill only detaches a client', () => {
    expect(canDisposePark({ tmuxBacked: true, agentState: 'working' })).toBe(true)
    expect(canDisposePark({ tmuxBacked: true, agentState: 'waiting' })).toBe(true)
  })
})

/**
 * THE REPRO, at the level the logic lives on.
 *
 * The park levers do not read a state, they read a REGISTRY of parked entries; so does the real
 * `parkDisposable` in TerminalNode. This fakes that registry and drives all three levers through
 * the same predicate they use in production, because the bug was never in any one lever — it was
 * in what they all read.
 *
 * Sequence: a plain-shell terminal parks while its agent is WORKING, then TerminalNode's departure
 * effect clears the node's agent status (the unmount that parks is the same unmount that clears),
 * so every later live read answers `undefined`.
 */
describe('a parked plain-shell agent survives the departure clear (#126)', () => {
  const registry = new Map<string, ParkedEntryState>()
  const disposable = (key: string): boolean => {
    const e = registry.get(key)
    return e ? canDisposeParkedEntry(e) : true
  }
  /** Park `key`, snapshotting the state the node had at that moment. */
  const park = (key: string, e: ParkedEntryState): void => void registry.set(key, e)
  /** What the departure effect does: the store forgets the node entirely. */
  const departureClear = (key: string): void => {
    const e = registry.get(key)
    if (e) registry.set(key, { ...e, liveAgentState: undefined })
  }

  beforeEach(() => registry.clear())

  it('LRU eviction: the just-parked working terminal is not evicted past the cap', () => {
    park('victim', { tmuxBacked: false, parkedAgentState: 'working', liveAgentState: 'working' })
    departureClear('victim')
    for (let i = 0; i < PARK_MAX; i++) park(`other${i}`, { tmuxBacked: true })
    // 13 parks against a cap of 12, oldest ('victim') first — the exact >PARK_MAX project switch.
    const plan = planParkEviction([...registry.keys()], PARK_MAX, disposable)
    expect(plan).not.toContain('victim')
    expect(plan).toEqual(['other0']) // the cap still holds, paid by the next-oldest disposable park
  })

  it('window expiry: re-arms instead of disposing, then disposes when the agent reports done', () => {
    park('victim', { tmuxBacked: false, parkedAgentState: 'working', liveAgentState: 'working' })
    departureClear('victim')
    const armed: Array<{ fn: () => void; ms: number }> = []
    let disposed = 0
    armParkExpiry(() => disposable('victim'), () => disposed++, 5000, {
      set: (fn, ms) => armed.push({ fn, ms }) - 1,
      clear: () => {}
    })
    armed[0].fn()
    expect(disposed).toBe(0)
    expect(armed[1].ms).toBe(PARK_RECHECK_MS)
    // A `done` hook event lands while the node is still parked — Canvas's listener is keyed by
    // node id, not by mount, so the store CAN learn this — and the live read overrides the floor.
    registry.set('victim', { ...registry.get('victim')!, liveAgentState: 'done' })
    armed[1].fn()
    expect(disposed).toBe(1)
  })

  it('memory-pressure lever: drops every other park and leaves this one', () => {
    park('victim', { tmuxBacked: false, parkedAgentState: 'working', liveAgentState: 'working' })
    departureClear('victim')
    park('plain', { tmuxBacked: false })
    park('tmux-working', { tmuxBacked: true, parkedAgentState: 'working' })
    expect(disposableParks([...registry.keys()], disposable)).toEqual(['plain', 'tmux-working'])
  })

  it('protects a WAITING park, which no later hook event would ever repopulate', () => {
    // `waiting`/`blocked` is a question held open for the user: the agent emits nothing more until
    // they answer, so the store clear is permanent and the snapshot is the ONLY evidence left.
    park('ask', { tmuxBacked: false, parkedAgentState: 'waiting', liveAgentState: 'waiting' })
    departureClear('ask')
    expect(disposable('ask')).toBe(false)
  })

  /**
   * The one bound the snapshot needs, because no sweep can supply it.
   *
   * A `working` snapshot outlives its evidence when the CLI dies without saying so (Esc mid-tool,
   * a killed process, a slept machine). Neither stale-working sweep can correct a PARKED node: the
   * renderer's matches `state === 'working'` and the departure clear already blanked the entry;
   * the core's fires an `onNodeStateChange` edge that never reaches the renderer's agent:status
   * IPC. Unaged, that park re-arms its expiry forever and permanently eats a PARK_MAX slot.
   */
  describe('the working snapshot ages out at WORKING_STALE_MS', () => {
    const parkedAt = 5_000_000
    const working: ParkedEntryState = { tmuxBacked: false, parkedAgentState: 'working', parkedAt }

    it('protects inside the window and releases past it', () => {
      expect(canDisposeParkedEntry(working, parkedAt + WORKING_STALE_MS)).toBe(false)
      expect(canDisposeParkedEntry(working, parkedAt + WORKING_STALE_MS + 1)).toBe(true)
    })

    it('keeps protecting a waiting snapshot past the same window', () => {
      const waiting: ParkedEntryState = { ...working, parkedAgentState: 'waiting' }
      expect(canDisposeParkedEntry(waiting, parkedAt + 10 * WORKING_STALE_MS)).toBe(false)
    })

    it('never ages a LIVE working reading — the live sweep owns that case', () => {
      // The store says it is working NOW, so the snapshot's age is irrelevant: this is a real
      // session mid-turn (and the renderer sweep CAN reach a node the store still knows about).
      expect(
        canDisposeParkedEntry({ ...working, liveAgentState: 'working' }, parkedAt + 10 * WORKING_STALE_MS)
      ).toBe(false)
    })
  })

  it('still disposes the cases that were always disposable, snapshot or not', () => {
    expect(canDisposeParkedEntry({ tmuxBacked: true, parkedAgentState: 'working' })).toBe(true)
    expect(canDisposeParkedEntry({ tmuxBacked: false, parkedAgentState: 'done' })).toBe(true)
    expect(canDisposeParkedEntry({ tmuxBacked: false })).toBe(true)
    // A live `done` overrides a `working` snapshot — the protection must not be one-way.
    expect(
      canDisposeParkedEntry({
        tmuxBacked: false,
        parkedAgentState: 'working',
        liveAgentState: 'done'
      })
    ).toBe(true)
  })
})

describe('disposableParks', () => {
  it('drops everything except the protected parks', () => {
    expect(disposableParks(['a', 'b', 'c'], (k) => k !== 'b')).toEqual(['a', 'c'])
    expect(disposableParks(['a', 'b'], () => true)).toEqual(['a', 'b'])
    expect(disposableParks(['a', 'b'], () => false)).toEqual([])
  })
})

describe('armParkExpiry', () => {
  /** Minimal injectable timer pair: fire(n) runs the nth armed callback. */
  function fakeTimers(): {
    timers: { set: (fn: () => void, ms: number) => number; clear: (h: number) => void }
    armed: Array<{ fn: () => void; ms: number; cleared: boolean }>
  } {
    const armed: Array<{ fn: () => void; ms: number; cleared: boolean }> = []
    return {
      armed,
      timers: {
        set: (fn, ms) => armed.push({ fn, ms, cleared: false }) - 1,
        clear: (h) => {
          armed[h].cleared = true
        }
      }
    }
  }

  it('disposes when the window expires and the park is disposable', () => {
    const { timers, armed } = fakeTimers()
    let disposed = 0
    armParkExpiry(() => true, () => disposed++, 5000, timers)
    expect(armed[0].ms).toBe(5000)
    armed[0].fn()
    expect(disposed).toBe(1)
    expect(armed).toHaveLength(1) // nothing re-armed
  })

  it('re-arms at PARK_RECHECK_MS instead of disposing while the park is protected', () => {
    const { timers, armed } = fakeTimers()
    let disposable = false
    let disposed = 0
    armParkExpiry(() => disposable, () => disposed++, 5000, timers)
    armed[0].fn()
    expect(disposed).toBe(0)
    expect(armed).toHaveLength(2)
    expect(armed[1].ms).toBe(PARK_RECHECK_MS)
    // Still protected → still re-checking, never leaked into a permanent park.
    armed[1].fn()
    expect(disposed).toBe(0)
    expect(armed[2].ms).toBe(PARK_RECHECK_MS)
    // The agent finished: the next re-check disposes for real.
    disposable = true
    armed[2].fn()
    expect(disposed).toBe(1)
    expect(armed).toHaveLength(3)
  })

  it('cancel() clears the timer currently armed, re-armed or not', () => {
    const { timers, armed } = fakeTimers()
    const t = armParkExpiry(() => false, () => {}, 5000, timers)
    armed[0].fn() // re-arm
    t.cancel()
    expect(armed[0].cleared).toBe(false) // already fired; the live one is the re-armed timer
    expect(armed[1].cleared).toBe(true)
  })
})
