// scrypt (built-in) instead of the spec's argon2 — no native dependency; parameters N=16384,r=8,p=1 per OWASP baseline.
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'

const SCRYPT_N = 16384
const SCRYPT_R = 8
const SCRYPT_P = 1
const SCRYPT_KEYLEN = 32

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000

/** The one password-length rule: the setup form refuses below it, the boot seed warns below it. */
export const MIN_PASSWORD_LENGTH = 8
export function passwordTooShort(password: string): boolean {
  return password.length < MIN_PASSWORD_LENGTH
}

// ---- Login rate limit (security audit 2026-10, S1 + S4) -------------------------------------
//
// S1: the old gate was CHECKED before the request body was read and CHARGED after the password
// was verified, so N requests whose bodies were held back all passed it with the counter at zero
// (measured: 60 of 60 verified). Now an attempt RESERVES a slot synchronously before the body is
// read, and the budget counts reserved slots plus failures — so at most MAX_FAILURES attempts per
// client can ever be outstanding or failed before the lock, however they are timed.
//
// S4: one global counter let anyone lock the owner out with five wrong passwords a minute. The
// lock is per CLIENT now (an address, see client-address.ts), with exponential backoff, and a much
// higher global ceiling across all clients stays as the backstop against a guesser with many
// addresses. The ceiling also counts in-flight attempts, or the S1 race would reopen across
// clients. Its cost, stated: under a sustained distributed attack the ceiling refuses the owner
// too, for as long as the attack keeps the window full.

/** First lock a client earns; each further lock doubles it, up to MAX_LOCKOUT_MS. */
export const LOCKOUT_MS = 60_000
export const MAX_LOCKOUT_MS = 60 * 60_000
/** Failures (plus attempts still in flight) a client may have before it is locked. */
export const MAX_FAILURES = 5
/** The global backstop: failures within the window plus every attempt in flight, all clients. */
export const GLOBAL_WINDOW_MS = 5 * 60_000
export const GLOBAL_MAX_ATTEMPTS = 50
/** A client quiet this long after its last attempt or lock is forgotten (backoff starts over). */
export const CLIENT_MEMORY_MS = 60 * 60_000
/** Bounded memory: past this many tracked clients, the least recently seen are forgotten. */
export const MAX_TRACKED_CLIENTS = 10_000
/** Concurrent scrypt verifications (each is ~16 MiB and a libuv pool thread). */
export const SCRYPT_SLOTS = 2

export type LoginOutcome = 'success' | 'failure' | 'abandoned'
/** A reserved login attempt (settle it exactly once), or a refusal and when to come back. */
export type LoginGate =
  | { ok: true; finish(outcome: LoginOutcome): void }
  | { ok: false; retryAfterMs: number; scope: 'client' | 'global' }

interface ClientState {
  failures: number
  inFlight: number
  lockedUntil: number
  /** How many locks this client has earned in a row — the backoff exponent. */
  level: number
  lastSeen: number
}

/** A FIFO gate: at most `slots` tasks run at once, the rest wait in order. */
function fifoGate(slots: number): { run<T>(task: () => Promise<T>): Promise<T>; active(): number } {
  let active = 0
  const waiting: (() => void)[] = []
  const release = (): void => {
    const next = waiting.shift()
    if (next) next()
    else active--
  }
  return {
    active: () => active,
    run: <T>(task: () => Promise<T>): Promise<T> =>
      new Promise<T>((resolve, reject) => {
        const go = (): void => {
          let p: Promise<T>
          try {
            p = Promise.resolve(task())
          } catch (err) {
            p = Promise.reject(err)
          }
          p.then(resolve, reject).finally(release)
        }
        if (active < slots) {
          active++
          go()
        } else waiting.push(go)
      })
  }
}

function scryptAsync(password: string, salt: Buffer, keylen: number, opts: crypto.ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    crypto.scrypt(password, salt, keylen, opts, (err, key) => (err ? reject(err) : resolve(key)))
  )
}

interface AuthFile {
  salt: string
  hash: string
  N: number
  r: number
  p: number
}

interface SessionEntry {
  createdAt: number
}

/** Sessions by token. A `Map`, never a plain object: the token arrives in a request cookie, and a
 *  request-chosen key must not index (or `delete` from) an object's own properties. On disk it stays
 *  the `{ token: { createdAt } }` object it always was. */
type SessionMap = Map<string, SessionEntry>

/** What `createSession` mints: 32 random bytes as hex. Anything else is not a token of ours. */
const SESSION_TOKEN_RE = /^[0-9a-f]{64}$/

function isSessionToken(token: string | undefined): token is string {
  return typeof token === 'string' && SESSION_TOKEN_RE.test(token)
}

