import { createHmac } from 'node:crypto'
import nacl from 'tweetnacl'
import { describe, expect, it } from 'vitest'
import vector from './relay-pop-vector.json'
import { computePopProof, fetchPopChallenge, popProverFor, popRefusalOf, type PopPurpose } from './relay-pop'
import { createTestPopServer } from './relay-pop.test-server'

const secretKey = new Uint8Array(Buffer.from(vector.hostSecretKeyB64, 'base64'))

describe('relay-pop: the shared vector (byte contract with nodeterm-server)', () => {
  for (const c of vector.cases) {
    it(`computes the vector proof (${c.purpose}, "${c.subject}")`, () => {
      expect(computePopProof({ hostSecretKey: secretKey, hostPublicKeyB64: vector.hostPublicKeyB64, challenge: c.challenge, serverPublicKeyB64: c.serverPublicKeyB64, purpose: c.purpose as PopPurpose, subject: c.subject })).toBe(c.proof)
    })
  }
  it('the test server issues the vector challenge (so fakes mirror the backend)', () => {
    const s = createTestPopServer(vector.popSecret, { now: () => (vector.cases[0].exp - 60) * 1000, nonce: Buffer.from(vector.nonce, 'base64url') })
    expect(s.issue(vector.hostPublicKeyB64, 'host-token')).toEqual({ challenge: vector.cases[0].challenge, serverPublicKeyB64: vector.cases[0].serverPublicKeyB64, exp: vector.cases[0].exp })
  })
  // The vector pins the mirror's issue() and the client's proof; this pins the mirror's verify() to
  // the same bytes directly, instead of only through random keys. One server per case: the cases
  // share one nonce, and verify() consumes it.
  for (const c of vector.cases) {
    it(`the test server verifies the vector proof (${c.purpose}, "${c.subject}")`, () => {
      const s = createTestPopServer(vector.popSecret, { now: () => (c.exp - 60) * 1000, nonce: Buffer.from(vector.nonce, 'base64url') })
      expect(s.verify({ hostPublicKeyB64: vector.hostPublicKeyB64, purpose: c.purpose as PopPurpose, subject: c.subject, popChallenge: c.challenge, popProof: c.proof })).toBe(true)
    })
  }
})

describe('computePopProof', () => {
  it('refuses a degenerate (all-zero) server key', () => {
    expect(() => computePopProof({ hostSecretKey: secretKey, hostPublicKeyB64: vector.hostPublicKeyB64, challenge: 'c', serverPublicKeyB64: Buffer.alloc(32).toString('base64'), purpose: 'push', subject: '' })).toThrow(/degenerate/)
  })
  it('refuses a malformed server key', () => {
    expect(() => computePopProof({ hostSecretKey: secretKey, hostPublicKeyB64: vector.hostPublicKeyB64, challenge: 'c', serverPublicKeyB64: 'AAAA', purpose: 'push', subject: '' })).toThrow()
  })
  it('popProverFor proves with its key pair, and the test server accepts it', () => {
    const k = nacl.box.keyPair()
    const pub = Buffer.from(k.publicKey).toString('base64')
    const s = createTestPopServer()
    const ch = s.issue(pub, 'host-token')
    const proof = popProverFor(k)({ challenge: ch.challenge, serverPublicKeyB64: ch.serverPublicKeyB64, purpose: 'host-token', subject: 'd' })
    expect(s.verify({ hostPublicKeyB64: pub, purpose: 'host-token', subject: 'd', popChallenge: ch.challenge, popProof: proof })).toBe(true)
  })
  it.each<[string, (k: nacl.BoxKeyPair, other: nacl.BoxKeyPair) => void]>([
    ['has its bytes overwritten in place', (k, other) => k.secretKey.set(other.secretKey)],
    ['is replaced by another array', (k, other) => { k.secretKey = other.secretKey }]
  ])('popProverFor captures the secret at creation: a key pair whose secret %s still proves for the public key it was made with', (_label, mutate) => {
    // The public key is captured eagerly; a secret read at call time could pair a NEW secret with the
    // OLD public key, which proves nothing the backend accepts.
    const k = nacl.box.keyPair()
    const pub = Buffer.from(k.publicKey).toString('base64')
    const prove = popProverFor(k)
    mutate(k, nacl.box.keyPair())
    const s = createTestPopServer()
    const ch = s.issue(pub, 'push')
    const proof = prove({ challenge: ch.challenge, serverPublicKeyB64: ch.serverPublicKeyB64, purpose: 'push', subject: 'x' })
    expect(s.verify({ hostPublicKeyB64: pub, purpose: 'push', subject: 'x', popChallenge: ch.challenge, popProof: proof })).toBe(true)
  })
})

