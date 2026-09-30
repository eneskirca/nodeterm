// Test-only mirror of nodeterm-server's src/lib/relay-pop.ts (issue + verify). Pinned to the same bytes by relay-pop-vector.json; never import from product code.
//
// Tests and test fakes use it to answer `/v1/relay/challenge` and to check a proof the way the real
// backend does (docs/hosted-team-relay.md), so a client that proves something the backend would
// refuse goes red here instead of in production. The hostId hash is computed inline rather than via
// ./relay-id: a mirror of the BACKEND must not silently follow a drift in the client's own derivation.
//
// Deliberately NOT mirrored: the backend's cap on its used-nonce set (50 000 entries; when full it
// sweeps the expired nonces, then evicts the oldest). `used` below is an unbounded Set. A test issues
// a handful of challenges, nowhere near the cap, and what a client test needs from the mirror is the
// replay refusal itself; the cap only decides which very old nonce becomes replayable under load.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import nacl from 'tweetnacl'
import type { PopPurpose } from './relay-pop'

const CHALLENGE_LABEL = 'nodeterm/relay-pop/challenge/v1'
const EPHEMERAL_LABEL = 'nodeterm/relay-pop/eph/v1'
const PROOF_LABEL = 'nodeterm/relay-pop/v1'
const PURPOSES: readonly PopPurpose[] = ['host-token', 'push']
const CHALLENGE_TTL_S = 60
const SKEW_S = 5
const TOKEN_MAX = 2000

const b64u = (b: Uint8Array): string => Buffer.from(b).toString('base64url')
const hmac = (key: Buffer | Uint8Array | string, data: string): Buffer => createHmac('sha256', key).update(data).digest()

function decodeHostKey(b64: unknown): Uint8Array | null {
  if (typeof b64 !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(b64)) return null
  const raw = Buffer.from(b64, 'base64')
  return raw.length === 32 ? new Uint8Array(raw) : null
}

const hostIdOf = (hostPub: Uint8Array): string => createHash('sha256').update(hostPub).digest('base64url').slice(0, 22)

function isZero(b: Uint8Array): boolean {
  let acc = 0
  for (const x of b) acc |= x
  return acc === 0
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

export function createTestPopServer(
  secret = 'test-pop-secret-'.padEnd(40, 'x'),
  opts: { now?: () => number; nonce?: Buffer } = {}
): {
  issue(hostPublicKeyB64: string, purpose: PopPurpose): { challenge: string; serverPublicKeyB64: string; exp: number }
  verify(i: { hostPublicKeyB64: string; purpose: PopPurpose; subject: string; popChallenge: unknown; popProof: unknown }): boolean
} {
  const now = opts.now ?? Date.now
  const nowS = (): number => Math.floor(now() / 1000)
  const used = new Set<string>()

  const seal = (part: string): string => b64u(hmac(secret, `${CHALLENGE_LABEL}\n${part}`))
  const serverSecretFor = (nonce: string): Uint8Array => new Uint8Array(hmac(secret, `${EPHEMERAL_LABEL}\n${nonce}`))

  function open(token: unknown): Record<string, unknown> | null {
    if (typeof token !== 'string' || token.length > TOKEN_MAX) return null
    const dot = token.indexOf('.')
    if (dot <= 0 || dot !== token.lastIndexOf('.')) return null
    const part = token.slice(0, dot)
    if (!safeEqual(token.slice(dot + 1), seal(part))) return null
    try {
      const v: unknown = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'))
      return v && typeof v === 'object' ? (v as Record<string, unknown>) : null
    } catch {
      return null
    }
  }

  return {
    issue(hostPublicKeyB64, purpose) {
      const hostPub = decodeHostKey(hostPublicKeyB64)
      // The backend answers null (→ 400) here; this throws instead. Called inside a fetch fake (where
      // every client test calls it), the throw becomes a rejected fetch, which the client reads as a
      // transient network failure (`network` on the Server Edition mint, `null` on the desktop mint,
      // 'drop' on push), NOT a loud error: a test that expects success still fails, but on its own
      // assertion, not here.
      if (!hostPub || !PURPOSES.includes(purpose)) throw new Error('relay-pop test server: bad host key or purpose')
      const nonce = b64u(opts.nonce ?? randomBytes(16))
      const exp = nowS() + CHALLENGE_TTL_S
      const part = b64u(Buffer.from(JSON.stringify({ v: 1, hostId: hostIdOf(hostPub), purpose, nonce, exp }), 'utf8'))
      return {
        challenge: `${part}.${seal(part)}`,
        serverPublicKeyB64: Buffer.from(nacl.scalarMult.base(serverSecretFor(nonce))).toString('base64'),
        exp
      }
    },
    verify({ hostPublicKeyB64, purpose, subject, popChallenge, popProof }) {
      const hostPub = decodeHostKey(hostPublicKeyB64)
      if (!hostPub || typeof popProof !== 'string' || typeof subject !== 'string') return false
      const c = open(popChallenge)
      if (!c || c.v !== 1 || c.purpose !== purpose || typeof c.nonce !== 'string' || typeof c.exp !== 'number') return false
      if (c.hostId !== hostIdOf(hostPub)) return false
      if (c.exp + SKEW_S < nowS()) return false
      const shared = nacl.scalarMult(serverSecretFor(c.nonce), hostPub)
      if (isZero(shared)) return false // a low-order "key" gives everyone the same secret
      const key = hmac(Buffer.from(shared), PROOF_LABEL)
      const expected = b64u(hmac(key, [popChallenge as string, purpose, subject, hostPublicKeyB64].join('\n')))
      if (!safeEqual(popProof, expected)) return false
      if (used.has(c.nonce)) return false // single-use
      used.add(c.nonce)
      return true
    }
  }
}
