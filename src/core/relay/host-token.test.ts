// src/core/relay/host-token.test.ts
import { describe, it, expect, vi, afterEach } from 'vitest'
import nacl from 'tweetnacl'
import { mintHostToken, tokenTtlMs } from './host-token'
import { createTestPopServer } from './relay-pop.test-server'

const res = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  ({ ok: status >= 200 && status < 300, status, headers: new Headers(headers), json: async () => body, text: async () => JSON.stringify(body) }) as Response

afterEach(() => {
  vi.useRealTimers()
})

describe('host token', () => {
  it('sends deviceId + host key and measures TTL on the server clock', async () => {
    let sent: unknown
    const urls: string[] = []
    const r = await mintHostToken({
      apiBase: 'https://api', deviceId: 'd', hostPublicKeyB64: 'K',
      fetch: (async (u: string, init: RequestInit) => { urls.push(u); sent = JSON.parse(String(init.body)); return res(200, { pairingToken: 'T', hostId: 'H', exp: 1_000_120 }, { date: new Date(1_000_000_000).toUTCString() }) }) as typeof fetch,
      now: () => 999_000_000 // local clock 1000 s behind: must not matter
    })
    // No hostSecretKey = the legacy mode: one call, never a challenge.
    expect(urls.some((u) => u.endsWith('/challenge'))).toBe(false)
    expect(sent).toEqual({ deviceId: 'd', hostPublicKeyB64: 'K' })
    expect(r).toEqual({ ok: true, pairingToken: 'T', hostId: 'H', ttlMs: 120_000 })
  })
  it('429 carries Retry-After; 402 is refused; network throws are network', async () => {
    const f = (r: Response) => (async () => r) as unknown as typeof fetch
    expect(await mintHostToken({ apiBase: 'a', deviceId: 'd', hostPublicKeyB64: 'k', fetch: f(res(429, {}, { 'retry-after': '90' })) }))
      .toMatchObject({ ok: false, kind: 'rate-limited', retryAfterMs: 90_000 })
    expect(await mintHostToken({ apiBase: 'a', deviceId: 'd', hostPublicKeyB64: 'k', fetch: f(res(402, { error: 'not_entitled' })) }))
      .toMatchObject({ ok: false, kind: 'refused', status: 402 })
    expect(await mintHostToken({ apiBase: 'a', deviceId: 'd', hostPublicKeyB64: 'k', fetch: (async () => { throw new Error('x') }) as unknown as typeof fetch }))
      .toMatchObject({ ok: false, kind: 'network' })
  })
  it('tokenTtlMs falls back to the local clock without a Date header', () => {
    expect(tokenTtlMs(100, null, 40_000)).toBe(60_000)
    expect(tokenTtlMs(0, null, 0)).toBe(120_000)
  })

  it('posts to <apiBase>/v1/relay/host-token, tolerating a trailing slash on the base', async () => {
    const urls: string[] = []
    const methods: Array<string | undefined> = []
    const f = (async (u: string, init: RequestInit) => {
      urls.push(u)
      methods.push(init.method)
      return res(200, { pairingToken: 'T', hostId: 'H', exp: 0 })
    }) as unknown as typeof fetch
    await mintHostToken({ apiBase: 'https://api.example/', deviceId: 'd', hostPublicKeyB64: 'k', fetch: f })
    await mintHostToken({ apiBase: 'https://api.example', deviceId: 'd', hostPublicKeyB64: 'k', fetch: f })
    expect(urls).toEqual(['https://api.example/v1/relay/host-token', 'https://api.example/v1/relay/host-token'])
    expect(methods).toEqual(['POST', 'POST'])
  })

  it('403 is refused; any other non-2xx is network with its status; a 429 without Retry-After has no retryAfterMs', async () => {
    const f = (r: Response) => (async () => r) as unknown as typeof fetch
    expect(await mintHostToken({ apiBase: 'a', deviceId: 'd', hostPublicKeyB64: 'k', fetch: f(res(403, {})) }))
      .toMatchObject({ ok: false, kind: 'refused', status: 403 })
    expect(await mintHostToken({ apiBase: 'a', deviceId: 'd', hostPublicKeyB64: 'k', fetch: f(res(503, {})) }))
      .toEqual({ ok: false, kind: 'network', status: 503 })
    expect(await mintHostToken({ apiBase: 'a', deviceId: 'd', hostPublicKeyB64: 'k', fetch: f(res(429, {})) }))
      .toEqual({ ok: false, kind: 'rate-limited', status: 429 })
  })

  it('a 200 without a usable token or with an unparseable body is bad-response', async () => {
    const f = (r: Response) => (async () => r) as unknown as typeof fetch
    expect(await mintHostToken({ apiBase: 'a', deviceId: 'd', hostPublicKeyB64: 'k', fetch: f(res(200, { hostId: 'H', exp: 1 })) }))
      .toEqual({ ok: false, kind: 'bad-response' })
    expect(await mintHostToken({ apiBase: 'a', deviceId: 'd', hostPublicKeyB64: 'k', fetch: f(res(200, { pairingToken: '' })) }))
      .toEqual({ ok: false, kind: 'bad-response' })
    const broken = { ...res(200, null), json: async () => { throw new SyntaxError('Unexpected token <') } } as Response
    expect(await mintHostToken({ apiBase: 'a', deviceId: 'd', hostPublicKeyB64: 'k', fetch: f(broken) }))
      .toEqual({ ok: false, kind: 'bad-response' })
  })

  it('the 8 s timeout also covers a body that stalls after the headers arrived', async () => {
    // A body read outside the abort window would leave the mint pending forever, and the scheduler
    // (which runs one mint at a time) would never mint again.
    vi.useFakeTimers()
    const f = (async (_u: string, init: RequestInit) => ({
      ...res(200, null),
      json: () => new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      })
    }) as Response) as unknown as typeof fetch
    const p = mintHostToken({ apiBase: 'a', deviceId: 'd', hostPublicKeyB64: 'k', fetch: f })
    let settled: unknown = 'pending'
    void p.then((r) => { settled = r })
    await vi.advanceTimersByTimeAsync(7_999)
    expect(settled).toBe('pending')
    await vi.advanceTimersByTimeAsync(1)
    expect(settled).toEqual({ ok: false, kind: 'network' })
  })
})

