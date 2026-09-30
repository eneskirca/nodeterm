// End-to-end encryption primitives for the relay transport.
//
// Pure functions over NaCl box (Curve25519 + XSalsa20-Poly1305): no sockets, no
// Electron. The box format is `nonce ‖ ciphertext ‖ mac` so an interoperable peer
// can be implemented against the same wire format.
import { hkdfSync } from 'node:crypto'
import nacl from 'tweetnacl'

export type KeyPair = {
  publicKey: Uint8Array
  secretKey: Uint8Array
}

export function genKeyPair(): KeyPair {
  return nacl.box.keyPair()
}

export function publicKeyToB64(key: Uint8Array): string {
  return Buffer.from(key).toString('base64')
}

export function publicKeyFromB64(b64: string): Uint8Array {
  const key = Uint8Array.from(Buffer.from(b64, 'base64'))
  if (key.length !== nacl.box.publicKeyLength) {
    throw new Error(`Invalid public key: expected ${nacl.box.publicKeyLength} bytes, got ${key.length}`)
  }
  return key
}

// Same strictness for a secret key: `Buffer.from(x, 'base64')` silently drops non-alphabet
// characters and truncates, so a corrupt/short blob would otherwise decode to a short-but-accepted
// key that only blows up ("bad secret key size") deep inside a later nacl.box call.
export function secretKeyFromB64(b64: string): Uint8Array {
  const key = Uint8Array.from(Buffer.from(b64, 'base64'))
  if (key.length !== nacl.box.secretKeyLength) {
    throw new Error(`Invalid secret key: expected ${nacl.box.secretKeyLength} bytes, got ${key.length}`)
  }
  return key
}

// Derive the shared secret (ECDH precompute) from the peer's base64 public key
// and our secret key. Both sides arrive at the same value. This is the STABLE
// per-device-pair key (both endpoints use static keys for pin-once), so it must
// NOT be used directly to encrypt traffic — see deriveSessionKey.
export function deriveSharedKey(theirPubB64: string, ourSecret: Uint8Array): Uint8Array {
  const theirPub = publicKeyFromB64(theirPubB64)
  return nacl.box.before(theirPub, ourSecret)
}

// A fresh 16-byte session nonce, exchanged in the handshake.
export function randomSessionNonce(): Uint8Array {
  return nacl.randomBytes(16)
}

// Per-SESSION traffic key = HKDF-SHA256(baseShared, salt = hostNonce ‖ clientNonce).
// Because both endpoints hold STATIC keys (stable pin-once identity), the raw ECDH
// `baseShared` is identical on every reconnect — encrypting with it lets a malicious
// relay replay a whole recorded session's boxes against a fresh connection (the seq
// counter resets per connection, so it can't stop this). Mixing in fresh per-session
// nonces makes the traffic key unique to each session, so recorded boxes never decrypt
// under a later session's key. RFC 5869 HKDF; matches iOS CryptoKit HKDF<SHA256>.
export function deriveSessionKey(
  baseShared: Uint8Array,
  hostNonce: Uint8Array,
  clientNonce: Uint8Array
): Uint8Array {
  const salt = new Uint8Array(hostNonce.length + clientNonce.length)
  salt.set(hostNonce)
  salt.set(clientNonce, hostNonce.length)
  const info = new TextEncoder().encode('nodeterm-relay-session-v2')
  const out = hkdfSync('sha256', baseShared, salt, info, 32)
  return new Uint8Array(out)
}

// Encrypt with the precomputed shared key. Returns `nonce ‖ ciphertext ‖ mac`.
export function encrypt(plain: Uint8Array, shared: Uint8Array): Uint8Array {
  const nonce = nacl.randomBytes(nacl.box.nonceLength)
  const ciphertext = nacl.box.after(plain, nonce, shared)

  const box = new Uint8Array(nonce.length + ciphertext.length)
  box.set(nonce)
  box.set(ciphertext, nonce.length)
  return box
}

// Short Authentication String: a 6-digit code derived from the ECDH shared key. Both peers
// compute the SAME value (same shared key), so the two humans can compare it out-of-band to
// confirm they're on the same channel before the host approves a connection. Formatted "NNN NNN".
export function sasFromSharedKey(shared: Uint8Array): string {
  const h = nacl.hash(shared) // SHA-512
  // Fold the first 4 bytes into a 32-bit int, then take 6 decimal digits.
  const n = ((h[0] << 24) | (h[1] << 16) | (h[2] << 8) | h[3]) >>> 0
  const code = (n % 1_000_000).toString().padStart(6, '0')
  return `${code.slice(0, 3)} ${code.slice(3)}`
}

// Decrypt a `nonce ‖ ciphertext ‖ mac` box. Returns null on malformed input or
// a failed MAC check — never throws.
export function decrypt(box: Uint8Array, shared: Uint8Array): Uint8Array | null {
  if (box.length < nacl.box.nonceLength + nacl.box.overheadLength) {
    return null
  }
  const nonce = box.slice(0, nacl.box.nonceLength)
  const ciphertext = box.slice(nacl.box.nonceLength)
  const plain = nacl.box.open.after(ciphertext, nonce, shared)
  return plain ?? null
}
