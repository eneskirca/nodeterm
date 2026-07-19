// Kimi Code subscription usage.
//
// Strictly read-only, and here that is load-bearing rather than a house style: the access token
// in `~/.kimi-code/credentials/kimi-code.json` has a ~15-minute TTL and the Kimi CLI rotates the
// refresh token alongside it. Writing that file — or spending its refresh token — would log out
// a live `kimi` session.
import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import type { ProviderUsage, UsageLimit } from '../../shared/types'

const DEFAULT_BASE_URL = 'https://api.kimi.com/coding/v1'
const FETCH_TIMEOUT_MS = 8000
const WEEKLY_WINDOW_MINUTES = 10_080

export function kimiHome(): string {
  return process.env.KIMI_CODE_HOME?.trim() || path.join(os.homedir(), '.kimi-code')
}

function baseUrl(): string {
  return process.env.KIMI_CODE_BASE_URL?.trim().replace(/\/$/, '') || DEFAULT_BASE_URL
}

export async function readKimiToken(home = kimiHome()): Promise<string | null> {
  try {
    const raw = await fs.readFile(path.join(home, 'credentials', 'kimi-code.json'), 'utf-8')
    const j = JSON.parse(raw) as Record<string, any>
    const token = j.access_token ?? j.accessToken
    return typeof token === 'string' && token ? token : null
  } catch {
    return null
  }
}

/** Counts arrive as strings on some responses and numbers on others. */
function toInt(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string') {
    const n = Number(value)
    return Number.isFinite(n) ? n : null
  }
  return null
}

/** `{ duration, timeUnit }` → minutes. An unrecognized unit is treated as minutes. */
export function windowToMinutes(window: unknown): number | null {
  const w = (window ?? {}) as Record<string, any>
  const duration = toInt(w.duration)
  if (duration === null) return null
  const unit = String(w.timeUnit ?? '').toUpperCase()
  if (unit.includes('SECOND')) return Math.round(duration / 60)
  if (unit.includes('MINUTE')) return duration
  if (unit.includes('HOUR')) return duration * 60
  if (unit.includes('DAY')) return duration * 60 * 24
  return duration
}

/**
 * One quota block → a limit. Kimi reports counts, not percentages, and gives `used` on some
 * plans and `remaining` on others — derive the missing one rather than dropping the window.
 */
export function mapKimiDetail(
  detail: unknown,
  kind: string,
  group: string,
  windowMinutes: number | null
): UsageLimit | null {
  if (!detail || typeof detail !== 'object') return null
  const d = detail as Record<string, any>
  const limit = toInt(d.limit)
  let used = toInt(d.used)
  if (used === null) {
    const remaining = toInt(d.remaining)
    if (remaining !== null && limit !== null) used = limit - remaining
  }
  if (limit === null || limit <= 0 || used === null) return null

  const reset = d.resetTime ?? d.resetAt
  const resetsAt = typeof reset === 'string' ? Date.parse(reset) || null : null

  return {
    kind,
    group,
    usedPercent: Math.min(100, Math.max(0, (used / limit) * 100)),
    severity: null,
    resetsAt,
    windowMinutes,
    scopeLabel: null,
    isActive: false
  }
}

/**
 * The top-level `usage` block is the weekly quota; entries in `limits[]` are shorter rolling
 * windows.
 *
 * Orca picks the single `limits[]` entry closest to 5h because its shape has one `session` slot
 * to fill. Ours carries a list, so every window is emitted — a plan with both an hourly and a
 * 5-hourly cap shows both instead of silently discarding one.
 */
export function mapKimiLimits(body: unknown): UsageLimit[] {
  if (!body || typeof body !== 'object') return []
  const b = body as Record<string, any>
  const out: UsageLimit[] = []

  const weekly = mapKimiDetail(b.usage, 'weekly_all', 'weekly', WEEKLY_WINDOW_MINUTES)
  if (weekly) out.push(weekly)

  const entries = Array.isArray(b.limits) ? b.limits : []
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue
    const minutes = windowToMinutes((entry as any).window)
    const mapped = mapKimiDetail((entry as any).detail, 'session', 'session', minutes)
    if (mapped) out.push(mapped)
  }
  return out
}

function snapshot(limits: UsageLimit[], status: ProviderUsage['status']): ProviderUsage {
  return { provider: 'kimi', limits, account: null, updatedAt: Date.now(), status }
}

/** Kimi usage. Never rejects. */
export async function fetchKimiUsage(home = kimiHome()): Promise<ProviderUsage> {
  try {
    const token = await readKimiToken(home)
    if (!token) return snapshot([], 'unavailable')

    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
    const res = await fetch(`${baseUrl()}/usages`, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      signal: ctrl.signal
    }).finally(() => clearTimeout(t))

    // The token lives ~15 minutes and only the CLI renews it, so an expired one is "nothing to
    // show" rather than an error — exactly the Gemini situation.
    if (res.status === 401 || res.status === 403) return snapshot([], 'unavailable')
    if (!res.ok) return snapshot([], 'error')

    const limits = mapKimiLimits(await res.json())
    return snapshot(limits, limits.length > 0 ? 'ok' : 'unavailable')
  } catch {
    return snapshot([], 'error')
  }
}
