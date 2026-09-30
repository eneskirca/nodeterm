// The Server Edition's relay host identity. Its public key IS the team's address (hostId), and
// every joiner pins it — so an unreadable or corrupt key is NEVER silently replaced: a new key
// orphans every bookmark and forces every teammate through first-join approval again. Rotation is
// only the explicit `team rotate-key`. Plaintext secret at 0600: headless Linux has no keyring
// (the same decision the Server Edition's node identity made).
import { promises as fs } from 'node:fs'
import path from 'node:path'
import nacl from 'tweetnacl'
import { writeFileAtomic } from '../fs-atomic'
import { encodeKeyFile, decodeKeyFile, type SafeStorageLike } from './key-file-codec'
import { genKeyPair, publicKeyToB64, type KeyPair } from './e2ee'
import { hostIdFromPublicKeyB64 } from './relay-id'
import { ensurePrivateDir } from './private-dir'

const NO_KEYRING: SafeStorageLike = {
  isEncryptionAvailable: () => false,
  encryptString: () => { throw new Error('no keyring') },
  decryptString: () => { throw new Error('no keyring') }
}

export class HostKeyUnreadableError extends Error {
  readonly code = 'E_HOST_KEY_UNREADABLE'
  constructor(detail: string) {
    super(`The team host key could not be read (${detail}). It was NOT replaced — a new key would ` +
      `invalidate every teammate's bookmark. Restore it, or run \`team rotate-key\` on purpose.`)
    this.name = 'HostKeyUnreadableError'
  }
}

/** `createHostKey` found a key already there. Typed, so a caller that lost an init race (two
 *  `team init`s at once) can recognise it by `code` rather than by matching message text. */
export class HostKeyExistsError extends Error {
  readonly code = 'E_HOST_KEY_EXISTS'
  constructor() {
    super('A team host key already exists.')
    this.name = 'HostKeyExistsError'
  }
}

const file = (dir: string): string => path.join(dir, 'host-key.json')

async function persist(dir: string, keys: KeyPair): Promise<void> {
  ensurePrivateDir(dir)
  await writeFileAtomic(file(dir), encodeKeyFile(keys, NO_KEYRING), { mode: 0o600 })
}

// "Is there a key?" then "write one" is two steps. Two `team init`s arriving together over the
// admin socket would both see none, and the second write would silently replace the first key —
// possibly after its join code was already handed out. Every WRITE to one directory therefore runs
// one at a time. In-process is enough: the server that owns the admin socket is the only writer.
const writeChains = new Map<string, Promise<unknown>>()
function serializeWrite<T>(dir: string, op: () => Promise<T>): Promise<T> {
  const key = path.resolve(dir)
  const run = (writeChains.get(key) ?? Promise.resolve()).then(op)
  const tail = run.catch(() => {})
  writeChains.set(key, tail)
  void tail.then(() => { if (writeChains.get(key) === tail) writeChains.delete(key) })
  return run
}

/** `null` = no key yet. Anything else that is not a usable key throws `HostKeyUnreadableError`. */
export async function loadHostKey(dir: string): Promise<KeyPair | null> {
  let raw: string
  try {
    raw = await fs.readFile(file(dir), 'utf-8')
  } catch (err) {
    // Unreadable is not absent: only a missing file means "none yet".
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new HostKeyUnreadableError((err as NodeJS.ErrnoException).code ?? 'read failed')
  }
  const decoded = decodeKeyFile(raw, NO_KEYRING)
  if (decoded === 'locked') throw new HostKeyUnreadableError('encrypted with a keyring this host does not have')
  if (!decoded) throw new HostKeyUnreadableError('malformed')
  // The codec checks lengths only. A public key from one pair beside the secret of another (a
  // half-restored backup) would advertise an address whose handshakes can never decrypt.
  const derived = nacl.box.keyPair.fromSecretKey(decoded.keys.secretKey).publicKey
  if (!Buffer.from(derived).equals(Buffer.from(decoded.keys.publicKey))) {
    throw new HostKeyUnreadableError('the public key does not match the secret key')
  }
  return decoded.keys
}

/** Mint the first key. Refuses with `HostKeyExistsError` when one exists, and throws
 *  `HostKeyUnreadableError` (without writing) when one exists but cannot be read. */
export function createHostKey(dir: string): Promise<KeyPair> {
  return serializeWrite(dir, async () => {
    if ((await loadHostKey(dir)) !== null) throw new HostKeyExistsError()
    const keys = genKeyPair()
    await persist(dir, keys)
    return keys
  })
}

/** Replace the key, whatever is there. Explicit only: every teammate needs a new join code. */
export function rotateHostKey(dir: string): Promise<KeyPair> {
  return serializeWrite(dir, async () => {
    const keys = genKeyPair()
    await persist(dir, keys)
    return keys
  })
}

export function hostAddress(keys: KeyPair): { hostPublicKeyB64: string; hostId: string } {
  const hostPublicKeyB64 = publicKeyToB64(keys.publicKey)
  return { hostPublicKeyB64, hostId: hostIdFromPublicKeyB64(hostPublicKeyB64) }
}
