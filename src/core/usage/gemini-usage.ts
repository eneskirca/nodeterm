// Gemini CLI subscription usage, via Google's internal Cloud Code quota API — the same endpoint
// the Gemini CLI itself reads.
//
// Two deliberate limits, both narrower than orca's equivalent:
//
//   * We read ONLY `~/.gemini/oauth_creds.json`. Orca additionally scans opencode's data
//     directories (`~/.local/share/opencode/auth.json`, the macOS Application Support copy, …)
//     for a Google token — and gates that behind an explicit opt-in precisely because it means
//     reading another application's credentials off disk. The simplest correct answer is not to.
//
//   * We never refresh the token. Same policy as the Claude and Codex providers: display-only,
//     no credential writes. Orca refreshes using an OAuth client id/secret extracted from the
//     installed Gemini CLI's JS bundle, which is both fragile (a CLI update breaks it) and a
//     step up in credential handling we have no need to take.
//
//     The tradeoff is real and worth knowing: Google access tokens are short-lived (~1h), so an
//     expired token reports 'unavailable' until the user next runs `gemini`, which refreshes it.
//     Usage is therefore reliable while you are actually using Gemini and goes quiet afterwards.
import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import type { ProviderUsage, UsageLimit } from '../../shared/types'

const LOAD_CODE_ASSIST_URL = 'https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist'
const RETRIEVE_QUOTA_URL = 'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota'
const FETCH_TIMEOUT_MS = 8000
/** Google's quota buckets are hourly. The API does not state the duration, so this is fixed. */
const BUCKET_WINDOW_MINUTES = 60

/** Friendly names for the model ids Google returns. Anything unlisted is humanized instead. */
const MODEL_LABELS: Record<string, string> = {
  'gemini-3.1-pro': '3.1 Pro',
  'gemini-3.1-flash': '3.1 Flash',
  'gemini-3.1-flash-lite': '3.1 Flash Lite',
  'gemini-3.0-pro': '3.0 Pro',
  'gemini-3.0-flash': '3.0 Flash',
  'gemini-2.5-pro': 'Pro',
  'gemini-2.5-flash': 'Flash',
  'gemini-2.5-flash-lite': 'Flash Lite',
  'gemini-2.0-pro': '2.0 Pro',
  'gemini-2.0-flash': '2.0 Flash',
  'gemini-2.0-flash-lite': '2.0 Flash Lite',
  'gemini-1.5-pro': '1.5 Pro',
  'gemini-1.5-flash': '1.5 Flash'
}

export function modelLabel(modelId: string): string {
  const known = MODEL_LABELS[modelId]
  if (known) return known
  return modelId
    .replace(/^gemini-/i, '')
    .split('-')
    .map((part) => (part ? part[0]!.toUpperCase() + part.slice(1) : part))
    .join(' ')
}

interface GeminiCreds {
  accessToken: string | null
  expired: boolean
}

/** Read the Gemini CLI's OAuth credentials. Never written back. */
export async function readGeminiCreds(home = path.join(os.homedir(), '.gemini')): Promise<GeminiCreds> {
  try {
    const raw = await fs.readFile(path.join(home, 'oauth_creds.json'), 'utf-8')
    const j = JSON.parse(raw) as Record<string, any>
    const accessToken = typeof j.access_token === 'string' ? j.access_token : null
    // `expiry_date` is Unix ms. Treat a missing one as "not expired" and let the API decide —
    // refusing to try on incomplete local metadata would be a self-inflicted outage.
    const expired = typeof j.expiry_date === 'number' ? j.expiry_date <= Date.now() : false
    return { accessToken, expired }
  } catch {
    return { accessToken: null, expired: false }
  }
}

interface QuotaBucket {
  remainingFraction: number
  resetTime: string
  modelId: string
}

function isQuotaBucket(o: unknown): o is QuotaBucket {
  if (!o || typeof o !== 'object') return false
  const b = o as Record<string, any>
  return (
    typeof b.remainingFraction === 'number' &&
    Number.isFinite(b.remainingFraction) &&
    typeof b.resetTime === 'string' &&
    typeof b.modelId === 'string'
  )
}

/** The response has been seen both as a bare array and wrapped in `{ buckets }`. Accept both. */
export function parseQuotaBuckets(data: unknown): QuotaBucket[] {
  const raw = Array.isArray(data)
    ? data
    : data && typeof data === 'object' && Array.isArray((data as any).buckets)
      ? (data as any).buckets
      : []
  return (raw as unknown[]).filter(isQuotaBucket)
}

