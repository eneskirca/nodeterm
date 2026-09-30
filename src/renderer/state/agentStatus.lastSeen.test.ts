import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { buildHibernationCandidates } from '../lib/hibernationCandidates'
import { planHibernation } from '../terminal/hibernation-policy'
import { shouldDeferReleaseForEco } from '../terminal/offscreen-policy'
import { buildStatusList } from '../lib/sessionList'

// The persisted "last seen" clock (`AgentNodeStatus.lastSeen`): restored across an app restart as a
// CLOCK that orders and ages sidebar rows — never as a live state, never as Eco's idle clock. It
// lives under its OWN key so a hook event never rewrites the main status table.

function memStorage(seed: Record<string, string> = {}): Storage {
  const m = new Map(Object.entries(seed))
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
    key: () => null,
    get length() {
      return m.size
    }
  } as Storage
}

const KEY = 'nodeterm.agentStatus'
const CLOCK_KEY = 'nodeterm.agentStatus.lastSeen'
const HOUR = 3600_000

function seeded(main: Record<string, unknown>, clocks: Record<string, unknown>): Storage {
  return memStorage({ [KEY]: JSON.stringify(main), [CLOCK_KEY]: JSON.stringify(clocks) })
}

beforeEach(() => vi.resetModules())
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

/** Run one app "session": import a fresh store over `storage`. */
async function boot(storage: Storage): Promise<typeof import('./agentStatus')> {
  vi.resetModules()
  vi.stubGlobal('localStorage', storage)
  return import('./agentStatus')
}

describe('lastSeen survives a restart as a clock, not a state', () => {
  it('persist → new store: the clock and its state come back marked restored; live state and idle clock do not', async () => {
    vi.useFakeTimers()
    const storage = memStorage()
    const run1 = await boot(storage)
    run1.useAgentStatus.getState().setState('a', 'working', 'claude')
    vi.advanceTimersByTime(1000)
    run1.useAgentStatus.getState().setState('a', 'done', 'claude')
    vi.advanceTimersByTime(run1.LAST_SEEN_SAVE_DEBOUNCE_MS + 10)
    const doneAt = run1.useAgentStatus.getState().byId['a'].lastEventAt!
    // Only the two fields go to disk, under the clock key; the main table carries no clock.
    expect(JSON.parse(storage.getItem(CLOCK_KEY)!)).toEqual({ a: { at: doneAt, state: 'done' } })
    expect(storage.getItem(KEY)).toBeNull()

    const run2 = await boot(storage)
    const st = run2.useAgentStatus.getState().byId['a']
    expect(st.lastSeen).toEqual({ at: doneAt, state: 'done', restored: true })
    expect(st.state).toBeUndefined()
    expect(st.lastEventAt).toBeUndefined()
    expect(st.stateAt).toBeUndefined()
  })

  it('a long burst of hook events writes the clock key ONCE (trailing debounce) and never the main table', async () => {
    vi.useFakeTimers()
    const storage = memStorage()
    const spy = vi.spyOn(storage, 'setItem')
    const run1 = await boot(storage)
    const s = run1.useAgentStatus.getState()
    s.setState('b', 'working', 'claude')
    // 2 Hz for 10 s — a busy turn's tool events.
    for (let i = 0; i < 20; i++) {
      vi.advanceTimersByTime(500)
      s.setState('b', 'working', 'claude')
    }
    expect(spy).not.toHaveBeenCalled()
    vi.advanceTimersByTime(run1.LAST_SEEN_SAVE_DEBOUNCE_MS + 10)
    expect(spy.mock.calls.map((c) => c[0])).toEqual([CLOCK_KEY])
    const saved = JSON.parse(storage.getItem(CLOCK_KEY)!)
    expect(saved.b.at).toBe(run1.useAgentStatus.getState().byId['b'].stateAt)
    expect(storage.getItem(KEY)).toBeNull() // state events still write nothing to the main table
  })

  it('a canvas that is never quiet still persists within the max wait', async () => {
    vi.useFakeTimers()
    const storage = memStorage()
    const spy = vi.spyOn(storage, 'setItem')
    const run1 = await boot(storage)
    const s = run1.useAgentStatus.getState()
    s.setState('c', 'working', 'claude')
    const steps = Math.ceil(run1.LAST_SEEN_SAVE_MAX_WAIT_MS / 1000) + 1
    for (let i = 0; i < steps; i++) {
      vi.advanceTimersByTime(1000)
      s.setState('c', 'working', 'claude')
    }
    expect(spy.mock.calls.filter((c) => c[0] === CLOCK_KEY)).toHaveLength(1)
    expect(spy.mock.calls.some((c) => c[0] === KEY)).toBe(false)
  })

  it('remove() drops the clock with the node at once, and a pending debounce cannot resurrect it', async () => {
    vi.useFakeTimers()
    const storage = memStorage()
    const run1 = await boot(storage)
    run1.useAgentStatus.getState().setState('c', 'done', 'claude')
    vi.advanceTimersByTime(run1.LAST_SEEN_SAVE_DEBOUNCE_MS + 10)
    expect(JSON.parse(storage.getItem(CLOCK_KEY)!).c).toBeDefined()
    run1.useAgentStatus.getState().setState('c', 'working', 'claude') // arms a debounce
    run1.useAgentStatus.getState().remove('c')
    expect(JSON.parse(storage.getItem(CLOCK_KEY)!).c).toBeUndefined()
    vi.advanceTimersByTime(run1.LAST_SEEN_SAVE_MAX_WAIT_MS)
    expect(JSON.parse(storage.getItem(CLOCK_KEY)!).c).toBeUndefined()
    const run2 = await boot(storage)
    expect(run2.useAgentStatus.getState().byId['c']).toBeUndefined()
  })

  it('bounds the persisted clocks to the newest LAST_SEEN_MAX', async () => {
    const { lastSeenKeep, LAST_SEEN_MAX } = await boot(memStorage())
    const byId: Record<string, { lastSeen?: { at: number } }> = {}
    for (let i = 0; i < LAST_SEEN_MAX + 5; i++) byId[`n${i}`] = { lastSeen: { at: 1_000 + i } }
    byId.none = {}
    const keep = lastSeenKeep(byId)
    expect(keep.size).toBe(LAST_SEEN_MAX)
    for (let i = 0; i < 5; i++) expect(keep.has(`n${i}`)).toBe(false) // oldest dropped
    expect(keep.has(`n${LAST_SEEN_MAX + 4}`)).toBe(true)
    expect(keep.has('none')).toBe(false)
  })
})