// The fakes in later tests are only as strict as this mirror: each refusal below is one the backend
// makes, and each would let a wrong client proof through if the mirror dropped it.
describe('createTestPopServer refuses what the backend refuses', () => {
  const keys = nacl.box.keyPair()
  const pub = Buffer.from(keys.publicKey).toString('base64')
  const T = 1_000_000
  const at = (s: number) => () => s * 1000
  const prove = (ch: { challenge: string; serverPublicKeyB64: string }, purpose: PopPurpose, subject: string, k = keys) =>
    popProverFor(k)({ challenge: ch.challenge, serverPublicKeyB64: ch.serverPublicKeyB64, purpose, subject })

  it('accepts once, refuses the same nonce again', () => {
    const s = createTestPopServer(undefined, { now: at(T) })
    const ch = s.issue(pub, 'push')
    const input = { hostPublicKeyB64: pub, purpose: 'push' as const, subject: 'x', popChallenge: ch.challenge, popProof: prove(ch, 'push', 'x') }
    expect(s.verify(input)).toBe(true)
    expect(s.verify(input)).toBe(false)
  })
  it('refuses another subject, a tampered challenge, and a challenge sealed under another secret', () => {
    const s = createTestPopServer(undefined, { now: at(T) })
    const ch = s.issue(pub, 'host-token')
    const base = { hostPublicKeyB64: pub, purpose: 'host-token' as const, subject: 'd', popChallenge: ch.challenge, popProof: prove(ch, 'host-token', 'd') }
    expect(s.verify({ ...base, subject: 'e' })).toBe(false)
    expect(s.verify({ ...base, popChallenge: ch.challenge.replace(/.$/, (x) => (x === 'A' ? 'B' : 'A')) })).toBe(false)
    expect(createTestPopServer('t'.repeat(40), { now: at(T) }).verify(base)).toBe(false)
    expect(s.verify(base)).toBe(true)
  })
  it('refuses a re-written challenge payload (extended exp), even with the key holder\'s proof over it', () => {
    const ch = createTestPopServer(undefined, { now: at(T) }).issue(pub, 'push')
    const [part, sig] = ch.challenge.split('.')
    const body = JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as { exp: number }
    const forged = `${Buffer.from(JSON.stringify({ ...body, exp: body.exp + 3600 }), 'utf8').toString('base64url')}.${sig}`
    const late = createTestPopServer(undefined, { now: at(T + 600) })
    expect(late.verify({ hostPublicKeyB64: pub, purpose: 'push', subject: 'x', popChallenge: forged, popProof: prove({ ...ch, challenge: forged }, 'push', 'x') })).toBe(false)
  })
  it('refuses a challenge issued for another purpose, even with a proof made over it', () => {
    const s = createTestPopServer(undefined, { now: at(T) })
    const ch = s.issue(pub, 'push')
    expect(s.verify({ hostPublicKeyB64: pub, purpose: 'host-token', subject: 'd', popChallenge: ch.challenge, popProof: prove(ch, 'host-token', 'd') })).toBe(false)
  })
  it('refuses a challenge issued for another host key, even with that key\'s own valid proof', () => {
    const s = createTestPopServer(undefined, { now: at(T) })
    const other = nacl.box.keyPair()
    const ch = s.issue(pub, 'push')
    const otherPub = Buffer.from(other.publicKey).toString('base64')
    expect(s.verify({ hostPublicKeyB64: otherPub, purpose: 'push', subject: 'x', popChallenge: ch.challenge, popProof: prove(ch, 'push', 'x', other) })).toBe(false)
  })
  it('accepts up to exp + 5 s, refuses after', () => {
    const issued = createTestPopServer(undefined, { now: at(T) }).issue(pub, 'push')
    const input = (subject: string) => ({ hostPublicKeyB64: pub, purpose: 'push' as const, subject, popChallenge: issued.challenge, popProof: prove(issued, 'push', subject) })
    expect(createTestPopServer(undefined, { now: at(issued.exp + 6) }).verify(input('x'))).toBe(false)
    expect(createTestPopServer(undefined, { now: at(issued.exp + 5) }).verify(input('x'))).toBe(true)
  })
  it('refuses a proof forged over the all-zero shared secret of a low-order host key', () => {
    const zero = Buffer.alloc(32).toString('base64')
    const s = createTestPopServer(undefined, { now: at(T) })
    const ch = s.issue(zero, 'host-token')
    const zeroKey = createHmac('sha256', Buffer.alloc(32)).update('nodeterm/relay-pop/v1').digest()
    const forged = createHmac('sha256', zeroKey).update([ch.challenge, 'host-token', '', zero].join('\n')).digest('base64url')
    expect(s.verify({ hostPublicKeyB64: zero, purpose: 'host-token', subject: '', popChallenge: ch.challenge, popProof: forged })).toBe(false)
  })
  it('refuses non-string evidence without throwing', () => {
    expect(createTestPopServer().verify({ hostPublicKeyB64: pub, purpose: 'push', subject: '', popChallenge: 5, popProof: {} })).toBe(false)
  })
})

