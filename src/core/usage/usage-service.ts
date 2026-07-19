// Claude Code subscription usage: credential resolution, the OAuth fetch, the per-account cache,
// and the RPC surface. Lives in core so BOTH shells serve it — the Server Edition previously had
// no usage at all (the browser bridge answered `null`), because every line of this was welded to
// Electron's ipcMain + BrowserWindow.
//
// Display-only: we read credentials, never write or refresh them. Rotating a refresh token here
// would log out whatever CLI session owns it.
import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { IPC } from '../../shared/ipc'
import type { ClaudeUsage, ClaudeUsageWindow, UsageLimit } from '../../shared/types'
import { findLimit } from '../../shared/usage-limits'
import { mapUsageLimits } from './claude-usage-map'
import { usageCredsPaths } from '../claude-accounts-core'
import { claudeConfigDirFor } from '../claude-config-dir'
import { platform } from '../platform'

const execFileP = promisify(execFile)

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
const OAUTH_BETA = 'oauth-2025-04-20'
const FETCH_TIMEOUT_MS = 8000
const POLL_MS = 15 * 60 * 1000
/** Also the cache TTL for `usage.fetch` — a repeat call inside this window is served from cache. */
const REFETCH_DEBOUNCE_MS = 5 * 60 * 1000

interface OAuthCreds {
  accessToken: string | null
  email: string | null
}

/** Parse a credentials JSON blob; tokens may sit at top level or under `claudeAiOauth`. */
export function parseCreds(raw: string): OAuthCreds {
  try {
    const j = JSON.parse(raw) as Record<string, any>
    const o = (j.claudeAiOauth ?? j) as Record<string, any>
    const accessToken = typeof o.accessToken === 'string' ? o.accessToken : null
    const email =
      (typeof o.email === 'string' && o.email) ||
      (typeof o.emailAddress === 'string' && o.emailAddress) ||
      null
    return { accessToken, email }
  } catch {
    return { accessToken: null, email: null }
  }
}

/**
 * macOS Keychain → {config}/.credentials.json → email backfill from {config}/.claude.json.
 * With an `accountId` the config dir is the managed account's isolated dir (scoped Keychain
 * service first); without, it's exactly the system default (`~/.claude`, unscoped services).
 *
 * The Keychain leg is darwin-only by construction — on the Server Edition's Linux host the
 * `security` binary does not exist, so the file leg is the whole story there.
 */
async function resolveCreds(accountId?: string): Promise<OAuthCreds> {
  const configDir = accountId ? claudeConfigDirFor(accountId) : undefined
  const { services, credsFile, identityFile } = usageCredsPaths(os.homedir(), configDir)

  let creds: OAuthCreds = { accessToken: null, email: null }

  if (process.platform === 'darwin') {
    for (const service of services) {
      try {
        const { stdout } = await execFileP('security', [
          'find-generic-password',
          '-s',
          service,
          '-w'
        ])
        const parsed = parseCreds(stdout.trim())
        if (parsed.accessToken) {
          creds = parsed
          break
        }
      } catch {
        // not in keychain under this service — try the next / the file
      }
    }
  }

  if (!creds.accessToken) {
    try {
      const raw = await fs.readFile(credsFile, 'utf-8')
      creds = parseCreds(raw)
    } catch {
      // no file — leave creds empty
    }
  }

  if (creds.accessToken && !creds.email) {
    try {
      const raw = await fs.readFile(identityFile, 'utf-8')
      const j = JSON.parse(raw) as Record<string, any>
      const acct = j.oauthAccount as Record<string, any> | undefined
      const email =
        (acct && typeof acct.emailAddress === 'string' && acct.emailAddress) ||
        (acct && typeof acct.email === 'string' && acct.email) ||
        null
      if (email) creds = { ...creds, email }
    } catch {
      // best-effort only
    }
  }

  return creds
}

/** The OAuth access token alone (keychain → {config}/.credentials.json), or null. */
export async function resolveClaudeAccessToken(accountId?: string): Promise<string | null> {
  return (await resolveCreds(accountId)).accessToken
}

/** Back-compat view of one limit as the old remaining-percent window. */
function asWindow(limit: UsageLimit | null): ClaudeUsageWindow | null {
  if (!limit) return null
  return { leftPercent: 100 - limit.usedPercent, resetsAt: limit.resetsAt }
}

function emptyUsage(email: string | null, now: number, status: ClaudeUsage['status']): ClaudeUsage {
  return { limits: [], session: null, weekly: null, email, updatedAt: now, status }
}

