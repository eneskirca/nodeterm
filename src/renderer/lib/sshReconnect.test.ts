import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SshReconnector, RECONNECT_DELAYS_MS, RESPAWN_REFUSE_MS, subscribeSshReattach } from './sshReconnect'

describe('SshReconnector', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  const make = (connectImpl?: (projectId: string) => Promise<boolean>) => {
    const connect = vi.fn(connectImpl ?? (async () => true))
    const respawn = vi.fn()
    const rec = new SshReconnector({ connect, respawn })
    return { rec, connect, respawn }
  }

  it('reconnects after a drop and respawns the reported node', async () => {
    const { rec, connect, respawn } = make()
    rec.reportDrop('p1', 'n1')
    expect(connect).not.toHaveBeenCalled() // debounced: first attempt waits for the first delay
    await vi.advanceTimersByTimeAsync(RECONNECT_DELAYS_MS[0])
    expect(connect).toHaveBeenCalledTimes(1)
    expect(connect).toHaveBeenCalledWith('p1')
    expect(respawn).toHaveBeenCalledWith('p1', ['n1'])
  })

  it('coalesces multiple dropped nodes of one project into a single connect + respawn', async () => {
    const { rec, connect, respawn } = make()
    rec.reportDrop('p1', 'n1')
    rec.reportDrop('p1', 'n2')
    await vi.advanceTimersByTimeAsync(RECONNECT_DELAYS_MS[0])
    expect(connect).toHaveBeenCalledTimes(1)
    expect(respawn).toHaveBeenCalledTimes(1)
    expect(respawn.mock.calls[0][0]).toBe('p1')
    expect([...respawn.mock.calls[0][1]].sort()).toEqual(['n1', 'n2'])
  })

  it('backs off on failure and gives up after the schedule is exhausted (~30s total)', async () => {
    const { rec, connect, respawn } = make(async () => false)
    rec.reportDrop('p1', 'n1')
    for (const d of RECONNECT_DELAYS_MS) await vi.advanceTimersByTimeAsync(d)
    expect(connect).toHaveBeenCalledTimes(RECONNECT_DELAYS_MS.length)
    // Exhausted: no further attempts, no respawn.
    await vi.advanceTimersByTimeAsync(120_000)
    expect(connect).toHaveBeenCalledTimes(RECONNECT_DELAYS_MS.length)
    expect(respawn).not.toHaveBeenCalled()
  })

  it('a connect() that throws counts as a failed attempt (backoff continues)', async () => {
    const { rec, connect } = make(async () => {
      throw new Error('boom')
    })
    rec.reportDrop('p1', 'n1')
    await vi.advanceTimersByTimeAsync(RECONNECT_DELAYS_MS[0])
    await vi.advanceTimersByTimeAsync(RECONNECT_DELAYS_MS[1])
    expect(connect).toHaveBeenCalledTimes(2)
  })

  it('onConnected flushes pending nodes after the loop gave up (tab-switch reconnect heals)', async () => {
    const { rec, respawn } = make(async () => false)
    rec.reportDrop('p1', 'n1')
    for (const d of RECONNECT_DELAYS_MS) await vi.advanceTimersByTimeAsync(d)
    expect(respawn).not.toHaveBeenCalled()
    rec.onConnected('p1')
    expect(respawn).toHaveBeenCalledWith('p1', ['n1'])
  })

  it('onConnected cancels an in-progress backoff loop (no duplicate respawn)', async () => {
    const { rec, connect, respawn } = make(async () => false)
    rec.reportDrop('p1', 'n1')
    await vi.advanceTimersByTimeAsync(RECONNECT_DELAYS_MS[0]) // one failed attempt
    rec.onConnected('p1')
    expect(respawn).toHaveBeenCalledTimes(1)
    const attempts = connect.mock.calls.length
    await vi.advanceTimersByTimeAsync(120_000)
    expect(connect).toHaveBeenCalledTimes(attempts) // loop stopped
    expect(respawn).toHaveBeenCalledTimes(1)
  })

  it('onConnected with nothing pending does not respawn', () => {
    const { rec, respawn } = make()
    rec.onConnected('p1')
    expect(respawn).not.toHaveBeenCalled()
  })

  it(`refuses a re-drop within ${RESPAWN_REFUSE_MS}ms of that node's respawn (no hot loop)`, async () => {
    const { rec, connect, respawn } = make()
    rec.reportDrop('p1', 'n1')
    await vi.advanceTimersByTimeAsync(RECONNECT_DELAYS_MS[0])
    expect(respawn).toHaveBeenCalledTimes(1)
    // The respawned node's ssh dies again immediately (broken spawn): refuse it.
    await vi.advanceTimersByTimeAsync(RESPAWN_REFUSE_MS - 1000)
    rec.reportDrop('p1', 'n1')
    await vi.advanceTimersByTimeAsync(120_000)
    expect(connect).toHaveBeenCalledTimes(1)
    expect(respawn).toHaveBeenCalledTimes(1)
  })

  it('accepts a re-drop after the refuse window (a real later drop reconnects again)', async () => {
    const { rec, respawn } = make()
    rec.reportDrop('p1', 'n1')
    await vi.advanceTimersByTimeAsync(RECONNECT_DELAYS_MS[0])
    expect(respawn).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(RESPAWN_REFUSE_MS + 1000)
    rec.reportDrop('p1', 'n1')
    await vi.advanceTimersByTimeAsync(RECONNECT_DELAYS_MS[0])
    expect(respawn).toHaveBeenCalledTimes(2)
  })

  it('tracks projects independently', async () => {
    const { rec, respawn } = make()
    rec.reportDrop('p1', 'n1')
    rec.reportDrop('p2', 'n2')
    await vi.advanceTimersByTimeAsync(RECONNECT_DELAYS_MS[0])
    expect(respawn).toHaveBeenCalledWith('p1', ['n1'])
    expect(respawn).toHaveBeenCalledWith('p2', ['n2'])
  })

  // retryNow: the connection banner's Reconnect button, and an offline node's own. A person is
  // watching, so none of the automatic loop's patience applies to it.
  it('retryNow connects immediately, skipping the backoff delay', async () => {
    const { rec, connect, respawn } = make()
    rec.retryNow('p1', ['n1'])
    await vi.advanceTimersByTimeAsync(0) // no delay to wait out — just the connect's own promise
    expect(connect).toHaveBeenCalledTimes(1)
    expect(respawn).toHaveBeenCalledWith('p1', ['n1'])
  })

  it('retryNow revives an EXHAUSTED loop (giving up is for the automatic retries only)', async () => {
    let ok = false
    const { rec, connect, respawn } = make(async () => ok)
    rec.reportDrop('p1', 'n1')
    for (const d of RECONNECT_DELAYS_MS) await vi.advanceTimersByTimeAsync(d)
    expect(connect).toHaveBeenCalledTimes(RECONNECT_DELAYS_MS.length) // gave up

    ok = true // the user's network is back and they click Reconnect
    rec.retryNow('p1')
    await vi.advanceTimersByTimeAsync(0)
    expect(connect).toHaveBeenCalledTimes(RECONNECT_DELAYS_MS.length + 1)
    // The node queued by the original drop is still pending, so it comes back with this connect.
    expect(respawn).toHaveBeenCalledWith('p1', ['n1'])
  })

  it('retryNow clears the respawn-refuse window (a click is not a hot loop)', async () => {
    const { rec, respawn } = make()
    rec.reportDrop('p1', 'n1')
    await vi.advanceTimersByTimeAsync(RECONNECT_DELAYS_MS[0])
    expect(respawn).toHaveBeenCalledTimes(1)
    // Well inside the window that refuses an AUTOMATIC re-drop of this node.
    await vi.advanceTimersByTimeAsync(1000)
    rec.retryNow('p1', ['n1'])
    await vi.advanceTimersByTimeAsync(0)
    expect(respawn).toHaveBeenCalledTimes(2)
  })

  it('retryNow on a project with nothing pending still connects (banner with no dead nodes)', async () => {
    const { rec, connect, respawn } = make()
    rec.retryNow('p1')
    await vi.advanceTimersByTimeAsync(0)
    expect(connect).toHaveBeenCalledWith('p1')
    expect(respawn).not.toHaveBeenCalled()
  })

  it('dispose cancels pending loops (no connects or respawns afterwards)', async () => {
    const { rec, connect, respawn } = make()
    rec.reportDrop('p1', 'n1')
    rec.dispose()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(connect).not.toHaveBeenCalled()
    expect(respawn).not.toHaveBeenCalled()
  })
})

