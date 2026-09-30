// Standing-host token mint for the Server Edition's hosted team relay. Mirrors the desktop's
// `mintHostToken` + `tokenTtlMs` in src/main/remote/standing-host.ts (see that file for the measured
// incidents: clock skew → 238 mints/hour, refused mints re-minted in a tight loop), minus Electron.
// It sends its deviceId, never an entitlement: relay access is free (CLAUDE.md, "Remote access …
// free, not Pro"), and the backend is the gate. When the backend supports it, the mint also carries
// a proof that this process holds the host's secret key (relay-pop.ts), so a join code alone can no
// longer mint this host's tokens. Only a challenge answered 404/405 means "this backend predates the
// proof" and gets the legacy two-field mint; any other challenge failure is transient.
//
// The desktop copy distinguishes only two outcomes: a key-proof refusal (`{ refused }` —
// `pop_invalid`, or `pop_required` on a proven mint), which stops phone access and tells the human
// once when it is the second in a row, and `null` for every other failure, which backs off and
// retries. This one says WHICH failure it was, because the scheduler reacts differently to each: a
// 429 waits at least a minute, a 402/403 stops minting (a key-proof refusal only on the second in a
// row — hosted-scheduler.ts counts), anything else backs off and retries. Both copies stay stateless
// and count their refusals in the caller. Both share one more rule: a 403 is
// deliberately NOT terminal when it is a `pop_required` answer to a mint sent WITHOUT a proof because
// the challenge said 404/405. A reverse proxy answers 404 while the backend redeploys, and the
// unproven mint that follows can land on the fresh backend, which requires a proof from a host it
// has seen prove before. Stopping there would stop hosting for good over a redeploy, so it backs off
// and the next attempt asks for a challenge again.
import { computePopProof, fetchPopChallenge, popRefusalOf, type PopRefusal } from './relay-pop'

export type MintResult =
  | { ok: true; pairingToken: string; hostId: string; ttlMs: number }
  | {
      ok: false
      kind: 'network' | 'rate-limited' | 'refused' | 'bad-response'
      retryAfterMs?: number
      status?: number
      /** Set only on a key-proof refusal (a `refused` 403). The caller counts them: the second in a
       *  row is terminal (see hosted-scheduler.ts). */
      reason?: PopRefusal
    }

const DEFAULT_TTL_MS = 120_000
const MINT_TIMEOUT_MS = 8000

/**
 * How long a freshly minted token has left, in ms.
 *
 * `exp` is an absolute instant (seconds) on the SERVER's clock. Subtracting the LOCAL clock from it
 * folds this machine's clock error into the answer: a clock 75 s fast leaves 120 − 75 = 45 s, minus
 * the 30 s refresh lead = the 15 s floor, so the host re-mints four times per TTL (relay log,
 * 2026-09-27: 238 mints/hour against a free limit of 240). The response's own `Date` header is the
 * server's clock at the instant it computed `exp`, so the difference is clock-independent. The
 * local clock is the fallback only when the header is missing or unparseable (a proxy stripped it).
 */
export function tokenTtlMs(exp: number, serverDate: string | null, localNowMs: number): number {
  if (!(exp > 0)) return DEFAULT_TTL_MS
  const serverNowMs = serverDate ? Date.parse(serverDate) : NaN
  return exp * 1000 - (Number.isFinite(serverNowMs) ? serverNowMs : localNowMs)
}