describe('the first event after a restart (SessionStart of a cold-restore resume)', () => {
  it('drops the restored mark, re-renders so the row re-sorts, and leaves the idle clock unknown', async () => {
    const now = Date.now()
    const storage = seeded(
      { r: { agentId: 'claude', sessionId: 's' } },
      { r: { at: now - 5 * HOUR, state: 'done' } }
    )
    const { useAgentStatus } = await boot(storage)
    const before = useAgentStatus.getState().byId
    // A SessionStart normalizes to `state: undefined` — same-state for a restored entry.
    useAgentStatus.getState().setState('r', undefined, 'claude')
    const after = useAgentStatus.getState().byId
    expect(after).not.toBe(before) // a new table: subscribers (the sidebar) re-sort now
    expect(after.r.lastSeen?.restored).toBeUndefined()
    expect(Date.now() - after.r.lastSeen!.at).toBeLessThan(5000)
    expect(after.r.lastEventAt).toBeUndefined() // an unknown state is not an idle one
    expect(after.r.sessionId).toBe('s')

    const project = {
      id: 'p',
      name: 'P',
      color: '#fff',
      nodes: [{ id: 'r', kind: 'terminal' as const, title: 'r', color: '#fff', agentId: 'claude' as const }]
    }
    const row = buildStatusList([project], null, 'p', after, '').flatMap((g) => g.rows)[0]
    expect(row.statusClock).toBe('seen') // NOT "before nodeterm restarted"
    const { sessionStateAgeTitle } = await import('../lib/sessionList')
    expect(sessionStateAgeTitle('seen just now', row.statusClock)).not.toMatch(/restarted/)
  })
})

