// Grok (xAI) subscription usage, via the CLI chat proxy's billing endpoint.
//
// Grok is billing-shaped rather than window-shaped: a plan exposes a weekly credit allowance
// and/or a monthly money budget, so the two limits here are derived from billing figures rather
// than read off rate-limit windows. Read-only — we never write `auth.json`.
import { promises as fs } from 'fs'
import path from 'path'
import { grokHomeDir } from '../agents/grok-paths'
import type { ProviderUsage, UsageLimit } from '../../shared/types'

const DEFAULT_PROXY_BASE = 'https://cli-chat-proxy.grok.com/v1'
const FETCH_TIMEOUT_MS = 8000
const WEEKLY_WINDOW_MINUTES = 10_080
const MONTHLY_WINDOW_MINUTES = 43_200

/** Grok's own issuer. An `auth.json` can hold several entries; this one is the CLI's. */
const XAI_ISSUER = 'auth.x.ai'

function proxyBase(): string {
  return process.env.GROK_CLI_CHAT_PROXY_BASE_URL?.trim().replace(/\/$/, '') || DEFAULT_PROXY_BASE
}

/** Grok's config dir. Delegates to the ONE `$GROK_HOME` rule (`core/agents/grok-paths.ts`), which
 *  the hook installer and the session-path helpers also read — two copies of this rule is how the
 *  remote hook installer drifted for months. Kept as a named export because this module's callers
 *  and tests use it. */
export function grokHome(): string {
  return grokHomeDir()
}

interface GrokAuth {
  key: string | null
  userId: string | null
}

/**
 * Read the CLI's API key. `auth.json` maps issuer → entry, and an account can carry entries for
 * more than one issuer, so prefer xAI's own and fall back to the first entry that has a key
 * rather than assuming there is exactly one.
 */
export function pickGrokAuth(parsed: unknown): GrokAuth {
  if (!parsed || typeof parsed !== 'object') return { key: null, userId: null }
  const entries = Object.entries(parsed as Record<string, any>).filter(
    ([, v]) => v && typeof v === 'object' && typeof v.key === 'string' && v.key
  )
  if (entries.length === 0) return { key: null, userId: null }
  const preferred =
    entries.find(([issuer]) => issuer.includes(XAI_ISSUER)) ??
    entries.find(([, v]) => typeof v.oidc_client_id === 'string' && v.oidc_client_id) ??
    entries[0]
  const [, entry] = preferred!
  return {
    key: entry.key,
    userId: typeof entry.user_id === 'string' ? entry.user_id : null
  }
}

export async function readGrokAuth(home = grokHome()): Promise<GrokAuth> {
  try {
    return pickGrokAuth(JSON.parse(await fs.readFile(path.join(home, 'auth.json'), 'utf-8')))
  } catch {
    return { key: null, userId: null }
  }
}

/** Money values arrive as `{ val }`, and `val` is a string on some plans and a number on others. */
export function parseMoney(value: unknown): number | null {
  const raw = (value as any)?.val
  const num = typeof raw === 'string' ? Number.parseFloat(raw) : raw
  return typeof num === 'number' && Number.isFinite(num) ? num : null
}

function periodEnd(config: Record<string, any>): number | null {
  const end = config.currentPeriod?.end ?? config.billingPeriodEnd
  if (typeof end !== 'string') return null
  const t = Date.parse(end)
  return Number.isFinite(t) ? t : null
}

function timestampsMatch(a: unknown, b: unknown): boolean {
  return typeof a === 'string' && typeof b === 'string' && Date.parse(a) === Date.parse(b)
}

/**
 * Weekly credit allowance.
 *
 * The zero case needs care: Grok omits `creditUsagePercent` when it is zero (protobuf drops
 * default values), so an untouched allowance and an absent one look identical. They are only
 * distinguishable when the current period is explicitly weekly AND its bounds match the billing
 * period — then the omission provably means 0% used, not "no such limit".
 */
