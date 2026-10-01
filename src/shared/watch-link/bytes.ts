// Byte helpers for the live-link protocol. ISOMORPHIC: this directory is vendored byte-for-byte by
// nodeterm-web (the viewer page), so nothing here may touch `Buffer`, `node:*` or the DOM beyond
// `btoa`/`atob`/`TextEncoder`, which Node ≥ 16 and every browser provide.

const B64 = /^[A-Za-z0-9+/]*={0,2}$/
const B64URL = /^[A-Za-z0-9_-]*$/

export function bytesToB64(b: Uint8Array): string {
  let s = ''
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i])
  return btoa(s)
}

/** Strict: a string with characters outside the alphabet is `null`, never a silently shorter key. */
export function b64ToBytes(s: string): Uint8Array | null {
  if (typeof s !== 'string' || s.length % 4 !== 0 || !B64.test(s)) return null
  try {
    const bin = atob(s)
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out
  } catch {
    return null
  }
}

export function bytesToB64url(b: Uint8Array): string {
  return bytesToB64(b).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function b64urlToBytes(s: string): Uint8Array | null {
  if (typeof s !== 'string' || !B64URL.test(s)) return null
  const std = s.replace(/-/g, '+').replace(/_/g, '/')
  return b64ToBytes(std + '='.repeat((4 - (std.length % 4)) % 4))
}

export function bytesToHex(b: Uint8Array): string {
  let s = ''
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, '0')
  return s
}

export function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s)
}

/** WebCrypto takes only ArrayBuffer-backed views: TypeScript types a bare `Uint8Array` as possibly
 *  SharedArrayBuffer-backed, and browsers refuse those at runtime. A copy is exact and costs nothing
 *  at key sizes, so every `crypto.subtle` argument goes through here instead of a cast. */
export function webCryptoBytes(b: Uint8Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(b)
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}
