// Polls the backend /v1/check feed from the main process (so the renderer CSP stays 'self').
// Successor to the static announcements.json: returns targeted messages for the announcement
// banner, one-time popups (`popups`), AND the mandatory-update policy for the Update Card. It also carries the anonymous
// install id (deviceId + os/arch/version), which the backend upserts into `devices` as a
// passive active-install counter — so the version distribution reflects EVERY install, not only
// the (few) that also opt into the telemetry ping. It also states the plan (`pro` | `free`) so a
// message can be aimed at paid or free users; the backend matches on it and does not store it.
// While the Settings → Privacy telemetry toggle is on it also carries the open-project count
// (`openProjects`, a bare number — never names, paths or hosts); the backend keeps the per-install
// maximum, the data the project-limit allowance is computed from. See `configureCheck`.
// In the other direction, the reply says whether the open-project limit is on (`limits`, present
// only while it is); that answer reaches core through `onCheckAnswer`, not through CheckResult.
// Nothing personal is sent and the client IP is never stored server-side; a hard opt-out is still
// DO_NOT_TRACK / NODETERM_TELEMETRY_DISABLED.
import { createHash } from 'node:crypto'
import { platform } from './platform'
import { getDeviceId } from './device-id'
import { isPremium } from './license'
import type { Announcement, PopupAnnouncement, UpdatePolicy } from '../shared/types'

const API_BASE = process.env.NODETERM_API_BASE || 'https://api.nodeterm.dev'
const CACHE_MS = 5 * 60 * 1000

export interface CheckResult {
  messages: Announcement[]
  /** One-time popups. The server sends them under their own key so that a build reading only
   *  `messages` (every one before this, and mobile) never receives one as a recurring banner. */
  popups: PopupAnnouncement[]
  update: UpdatePolicy
}

const EMPTY: CheckResult = { messages: [], popups: [], update: { minSupported: null, mandatory: false } }

// Same build + DO_NOT_TRACK gate as telemetry: dev never hits the prod API unless a local
// server is targeted explicitly. Deliberately NOT gated on the in-app telemetry toggle: this
// call always runs (content delivery + the anonymous install count), so an install still counts
// even if the user never opts into the detailed telemetry ping. The env kill-switches above are
// the hard off. The one field that IS gated on the toggle is `openProjects` (`openProjectsQuery`).
function allowed(): boolean {
  if (process.env.DO_NOT_TRACK || process.env.NODETERM_TELEMETRY_DISABLED) return false
  if (!platform().isPackaged && !process.env.NODETERM_API_BASE) return false
  return true
}

function sanitize(data: unknown): CheckResult {
  if (!data || typeof data !== 'object') return EMPTY
  const d = data as Record<string, unknown>
  const items = (raw: unknown): Record<string, unknown>[] =>
    (Array.isArray(raw) ? raw : [])
      .filter((m): m is Record<string, unknown> => !!m && typeof m === 'object')
      .filter((m) => typeof m.id === 'string' && typeof m.title === 'string')
  const toMessage = (m: Record<string, unknown>): Announcement => ({
    id: m.id as string,
    title: m.title as string,
    body: typeof m.body === 'string' ? m.body : undefined,
    url: typeof m.url === 'string' && /^https?:\/\//.test(m.url) ? m.url : undefined,
    level: m.level === 'success' || m.level === 'warning' ? m.level : 'info'
  })
  const messages = items(d.messages).map(toMessage)
  const popups = items(d.popups).map((m): PopupAnnouncement => {
    const p: PopupAnnouncement = toMessage(m)
    const label = typeof m.ctaLabel === 'string' ? m.ctaLabel.trim() : ''
    if (label) p.ctaLabel = label.slice(0, CTA_LABEL_MAX)
    // A closed set: an action this build does not know is no action, never a guess at one.
    if (m.action === 'upgrade') p.action = 'upgrade'
    if (typeof m.image === 'string' && IMAGE_HASH.test(m.image)) p.image = m.image
    return p
  })
  const u = (d.update ?? {}) as Record<string, unknown>
  const update: UpdatePolicy = {
    minSupported: typeof u.minSupported === 'string' ? u.minSupported : null,
    mandatory: u.mandatory === true
  }
  // Optional release highlights for the update card. Both or neither: notes without the version
  // they describe could be pinned to the wrong card.
  if (typeof u.notes === 'string' && u.notes.trim() && typeof u.latestVersion === 'string' && u.latestVersion) {
    update.notes = u.notes.slice(0, NOTES_MAX)
    update.latestVersion = u.latestVersion.slice(0, 64)
  }
  return { messages, popups, update }
}

const NOTES_MAX = 16 * 1024
const CTA_LABEL_MAX = 40
const IMAGE_HASH = /^[0-9a-f]{64}$/
/** The largest popup picture this build takes; the admin console refuses more on upload. */
const IMAGE_MAX_BYTES = 2 * 1024 * 1024
const IMAGE_TIMEOUT_MS = 20_000