describe('hostile / corrupt persisted values', () => {
  const now = Date.UTC(2026, 8, 30)
  it('readLastSeen refuses what is not a sane past clock', async () => {
    const { readLastSeen, LAST_SEEN_MAX_AGE_MS, LAST_SEEN_FUTURE_SLACK_MS } = await boot(memStorage())
    for (const bad of [
      null,
      undefined,
      42,
      'x',
      [],
      {},
      { at: 'yesterday' },
      { at: NaN },
      { at: Infinity },
      { at: -5 },
      { at: 0 },
      { at: now + LAST_SEEN_FUTURE_SLACK_MS + 1 }, // future: would pin a row to the top
      { at: now - LAST_SEEN_MAX_AGE_MS - 1 }
    ]) {
      expect(readLastSeen(bad, now)).toBeUndefined()
    }
    // Unknown state: keep the time, drop the state. Prototype names are not states. A forged
    // `restored` never comes through (the loader sets it itself).
    expect(readLastSeen({ at: now - HOUR, state: 'constructor' }, now)).toEqual({ at: now - HOUR })
    expect(readLastSeen({ at: now - HOUR, state: 7 }, now)).toEqual({ at: now - HOUR })
    expect(readLastSeen({ at: now - HOUR, state: 'blocked', extra: 1, restored: 'no' }, now)).toEqual({
      at: now - HOUR,
      state: 'blocked'
    })
  })

  it('a corrupt clock never breaks the load of the table or its neighbours, and never becomes a state', async () => {
    const storage = seeded(
      { good: { unread: true }, badClock: { sessionId: 's', state: 'working', lastEventAt: 1 } },
      {
        good: { at: Date.now() - HOUR, state: 'working' },
        nullEntry: null,
        numEntry: 5,
        badClock: { at: 'soon', state: 'done' }
      }
    )
    const { useAgentStatus } = await boot(storage)
    const byId = useAgentStatus.getState().byId
    expect(byId.good.unread).toBe(true)
    expect(byId.good.lastSeen?.state).toBe('working')
    expect(byId.good.state).toBeUndefined() // a restored "working" is not a live one
    expect(byId.badClock.sessionId).toBe('s')
    expect(byId.badClock.lastSeen).toBeUndefined()
    expect(byId.badClock.state).toBeUndefined()
    expect(byId.badClock.lastEventAt).toBeUndefined()
    expect(byId.nullEntry).toBeUndefined()
    expect(byId.numEntry).toBeUndefined()
  })

  it('an unparseable or non-object clock key costs the clocks only', async () => {
    for (const raw of ['{not json', '"hello"', '[1,2]', 'null']) {
      const { useAgentStatus } = await boot(
        memStorage({ [KEY]: JSON.stringify({ k: { unread: true } }), [CLOCK_KEY]: raw })
      )
      expect(useAgentStatus.getState().byId).toEqual({ k: { unread: true } })
    }
  })

  it('a non-object main table loads as empty', async () => {
    const { useAgentStatus } = await boot(memStorage({ [KEY]: '"hello"' }))
    expect(useAgentStatus.getState().byId).toEqual({})
  })
})