describe('SSH reconnect view subscriptions', () => {
  const unsubscribes: Array<() => void> = []
  let rec: SshReconnector
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    rec?.dispose()
    unsubscribes.splice(0).forEach((off) => off())
    vi.useRealTimers()
  })
  const watch = (scope: string, node: string) => {
    const listener = vi.fn()
    const off = subscribeSshReattach(scope, node, listener)
    unsubscribes.push(off)
    return { listener, off }
  }

  it('notifies every matching view after success, without notifying another scope or node', async () => {
    const first = watch('owner-host', 'n1')
    const second = watch('owner-host', 'n1')
    const otherScope = watch('other-host', 'n1')
    const otherNode = watch('owner-host', 'n2')
    rec = new SshReconnector({ connect: async () => true, respawn: vi.fn() })
    // Canvas and Modal can both report the same exit; the pending set coalesces them.
    rec.reportDrop('owner-host', 'n1')
    rec.reportDrop('owner-host', 'n1')
    expect(first.listener).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(RECONNECT_DELAYS_MS[0])
    expect(first.listener).toHaveBeenCalledTimes(1)
    expect(second.listener).toHaveBeenCalledTimes(1)
    expect(otherScope.listener).not.toHaveBeenCalled()
    expect(otherNode.listener).not.toHaveBeenCalled()
    rec.onConnected('owner-host')
    expect(first.listener).toHaveBeenCalledTimes(1)
  })

  it('keeps views untouched on failure and delivers an external successful reconnect only once', async () => {
    const view = watch('p1', 'n1')
    rec = new SshReconnector({ connect: async () => false, respawn: vi.fn() })
    rec.reportDrop('p1', 'n1')
    for (const delay of RECONNECT_DELAYS_MS) await vi.advanceTimersByTimeAsync(delay)
    expect(view.listener).not.toHaveBeenCalled()
    rec.onConnected('p2')
    expect(view.listener).not.toHaveBeenCalled()
    rec.onConnected('p1')
    rec.onConnected('p1')
    expect(view.listener).toHaveBeenCalledTimes(1)
  })

  it('does not double-deliver when the connected event wins the connect-promise race', async () => {
    let finish!: (value: boolean) => void
    const view = watch('p1', 'n1')
    rec = new SshReconnector({
      connect: () => new Promise<boolean>((resolve) => { finish = resolve }),
      respawn: vi.fn()
    })
    rec.reportDrop('p1', 'n1')
    await vi.advanceTimersByTimeAsync(RECONNECT_DELAYS_MS[0])
    rec.onConnected('p1')
    finish(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(view.listener).toHaveBeenCalledTimes(1)
  })

  it('retired subscriptions cannot remove a replacement view or receive later notifications', async () => {
    const retired = watch('p1', 'n1')
    retired.off()
    const replacement = watch('p1', 'n1')
    retired.off() // a late second cleanup must not delete the new scope's listeners
    rec = new SshReconnector({ connect: async () => true, respawn: vi.fn() })
    rec.reportDrop('p1', 'n1')
    await vi.advanceTimersByTimeAsync(RECONNECT_DELAYS_MS[0])
    expect(retired.listener).not.toHaveBeenCalled()
    expect(replacement.listener).toHaveBeenCalledTimes(1)
  })
})