export async function mintHostToken(deps: {
  apiBase: string
  deviceId: string
  hostPublicKeyB64: string
  /**
   * The host's X25519 secret key, used only to prove possession (relay-pop.ts); it never leaves
   * this process. Absent = the legacy unproven mint: only tests and pre-proof call sites omit it.
   */
  hostSecretKey?: Uint8Array
  fetch?: typeof fetch
  now?: () => number
}): Promise<MintResult> {
  const f = deps.fetch ?? fetch
  const ctrl = new AbortController()
  // The timeout covers the BODY read too, not just the headers: a response whose body stalls would
  // otherwise leave this mint pending forever, and the scheduler runs one mint at a time.
  const timer = setTimeout(() => ctrl.abort(), MINT_TIMEOUT_MS)
  try {
    let proof: { popChallenge: string; popProof: string } | null = null
    // True only when a challenge was asked for and answered 404/405: the one case this mint goes out
    // unproven although we hold the key (see the header on what a 403 then means).
    let sentUnproven = false
    if (deps.hostSecretKey) {
      const ch = await fetchPopChallenge({
        apiBase: deps.apiBase,
        hostPublicKeyB64: deps.hostPublicKeyB64,
        purpose: 'host-token',
        fetch: f,
        signal: ctrl.signal
      })
      // Never an unproven mint after a transient failure: to a host the backend has seen prove
      // before, that mint is a 403 which would stop hosting. Back off and ask again.
      if (!ch.ok && !ch.unsupported) {
        // /challenge has its own per-IP limit, which several hosts behind one NAT share: take the
        // scheduler's 60 s floor rather than the short network backoff.
        if (ch.status === 429) return { ok: false, kind: 'rate-limited', status: 429 }
        // A 2xx that is not a usable challenge is the server's fault, unless the body read was cut
        // short by our own timeout.
        if (ch.status !== undefined && ch.status >= 200 && ch.status < 300) {
          return ctrl.signal.aborted ? { ok: false, kind: 'network' } : { ok: false, kind: 'bad-response' }
        }
        return { ok: false, kind: 'network', ...(ch.status ? { status: ch.status } : {}) }
      }
      if (!ch.ok && ch.unsupported) sentUnproven = true
      if (ch.ok) {
        try {
          proof = {
            popChallenge: ch.challenge,
            popProof: computePopProof({
              hostSecretKey: deps.hostSecretKey,
              hostPublicKeyB64: deps.hostPublicKeyB64,
              challenge: ch.challenge,
              serverPublicKeyB64: ch.serverPublicKeyB64,
              purpose: 'host-token',
              subject: deps.deviceId
            })
          }
        } catch {
          // A server key the proof cannot use (malformed, or low-order): the server's fault.
          return { ok: false, kind: 'bad-response' }
        }
      }
    }
    let res: Response
    try {
      res = await f(`${deps.apiBase.replace(/\/+$/, '')}/v1/relay/host-token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // deviceId + host key, plus the key proof when the backend issued a challenge (relay-pop.ts).
        // The two-field form is what a pre-PoP backend was verified against.
        body: JSON.stringify({ deviceId: deps.deviceId, hostPublicKeyB64: deps.hostPublicKeyB64, ...(proof ?? {}) }),
        signal: ctrl.signal
      })
    } catch {
      return { ok: false, kind: 'network' }
    }
    if (res.status === 429) {
      // Seconds only. An HTTP-date Retry-After (or none) falls to the scheduler's 60 s floor.
      const ra = Number(res.headers.get('retry-after'))
      return { ok: false, kind: 'rate-limited', status: 429, ...(ra > 0 ? { retryAfterMs: ra * 1000 } : {}) }
    }
    if (res.status === 402 || res.status === 403) {
      const reason = res.status === 403 ? popRefusalOf(403, await res.json().catch(() => null)) : null
      // The challenge said 404/405 and this mint went out unproven: a pop_required here is a backend
      // that came back mid-redeploy (see the header), so it is transient, not a refusal.
      if (reason === 'pop_required' && sentUnproven) return { ok: false, kind: 'network', status: 403 }
      return { ok: false, kind: 'refused', status: res.status, ...(reason ? { reason } : {}) }
    }
    if (!res.ok) return { ok: false, kind: 'network', status: res.status }
    let json: { pairingToken?: unknown; hostId?: unknown; exp?: unknown } | null
    try {
      json = (await res.json()) as typeof json
    } catch {
      // Aborted mid-body is a timeout (network); a body that is not JSON is the server's fault.
      return ctrl.signal.aborted ? { ok: false, kind: 'network' } : { ok: false, kind: 'bad-response' }
    }
    if (!json || typeof json.pairingToken !== 'string' || !json.pairingToken) return { ok: false, kind: 'bad-response' }
    const exp = typeof json.exp === 'number' ? json.exp : 0
    return {
      ok: true,
      pairingToken: json.pairingToken,
      hostId: typeof json.hostId === 'string' ? json.hostId : '',
      ttlMs: tokenTtlMs(exp, res.headers.get('date'), (deps.now ?? Date.now)())
    }
  } finally {
    clearTimeout(timer)
  }
}
