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
import type { LicenseDetail, LicenseSource, LicenseStatus } from '../shared/types'
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

/** DO_NOT_TRACK or the telemetry kill switch is set (read live, like every other env guard here). */
export function isDntEnv(): boolean {
  return !!(process.env.DO_NOT_TRACK || process.env.NODETERM_TELEMETRY_DISABLED)
}

// The user's consent to license calls while DO_NOT_TRACK is set (spec §7.4: a setting shown and
// revocable in Settings → Privacy, wired in by the shell). Unwired — the default, and any shell that
// never wires it — there is no consent, which is the pre-consent behavior: no license call under DNT.
let networkConsent: () => boolean = () => false

/**
 * Install the consent callback. It is read on EVERY gated call, so revoking consent takes effect at
 * once. Only callers of `licenseNetworkGate()` honor it — the license routes in this file, and the
 * project-limit claim (spec §7.4) — never telemetry or the check feed, which keep their own
 * unconditional DNT guard.
 */
export function setLicenseNetworkConsent(fn: () => boolean): void {
  networkConsent = fn
}

/** Why a license call may not run. The non-`ok` words are also `ClaimError`s (shared/project-limit). */
export type LicenseNetworkGate = 'ok' | 'consent_required' | 'disabled'

/**
 * Whether a license call may reach the API. `disabled`: a dev/unsigned build never hits the prod API
 * unless a local server is targeted explicitly (the same build rule as telemetry/check).
 * `consent_required`: DO_NOT_TRACK / the kill switch is set and the user has not consented. A consent
 * callback that throws reads as no consent — the direction that sends nothing.
 */
export function licenseNetworkGate(): LicenseNetworkGate {
  if (!platform().isPackaged && !process.env.NODETERM_API_BASE) return 'disabled'
  if (isDntEnv()) {
    let consented = false
    try {
      consented = networkConsent()
    } catch {
      // fall through: no consent
    }
    return consented ? 'ok' : 'consent_required'
  }
  return 'ok'
}

function allowed(): boolean {
  return licenseNetworkGate() === 'ok'
}

interface Stored {
  key?: string
  token?: string
  /** Largest unix-seconds timestamp this install has observed — the clock-rollback anchor. */
  lastSeen?: number
  /** The subscription term the server stated BESIDE `token` (unix seconds), for display only.
   *  It belongs to that token: written and replaced together with it (`withToken`), so a reply
   *  that states no term clears an old one instead of leaving it to describe a newer token. */
  termEndsAt?: number
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

/**
 * The clock-rollback anchor (ms): the later of the wall clock and the largest timestamp this install
 * has observed (`lastSeen`). Every expiry here is compared against it, never the bare wall clock, so
 * setting the system clock back cannot revive an expired token.
 */
export function clockAnchorMs(): number {
  return Math.max(Date.now(), (load().lastSeen ?? 0) * 1000)
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
// can't revive an expired token (see clockAnchorMs). `graceMs` accepts a token that expired
// less than that long ago; every caller but proForProjectLimit passes none.
function verify(token: string | undefined, graceMs = 0): Payload | null {
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
    if (typeof payload.exp !== 'number' || payload.exp * 1000 <= clockAnchorMs() - graceMs) return null
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

/** Every failure answers with this shape plus a reason code: zeros that are NEVER a device count.
 * The renderer must read `error` first — "we could not look" and "you have no devices" are
 * different facts, and rendering the first as the second is the bug this whole route exists for. */
const EMPTY_DETAIL: LicenseDetail = { key: null, used: 0, seats: 0, source: null, error: null }

const LICENSE_SOURCES: readonly string[] = ['keygen', 'apple', 'google', 'free']

/** The source decides whether the UI offers "release other devices" at all, so an unrecognized
 * word degrades to "none stated" (action hidden) rather than reaching the renderer as data. */
function licenseSourceOf(v: unknown): LicenseSource | null {
  return typeof v === 'string' && LICENSE_SOURCES.includes(v) ? (v as LicenseSource) : null
}

/** A count the server actually stated. A string, null or NaN is not one — see the 2xx guard in
 * `licenseCall`, where "we could not read the body" must stay distinct from "no devices". */
function isCount(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

/**
 * The subscription term a server reply stated, or null. NOT the token's `exp`: that is a 7-day offline
 * grace window re-minted every refresh, and printing it as "active until" told a yearly subscriber
 * they were a week from losing Pro (issue #800). The term is its own field (`termEndsAt`), and null
 * is a real answer — a lifetime entitlement, a license with no expiry, or a server that predates the
 * field. Anything that is not a positive, finite number is null too: a 0 would render as 1970.
 * Unsigned and display-only; nothing gates on it.
 */
function termFrom(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null
}

/** The stored state after a reply that minted `r.token`: the token and ITS term, replaced together. */
function withToken(stored: Stored, r: { token?: string; termEndsAt?: unknown }): Stored {
  return { ...stored, token: r.token, termEndsAt: termFrom(r.termEndsAt) ?? undefined }
}

function statusFrom(
  token: string | undefined,
  error: string | null = null,
  termEndsAt: number | null = null
): LicenseStatus {
  const p = verify(token)
  return p
    ? { tier: p.tier, active: true, expiresAt: p.exp, termEndsAt, seats: seatsFrom(p), error: null }
    : { tier: null, active: false, expiresAt: null, termEndsAt: null, seats: 0, error }
}

/** Status of what is on disk, the stored token's term included. */
function statusOf(stored: Stored, error: string | null = null): LicenseStatus {
  return statusFrom(stored.token, error, termFrom(stored.termEndsAt))
}

/**
 * The seat cap the current stored entitlement grants: premium → max(PRO_FREE_SEATS, its `seats`),
 * else 0. The relay host reads this to enforce how many devices may connect at once. Kept consistent
 * with `statusFrom` by sharing `seatsFrom`/`verify` — do not reimplement the resolution here.
 */
export function licensedSeats(): number {
  return seatsFrom(verify(load().token))
}

/**
 * How long a license request may take IN TOTAL — headers and body.
 *
 * The timer must outlive the `fetch` promise and be cleared only once the body has been read.
 * Clearing it when the headers arrive (`fetch(…).finally(clearTimeout)`) disarms the abort while
 * the interesting half is still outstanding, and a response whose body never completes — a captive
 * portal, a proxy that holds the connection open — then hangs the awaiting IPC handler FOREVER:
 * the Release button sits on "Releasing…" with no failure and no way back.
 */
const REQUEST_TIMEOUT_MS = 8000

/** What a minting route answers. `termEndsAt` is optional on the wire: older servers never send it. */
interface MintReply {
  token?: string
  error?: string
  termEndsAt?: unknown
}

async function call(path: string, body: unknown): Promise<MintReply> {
  if (!allowed()) return { error: 'disabled' }
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS)
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal
    })
    if (res.status === 204) return {}
    const json = (await res.json().catch(() => ({}))) as MintReply
    if (!res.ok) return { error: json.error ?? 'network' }
    return json
  } catch {
    return { error: 'offline' }
  } finally {
    clearTimeout(t)
  }
}

