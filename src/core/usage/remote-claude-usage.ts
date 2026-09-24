// Claude subscription usage for a REMOTE (SSH project) account, read over that project's
// ControlMaster. v1 deliberately had none of this ("remote accounts are excluded"), so a user
// whose Claude runs on a server saw an empty pill while the host had perfectly good numbers.
//
// **The token never leaves the host.** The desktop could `cat` the remote `.credentials.json`
// and call the API itself — it already reads remote transcripts over the same master — but a
// bearer token pulled off a (possibly shared) server into another machine's memory is a bigger
// surface than any transcript read, and it buys nothing: the host can make the request itself.
// So the remote shell reads its own credential file and curls the endpoint; we only ever see
// the JSON answer. Two consequences the command below is built around:
//   - the token must not appear in the remote **argv** (`ps` is readable by other users on a
//     shared host), which is why it is piped into `curl --config -` instead of `-H`;
//   - the reply is marker-delimited, so shell/profile noise can never be parsed as usage
//     (same lesson as `claude-version-probe`).
//
// curl is a hard requirement, not a fallback-to-wget: the canvas-control and context-link shims
// already require it on every host, and wget would put the token back on the command line.
import type { ClaudeAccount, ClaudeUsage } from '../../shared/types'
import { emptyUsage, usageFromPayload } from './claude-usage-map'

/** Same shape of id every remote path builder validates against (see claude-accounts-core). */
const ACCOUNT_ID_RE = /^[A-Za-z0-9_-]+$/

const BEGIN = '__NTU_BEGIN__'
const END = '__NTU_END__'
const EMAIL = '__NTU_EMAIL__'
const STATUS = '__NTU_STATUS__'
const HTTP = '__NTU_HTTP__'

/** How long the REMOTE curl may take. Below the ssh runner's own 15 s child timeout. */
const REMOTE_CURL_TIMEOUT_S = 10

/** One remote Claude identity the usage popover can show a row for. */
export interface RemoteUsageTarget {
  /** Omitted on legacy Claude targets. */
  provider?: 'claude' | 'codex'
  remoteHome?: string
  /** Changes when the reader connection is replaced; prevents reusing a former host session. */
  connectionKey?: string
  /** Stable row identity: `<hostKey>#<accountId ?? ''>`. Also the service's cache key. */
  key: string
  /** `user@host` of the connection — matches `ClaudeAccount.host`. */
  hostKey: string
  /** A connected SSH project on that host, whose ControlMaster carries the read. */
  projectId: string
  /** Managed remote account, or null for the host's system `~/.claude`. */
  accountId: string | null
  /** Display label: the account's own label, else the host key. */
  label: string
}

/** Runs a POSIX sh command on the target's host; resolves its stdout, or null if it could not run. */
export type RemoteUsageRunner = (
  target: RemoteUsageTarget,
  command: string
) => Promise<string | null>

/**
 * The rows to offer, given every connected SSH project and the configured accounts.
 *
 * One host answers once: several projects can share a host (and share its `$HOME`), so the hosts
 * are deduped and the first connected project is elected reader — a second read over a second
 * master would return the same numbers at twice the cost. Each host contributes its system
 * account (`~/.claude`, the common case: someone SSHes in and runs plain `claude`) plus every
 * managed account pinned to that host. `pending` accounts have no credentials yet, so they are
 * skipped exactly as the local popover skips them.
 */
export function remoteUsageTargets(
  connected: readonly { projectId: string; hostKey: string }[],
  accounts: readonly ClaudeAccount[]
): RemoteUsageTarget[] {
  const out: RemoteUsageTarget[] = []
  const seen = new Set<string>()
  for (const { projectId, hostKey } of connected) {
    if (!hostKey || seen.has(hostKey)) continue
    seen.add(hostKey)
    out.push({ key: `${hostKey}#`, hostKey, projectId, accountId: null, label: hostKey })
    for (const a of accounts) {
      if (a.host !== hostKey || a.pending || !ACCOUNT_ID_RE.test(a.id)) continue
      out.push({
        key: `${hostKey}#${a.id}`,
        hostKey,
        projectId,
        accountId: a.id,
        label: a.label || a.id
      })
    }
  }
  return out
}

/**
 * The remote sh command for one account's usage. `accountId` null = the host's system account.
 *
 * The two file paths mirror `usageCredsPaths`' file leg, rooted at the REMOTE `$HOME`: a managed
 * account keeps both under its config dir (`remoteAccountConfigDir`), the system account splits
 * them (`~/.claude/.credentials.json` + `~/.claude.json`). There is no keychain leg — a remote
 * host is a Linux server in practice, and prompting a headless macOS host's Keychain over ssh
 * would hang rather than answer.
 *
 * The account id is re-validated here even though the caller already filtered on it: this is an
 * interpolation into a remote shell command, and the type system is compile-time only.
 */
