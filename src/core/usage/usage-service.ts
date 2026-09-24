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
  ProviderUsage,
  RemoteAccountUsage,
  RemoteUsageQuery
} from '../../shared/types'
import { emptyUsage, usageFromPayload } from './claude-usage-map'
import {
  fetchRemoteUsage,
  type RemoteUsageRunner,
  type RemoteUsageTarget
} from './remote-claude-usage'
import { fetchCodexUsage } from './codex-usage'
import { fetchRemoteCodexUsage } from './remote-codex-usage'
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
  organization?: ClaudeUsage['organization']
}

/**
 * Providers other than Claude. Claude keeps its own channels because it alone is account-aware
 * (managed config dirs, a per-account popover row); everything else answers one snapshot.
 * Adding a provider is one entry here plus its fetcher — no changes to the service or the UI.
 */
const OTHER_PROVIDERS: { id: string; fetch: () => Promise<ProviderUsage> }[] = [
  // Codex is NOT here — it is account-scoped (one system row + one row per managed account,
  // built dynamically in runProviders so each row is keyed by its own accountId and can never
  // collapse into another). See the Codex block in runProviders and S6 §4.3 (no mixing).
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
 * macOS Keychain → {config}/.credentials.json; identity metadata from {config}/.claude.json.
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
    // An unscoped Keychain entry belongs to the system account. Using it here would
    // label the system token's limits with the managed account's organization.
    for (const service of configDir ? services.slice(0, 1) : services) {
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

  if (creds.accessToken) {
    try {
      const raw = await fs.readFile(identityFile, 'utf-8')
      const j = JSON.parse(raw) as Record<string, any>
      const acct = j.oauthAccount as Record<string, any> | undefined
      const email =
        (acct && typeof acct.emailAddress === 'string' && acct.emailAddress) ||
        (acct && typeof acct.email === 'string' && acct.email) ||
        null
      // Identity may lag a login. A known email mismatch must not label this token
      // with another user's organization; missing metadata still leaves usage intact.
      if (!creds.email || !email || creds.email === email) {
        const text = (value: unknown): string | undefined =>
          typeof value === 'string' ? value.trim() || undefined : undefined
        const name = text(acct?.organizationName)
        creds = {
          ...creds,
          email: creds.email || email,
          ...(name
            ? { organization: {
                name,
                uuid: text(acct?.organizationUuid),
                type: text(acct?.organizationType),
                rateLimitTier: text(acct?.organizationRateLimitTier)
              } }
            : {})
        }
      }
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

export async function fetchUsage(accountId?: string): Promise<ClaudeUsage> {
  const now = Date.now()
  const { accessToken, email, organization } = await resolveCreds(accountId)
  const identify = (usage: ClaudeUsage): ClaudeUsage =>
    organization ? { ...usage, organization } : usage
  if (!accessToken) return identify(emptyUsage(email, now, 'unavailable'))
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
      return identify(emptyUsage(email, now, status))
    }
    const data = (await res.json()) as Record<string, any>
    return identify(usageFromPayload(data, email, now))
  } catch {
    return identify(emptyUsage(email, now, 'error'))
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
   * Override the poll gate when the phone-facing MIRROR needs fresh data even though the shell's
   * own `shouldPoll` says no. On desktop `shouldPoll` is "is the window focused" — for the PILL —
   * but the phone reads the agent-status mirror's `usage` block with no window focused at all, so a
   * focus-only gate froze that block into fossil bars whenever the Mac was in the background (the
   * same "nobody connected ≠ nobody looking" bug the Server Edition already runs UNGATED to avoid).
   * When this returns true the background poll fires regardless of `shouldPoll`, at the same 15-min
   * cadence (4 req/hour/account — well inside the endpoint budget). Default: never (desktop wires it
   * to "a phone is paired / has a push grant"; the Server Edition leaves it unset and polls anyway).
   */
  mirrorMayBeRead?: () => boolean
  /**
   * Local managed accounts to poll ALONGSIDE the system account on the background cadence (spec:
   * mobile-usage-inbox). Returns their account ids (settings' non-`host`, non-`pending` claude
   * accounts). The shell owns this because settings live in the shell. Absent ⇒ system only.
   */
  localAccounts?: () => string[]
  /**
   * Local managed Codex accounts (settings' non-`host`, non-`pending` codex accounts), each with
   * the isolated home its `auth.json` lives in. Every one is fetched SEPARATELY and rendered by
   * account — there is no reduce/merge step, so one account's usage can never be attributed to
   * another (S6 §4.3, Property 9). The shell owns this because settings live in the shell. Must
   * never throw — a throwing provider fails closed to system-only, never a fabricated account.
   * Absent ⇒ the system Codex account only (the merged S4 flat-identity behavior is untouched).
   */
  codexAccounts?: () => Array<{ id: string; home: string; label: string; email?: string | null }>
  /**
   * Fired after any account's cache is (re)populated — the mirror wires this to a flush so the
   * phone-facing `usage` block refreshes when a poll lands. Best-effort; must never throw.
   */
  onCacheUpdate?: () => void
  /**
   * Claude accounts living on the hosts of connected SSH projects. Injected the same way Context
   * Link takes its remote deps: core owns the command + the parsing, the shell owns the
   * ControlMaster. Absent ⇒ `usage:remote` answers `[]` — which is exactly right for the Server
   * Edition (no SSH projects there) and needs no capability check in the UI.
   */
  remote?: RemoteUsageDeps
}

export interface RemoteUsageDeps {
  /** The rows to offer right now (see `remoteUsageTargets`). Re-read per request — projects
   *  connect and disconnect under us. Must never throw. */
  targets: () => RemoteUsageTarget[]
  /** Run a POSIX sh command on that target's host; null when it could not run. */
  run: RemoteUsageRunner
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
  const mirrorMayBeRead = opts.mirrorMayBeRead ?? ((): boolean => false)

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
  // The account set the current cache was built from. When it changes (an account added, removed,
  // or relabelled) the cache is busted so a snapshot from a DIFFERENT account set is never served —
  // switching accounts can't show stale numbers (S6 §4.3, cache fingerprint).
  let codexAccountsFingerprint = ''

  // A throwing provider must never break the sweep — fail closed to the empty set (system-only),
  // never a fabricated account (S6 §4.3).
  const readCodexAccounts = (): ReturnType<NonNullable<UsageServiceOptions['codexAccounts']>> => {
    try {
      return opts.codexAccounts?.() ?? []
    } catch {
      return []
    }
  }

  // `id\0home\0label\0email` per account, NUL-joined — every field that changes what a row reports
  // participates, so a relabel or a home move busts the cache too, not just add/remove.
  const fingerprintCodexAccounts = (
    accounts: ReturnType<NonNullable<UsageServiceOptions['codexAccounts']>>
  ): string =>
    accounts.map((a) => `${a.id}\0${a.home}\0${a.label}\0${a.email ?? ''}`).join('\x01')

  const runProviders = async (): Promise<ProviderUsage[]> => {
    if (providersInFlight) return providersInFlight
    // Codex is account-scoped: one system fetcher (no identity ⇒ accountId undefined, the un-owned
    // row stays un-owned) plus one fetcher per managed account against ITS OWN home + identity.
    // No reduce/dedupe merge step — each row is keyed by its own accountId and can never collapse
    // into another (Property 9). The account id is carried on the descriptor so even a THROWN fetch
    // stays attributed to its own account (fail closed), never masquerading as the system row.
    const codexAccounts = readCodexAccounts()
    codexAccountsFingerprint = fingerprintCodexAccounts(codexAccounts)
    type ProviderFetcher = {
      id: string
      accountId?: string
      fetch: () => Promise<ProviderUsage>
    }
    const codexProviders: ProviderFetcher[] = [
      { id: 'codex', fetch: () => fetchCodexUsage() },
      ...codexAccounts.map((account) => ({
        id: 'codex',
        accountId: account.id,
        fetch: () => fetchCodexUsage(account.home, account)
      }))
    ]
    const allProviders: ProviderFetcher[] = [...codexProviders, ...OTHER_PROVIDERS]
    // One slow provider must not withhold the others — settle each independently.
    providersInFlight = Promise.all(
      allProviders.map((p) =>
        p.fetch().catch(
          (): ProviderUsage => ({
            provider: p.id,
            limits: [],
            account: null,
            // Keep the failing row attributed to its own account (undefined for the un-owned
            // rows) so an error fails closed to THIS account, never another's or a fabricated one.
            accountId: p.accountId,
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
    // Bust the debounce when the Codex account set has changed since the cache was built, so a
    // snapshot from a different account set (stale numbers after an add/remove/switch) is never
    // served (S6 §4.3). runProviders re-stamps the fingerprint from the fresh set.
    if (fingerprintCodexAccounts(readCodexAccounts()) !== codexAccountsFingerprint) providersAt = 0
    if (!force && providersAt && Date.now() - providersAt < REFETCH_DEBOUNCE_MS) {
      return providersCache
    }
    return runProviders()
  })

  // Remote (SSH host) Claude accounts. Cached per target under the same debounce and, like the
  // providers above, fetched ON DEMAND rather than polled: each row costs an ssh exec plus an
  // HTTPS request made on someone else's machine, and the pill is informational. The renderer
  // asks on mount, when the popover opens, and whenever the set of connected projects changes.
  const remoteCache = new Map<string, { at: number; usage: ClaudeUsage | ProviderUsage }>()
  const remoteInFlight = new Map<string, Promise<ClaudeUsage | ProviderUsage>>()
  const remoteKey = (t: RemoteUsageTarget): string => JSON.stringify([
    t.provider ?? 'claude', t.hostKey, t.accountId, t.projectId, t.remoteHome, t.connectionKey, t.key
  ])

  const runRemote = async (
    deps: RemoteUsageDeps,
    target: RemoteUsageTarget
  ): Promise<ClaudeUsage | ProviderUsage> => {
    const key = remoteKey(target)
    const pending = remoteInFlight.get(key)
    if (pending) return pending
    const p = target.provider === 'codex'
      ? fetchRemoteCodexUsage(target, deps.run, Date.now())
      : fetchRemoteUsage(target, deps.run, Date.now())
    remoteInFlight.set(key, p)
    try {
      const u = await p
      // A replaced connection/account cannot repopulate the cache with a late old reply.
      if (remoteInFlight.get(key) === p && deps.targets().some(t => remoteKey(t) === key)) {
        remoteCache.set(key, { at: Date.now(), usage: u })
      }
      return u
    } finally {
      if (remoteInFlight.get(key) === p) remoteInFlight.delete(key)
    }
  }

  platform().handle(IPC.usageRemote, async (query?: RemoteUsageQuery): Promise<RemoteAccountUsage[]> => {
    const deps = opts.remote
    if (!deps) return []
    let all: RemoteUsageTarget[] = []
    try {
      all = deps.targets()
    } catch {
      return [] // a throwing provider must never break the popover
    }
    // Rows for hosts that have since disconnected would otherwise sit in the cache forever,
    // reporting numbers from a connection that no longer exists. Evicted against the FULL target
    // list rather than the caller's filtered one: switching between two SSH projects would
    // otherwise throw away each host's cache on the way to the other.
    const live = new Set(all.map(remoteKey))
    for (const key of [...remoteCache.keys()]) if (!live.has(key)) remoteCache.delete(key)
    for (const key of [...remoteInFlight.keys()]) if (!live.has(key)) remoteInFlight.delete(key)
    // The scoped indicator asks for ONE host — the machine the active project runs on — so the
    // other connections cost nothing while you are not looking at them.
    const targets = query?.hostKey ? all.filter((t) => t.hostKey === query.hostKey) : all
    const force = query?.force
    // One slow / unreachable host must not withhold the others.
    const rows = await Promise.all(
      targets.map(async (t): Promise<RemoteAccountUsage> => {
        const cached = remoteCache.get(remoteKey(t))
        const fresh = cached && Date.now() - cached.at < REFETCH_DEBOUNCE_MS
        const usage =
          !force && fresh
            ? cached.usage
            : await runRemote(deps, t).catch((): ClaudeUsage | ProviderUsage => t.provider === 'codex'
              ? { provider: 'codex', accountId: t.accountId ?? undefined, account: t.accountId ? t.label : null,
                  status: 'error', limits: [], updatedAt: Date.now() }
              : emptyUsage(null, Date.now(), 'error'))
        const identity = { hostKey: t.hostKey, accountId: t.accountId, label: t.label }
        return 'provider' in usage
          ? { ...identity, provider: 'codex', usage }
          : { ...identity, usage }
      })
    )
    return rows
  })

  // Poll the system account AND every local managed account (spec: mobile-usage-inbox), so the
  // agent-status mirror can advertise per-account usage to the phone — not just the collapsed chip's
  // system row. Each account is one request per cadence; the request-budget gate (`shouldPoll`)
  // still fronts the whole sweep.
  const pollAll = (): void => {
    // Fire when the shell wants it (focused pill) OR when a phone may be reading the mirror — the
    // latter keeps the phone's `usage` block fresh on a backgrounded desktop instead of fossilizing.
    if (!shouldPoll() && !mirrorMayBeRead()) return
    // Fire-and-forget: a poll that lands after shutdown (or a test's platform reset) throws
    // from platform()-dependent fetch paths — in an un-awaited chain that is an unhandled
    // rejection, not a signal (same hardening as push()'s broadcast).
    void run().catch(() => {})
    let ids: string[] = []
    try {
      ids = opts.localAccounts?.() ?? []
    } catch {
      ids = [] // a throwing provider must never break the poll
    }
    for (const id of ids) if (id) void run(id).catch(() => {})
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
      if (Date.now() - (lastFetchAt.get('') ?? 0) >= REFETCH_DEBOUNCE_MS) void run().catch(() => {})
    },
    snapshot: () =>
      // System account (key '') first, then managed accounts in insertion order.
      [...last.entries()]
        .sort((a, b) => (a[0] === '' ? -1 : b[0] === '' ? 1 : 0))
        .map(([key, usage]) => ({ accountId: key === '' ? null : key, usage })),
    dispose: () => clearInterval(interval)
  }
}