/** What the device-bound status poll answers. `answered` is true only for a 2xx: it is the one
 * reply that may state "this device is not entitled". A 429 from our rate limiter, a 5xx, or a
 * keygen outage relayed as an error is the server failing to answer, not answering "no". */
interface StatusReply extends MintReply {
  active?: boolean
  answered?: boolean
}

// GET helper for the device-bound status poll.
async function getJson(path: string): Promise<StatusReply> {
  if (!allowed()) return { error: 'disabled' }
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS)
  try {
    const res = await fetch(`${API_BASE}${path}`, { signal: ctrl.signal })
    const json = (await res.json().catch(() => ({}))) as StatusReply
    if (!res.ok) return { error: json.error ?? 'network' }
    return { ...json, answered: true }
  } catch {
    return { error: 'offline' }
  } finally {
    clearTimeout(t)
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

/** How long past its expiry a stored entitlement still counts as Pro — for the project limit only. */
export const PRO_LIMIT_GRACE_MS = 30 * 24 * 60 * 60 * 1000

/**
 * Pro for the purposes of the free-tier open-project limit (spec §6), and for NOTHING else — every
 * other Pro feature gates on `isPremium()`. True when `isPremium()` is, or when the stored token
 * passes the same signature + deviceId verification and expired less than `PRO_LIMIT_GRACE_MS` ago
 * by the clock anchor. A paying user offline past the 7-day token TTL must not be blocked from
 * opening a project; the cost is that cancelling and then blocking the API buys at most 30 days.
 *
 * "No 2xx `active:false` since" needs no record of its own: the device-bound refresh deletes the
 * stored token on exactly that answer, so a token still on disk means the server has not said
 * inactive since it was minted.
 */
export function proForProjectLimit(): boolean {
  return isPremium() || verify(load().token, PRO_LIMIT_GRACE_MS) !== null
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

  platform().handle(IPC.licenseStatus, () => statusOf(load()))

  // Both routes are authorized by the stored entitlement token. Sending a deviceId instead would
  // hand a key — which works on ANY machine — to whoever learned an id that rides query strings,
  // telemetry and relay pairing. The token is the only credential on the wire here, and it goes
  // in the BODY, never the URL.
  const licenseCall = async (route: string): Promise<LicenseDetail> => {
    const token = load().token
    if (!token) return { ...EMPTY_DETAIL, error: 'unauthorized' }
    if (!allowed()) return { ...EMPTY_DETAIL, error: 'disabled' }
    // The timer covers the BODY too — see REQUEST_TIMEOUT_MS. This is the route the Release
    // button awaits, so a request that never finishes leaves that button spinning for good.
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS)
    try {
      const res = await fetch(`${API_BASE}${route}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ entitlement: token }),
        signal: ctrl.signal
      })
      const json = (await res.json().catch(() => ({}))) as {
        key?: unknown
        used?: unknown
        seats?: unknown
        source?: unknown
        error?: unknown
        retryAfterDays?: unknown
      }
      if (!res.ok) {
        // The server's own reason code (401 unauthorized / 402 inactive / 429 too_soon /
        // 400 not_applicable) is kept verbatim: the UI tells those four apart. `retryAfterDays`
        // rides only 429 and is the whole content of that answer.
        const days = isCount(json.retryAfterDays) ? json.retryAfterDays : 0
        return {
          ...EMPTY_DETAIL,
          error: typeof json.error === 'string' && json.error ? json.error : 'network',
          ...(days > 0 ? { retryAfterDays: days } : {})
        }
      }
      // A 2xx we could not READ is a failed read, not a license with no devices. A captive portal
      // or corporate proxy answers this POST with a 200 HTML page, and a bad deploy can answer
      // `200 {}` or `200 {"used":"3"}` — coercing any of those to 0 while leaving `error` null
      // renders "0 of 0 devices" and an empty key AS FACT, which is the one thing this route
      // exists to prevent. Both counts must be real numbers; the legitimate non-keygen 200 states
      // exactly that (`{key:null, used:0, seats:0, source:'apple'}`) and is untouched.
      if (!isCount(json.used) || !isCount(json.seats)) {
        return { ...EMPTY_DETAIL, error: 'network' }
      }
      return {
        // `key: null` on a 200 is a real state (a keygen policy that hides keys, a license older
        // than the column, a non-keygen source) — a success, not a failed read.
        key: typeof json.key === 'string' ? json.key : null,
        // Never clamped against seats: a cap lowered after activation makes used > seats real.
        used: json.used,
        seats: json.seats,
        source: licenseSourceOf(json.source),
        error: null
      }
    } catch {
      return { ...EMPTY_DETAIL, error: 'offline' }
    } finally {
      clearTimeout(t)
    }
  }

  platform().handle(IPC.licenseDetail, () => licenseCall('/v1/license/detail'))
  platform().handle(IPC.licenseRelease, () => licenseCall('/v1/license/release'))

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
          const next = withToken(load(), r)
          await save(next)
          broadcast(statusOf(next))
          polling = false
          return
        }
        setTimeout(() => void poll(), 4000)
      }
      setTimeout(() => void poll(), 4000)
    }
    return statusOf(load())
  })

  platform().handle(IPC.licenseActivate, async (key: string) => {
    const r = await call('/v1/license/activate', { key: String(key).trim(), deviceId })
    let status: LicenseStatus
    if (r.token) {
      const next = { ...withToken(load(), r), key: String(key).trim() }
      await save(next)
      status = statusOf(next, r.error ?? null)
    } else {
      status = statusFrom(undefined, r.error ?? null)
    }
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
        const next = withToken(stored, r)
        await save(next)
        broadcast(statusOf(next))
      } else {
        broadcast(statusOf(stored, r.error ?? null)) // offline grace
      }
    } else {
      // Device-bound flow (no key): re-poll status by deviceId. Covers a purchase that completed
      // after the in-app Upgrade poll window, and every later relaunch.
      const r = await getJson(`/v1/license/status?deviceId=${encodeURIComponent(deviceId)}`)
      if (r.active && r.token) {
        const next = withToken(stored, r)
        await save(next)
        broadcast(statusOf(next))
      } else if (r.answered && r.active === false) {
        // The server ANSWERED (2xx) that this device is no longer entitled (canceled / suspended /
        // expired) → drop Pro and clear the cached token, even though it hasn't expired yet.
        if (stored.token) await save({ ...stored, token: undefined, termEndsAt: undefined })
        broadcast(statusFrom(undefined))
      } else {
        // Anything else is a status read that did not run — offline, a 429 from the rate limiter,
        // a 5xx, a keygen outage, an unusable body. Not evidence of cancellation: keep the last
        // valid token (offline grace, the same rule the key-paste branch above follows). It still
        // expires on its own clock, so a real cancellation is never held open past the token.
        // This used to be an allowlist of offline/network/disabled with every other error read as
        // "canceled", which deleted a paying customer's Pro on a single 429.
        if (stored.token) broadcast(statusOf(stored))
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
