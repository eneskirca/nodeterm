// HTTP client for the live-link routes (nodeterm-server, Plan 1). Credentials ride the JSON body
// over TLS, never argv. Every call is bounded by a timeout that also covers the body read.
import { tokenTtlMs, type MintResult } from '../relay/host-token'
import { LINK_ID_RE } from '../../shared/watch-link/link'

export type CreateError = 'not-entitled' | 'limit-active' | 'limit-daily' | 'rate-limited' | 'license-check' | 'bad-request' | 'network'
export type HostTokenResult = MintResult | { ok: false; kind: 'gone'; reason: 'revoked' | 'expired' }
export interface WatchLinkApi {
  create(entitlement: string, joinKeyHash: string, ttlSeconds: number): Promise<{ ok: true; linkId: string; expiresAt: number } | { ok: false; error: CreateError }>
  hostToken(linkId: string, entitlement: string): Promise<HostTokenResult>
  status(linkId: string, entitlement: string): Promise<'live' | 'revoked' | 'expired' | 'unknown'>
  revoke(linkId: string, entitlement: string): Promise<boolean>
  revokeAll(entitlement: string): Promise<boolean>
}

interface Reply {
  status: number
  /** The parsed body when it is a JSON object; null for 204, an empty or non-JSON body, or any other JSON value. */
  json: Record<string, unknown> | null
  date: string | null
  retryAfter: string | null
}

/** The longest wait a Retry-After may impose. Our limiters do not count a refused request, so asking
 *  again early is cheap, while an unbounded header (a proxy's `86400`) would park a link's host for
 *  longer than the link lives. */
const RETRY_AFTER_MAX_S = 3600

/** Retry-After as RFC 9110 delay-seconds only, clamped. Anything else (an HTTP-date, `1e9`,
 *  `Infinity`, `0x10`, `0.5`, empty, 0) is no answer: the scheduler's own floor applies. */
function retryAfterMs(header: string | null): number | undefined {
  if (header === null || !/^\d+$/.test(header)) return undefined
  const s = Number(header)
  return s > 0 ? Math.min(s, RETRY_AFTER_MAX_S) * 1000 : undefined
}

export function createWatchLinkApi(o: { apiBase: string; fetch?: typeof fetch; now?: () => number; timeoutMs?: number }): WatchLinkApi {
  const base = o.apiBase.replace(/\/+$/, '')
  const now = o.now ?? Date.now
  const f = o.fetch ?? fetch

  /** One POST. null = no answer (the request failed, or the body did not arrive whole, timeout included). */
  async function post(path: string, body: unknown): Promise<Reply | null> {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), o.timeoutMs ?? 8000)
    try {
      const r = await f(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctrl.signal,
        // A 307/308 would re-send this body, entitlement included, to wherever Location points. None
        // of these routes redirects, so a redirect is an error rather than a hop.
        redirect: 'error'
      })
      let json: Record<string, unknown> | null = null
      if (r.status !== 204) {
        // Reading and parsing are two different failures. A read that throws (a reset mid-body, the
        // timeout's abort) is the network's: the outer catch turns it into "no answer". A body that
        // arrived whole but is not a JSON object is the server's: json stays null.
        const text = await r.text()
        try {
          const v: unknown = JSON.parse(text)
          json = v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
        } catch {
          json = null
        }
      }
      return { status: r.status, json, date: r.headers.get('date'), retryAfter: r.headers.get('retry-after') }
    } catch {
      return null
    } finally {
      clearTimeout(timer)
    }
  }
  const path = (id: string, verb: string) => `/v1/watch-links/${encodeURIComponent(id)}/${verb}`

  return {
    async create(entitlement, joinKeyHash, ttlSeconds) {
      const r = await post('/v1/watch-links', { entitlement, joinKeyHash, ttlSeconds })
      if (!r) return { ok: false, error: 'network' }
      const exp = r.json?.expiresAt
      // A link always ends in the future; 0, a negative or a non-finite instant is a malformed reply,
      // and tokenTtlMs would turn it into its two-minute HOST-TOKEN default (a link that "expires" in
      // 2 minutes while its server row stays live and counts against the active-link cap). A link id
      // the URL could not carry (`formatWatchLink` refuses it, and the store would drop the record at
      // the next boot) is malformed too.
      const linkId = r.json?.linkId
      if (r.status === 200 && typeof linkId === 'string' && LINK_ID_RE.test(linkId) && typeof exp === 'number' && Number.isFinite(exp) && exp > 0) {
        // `expiresAt` is an instant on the SERVER's clock; the Date header turns it into time left,
        // which is then anchored on this machine's clock (see tokenTtlMs).
        const t = now()
        return { ok: true, linkId, expiresAt: t + tokenTtlMs(exp, r.date, t) }
      }
      if (r.status === 402 || r.status === 403) return { ok: false, error: 'not-entitled' }
      if (r.status === 429) {
        const scope = r.json?.scope
        return { ok: false, error: scope === 'active_links' ? 'limit-active' : scope === 'license' ? 'limit-daily' : 'rate-limited' }
      }
      if (r.status === 503) return { ok: false, error: 'license-check' }
      if (r.status === 400) return { ok: false, error: 'bad-request' }
      return { ok: false, error: 'network' }
    },
    async hostToken(linkId, entitlement) {
      const r = await post(path(linkId, 'host-token'), { entitlement })
      if (!r) return { ok: false, kind: 'network' }
      if (r.status === 200) {
        // A 200 without a token is the server's fault, not the network's (same rule as mintHostToken).
        if (typeof r.json?.pairingToken !== 'string' || !r.json.pairingToken) return { ok: false, kind: 'bad-response', status: 200 }
        const exp = typeof r.json.exp === 'number' ? r.json.exp : 0
        return { ok: true, pairingToken: r.json.pairingToken, hostId: '', ttlMs: tokenTtlMs(exp, r.date, now()) }
      }
      if (r.status === 410) return { ok: false, kind: 'gone', reason: r.json?.reason === 'expired' ? 'expired' : 'revoked' }
      if (r.status === 429) {
        const ra = retryAfterMs(r.retryAfter)
        return { ok: false, kind: 'rate-limited', status: 429, ...(ra !== undefined ? { retryAfterMs: ra } : {}) }
      }
      // 400 is our own malformed request (the owner check's body validation): it can never succeed,
      // so it stops minting like the other refusals instead of being retried as a network failure.
      if (r.status === 400 || r.status === 402 || r.status === 403 || r.status === 404) return { ok: false, kind: 'refused', status: r.status }
      return { ok: false, kind: 'network', status: r.status }
    },
    async status(linkId, entitlement) {
      const r = await post(path(linkId, 'status'), { entitlement })
      const s = r?.status === 200 ? r.json?.state : null
      return s === 'live' || s === 'revoked' || s === 'expired' ? s : 'unknown'
    },
    async revoke(linkId, entitlement) {
      return (await post(path(linkId, 'revoke'), { entitlement }))?.status === 204
    },
    async revokeAll(entitlement) {
      return (await post('/v1/watch-links/revoke-all', { entitlement }))?.status === 204
    }
  }
}
