// Codex (ChatGPT) subscription usage. Two independent sources, tried in order:
//
//   1. The ChatGPT backend endpoint Codex itself reads (`backend-client`'s
//      `get_rate_limit_status`). Cheap: one HTTPS request with the token already on disk.
//   2. The `codex app-server` JSON-RPC surface. Costs a subprocess, so it is only a fallback —
//      but it is the one that works when the backend contract shifts under us.
//
// A third tier (driving the interactive CLI in a PTY) is deliberately NOT here; see the note on
// `fetchCodexUsage` below.
//
// Read-only, like the Claude provider: we never write or refresh `auth.json`. The Codex CLI
// rotates those tokens itself, and rewriting the file would log out a live `codex` session.
import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import { spawn } from 'child_process'
import type { ProviderUsage, UsageLimit } from '../../shared/types'
import { parseResetTimestamp } from './claude-usage-map'
import { directExecutableInvocation, findInLoginPath } from '../exec-path'

const BACKEND_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage'
const FETCH_TIMEOUT_MS = 8000
const APP_SERVER_TIMEOUT_MS = 10_000

/** Fallback bucket durations, used only when the backend omits `limit_window_seconds`. */
const PRIMARY_WINDOW_MINUTES = 300 // 5h
const SECONDARY_WINDOW_MINUTES = 10_080 // 7d

/** `~/.codex`, or `$CODEX_HOME` when the user has relocated it. */
export function codexHome(): string {
  return process.env.CODEX_HOME?.trim() || path.join(os.homedir(), '.codex')
}

interface CodexAuth {
  accessToken: string | null
  accountId: string | null
}

/** Read the access token Codex stores after `codex login`. Never written back. */
export async function readCodexAuth(home = codexHome()): Promise<CodexAuth> {
  try {
    const raw = await fs.readFile(path.join(home, 'auth.json'), 'utf-8')
    const j = JSON.parse(raw) as Record<string, any>
    const tokens = j.tokens as Record<string, any> | undefined
    return {
      accessToken: typeof tokens?.access_token === 'string' ? tokens.access_token : null,
      accountId: typeof tokens?.account_id === 'string' ? tokens.account_id : null
    }
  } catch {
    return { accessToken: null, accountId: null }
  }
}

function clampPercent(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null
  return Math.min(100, Math.max(0, v))
}

/**
 * Map one Codex rate-limit window. `limit_window_seconds` is the bucket's REAL duration and the
 * backend varies it by plan, so it wins over the caller's fallback — labelling a 7h window "5h"
 * because of its position in the payload would be a lie. Rounds partial minutes up, matching
 * Codex's own `window_minutes_from_seconds`.
 */
export function mapCodexWindow(
  raw: unknown,
  kind: string,
  group: string,
  fallbackWindowMinutes: number
): UsageLimit | null {
  if (!raw || typeof raw !== 'object') return null
  const w = raw as Record<string, any>
  const usedPercent = clampPercent(w.used_percent ?? w.usedPercent)
  if (usedPercent === null) return null

  const seconds = w.limit_window_seconds ?? w.limitWindowSeconds
  const windowMinutes =
    typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0
      ? Math.ceil(seconds / 60)
      : fallbackWindowMinutes

  return {
    kind,
    group,
    usedPercent,
    // Codex reports no severity — leave it to the local percentage thresholds. Defaulting to
    // 'normal' here would paint an exhausted Codex window green.
    severity: null,
    // Codex sends `reset_at` as Unix SECONDS; parseResetTimestamp promotes those to ms.
    resetsAt: parseResetTimestamp(w.reset_at ?? w.resetsAt),
    windowMinutes,
    scopeLabel: null,
    // Codex flags no "currently gating" window; the UI falls back to worst-percentage.
    isActive: false
  }
}

/** Normalize either transport's payload — the backend and app-server shapes differ only in case. */
export function mapCodexLimits(rateLimit: unknown): UsageLimit[] {
  if (!rateLimit || typeof rateLimit !== 'object') return []
  const r = rateLimit as Record<string, any>
  const primary = r.primary_window ?? r.primary
  const secondary = r.secondary_window ?? r.secondary
  return [
    mapCodexWindow(primary, 'session', 'session', PRIMARY_WINDOW_MINUTES),
    mapCodexWindow(secondary, 'weekly_all', 'weekly', SECONDARY_WINDOW_MINUTES)
  ].filter((l): l is UsageLimit => l !== null)
}

function snapshot(
  limits: UsageLimit[],
  status: ProviderUsage['status'],
  account: string | null = null,
  accountId?: string
): ProviderUsage {
  return { provider: 'codex', limits, account, accountId, updatedAt: Date.now(), status }
}

/** Tier 1: the endpoint the Codex CLI itself reads. */
async function fetchViaBackend(home: string): Promise<ProviderUsage | null> {
  const { accessToken, accountId } = await readCodexAuth(home)
  if (!accessToken) return null

  const headers: Record<string, string> = {
    authorization: `Bearer ${accessToken}`,
    // Codex's own client identity. The backend gates on these, so they are not decoration.
    'user-agent': 'codex-cli',
    'openai-beta': 'codex-1',
    originator: 'Codex Desktop'
  }
  if (accountId) headers['chatgpt-account-id'] = accountId

  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
  const res = await fetch(BACKEND_USAGE_URL, { signal: ctrl.signal, headers }).finally(() =>
    clearTimeout(t)
  )
  if (!res.ok) return null

  const payload = (await res.json()) as Record<string, any>
  // `plan_type` is required by Codex's own RateLimitStatusPayload. Without it we are looking at
  // something else that merely returned 200 (a captive portal, an error envelope) — reject so
  // the app-server tier still gets its turn instead of reporting a confidently empty snapshot.
  if (typeof payload.plan_type !== 'string') return null

  return snapshot(mapCodexLimits(payload.rate_limit), 'ok')
}

