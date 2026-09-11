import { describe, it, expect } from 'vitest'
import { encodePairQr, PAIR_URL_PREFIX, DEFAULT_PAIR_QR_FORM } from './pair-qr'

// The exact string `buildPairingPayload` emits, as a literal: this file belongs to the web
// tsconfig project and cannot import from src/main. The composition with the real builder is
// asserted in `src/main/pairing-core.test.ts` instead.
const payload =
  '{"v":1,"host":"192.168.1.5","port":22,"user":"enes","token":"tok123","pairPort":54321,"nodeterm":true,"name":"MacBook"}'

describe('encodePairQr', () => {
  it('defaults to the raw JSON every shipped iOS version can read', () => {
    expect(DEFAULT_PAIR_QR_FORM).toBe('json')
    expect(encodePairQr(payload)).toBe(payload)
    expect(encodePairQr(payload, 'json')).toBe(payload)
  })

  it('wraps the SAME bytes in the app URL scheme for the url form', () => {
    const url = encodePairQr(payload, 'url')
    expect(url.startsWith(PAIR_URL_PREFIX)).toBe(true)
    const code = url.slice(PAIR_URL_PREFIX.length)
    expect(Buffer.from(code, 'base64url').toString('utf-8')).toBe(payload)
  })

  it('emits base64url, not base64 — the code rides in a query parameter', () => {
    // A payload whose base64 is guaranteed to contain + and / unless base64url is used.
    const awkward = JSON.stringify({ v: 1, name: 'ÿÿÿþ>?>?', host: 'a'.repeat(3) })
    const code = encodePairQr(awkward, 'url').slice(PAIR_URL_PREFIX.length)
    expect(code).not.toMatch(/[+/=]/)
    expect(Buffer.from(code, 'base64url').toString('utf-8')).toBe(awkward)
  })

  it('round-trips a payload carrying the relay block and host key', () => {
    const full =
      '{"v":1,"host":"10.0.0.2","port":22,"user":"enes","token":"tok","pairPort":5,' +
      '"nodeterm":true,"name":"Mac","hostKey":"AAAAhostpub","relay":' +
      '{"hostId":"abcABC012_-def012ghij","hostPublicKeyB64":"AAAAhostpub",' +
      '"relayEndpoint":"wss://relay.nodeterm.dev"}}'
    const code = encodePairQr(full, 'url').slice(PAIR_URL_PREFIX.length)
    expect(Buffer.from(code, 'base64url').toString('utf-8')).toBe(full)
  })

  it('produces a URL the phone-side parse rules accept (scheme, host, code param)', () => {
    const url = new URL(encodePairQr(payload, 'url'))
    expect(url.protocol).toBe('nodeterm:')
    expect(url.hostname).toBe('pair')
    expect(url.pathname === '' || url.pathname === '/').toBe(true)
    expect(url.searchParams.get('code')).toBeTruthy()
  })
})
