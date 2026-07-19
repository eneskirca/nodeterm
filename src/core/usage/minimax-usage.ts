// MiniMax coding-plan usage.
//
// Unlike every other provider here, MiniMax exposes no CLI credential on disk — the quota lives
// behind the web console's session. So the user pastes their browser Cookie header into
// Settings and we replay it. That cookie is a live bearer credential, which is why it is stored
// in its own 0600 file rather than in settings.json (see minimax-cookie.ts).
import type { ProviderUsage, UsageLimit } from '../../shared/types'
import { parseResetTimestamp } from './claude-usage-map'

const USAGE_URL = 'https://platform.minimax.io/v1/api/openplatform/coding_plan/remains'
const ORIGIN = 'https://platform.minimax.io'
const REFERER = 'https://platform.minimax.io/console/usage'
const FETCH_TIMEOUT_MS = 15_000

/**
 * The API reports `end_time - start_time`, and that span drifts below the contracted bucket
 * (4h, 295 min, …). The plan sells a 5-hour session, so the label is pinned rather than derived
 * — the same choice Codex's fallback durations make.
 */
const SESSION_WINDOW_MINUTES = 300

/**
 * MiniMax's endpoint rejects clients that don't look like a browser, so a real per-platform
 * Firefox UA is sent instead of an app-specific agent string. Do not "clean this up" into a
 * nodeterm UA — the request will start failing.
 */
function browserUserAgent(): string {
  if (process.platform === 'win32') {
    return 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:152.0) Gecko/20100101 Firefox/152.0'
  }
  if (process.platform === 'darwin') {
    return 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:152.0) Gecko/20100101 Firefox/152.0'
  }
  return 'Mozilla/5.0 (X11; Linux x86_64; rv:152.0) Gecko/20100101 Firefox/152.0'
}

/** Pull one cookie's value out of a pasted `Cookie:` header. */
export function cookieValue(cookie: string, name: string): string | null {
  for (const part of cookie.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    if (part.slice(0, eq).trim() === name) {
      const v = part.slice(eq + 1).trim()
      return v || null
    }
  }
  return null
}

/**
 * `_token` is what actually authenticates the request, so a paste that lacks it is not a usable
 * cookie no matter how long it is — catching that here turns a mystifying 401 into an obvious
 * "you copied the wrong header".
 */
export function isUsableMinimaxCookie(cookie: string | null | undefined): boolean {
  return !!cookie && cookieValue(cookie, '_token') !== null
}

function asNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'string') {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  return null
}

/**
 * One per-model entry. MiniMax reports what is REMAINING, like Gemini, so this inverts. The
 * model name rides in `scopeLabel`, the same treatment Claude's scoped caps and Gemini's buckets
 * get — the UI needs to know nothing about MiniMax to label it.
 */
export function mapMinimaxItem(item: unknown): UsageLimit | null {
  if (!item || typeof item !== 'object') return null
  const it = item as Record<string, unknown>
  const modelName = typeof it.model_name === 'string' ? it.model_name : null
  const remaining = asNumber(it.current_interval_remaining_percent)
  if (!modelName || remaining === null) return null

  return {
    kind: 'session_scoped',
    group: 'session',
    usedPercent: Math.min(100, Math.max(0, 100 - remaining)),
    severity: null,
    resetsAt: parseResetTimestamp(it.end_time),
    windowMinutes: SESSION_WINDOW_MINUTES,
    scopeLabel: modelName,
    isActive: false
  }
}

/**
 * Every model's window, not just one. Orca selects a single preferred model because its shape
 * has one session slot to fill; ours carries a list, so a plan covering several models shows
 * each of them.
 */
export function mapMinimaxLimits(body: unknown): UsageLimit[] {
  if (!body || typeof body !== 'object') return []
  const items = (body as Record<string, any>).model_remains
  if (!Array.isArray(items)) return []
  return items.map(mapMinimaxItem).filter((l): l is UsageLimit => l !== null)
}

/** A non-zero `base_resp.status_code` is MiniMax reporting failure inside an HTTP 200. */
export function minimaxRejected(body: unknown): boolean {
  const code = (body as any)?.base_resp?.status_code
  return typeof code === 'number' && code !== 0
}

function snapshot(limits: UsageLimit[], status: ProviderUsage['status']): ProviderUsage {
  return { provider: 'minimax', limits, account: null, updatedAt: Date.now(), status }
}

/**
 * MiniMax usage. Never rejects.
 *
 * A stale cookie is reported as 'unavailable' rather than 'error': the user's session simply
 * expired and they need to paste a fresh one, which is the same "not signed in" story every
 * other provider tells — not a fault worth an alarm icon.
 */
export async function fetchMinimaxUsage(cookie: string | null): Promise<ProviderUsage> {
  if (!isUsableMinimaxCookie(cookie)) return snapshot([], 'unavailable')
  try {
    const headers: Record<string, string> = {
      cookie: cookie!,
      accept: 'application/json',
      origin: ORIGIN,
      referer: REFERER,
      'user-agent': browserUserAgent()
    }
    // The console scopes the query to the active group; without this the endpoint answers for
    // the wrong one (or refuses) on accounts that belong to more than one.
    const groupId = cookieValue(cookie!, 'minimax_group_id_v2')
    if (groupId) headers['x-group-id'] = groupId

    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
    const res = await fetch(USAGE_URL, { headers, signal: ctrl.signal }).finally(() =>
      clearTimeout(t)
    )
    if (res.status === 401 || res.status === 403) return snapshot([], 'unavailable')
    if (!res.ok) return snapshot([], 'error')

    const body = await res.json()
    // An expired session is answered inside a 200 with a non-zero status_code, so this is the
    // usual way a stale cookie shows up — not the 401 above.
    if (minimaxRejected(body)) return snapshot([], 'unavailable')

    const limits = mapMinimaxLimits(body)
    return snapshot(limits, limits.length > 0 ? 'ok' : 'unavailable')
  } catch {
    return snapshot([], 'error')
  }
}
