// src/core/relay/hosted-scheduler.test.ts
import { describe, it, expect, vi } from 'vitest'
import nacl from 'tweetnacl'
import { createHostedScheduler, type MintResult, type SchedulerStatus } from './hosted-scheduler'
import { mintHostToken } from './host-token'
import { POP_REFUSED_MESSAGE } from './relay-pop'
import { createTestPopServer } from './relay-pop.test-server'

// Flush with macrotask turns, not a fixed count of microtasks: how many awaits an async mint takes
// is an implementation detail the tests must not pin.
const flush = async (turns = 5) => {
  for (let i = 0; i < turns; i++) await new Promise<void>((r) => setImmediate(r))
}

type Opened = { bridged: boolean; closed: boolean; token: string; ev: { onBridged(): void; onClose(): void }; close(): void }

function harness(mints: Array<MintResult | (() => Promise<MintResult>)>, opts: {
  open?: (tok: string, ev: { onBridged(): void; onClose(): void }) => Opened
  onStatus?: (s: SchedulerStatus) => void
  firstTimerId?: number
} = {}) {
  let t = 0
  const timers: Array<{ at: number; fn: () => void; id: number; ms: number }> = []
  const delays: number[] = []
  let seq = (opts.firstTimerId ?? 1) - 1
  let mintCalls = 0
  const opened: Opened[] = []
  const s = createHostedScheduler({
    mint: async () => {
      mintCalls++
      const next = mints.shift()
      if (typeof next === 'function') return next()
      return next ?? { ok: false, kind: 'network' }
    },
    open: (tok, ev) => {
      if (opts.open) return opts.open(tok, ev)
      const l: Opened = { bridged: false, closed: false, token: tok, ev, close() { l.closed = true } }
      opened.push(l)
      return l
    },
    setTimeout: (fn, ms) => { const id = ++seq; timers.push({ at: t + ms, fn, id, ms }); delays.push(ms); return id },
    clearTimeout: (id) => { const i = timers.findIndex((x) => x.id === id); if (i >= 0) timers.splice(i, 1) },
    onStatus: opts.onStatus
  }, () => t)
  const advance = async (ms: number) => {
    const target = t + ms
    for (;;) {
      timers.sort((a, b) => a.at - b.at)
      const due = timers[0]
      if (!due || due.at > target) break
      timers.shift()
      t = due.at
      due.fn()
      await flush()
    }
    t = target
  }
  return { s, opened, advance, timers, delays, mintCalls: () => mintCalls }
}
const ok = (ttlMs = 120_000): MintResult => ({ ok: true, pairingToken: 'T', hostId: 'H', ttlMs })
const okMany = (n: number): MintResult[] => Array.from({ length: n }, () => ok())
const listener = (tok: string, ev: { onBridged(): void; onClose(): void }): Opened => {
  const l: Opened = { bridged: false, closed: false, token: tok, ev, close() { l.closed = true } }
  return l
}
const HOUR = 3_600_000
const TIMER_MAX = 2_147_483_647

