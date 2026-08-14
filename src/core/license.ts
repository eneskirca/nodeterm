// License/premium client. Runs in the main process: stores the key + last entitlement token,
// activates/refreshes against our API, and verifies the token OFFLINE with the embedded
// Ed25519 public key. Offline grace: a still-unexpired stored token keeps premium alive when
// a refresh can't reach the server. The offline check also binds the token to this machine's
// device id and anchors expiry to the largest observed timestamp (clock-rollback guard).
import { promises as fs, readFileSync } from 'fs'
import path from 'path'
import crypto from 'node:crypto'
import { platform } from './platform'
import { IPC } from '../shared/ipc'
import type { LicenseStatus } from '../shared/types'
import { getDeviceId } from './device-id'
import { ENTITLEMENT_PUBLIC_KEY } from './entitlement-key'

const API_BASE = process.env.NODETERM_API_BASE || 'https://api.nodeterm.dev'

// Stripe Payment Link (live) for the base Pro subscription ($10/mo, includes the 3 free seats).
// The app appends ?client_reference_id=<deviceId> so the webhook binds the purchase to this device
// → keyless ("device-bound") activation. NODETERM_CHECKOUT_URL overrides it (e.g. the test link).
const CHECKOUT_URL = process.env.NODETERM_CHECKOUT_URL || 'https://buy.stripe.com/eVq00lbeY0qNbwz90w7EQ02'

// Add-seats checkout: the live quantity-based Payment Link for buying seats BEYOND the free 3 (the
// buyer picks the total; extra seats are $5/seat/mo). NODETERM_SEATS_CHECKOUT_URL overrides it.
const SEATS_CHECKOUT_URL = process.env.NODETERM_SEATS_CHECKOUT_URL || 'https://buy.stripe.com/28E9AV6YI8Xj303a4A7EQ03'

// Tokens are short-lived (the server mints 7-day entitlements) and the app is designed to
// stay open for days, so a launch-only refresh would let the token expire mid-session and
// silently drop Pro. Re-refresh on the same 6h cadence as the check/update polls.
const REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000

// Same gate as telemetry/check: never hit the prod API from a dev/unsigned build unless a
// local server is targeted explicitly, and honor DO_NOT_TRACK / the kill switch.
function allowed(): boolean {
  if (process.env.DO_NOT_TRACK || process.env.NODETERM_TELEMETRY_DISABLED) return false
  if (!platform().isPackaged && !process.env.NODETERM_API_BASE) return false
  return true
}

interface Stored {
  key?: string
  token?: string
  /** Largest unix-seconds timestamp this install has observed — the clock-rollback anchor. */
  lastSeen?: number
}

function file(): string {
  return path.join(platform().userDataDir, 'license.json')
}
function load(): Stored {
  try {
    return JSON.parse(readFileSync(file(), 'utf-8')) as Stored
  } catch {
    return {}
  }
}
async function save(s: Stored): Promise<void> {
  await fs.writeFile(file(), JSON.stringify(s), 'utf-8').catch(() => {})
}

interface Payload {
  deviceId: string
  tier: string
  licenseId: string
  exp: number
  /** Seat cap for the relay host (Team Access). Rides the same signed token; an old token
   * lacks it, in which case it resolves to the free baseline (PRO_FREE_SEATS). See `seatsFrom`. */
  seats?: number
}

/** Every Pro plan includes this many collaborator seats for free — the token carries a `seats`
 * value only when a plan buys MORE than this (extra seats are $5/seat/month). The server omits
 * `seats` at/below this baseline, so existing Pro tokens (no `seats` field) grant it automatically
 * with no re-mint. Kept in sync with the server's PRO_FREE_SEATS (nodeterm-server entitlement). */
export const PRO_FREE_SEATS = 3

// Offline verification of our compact Ed25519 token: base64url(payload).base64url(sig).
// Beyond the signature, the token must be minted for THIS machine (a copied license.json
// from another install must not validate), and its expiry is checked against the largest
// timestamp we've ever observed — not just Date.now() — so rolling the system clock back
// can't revive an expired token (see lastSeen).
function verify(token: string | undefined): Payload | null {
  if (!token || !ENTITLEMENT_PUBLIC_KEY) return null
  const dot = token.indexOf('.')
  if (dot < 1) return null
  const p = token.slice(0, dot)
  const s = token.slice(dot + 1)
  try {
    const key = crypto.createPublicKey(ENTITLEMENT_PUBLIC_KEY)
    if (!crypto.verify(null, Buffer.from(p), key, Buffer.from(s, 'base64url'))) return null
    const payload = JSON.parse(Buffer.from(p, 'base64url').toString('utf-8')) as Payload
    if (payload.deviceId !== getDeviceId()) return null
    const now = Math.max(Date.now(), (load().lastSeen ?? 0) * 1000)
    if (typeof payload.exp !== 'number' || payload.exp * 1000 <= now) return null
    return payload
  } catch {
    return null
  }
}

