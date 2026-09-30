// The renderer-safe half of a hosted team's join code (`nodeterm://join?code=<base64url(JSON)>`).
//
// The real codec lives in core (src/core/relay/join-code.ts): it VERIFIES a code (the hostId must
// derive from the host key it carries, the relay must be one we will dial) and needs node's crypto
// to do so. The renderer cannot import it, but it still has to tell a join code from a pairing offer
// and to know which team a pasted code names, so it can keep ONE attempt per team (a second attempt
// would open a second pending request on the host, which replaces the first). The prefix lives here
// once and core imports it.
//
// `peekJoinCode` trusts nothing: it reads what a code CLAIMS, for display and for de-duplication
// only. Every decision that matters is made in main, on the verified decode.

export const JOIN_CODE_PREFIX = 'nodeterm://join?code='

/** Is this a hosted team's join code (as opposed to a pairing offer)? */
export function isJoinCode(s: string): boolean {
  return typeof s === 'string' && s.trim().startsWith(JOIN_CODE_PREFIX)
}

/** The same cap core's decoder puts on a hostId. */
const HOST_ID_MAX = 64

/** The team a join code names, UNVERIFIED — or null when it does not read as one. Never throws. */
export function peekJoinCode(s: string): { hostId: string; label: string } | null {
  if (!isJoinCode(s)) return null
  try {
    const b64 = s.trim().slice(JOIN_CODE_PREFIX.length).replace(/-/g, '+').replace(/_/g, '/')
    if (!b64) return null
    const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4))
    const o = JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)))) as unknown
    if (!o || typeof o !== 'object' || Array.isArray(o)) return null
    const r = o as Record<string, unknown>
    if (typeof r.hostId !== 'string' || !r.hostId || r.hostId.length > HOST_ID_MAX) return null
    return { hostId: r.hostId, label: typeof r.label === 'string' ? r.label : '' }
  } catch {
    return null
  }
}
