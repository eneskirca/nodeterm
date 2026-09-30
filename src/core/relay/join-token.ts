// The joiner's two API legs: the phone's relay flow, for a desktop joining a hosted team.
//   1. `POST /v1/relay/device {deviceId, hostDeviceId, hostPublicKeyB64, label}` → a device token
//      for THIS device and THAT host (about 90 days). Free-tier mints are damped server-side
//      (a few per day), so the caller keeps the token and never mints in a loop.
//   2. `POST /v1/relay/join {deviceToken}` → a short-lived client pairing token and the relay to use.
// Neither leg grants anything on its own: the host still decides who gets in.
//
// Each result says WHICH failure it was, because the caller reacts differently to each: only a
// `bad-token` join earns one fresh device mint, a `revoked` one never does, and the two 429s mean
// different things (the backend is nodeterm-server):
//  - `throttled`: the PER-IP limiter — `rateLimit({ windowMs: 60_000, max: 30 })`,
//    src/routes/relay.ts:104, shared by /device, /join and /host-token — whose body is
//    `{ error: 'rate_limited', scope: 'ip' }` (src/lib/rate-limit.ts:77), sent with no Retry-After.
//    It clears within a minute; a desktop behind an office NAT can hit it. Retried, once a minute.
//  - `rate-limited`: the free device-mint DAMPER on /device, the one DAILY limit — the same error
//    with no `scope`. Waiting for tomorrow, never retried. /join has no daily limit, so every /join
//    429 is `throttled`; a /device 429 whose body cannot be read is taken as the damper's.
import type { JoinCode } from './join-code'

const TIMEOUT_MS = 8000

/** The per-network limiter said to slow down; `retryAfterMs` only when it named a Retry-After. */
export type ThrottledResult = { ok: false; kind: 'throttled'; retryAfterMs?: number }
export type DeviceMintResult =
  | { ok: true; deviceToken: string }
  | { ok: false; kind: 'network' | 'refused' | 'rate-limited' }
  | ThrottledResult
export type JoinMintResult =
  | { ok: true; pairingToken: string; relayEndpoint: string }
  | { ok: false; kind: 'bad-token' | 'revoked' | 'network' }
  | ThrottledResult

/** A reply: its status, its parsed JSON body (`null` when the body is not JSON) and its Retry-After
 *  in ms (`null` when absent or not a number of seconds). */
interface Reply { status: number; ok: boolean; body: unknown; retryAfterMs: number | null }

/** The per-IP limiter's 429 body names its scope; the device damper's does not. */
function ipScoped(body: unknown): boolean {
  return !!body && typeof body === 'object' && (body as { scope?: unknown }).scope === 'ip'
}

function throttled(res: Reply): ThrottledResult {
  return res.retryAfterMs !== null ? { ok: false, kind: 'throttled', retryAfterMs: res.retryAfterMs } : { ok: false, kind: 'throttled' }
}

/** POST `body` and read the JSON reply under ONE timeout that covers the body too: a reply whose
 *  body stalls would otherwise leave the join pending forever. `null` = no usable response (the
 *  request failed, or the timeout cut it short), which is the network's fault either way. */
async function post(apiBase: string, p: string, body: unknown, f: typeof fetch, timeoutMs: number): Promise<Reply | null> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await f(`${apiBase.replace(/\/+$/, '')}${p}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal
    })
    let parsed: unknown = null
    try {
      parsed = await res.json()
    } catch {
      if (ctrl.signal.aborted) return null
    }
    const ra = res.headers?.get?.('retry-after')
    const retryAfterMs = ra && /^\d+$/.test(ra.trim()) ? Number(ra.trim()) * 1000 : null
    return { status: res.status, ok: res.ok, body: parsed, retryAfterMs }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

export async function mintDeviceToken(d: {
  apiBase: string
  deviceId: string
  code: JoinCode
  label: string
  fetch?: typeof fetch
  timeoutMs?: number
}): Promise<DeviceMintResult> {
  const res = await post(
    d.apiBase,
    '/v1/relay/device',
    // EXACTLY these four fields: the free-tier body the production endpoint was verified against.
    { deviceId: d.deviceId, hostDeviceId: d.code.hostDeviceId, hostPublicKeyB64: d.code.hostPublicKeyB64, label: d.label },
    d.fetch ?? fetch,
    d.timeoutMs ?? TIMEOUT_MS
  )
  if (!res) return { ok: false, kind: 'network' }
  if (res.status === 429) return ipScoped(res.body) ? throttled(res) : { ok: false, kind: 'rate-limited' }
  // A 5xx is the service being down, not a verdict on this device.
  if (res.status >= 500) return { ok: false, kind: 'network' }
  if (!res.ok) return { ok: false, kind: 'refused' }
  const token = (res.body as { deviceToken?: unknown } | null)?.deviceToken
  return typeof token === 'string' && token ? { ok: true, deviceToken: token } : { ok: false, kind: 'refused' }
}

export async function mintJoinToken(d: {
  apiBase: string
  deviceToken: string
  fetch?: typeof fetch
  timeoutMs?: number
}): Promise<JoinMintResult> {
  const res = await post(d.apiBase, '/v1/relay/join', { deviceToken: d.deviceToken }, d.fetch ?? fetch, d.timeoutMs ?? TIMEOUT_MS)
  if (!res) return { ok: false, kind: 'network' }
  // 401 = the token did not verify (expired, or never ours); 403 = the device row is revoked.
  // Everything else says nothing about the token, so it must not cost a device mint.
  if (res.status === 401) return { ok: false, kind: 'bad-token' }
  if (res.status === 403) return { ok: false, kind: 'revoked' }
  // /join has no daily limit: its 429 is always the per-network limiter (see the header).
  if (res.status === 429) return throttled(res)
  if (!res.ok) return { ok: false, kind: 'network' }
  const j = res.body as { pairingToken?: unknown; relayEndpoint?: unknown } | null
  if (typeof j?.pairingToken !== 'string' || !j.pairingToken || typeof j.relayEndpoint !== 'string' || !j.relayEndpoint) {
    return { ok: false, kind: 'network' }
  }
  return { ok: true, pairingToken: j.pairingToken, relayEndpoint: j.relayEndpoint }
}