/** Test seam: the sanitizer is the whole contract with the feed's shape. */
export const sanitizeCheckForTest = sanitize

/** What one successful read of the feed said about the open-project limit. The server adds
 *  `limits: { projects: { free, epoch } }` exactly while the limit is on and leaves the key absent
 *  otherwise, so `off` is the ABSENCE of the key — but only in a reply shaped like a check reply
 *  (`messages` array + `update` object, which every 2xx from the route carries). `unknown` = anything
 *  else: a malformed `limits`, or JSON that is not a check reply at all (`{}`, `{"status":"ok"}`, a
 *  proxy's JSON page behind a followed redirect). It must change nothing: the latch reads `off` as
 *  "clear", and a reply that did not come from the route must never be able to clear it. */
export type LimitsAnswer = { kind: 'on'; free: number; epoch: number } | { kind: 'off' } | { kind: 'unknown' }

const FREE_MIN = 1
const FREE_MAX = 1000

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

// Kept apart from `sanitize`, whose CheckResult its existing callers (banner, update card) depend on
// exactly — and stricter than it: `sanitize` reads any JSON as an empty feed, which is harmless for a
// banner, while here only a check-shaped reply says anything (see LimitsAnswer). A fresh object every
// call, so no answer aliases a module constant a listener could mutate.
function sanitizeLimits(data: unknown): LimitsAnswer {
  if (!isRecord(data) || !Array.isArray(data.messages) || !isRecord(data.update)) return { kind: 'unknown' }
  if (!Object.hasOwn(data, 'limits')) return { kind: 'off' }
  const projects = isRecord(data.limits) ? data.limits.projects : undefined
  if (!isRecord(projects)) return { kind: 'unknown' }
  const { free, epoch } = projects
  if (typeof free !== 'number' || !Number.isInteger(free) || free < FREE_MIN || free > FREE_MAX) {
    return { kind: 'unknown' }
  }
  // Safe integers only: the epoch is compared for equality against a stored token's.
  if (typeof epoch !== 'number' || !Number.isSafeInteger(epoch) || epoch < 1) return { kind: 'unknown' }
  return { kind: 'on', free, epoch }
}

/** Test seam: the limits half of the feed's shape. */
export const sanitizeLimitsForTest = sanitizeLimits

type AnswerListener = (a: LimitsAnswer) => void
const answerListeners = new Set<AnswerListener>()

/** Subscribe to the server's limit answer. Fired only after a 2xx response whose body parsed as
 *  JSON, once per network read — never for a cache hit, a failed read or its fallback, because the
 *  project-limit latch reads `off` as "clear" and a blocked network must not be able to say it.
 *  Returns the unsubscribe. */
export function onCheckAnswer(listener: AnswerListener): () => void {
  answerListeners.add(listener)
  return () => {
    answerListeners.delete(listener)
  }
}

function emitAnswer(answer: LimitsAnswer): void {
  // A copy, so a listener that unsubscribes (or subscribes) mid-emit does not skew this round.
  for (const listener of [...answerListeners]) {
    try {
      listener(answer)
    } catch (err) {
      // A listener's bug is its own: fetchCheck's callers still get the answer they asked for.
      console.warn('[check] answer listener failed', err)
    }
  }
}

export interface CheckDeps {
  /** Open projects in the workspace index (`WorkspaceStore.openProjectCount`); undefined = unknown
   *  (index not loaded yet, or never saved in v3 form), and an unknown count is never sent. */
  openProjects: () => number | undefined
  /** `settings.telemetryEnabled` — the count is sent only while it is exactly true. */
  telemetryEnabled: () => boolean
}

// Set once by the shell at boot; read per call, so a toggle flip or a project open/close takes
// effect on the next uncached fetch. Never configured = the count is never sent.
let deps: CheckDeps | null = null

export function configureCheck(next: CheckDeps): void {
  deps = next
}

/** The open-project count for one read: `param` is `openProjects=<n>` only when configured, the
 *  telemetry toggle is on and `n` is a non-negative integer (nothing else is added); `owed` = the
 *  count was wanted (toggle on) but is not known yet — the index still loading at boot. Never
 *  throws: a toggle that cannot be read is off, a count that cannot be read is unknown. */
function openProjectsQuery(): { param: Record<string, string>; owed: boolean } {
  let wanted = false
  try {
    wanted = !!deps && deps.telemetryEnabled() === true
  } catch {
    wanted = false
  }
  if (!deps || !wanted) return { param: {}, owed: false }
  let n: number | undefined
  try {
    n = deps.openProjects()
  } catch {
    n = undefined
  }
  return typeof n === 'number' && Number.isInteger(n) && n >= 0
    ? { param: { openProjects: String(n) }, owed: false }
    : { param: {}, owed: true }
}

