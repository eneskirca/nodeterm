// Cursor plan usage: the same numbers the CLI's own `/usage` command shows.
//
// Source, measured on cursor-agent 2026.10.01-e373342: the CLI's `src/usage/usage-data.ts` calls
// `aiserver.v1.DashboardService/GetCurrentPeriodUsage` (Connect protocol, so plain JSON over POST
// works) on its backend `https://api2.cursor.sh`. `planUsage` carries the plan's included-usage
// percentages (total, Auto bucket, API bucket); `billingCycleEnd` is the reset (epoch ms, as a
// string because it is an int64).
//
// The credential is the CLI's own login, read and never written or refreshed (refreshing would
// rotate the token under a live `cursor-agent`). Where it lives is the CLI's `cli-credentials`
// store: the macOS login Keychain (account `cursor-user`, service `cursor-access-token`, written by
// `/usr/bin/security`, so reading it with the same binary raises no prompt); everywhere else, and
// on macOS with AGENT_CLI_CREDENTIAL_STORE=file, an `auth.json` with `accessToken`. The token only
// ever travels in-process: the `security` call's argv holds the service name, the value comes
// back on stdout.
import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import type { ProviderUsage, UsageLimit } from '../../shared/types'
import { HOLD_LAST_GOOD_MAX_MS } from './claude-usage-map'

const execFileP = promisify(execFile)

const USAGE_URL = 'https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage'
const FETCH_TIMEOUT_MS = 8000
/** A usage reply is a few fields; a body past this is not one and is never parsed. */
const MAX_BODY_BYTES = 256 * 1024

/** The reply's JSON, or null when it runs past MAX_BODY_BYTES (the read stops there). */
async function cappedJson(res: Response): Promise<unknown> {
  const reader = res.body?.getReader()
  if (!reader) return null
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > MAX_BODY_BYTES) {
      await reader.cancel()
      return null
    }
    chunks.push(value)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/** The CLI's `auth.json` path when it uses the file store (its own `getAuthFilePath`). */
export function cursorAuthFile(platform = process.platform, env = process.env, home = os.homedir()): string {
  if (platform === 'win32') return path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Cursor', 'auth.json')
  if (platform === 'darwin') return path.join(home, '.cursor', 'auth.json')
  return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'cursor', 'auth.json')
}

export async function readCursorToken(): Promise<string | null> {
  if (process.platform === 'darwin') {
    try {
      const { stdout } = await execFileP(
        '/usr/bin/security',
        ['find-generic-password', '-a', 'cursor-user', '-s', 'cursor-access-token', '-w'],
        { timeout: 5000 }
      )
      const token = stdout.trim()
      if (token) return token
    } catch {
      // no Keychain item (signed out, or the file store): fall through to auth.json
    }
  }
  try {
    const j = JSON.parse(await fs.readFile(cursorAuthFile(), 'utf-8')) as Record<string, unknown>
    return typeof j.accessToken === 'string' && j.accessToken ? j.accessToken : null
  } catch {
    return null
  }
}

/** The login's `sub` claim, used only to refuse holding one account's numbers for another. */
export function tokenSubject(token: string): string | null {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf-8'))
    return typeof payload?.sub === 'string' ? payload.sub : null
  } catch {
    return null
  }
}

function num(value: unknown): number | null {
  const n = typeof value === 'string' ? Number(value) : value
  return typeof n === 'number' && Number.isFinite(n) ? n : null
}

function limit(kind: string, scopeLabel: string | null, percent: number, resetsAt: number | null, windowMinutes: number | null): UsageLimit {
  return {
    kind,
    group: 'monthly',
    usedPercent: Math.min(100, Math.max(0, percent)),
    severity: null,
    resetsAt,
    windowMinutes,
    scopeLabel,
    isActive: false
  }
}

/**
 * A GetCurrentPeriodUsage body → limits. No `planUsage` (the CLI's enterprise/spend-only case)
 * or no total is an empty list: nothing honest to draw, never a fabricated 0%.
 */
