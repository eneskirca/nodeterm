// Pure helpers for a hosted team (a Server Edition hosting over the E2EE relay, joined by a
// `nodeterm://join` code): the unattended reconnect's backoff and retry decision, the sentences a
// refusal is told in, and the role wording. No React, no window — see docs/hosted-team-relay.md.
import { joinErrorCode, joinErrorRetries, joinRetryAfterMs, type JoinErrorCode } from '@shared/relay-join-errors'
import type { HostedPendingClosedReason, HostedRole, RelayClosedReason } from '@shared/types'

const BACKOFF = [1000, 2000, 4000, 8000, 15000]

/** How long the `attempt`-th unattended retry waits: 1, 2, 4, 8, 15 s, then every 60 s. */
export function reconnectDelayMs(attempt: number): number {
  return attempt < BACKOFF.length ? BACKOFF[attempt] : 60_000
}

/** What an unattended reconnect says, once per streak, while the service's per-network limiter
 *  holds it back (R41). */
export const THROTTLED_NOTICE = 'The nodeterm service is limiting requests from this network — retrying in a minute.'

/** A throttled retry never comes sooner than this, whatever Retry-After says (R41). */
export const THROTTLE_MIN_DELAY_MS = 60_000

/** ...and never later than this. The per-network limiter clears within a minute, so a longer
 *  Retry-After is not a reason to go quiet for longer, and a huge one (past 2^31-1 ms, or too many
 *  digits to be a number) would make the timer fire at once: exactly the burst the floor prevents. */
export const THROTTLE_MAX_DELAY_MS = 600_000

/** How long a throttled join waits: its Retry-After, clamped to [1 min, 10 min]. */
export function throttleDelayMs(retryAfterMs: number | null): number {
  const asked = retryAfterMs === null || Number.isNaN(retryAfterMs) ? 0 : retryAfterMs
  return Math.min(THROTTLE_MAX_DELAY_MS, Math.max(THROTTLE_MIN_DELAY_MS, asked))
}

/** How many times an unattended attempt retries a connection that dropped before the host answered
 *  (a host restarting): the short steps of the ladder, 1/2/4/8/15 s, and then it stops and says so
 *  (R40). Each try mints a join token and opens a relay socket, so this one is bounded — unlike a
 *  network failure, which keeps the 60 s tail (R35). */
export const DROP_RETRY_MAX = 5

/** The sentence for a close the HOST explained (it refused this device), or null for a close it did
 *  not — only reasons the host actually sent are named, never a guessed cause. */
export function closedReasonMessage(reason?: string): string | null {
  switch (reason) {
    case 'removed':
      return 'Your access to this team was removed by an owner.'
    case 'denied':
      return 'An owner declined the request.'
    case 'expired':
      return 'No owner answered the request in time.'
    default:
      return null
  }
}

/** A close that ended a relay connection before it was approved (session/relay-tab.ts). `reason` is
 *  the host's own, set only when a hosted team's host refused this device (an owner declined, nobody
 *  answered, it was removed); a Team Access close carries none and keeps its old message exactly. */
export class RelayApprovalError extends Error {
  constructor(message: string, readonly reason?: RelayClosedReason) {
    super(message)
    this.name = 'RelayApprovalError'
  }
}

/** Could another attempt help a hosted tab that never opened? Only when the connection dropped
 *  WITHOUT the host saying why (a host restarting, a relay blip) or the host vanished right after
 *  approving. A refusal the host explained, a timeout, a declined SAS: no. */
export function mountFailureRetries(err: unknown): boolean {
  if (err instanceof RelayApprovalError) return err.reason === undefined
  return (err as { code?: unknown } | null)?.code === 'E_DISCONNECTED'
}

/** The line a hosted tab that never opened is told in. */
export function mountFailureMessage(err: unknown, teamLabel: string): string {
  const message = err instanceof Error ? err.message : String(err)
  return `Could not open ${teamLabel.trim() || 'the team'}: ${stripIpcPrefix(message)}`
}

/** A device key's short display form. */
export function keyFingerprint(peerKeyB64: string): string {
  return `${peerKeyB64.slice(0, 4)}·${peerKeyB64.slice(4, 8)}`
}

/** A hosted team's FIRST join waits for an owner as long as the host keeps the request pending
 *  (core hosted-service `PENDING_TTL_MS`); a pairing offer keeps the relay tab's own 60 s. */
