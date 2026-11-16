import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  Auth,
  LOCKOUT_MS,
  MAX_LOCKOUT_MS,
  MAX_FAILURES,
  GLOBAL_MAX_ATTEMPTS,
  GLOBAL_WINDOW_MS,
  CLIENT_MEMORY_MS,
  MAX_TRACKED_CLIENTS,
  passwordTooShort,
  type LoginGate
} from './auth'

let dir: string
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-auth-')) })
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); vi.useRealTimers() })

describe('Auth', () => {
  it('is unconfigured until a password is set; then verifies only the right one', async () => {
    const a = new Auth(dir)
    expect(a.isConfigured()).toBe(false)
    expect(await a.verifyPasswordAsync('anything')).toBe(false)
    a.setPassword('correct horse')
    expect(a.isConfigured()).toBe(true)
    expect(await a.verifyPasswordAsync('correct horse')).toBe(true)
    expect(await a.verifyPasswordAsync('wrong')).toBe(false)
    // survives process restart (re-read from disk)
    expect(await new Auth(dir).verifyPasswordAsync('correct horse')).toBe(true)
  })

  it('verifies OFF the event loop and at most two at a time (S1)', async () => {
    // A synchronous scrypt per login froze every terminal's WebSocket for ~35 ms per guess, and a
    // burst of held requests froze the whole server. The event loop must stay free while verifying,
    // and the libuv pool must not be flooded (two at a time).
    const a = new Auth(dir)
    a.setPassword('correct horse')
    let ticks = 0
    const timer = setInterval(() => ticks++, 1)
    const running: Promise<boolean>[] = []
    for (let i = 0; i < 6; i++) running.push(a.verifyPasswordAsync(i === 5 ? 'correct horse' : `w${i}`))
    expect(a._scryptInFlightForTest()).toBeLessThanOrEqual(2)
    const results = await Promise.all(running)
    clearInterval(timer)
    expect(results).toEqual([false, false, false, false, false, true])
    expect(ticks).toBeGreaterThan(5) // the loop kept turning while six scrypts ran
  }, 30_000)

  it('setup token is single-use and timing-safe-compared', () => {
    const a = new Auth(dir)
    const tok = a.setupToken()
    expect(a.setupToken()).toBe(tok) // stable within process
    expect(a.consumeSetupToken('wrong')).toBe(false)
    expect(a.consumeSetupToken(tok)).toBe(true)
    expect(a.consumeSetupToken(tok)).toBe(false) // consumed
  })

  it('sessions persist, validate, expire and revoke', () => {
    vi.useFakeTimers()
    const a = new Auth(dir)
    const t = a.createSession()
    expect(a.validateSession(t)).toBe(true)
    expect(a.validateSession('nope')).toBe(false)
    expect(a.validateSession(undefined)).toBe(false)
    expect(new Auth(dir).validateSession(t)).toBe(true) // persisted
    vi.advanceTimersByTime(31 * 24 * 60 * 60 * 1000)
    expect(a.validateSession(t)).toBe(false) // expired
    const t2 = a.createSession()
    a.revokeAll()
    expect(a.validateSession(t2)).toBe(false)
  })

  it('revokeSession deletes exactly the presented token, and listeners hear every revoke (S3)', () => {
    const a = new Auth(dir)
    const heard: number[] = []
    const off = a.onSessionsRevoked(() => heard.push(1))
    const t1 = a.createSession()
    const t2 = a.createSession()
    expect(a.revokeSession(t1)).toBe(true)
    expect(a.validateSession(t1)).toBe(false)
    expect(a.validateSession(t2)).toBe(true)
    expect(new Auth(dir).validateSession(t1)).toBe(false) // gone from disk, not only memory
    expect(a.revokeSession(t1)).toBe(false) // already gone: nothing to announce
    expect(a.revokeSession('constructor')).toBe(false) // not an own key
    expect(heard).toHaveLength(1)
    a.revokeAll()
    expect(heard).toHaveLength(2)
    off()
    a.revokeAll()
    expect(heard).toHaveLength(2)
  })

  it('a request-chosen token never indexes an object: odd keys are just "no such session"', () => {
    const a = new Auth(dir)
    const real = a.createSession()
    for (const key of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', '', 'x'.repeat(64)]) {
      expect(a.validateSession(key)).toBe(false)
      expect(a.revokeSession(key)).toBe(false)
    }
    expect(a.validateSession(real)).toBe(true)
    // On disk it is still the { token: { createdAt } } object every older build wrote and reads.
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'sessions.json'), 'utf8'))
    expect(Object.keys(onDisk)).toEqual([real])
    expect(typeof onDisk[real].createdAt).toBe('number')
  })

  it('loading sessions.json keeps only well-formed tokens (an older file keeps working)', () => {
    const good = 'a'.repeat(64)
    fs.writeFileSync(
      path.join(dir, 'sessions.json'),
      `{"${good}":{"createdAt":${Date.now()}},"__proto__":{"createdAt":${Date.now()}},"short":{"createdAt":${Date.now()}},"${'b'.repeat(64)}":{"createdAt":"soon"}}`
    )
    const a = new Auth(dir)
    expect(a.validateSession(good)).toBe(true)
    expect(a.validateSession('__proto__')).toBe(false)
    expect(a.validateSession('short')).toBe(false)
    expect(a.validateSession('b'.repeat(64))).toBe(false)
    // The malformed entries are gone from the next write, not carried along.
    const fresh = a.createSession()
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'sessions.json'), 'utf8'))
    expect(Object.keys(onDisk).sort()).toEqual([good, fresh].sort())
    fs.writeFileSync(path.join(dir, 'sessions.json'), '[1,2]')
    expect(new Auth(dir).validateSession(good)).toBe(false)
  })

  it('password rule: at least 8 characters, one definition for setup and the boot seed (S8)', () => {
    expect(passwordTooShort('1234567')).toBe(true)
    expect(passwordTooShort('12345678')).toBe(false)
  })
})

