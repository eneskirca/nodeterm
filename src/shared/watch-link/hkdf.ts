// HKDF-SHA256 over WebCrypto, the browser's equivalent of the relay's `hkdfSync` (e2ee.ts).
import { webCryptoBytes } from './bytes'

export async function hkdfSha256(ikm: Uint8Array, salt: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  const subtle = globalThis.crypto.subtle
  const key = await subtle.importKey('raw', webCryptoBytes(ikm), 'HKDF', false, ['deriveBits'])
  return new Uint8Array(
    await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: webCryptoBytes(salt), info: webCryptoBytes(info) }, key, length * 8)
  )
}
