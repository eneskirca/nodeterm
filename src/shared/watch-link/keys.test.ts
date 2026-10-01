import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import nacl from 'tweetnacl'
import { bytesToB64, b64ToBytes, bytesToB64url, b64urlToBytes, bytesToHex, utf8, concatBytes } from './bytes'
import { deriveWatchLinkKeys, newWatchLinkSecret, sha256Hex, WATCH_LINK_KDF_PREFIX } from './keys'
import { formatWatchLink, parseWatchLinkLocation, LINK_ID_RE } from './link'

const secret = Uint8Array.from({ length: 32 }, (_, i) => i)

describe('bytes', () => {
  it('round-trips base64 and base64url like Buffer does', () => {
    const b = nacl.randomBytes(57)
    expect(bytesToB64(b)).toBe(Buffer.from(b).toString('base64'))
    expect(bytesToB64url(b)).toBe(Buffer.from(b).toString('base64url'))
    expect(b64ToBytes(bytesToB64(b))).toEqual(b)
    expect(b64urlToBytes(bytesToB64url(b))).toEqual(b)
    expect(bytesToHex(Uint8Array.of(0, 255, 16))).toBe('00ff10')
    expect(concatBytes(utf8('a'), utf8('bc'))).toEqual(utf8('abc'))
  })
  it("pins base64url's two URL-safe characters with a fixed vector (random bytes may never hit them)", () => {
    // 0xfb 0xff = 111110 111111 1111(00): 62 → '-', 63 → '_', 60 → '8'.
    expect(bytesToB64url(Uint8Array.of(0xfb, 0xff))).toBe('-_8')
    expect(b64urlToBytes('-_8')).toEqual(Uint8Array.of(0xfb, 0xff))
    expect(bytesToB64(Uint8Array.of(0xfb, 0xff))).toBe('+/8=')
  })
  it('refuses malformed base64 instead of silently truncating', () => {
    expect(b64ToBytes('not base64!!')).toBeNull()
    expect(b64urlToBytes('+/+/')).toBeNull()
  })
})

describe('deriveWatchLinkKeys', () => {
  it('derives each key from a domain-separated SHA-512 of the secret', () => {
    const k = deriveWatchLinkKeys(secret)
    const sub = (label: string) =>
      new Uint8Array(createHash('sha512').update(Buffer.concat([Buffer.from(WATCH_LINK_KDF_PREFIX + label), Buffer.from(secret)])).digest()).slice(0, 32)
    expect(k.host.secretKey).toEqual(sub('host'))
    expect(k.host.publicKey).toEqual(nacl.box.keyPair.fromSecretKey(sub('host')).publicKey)
    expect(k.viewer.secretKey).toEqual(sub('viewer'))
    expect(k.joinKey).toEqual(sub('join'))
    expect(k.host.publicKey).not.toEqual(k.viewer.publicKey)
  })
  it('refuses a secret of any other length rather than derive keys from it', () => {
    for (const n of [0, 16, 31, 33, 64]) expect(() => deriveWatchLinkKeys(new Uint8Array(n))).toThrow(/32 bytes/)
  })
  it('makes a fresh 32-byte secret each time', () => {
    const a = newWatchLinkSecret()
    expect(a).toHaveLength(32)
    expect(a).not.toEqual(newWatchLinkSecret())
  })
  it('hashes the join key as lowercase hex sha256', async () => {
    const k = deriveWatchLinkKeys(secret)
    expect(await sha256Hex(k.joinKey)).toBe(createHash('sha256').update(k.joinKey).digest('hex'))
  })
})

describe('link format', () => {
  const id = 'AbCdEfGhIjKlMnOpQrStUv'
  it('formats and parses the viewer URL', () => {
    const url = formatWatchLink(id, secret)
    expect(url).toBe(`https://nodeterm.dev/s/${id}#1.${Buffer.from(secret).toString('base64url')}`)
    const u = new URL(url)
    expect(parseWatchLinkLocation(u.pathname, u.hash)).toEqual({ linkId: id, secret })
  })
  it('refuses a wrong version, id or secret length', () => {
    const s = Buffer.from(secret).toString('base64url')
    expect(parseWatchLinkLocation(`/s/${id}`, `#2.${s}`)).toBeNull()
    expect(parseWatchLinkLocation('/s/short', `#1.${s}`)).toBeNull()
    expect(parseWatchLinkLocation(`/s/${id}`, `#1.${s.slice(1)}`)).toBeNull()
    expect(parseWatchLinkLocation(`/s/${id}/x`, `#1.${s}`)).toBeNull()
    expect(LINK_ID_RE.test(id)).toBe(true)
  })
  // A link nobody can open — or one whose secret ends up outside the fragment — is never formatted.
  it('formats only what it could parse back: a bad id, secret or origin throws', () => {
    for (const bad of ['short', `${id}x`, 'AbCdEfGhIjKlMnOpQrSt/v', 'AbCdEfGhIjKlMnOpQrSt#v', ''])
      expect(() => formatWatchLink(bad, secret)).toThrow(/link id/)
    for (const n of [0, 31, 33]) expect(() => formatWatchLink(id, new Uint8Array(n))).toThrow(/secret/)
    for (const origin of ['https://nodeterm.dev/', 'https://nodeterm.dev/x', 'https://a.dev?x=1', 'https://a.dev#f', 'javascript:alert(1)', 'nodeterm.dev', ''])
      expect(() => formatWatchLink(id, secret, origin)).toThrow(/origin/)
    expect(formatWatchLink(id, secret, 'http://localhost:4321')).toMatch(/^http:\/\/localhost:4321\/s\//)
  })
})