/**
 * Map one bucket. Google reports what is LEFT (`remainingFraction`, 0–1) where every other
 * provider reports what is used, so this inverts — getting that backwards would show a drained
 * quota as untouched.
 */
function mapBucket(b: QuotaBucket): UsageLimit {
  const usedPercent = Math.min(100, Math.max(0, Math.round((1 - b.remainingFraction) * 100)))
  const resetsAt = Date.parse(b.resetTime)
  return {
    // Each bucket is a per-model cap, which is the same idea as Claude's `weekly_scoped` — the
    // model rides in scopeLabel, so the UI labels it without knowing anything about Gemini.
    kind: 'model_hourly',
    group: 'model',
    usedPercent,
    // Google reports no severity.
    severity: null,
    resetsAt: Number.isNaN(resetsAt) ? null : resetsAt,
    windowMinutes: BUCKET_WINDOW_MINUTES,
    scopeLabel: modelLabel(b.modelId),
    isActive: false
  }
}

/**
 * Google returns the same underlying bucket under several model aliases (a `-latest` id and its
 * concrete version share one quota), so rendering them all would repeat one bar three times.
 * Identical (usedPercent, resetsAt) means one bucket; keep the entry with the best name —
 * a known label beats an unknown one, and among equals the shorter one wins.
 */
export function dedupeBuckets(buckets: QuotaBucket[]): UsageLimit[] {
  const out: { limit: UsageLimit; known: boolean }[] = []
  const seen = new Map<string, number>()

  for (const b of buckets) {
    const limit = mapBucket(b)
    const known = b.modelId in MODEL_LABELS
    const key = `${limit.usedPercent}-${limit.resetsAt}`
    const at = seen.get(key)
    if (at === undefined) {
      seen.set(key, out.length)
      out.push({ limit, known })
      continue
    }
    const prev = out[at]!
    const better =
      (known && !prev.known) ||
      (known === prev.known && (limit.scopeLabel?.length ?? 0) < (prev.limit.scopeLabel?.length ?? 0))
    if (better) out[at] = { limit, known }
  }
  return out.map((e) => e.limit)
}

function snapshot(limits: UsageLimit[], status: ProviderUsage['status']): ProviderUsage {
  return { provider: 'gemini', limits, account: null, updatedAt: Date.now(), status }
}

async function postJson(url: string, token: string, body: unknown): Promise<Response> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
    signal: ctrl.signal
  }).finally(() => clearTimeout(t))
}

/**
 * The quota call is project-scoped. `GOOGLE_CLOUD_PROJECT` short-circuits the lookup (the Gemini
 * CLI honours it too); otherwise ask Code Assist which project this account is onboarded to.
 */
export async function resolveProjectId(token: string): Promise<string | null> {
  const fromEnv = process.env.GOOGLE_CLOUD_PROJECT?.trim()
  if (fromEnv) return fromEnv
  const res = await postJson(LOAD_CODE_ASSIST_URL, token, {
    metadata: { ideType: 'GEMINI_CLI', pluginType: 'GEMINI' }
  })
  if (!res.ok) return null
  const data = (await res.json()) as Record<string, any>
  return typeof data.cloudaicompanionProject === 'string' ? data.cloudaicompanionProject : null
}

/**
 * Gemini usage. Never rejects — a missing credentials file, an expired token and an unreachable
 * API are all "we don't know", which the UI renders as no data rather than an error the user
 * cannot act on.
 *
 * Note there is no synthesized "session" window here. Orca derives one from its most-constrained
 * bucket because its shape has fixed session/weekly slots to fill; ours carries a list, so the
 * buckets ARE the limits and `primaryLimit` already leads with the worst of them.
 */
export async function fetchGeminiUsage(
  home = path.join(os.homedir(), '.gemini')
): Promise<ProviderUsage> {
  try {
    const { accessToken, expired } = await readGeminiCreds(home)
    // Not signed in, or the token lapsed and only the CLI can renew it — see the header note.
    if (!accessToken || expired) return snapshot([], 'unavailable')

    const projectId = await resolveProjectId(accessToken)
    if (!projectId) return snapshot([], 'unavailable')

    const res = await postJson(RETRIEVE_QUOTA_URL, accessToken, { project: projectId })
    // 401/403 means the token is stale despite its local expiry_date — same "nothing to show"
    // outcome as being logged out, not an error worth alarming about.
    if (res.status === 401 || res.status === 403) return snapshot([], 'unavailable')
    if (!res.ok) return snapshot([], 'error')

    return snapshot(dedupeBuckets(parseQuotaBuckets(await res.json())), 'ok')
  } catch {
    return snapshot([], 'error')
  }
}
