import { describe, it, expect } from 'vitest'
import crypto from 'node:crypto'
import nacl from 'tweetnacl'
import { createPushWebhookClient, webhookProofContext, type PushWebhookHost } from './push-webhook'

// A stand-in for the backend's verifier, written against Node's X25519 (the server's primitive) so
// the test proves the desktop's NaCl `scalarMult` proof interoperates with it — not merely that the
// client agrees with itself.
const PKCS8 = Buffer.from('302e020100300506032b656e04220420', 'hex')
const SPKI = Buffer.from('302a300506032b656e032100', 'hex')
const priv = (raw: Buffer) => crypto.createPrivateKey({ key: Buffer.concat([PKCS8, raw]), format: 'der', type: 'pkcs8' })
const pub = (raw: Buffer) => crypto.createPublicKey({ key: Buffer.concat([SPKI, raw]), format: 'der', type: 'spki' })
const rawPub = (k: crypto.KeyObject) => (k.export({ type: 'spki', format: 'der' }) as Buffer).subarray(12)

function fakeServer(opts: { paired?: boolean; status?: number } = {}) {
  const eph = new Map<string, Buffer>()
  const calls: Array<{ path: string; body: any }> = []
  const verified: string[] = []
  const f = async (url: string, init: { body: string }) => {
    const path = new URL(url).pathname
    const body = JSON.parse(init.body)
    calls.push({ path, body })
    const respond = (status: number, json: unknown) =>
      ({ status, json: async () => json }) as unknown as Response
    if (path === '/v1/push/webhook/challenge') {
      const challenge = `${Date.now()}.${crypto.randomBytes(16).toString('base64url')}`
      const raw = crypto.randomBytes(32)
      eph.set(challenge, raw)
      return respond(200, { challenge, serverPublicKeyB64: rawPub(crypto.createPublicKey(priv(raw))).toString('base64') })
    }
    if (opts.status) return respond(opts.status, { error: 'x' })
    const action = path.endsWith('/token') ? 'mint' : path.endsWith('/status') ? 'status' : 'revoke'
    const shared = crypto.diffieHellman({
      privateKey: priv(eph.get(body.challenge)!),
      publicKey: pub(Buffer.from(body.hostPublicKeyB64, 'base64'))
    })
    const expected = crypto.createHmac('sha256', shared).update(webhookProofContext(body.challenge, action, body.hostDeviceId)).digest('base64')
    if (expected !== body.proof) return respond(403, { error: 'forbidden' })
    verified.push(action)
    if (action === 'mint') {
      if (opts.paired === false) return respond(409, { error: 'no_paired_phone' })
      return respond(200, { token: 'ntwh_' + 'a'.repeat(43), tokenId: 't1', tokenPrefix: 'ntwh_aaaa', createdAt: '2026-09-30T00:00:00.000Z' })
    }
    if (action === 'status') return respond(200, { token: null })
    return respond(200, { ok: true })
  }
  return { fetch: f as unknown as typeof fetch, calls, verified }
}

const kp = nacl.box.keyPair()
const host: PushWebhookHost = { hostDeviceId: 'desk-1', publicKey: kp.publicKey, secretKey: kp.secretKey, label: 'mac-mini' }

function client(server: ReturnType<typeof fakeServer>, over: Partial<Parameters<typeof createPushWebhookClient>[0]> = {}) {
  return createPushWebhookClient({
    fetch: server.fetch,
    apiBase: 'https://api.test',
    loadHost: async () => host,
    hasPairedPhone: async () => true,
    isPackaged: () => true,
    env: {},
    ...over
  })
}

describe('push webhook client', () => {
  it('proves possession of the host secret key in a form the server’s X25519 accepts', async () => {
    const s = fakeServer()
    const c = client(s)
    const minted = await c.mint()
    expect(minted).toEqual({
      ok: true,
      value: { token: 'ntwh_' + 'a'.repeat(43), tokenId: 't1', tokenPrefix: 'ntwh_aaaa', createdAt: '2026-09-30T00:00:00.000Z', lastUsedAt: null }
    })
    expect(await c.status()).toEqual({ ok: true, value: null })
    expect(await c.revoke()).toEqual({ ok: true, value: true })
    expect(s.verified).toEqual(['mint', 'status', 'revoke'])
    // The secret key never goes on the wire.
    expect(JSON.stringify(s.calls)).not.toContain(Buffer.from(kp.secretKey).toString('base64'))
    // The label rides only on the mint.
    expect(s.calls.find((c) => c.path.endsWith('/token'))!.body.label).toBe('mac-mini')
    expect(s.calls.find((c) => c.path.endsWith('/status'))!.body.label).toBeUndefined()
  })

  it('a proof made with another key is refused', async () => {
    const s = fakeServer()
    const other = nacl.box.keyPair()
    const c = client(s, { loadHost: async () => ({ ...host, secretKey: other.secretKey }) })
    expect(await c.mint()).toEqual({ ok: false, error: 'refused' })
  })

  it('maps each failure to its own reason', async () => {
    expect(await client(fakeServer({ paired: false })).mint()).toEqual({ ok: false, error: 'no-paired-phone' })
    expect(await client(fakeServer({ status: 429 })).status()).toEqual({ ok: false, error: 'rate-limited' })
    expect(await client(fakeServer({ status: 502 })).status()).toEqual({ ok: false, error: 'unreachable' })
    expect(await client(fakeServer({ status: 400 })).status()).toEqual({ ok: false, error: 'bad-request' })
    const throwing = createPushWebhookClient({
      fetch: (async () => { throw new Error('offline') }) as unknown as typeof fetch,
      apiBase: 'https://api.test',
      loadHost: async () => host,
      hasPairedPhone: async () => true,
      isPackaged: () => true
    })
    expect(await throwing.status()).toEqual({ ok: false, error: 'unreachable' })
    const locked = client(fakeServer(), { loadHost: async () => { throw new Error('locked') } })
    expect(await locked.mint()).toEqual({ ok: false, error: 'no-host-key' })
  })

  it('an unpackaged build without an API override calls nothing', async () => {
    const s = fakeServer()
    const c = createPushWebhookClient({ fetch: s.fetch, loadHost: async () => host, hasPairedPhone: async () => true, isPackaged: () => false, env: {} })
    expect(await c.status()).toEqual({ ok: false, error: 'dev-build' })
    expect(s.calls).toHaveLength(0)
  })
})

it('with no paired phone it neither reads the host key nor calls the backend', async () => {
  const s = fakeServer()
  let keyReads = 0
  const c = client(s, {
    hasPairedPhone: async () => false,
    loadHost: async () => {
      keyReads++
      return host
    }
  })
  for (const r of [await c.status(), await c.mint(), await c.revoke()]) {
    expect(r).toEqual({ ok: false, error: 'no-paired-phone' })
  }
  expect(keyReads).toBe(0)
  expect(s.calls).toHaveLength(0)
  // A failed local check reads as "no phone", never as permission to call.
  const failing = client(s, { hasPairedPhone: async () => { throw new Error('unreadable') } })
  expect(await failing.status()).toEqual({ ok: false, error: 'no-paired-phone' })
  expect(s.calls).toHaveLength(0)
})