export class Auth {
  private authPath: string
  private sessionsPath: string

  private setupTokenValue: string | null = null

  private sessions: SessionMap | null = null
  private revokeListeners = new Set<() => void>()

  private clients = new Map<string, ClientState>()
  /** Times of recent failures, all clients (pruned to GLOBAL_WINDOW_MS). */
  private globalFailures: number[] = []
  private globalInFlight = 0
  private scryptGate = fifoGate(SCRYPT_SLOTS)

  constructor(dataDir: string) {
    this.authPath = path.join(dataDir, 'auth.json')
    this.sessionsPath = path.join(dataDir, 'sessions.json')
  }

  // ---- Configuration / password ------------------------------------------

  isConfigured(): boolean {
    return fs.existsSync(this.authPath)
  }

  private readAuth(): AuthFile | null {
    try {
      return JSON.parse(fs.readFileSync(this.authPath, 'utf8')) as AuthFile
    } catch {
      return null
    }
  }

  setPassword(password: string): void {
    const salt = crypto.randomBytes(16)
    const hash = crypto.scryptSync(password, salt, SCRYPT_KEYLEN, {
      N: SCRYPT_N,
      r: SCRYPT_R,
      p: SCRYPT_P
    })
    const data: AuthFile = {
      salt: salt.toString('hex'),
      hash: hash.toString('hex'),
      N: SCRYPT_N,
      r: SCRYPT_R,
      p: SCRYPT_P
    }
    fs.writeFileSync(this.authPath, JSON.stringify(data, null, 2), { mode: 0o600 })
  }

  /**
   * Verify a password with the ASYNC scrypt, through a FIFO gate of SCRYPT_SLOTS. The old
   * `scryptSync` ran on the one event loop that carries every terminal's WebSocket, so each guess
   * froze the whole server for its duration (S1). There is deliberately no synchronous variant.
   */
  async verifyPasswordAsync(password: string): Promise<boolean> {
    const auth = this.readAuth()
    if (!auth) return false
    const salt = Buffer.from(auth.salt, 'hex')
    const stored = Buffer.from(auth.hash, 'hex')
    const computed = await this.scryptGate.run(() =>
      scryptAsync(password, salt, stored.length, { N: auth.N, r: auth.r, p: auth.p })
    )
    if (computed.length !== stored.length) return false
    return crypto.timingSafeEqual(computed, stored)
  }

  /** Test seam: scrypt runs currently holding a gate slot. */
  _scryptInFlightForTest(): number {
    return this.scryptGate.active()
  }

  // ---- Setup token -------------------------------------------------------

  setupToken(): string {
    if (this.setupTokenValue === null) {
      this.setupTokenValue = crypto.randomBytes(16).toString('hex') // 32 hex chars
    }
    return this.setupTokenValue
  }

  /** Constant-time check WITHOUT consuming — GET /setup uses this to decide whether the caller
   *  (who must present the token printed to the console) may see the setup form. */
  verifySetupToken(candidate: string): boolean {
    const current = this.setupTokenValue
    if (current === null || !candidate) return false
    const a = crypto.createHash('sha256').update(candidate).digest()
    const b = crypto.createHash('sha256').update(current).digest()
    return crypto.timingSafeEqual(a, b)
  }

  consumeSetupToken(candidate: string): boolean {
    if (!this.verifySetupToken(candidate)) return false
    this.setupTokenValue = null
    return true
  }

  // ---- Sessions ----------------------------------------------------------