export function mapGrokWeekly(config: Record<string, any>): UsageLimit | null {
  const confirmedWeekly =
    config.currentPeriod?.type === 'USAGE_PERIOD_TYPE_WEEKLY' &&
    timestampsMatch(config.currentPeriod?.start, config.billingPeriodStart) &&
    timestampsMatch(config.currentPeriod?.end, config.billingPeriodEnd)

  const raw = config.creditUsagePercent === undefined && confirmedWeekly ? 0 : config.creditUsagePercent
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null

  return {
    kind: 'weekly_all',
    group: 'weekly',
    usedPercent: Math.min(100, Math.max(0, raw)),
    severity: null,
    resetsAt: periodEnd(config),
    windowMinutes: WEEKLY_WINDOW_MINUTES,
    scopeLabel: null,
    isActive: false
  }
}

/** Monthly included budget, as a share of spend rather than of requests. */
export function mapGrokMonthly(config: Record<string, any>): UsageLimit | null {
  const limit = parseMoney(config.monthlyLimit)
  const used = parseMoney(config.used)
  if (limit === null || used === null || limit <= 0) return null
  return {
    kind: 'monthly_spend',
    group: 'monthly',
    usedPercent: Math.min(100, Math.max(0, (used / limit) * 100)),
    severity: null,
    resetsAt: periodEnd(config),
    windowMinutes: MONTHLY_WINDOW_MINUTES,
    scopeLabel: null,
    isActive: false
  }
}

/** The figures live at the top level on some responses and under `config` on others. */
export function grokConfigOf(body: unknown): Record<string, any> {
  if (!body || typeof body !== 'object') return {}
  const b = body as Record<string, any>
  return b.config && typeof b.config === 'object' ? { ...b, ...b.config } : b
}

export function mapGrokLimits(body: unknown): UsageLimit[] {
  const config = grokConfigOf(body)
  return [mapGrokWeekly(config), mapGrokMonthly(config)].filter((l): l is UsageLimit => l !== null)
}

function snapshot(limits: UsageLimit[], status: ProviderUsage['status']): ProviderUsage {
  return { provider: 'grok', limits, account: null, updatedAt: Date.now(), status }
}

async function getBilling(url: string, auth: GrokAuth): Promise<unknown | null> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${auth.key}`,
    accept: 'application/json'
  }
  // The CLI sends a second auth header whose value it takes from the environment; forward it
  // when present rather than inventing one.
  const tokenAuth = process.env.GROK_CLI_AUTH_HEADER?.trim()
  if (tokenAuth) headers['x-xai-token-auth'] = tokenAuth
  if (auth.userId) headers['x-userid'] = auth.userId

  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
  const res = await fetch(url, { headers, signal: ctrl.signal }).finally(() => clearTimeout(t))
  if (!res.ok) return null
  return res.json()
}

/**
 * Grok usage. Two views: the credits view carries `creditUsagePercent`, but unified-billing
 * accounts omit it and expose only the monthly budget — so when the credits view yields nothing
 * usable, the default view is consulted before giving up. Never rejects.
 */
export async function fetchGrokUsage(home = grokHome()): Promise<ProviderUsage> {
  try {
    const auth = await readGrokAuth(home)
    if (!auth.key) return snapshot([], 'unavailable')

    const base = proxyBase()
    const credits = await getBilling(`${base}/billing?format=credits`, auth)
    const fromCredits = credits ? mapGrokLimits(credits) : []
    if (fromCredits.length > 0) return snapshot(fromCredits, 'ok')

    const dflt = await getBilling(`${base}/billing`, auth)
    const fromDefault = dflt ? mapGrokLimits(dflt) : []
    if (fromDefault.length > 0) return snapshot(fromDefault, 'ok')

    // Both views answered but neither carried a quota: the account genuinely has none to show.
    if (credits !== null || dflt !== null) return snapshot([], 'unavailable')
    return snapshot([], 'error')
  } catch {
    return snapshot([], 'error')
  }
}