/**
 * Tier 2: `codex app-server` speaks JSON-RPC over stdio. Costs a subprocess, so it runs only
 * when the backend tier declined. Sandboxed read-only/untrusted — this must never be a way for
 * a quota refresh to touch the user's files.
 */
export async function fetchCodexUsageViaAppServerAt(
  bin: string,
  home: string
): Promise<ProviderUsage | null> {
  const invocation = directExecutableInvocation(bin, [
    '-s',
    'read-only',
    '-a',
    'untrusted',
    'app-server'
  ])
  if (!invocation) return null
  return new Promise<ProviderUsage | null>((resolve) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(invocation.executable, invocation.args, {
        env: { ...process.env, CODEX_HOME: home },
        stdio: ['pipe', 'pipe', 'ignore']
      })
    } catch {
      resolve(null)
      return
    }

    let settled = false
    const finish = (v: ProviderUsage | null): void => {
      if (settled) return
      settled = true
      try {
        child.kill()
      } catch {
        // already gone
      }
      resolve(v)
    }

    const timer = setTimeout(() => finish(null), APP_SERVER_TIMEOUT_MS)
    timer.unref?.()

    // A missing `codex` binary surfaces here, not as a spawn throw.
    child.on('error', () => finish(null))
    child.on('exit', () => finish(null))
    // codex can exit before draining a request (an older CLI without `app-server` prints usage
    // and quits) — the EPIPE from the stdin writes below is an async 'error' EVENT on the pipe,
    // not a throw at the call site, and unhandled it kills the main process (issue #382's
    // class). A broken pipe means no reply is coming, so settle instead of waiting the timer out.
    child.stdin?.on('error', () => finish(null))

    let buf = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      buf += chunk.toString()
      // Line-delimited JSON-RPC; a partial trailing line stays in the buffer.
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.trim()) continue
        let msg: Record<string, any>
        try {
          msg = JSON.parse(line)
        } catch {
          continue
        }
        if (msg.id === 1) {
          // initialize acked → announce, then ask for the limits.
          child.stdin?.write(JSON.stringify({ jsonrpc: '2.0', method: 'initialized' }) + '\n')
          child.stdin?.write(
            JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'account/rateLimits/read' }) + '\n'
          )
        } else if (msg.id === 2) {
          const limits = mapCodexLimits(msg.result?.rateLimits)
          finish(limits.length > 0 ? snapshot(limits, 'ok') : null)
        }
      }
    })

    child.stdin?.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { clientInfo: { name: 'nodeterm', version: '1' } }
      }) + '\n'
    )
  })
}

async function fetchViaAppServer(home: string): Promise<ProviderUsage | null> {
  const bin = await findInLoginPath('codex')
  return bin ? fetchCodexUsageViaAppServerAt(bin, home) : null
}

/**
 * Codex usage, backend first and app-server second.
 *
 * No PTY tier. One would drive the interactive CLI and scrape the TUI, and would exist
 * mainly to serve users whose auth the HTTP path cannot use. Adding it here means owning hidden
 * PTY lifecycle and screen-scraping regexes, and Claude needs the same machinery for the same
 * reason, so it belongs in one shared piece of work rather than being written twice.
 *
 * Never rejects: an unreachable backend and a missing CLI are both "we don't know", and the
 * caller renders that as no data rather than an error the user can't act on.
 *
 * `identity` scopes the row to one managed account (S6 §4.3): its `id` is stamped as `accountId`
 * on EVERY return path — including `unavailable` — so a row read from account A's home is always
 * attributed to A and can never be mixed with, or mistaken for, another account or the un-owned
 * system row. Absent ⇒ the system account: `account: null`, `accountId: undefined` (un-owned stays
 * explicitly un-owned). The id is never used to build a path here — the caller already resolved
 * `home` from it through the validated account-home builders — so no id validation is duplicated.
 */
export async function fetchCodexUsage(
  home = codexHome(),
  identity?: { id?: string; label?: string | null; email?: string | null }
): Promise<ProviderUsage> {
  const account = identity?.email || identity?.label || null
  const accountId = identity?.id
  try {
    const viaBackend = await fetchViaBackend(home)
    if (viaBackend) return { ...viaBackend, account, accountId }
  } catch {
    // fall through to the app-server tier
  }
  try {
    const viaAppServer = await fetchViaAppServer(home)
    if (viaAppServer) return { ...viaAppServer, account, accountId }
  } catch {
    // fall through to 'unavailable'
  }
  // Not signed in, no CLI, or both transports declined — nothing to show, same as Claude on
  // API-key billing. 'unavailable' hides the provider rather than showing a broken row. Still
  // stamped with this account's identity so an empty read fails closed to THIS account, never to
  // a fabricated one or another account's numbers.
  return snapshot([], 'unavailable', account, accountId)
}
