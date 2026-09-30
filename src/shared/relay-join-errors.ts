// Stable codes for a hosted-team join that failed before it reached the relay.
//
// The main process throws with a message that starts with `[E_JOIN_…]`; that code is the only part
// of the failure that survives Electron IPC (an `ipcMain.handle` rejection reaches the renderer as
// its message, wrapped in Electron's own prefix). A renderer that reconnects on its own reads the
// code with `joinErrorCode` and decides whether trying again can help: only a network failure can.
// Every other code needs a human (a new code, an unlocked keyring, an owner) or a new day, and
// retrying it would at best repeat the refusal and at worst spend damped device-token mints.
// `E_JOIN_BUSY` says nothing about the team at all: another join of OURS for the same team is still
// running, and it is the one that should finish.
// `E_JOIN_THROTTLED` is the service's per-network limiter (it clears within a minute), so it is the
// one refusal worth retrying — never faster than once a minute. `E_JOIN_RATE` is the daily limit on
// device mints: tomorrow, not in a minute.

export const JOIN_ERROR_CODES = [
  'E_JOIN_REVOKED',
  'E_JOIN_REFUSED',
  'E_JOIN_RATE',
  'E_JOIN_BAD_CODE',
  'E_JOIN_NETWORK',
  'E_JOIN_KEY_LOCKED',
  'E_JOIN_BUSY',
  'E_JOIN_THROTTLED'
] as const

export type JoinErrorCode = (typeof JOIN_ERROR_CODES)[number]

const CODE_RE = /\[(E_JOIN_[A-Z_]+)\]/

/** The join error code in `message` (anywhere: Electron prefixes it), or null when there is none. */
export function joinErrorCode(message: string): JoinErrorCode | null {
  if (typeof message !== 'string') return null
  const m = CODE_RE.exec(message)
  const code = m?.[1]
  return code && (JOIN_ERROR_CODES as readonly string[]).includes(code) ? (code as JoinErrorCode) : null
}

/** Whether a failed join is worth retrying unattended. */
export function joinErrorRetries(code: JoinErrorCode | null): boolean {
  return code === 'E_JOIN_NETWORK' || code === 'E_JOIN_THROTTLED'
}

const RETRY_AFTER_RE = /\[retry-after:(\d+)\]/

/** The Retry-After (in ms) main attached to a throttled join as `[retry-after:<seconds>]`, else null. */
export function joinRetryAfterMs(message: string): number | null {
  if (typeof message !== 'string') return null
  const m = RETRY_AFTER_RE.exec(message)
  return m ? Number(m[1]) * 1000 : null
}

/** The tag main appends to a throttled join's message when the service named a Retry-After. */
export function retryAfterTag(ms: number): string {
  return `[retry-after:${Math.max(0, Math.ceil(ms / 1000))}]`
}
