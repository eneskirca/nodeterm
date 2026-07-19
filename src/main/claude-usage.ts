// Fetches Claude Code subscription usage from Anthropic's OAuth usage endpoint — every limit
// the plan exposes, including per-model scoped caps (Fable's weekly cap and whatever ships
// next), which arrive as generic `limits[]` entries rather than fixed fields.
// Runs in the main process (Node) so the renderer CSP stays 'self' — the renderer asks for the
// data over IPC. Display-only: we never write credentials or refresh tokens.
import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { ipcMain, type BrowserWindow } from 'electron'
import { IPC } from '../shared/ipc'
import type { ClaudeUsage, ClaudeUsageWindow, UsageLimit } from '../shared/types'
import { mapUsageLimits } from '../core/usage/claude-usage-map'
import { findLimit } from '../shared/usage-limits'
import { usageCredsPaths } from '../core/claude-accounts-core'
import { claudeConfigDirFor } from './claude-accounts'

const execFileP = promisify(execFile)

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
const OAUTH_BETA = 'oauth-2025-04-20'
const FETCH_TIMEOUT_MS = 8000
const POLL_MS = 15 * 60 * 1000
const FOCUS_DEBOUNCE_MS = 5 * 60 * 1000

interface OAuthCreds {
  accessToken: string | null
  email: string | null
}

/** Parse a credentials JSON blob; tokens may sit at top level or under `claudeAiOauth`. */
function parseCreds(raw: string): OAuthCreds {
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

/** The OAuth access token alone (keychain → ~/.claude/.credentials.json), or null. */
export async function resolveClaudeAccessToken(): Promise<string | null> {
  return (await resolveCreds()).accessToken
}

/**
 * macOS Keychain → {config}/.credentials.json → email backfill from {config}/.claude.json.
 * With an `accountId` the config dir is the managed account's isolated dir (scoped Keychain
 * service first); without, it's exactly the system default (`~/.claude`, unscoped services).
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

/** Back-compat view of one limit as the old remaining-percent window. */
function asWindow(limit: UsageLimit | null): ClaudeUsageWindow | null {
  if (!limit) return null
  return { leftPercent: 100 - limit.usedPercent, resetsAt: limit.resetsAt }
}

function emptyUsage(
  email: string | null,
  now: number,
  status: ClaudeUsage['status']
): ClaudeUsage {
  return { limits: [], session: null, weekly: null, email, updatedAt: now, status }
}

async function fetchUsage(accountId?: string): Promise<ClaudeUsage> {
  const now = Date.now()
  const { accessToken, email } = await resolveCreds(accountId)
  if (!accessToken) {
    return emptyUsage(email, now, 'unavailable')
  }
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

export function initClaudeUsage(win: BrowserWindow): void {
  // Per-account caches keyed by `accountId ?? ''`. The empty key is the system account, the
  // only one that's proactively polled + pushed; managed-account rows fetch on demand from the
  // popover.
  const last = new Map<string, ClaudeUsage>()
  const lastFetchAt = new Map<string, number>()
  const inFlight = new Map<string, Promise<ClaudeUsage>>()

  const push = (key: string, u: ClaudeUsage): void => {
    last.set(key, u)
    lastFetchAt.set(key, u.updatedAt)
    // Only the system account feeds the push channel — the collapsed chip tracks it.
    if (key === '' && !win.isDestroyed()) win.webContents.send(IPC.usageUpdate, u)
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

  ipcMain.handle(IPC.usageFetch, async (_e, accountId?: string) => {
    const key = accountId ?? ''
    const cached = last.get(key)
    if (cached && Date.now() - (lastFetchAt.get(key) ?? 0) < FOCUS_DEBOUNCE_MS) return cached
    return run(accountId)
  })
  ipcMain.handle(IPC.usageRefresh, (_e, accountId?: string) => run(accountId))

  void run()
  const interval = setInterval(() => {
    if (win.isFocused()) void run()
  }, POLL_MS)

  const onFocus = (): void => {
    if (Date.now() - (lastFetchAt.get('') ?? 0) >= FOCUS_DEBOUNCE_MS) void run()
  }
  win.on('focus', onFocus)
  win.on('closed', () => clearInterval(interval))
}
