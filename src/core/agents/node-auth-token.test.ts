import { describe, it, expect } from 'vitest'
import { createHmac, randomBytes } from 'node:crypto'
import {
  isSafeNodeId,
  nodeAuthKid,
  nodeAuthToken,
  verifyNodeToken
} from './node-auth-token'

const secret = randomBytes(32)
const other = randomBytes(32)

describe('node auth token', () => {
  it('is kid.mac, domain-separated, and stable for a given secret+node', () => {
    const t = nodeAuthToken(secret, 'node-1')
    expect(t).toMatch(/^[A-Za-z0-9_-]{8}\.[A-Za-z0-9_-]{43}$/)
    expect(t.split('.')[0]).toBe(nodeAuthKid(secret))
    expect(nodeAuthToken(secret, 'node-1')).toBe(t)
    // Domain separation: the bare-nodeId HMAC #167 shipped must NOT be a valid mac here.
    const bareMac = createHmac('sha256', secret).update('node-1').digest('base64url')
    expect(t.split('.')[1]).not.toBe(bareMac)
  })

  it("verifies our kid + right node, and 403s our kid + another node's mac", () => {
    expect(verifyNodeToken(secret, 'node-1', nodeAuthToken(secret, 'node-1'))).toBe('verified')
    expect(verifyNodeToken(secret, 'node-1', nodeAuthToken(secret, 'node-2'))).toBe('forged')
  })

  it('403s a mutated mac in every shape (flipped, truncated, padded, empty-mac)', () => {
    const t = nodeAuthToken(secret, 'node-1')
    const [kid, mac] = t.split('.')
    const flipped = `${kid}.${mac.slice(0, -1)}${mac.endsWith('A') ? 'B' : 'A'}`
    for (const bad of [flipped, `${kid}.${mac.slice(0, 20)}`, `${kid}.${mac} `, `${kid}.`]) {
      expect(verifyNodeToken(secret, 'node-1', bad), bad).toBe('forged')
    }
  })

  it('treats a FOREIGN kid as legacy, never as forgery (the failover path)', () => {
    expect(verifyNodeToken(secret, 'node-1', nodeAuthToken(other, 'node-1'))).toBe('legacy')
  })

  it('treats absent / empty / shapeless / non-string tokens as legacy', () => {
    for (const p of [undefined, '', 'not-a-token', ['a', 'b']] as const) {
      expect(verifyNodeToken(secret, 'node-1', p as never)).toBe('legacy')
    }
    // A leading dot is not our shape (dot at index 0).
    expect(verifyNodeToken(secret, 'node-1', '.mac')).toBe('legacy')
  })

  it('is legacy when the server has no secret at all (mixed-version machines)', () => {
    expect(verifyNodeToken(null, 'node-1', nodeAuthToken(secret, 'node-1'))).toBe('legacy')
  })

  it('refuses unsafe node ids before hashing — including bare dot segments', () => {
    for (const bad of ['..', '.', '../x', 'a b', 'a/b', '', 'x'.repeat(300)]) {
      expect(isSafeNodeId(bad), bad).toBe(false)
    }
    for (const good of ['node-1', 'term_abc.9', 'A.B-C_d']) {
      expect(isSafeNodeId(good), good).toBe(true)
    }
    expect(nodeAuthToken(secret, '../etc')).toBe('')
    // An unsafe id UNDER our kid is forgery, not legacy — the id can never be a real token.
    expect(verifyNodeToken(secret, '..', `${nodeAuthKid(secret)}.whatever`)).toBe('forged')
  })

  it('does not throw on unequal-length compares', () => {
    expect(() => verifyNodeToken(secret, 'node-1', `${nodeAuthKid(secret)}.x`)).not.toThrow()
  })

  it('handles an enormous presented string without throwing or stalling', () => {
    const huge = `${nodeAuthKid(secret)}.${'A'.repeat(10000)}`
    expect(verifyNodeToken(secret, 'node-1', huge)).toBe('forged')
  })
})
