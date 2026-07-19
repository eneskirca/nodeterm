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
import type {
  ClaudeUsage,
  ClaudeUsageWindow,
  ProviderUsage,
  UsageLimit
} from '../../shared/types'
import { findLimit } from '../../shared/usage-limits'
import { mapUsageLimits } from './claude-usage-map'
import { fetchCodexUsage } from './codex-usage'
import { fetchGeminiUsage } from './gemini-usage'
import { fetchGrokUsage } from './grok-usage'
import { fetchKimiUsage } from './kimi-usage'
import { fetchMinimaxUsage } from './minimax-usage'
import { fetchOpencodeUsage } from './opencode-usage'
import {
  COOKIE_PROVIDERS,
  isCookieProvider,
  readProviderCookie,
  writeProviderCookie,
  hasProviderCookie
} from './provider-cookie'
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

/**
 * Providers other than Claude. Claude keeps its own channels because it alone is account-aware
 * (managed config dirs, a per-account popover row); everything else answers one snapshot.
 * Adding a provider is one entry here plus its fetcher — no changes to the service or the UI.
 */
const OTHER_PROVIDERS: { id: string; fetch: () => Promise<ProviderUsage> }[] = [
  { id: 'codex', fetch: fetchCodexUsage },
  { id: 'gemini', fetch: fetchGeminiUsage },
  { id: 'grok', fetch: fetchGrokUsage },
  { id: 'kimi', fetch: fetchKimiUsage },
  // These two publish no on-disk CLI credential; their cookies come from our own 0600 store.
  { id: 'minimax', fetch: async () => fetchMinimaxUsage(await readProviderCookie('minimax')) },
  { id: 'opencode', fetch: async () => fetchOpencodeUsage(await readProviderCookie('opencode')) }
]

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
  /**
   * Local managed accounts to poll ALONGSIDE the system account on the background cadence (spec:
   * mobile-usage-inbox). Returns their account ids (settings' non-`host`, non-`pending` claude
   * accounts). The shell owns this because settings live in the shell. Absent ⇒ system only.
   */
  localAccounts?: () => string[]
  /**
   * Fired after any account's cache is (re)populated — the mirror wires this to a flush so the
   * phone-facing `usage` block refreshes when a poll lands. Best-effort; must never throw.
   */
  onCacheUpdate?: () => void
}

export interface UsageService {
  /** Cached if fresh, else a fresh fetch. */
  fetch(accountId?: string): Promise<ClaudeUsage>
  /** Always a fresh fetch, bypassing the debounce. */
  refresh(accountId?: string): Promise<ClaudeUsage>
  /** Refresh the system account if the debounce has elapsed — for shell focus/attach events. */
  refreshIfStale(): void
  /** Every cached usage row (system account first). Feeds the agent-status mirror's `usage` block. */
  snapshot(): { accountId: string | null; usage: ClaudeUsage }[]
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
    // Best-effort: a fetch launched before shutdown (or a test's platform reset) can land after
    // the shell is gone, and this runs inside an un-awaited promise chain — throwing here is an
    // unhandled rejection, not a signal. The cache above is still updated either way.
    if (key === '') {
      try {
        platform().broadcast(IPC.usageUpdate, u)
      } catch {
        // shell gone — nobody left to notify
      }
    }
    // Notify the mirror (fail-open) so its phone-facing `usage` block re-assembles from the cache.
    try {
      opts.onCacheUpdate?.()
    } catch {
      // a mirror flush must never break the usage cache update
    }
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

  // Non-Claude providers. Fetched on demand (when the popover opens) rather than polled: each
  // one costs its own network round-trip — and, on the app-server fallback, a subprocess — so
  // polling them all on the Claude cadence would multiply that cost for data nobody is looking
  // at. Cached under the same debounce.
  let providersAt = 0
  let providersCache: ProviderUsage[] = []
  let providersInFlight: Promise<ProviderUsage[]> | null = null

  const runProviders = async (): Promise<ProviderUsage[]> => {
    if (providersInFlight) return providersInFlight
    // One slow provider must not withhold the others — settle each independently.
    providersInFlight = Promise.all(
      OTHER_PROVIDERS.map((p) =>
        p.fetch().catch(
          (): ProviderUsage => ({
            provider: p.id,
            limits: [],
            account: null,
            updatedAt: Date.now(),
            status: 'error'
          })
        )
      )
    )
    try {
      providersCache = await providersInFlight
      providersAt = Date.now()
      return providersCache
    } finally {
      providersInFlight = null
    }
  }

  // The cookie is write-only from the UI's perspective: it can be set and cleared, and the UI
  // can ask WHETHER one is stored, but there is no channel that hands the value back. A
  // credential that never crosses the boundary cannot be leaked by whatever reads it.
  platform().handle(IPC.usageSetProviderCookie, async (provider: string, cookie: string) => {
    // The provider id arrives from the renderer and is used to build a file path — validate it
    // against the known set rather than trusting it into `path.join`.
    if (!isCookieProvider(provider)) return false
    await writeProviderCookie(provider, typeof cookie === 'string' ? cookie : '')
    // Drop the cache so the next read reflects the new cookie instead of the old snapshot.
    providersAt = 0
    return hasProviderCookie(provider)
  })
  platform().handle(IPC.usageCookieProviders, async () => {
    const stored: Record<string, boolean> = {}
    for (const p of COOKIE_PROVIDERS) stored[p] = await hasProviderCookie(p)
    return stored
  })

  platform().handle(IPC.usageProviders, (force?: boolean) => {
    if (!force && providersAt && Date.now() - providersAt < REFETCH_DEBOUNCE_MS) {
      return providersCache
    }
    return runProviders()
  })

  // Poll the system account AND every local managed account (spec: mobile-usage-inbox), so the
  // agent-status mirror can advertise per-account usage to the phone — not just the collapsed chip's
  // system row. Each account is one request per cadence; the request-budget gate (`shouldPoll`)
  // still fronts the whole sweep.
  const pollAll = (): void => {
    if (!shouldPoll()) return
    void run()
    let ids: string[] = []
    try {
      ids = opts.localAccounts?.() ?? []
    } catch {
      ids = [] // a throwing provider must never break the poll
    }
    for (const id of ids) if (id) void run(id)
  }

  // The warm-up fetch goes through the same gate as the poll: it IS a poll, just the first one.
  // On desktop a focused window warms the cache before the pill mounts; on the server, boot
  // happens with no browser attached, so this correctly does nothing until someone connects
  // (and UsageIndicator fetches on mount regardless, so nothing is lost either way).
  pollAll()
  const interval = setInterval(pollAll, POLL_MS)
  // Node keeps the process alive for pending timers; the server shell should exit on its own terms.
  interval.unref?.()

  return {
    fetch: (accountId?: string) => run(accountId),
    refresh: (accountId?: string) => run(accountId),
    refreshIfStale: () => {
      if (Date.now() - (lastFetchAt.get('') ?? 0) >= REFETCH_DEBOUNCE_MS) void run()
    },
    snapshot: () =>
      // System account (key '') first, then managed accounts in insertion order.
      [...last.entries()]
        .sort((a, b) => (a[0] === '' ? -1 : b[0] === '' ? 1 : 0))
        .map(([key, usage]) => ({ accountId: key === '' ? null : key, usage })),
    dispose: () => clearInterval(interval)
  }
}
