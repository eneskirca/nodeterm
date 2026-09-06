import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'

// The store binds localStorage at import time, so each test stubs a fresh in-memory
// storage and re-imports the module (vi.resetModules) to exercise load()/save().
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

beforeEach(() => vi.resetModules())
afterEach(() => vi.unstubAllGlobals())

describe('loop persistence (cron/schedule survive an app restart)', () => {
  it('persists an active loop to localStorage and drops it on setLoop(false)', async () => {
    const store = memStorage()
    vi.stubGlobal('localStorage', store)
    const { useAgentStatus } = await import('./agentStatus')
    useAgentStatus.getState().setLoop('n1', true, 'cron', { schedule: '0 9 * * *', task: 'daily report' })
    let saved = JSON.parse(store.getItem('nodeterm.agentStatus')!)
    expect(saved.n1.loop).toMatchObject({ kind: 'cron', schedule: '0 9 * * *', task: 'daily report' })
    useAgentStatus.getState().setLoop('n1', false)
    saved = JSON.parse(store.getItem('nodeterm.agentStatus') ?? '{}')
    expect(saved.n1?.loop).toBeUndefined()
  })

  it('restores a persisted cron loop on load', async () => {
    vi.stubGlobal(
      'localStorage',
      memStorage({
        'nodeterm.agentStatus': JSON.stringify({
          n2: { unread: false, loop: { count: 3, kind: 'cron', schedule: '*/5 * * * *', task: 't', items: [] } }
        })
      })
    )
    const { useAgentStatus } = await import('./agentStatus')
    expect(useAgentStatus.getState().byId['n2']?.loop).toMatchObject({
      kind: 'cron',
      schedule: '*/5 * * * *'
    })
  })

  it('persists `hibernated` and drops the key when the node wakes', async () => {
    const store = memStorage()
    vi.stubGlobal('localStorage', store)
    const { useAgentStatus } = await import('./agentStatus')
    useAgentStatus.getState().setHibernated('n1', true)
    expect(JSON.parse(store.getItem('nodeterm.agentStatus')!).n1.hibernated).toBe(true)
    useAgentStatus.getState().setHibernated('n1', false)
    expect(JSON.parse(store.getItem('nodeterm.agentStatus') ?? '{}').n1?.hibernated).toBeUndefined()
  })

  it('clears `hibernated` on a LIVE state — a hook event is proof the CLI is running', async () => {
    // Left standing, the flag renders RUNNING and SLEEPING at once AND exempts the session from
    // Eco for good (the sweep skips hibernated nodes). The three ways it goes stale are all real:
    // the user relaunched the agent by hand, a wake landed, or a resume we could not confirm
    // actually worked.
    const store = memStorage()
    vi.stubGlobal('localStorage', store)
    const { useAgentStatus } = await import('./agentStatus')
    for (const state of ['working', 'blocked', 'waiting'] as const) {
      useAgentStatus.getState().setHibernated('n10', true)
      useAgentStatus.getState().setState('n10', state, 'claude')
      expect(useAgentStatus.getState().byId['n10'].hibernated, state).toBeUndefined()
      // …and it reaches disk, or a relaunch would restore a flag we have disproved.
      expect(JSON.parse(store.getItem('nodeterm.agentStatus')!).n10?.hibernated, state).toBeUndefined()
      useAgentStatus.getState().setState('n10', undefined)
    }
  })

  it('keeps `hibernated` through a `done` event — a late Stop must not undo the exit', async () => {
    vi.stubGlobal('localStorage', memStorage())
    const { useAgentStatus } = await import('./agentStatus')
    useAgentStatus.getState().setHibernated('n11', true)
    useAgentStatus.getState().setState('n11', 'done', 'claude')
    expect(useAgentStatus.getState().byId['n11'].hibernated).toBe(true)
  })

  it('waking restarts the idle clock, so a quiet resumed session is not re-hibernated', async () => {
    vi.stubGlobal('localStorage', memStorage())
    const { useAgentStatus } = await import('./agentStatus')
    useAgentStatus.setState({
      byId: { n12: { unread: false, state: 'done', lastEventAt: Date.now() - 6 * 3600_000, hibernated: true } }
    })
    useAgentStatus.getState().setHibernated('n12', false)
    const st = useAgentStatus.getState().byId['n12']
    expect(st.hibernated).toBeUndefined()
    expect(Date.now() - st.lastEventAt!).toBeLessThan(5000) // hours-old clock replaced
  })

  it('persists `hibernatedPane` with the flag and drops it on wake', async () => {
    // What the pane settled to when the CLI let go: the wake's second way of recognizing a pane it
    // may type into, for shells the `isShellCommand` allowlist does not know (nu/xonsh/pwsh).
    // Kept past a wake it would be a standing permission to type into whatever that string names.
    const store = memStorage()
    vi.stubGlobal('localStorage', store)
    const { useAgentStatus } = await import('./agentStatus')
    useAgentStatus.getState().setHibernatedPane('n15', 'nu')
    useAgentStatus.getState().setHibernated('n15', true)
    expect(JSON.parse(store.getItem('nodeterm.agentStatus')!).n15).toMatchObject({
      hibernated: true,
      hibernatedPane: 'nu'
    })
    useAgentStatus.getState().setHibernated('n15', false)
    expect(useAgentStatus.getState().byId['n15'].hibernatedPane).toBeUndefined()
    expect(JSON.parse(store.getItem('nodeterm.agentStatus')!).n15?.hibernatedPane).toBeUndefined()
  })

  it('forgets the recorded pane when the exit could not read one (null)', async () => {
    vi.stubGlobal('localStorage', memStorage())
    const { useAgentStatus } = await import('./agentStatus')
    useAgentStatus.getState().setHibernatedPane('n16', 'nu')
    useAgentStatus.getState().setHibernatedPane('n16', null)
    // A stale string must never stand in as permission to type into TODAY's pane.
    expect(useAgentStatus.getState().byId['n16'].hibernatedPane).toBeUndefined()
  })

  it('drops `hibernatedPane` with the flag on the live-state self-heal', async () => {
    vi.stubGlobal('localStorage', memStorage())
    const { useAgentStatus } = await import('./agentStatus')
    useAgentStatus.getState().setHibernatedPane('n17', 'nu')
    useAgentStatus.getState().setHibernated('n17', true)
    useAgentStatus.getState().setState('n17', 'working', 'claude')
    expect(useAgentStatus.getState().byId['n17'].hibernated).toBeUndefined()
    expect(useAgentStatus.getState().byId['n17'].hibernatedPane).toBeUndefined()
  })

  it('never restores a recorded pane without the flag it belongs to', async () => {
    vi.stubGlobal(
      'localStorage',
      memStorage({
        'nodeterm.agentStatus': JSON.stringify({
          n18: { unread: false, sessionId: 's', hibernatedPane: 'nu' }
        })
      })
    )
    const { useAgentStatus } = await import('./agentStatus')
    expect(useAgentStatus.getState().byId['n18'].hibernatedPane).toBeUndefined()
  })

  it('setHibernated(false) on a node that is not hibernated changes NOTHING', async () => {
    // Load-bearing since Canvas calls it on every SessionStart (a fresh launch disproves the
    // flag): the bail must not create an entry, must not touch the idle clock — which would hide
    // a genuinely idle session from the sweep — and must not write.
    const store = memStorage()
    vi.stubGlobal('localStorage', store)
    const { useAgentStatus } = await import('./agentStatus')
    useAgentStatus.getState().setHibernated('n13', false)
    expect(useAgentStatus.getState().byId['n13']).toBeUndefined()
    const idle = Date.now() - 45 * 60_000
    useAgentStatus.setState({ byId: { n14: { unread: false, state: 'done', lastEventAt: idle } } })
    useAgentStatus.getState().setHibernated('n14', false)
    expect(useAgentStatus.getState().byId['n14'].lastEventAt).toBe(idle)
    expect(store.getItem('nodeterm.agentStatus')).toBeNull()
  })

  it('restores `hibernated` on load (the CLI stays exited across an app restart)', async () => {
    vi.stubGlobal(
      'localStorage',
      memStorage({
        'nodeterm.agentStatus': JSON.stringify({ n4: { unread: false, sessionId: 's', hibernated: true } })
      })
    )
    const { useAgentStatus } = await import('./agentStatus')
    expect(useAgentStatus.getState().byId['n4']?.hibernated).toBe(true)
  })

  it('persists `paused` and drops the key on resume', async () => {
    const store = memStorage()
    vi.stubGlobal('localStorage', store)
    const { useAgentStatus } = await import('./agentStatus')
    useAgentStatus.getState().setPaused('n20', true)
    expect(JSON.parse(store.getItem('nodeterm.agentStatus')!).n20.paused).toBe(true)
    useAgentStatus.getState().setPaused('n20', false)
    expect(JSON.parse(store.getItem('nodeterm.agentStatus') ?? '{}').n20?.paused).toBeUndefined()
  })

  it('`paused` persists INDEPENDENTLY of `hibernated` — the deep pause recycles tmux, so a paused node can carry no hibernated flag at all', async () => {
    const store = memStorage()
    vi.stubGlobal('localStorage', store)
    const { useAgentStatus } = await import('./agentStatus')
    useAgentStatus.getState().setPaused('n21', true)
    const saved = JSON.parse(store.getItem('nodeterm.agentStatus')!).n21
    expect(saved.paused).toBe(true)
    expect(saved.hibernated).toBeUndefined()
  })

  it('persists `hibernatedPane` for a PAUSED node even with `hibernated` unset — the deep pause records what its recycled pane settled to, and needs the record to survive a restart just as `paused` does', async () => {
    const store = memStorage()
    vi.stubGlobal('localStorage', store)
    const { useAgentStatus } = await import('./agentStatus')
    useAgentStatus.getState().setPaused('n26', true)
    useAgentStatus.getState().setHibernatedPane('n26', 'nu')
    const saved = JSON.parse(store.getItem('nodeterm.agentStatus')!).n26
    expect(saved).toMatchObject({ paused: true, hibernatedPane: 'nu' })
    expect(saved.hibernated).toBeUndefined()
  })

  it('restores `hibernatedPane` on load for a paused (not hibernated) node', async () => {
    vi.stubGlobal(
      'localStorage',
      memStorage({
        'nodeterm.agentStatus': JSON.stringify({
          n27: { unread: false, sessionId: 's', paused: true, hibernatedPane: 'nu' }
        })
      })
    )
    const { useAgentStatus } = await import('./agentStatus')
    expect(useAgentStatus.getState().byId['n27']).toMatchObject({ paused: true, hibernatedPane: 'nu' })
  })

  it('setPaused(false) drops `hibernatedPane` when it was the only owner, but leaves it standing for `hibernated`', async () => {
    const store = memStorage()
    vi.stubGlobal('localStorage', store)
    const { useAgentStatus } = await import('./agentStatus')
    // paused-only: resuming drops the pane record too.
    useAgentStatus.getState().setPaused('n28', true)
    useAgentStatus.getState().setHibernatedPane('n28', 'nu')
    useAgentStatus.getState().setPaused('n28', false)
    expect(useAgentStatus.getState().byId['n28'].hibernatedPane).toBeUndefined()
    // hibernated AND paused together: resuming `paused` alone leaves `hibernated`'s copy intact.
    useAgentStatus.getState().setHibernated('n29', true)
    useAgentStatus.getState().setHibernatedPane('n29', 'nu')
    useAgentStatus.getState().setPaused('n29', true)
    useAgentStatus.getState().setPaused('n29', false)
    expect(useAgentStatus.getState().byId['n29'].hibernatedPane).toBe('nu')
  })

  it('clears `paused` on a LIVE state — same self-heal as `hibernated`', async () => {
    const store = memStorage()
    vi.stubGlobal('localStorage', store)
    const { useAgentStatus } = await import('./agentStatus')
    for (const state of ['working', 'blocked', 'waiting'] as const) {
      useAgentStatus.getState().setPaused('n22', true)
      useAgentStatus.getState().setState('n22', state, 'claude')
      expect(useAgentStatus.getState().byId['n22'].paused, state).toBeUndefined()
      expect(JSON.parse(store.getItem('nodeterm.agentStatus')!).n22?.paused, state).toBeUndefined()
      useAgentStatus.getState().setState('n22', undefined)
    }
  })

  it('the LIVE-state self-heal drops `hibernatedPane` alongside a paused-only flag (deep pause), but NOT when `hibernated` still owns it', async () => {
    const { useAgentStatus } = await import('./agentStatus')
    // paused-only (the deep "pause & end session" shape): the pane record goes with it.
    useAgentStatus.getState().setPaused('n30', true)
    useAgentStatus.getState().setHibernatedPane('n30', 'nu')
    useAgentStatus.getState().setState('n30', 'working', 'claude')
    expect(useAgentStatus.getState().byId['n30'].hibernatedPane).toBeUndefined()
    // hibernated AND paused together (shallow pause): the shared `hibernated` clear already drops
    // it — this is not a NEW case, just confirming the paused-only branch doesn't double-clear.
    useAgentStatus.getState().setHibernated('n31', true)
    useAgentStatus.getState().setPaused('n31', true)
    useAgentStatus.getState().setHibernatedPane('n31', 'nu')
    useAgentStatus.getState().setState('n31', 'working', 'claude')
    expect(useAgentStatus.getState().byId['n31'].hibernatedPane).toBeUndefined()
  })

  it('keeps `paused` through a `done` event — same as `hibernated`, and through a cold restart (this store never clears it on its own)', async () => {
    vi.stubGlobal('localStorage', memStorage())
    const { useAgentStatus } = await import('./agentStatus')
    useAgentStatus.getState().setPaused('n23', true)
    useAgentStatus.getState().setState('n23', 'done', 'claude')
    expect(useAgentStatus.getState().byId['n23'].paused).toBe(true)
  })

  it('resuming restarts the idle clock, so a long-paused session is not immediately re-eligible for Eco', async () => {
    vi.stubGlobal('localStorage', memStorage())
    const { useAgentStatus } = await import('./agentStatus')
    useAgentStatus.setState({
      byId: { n24: { unread: false, state: 'done', lastEventAt: Date.now() - 6 * 3600_000, paused: true } }
    })
    useAgentStatus.getState().setPaused('n24', false)
    const st = useAgentStatus.getState().byId['n24']
    expect(st.paused).toBeUndefined()
    expect(Date.now() - st.lastEventAt!).toBeLessThan(5000)
  })

  it('restores `paused` on load', async () => {
    vi.stubGlobal(
      'localStorage',
      memStorage({
        'nodeterm.agentStatus': JSON.stringify({ n25: { unread: false, sessionId: 's', paused: true } })
      })
    )
    const { useAgentStatus } = await import('./agentStatus')
    expect(useAgentStatus.getState().byId['n25']?.paused).toBe(true)
  })

  it('never persists `lastEventAt` — a stale idle clock would hibernate on relaunch', async () => {
    const store = memStorage()
    vi.stubGlobal('localStorage', store)
    const { useAgentStatus } = await import('./agentStatus')
    useAgentStatus.getState().setState('n5', 'done', 'claude')
    // The live entry carries the idle clock…
    expect(useAgentStatus.getState().byId['n5'].lastEventAt).toBeTypeOf('number')
    // …but nothing durable happened yet, so nothing was written at all.
    useAgentStatus.getState().setSessionId('n5', 'sess-1')
    const saved = JSON.parse(store.getItem('nodeterm.agentStatus')!)
    expect(saved.n5.sessionId).toBe('sess-1')
    expect(saved.n5.lastEventAt).toBeUndefined()
    expect(saved.n5.stateAt).toBeUndefined()
    expect(saved.n5.state).toBeUndefined()
  })

  it('never persists `backgroundTaskAt` — a stale stamp would exempt a node from Eco forever', async () => {
    // Same rationale as `lastEventAt`: after a relaunch nothing is running that we know of, and any
    // turn's `working` would have cleared it anyway.
    const store = memStorage()
    vi.stubGlobal('localStorage', store)
    const { useAgentStatus } = await import('./agentStatus')
    useAgentStatus.getState().markBackgroundTask('n15')
    expect(useAgentStatus.getState().byId['n15'].backgroundTaskAt).toBeTypeOf('number')
    // The stamp alone is not durable, so it writes nothing at all…
    expect(store.getItem('nodeterm.agentStatus')).toBeNull()
    // …and it stays out of the file when a durable field does get written.
    useAgentStatus.getState().setSessionId('n15', 'sess-2')
    const saved = JSON.parse(store.getItem('nodeterm.agentStatus')!)
    expect(saved.n15.sessionId).toBe('sess-2')
    expect(saved.n15.backgroundTaskAt).toBeUndefined()
  })

  it('stamps `lastEventAt` on a state transition only (same-state refresh keeps the idle clock)', async () => {
    vi.stubGlobal('localStorage', memStorage())
    const { useAgentStatus } = await import('./agentStatus')
    const st = useAgentStatus.getState()
    st.setState('n6', 'working', 'claude')
    st.setState('n6', 'done', 'claude')
    const first = useAgentStatus.getState().byId['n6'].lastEventAt!
    expect(first).toBeTypeOf('number')
    // A same-state event refreshes freshness, not the idle clock.
    st.setState('n6', 'done', 'claude')
    expect(useAgentStatus.getState().byId['n6'].lastEventAt).toBe(first)
  })

  it('dismissLoopCard hides the card but KEEPS the entry — the job is still out there', async () => {
    // The card's × has always promised "does not remove the job", but clearing the entry dropped
    // the only record that a wakeup is pending — which is what stops Eco mode from `/exit`ing the
    // CLI the wakeup lives in. So a dismiss now MARKS, and only the render filters on the mark.
    const store = memStorage()
    vi.stubGlobal('localStorage', store)
    const { useAgentStatus } = await import('./agentStatus')
    useAgentStatus.getState().setLoop('n7', true, 'cron', { schedule: '0 9 * * *' })
    useAgentStatus.getState().dismissLoopCard('n7')
    expect(useAgentStatus.getState().byId['n7'].loop).toMatchObject({ kind: 'cron', dismissed: true })
    const saved = JSON.parse(store.getItem('nodeterm.agentStatus')!)
    expect(saved.n7.loop).toMatchObject({ kind: 'cron', dismissed: true })
    // A real end (CronDelete) is still a real clear.
    useAgentStatus.getState().setLoop('n7', false)
    expect(useAgentStatus.getState().byId['n7'].loop).toBeUndefined()
  })

  it('restores `loop.dismissed` on load, and a new recurring event un-dismisses', async () => {
    vi.stubGlobal(
      'localStorage',
      memStorage({
        'nodeterm.agentStatus': JSON.stringify({
          n8: { unread: false, loop: { count: 1, kind: 'schedule', items: [], dismissed: true } }
        })
      })
    )
    const { useAgentStatus } = await import('./agentStatus')
    expect(useAgentStatus.getState().byId['n8'].loop).toMatchObject({ kind: 'schedule', dismissed: true })
    // setLoop(active) rebuilds the entry from scratch — a freshly created job shows its card again.
    useAgentStatus.getState().setLoop('n8', true, 'cron')
    expect(useAgentStatus.getState().byId['n8'].loop?.dismissed).toBeUndefined()
  })

  it('is a no-op for a node with no loop entry', async () => {
    vi.stubGlobal('localStorage', memStorage())
    const { useAgentStatus } = await import('./agentStatus')
    useAgentStatus.getState().dismissLoopCard('n9')
    expect(useAgentStatus.getState().byId['n9']).toBeUndefined()
  })

  it('tolerates a persisted entry without loop (older format)', async () => {
    vi.stubGlobal(
      'localStorage',
      memStorage({ 'nodeterm.agentStatus': JSON.stringify({ n3: { unread: true, sessionId: 's' } }) })
    )
    const { useAgentStatus } = await import('./agentStatus')
    expect(useAgentStatus.getState().byId['n3']).toMatchObject({ unread: true, sessionId: 's' })
    expect(useAgentStatus.getState().byId['n3'].loop).toBeUndefined()
  })
})