describe('hosted scheduler', () => {
  it('keeps one idle listener and replaces it before the token expires', async () => {
    const h = harness([ok(), ok()])
    h.s.start(); await flush()
    expect(h.opened).toHaveLength(1)
    await h.advance(90_000) // 120 s TTL − 30 s lead
    expect(h.opened[0].closed).toBe(true)
    expect(h.opened).toHaveLength(2)
  })
  it('a bridged listener is never cut for a refresh, and a new idle one is opened', async () => {
    const h = harness([ok(), ok()])
    h.s.start(); await flush()
    h.opened[0].ev.onBridged(); await flush()
    expect(h.opened).toHaveLength(2)
    await h.advance(90_000)
    expect(h.opened[0].closed).toBe(false)
  })
  it('a mint success does NOT reset the backoff when sockets keep dying (relay down, API up)', async () => {
    const h = harness([ok(), ok(), ok(), ok()])
    h.s.start(); await flush()
    h.opened[0].ev.onClose(); await flush()
    await h.advance(1000); h.opened[1].ev.onClose(); await flush()
    await h.advance(1999)
    expect(h.opened).toHaveLength(2) // second retry waits the full 2 s
    await h.advance(1); expect(h.opened).toHaveLength(3)
  })
  it('429 waits max(60 s, Retry-After); 402 stops with backend-refused', async () => {
    const h = harness([{ ok: false, kind: 'rate-limited', retryAfterMs: 90_000 }, ok()])
    h.s.start(); await flush()
    await h.advance(89_999); expect(h.opened).toHaveLength(0)
    await h.advance(1); await flush(); expect(h.opened).toHaveLength(1)
    const r = harness([{ ok: false, kind: 'refused', status: 402 }])
    r.s.start(); await flush()
    expect(r.s.status().state).toBe('backend-refused')
    expect(r.timers).toHaveLength(0)
  })
  it('counts mints in the last hour', async () => {
    const h = harness([ok(), ok()])
    h.s.start(); await flush()
    expect(h.s.status().mintsLastHour).toBe(1)
  })

  // --- beyond the brief: the rest of the ported rules and the failure modes that would wedge it ---

  it('a 429 without Retry-After still waits the 60 s floor', async () => {
    const h = harness([{ ok: false, kind: 'rate-limited', status: 429 }, ok()])
    h.s.start(); await flush()
    await h.advance(59_999); expect(h.opened).toHaveLength(0)
    await h.advance(1); expect(h.opened).toHaveLength(1)
  })

  it('a Retry-After beyond the timer range is clamped, never overflowing into a ~1 ms re-mint loop', async () => {
    // Node's setTimeout fires after 1 ms for any delay above 2^31-1: an unclamped 30-day wait is
    // a tight loop against the very API that asked us to back off.
    const h = harness([{ ok: false, kind: 'rate-limited', status: 429, retryAfterMs: 30 * 24 * 3_600_000 }])
    h.s.start(); await flush()
    expect(h.delays).toHaveLength(1)
    expect(h.delays[0]).toBeGreaterThanOrEqual(60_000)
    expect(h.delays[0]).toBe(TIMER_MAX) // capped at setTimeout's own limit, not shortened below it
  })

  it('a 2 h Retry-After is honored in full (a 429 waits max(60 s, Retry-After), never less)', async () => {
    const h = harness([{ ok: false, kind: 'rate-limited', status: 429, retryAfterMs: 2 * HOUR }, ok()])
    h.s.start(); await flush()
    await h.advance(2 * HOUR - 1)
    expect(h.mintCalls()).toBe(1)
    expect(h.opened).toHaveLength(0)
    await h.advance(1)
    expect(h.opened).toHaveLength(1)
  })

  it('a missing, NaN or absurd ttl never arms a refresh below 15 s or beyond the timer range', async () => {
    const h = harness([ok(Number.NaN), ok(-5_000), ok(1e15)])
    h.s.start(); await flush()
    expect(h.delays.at(-1)).toBe(90_000) // NaN → the default 120 s TTL − 30 s lead
    h.opened[0].ev.onBridged(); await flush()
    expect(h.delays.at(-1)).toBe(15_000) // already expired → the 15 s floor
    h.opened[1].ev.onBridged(); await flush()
    expect(h.delays.at(-1)).toBe(TIMER_MAX)
  })

  it('a bridged session ending does not advance the backoff (only a relay failure does)', async () => {
    const h = harness([ok(), ok(), ok()])
    h.s.start(); await flush()
    h.opened[0].ev.onBridged(); await flush()
    expect(h.opened).toHaveLength(2)
    h.opened[0].ev.onClose(); await flush() // the teammate left: not a relay failure
    expect(h.opened).toHaveLength(2) // the idle replacement already exists
    expect(h.timers.filter((x) => x.ms === 1000 || x.ms === 2000)).toHaveLength(0)
    h.opened[1].ev.onClose(); await flush() // the idle one dies on its own: the FIRST backoff step
    await h.advance(1000)
    expect(h.opened).toHaveLength(3)
  })

  it('a bridged session ending never mints over a pending backoff (a 429 wait stays a wait)', async () => {
    const h = harness([ok(), { ok: false, kind: 'rate-limited', status: 429, retryAfterMs: 60_000 }, ok()])
    h.s.start(); await flush()
    h.opened[0].ev.onBridged(); await flush() // the replacement mint is answered 429
    expect(h.mintCalls()).toBe(2)
    h.opened[0].ev.onClose(); await flush() // the teammate leaves while the 429 wait is armed
    await h.advance(59_999)
    expect(h.mintCalls()).toBe(2)
    await h.advance(1)
    expect(h.mintCalls()).toBe(3)
    expect(h.opened).toHaveLength(2)
  })

  it('never runs two mints at once', async () => {
    const h = harness([ok(), () => new Promise<MintResult>(() => {}) /* replacement mint hangs */])
    h.s.start(); await flush()
    h.opened[0].ev.onBridged(); await flush()
    expect(h.mintCalls()).toBe(2) // the replacement mint is in flight
    h.opened[0].ev.onBridged(); await flush()
    h.opened[0].ev.onClose(); await flush()
    expect(h.mintCalls()).toBe(2)
  })

  it('onBridged twice (pending, then approved) is one bridge: one replacement, no second proof', async () => {
    // The hosted service reports a peer on the pending handshake AND again on approval. The second
    // report is the same peer, not new evidence: it must not open a second replacement, nor wipe a
    // failure that happened in between (here the replacement mint was answered 503).
    const h = harness([ok(), { ok: false, kind: 'network', status: 503 }, ok()])
    h.s.start(); await flush()
    h.opened[0].ev.onBridged(); await flush()
    expect(h.s.status().lastError).toBe('network (503)')
    h.opened[0].ev.onBridged(); await flush()
    expect(h.s.status().lastError).toBe('network (503)')
    expect(h.mintCalls()).toBe(2)
    await h.advance(1000) // the backoff, not the second report, owns the next mint
    expect(h.opened).toHaveLength(2)
    expect(h.s.status()).toMatchObject({ idle: 1, bridged: 1 })
    expect(h.opened[0].bridged).toBe(true)
  })

  it('an intentional close (refresh / stop) never counts as a relay failure, even if it fires onClose', async () => {
    const h = harness([ok(), ok(), ok()], {
      open: (tok, ev) => {
        const l: Opened = { bridged: false, closed: false, token: tok, ev, close() { l.closed = true; ev.onClose() } }
        h.opened.push(l)
        return l
      }
    })
    h.s.start(); await flush()
    await h.advance(90_000) // refresh: close() fires onClose synchronously
    expect(h.opened).toHaveLength(2)
    expect(h.timers.map((x) => x.ms)).toEqual([90_000]) // only the new refresh, no backoff armed
  })

  it('a mint that THROWS backs off and retries instead of wedging the scheduler', async () => {
    const h = harness([() => Promise.reject(new Error('host key unreadable')), ok()])
    h.s.start(); await flush()
    expect(h.s.status()).toMatchObject({ state: 'running', idle: 0 })
    expect(h.s.status().lastError).toMatch(/mint/)
    await h.advance(1000)
    expect(h.opened).toHaveLength(1)
  })

  it('an open() that THROWS (bad relay URL) backs off and retries instead of wedging', async () => {
    let fail = true
    const h = harness([ok(), ok()], {
      open: (tok, ev) => {
        if (fail) { fail = false; throw new SyntaxError('Invalid URL') }
        const l: Opened = { bridged: false, closed: false, token: tok, ev, close() { l.closed = true } }
        h.opened.push(l)
        return l
      }
    })
    h.s.start(); await flush()
    expect(h.opened).toHaveLength(0)
    expect(h.s.status().lastError).toMatch(/open/)
    await h.advance(1000)
    expect(h.opened).toHaveLength(1)
  })

  it('an onStatus observer that throws never wedges the lifecycle', async () => {
    const h = harness([ok(), ok()], { onStatus: () => { throw new Error('observer bug') } })
    h.s.start(); await flush()
    expect(h.opened).toHaveLength(1)
    await h.advance(90_000)
    expect(h.opened).toHaveLength(2)
  })

  it('lastError reports a relay that drops idle listeners, and clears only on proof the relay works', async () => {
    const h = harness([ok(), ok(), ok()]) // the third is the replacement minted after the bridge
    h.s.start(); await flush()
    expect(h.s.status().lastError).toBeNull()
    h.opened[0].ev.onClose(); await flush()
    expect(h.s.status().lastError).toMatch(/relay/)
    await h.advance(1000) // a fresh mint succeeds — still not proof the relay leg works
    expect(h.opened).toHaveLength(2)
    expect(h.s.status().lastError).toMatch(/relay/)
    h.opened[1].ev.onBridged(); await flush() // a peer bridged: that IS proof
    expect(h.s.status().lastError).toBeNull()
  })

  it('stop() closes every listener, cancels timers, and a mint landing afterwards opens nothing', async () => {
    let release!: (r: MintResult) => void
    const h = harness([ok(), () => new Promise<MintResult>((r) => { release = r })])
    h.s.start(); await flush()
    h.opened[0].ev.onBridged(); await flush() // replacement mint now in flight
    h.s.stop()
    expect(h.opened[0].closed).toBe(true)
    expect(h.timers).toHaveLength(0)
    expect(h.s.status()).toMatchObject({ state: 'stopped', idle: 0, bridged: 0 })
    release(ok()); await flush()
    expect(h.opened).toHaveLength(1)
    expect(h.timers).toHaveLength(0)
  })

  it('stop() then start() while a mint is in flight still ends with one idle listener', async () => {
    let release!: (r: MintResult) => void
    const h = harness([() => new Promise<MintResult>((r) => { release = r })])
    h.s.start(); await flush()
    h.s.stop()
    h.s.start(); await flush()
    release(ok()); await flush()
    expect(h.opened).toHaveLength(1)
    expect(h.s.status()).toMatchObject({ state: 'running', idle: 1 })
  })

  it('a timer handle of 0 is still a timer (stop() clears it, and it still owns the next mint)', async () => {
    // Browsers number timers from 1, but an injected setTimeout may legitimately hand back 0.
    const h = harness([{ ok: false, kind: 'network', status: 503 }], { firstTimerId: 0 })
    h.s.start(); await flush()
    expect(h.timers.map((x) => x.id)).toEqual([0])
    h.s.stop()
    expect(h.timers).toHaveLength(0)
  })

  it('start() after backend-refused mints again', async () => {
    const h = harness([{ ok: false, kind: 'refused', status: 402 }, ok()])
    h.s.start(); await flush()
    expect(h.s.status().state).toBe('backend-refused')
    h.s.start(); await flush()
    expect(h.s.status()).toMatchObject({ state: 'running', idle: 1, lastError: expect.stringContaining('402') })
  })

  it('mintsLastHour forgets mints older than an hour', async () => {
    // An idle listener is re-minted every 90 s: mints land at 0, 90 s, …, 3600 s (41 of them).
    const h = harness(Array.from({ length: 60 }, () => ok()))
    h.s.start(); await flush()
    await h.advance(3_600_000)
    expect(h.s.status().mintsLastHour).toBe(41)
    await h.advance(1) // the mint at t=0 is now more than an hour old
    expect(h.s.status().mintsLastHour).toBe(40)
  })
  it('a listener that bridges AND closes synchronously inside open() does not leave the scheduler dead', async () => {
    let first = true
    const h = harness([ok(), ok()], {
      open: (tok, ev) => {
        const l = listener(tok, ev)
        h.opened.push(l)
        if (first) { first = false; ev.onBridged(); ev.onClose() }
        return l
      }
    })
    h.s.start(); await flush()
    expect(h.opened).toHaveLength(2)
    expect(h.s.status()).toMatchObject({ state: 'running', idle: 1, bridged: 0 })
  })

  it("only an IDLE listener's refresh proves the registration path: a bridged one neither resets the backoff nor holds a timer", async () => {
    let drop = false
    const h = harness(okMany(100), {
      open: (tok, ev) => {
        const l = listener(tok, ev)
        h.opened.push(l)
        if (drop) queueMicrotask(() => ev.onClose()) // the relay refuses every NEW registration
        return l
      }
    })
    h.s.start(); await flush()
    drop = true
    h.opened[0].ev.onBridged(); await flush() // a teammate stays connected throughout
    expect(h.s.status()).toMatchObject({ idle: 0, bridged: 1 })
    // Its refresh timer went with the bridge: the only timer is the backoff for the refused newcomer.
    expect(h.timers.map((x) => x.ms)).toEqual([1000])
    await h.advance(600_000) // several 90 s refresh periods of the bridged listener
    const backoffs = h.delays.filter((d) => d <= 15_000)
    const settled = backoffs.indexOf(15_000)
    expect(settled).toBeGreaterThan(-1)
    // Once the backoff has climbed to its ceiling, nothing may knock it back down to 1 s.
    expect(backoffs.slice(settled).every((d) => d === 15_000)).toBe(true)
    expect(h.s.status().lastError).toMatch(/relay/)
    // The bridged listener holds no refresh timer at all (only the pending backoff is armed).
    expect(h.timers).toHaveLength(1)
  })

  it('(a) a peer that connects and leaves every 10 s cannot push the mint rate past the hourly budget', async () => {
    const seen = new Set<string | null>()
    const h = harness(okMany(1000), { onStatus: (st) => seen.add(st.lastError) })
    const left = new Set<Opened>()
    h.s.start(); await flush()
    for (let i = 0; i < 359; i++) {
      await h.advance(10_000)
      const idle = [...h.opened].reverse().find((l) => !l.bridged && !l.closed && !left.has(l))
      if (!idle) continue // the budget is holding: no listener to join right now
      idle.ev.onBridged(); await flush()
      idle.ev.onClose(); left.add(idle); await flush()
    }
    expect(h.mintCalls()).toBeLessThanOrEqual(200) // every mint so far falls inside one hour
    expect(seen.has('mint budget')).toBe(true)
    await h.advance(HOUR) // the budget releases: hosting comes back on its own
    expect(h.s.status()).toMatchObject({ state: 'running', idle: 1 })
  })

  it('(b) a relay that drops every NEW registration beside one long-lived bridged session stays within budget', async () => {
    let drop = false
    const h = harness(okMany(1000), {
      open: (tok, ev) => {
        const l = listener(tok, ev)
        h.opened.push(l)
        if (drop) queueMicrotask(() => ev.onClose())
        return l
      }
    })
    h.s.start(); await flush()
    drop = true
    h.opened[0].ev.onBridged(); await flush()
    await h.advance(HOUR)
    expect(h.mintCalls()).toBeLessThanOrEqual(200)
  })

  it('(c) six bridged sessions on staggered phases do not multiply the re-mint rate', async () => {
    let drop = false
    const h = harness(okMany(2000), {
      open: (tok, ev) => {
        const l = listener(tok, ev)
        h.opened.push(l)
        if (drop) queueMicrotask(() => ev.onClose())
        return l
      }
    })
    h.s.start(); await flush()
    for (let k = 0; k < 6; k++) {
      await h.advance(15_000)
      h.opened[h.opened.length - 1].ev.onBridged(); await flush() // bridge whichever listener is idle
    }
    expect(h.s.status()).toMatchObject({ idle: 1, bridged: 6 })
    drop = true
    const before = h.mintCalls()
    await h.advance(HOUR)
    expect(h.mintCalls() - before).toBeLessThanOrEqual(200)
  })

  // --- relay proof of possession (relay-pop.ts) ---

  const popRefused = (reason: 'pop_required' | 'pop_invalid' = 'pop_invalid'): MintResult =>
    ({ ok: false, kind: 'refused', status: 403, reason })

  it.each(['pop_required', 'pop_invalid'] as const)(
    'two %s refusals in a row stop with backend-refused and the proof message; the first backs off',
    async (reason) => {
      const h = harness([popRefused(reason), popRefused(reason)])
      h.s.start(); await flush()
      // The first is transient (a POP_SECRET rotation mid challenge→mint looks exactly like this),
      // and says so: an operator reading `team status` must not see a bare `network (403)`.
      expect(h.s.status()).toMatchObject({
        state: 'running',
        lastError: `key proof refused once (${reason}) — retrying with a fresh challenge`
      })
      expect(h.timers).toHaveLength(1) // the backoff owns the next mint (a fresh challenge)
      await h.advance(1000)
      expect(h.mintCalls()).toBe(2)
      expect(h.s.status()).toMatchObject({ state: 'backend-refused', lastError: POP_REFUSED_MESSAGE })
      expect(h.timers).toHaveLength(0)
    }
  )

  it.each<[string, MintResult]>([
    ['a 503', { ok: false, kind: 'network', status: 503 }],
    ['a 429', { ok: false, kind: 'rate-limited', status: 429 }],
    ['a bad response', { ok: false, kind: 'bad-response' }]
  ])('a transient failure between two refusals does not reset the count: refusal, %s, refusal stops', async (_label, transient) => {
    // Only a successful mint (or start()) proves the key is accepted. Resetting on a transient
    // failure would let a backend that refuses every proof, behind a flaky challenge, loop forever.
    const h = harness([popRefused(), transient, popRefused()])
    h.s.start(); await flush()
    expect(h.s.status().state).toBe('running')
    await h.advance(1000) // the backoff → the transient failure
    expect(h.mintCalls()).toBe(2)
    expect(h.s.status().state).toBe('running')
    await h.advance(60_000) // the next backoff step (or the 429's 60 s floor) → refused again
    expect(h.mintCalls()).toBe(3)
    expect(h.s.status()).toMatchObject({ state: 'backend-refused', lastError: POP_REFUSED_MESSAGE })
    expect(h.timers).toHaveLength(0)
  })

  it('each key-proof refusal is logged with its kind: warn on the first, error on the terminal one', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const h = harness([popRefused('pop_required'), popRefused('pop_invalid')])
      h.s.start(); await flush()
      expect(warn).toHaveBeenCalledTimes(1)
      expect(String(warn.mock.calls[0][0])).toContain('pop_required')
      expect(error).not.toHaveBeenCalled()
      await h.advance(1000)
      expect(h.s.status().state).toBe('backend-refused')
      expect(warn).toHaveBeenCalledTimes(1)
      expect(error).toHaveBeenCalledTimes(1)
      expect(String(error.mock.calls[0][0])).toContain('pop_invalid')
    } finally {
      warn.mockRestore()
      error.mockRestore()
    }
  })

  it('a refusal that is not a key proof (402) logs nothing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const h = harness([{ ok: false, kind: 'refused', status: 402 }])
      h.s.start(); await flush()
      expect(h.s.status()).toMatchObject({ state: 'backend-refused', lastError: 'refused (402)' })
      expect(warn).not.toHaveBeenCalled()
      expect(error).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
      error.mockRestore()
    }
  })

  it('one PoP refusal then a successful mint: hosting keeps running', async () => {
    const h = harness([popRefused(), ok()])
    h.s.start(); await flush()
    await h.advance(1000)
    expect(h.s.status()).toMatchObject({ state: 'running', idle: 1 })
    expect(h.opened).toHaveLength(1)
  })

  it('a successful mint resets the count: refusal, success, refusal is still transient', async () => {
    const h = harness([popRefused(), ok(), popRefused(), popRefused()])
    h.s.start(); await flush()
    await h.advance(1000) // retry → success
    expect(h.opened).toHaveLength(1)
    h.opened[0].ev.onBridged(); await flush() // bridged → a replacement is minted, and refused
    expect(h.mintCalls()).toBe(3)
    expect(h.s.status().state).toBe('running') // the first refusal since the success
    await h.advance(1000)
    expect(h.mintCalls()).toBe(4)
    expect(h.s.status().state).toBe('backend-refused') // the second in a row
  })

  it('start() resets the count: a refusal before a stop does not make the next one terminal', async () => {
    const h = harness([popRefused(), popRefused()])
    h.s.start(); await flush()
    expect(h.s.status().state).toBe('running')
    h.s.stop()
    h.s.start(); await flush()
    expect(h.mintCalls()).toBe(2)
    expect(h.s.status().state).toBe('running') // the first refusal of THIS run
  })

  it('a POP_SECRET rotated between the challenge and the mint: the real mint backs off, re-challenges and proves', async () => {
    // Backend A issues the challenge, backend B (the new secret) verifies the mint: an honest host
    // earns pop_invalid once. Stopping there would stop every host mid-mint at the rotation.
    const keys = nacl.box.keyPair()
    const pub = Buffer.from(keys.publicKey).toString('base64')
    const oldSecret = createTestPopServer('old-secret-'.padEnd(40, 'o'))
    const newSecret = createTestPopServer('new-secret-'.padEnd(40, 'n'))
    let issuer = oldSecret
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status })
    const f = (async (u: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>
      if (u.endsWith('/v1/relay/challenge')) {
        const c = issuer.issue(pub, 'host-token')
        issuer = newSecret // the rotation lands right after the first challenge
        return json(200, c)
      }
      const proven = newSecret.verify({ hostPublicKeyB64: pub, purpose: 'host-token', subject: String(body.deviceId ?? ''), popChallenge: body.popChallenge, popProof: body.popProof })
      return proven ? json(200, { pairingToken: 'T', hostId: 'H', exp: 0 }) : json(403, { error: 'pop_invalid' })
    }) as typeof fetch
    const mint = () => mintHostToken({ apiBase: 'https://api', deviceId: 'd', hostPublicKeyB64: pub, hostSecretKey: keys.secretKey, fetch: f })
    const h = harness([mint, mint])
    h.s.start(); await flush()
    expect(h.s.status().state).toBe('running')
    await h.advance(1000); await flush()
    expect(h.opened).toHaveLength(1)
    expect(h.s.status().state).toBe('running')
  })

  it('a pop_required answer to an unproven mint (challenge 404 mid-redeploy) backs off and proves on the retry', async () => {
    // The real mint against a fake API: while the backend redeploys its proxy answers the challenge
    // 404, the unproven mint lands on the fresh backend and earns pop_required. That must be a retry,
    // never backend-refused — and the retry asks for a fresh challenge and proves.
    const keys = nacl.box.keyPair()
    const pub = Buffer.from(keys.publicKey).toString('base64')
    const pop = createTestPopServer()
    let redeploying = true
    const urls: string[] = []
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status })
    const f = (async (u: string, init: RequestInit) => {
      urls.push(u)
      const body = JSON.parse(String(init.body)) as Record<string, unknown>
      if (u.endsWith('/v1/relay/challenge')) return redeploying ? json(404, {}) : json(200, pop.issue(pub, 'host-token'))
      if (!pop.verify({ hostPublicKeyB64: pub, purpose: 'host-token', subject: String(body.deviceId ?? ''), popChallenge: body.popChallenge, popProof: body.popProof }))
        return json(403, { error: 'pop_required' })
      return json(200, { pairingToken: 'T', hostId: 'H', exp: 0 })
    }) as typeof fetch
    const mint = () => mintHostToken({ apiBase: 'https://api', deviceId: 'd', hostPublicKeyB64: pub, hostSecretKey: keys.secretKey, fetch: f })
    const h = harness([mint, mint])
    h.s.start(); await flush()
    expect(h.s.status()).toMatchObject({ state: 'running', lastError: 'network (403)' })
    expect(h.timers).toHaveLength(1) // the backoff owns the next mint
    expect(h.opened).toHaveLength(0)
    redeploying = false
    await h.advance(1000); await flush()
    expect(h.opened).toHaveLength(1)
    expect(urls.map((u) => u.replace('https://api', ''))).toEqual([
      '/v1/relay/challenge', '/v1/relay/host-token', '/v1/relay/challenge', '/v1/relay/host-token'
    ])
  })

  it('a rate-limited challenge (429, shared per-IP limit) waits the 60 s floor before the next mint', async () => {
    const keys = nacl.box.keyPair()
    const pub = Buffer.from(keys.publicKey).toString('base64')
    let challenges = 0
    const f = (async (u: string) => {
      if (u.endsWith('/v1/relay/challenge')) { challenges++; return new Response('{}', { status: 429 }) }
      throw new Error('no mint may follow a refused challenge')
    }) as typeof fetch
    const mint = () => mintHostToken({ apiBase: 'https://api', deviceId: 'd', hostPublicKeyB64: pub, hostSecretKey: keys.secretKey, fetch: f })
    const h = harness([mint, mint])
    h.s.start(); await flush()
    expect(h.s.status()).toMatchObject({ state: 'running', lastError: 'rate-limited (429)' })
    await h.advance(59_999)
    expect(challenges).toBe(1)
    await h.advance(1)
    expect(challenges).toBe(2)
  })
})