type Plan = 'pro' | 'free'

// The plan the response was fetched for. The backend aims messages at paid or free users by the
// plan WE state (the feed is anonymous — it cannot look a device up), so an answer belongs to the
// plan it was asked with: a purchase or a lapse must not be served the other plan's messages.
// `countOwed`: the read went out while the count was wanted but unknown (see openProjectsQuery).
let cache: { at: number; plan: Plan; data: CheckResult; countOwed: boolean } | null = null

export async function fetchCheck(): Promise<CheckResult> {
  if (!allowed()) return EMPTY
  const now = Date.now()
  // Offline token verify, so it is cheap to read per call and already right at boot.
  const plan: Plan = isPremium() ? 'pro' : 'free'
  const count = openProjectsQuery()
  // A reply fetched while the count was owed does not stand in for a read that can carry it: at boot
  // the first reads (this module's own, the banner's, the update card's) can all run before the
  // workspace index is loaded, and served from the cache that count-less reply would keep the count
  // off the wire until the 6 h tick — for a session shorter than that, for good. So once the count
  // is known this read refetches, and its reply replaces the cache. A reply that carried the count,
  // or was fetched with the toggle off, is reused exactly as before.
  const countNowKnown = cache?.countOwed === true && Object.hasOwn(count.param, 'openProjects')
  if (cache && cache.plan === plan && now - cache.at < CACHE_MS && !countNowKnown) return cache.data
  // A failed read keeps the last good answer, except the messages and popups it fetched for another
  // plan. The update policy does not depend on the plan, so it survives.
  const fallback = (): CheckResult =>
    !cache ? EMPTY : cache.plan === plan ? cache.data : { messages: [], popups: [], update: cache.data.update }
  try {
    const q = new URLSearchParams({
      deviceId: getDeviceId(),
      version: platform().appVersion,
      os: process.platform,
      arch: process.arch,
      channel: 'stable',
      plan,
      ...count.param
    })
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 8000)
    const res = await fetch(`${API_BASE}/v1/check?${q.toString()}`, {
      signal: ctrl.signal,
      cache: 'no-cache'
    }).finally(() => clearTimeout(t))
    if (!res.ok) return fallback()
    // A body that does not parse (a captive portal's HTML page) throws into the fallback below.
    const body: unknown = await res.json()
    const data = sanitize(body)
    cache = { at: now, plan, data, countOwed: count.owed }
    // The one place an answer is given: a 2xx whose body parsed as JSON. Cached first, so a
    // listener that reads the feed again is served from the cache rather than re-fetching.
    emitAnswer(sanitizeLimits(body))
    return data
  } catch {
    return fallback()
  }
}

/** The type the bytes say. A closed set, so nothing else can reach a `data:` URL. */
function imageMime(b: Uint8Array): string | null {
  const starts = (at: number, sig: number[]): boolean => sig.every((x, i) => b[at + i] === x)
  if (starts(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png'
  if (starts(0, [0xff, 0xd8, 0xff])) return 'image/jpeg'
  if (starts(0, [0x52, 0x49, 0x46, 0x46]) && starts(8, [0x57, 0x45, 0x42, 0x50])) return 'image/webp'
  return null
}

/** The body up to `max` bytes, or null past it. Read in chunks: `content-length` is only a claim. */
async function readCapped(body: ReadableStream<Uint8Array>, max: number): Promise<Buffer | null> {
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return Buffer.concat(chunks)
    size += value.length
    if (size > max) {
      await reader.cancel()
      return null
    }
    chunks.push(value)
  }
}

let lastImage: { sha256: string; url: string } | null = null

/**
 * A popup's picture as a `data:` URL (the renderer CSP's `img-src` takes no network source), or null
 * when it cannot be had. The feed only ever names a hash, never a URL, so it cannot point this at
 * another host; the bytes must match that hash and be an image. No install id goes with it.
 * The latest is kept: a popup waiting its turn asks again every few minutes.
 */
export async function fetchPopupImage(sha256: string): Promise<string | null> {
  if (!IMAGE_HASH.test(sha256) || !allowed()) return null
  if (lastImage?.sha256 === sha256) return lastImage.url
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), IMAGE_TIMEOUT_MS)
  try {
    const res = await fetch(`${API_BASE}/v1/message-image/${sha256}`, { signal: ctrl.signal, redirect: 'error' })
    if (!res.ok || !res.body) return null
    const bytes = await readCapped(res.body, IMAGE_MAX_BYTES)
    if (!bytes || createHash('sha256').update(bytes).digest('hex') !== sha256) return null
    const mime = imageMime(bytes)
    if (!mime) return null
    lastImage = { sha256, url: `data:${mime};base64,${bytes.toString('base64')}` }
    return lastImage.url
  } catch {
    return null
  } finally {
    clearTimeout(t)
  }
}