// --- proof of possession (relay-pop.ts): a real key pair against a byte-exact mirror of the backend ---
const keys = nacl.box.keyPair()
const PUB = Buffer.from(keys.publicKey).toString('base64')

function api(s = createTestPopServer(), over: { challenge?: (() => Response) | null; mint?: (body: Record<string, unknown>) => Response } = {}) {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = []
  const f = (async (u: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>
    calls.push({ url: u, body })
    if (u.endsWith('/v1/relay/challenge')) {
      if (over.challenge === null) return res(404, {})
      if (over.challenge) return over.challenge()
      return res(200, s.issue(body.hostPublicKeyB64 as string, body.purpose as 'host-token'))
    }
    if (over.mint) return over.mint(body)
    const valid = s.verify({ hostPublicKeyB64: body.hostPublicKeyB64 as string, purpose: 'host-token', subject: String(body.deviceId ?? ''), popChallenge: body.popChallenge, popProof: body.popProof })
    return valid ? res(200, { pairingToken: 'T', hostId: 'H', exp: 0 }) : res(403, { error: 'pop_invalid' })
  }) as typeof fetch
  return { f, calls }
}

describe('host token proof of possession', () => {
  it('proves possession: challenge first, then a mint the backend verifies', async () => {
    const { f, calls } = api()
    const r = await mintHostToken({ apiBase: 'https://api', deviceId: 'd', hostPublicKeyB64: PUB, hostSecretKey: keys.secretKey, fetch: f })
    expect(r.ok).toBe(true)
    expect(calls.map((c) => c.url)).toEqual(['https://api/v1/relay/challenge', 'https://api/v1/relay/host-token'])
    expect(Object.keys(calls[1].body).sort()).toEqual(['deviceId', 'hostPublicKeyB64', 'popChallenge', 'popProof'])
  })
  it('an old backend (challenge 404) gets the legacy two-field body', async () => {
    const { f, calls } = api(undefined, { challenge: null })
    await mintHostToken({ apiBase: 'https://api', deviceId: 'd', hostPublicKeyB64: PUB, hostSecretKey: keys.secretKey, fetch: f })
    expect(calls[1].body).toEqual({ deviceId: 'd', hostPublicKeyB64: PUB })
  })
  it('a transient challenge failure sends NO unproven mint', async () => {
    const { f, calls } = api(undefined, { challenge: () => res(503, {}) })
    const r = await mintHostToken({ apiBase: 'https://api', deviceId: 'd', hostPublicKeyB64: PUB, hostSecretKey: keys.secretKey, fetch: f })
    expect(r).toEqual({ ok: false, kind: 'network', status: 503 })
    expect(calls).toHaveLength(1)
  })
  it('a 403 PoP refusal carries its reason', async () => {
    const { f } = api(undefined, { mint: () => res(403, { error: 'pop_required' }) })
    const r = await mintHostToken({ apiBase: 'https://api', deviceId: 'd', hostPublicKeyB64: PUB, hostSecretKey: keys.secretKey, fetch: f })
    expect(r).toEqual({ ok: false, kind: 'refused', status: 403, reason: 'pop_required' })
  })

  // --- beyond the brief ---

  it('a pop_required answer to an UNPROVEN mint (challenge 404) is transient, not a refusal', async () => {
    // A reverse proxy answers 404 while the backend redeploys; the legacy mint that follows can land on
    // the fresh backend, which requires a proof from a latched host. Stopping here would stop hosting
    // for good over a redeploy: back off, and the next attempt fetches a fresh challenge.
    const { f, calls } = api(undefined, { challenge: null, mint: () => res(403, { error: 'pop_required' }) })
    const r = await mintHostToken({ apiBase: 'https://api', deviceId: 'd', hostPublicKeyB64: PUB, hostSecretKey: keys.secretKey, fetch: f })
    expect(r).toEqual({ ok: false, kind: 'network', status: 403 })
    expect(calls[1].body).toEqual({ deviceId: 'd', hostPublicKeyB64: PUB })
  })
  it('pop_invalid is terminal, proven or not', async () => {
    const proven = api(undefined, { mint: () => res(403, { error: 'pop_invalid' }) })
    expect(await mintHostToken({ apiBase: 'https://api', deviceId: 'd', hostPublicKeyB64: PUB, hostSecretKey: keys.secretKey, fetch: proven.f }))
      .toEqual({ ok: false, kind: 'refused', status: 403, reason: 'pop_invalid' })
    const unproven = api(undefined, { challenge: null, mint: () => res(403, { error: 'pop_invalid' }) })
    expect(await mintHostToken({ apiBase: 'https://api', deviceId: 'd', hostPublicKeyB64: PUB, hostSecretKey: keys.secretKey, fetch: unproven.f }))
      .toEqual({ ok: false, kind: 'refused', status: 403, reason: 'pop_invalid' })
  })
  it('a pop_required answer to an UNPROVEN mint after a 405 challenge is transient too', async () => {
    const { f, calls } = api(undefined, { challenge: () => res(405, {}), mint: () => res(403, { error: 'pop_required' }) })
    const r = await mintHostToken({ apiBase: 'https://api', deviceId: 'd', hostPublicKeyB64: PUB, hostSecretKey: keys.secretKey, fetch: f })
    expect(r).toEqual({ ok: false, kind: 'network', status: 403 })
    expect(calls[1].body).toEqual({ deviceId: 'd', hostPublicKeyB64: PUB })
  })
  it('a 405 challenge is an old backend too; any other challenge failure is transient and sends nothing', async () => {
    const old = api(undefined, { challenge: () => res(405, {}) })
    await mintHostToken({ apiBase: 'https://api', deviceId: 'd', hostPublicKeyB64: PUB, hostSecretKey: keys.secretKey, fetch: old.f })
    expect(old.calls.map((c) => c.url)).toEqual(['https://api/v1/relay/challenge', 'https://api/v1/relay/host-token'])
    expect(old.calls[1].body).toEqual({ deviceId: 'd', hostPublicKeyB64: PUB })
    for (const challenge of [() => res(403, { error: 'pop_invalid' }), () => res(502, {}), () => { throw new Error('ECONNRESET') }]) {
      const t = api(undefined, { challenge })
      const r = await mintHostToken({ apiBase: 'https://api', deviceId: 'd', hostPublicKeyB64: PUB, hostSecretKey: keys.secretKey, fetch: t.f })
      expect(r).toMatchObject({ ok: false, kind: 'network' })
      expect(t.calls).toHaveLength(1)
    }
  })
  it('a rate-limited challenge (429) is rate-limited, so the scheduler waits its 60 s floor, and sends nothing', async () => {
    // Several hosts behind one NAT share /challenge's per-IP limit.
    const { f, calls } = api(undefined, { challenge: () => res(429, {}) })
    const r = await mintHostToken({ apiBase: 'https://api', deviceId: 'd', hostPublicKeyB64: PUB, hostSecretKey: keys.secretKey, fetch: f })
    expect(r).toEqual({ ok: false, kind: 'rate-limited', status: 429 })
    expect(calls).toHaveLength(1)
  })
  it('a 2xx challenge the host cannot use is bad-response, not network, and sends nothing', async () => {
    for (const body of [{ challenge: 1, serverPublicKeyB64: 'x' }, { pairingToken: 'T' }, null]) {
      const { f, calls } = api(undefined, { challenge: () => res(200, body) })
      const r = await mintHostToken({ apiBase: 'https://api', deviceId: 'd', hostPublicKeyB64: PUB, hostSecretKey: keys.secretKey, fetch: f })
      expect(r).toEqual({ ok: false, kind: 'bad-response' })
      expect(calls).toHaveLength(1)
    }
    const broken = { ...res(200, null), json: async () => { throw new SyntaxError('Unexpected token <') } } as Response
    const t = api(undefined, { challenge: () => broken })
    expect(await mintHostToken({ apiBase: 'https://api', deviceId: 'd', hostPublicKeyB64: PUB, hostSecretKey: keys.secretKey, fetch: t.f }))
      .toEqual({ ok: false, kind: 'bad-response' })
  })
  it('a challenge body that stalls until the 8 s timeout is network (a timeout), not bad-response, and mints nothing', async () => {
    vi.useFakeTimers()
    // The URL list is the guard: a mint that slipped through would ALSO read as network (this fake
    // throws on it, and so would a real fetch on the already-aborted signal), so the result alone
    // cannot tell "no mint" from "a mint that failed".
    const urls: string[] = []
    const f = (async (u: string, init: RequestInit) => {
      urls.push(u)
      if (!u.endsWith('/v1/relay/challenge')) throw new Error('no mint may follow')
      return {
        ...res(200, null),
        json: () => new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
        })
      } as Response
    }) as unknown as typeof fetch
    const p = mintHostToken({ apiBase: 'https://api', deviceId: 'd', hostPublicKeyB64: PUB, hostSecretKey: keys.secretKey, fetch: f })
    let settled: unknown = 'pending'
    void p.then((r) => { settled = r })
    await vi.advanceTimersByTimeAsync(8_000)
    expect(settled).toEqual({ ok: false, kind: 'network' })
    expect(urls).toEqual(['https://api/v1/relay/challenge'])
  })
  it('a proof that cannot be computed (a low-order server key) is bad-response and sends no mint', async () => {
    const { f, calls } = api(undefined, { challenge: () => res(200, { challenge: 'c.s', serverPublicKeyB64: Buffer.alloc(32).toString('base64') }) })
    const r = await mintHostToken({ apiBase: 'https://api', deviceId: 'd', hostPublicKeyB64: PUB, hostSecretKey: keys.secretKey, fetch: f })
    expect(r).toEqual({ ok: false, kind: 'bad-response' })
    expect(calls).toHaveLength(1)
  })
  it('the proof binds the deviceId: the backend refuses it for another subject', async () => {
    const s = createTestPopServer()
    const { f, calls } = api(s, { mint: () => res(200, { pairingToken: 'T', hostId: 'H', exp: 0 }) })
    await mintHostToken({ apiBase: 'https://api', deviceId: 'dev-A', hostPublicKeyB64: PUB, hostSecretKey: keys.secretKey, fetch: f })
    const b = calls[1].body
    expect(s.verify({ hostPublicKeyB64: PUB, purpose: 'host-token', subject: 'dev-B', popChallenge: b.popChallenge, popProof: b.popProof })).toBe(false)
    expect(s.verify({ hostPublicKeyB64: PUB, purpose: 'host-token', subject: 'dev-A', popChallenge: b.popChallenge, popProof: b.popProof })).toBe(true)
  })
  it('the 8 s timeout covers a challenge that never answers', async () => {
    vi.useFakeTimers()
    const f = ((_u: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
    })) as unknown as typeof fetch
    const p = mintHostToken({ apiBase: 'https://api', deviceId: 'd', hostPublicKeyB64: PUB, hostSecretKey: keys.secretKey, fetch: f })
    let settled: unknown = 'pending'
    void p.then((r) => { settled = r })
    await vi.advanceTimersByTimeAsync(7_999)
    expect(settled).toBe('pending')
    await vi.advanceTimersByTimeAsync(1)
    expect(settled).toEqual({ ok: false, kind: 'network' })
  })
})