export async function fetchUsage(accountId?: string): Promise<ClaudeUsage> {
  const now = Date.now()
  const { accessToken, email } = await resolveCreds(accountId)
  if (!accessToken) return emptyUsage(email, now, 'unavailable')
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
    const res = await fetch(USAGE_URL, {
      signal: ctrl.signal,
      cache: 'no-cache',
      headers: { authorization: `Bearer ${accessToken}`, 'anthropic-beta': OAUTH_BETA }
    }).finally(() => clearTimeout(t))
    if (!res.ok) {
      // 401/403 → token is an API key or expired: no subscription windows to show.
      const status = res.status === 401 || res.status === 403 ? 'unavailable' : 'error'
      return emptyUsage(email, now, status)
    }
    const data = (await res.json()) as Record<string, any>
    const limits = mapUsageLimits(data)
    return {
      limits,
      session: asWindow(findLimit(limits, 'session')),
      weekly: asWindow(findLimit(limits, 'weekly_all')),
      email,
      updatedAt: now,
      status: 'ok'
    }
  } catch {
    return emptyUsage(email, now, 'error')
  }
}

export interface UsageServiceOptions {
  /**
   * Whether a background poll should actually fire. The shell owns this because "is anyone
   * looking?" is shell-specific: Electron asks the window whether it is focused, the server asks
   * whether any browser is connected. Core must not learn about either. Default: always poll.
   *
   * Why gate at all: the usage endpoint has a tight request budget and this data is purely
   * informational, so a stale snapshot beats polling an idle app into 429s.
   */
  shouldPoll?: () => boolean
}

export interface UsageService {
  /** Cached if fresh, else a fresh fetch. */
  fetch(accountId?: string): Promise<ClaudeUsage>
  /** Always a fresh fetch, bypassing the debounce. */
  refresh(accountId?: string): Promise<ClaudeUsage>
  /** Refresh the system account if the debounce has elapsed — for shell focus/attach events. */
  refreshIfStale(): void
  /** Stop the poll timer. */
  dispose(): void
}

/**
 * Start the usage service and register its RPC handlers. Safe to call once per shell boot.
 */
export function startUsageService(opts: UsageServiceOptions = {}): UsageService {
  const shouldPoll = opts.shouldPoll ?? ((): boolean => true)

  // Per-account caches keyed by `accountId ?? ''`. The empty key is the system account, the only
  // one that's proactively polled + pushed; managed-account rows fetch on demand from the popover.
  const last = new Map<string, ClaudeUsage>()
  const lastFetchAt = new Map<string, number>()
  const inFlight = new Map<string, Promise<ClaudeUsage>>()

  const push = (key: string, u: ClaudeUsage): void => {
    last.set(key, u)
    lastFetchAt.set(key, u.updatedAt)
    // Only the system account feeds the push channel — the collapsed chip tracks it.
    if (key === '') platform().broadcast(IPC.usageUpdate, u)
  }

  const run = async (accountId?: string): Promise<ClaudeUsage> => {
    const key = accountId ?? ''
    const pending = inFlight.get(key)
    if (pending) return pending
    const p = fetchUsage(accountId)
    inFlight.set(key, p)
    try {
      const u = await p
      push(key, u)
      return u
    } finally {
      inFlight.delete(key)
    }
  }

  platform().handle(IPC.usageFetch, async (accountId?: string) => {
    const key = accountId ?? ''
    const cached = last.get(key)
    if (cached && Date.now() - (lastFetchAt.get(key) ?? 0) < REFETCH_DEBOUNCE_MS) return cached
    return run(accountId)
  })
  platform().handle(IPC.usageRefresh, (accountId?: string) => run(accountId))

  // The warm-up fetch goes through the same gate as the poll: it IS a poll, just the first one.
  // On desktop a focused window warms the cache before the pill mounts; on the server, boot
  // happens with no browser attached, so this correctly does nothing until someone connects
  // (and UsageIndicator fetches on mount regardless, so nothing is lost either way).
  if (shouldPoll()) void run()
  const interval = setInterval(() => {
    if (shouldPoll()) void run()
  }, POLL_MS)
  // Node keeps the process alive for pending timers; the server shell should exit on its own terms.
  interval.unref?.()

  return {
    fetch: (accountId?: string) => run(accountId),
    refresh: (accountId?: string) => run(accountId),
    refreshIfStale: () => {
      if (Date.now() - (lastFetchAt.get('') ?? 0) >= REFETCH_DEBOUNCE_MS) void run()
    },
    dispose: () => clearInterval(interval)
  }
}
