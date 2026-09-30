// Pure encode/decode for a persisted NaCl box keypair file, with encrypt-at-rest and a legacy
// plaintext fallback + in-place migration. The Electron `safeStorage` is injected as `SafeStorageLike`
// so this stays free of `electron` and unit-tests without a keychain. The on-disk byte format mirrors
// host-service.ts's persistKeyPair/loadOrCreateKeyPair exactly (public key always plaintext base64 —
// it is a pinned identity, not a secret — the secret key either safeStorage-encrypted or 0600 plaintext).
//
// NOTE (intentional duplication): host-service.ts still inlines the same format. We do NOT refactor it
// to use this codec — that file is Stage 4c's to rewrite, and editing it here would collide. 4c may
// adopt this codec when it rewrites the handshake.
import { publicKeyFromB64, secretKeyFromB64, type KeyPair } from './e2ee'

export interface SafeStorageLike {
  isEncryptionAvailable(): boolean
  encryptString(plaintext: string): Buffer
  decryptString(ciphertext: Buffer): string
}

interface KeyFileBody {
  publicKey?: string
  secretKey?: string // legacy plaintext base64
  secretKeyEnc?: string // safeStorage ciphertext, base64
}

/** Serialize a keypair to the on-disk JSON string; encrypted when safeStorage is available. */
export function encodeKeyFile(keys: KeyPair, safe: SafeStorageLike): string {
  const publicKey = Buffer.from(keys.publicKey).toString('base64')
  const secretB64 = Buffer.from(keys.secretKey).toString('base64')
  const body: KeyFileBody = safe.isEncryptionAvailable()
    ? { publicKey, secretKeyEnc: safe.encryptString(secretB64).toString('base64') }
    : { publicKey, secretKey: secretB64 }
  return JSON.stringify(body)
}

/**
 * The three outcomes of reading a key file. They are NOT interchangeable — the caller must branch:
 *
 * - `{ keys, migrate }` — usable. `migrate:true` means the file is legacy plaintext but encryption
 *   is now available: re-persist to upgrade in place, KEEPING the identity.
 * - `null` — unusable: malformed JSON, a wrong-length key, or an encrypted blob the (available)
 *   keychain cannot decrypt (keychain reset ⇒ the secret is gone for good). Regenerating is the
 *   only way forward and is CORRECT here.
 * - `'locked'` — the file is well-formed and holds an ENCRYPTED secret, but `isEncryptionAvailable()`
 *   is false RIGHT NOW (keyring not yet unlocked, no session bus, safeStorage backend down). The
 *   identity is intact on disk, merely unreadable at this moment. The caller MUST NOT write:
 *   regenerating would replace a pinned identity with a fresh (plaintext) one, forcing re-approval
 *   on every host that pinned it — unrecoverably. Fail the operation and tell the user to unlock.
 */
export type KeyFileDecoded = { keys: KeyPair; migrate: boolean } | null | 'locked'

/** Parse a key file. See `KeyFileDecoded` — the three outcomes must not be collapsed into one. */
export function decodeKeyFile(raw: string, safe: SafeStorageLike): KeyFileDecoded {
  let body: unknown
  try {
    body = JSON.parse(raw)
  } catch {
    return null
  }
  // `JSON.parse` happily yields null / arrays / numbers for a truncated or aborted write; only a
  // plain object can be a key file. (Without this, the literal `null` threw a TypeError below.)
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  const file = body as KeyFileBody
  if (!file.publicKey) return null

  // Both key parsers are STRICT about the 32-byte length and throw otherwise — base64 decoding is
  // lenient (drops junk chars, truncates), so a corrupt file would otherwise decode to a
  // short/empty "identity" that the caller accepts and only fails much later inside nacl.
  try {
    const publicKey = publicKeyFromB64(file.publicKey)
    if (file.secretKeyEnc) {
      // An encrypted secret is AUTHORITATIVE: never silently fall back to a (possibly stale)
      // plaintext one, and never mistake "no keyring right now" for corruption.
      if (!safe.isEncryptionAvailable()) return 'locked'
      // decryptString may throw (keychain reset) OR return junk — either way the secret is
      // genuinely gone, so that is `null` (regenerate), not `'locked'`.
      const secretB64 = safe.decryptString(Buffer.from(file.secretKeyEnc, 'base64'))
      return { keys: { publicKey, secretKey: secretKeyFromB64(secretB64) }, migrate: false }
    }
    if (file.secretKey) {
      return {
        keys: { publicKey, secretKey: secretKeyFromB64(file.secretKey) },
        // Legacy plaintext but a keyring now exists → the caller should re-persist encrypted.
        migrate: safe.isEncryptionAvailable()
      }
    }
  } catch {
    return null
  }
  return null
}