export function mapCursorLimits(body: unknown): UsageLimit[] {
  if (!body || typeof body !== 'object') return []
  const b = body as Record<string, any>
  const plan = b.planUsage as Record<string, unknown> | undefined
  if (!plan || typeof plan !== 'object') return []

  const end = num(b.billingCycleEnd)
  const start = num(b.billingCycleStart)
  const resetsAt = end && end > 0 ? end : null
  const windowMinutes = resetsAt && start && start > 0 && resetsAt > start ? Math.round((resetsAt - start) / 60_000) : null

  // The CLI's own fallback: no percentage → included spend over the limit.
  const cap = num(plan.limit)
  const spent = num(plan.includedSpend)
  const total = num(plan.totalPercentUsed) ?? (cap && cap > 0 && spent !== null ? (spent / cap) * 100 : null)
  if (total === null) return []

  const out = [limit('monthly', null, total, resetsAt, windowMinutes)]
  const auto = num(plan.autoPercentUsed)
  if (auto !== null) out.push(limit('monthly_scoped', 'Auto', auto, resetsAt, windowMinutes))
  const api = num(plan.apiPercentUsed)
  if (api !== null) out.push(limit('monthly_scoped', 'API', api, resetsAt, windowMinutes))
  return out
}

/**
 * A failed read keeps the last good numbers of the SAME login (the `holdLastGood` rule Claude
 * uses): status 'error', old limits, old `updatedAt`. Refuses when a different login answered,
 * the numbers are older than an hour, or the billing period has reset since.
 */
export function holdCursorLastGood(
  prev: { sub: string | null; usage: ProviderUsage } | null,
  next: ProviderUsage,
  sub: string | null,
  now: number
): ProviderUsage {
  if (next.status !== 'error' || !prev || prev.usage.limits.length === 0) return next
  if (prev.sub !== sub) return next
  if (now - prev.usage.updatedAt > HOLD_LAST_GOOD_MAX_MS) return next
  if (prev.usage.limits.some((l) => l.resetsAt !== null && l.resetsAt <= now)) return next
  return { ...prev.usage, status: 'error' }
}

function snapshot(limits: UsageLimit[], status: ProviderUsage['status']): ProviderUsage {
  return { provider: 'cursor', limits, account: null, updatedAt: Date.now(), status }
}

// note: one process-wide slot, since Cursor has one login per machine; per-account slots if
// nodeterm ever manages several Cursor logins.
let lastGood: { sub: string | null; usage: ProviderUsage } | null = null

/** Cursor usage. Never rejects. `deps` exist for tests. */
export async function fetchCursorUsage(
  deps: { readToken?: () => Promise<string | null>; fetchImpl?: typeof fetch } = {}
): Promise<ProviderUsage> {
  const token = await (deps.readToken ?? readCursorToken)().catch(() => null)
  // Signed out: no row, exactly like the other CLI-credential providers.
  if (!token) return snapshot([], 'unavailable')
  const sub = tokenSubject(token)
  let fresh: ProviderUsage
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
    const res = await (deps.fetchImpl ?? fetch)(USAGE_URL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'connect-protocol-version': '1'
      },
      body: '{}',
      signal: ctrl.signal
    }).finally(() => clearTimeout(t))
    // Only the CLI renews its token, so an expired one is "nothing to show", not a failure.
    if (res.status === 401 || res.status === 403) fresh = snapshot([], 'unavailable')
    else if (!res.ok) fresh = snapshot([], 'error')
    else {
      const limits = mapCursorLimits(await cappedJson(res))
      fresh = snapshot(limits, limits.length > 0 ? 'ok' : 'unavailable')
    }
  } catch {
    fresh = snapshot([], 'error')
  }
  const out = holdCursorLastGood(lastGood, fresh, sub, Date.now())
  if (fresh.status === 'ok') lastGood = { sub, usage: fresh }
  else if (fresh.status === 'unavailable') lastGood = null
  return out
}

/** Test seam: forget the held snapshot. */
export function resetCursorUsageHold(): void {
  lastGood = null
}