// Resolve the seat cap from a (possibly null) verified payload — the single source of truth so
// statusFrom() and licensedSeats() can't drift. Every Pro plan grants at least the free baseline:
// a premium token resolves to max(PRO_FREE_SEATS, its seats) — so a token with no seats field (or a
// smaller/misconfigured value) still yields the 3 free seats, and a bought-up plan yields its higher
// count. Inactive/free/invalid → 0.
function seatsFrom(p: Payload | null): number {
  return p ? Math.max(PRO_FREE_SEATS, p.seats ?? PRO_FREE_SEATS) : 0
}

function statusFrom(token: string | undefined, error: string | null = null): LicenseStatus {
  const p = verify(token)
  return p
    ? { tier: p.tier, active: true, expiresAt: p.exp, seats: seatsFrom(p), error: null }
    : { tier: null, active: false, expiresAt: null, seats: 0, error }
}

/**
 * The seat cap the current stored entitlement grants: premium → max(PRO_FREE_SEATS, its `seats`),
 * else 0. The relay host reads this to enforce how many devices may connect at once. Kept consistent
 * with `statusFrom` by sharing `seatsFrom`/`verify` — do not reimplement the resolution here.
 */
export function licensedSeats(): number {
  return seatsFrom(verify(load().token))
}

async function call(path: string, body: unknown): Promise<{ token?: string; error?: string }> {
  if (!allowed()) return { error: 'disabled' }
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 8000)
    const res = await fetch(`${API_BASE}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal
    }).finally(() => clearTimeout(t))
    if (res.status === 204) return {}
    const json = (await res.json().catch(() => ({}))) as { token?: string; error?: string }
    if (!res.ok) return { error: json.error ?? 'network' }
    return json
  } catch {
    return { error: 'offline' }
  }
}

// GET helper for the device-bound status poll.
async function getJson(path: string): Promise<{ active?: boolean; token?: string; error?: string }> {
  if (!allowed()) return { error: 'disabled' }
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 8000)
    const res = await fetch(`${API_BASE}${path}`, { signal: ctrl.signal }).finally(() => clearTimeout(t))
    const json = (await res.json().catch(() => ({}))) as { active?: boolean; token?: string; error?: string }
    if (!res.ok) return { error: json.error ?? 'network' }
    return json
  } catch {
    return { error: 'offline' }
  }
}

/**
 * The stored entitlement token (the compact Ed25519 token minted by our API), or null when
 * none is stored. Other main-process features (e.g. the relay pairing call) read this to prove
 * entitlement to the server. Returns the raw stored value — verify with `isPremium()` for gating.
 */
export function getStoredEntitlement(): string | null {
  return load().token ?? null
}

/** True when a valid, unexpired Pro entitlement is stored (offline-verified). Gates premium features. */
export function isPremium(): boolean {
  return verify(load().token) !== null
}

// Every refresh started so far (the launch one + whatever the 6h interval fired), chained. The
// refresh is deliberately fire-and-forget — nothing at boot may block on the network — which has
// two consequences this handle exists to own:
//   1. a TEST can only observe it by racing a timed flush, and a loaded CI runner wins that race:
//      the assertion sees zero broadcasts, and the continuation then lands after the test has torn
//      the platform down, so platform() throws with nobody awaiting. One cause, two red symptoms.
//      __licenseRefreshesForTests() lets the test await the real thing instead.
//   2. a throw anywhere in the chain would be an UNHANDLED REJECTION in a process that stays up for
//      days, so the runner below logs instead of dropping it.
// It is a QUEUE, not merely "the latest run": see runRefresh below for why overlapping runs are
// wrong on their own terms, and note that awaiting only the newest would still leave an older run
// in flight — free to land after the test has torn its platform down.
let refreshes: Promise<void> = Promise.resolve()

/**
 * TEST ONLY (house pattern: webgl-budget's `__resetWebglBudgetForTests`) — resolves once every
 * refresh initLicense() has started so far has settled. Tests await this instead of guessing a
 * timeout; see the note on `refreshes`.
 */
export function __licenseRefreshesForTests(): Promise<void> {
  return refreshes
}

export function initLicense(onChange?: () => void): void {
  const deviceId = getDeviceId()
  const broadcast = (s: LicenseStatus) => {
    platform().broadcast(IPC.licenseChanged, s)
    // Let the main process react to a Pro state change (activate / refresh / device-poll). The
    // launch-time refresh is ASYNC, so anything gated on isPremium() at boot (the standing phone
    // host) must re-reconcile once the entitlement settles — without this it would stay down
    // until the toggle is flipped or the app restarts with an already-valid token.
    onChange?.()
  }

  platform().handle(IPC.licenseStatus, () => statusFrom(load().token))

  // Device-bound upgrade: open Stripe checkout (carrying our deviceId), then poll the status
  // endpoint until the webhook has bound + minted the entitlement. Status arrives via broadcast.
  let polling = false
  platform().handle(IPC.licenseUpgrade, async (target?: 'pro' | 'seats') => {
    // 'seats' opens the add-seats (quantity) link; anything else opens base Pro. Both carry the
    // deviceId so the same device-bound webhook binds either purchase to this machine.
    const base = target === 'seats' ? SEATS_CHECKOUT_URL : CHECKOUT_URL
    const url = `${base}${base.includes('?') ? '&' : '?'}client_reference_id=${encodeURIComponent(deviceId)}`
    await platform().openExternal(url)
    if (!polling) {
      polling = true
      const deadline = Date.now() + 6 * 60 * 1000 // poll up to 6 min after opening checkout
      const poll = async (): Promise<void> => {
        if (Date.now() > deadline) {
          polling = false
          return
        }
        const r = await getJson(`/v1/license/status?deviceId=${encodeURIComponent(deviceId)}`)
        if (r.active && r.token) {
          await save({ ...load(), token: r.token })
          broadcast(statusFrom(r.token))
          polling = false
          return
        }
        setTimeout(() => void poll(), 4000)
      }
      setTimeout(() => void poll(), 4000)
    }
    return statusFrom(load().token)
  })

  platform().handle(IPC.licenseActivate, async (key: string) => {
    const r = await call('/v1/license/activate', { key: String(key).trim(), deviceId })
    if (r.token) await save({ ...load(), key: String(key).trim(), token: r.token })
    const status = statusFrom(r.token, r.error ?? null)
    broadcast(status)
    return status
  })

  platform().handle(IPC.licenseDeactivate, async () => {
    const stored = load()
    if (stored.key) await call('/v1/license/deactivate', { key: stored.key, deviceId })
    await save({ lastSeen: stored.lastSeen }) // keep the clock anchor across deactivations
    const status = statusFrom(undefined)
    broadcast(status)
    return status
  })

  // Advance the clock-rollback anchor (see verify()): record the largest timestamp we've
  // observed, so setting the system clock back can't revive an expired token.
  const bumpLastSeen = async (): Promise<void> => {
    const stored = load()
    const now = Math.floor(Date.now() / 1000)
    if (now > (stored.lastSeen ?? 0)) await save({ ...stored, lastSeen: now })
  }

  // Re-establish entitlement, keeping the last valid token on failure (offline grace).
  const refresh = async (): Promise<void> => {
    const stored = load()
    if (stored.key) {
      // Key-paste flow: refresh against the stored key.
      const r = await call('/v1/license/refresh', { key: stored.key, deviceId })
      if (r.token) {
        await save({ ...stored, token: r.token })
        broadcast(statusFrom(r.token))
      } else {
        broadcast(statusFrom(stored.token, r.error ?? null)) // offline grace
      }
    } else {
      // Device-bound flow (no key): re-poll status by deviceId. Covers a purchase that completed
      // after the in-app Upgrade poll window, and every later relaunch.
      const r = await getJson(`/v1/license/status?deviceId=${encodeURIComponent(deviceId)}`)
      if (r.active && r.token) {
        await save({ ...stored, token: r.token })
        broadcast(statusFrom(r.token))
      } else if (r.error === 'offline' || r.error === 'network' || r.error === 'disabled') {
        // Couldn't reach the server → offline grace: keep the last valid token.
        if (stored.token) broadcast(statusFrom(stored.token))
      } else {
        // Server responded: this device is no longer entitled (canceled / suspended / expired)
        // → drop Pro and clear the cached token, even though it hasn't expired yet.
        if (stored.token) await save({ ...stored, token: undefined })
        broadcast(statusFrom(undefined))
      }
    }
  }

  // One refresh run: still fire-and-forget for the caller, but QUEUED behind the previous run,
  // parked on `refreshes` so tests can await it, and with its errors logged rather than left to
  // the unhandled-rejection handler.
  //
  // Queued, not merely tracked: bumpLastSeen is a read-modify-write of license.json (load() then
  // save()), so two overlapping runs can interleave and let the OLDER `lastSeen` land last —
  // which walks the clock-rollback anchor BACKWARDS, the one thing it exists to prevent. In the
  // real app the runs are 6h apart and never overlap (an 8s fetch abort bounds each one), so this
  // is a resolved promise plus a microtask; the overlap is reachable only where the clock is
  // compressed — a test advancing days of fake time — and it made the rollback test flaky.
  const runRefresh = (): void => {
    refreshes = refreshes
      .then(() => bumpLastSeen().then(refresh))
      .catch((err) =>
        console.warn('[license] refresh failed', err instanceof Error ? err.message : String(err))
      )
  }

  // On launch + every 6h while the app stays open (see REFRESH_INTERVAL_MS).
  runRefresh()
  setInterval(runRefresh, REFRESH_INTERVAL_MS).unref()
}
