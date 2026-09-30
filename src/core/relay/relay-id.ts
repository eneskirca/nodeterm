// Host-id derivation for the standing (phone) relay path.
//
// The relay broker matches a host and its clients by a short `hostId` derived from the host's
// NaCl box public key. This MUST match the server's `src/lib/relay-id.ts` byte-for-byte:
//   hostId = base64url(sha256(rawPublicKeyBytes)).slice(0, 22)   (base64url, no padding)
// where the raw bytes are the 32-byte Curve25519 public key (the same bytes `publicKeyToB64`
// standard-base64-encodes). Keep this in sync with the server — a mismatch means the phone and
// this host would register under different rooms and never bridge.

import { createHash } from 'node:crypto'

/** Derive the broker host id from the raw 32-byte NaCl box public key. */
export function hostIdFromPublicKey(pub: Uint8Array): string {
  // Node's 'base64url' digest is already unpadded RFC 4648 §5, matching the server.
  return createHash('sha256').update(pub).digest('base64url').slice(0, 22)
}

/** Derive the broker host id from a standard-base64 NaCl box public key (what publicKeyToB64 emits). */
export function hostIdFromPublicKeyB64(b64: string): string {
  return hostIdFromPublicKey(Uint8Array.from(Buffer.from(b64, 'base64')))
}