  private loadSessions(): SessionMap {
    if (this.sessions === null) {
      const map: SessionMap = new Map()
      try {
        const raw: unknown = JSON.parse(fs.readFileSync(this.sessionsPath, 'utf8'))
        if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
          for (const [token, entry] of Object.entries(raw as Record<string, unknown>)) {
            const createdAt = (entry as { createdAt?: unknown } | null)?.createdAt
            if (isSessionToken(token) && typeof createdAt === 'number' && Number.isFinite(createdAt)) {
              map.set(token, { createdAt })
            }
          }
        }
      } catch {
        /* missing or unreadable: no sessions */
      }
      this.sessions = map
    }
    return this.sessions
  }

  private persistSessions(): void {
    fs.writeFileSync(this.sessionsPath, JSON.stringify(Object.fromEntries(this.sessions ?? new Map()), null, 2), {
      mode: 0o600
    })
  }

  createSession(): string {
    const sessions = this.loadSessions()
    const token = crypto.randomBytes(32).toString('hex')
    sessions.set(token, { createdAt: Date.now() })
    this.persistSessions()
    return token
  }

  validateSession(token: string | undefined): boolean {
    if (!isSessionToken(token)) return false
    const sessions = this.loadSessions()
    const now = Date.now()
    let changed = false
    for (const [t, entry] of sessions) {
      if (now - entry.createdAt >= SESSION_TTL_MS) {
        sessions.delete(t)
        changed = true
      }
    }
    if (changed) this.persistSessions()
    return sessions.has(token)
  }

  /** Sign out ONE session: the token the caller presented (S3). True when it existed. */
  revokeSession(token: string): boolean {
    if (!isSessionToken(token)) return false
    const sessions = this.loadSessions()
    if (!sessions.delete(token)) return false
    this.persistSessions()
    this.announceRevoke()
    return true
  }

  /** Sign out everywhere: every session of every browser (S3). */
  revokeAll(): void {
    this.sessions = new Map()
    this.persistSessions()
    this.announceRevoke()
  }

  /** Hear every revoke — the WebSocket layer closes the sockets whose session is gone. */
  onSessionsRevoked(listener: () => void): () => void {
    this.revokeListeners.add(listener)
    return () => this.revokeListeners.delete(listener)
  }

  private announceRevoke(): void {
    for (const listener of [...this.revokeListeners]) {
      try {
        listener()
      } catch {
        /* a listener's failure must not undo the revoke */
      }
    }
  }

  // ---- Rate limiting (S1 + S4, see the block at the top of this file) -----

  /**
   * Reserve a login attempt for `client` (a key from client-address.ts) BEFORE the request body is
   * read. Refused when the client is locked or has MAX_FAILURES failures + attempts in flight, or
   * when the global window is full. A reservation must be settled exactly once: `success` resets
   * the client, `failure` charges it (and may lock it), `abandoned` (no body, a read error) only
   * releases the slot.
   */
  beginLoginAttempt(client: string, now = Date.now()): LoginGate {
    this.pruneGlobal(now)
    const state = this.clientState(client, now)
    if (now < state.lockedUntil) {
      return { ok: false, retryAfterMs: state.lockedUntil - now, scope: 'client' }
    }
    if (state.failures + state.inFlight >= MAX_FAILURES) {
      // Every slot is held by an attempt still in flight; one of them settling frees it.
      return { ok: false, retryAfterMs: 1000, scope: 'client' }
    }
    if (this.globalFailures.length + this.globalInFlight >= GLOBAL_MAX_ATTEMPTS) {
      const oldest = this.globalFailures[0]
      return {
        ok: false,
        retryAfterMs: oldest !== undefined ? Math.max(1000, oldest + GLOBAL_WINDOW_MS - now) : 1000,
        scope: 'global'
      }
    }
    state.inFlight++
    state.lastSeen = now
    this.globalInFlight++
    let settled = false
    return {
      ok: true,
      finish: (outcome: LoginOutcome): void => {
        if (settled) return
        settled = true
        const at = Date.now()
        state.inFlight--
        this.globalInFlight--
        state.lastSeen = at
        if (outcome === 'success') {
          state.failures = 0
          state.level = 0
          state.lockedUntil = 0
        } else if (outcome === 'failure') {
          state.failures++
          this.globalFailures.push(at)
          if (state.failures >= MAX_FAILURES) {
            state.lockedUntil = at + Math.min(LOCKOUT_MS * 2 ** state.level, MAX_LOCKOUT_MS)
            state.level++
            state.failures = 0
          }
        }
      }
    }
  }

  /** Test seam: how many clients are tracked. */
  _trackedClientsForTest(): number {
    return this.clients.size
  }

  private pruneGlobal(now: number): void {
    const cutoff = now - GLOBAL_WINDOW_MS
    let drop = 0
    while (drop < this.globalFailures.length && this.globalFailures[drop] <= cutoff) drop++
    if (drop > 0) this.globalFailures.splice(0, drop)
  }

  /** The client's state, forgotten first when it has been quiet long enough; moved to the end of
   *  the map (most recently seen) so the oldest are evicted first when the map is full. */
  private clientState(client: string, now: number): ClientState {
    let state = this.clients.get(client)
    if (state && state.inFlight === 0 && now - Math.max(state.lastSeen, state.lockedUntil) > CLIENT_MEMORY_MS) {
      state = undefined
    }
    this.clients.delete(client)
    if (!state) state = { failures: 0, inFlight: 0, lockedUntil: 0, level: 0, lastSeen: now }
    this.clients.set(client, state)
    while (this.clients.size > MAX_TRACKED_CLIENTS) {
      const oldest = this.clients.keys().next().value as string
      this.clients.delete(oldest)
    }
    return state
  }
}
