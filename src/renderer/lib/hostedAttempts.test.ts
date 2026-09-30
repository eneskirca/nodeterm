import { describe, it, expect, vi } from 'vitest'
import type { RelayClosedReason } from '@shared/types'
import { createHostedAttempts, type HostedAttemptDeps, type HostedAttemptRequest } from './hostedAttempts'
import type { JoinFailure } from './hostedTeam'

const wrap = (m: string) => new Error(`Error invoking remote method 'relay:client:connect': Error: ${m}`)
const flush = () => new Promise((r) => setTimeout(r, 0))

/** Deps whose every answer the test controls, with a manual clock. */
function harness() {
  const connects: Array<{ code: string; resolve: (id: string) => void; reject: (e: Error) => void }> = []
  const mounts: Array<{ id: string; req: HostedAttemptRequest; resolve: (r: { projectId: string } | { retry: boolean }) => void }> = []
  const closeCbs = new Map<string, (reason?: RelayClosedReason) => void>()
  const unsubs: string[] = []
  const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = []
  const stopped: Array<{ req: HostedAttemptRequest; f: JoinFailure }> = []
  const ended: Array<{ req: HostedAttemptRequest; projectId: string; reason?: RelayClosedReason }> = []
  const disconnected: string[] = []
  const exhausted: HostedAttemptRequest[] = []
  const throttledSaid: HostedAttemptRequest[] = []
  const wanted = { value: true }
  const deps: HostedAttemptDeps = {
    exhausted: (req) => exhausted.push(req),
    throttled: (req) => throttledSaid.push(req),
    wanted: () => wanted.value,
    connect: (code) => new Promise((resolve, reject) => connects.push({ code, resolve, reject })),
    mount: (id, req) => new Promise((resolve) => mounts.push({ id, req, resolve })),
    onClosed: (id, cb) => {
      closeCbs.set(id, cb)
      return () => unsubs.push(id)
    },
    disconnect: (id) => disconnected.push(id),
    stopped: (req, f) => stopped.push({ req, f }),
    ended: (req, projectId, reason) => ended.push({ req, projectId, reason }),
    setTimer: (fn, ms) => {
      const t = { fn, ms, cleared: false }
      timers.push(t)
      return t
    },
    clearTimer: (t) => {
      ;(t as { cleared: boolean }).cleared = true
    }
  }
  const fire = () => {
    const t = timers.filter((x) => !x.cleared).pop()
    if (!t) throw new Error('no armed timer')
    t.cleared = true
    t.fn()
  }
  const armed = () => timers.filter((t) => !t.cleared)
  return { deps, connects, mounts, closeCbs, unsubs, timers, armed, fire, stopped, ended, disconnected, exhausted, wanted, throttledSaid }
}

const boot = (over: Partial<HostedAttemptRequest> = {}): HostedAttemptRequest => ({
  hostId: 'H1', code: 'nodeterm://join?code=AAA', label: 'box', manual: false, retry: true, ...over
})