describe('Eco stays inert for a restored clock', () => {
  const nodes = [{ id: 'e', agentId: 'claude' }]
  const base = {
    nodes,
    subagents: [],
    isOffscreen: () => true,
    isWired: () => true,
    isRemote: () => false
  }
  const cfg = { enabled: true, idleMinutes: 30 }

  it('a status restored from disk (lastSeen done, hours old) is never a candidate', async () => {
    const { useAgentStatus } = await boot(
      seeded({ e: { agentId: 'claude', sessionId: 'sess' } }, { e: { at: Date.now() - 6 * HOUR, state: 'done' } })
    )
    const st = useAgentStatus.getState().byId['e']
    const rows = buildHibernationCandidates({ ...base, statusById: { e: st } })
    expect(rows[0].lastEventAt).toBeUndefined()
    expect(rows[0].state).toBeUndefined()
    expect(planHibernation(rows, Date.now(), cfg)).toEqual([])
    // Nor does it hold its viewer waiting for a hibernation that cannot come.
    expect(
      shouldDeferReleaseForEco({
        ecoEnabled: true,
        resumableAgent: true,
        hibernated: false,
        idleKnown: st.lastEventAt !== undefined,
        offscreenElapsedMs: HOUR,
        idleMinutes: 30,
        offscreenMinutes: 10
      })
    ).toBe(false)
  })

  it('pins why neither field may be restored: fed a guessed done + the old clock, the plan WOULD exit it', () => {
    const guessed = buildHibernationCandidates({
      ...base,
      statusById: { e: { state: 'done', sessionId: 's', lastEventAt: Date.now() - 6 * HOUR } }
    })
    expect(planHibernation(guessed, Date.now(), cfg)).toEqual(['e'])
    const restored = buildHibernationCandidates({ ...base, statusById: { e: { sessionId: 's' } } })
    expect(planHibernation(restored, Date.now(), cfg)).toEqual([])
  })

  it('the first live done after boot starts the idle window from NOW, not from the restored clock', async () => {
    const { useAgentStatus } = await boot(
      seeded({ e: { agentId: 'claude', sessionId: 's' } }, { e: { at: Date.now() - 6 * HOUR, state: 'done' } })
    )
    useAgentStatus.getState().setState('e', 'done', 'claude')
    const st = useAgentStatus.getState().byId['e']
    const rows = buildHibernationCandidates({ ...base, statusById: { e: st } })
    expect(planHibernation(rows, Date.now(), cfg)).toEqual([])
    expect(planHibernation(rows, Date.now() + 31 * 60_000, cfg)).toEqual(['e'])
  })
})

describe('sidebar ordering and age label', () => {
  it('orders rows by the restored clock and labels it as from before the restart', async () => {
    const now = Date.now()
    const { useAgentStatus } = await boot(
      seeded(
        { old: { agentId: 'claude' }, recent: { agentId: 'claude' } },
        {
          old: { at: now - 5 * HOUR, state: 'done' },
          recent: { at: now - 1 * HOUR, state: 'working' },
          // A clock for a node that no longer exists on any canvas: it must not make a row.
          ghost: { at: now - 60_000, state: 'done' }
        }
      )
    )
    const { sessionStateAgeLabel, sessionStateAgeTitle } = await import('../lib/sessionList')
    const project = {
      id: 'p',
      name: 'P',
      color: '#fff',
      nodes: [
        { id: 'noClock', kind: 'terminal' as const, title: 'a-no-clock', color: '#fff', agentId: 'claude' as const },
        { id: 'old', kind: 'terminal' as const, title: 'b-old', color: '#fff', agentId: 'claude' as const },
        { id: 'recent', kind: 'terminal' as const, title: 'c-recent', color: '#fff', agentId: 'claude' as const }
      ]
    }
    const groups = buildStatusList([project], null, 'p', useAgentStatus.getState().byId, '')
    const unknown = groups.find((g) => g.kind === 'unknown')!
    expect(unknown.rows.map((r) => r.id)).toEqual(['recent', 'old', 'noClock'])
    expect(groups.flatMap((g) => g.rows).some((r) => r.id === 'ghost')).toBe(false)
    const recent = unknown.rows[0]
    expect(recent.statusClock).toBe('restored')
    expect(recent.lastSeenState).toBe('working')
    expect(recent.statusKind).toBe('unknown') // the restored state is display-only
    const label = sessionStateAgeLabel(recent.statusUpdatedAt, now, recent.statusClock)
    expect(label).toBe('seen 1h ago')
    expect(sessionStateAgeTitle(label!, 'restored', 'working')).toMatch(/before nodeterm restarted/)
    expect(sessionStateAgeTitle(label!, 'restored', 'working')).toMatch(/Running/)
    // A live transition wins.
    useAgentStatus.getState().setState('old', 'done', 'claude')
    const after = buildStatusList([project], null, 'p', useAgentStatus.getState().byId, '')
    const oldRow = after.flatMap((g) => g.rows).find((r) => r.id === 'old')!
    expect(oldRow.statusClock).toBe('transition')
    expect(sessionStateAgeLabel(oldRow.statusUpdatedAt, Date.now(), oldRow.statusClock)).toBe('just now')
  })
})