/** Reserve, then settle as `outcome`. */
function attempt(a: Auth, client: string, outcome: 'success' | 'failure' | 'abandoned'): LoginGate {
  const g = a.beginLoginAttempt(client)
  if (g.ok) g.finish(outcome)
  return g
}

describe('login rate limit (S1 + S4)', () => {
  it('a client is locked after MAX_FAILURES failures; success resets it', () => {
    vi.useFakeTimers()
    const a = new Auth(dir)
    for (let i = 0; i < MAX_FAILURES; i++) expect(attempt(a, 'v4:1.1.1.1', 'failure').ok).toBe(true)
    const locked = a.beginLoginAttempt('v4:1.1.1.1')
    expect(locked.ok).toBe(false)
    if (!locked.ok) {
      expect(locked.scope).toBe('client')
      expect(locked.retryAfterMs).toBeGreaterThan(LOCKOUT_MS - 1000)
      expect(locked.retryAfterMs).toBeLessThanOrEqual(LOCKOUT_MS)
    }
    vi.advanceTimersByTime(LOCKOUT_MS + 1)
    expect(attempt(a, 'v4:1.1.1.1', 'failure').ok).toBe(true)
    expect(attempt(a, 'v4:1.1.1.1', 'success').ok).toBe(true)
    for (let i = 0; i < MAX_FAILURES; i++) expect(attempt(a, 'v4:1.1.1.1', 'failure').ok).toBe(true)
    expect(a.beginLoginAttempt('v4:1.1.1.1').ok).toBe(false)
  })

  it('S4: one client locking itself out does not lock out anyone else', () => {
    const a = new Auth(dir)
    for (let i = 0; i < MAX_FAILURES; i++) attempt(a, 'v4:6.6.6.6', 'failure')
    expect(a.beginLoginAttempt('v4:6.6.6.6').ok).toBe(false)
    // The owner, from their own address, still gets in.
    expect(attempt(a, 'v4:1.2.3.4', 'success').ok).toBe(true)
  })

  it('S1: the budget counts attempts IN FLIGHT — held request bodies cannot all pass the gate', () => {
    // The old gate was checked before the body was read and charged only after verification, so
    // sixty requests whose bodies were held back all passed it with the counter still at zero.
    const a = new Auth(dir)
    const held: LoginGate[] = []
    for (let i = 0; i < 60; i++) held.push(a.beginLoginAttempt('v4:6.6.6.6'))
    expect(held.filter((g) => g.ok)).toHaveLength(MAX_FAILURES)
    // Abandoned (no body ever came) releases the slot without charging a failure.
    for (const g of held) if (g.ok) g.finish('abandoned')
    expect(held.filter((g) => g.ok).length).toBe(MAX_FAILURES)
    expect(a.beginLoginAttempt('v4:6.6.6.6').ok).toBe(true)
  })

  it('finish is idempotent: settling twice charges once', () => {
    const a = new Auth(dir)
    const g = a.beginLoginAttempt('v4:1.1.1.1')
    if (!g.ok) throw new Error('refused')
    g.finish('failure')
    g.finish('failure')
    g.finish('success') // a late second settle must not reset either
    for (let i = 0; i < MAX_FAILURES - 1; i++) expect(attempt(a, 'v4:1.1.1.1', 'failure').ok).toBe(true)
    expect(a.beginLoginAttempt('v4:1.1.1.1').ok).toBe(false)
  })

  it('lockouts back off exponentially per client, capped, and are forgotten after a quiet hour', () => {
    vi.useFakeTimers()
    const a = new Auth(dir)
    const lockOnce = (): number => {
      for (let i = 0; i < MAX_FAILURES; i++) expect(attempt(a, 'v4:6.6.6.6', 'failure').ok).toBe(true)
      const g = a.beginLoginAttempt('v4:6.6.6.6')
      if (g.ok) throw new Error('not locked')
      return g.retryAfterMs
    }
    const waits: number[] = []
    for (let n = 0; n < 9; n++) {
      const w = lockOnce()
      waits.push(w)
      vi.advanceTimersByTime(w + 1)
    }
    expect(waits.slice(0, 4)).toEqual([LOCKOUT_MS, 2 * LOCKOUT_MS, 4 * LOCKOUT_MS, 8 * LOCKOUT_MS])
    expect(Math.max(...waits)).toBe(MAX_LOCKOUT_MS)
    // A quiet hour after the last lock ended: back to the first step.
    vi.advanceTimersByTime(CLIENT_MEMORY_MS + 1)
    expect(lockOnce()).toBe(LOCKOUT_MS)
  })

  it('a global ceiling across all clients is the backstop for a distributed guesser', () => {
    vi.useFakeTimers()
    const a = new Auth(dir)
    let n = 0
    // Each client stays under its own budget; together they reach the ceiling.
    while (n < GLOBAL_MAX_ATTEMPTS) {
      expect(attempt(a, `v4:10.0.${Math.floor(n / 4)}.1`, 'failure').ok).toBe(true)
      n++
    }
    const refused = a.beginLoginAttempt('v4:1.2.3.4')
    expect(refused.ok).toBe(false)
    if (!refused.ok) {
      expect(refused.scope).toBe('global')
      expect(refused.retryAfterMs).toBeLessThanOrEqual(GLOBAL_WINDOW_MS)
    }
    // It is a sliding window: once the failures age out, everyone can sign in again.
    vi.advanceTimersByTime(GLOBAL_WINDOW_MS + 1)
    expect(attempt(a, 'v4:1.2.3.4', 'success').ok).toBe(true)
  })

  it('the global ceiling also counts attempts in flight (S1 across many clients)', () => {
    const a = new Auth(dir)
    const held: LoginGate[] = []
    for (let i = 0; i < 400; i++) held.push(a.beginLoginAttempt(`v4:10.1.${i}.1`))
    expect(held.filter((g) => g.ok)).toHaveLength(GLOBAL_MAX_ATTEMPTS)
    for (const g of held) if (g.ok) g.finish('abandoned')
    expect(a.beginLoginAttempt('v4:1.2.3.4').ok).toBe(true)
  })

  it('tracks a bounded number of clients', () => {
    const a = new Auth(dir)
    for (let i = 0; i < MAX_TRACKED_CLIENTS + 500; i++) {
      const g = a.beginLoginAttempt(`v4:k${i}`)
      if (g.ok) g.finish('abandoned')
    }
    expect(a._trackedClientsForTest()).toBeLessThanOrEqual(MAX_TRACKED_CLIENTS)
  })
})