export const HOSTED_APPROVAL_WAIT_MS = 600_000

/** Main's message without the prefix Electron wraps an `ipcMain.handle` rejection in. */
export function stripIpcPrefix(message: string): string {
  return String(message)
    .replace(/^Error invoking remote method '[^']*': /, '')
    .replace(/^Error: /, '')
}

/** What a failed hosted connect means for the unattended reconnect. */
export interface JoinFailure {
  /** The stable `[E_JOIN_…]` code, or null when the failure carried none. */
  code: JoinErrorCode | null
  /** Worth another unattended attempt: a network failure, and nothing else (R35). */
  retry: boolean
  /** Another attempt of OURS for the same team is running — never a verdict about the team. */
  busy: boolean
  /** The service's per-network limiter: retry, but never faster than once a minute (R41). */
  throttled: boolean
  /** The Retry-After the service named, when it named one. */
  retryAfterMs: number | null
  /** Main's own sentence, without Electron's prefix or the code tag. */
  detail: string
}

export function classifyJoinFailure(message: string): JoinFailure {
  const code = joinErrorCode(String(message))
  const detail = stripIpcPrefix(message)
    .replace(/^\[E_JOIN_[A-Z_]+\]\s*/, '')
    .replace(/\s*\[retry-after:\d+\]/, '')
    .trim()
  return {
    code,
    retry: joinErrorRetries(code),
    busy: code === 'E_JOIN_BUSY',
    throttled: code === 'E_JOIN_THROTTLED',
    retryAfterMs: joinRetryAfterMs(String(message)),
    detail
  }
}

const teamName = (label: string): string => label.trim() || 'the team'

/**
 * The one sentence a stopped hosted connect is told in, or null when there is nothing to tell
 * (BUSY: our other attempt for that team is the one that will answer). A refusal and a locked
 * keyring carry main's own detail verbatim — it names the file or the fix; a stock sentence would
 * hide both (items 13, 19).
 */
export function joinStopMessage(f: JoinFailure, teamLabel: string): string | null {
  const team = teamName(teamLabel)
  switch (f.code) {
    case 'E_JOIN_BUSY':
      return null
    case 'E_JOIN_REVOKED':
      return `This device's access to ${team} was revoked. Remove the team and join again with a fresh invite code.`
    case 'E_JOIN_RATE':
      return `Too many join attempts for ${team} today. Try again tomorrow.`
    case 'E_JOIN_THROTTLED':
      return 'The nodeterm service is limiting requests from this network. Try again in a minute.'
    case 'E_JOIN_BAD_CODE':
      return `The invite code for ${team} is not valid. Ask an owner for a fresh code.`
    case 'E_JOIN_KEY_LOCKED':
      return `Could not load this device's identity to join ${team}: ${f.detail}`
    case 'E_JOIN_NETWORK':
      return `Could not reach ${team}: ${f.detail}`
    default:
      return `Could not join ${team}: ${f.detail}`
  }
}

const ROLE_LABEL: Readonly<Record<HostedRole, string>> = {
  owner: 'Owner',
  editor: 'Editor',
  commenter: 'Commenter',
  viewer: 'Viewer'
}

export function hostedRoleLabel(role: HostedRole): string {
  return ROLE_LABEL[role] ?? 'Viewer'
}

/** Below Editor: the tab may watch (and a commenter may comment), never type, edit or save. */
export function isReadOnlyRole(role: HostedRole | null | undefined): boolean {
  return role === 'viewer' || role === 'commenter'
}

/** The slim banner over a read-only hosted canvas. */
export function viewerBannerText(role: HostedRole, teamLabel: string): string {
  return `You're a ${hostedRoleLabel(role)} in ${teamName(teamLabel)} — terminals are read-only. Ask an owner for Editor access.`
}

/** What an owner is told when a request they were looking at closed on its own: only an answer from
 *  ANOTHER owner is worth a line; an expiry, a drop or a newer request from the same device is not. */
export function pendingClosedNotice(reason: HostedPendingClosedReason): string | null {
  return reason === 'approved' || reason === 'denied' ? 'Another owner answered this request.' : null
}

/** The joiner's non-blocking wait for an owner (a first join can take up to ten minutes). */
export function waitingForOwnerText(teamLabel: string): string {
  return `Waiting for an owner of ${teamName(teamLabel)} to approve this device…`
}