describe('fetchPopChallenge', () => {
  const res = (status: number, body: unknown) => new Response(JSON.stringify(body), { status })
  it('404/405 ⇒ unsupported (old backend)', async () => {
    for (const st of [404, 405]) {
      expect(await fetchPopChallenge({ apiBase: 'https://api/', hostPublicKeyB64: 'K', purpose: 'push', fetch: (async () => res(st, {})) as typeof fetch })).toEqual({ ok: false, unsupported: true })
    }
  })
  it('network error, 5xx, 429 and a malformed body are NOT unsupported', async () => {
    const throwing = (async () => { throw new Error('down') }) as typeof fetch
    expect(await fetchPopChallenge({ apiBase: 'https://api', hostPublicKeyB64: 'K', purpose: 'push', fetch: throwing })).toEqual({ ok: false, unsupported: false })
    expect(await fetchPopChallenge({ apiBase: 'https://api', hostPublicKeyB64: 'K', purpose: 'push', fetch: (async () => res(503, {})) as typeof fetch })).toEqual({ ok: false, unsupported: false, status: 503 })
    expect(await fetchPopChallenge({ apiBase: 'https://api', hostPublicKeyB64: 'K', purpose: 'push', fetch: (async () => res(429, {})) as typeof fetch })).toEqual({ ok: false, unsupported: false, status: 429 })
    expect(await fetchPopChallenge({ apiBase: 'https://api', hostPublicKeyB64: 'K', purpose: 'push', fetch: (async () => res(200, { pairingToken: 'T' })) as typeof fetch })).toEqual({ ok: false, unsupported: false, status: 200 })
  })
  it('posts {hostPublicKeyB64, purpose} to /v1/relay/challenge and returns the challenge', async () => {
    let url = ''; let sent: unknown
    const r = await fetchPopChallenge({ apiBase: 'https://api//', hostPublicKeyB64: 'K', purpose: 'host-token', fetch: (async (u: string, init: RequestInit) => { url = u; sent = JSON.parse(String(init.body)); return res(200, { challenge: 'C', serverPublicKeyB64: 'S', exp: 1 }) }) as typeof fetch })
    expect(url).toBe('https://api/v1/relay/challenge')
    expect(sent).toEqual({ hostPublicKeyB64: 'K', purpose: 'host-token' })
    expect(r).toEqual({ ok: true, challenge: 'C', serverPublicKeyB64: 'S' })
  })
})

describe('popRefusalOf', () => {
  it('reads only a 403 carrying a PoP error', () => {
    expect(popRefusalOf(403, { error: 'pop_required' })).toBe('pop_required')
    expect(popRefusalOf(403, { error: 'pop_invalid' })).toBe('pop_invalid')
    expect(popRefusalOf(403, { error: 'forbidden' })).toBeNull()
    expect(popRefusalOf(402, { error: 'pop_required' })).toBeNull()
    expect(popRefusalOf(403, null)).toBeNull()
  })
})