describe('hosted attempts: one attempt and one live connection per team (R38/R39)', () => {
  it('connects, mounts, and holds the team as live', async () => {
    const h = harness()
    const a = createHostedAttempts(h.deps)
    expect(a.run(boot())).toBe('started')
    expect(a.phase('H1')).toBe('connecting')
    h.connects[0].resolve('c1')
    await flush()
    expect(a.phase('H1')).toBe('mounting')
    expect(h.mounts[0].id).toBe('c1')
    h.mounts[0].resolve({ projectId: 'proj-1' })
    await flush()
    expect(a.phase('H1')).toBe('live')
  })

  it('a second run for the same team while it connects, waits for approval or is live is refused — never a second connect', async () => {
    const h = harness()
    const a = createHostedAttempts(h.deps)
    a.run(boot())
    expect(a.run(boot({ manual: true }))).toBe('busy') // connecting
    h.connects[0].resolve('c1')
    await flush()
    expect(a.run(boot({ manual: true }))).toBe('busy') // SAS / owner approval window (item 15)
    h.mounts[0].resolve({ projectId: 'proj-1' })
    await flush()
    expect(a.run(boot({ manual: true }))).toBe('busy') // live
    expect(h.connects).toHaveLength(1)
    // Another team is independent.
    expect(a.run(boot({ hostId: 'H2' }))).toBe('started')
    expect(h.connects).toHaveLength(2)
  })

  it('retries ONLY a network failure, on the 1/2/4/8/15/60 s ladder (R35)', async () => {
    const h = harness()
    const a = createHostedAttempts(h.deps)
    a.run(boot())
    const delays: number[] = []
    for (let i = 0; i < 7; i++) {
      h.connects[i].reject(wrap('[E_JOIN_NETWORK] Could not reach the nodeterm service.'))
      await flush()
      expect(a.phase('H1')).toBe('waiting')
      delays.push(h.armed()[0].ms)
      h.fire()
      expect(a.phase('H1')).toBe('connecting')
    }
    expect(delays).toEqual([1000, 2000, 4000, 8000, 15000, 60000, 60000])
    expect(h.stopped).toEqual([])
  })

  for (const code of ['E_JOIN_REVOKED', 'E_JOIN_REFUSED', 'E_JOIN_RATE', 'E_JOIN_BAD_CODE', 'E_JOIN_KEY_LOCKED']) {
    it(`${code} stops the loop at once and is told once — a retry would spend damped mints`, async () => {
      const h = harness()
      const a = createHostedAttempts(h.deps)
      a.run(boot())
      h.connects[0].reject(wrap(`[${code}] detail`))
      await flush()
      expect(a.phase('H1')).toBeNull()
      expect(h.armed()).toEqual([])
      expect(h.stopped).toHaveLength(1)
      expect(h.stopped[0].f).toMatchObject({ code, retry: false, detail: 'detail' })
    })
  }

  it('a failure with no code at all is never retried either', async () => {
    const h = harness()
    const a = createHostedAttempts(h.deps)
    a.run(boot())
    h.connects[0].reject(new Error('Remote access is unavailable in development builds.'))
    await flush()
    expect(h.armed()).toEqual([])
    expect(h.stopped[0].f.code).toBeNull()
  })

  it('an attempt that asked not to retry (a pasted code) reports a network failure instead of looping', async () => {
    const h = harness()
    const a = createHostedAttempts(h.deps)
    a.run(boot({ manual: true, retry: false }))
    h.connects[0].reject(wrap('[E_JOIN_NETWORK] x'))
    await flush()
    expect(h.armed()).toEqual([])
    expect(h.stopped[0].f.code).toBe('E_JOIN_NETWORK')
  })

  it('BUSY stops without being a verdict: reported as busy, never as a denial', async () => {
    const h = harness()
    const a = createHostedAttempts(h.deps)
    a.run(boot())
    h.connects[0].reject(wrap('[E_JOIN_BUSY] Already joining this team.'))
    await flush()
    expect(a.phase('H1')).toBeNull()
    expect(h.stopped[0].f).toMatchObject({ busy: true, retry: false })
  })

  it('a manual connect cancels the pending backoff and runs the one attempt now (item 15)', async () => {
    const h = harness()
    const a = createHostedAttempts(h.deps)
    a.run(boot())
    h.connects[0].reject(wrap('[E_JOIN_NETWORK] x'))
    await flush()
    expect(a.phase('H1')).toBe('waiting')
    // An automatic run while waiting leaves the existing loop alone.
    expect(a.run(boot())).toBe('busy')
    expect(a.run(boot({ manual: true, reconnectProjectId: 'proj-1' }))).toBe('started')
    expect(h.armed()).toEqual([])
    expect(h.connects).toHaveLength(2)
    // The manual request is the one that runs (it carries the tab to reconnect in place).
    h.connects[1].resolve('c2')
    await flush()
    expect(h.mounts[0].req.reconnectProjectId).toBe('proj-1')
  })

  it('cancel stops a waiting loop for good (the team was forgotten, the canvas went away)', async () => {
    const h = harness()
    const a = createHostedAttempts(h.deps)
    a.run(boot())
    h.connects[0].reject(wrap('[E_JOIN_NETWORK] x'))
    await flush()
    a.cancel('H1')
    expect(h.armed()).toEqual([])
    expect(a.phase('H1')).toBeNull()
  })

  it('cancel during a connect: the connection that arrives late is closed, never mounted', async () => {
    const h = harness()
    const a = createHostedAttempts(h.deps)
    a.run(boot())
    a.cancel('H1')
    h.connects[0].resolve('c1')
    await flush()
    expect(h.mounts).toEqual([])
    expect(h.disconnected).toEqual(['c1'])
    // …and a failure that lands late is not told.
    a.run(boot())
    a.cancel('H1')
    h.connects[1].reject(wrap('[E_JOIN_REVOKED] x'))
    await flush()
    expect(h.stopped).toEqual([])
  })

  it('a mount that never became a tab (SAS declined, owner refused, timed out) releases the team', async () => {
    const h = harness()
    const a = createHostedAttempts(h.deps)
    a.run(boot())
    h.connects[0].resolve('c1')
    await flush()
    h.mounts[0].resolve({ retry: false })
    await flush()
    expect(a.phase('H1')).toBeNull()
    expect(h.ended).toEqual([])
    expect(h.unsubs).toContain('c1')
    expect(a.run(boot())).toBe('started')
  })

  it('a connection that dropped before the host answered is retried on the same ladder (the host is restarting)', async () => {
    // connect() resolves as soon as main's relay client exists — before the host is reached — so a
    // host that is down shows up here, as a mount that failed on a reason-less close, not as a code.
    const h = harness()
    const a = createHostedAttempts(h.deps)
    a.run(boot())
    h.connects[0].resolve('c1')
    await flush()
    h.mounts[0].resolve({ retry: true })
    await flush()
    expect(a.phase('H1')).toBe('waiting')
    expect(h.armed()[0].ms).toBe(1000)
    expect(h.unsubs).toContain('c1')
    h.fire()
    expect(h.connects).toHaveLength(2)
    expect(h.stopped).toEqual([])
  })

  it('…but never for an attempt that asked not to retry (a pasted code: the mount already told its user)', async () => {
    const h = harness()
    const a = createHostedAttempts(h.deps)
    a.run(boot({ manual: true, retry: false }))
    h.connects[0].resolve('c1')
    await flush()
    h.mounts[0].resolve({ retry: true })
    await flush()
    expect(a.phase('H1')).toBeNull()
    expect(h.armed()).toEqual([])
  })

  it('a live connection that ends is released and reported with the host\'s reason', async () => {
    const h = harness()
    const a = createHostedAttempts(h.deps)
    a.run(boot())
    h.connects[0].resolve('c1')
    await flush()
    h.mounts[0].resolve({ projectId: 'proj-1' })
    await flush()
    h.closeCbs.get('c1')!('removed')
    expect(a.phase('H1')).toBeNull()
    expect(h.ended).toEqual([{ req: expect.objectContaining({ hostId: 'H1' }), projectId: 'proj-1', reason: 'removed' }])
    expect(h.unsubs).toContain('c1')
  })

  it('a close that lands while the tab is still mounting is not lost: the team never sticks "live"', async () => {
    const h = harness()
    const a = createHostedAttempts(h.deps)
    a.run(boot())
    h.connects[0].resolve('c1')
    await flush()
    h.closeCbs.get('c1')!(undefined)
    expect(a.phase('H1')).toBe('mounting')
    h.mounts[0].resolve({ projectId: 'proj-1' })
    await flush()
    expect(a.phase('H1')).toBeNull()
    expect(h.ended).toEqual([{ req: expect.objectContaining({ hostId: 'H1' }), projectId: 'proj-1', reason: undefined }])
  })

  it('the backoff starts over after a connection went live', async () => {
    const h = harness()
    const a = createHostedAttempts(h.deps)
    a.run(boot())
    h.connects[0].reject(wrap('[E_JOIN_NETWORK] x'))
    await flush()
    h.fire()
    h.connects[1].resolve('c1')
    await flush()
    h.mounts[0].resolve({ projectId: 'proj-1' })
    await flush()
    h.closeCbs.get('c1')!(undefined)
    a.run(boot())
    h.connects[2].reject(wrap('[E_JOIN_NETWORK] x'))
    await flush()
    expect(h.armed()[0].ms).toBe(1000)
  })

  it('dispose stops every loop and ignores whatever lands afterwards', async () => {
    const h = harness()
    const a = createHostedAttempts(h.deps)
    a.run(boot())
    a.run(boot({ hostId: 'H2' }))
    h.connects[0].reject(wrap('[E_JOIN_NETWORK] x'))
    await flush()
    a.dispose()
    expect(h.armed()).toEqual([])
    h.connects[1].resolve('c9')
    await flush()
    expect(h.mounts).toEqual([])
    expect(h.disconnected).toEqual(['c9'])
    expect(a.run(boot())).toBe('busy') // a disposed owner starts nothing
  })

  it('a throwing mount is a failed mount, not a stuck team', async () => {
    const h = harness()
    const deps = { ...h.deps, mount: vi.fn(async () => { throw new Error('boom') }) }
    const a = createHostedAttempts(deps)
    a.run(boot())
    h.connects[0].resolve('c1')
    await flush()
    await flush()
    expect(a.phase('H1')).toBeNull()
  })

  // ── R40 ─────────────────────────────────────────────────────────────────────────────────────────
  it('R40: a drop the host did not explain is retried at most 5 times on 1/2/4/8/15 s, then gives up ONCE', async () => {
    const h = harness()
    const a = createHostedAttempts(h.deps)
    a.run(boot({ reconnectProjectId: 'proj-1' }))
    const delays: number[] = []
    for (let i = 0; i < 6; i++) {
      h.connects[i].resolve(`c${i}`)
      await flush()
      h.mounts[i].resolve({ retry: true })
      await flush()
      if (i < 5) {
        delays.push(h.armed()[0].ms)
        h.fire()
      }
    }
    expect(delays).toEqual([1000, 2000, 4000, 8000, 15000])
    expect(h.connects).toHaveLength(6)
    expect(h.armed()).toEqual([])
    expect(a.phase('H1')).toBeNull()
    expect(h.exhausted).toEqual([expect.objectContaining({ hostId: 'H1', reconnectProjectId: 'proj-1' })])
    expect(h.stopped).toEqual([])
  })

  it('R40: network failures keep the R35 60 s tail — the bound is for the pre-approval drop only', async () => {
    const h = harness()
    const a = createHostedAttempts(h.deps)
    a.run(boot())
    for (let i = 0; i < 8; i++) {
      h.connects[i].reject(wrap('[E_JOIN_NETWORK] x'))
      await flush()
      h.fire()
    }
    expect(h.connects).toHaveLength(9)
    expect(h.exhausted).toEqual([])
  })

  it('R40: the drop budget starts over after the connection went live', async () => {
    const h = harness()
    const a = createHostedAttempts(h.deps)
    a.run(boot())
    for (let i = 0; i < 4; i++) {
      h.connects[i].resolve(`c${i}`)
      await flush()
      h.mounts[i].resolve({ retry: true })
      await flush()
      h.fire()
    }
    h.connects[4].resolve('c4')
    await flush()
    h.mounts[4].resolve({ projectId: 'proj-1' })
    await flush()
    h.closeCbs.get('c4')!(undefined)
    a.run(boot())
    h.connects[5].resolve('c5')
    await flush()
    h.mounts[5].resolve({ retry: true })
    await flush()
    expect(h.armed()[0].ms).toBe(1000)
  })

  it('R40: a retry whose tab is gone does not happen', async () => {
    const h = harness()
    const a = createHostedAttempts(h.deps)
    a.run(boot({ reconnectProjectId: 'proj-1' }))
    h.connects[0].reject(wrap('[E_JOIN_NETWORK] x'))
    await flush()
    h.wanted.value = false // the tab was closed while the loop backed off
    h.fire()
    await flush()
    expect(h.connects).toHaveLength(1)
    expect(a.phase('H1')).toBeNull()
    expect(h.stopped).toEqual([])
  })

  it('R40: a connection that arrives after its tab is gone is closed, never mounted', async () => {
    const h = harness()
    const a = createHostedAttempts(h.deps)
    a.run(boot({ reconnectProjectId: 'proj-1' }))
    h.wanted.value = false
    h.connects[0].resolve('c0')
    await flush()
    expect(h.mounts).toEqual([])
    expect(h.disconnected).toEqual(['c0'])
    expect(a.phase('H1')).toBeNull()
  })

  it('R40: closing a tab cancels its team\'s attempt in every phase, and releases the slot', async () => {
    const h = harness()
    const a = createHostedAttempts(h.deps)
    // waiting
    a.run(boot({ reconnectProjectId: 'proj-1' }))
    h.connects[0].reject(wrap('[E_JOIN_NETWORK] x'))
    await flush()
    a.cancelProject('proj-1')
    expect(h.armed()).toEqual([])
    expect(a.phase('H1')).toBeNull()
    // connecting: the late connection is closed, not mounted
    a.run(boot({ reconnectProjectId: 'proj-1' }))
    a.cancelProject('proj-1')
    h.connects[1].resolve('c1')
    await flush()
    expect(h.mounts).toEqual([])
    expect(h.disconnected).toContain('c1')
    // mounting (the approval wait): the connection is closed and the slot is free at once
    a.run(boot({ reconnectProjectId: 'proj-1' }))
    h.connects[2].resolve('c2')
    await flush()
    expect(a.phase('H1')).toBe('mounting')
    a.cancelProject('proj-1')
    expect(h.disconnected).toContain('c2')
    expect(a.phase('H1')).toBeNull()
    h.mounts[0].resolve({ projectId: 'proj-1' }) // lands late: ignored
    await flush()
    expect(a.phase('H1')).toBeNull()
    expect(a.run(boot())).toBe('started')
  })

  it('R40: cancelProject leaves other tabs\' teams alone, and releases a LIVE tab\'s team without reconnecting it', async () => {
    const h = harness()
    const a = createHostedAttempts(h.deps)
    a.run(boot({ hostId: 'H2', reconnectProjectId: 'proj-2' }))
    a.run(boot())
    h.connects[1].resolve('c1')
    await flush()
    h.mounts[0].resolve({ projectId: 'proj-1' })
    await flush()
    expect(a.phase('H1')).toBe('live')
    a.cancelProject('proj-1')
    expect(a.phase('H1')).toBeNull()
    expect(a.phase('H2')).toBe('connecting')
    expect(h.ended).toEqual([]) // a closed tab is not a drop: nothing to reconnect
  })

  it('R40: a manual hurry that names no tab keeps the tab the waiting loop was reconnecting', async () => {
    const h = harness()
    const a = createHostedAttempts(h.deps)
    a.run(boot({ reconnectProjectId: 'proj-1' }))
    h.connects[0].reject(wrap('[E_JOIN_NETWORK] x'))
    await flush()
    expect(a.run(boot({ manual: true, retry: false }))).toBe('started')
    h.connects[1].resolve('c1')
    await flush()
    expect(h.mounts[0].req.reconnectProjectId).toBe('proj-1')
  })

  // ── R41 ─────────────────────────────────────────────────────────────────────────────────────────
  it('R41: a throttle is retried after at least a minute, or the Retry-After when longer, and joins the 60 s tail', async () => {
    const h = harness()
    const a = createHostedAttempts(h.deps)
    a.run(boot())
    h.connects[0].reject(wrap('[E_JOIN_THROTTLED] limiting'))
    await flush()
    expect(a.phase('H1')).toBe('waiting')
    expect(h.armed()[0].ms).toBe(60_000)
    h.fire()
    h.connects[1].reject(wrap('[E_JOIN_THROTTLED] limiting [retry-after:150]'))
    await flush()
    expect(h.armed()[0].ms).toBe(150_000)
    h.fire()
    h.connects[2].reject(wrap('[E_JOIN_THROTTLED] limiting [retry-after:5]'))
    await flush()
    expect(h.armed()[0].ms).toBe(60_000) // never faster than once a minute
    h.fire()
    // A network failure right after a throttle stays on the tail: no burst back down to 1 s.
    h.connects[3].reject(wrap('[E_JOIN_NETWORK] x'))
    await flush()
    expect(h.armed()[0].ms).toBe(60_000)
    expect(h.stopped).toEqual([])
  })

  it('D2: a Retry-After longer than ten minutes waits ten minutes — a huge one never fires at once', async () => {
    const h = harness()
    const a = createHostedAttempts(h.deps)
    a.run(boot())
    // 99 999 999 s: past 2^31-1 ms, where a timer would fire immediately.
    h.connects[0].reject(wrap('[E_JOIN_THROTTLED] limiting [retry-after:99999999]'))
    await flush()
    expect(h.armed()[0].ms).toBe(600_000)
    h.fire()
    // Too many digits to be a number at all (Infinity): still ten minutes.
    h.connects[1].reject(wrap(`[E_JOIN_THROTTLED] limiting [retry-after:${'9'.repeat(400)}]`))
    await flush()
    expect(h.armed()[0].ms).toBe(600_000)
    h.fire()
    // Just under the ceiling is honoured as is.
    h.connects[2].reject(wrap('[E_JOIN_THROTTLED] limiting [retry-after:599]'))
    await flush()
    expect(h.armed()[0].ms).toBe(599_000)
  })

  it('R41: a throttle streak is announced once; a new streak (after the service answered) again', async () => {
    const h = harness()
    const a = createHostedAttempts(h.deps)
    a.run(boot())
    for (let i = 0; i < 3; i++) {
      h.connects[i].reject(wrap('[E_JOIN_THROTTLED] limiting'))
      await flush()
      h.fire()
    }
    expect(h.throttledSaid).toHaveLength(1)
    h.connects[3].resolve('c3') // the service answered: the streak is over
    await flush()
    h.mounts[0].resolve({ retry: true })
    await flush()
    h.fire()
    h.connects[4].reject(wrap('[E_JOIN_THROTTLED] limiting'))
    await flush()
    expect(h.throttledSaid).toHaveLength(2)
  })

  it('R41: a throttle on an attempt that asked not to retry (a pasted code) is told, not looped', async () => {
    const h = harness()
    const a = createHostedAttempts(h.deps)
    a.run(boot({ manual: true, retry: false }))
    h.connects[0].reject(wrap('[E_JOIN_THROTTLED] limiting'))
    await flush()
    expect(h.armed()).toEqual([])
    expect(h.stopped[0].f.code).toBe('E_JOIN_THROTTLED')
    expect(h.throttledSaid).toEqual([])
  })

  it('R41: a reconnect after a drop waits the 1 s rung first, then spends the rest of a fresh drop budget', async () => {
    const h = harness()
    const a = createHostedAttempts(h.deps)
    a.run(boot({ reconnectProjectId: 'proj-1', afterDrop: true }))
    expect(h.connects).toHaveLength(0)
    expect(a.phase('H1')).toBe('waiting')
    const delays = [h.armed()[0].ms]
    h.fire()
    for (let i = 0; i < 5; i++) {
      h.connects[i].resolve(`c${i}`)
      await flush()
      h.mounts[i].resolve({ retry: true })
      await flush()
      if (i < 4) {
        delays.push(h.armed()[0].ms)
        h.fire()
      }
    }
    expect(delays).toEqual([1000, 2000, 4000, 8000, 15000])
    expect(h.connects).toHaveLength(5)
    expect(h.exhausted).toHaveLength(1)
  })

  it('R41: a click during that first second hurries it (the user asked)', async () => {
    const h = harness()
    const a = createHostedAttempts(h.deps)
    a.run(boot({ reconnectProjectId: 'proj-1', afterDrop: true }))
    expect(a.run(boot({ manual: true, reconnectProjectId: 'proj-1' }))).toBe('started')
    expect(h.connects).toHaveLength(1)
    expect(h.armed()).toEqual([])
  })
})
