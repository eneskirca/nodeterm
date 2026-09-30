// src/core/relay/join-token.test.ts
import { describe, it, expect } from 'vitest'
import { mintDeviceToken, mintJoinToken } from './join-token'

const code = { v: 1 as const, relayEndpoint: 'wss://r', hostId: 'H', hostPublicKeyB64: 'K', hostDeviceId: 'HD', label: 'box' }

/** A fetch that answers `status` + `body` and records what it was asked. */
function fake(status: number, body: unknown) {
  const calls: Array<{ url: string; method?: string; body: unknown }> = []
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, method: init.method, body: JSON.parse(String(init.body)) })
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })
  }) as unknown as typeof fetch
  return { f, calls }
}
const throwing = (async () => { throw new Error('ECONNRESET') }) as unknown as typeof fetch

describe('joiner tokens', () => {
  it('device mint sends exactly the free-tier body to <apiBase>/v1/relay/device', async () => {
    const { f, calls } = fake(200, { deviceToken: 'DT', hostId: 'H', exp: 1 })
    expect(await mintDeviceToken({ apiBase: 'https://api/', deviceId: 'me', code, label: 'laptop', fetch: f }))
      .toEqual({ ok: true, deviceToken: 'DT' })
    expect(calls).toEqual([{
      url: 'https://api/v1/relay/device',
      method: 'POST',
      body: { deviceId: 'me', hostDeviceId: 'HD', hostPublicKeyB64: 'K', label: 'laptop' }
    }])
  })

  it('device mint: 429 is rate-limited, a 4xx is refused, 5xx and a throw are network, a bad body is refused', async () => {
    const mint = (f: typeof fetch) => mintDeviceToken({ apiBase: 'a', deviceId: 'me', code, label: 'l', fetch: f })
    expect(await mint(fake(429, { error: 'rate_limited' }).f)).toEqual({ ok: false, kind: 'rate-limited' })
    expect(await mint(fake(403, { error: 'reauth_required' }).f)).toEqual({ ok: false, kind: 'refused' })
    expect(await mint(fake(402, { error: 'not_entitled' }).f)).toEqual({ ok: false, kind: 'refused' })
    expect(await mint(fake(503, 'bad gateway').f)).toEqual({ ok: false, kind: 'network' })
    expect(await mint(throwing)).toEqual({ ok: false, kind: 'network' })
    expect(await mint(fake(200, 'not json').f)).toEqual({ ok: false, kind: 'refused' })
    expect(await mint(fake(200, { deviceToken: '' }).f)).toEqual({ ok: false, kind: 'refused' })
  })

  it('join posts {deviceToken} and maps 401 → bad-token and 403 → revoked', async () => {
    const ok = fake(200, { pairingToken: 'P', hostId: 'H', relayEndpoint: 'wss://r', exp: 1 })
    expect(await mintJoinToken({ apiBase: 'https://api', deviceToken: 'x', fetch: ok.f }))
      .toEqual({ ok: true, pairingToken: 'P', relayEndpoint: 'wss://r' })
    expect(ok.calls).toEqual([{ url: 'https://api/v1/relay/join', method: 'POST', body: { deviceToken: 'x' } }])
    expect(await mintJoinToken({ apiBase: 'a', deviceToken: 'x', fetch: fake(401, {}).f })).toEqual({ ok: false, kind: 'bad-token' })
    expect(await mintJoinToken({ apiBase: 'a', deviceToken: 'x', fetch: fake(403, {}).f })).toEqual({ ok: false, kind: 'revoked' })
  })

  // The backend's two 429s (nodeterm-server). The PER-IP limiter — `rateLimit({ windowMs: 60_000,
  // max: 30 })`, src/routes/relay.ts:104, shared by /device, /join and /host-token — answers
  // `{ error: 'rate_limited', scope: 'ip' }` (src/lib/rate-limit.ts:77) with no Retry-After, and
  // clears within a minute. The free device-mint DAMPER on /device is the one daily limit, and it
  // answers `{ error: 'rate_limited' }` with no `scope`. /join has no daily limit at all.
  const IP_429 = { error: 'rate_limited', scope: 'ip' }
  const DAILY_429 = { error: 'rate_limited' }

  it('R41: device — the per-IP 429 is `throttled` (retry in a minute); the damper\'s 429 is `rate-limited` (tomorrow)', async () => {
    const mint = (f: typeof fetch) => mintDeviceToken({ apiBase: 'a', deviceId: 'd', code, label: 'l', fetch: f })
    expect(await mint(fake(429, IP_429).f)).toEqual({ ok: false, kind: 'throttled' })
    expect(await mint(fake(429, DAILY_429).f)).toEqual({ ok: false, kind: 'rate-limited' })
    // A body that does not parse is the damper's answer on /device: never a retry that could spend mints.
    expect(await mint(fake(429, 'not json').f)).toEqual({ ok: false, kind: 'rate-limited' })
  })

  it('R41: join — every 429 is `throttled`: /join has no daily limit', async () => {
    const join = (f: typeof fetch) => mintJoinToken({ apiBase: 'a', deviceToken: 'x', fetch: f })
    expect(await join(fake(429, IP_429).f)).toEqual({ ok: false, kind: 'throttled' })
    expect(await join(fake(429, DAILY_429).f)).toEqual({ ok: false, kind: 'throttled' })
    expect(await join(fake(429, 'not json').f)).toEqual({ ok: false, kind: 'throttled' })
  })

  it('R41: a Retry-After, when the service sends one, rides the throttle', async () => {
    const withHeader = (async () =>
      new Response(JSON.stringify(IP_429), { status: 429, headers: { 'retry-after': '90' } })) as unknown as typeof fetch
    expect(await mintJoinToken({ apiBase: 'a', deviceToken: 'x', fetch: withHeader })).toEqual({ ok: false, kind: 'throttled', retryAfterMs: 90_000 })
    expect(await mintDeviceToken({ apiBase: 'a', deviceId: 'd', code, label: 'l', fetch: withHeader })).toEqual({ ok: false, kind: 'throttled', retryAfterMs: 90_000 })
  })

  it('join: any other failure is network, never a token verdict', async () => {
    const join = (f: typeof fetch) => mintJoinToken({ apiBase: 'a', deviceToken: 'x', fetch: f })
    expect(await join(fake(500, {}).f)).toEqual({ ok: false, kind: 'network' })
    expect(await join(fake(503, {}).f)).toEqual({ ok: false, kind: 'network' })
    expect(await join(throwing)).toEqual({ ok: false, kind: 'network' })
    expect(await join(fake(200, 'nope').f)).toEqual({ ok: false, kind: 'network' })
    expect(await join(fake(200, { pairingToken: 'P' }).f)).toEqual({ ok: false, kind: 'network' })
    expect(await join(fake(200, { pairingToken: '', relayEndpoint: 'wss://r' }).f)).toEqual({ ok: false, kind: 'network' })
  })

  it('the timeout covers a body that never finishes', async () => {
    const stalled = (async (_u: string, init: RequestInit) => ({
      ok: true,
      status: 200,
      json: () => new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')))
      })
    })) as unknown as typeof fetch
    expect(await mintJoinToken({ apiBase: 'a', deviceToken: 'x', fetch: stalled, timeoutMs: 20 })).toEqual({ ok: false, kind: 'network' })
    expect(await mintDeviceToken({ apiBase: 'a', deviceId: 'me', code, label: 'l', fetch: stalled, timeoutMs: 20 }))
      .toEqual({ ok: false, kind: 'network' })
  })
})
