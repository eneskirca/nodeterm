// Everything a live link needs is derived from ONE 32-byte secret S that lives only in the URL
// fragment. The host key pair lets the viewer pin the host; the viewer key pair is what the host
// accepts in the handshake (so the relay handshake itself is unchanged); the join key is shown to
// the API, which stores only its SHA-256 and so can gate a join without learning S. The three are
// domain-separated, so learning the join key (the API does) reveals nothing about the other two.
import nacl from 'tweetnacl'
import { bytesToHex, concatBytes, utf8, webCryptoBytes } from './bytes'

export const WATCH_LINK_KDF_PREFIX = 'nodeterm-watch-link-v1/'
export const WATCH_LINK_SECRET_BYTES = 32

export interface KeyPairBytes {
  publicKey: Uint8Array
  secretKey: Uint8Array
}
export interface WatchLinkKeys {
  host: KeyPairBytes
  viewer: KeyPairBytes
  joinKey: Uint8Array
}

function sub(secret: Uint8Array, label: string): Uint8Array {
  return nacl.hash(concatBytes(utf8(WATCH_LINK_KDF_PREFIX + label), secret)).slice(0, 32)
}

export function deriveWatchLinkKeys(secret: Uint8Array): WatchLinkKeys {
  if (secret.length !== WATCH_LINK_SECRET_BYTES) throw new Error('A live link secret is 32 bytes.')
  return {
    host: nacl.box.keyPair.fromSecretKey(sub(secret, 'host')),
    viewer: nacl.box.keyPair.fromSecretKey(sub(secret, 'viewer')),
    joinKey: sub(secret, 'join')
  }
}

export function newWatchLinkSecret(): Uint8Array {
  return nacl.randomBytes(WATCH_LINK_SECRET_BYTES)
}

export async function sha256Hex(b: Uint8Array): Promise<string> {
  return bytesToHex(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', webCryptoBytes(b))))
}