export function remoteUsageCommand(accountId: string | null): string {
  if (accountId !== null && !ACCOUNT_ID_RE.test(accountId)) {
    throw new Error(`invalid account id: ${JSON.stringify(accountId)}`)
  }
  const credsFile = accountId
    ? `"$HOME/.nodeterm/claude-accounts/${accountId}/.credentials.json"`
    : '"$HOME/.claude/.credentials.json"'
  const identityFile = accountId
    ? `"$HOME/.nodeterm/claude-accounts/${accountId}/.claude.json"`
    : '"$HOME/.claude.json"'
  // `tr -d` first so a pretty-printed file parses too (grep is line-based, and the CLI's writer
  // is not contractually single-line). `head -n 1` takes the first match: in `.claude.json` —
  // large and full of unrelated history — the identity block is the one we want, and a later
  // stray "emailAddress" must not win.
  const firstString = (key: string): string =>
    `grep -o '"${key}"[[:space:]]*:[[:space:]]*"[^"]*"' | head -n 1 | sed 's/.*"\\([^"]*\\)"$/\\1/'`
  const flatten = (file: string): string => `tr -d '\\n\\r' < ${file} 2>/dev/null`
  return [
    `printf '%s\\n' '${BEGIN}'`,
    // `.credentials.json` holds MORE than one "accessToken": every MCP server the CLI has
    // authorized keeps its own under `mcpOAuth`. Taking the first match in the file hands the
    // endpoint an MCP token, which answers 401 — i.e. the row reports "not signed in" on a host
    // that is perfectly signed in. So narrow to the `claudeAiOauth` object first, exactly as the
    // local `parseCreds` does (`j.claudeAiOauth ?? j`); a file without that key falls back to the
    // whole text, which is the flat top-level shape parseCreds also accepts.
    `c=$(${flatten(credsFile)})`,
    `case "$c" in *claudeAiOauth*) c=\${c#*claudeAiOauth}; c=\${c%%\\}*};; esac`,
    `t=$(printf '%s' "$c" | ${firstString('accessToken')})`,
    `e=$(${flatten(identityFile)} | ${firstString('emailAddress')})`,
    `printf '${EMAIL}%s\\n' "$e"`,
    `if [ -z "$t" ]; then printf '${STATUS}nocreds\\n%s\\n' '${END}'; exit 0; fi`,
    `if ! command -v curl >/dev/null 2>&1; then printf '${STATUS}nocurl\\n%s\\n' '${END}'; exit 0; fi`,
    // The token goes in on stdin as a curl config directive — never in argv, where `ps` would
    // hand it to every other user on the host.
    `printf 'header = "authorization: Bearer %s"\\n' "$t" | ` +
      `curl -sS -m ${REMOTE_CURL_TIMEOUT_S} --config - ` +
      `-H 'anthropic-beta: oauth-2025-04-20' ` +
      `-w '\\n${HTTP}%{http_code}\\n' ` +
      `'https://api.anthropic.com/api/oauth/usage' 2>/dev/null`,
    `printf '%s\\n' '${END}'`
  ].join('; ')
}

export interface RemoteUsageOutput {
  /** 'nocreds' | 'nocurl' when the remote short-circuited, else null. */
  reason: string | null
  email: string | null
  /** HTTP status curl reported, or null when it never got that far. */
  httpCode: number | null
  /** The response body, with every marker line stripped. */
  body: string
  /** Did the command actually run to completion (both markers present)? */
  complete: boolean
}

/**
 * Split the marker-delimited reply. Anything outside BEGIN/END is discarded — an ssh banner, a
 * host's MOTD or an rc-file warning is noise, and parsing it as JSON is how a "usage" row ends
 * up reporting nonsense.
 */
export function parseRemoteUsageOutput(stdout: string): RemoteUsageOutput {
  const start = stdout.indexOf(BEGIN)
  const end = stdout.indexOf(END, start + 1)
  const complete = start >= 0 && end > start
  const inner = complete ? stdout.slice(start + BEGIN.length, end) : ''
  let reason: string | null = null
  let email: string | null = null
  let httpCode: number | null = null
  const bodyLines: string[] = []
  for (const line of inner.split('\n')) {
    if (line.startsWith(EMAIL)) {
      const v = line.slice(EMAIL.length).trim()
      email = v || null
    } else if (line.startsWith(STATUS)) {
      reason = line.slice(STATUS.length).trim() || null
    } else if (line.startsWith(HTTP)) {
      const n = Number(line.slice(HTTP.length).trim())
      httpCode = Number.isFinite(n) && n > 0 ? n : null
    } else {
      bodyLines.push(line)
    }
  }
  return { reason, email, httpCode, body: bodyLines.join('\n').trim(), complete }
}

/**
 * One target's snapshot. Fails soft in every direction — this is an informational pill, and a
 * host that is mid-reconnect, missing curl, or logged out must degrade to a quiet row rather
 * than an error the user has to dismiss.
 *
 * Status mapping mirrors the local fetch: no credentials or a 401/403 means "nothing to show
 * for this identity" ('unavailable', which the UI hides), while a reachable-but-broken read
 * ('error') stays visible — a configured account whose numbers stopped arriving is information.
 */
export async function fetchRemoteUsage(
  target: RemoteUsageTarget,
  run: RemoteUsageRunner,
  now: number
): Promise<ClaudeUsage> {
  let stdout: string | null = null
  try {
    stdout = await run(target, remoteUsageCommand(target.accountId))
  } catch {
    return emptyUsage(null, now, 'error')
  }
  if (stdout === null) return emptyUsage(null, now, 'error')
  const out = parseRemoteUsageOutput(stdout)
  // The command never ran (master down, project disconnected mid-read): not evidence that this
  // account has no subscription, so it must not report 'unavailable' and vanish from the popover.
  if (!out.complete) return emptyUsage(out.email, now, 'error')
  if (out.reason === 'nocreds') return emptyUsage(out.email, now, 'unavailable')
  if (out.reason) return emptyUsage(out.email, now, 'error')
  if (out.httpCode === 401 || out.httpCode === 403) return emptyUsage(out.email, now, 'unavailable')
  if (out.httpCode !== 200 || !out.body) return emptyUsage(out.email, now, 'error')
  try {
    return usageFromPayload(JSON.parse(out.body), out.email, now)
  } catch {
    return emptyUsage(out.email, now, 'error')
  }
}
