import { randomBytes } from 'crypto'
import { promises as fs } from 'fs'
import path from 'path'
import { platform } from '../platform'

/**
 * The single 32-byte secret every per-node capability derives from. It is the root
 * of all node identity, so it is minted from crypto.randomBytes, written 0600 via
 * tmp+rename (a reader never sees a partial file), and stored in ONE of two at-rest
 * formats under two DISTINCT file names, so a data dir moved between shells can never
 * be misread as the other format:
 *
 *   - Desktop shell (can seal): node-auth-key.json — {version:1, secretKeyEnc:<base64
 *     of the sealed base64 secret>}, mirroring #167's codex-node-auth-key.json shape.
 *   - Server Edition (no keychain): node-auth-key.bin — exactly 32 raw bytes, mode 0600.
 *
 * The same secret signs the codex thread→node records #167 wrote, so on the sealed
 * path we ADOPT a pre-existing codex-node-auth-key.json before minting fresh — minting
 * anew would orphan every bound codex thread on the machine.
 */

type StoredSecret = { version: 1; secretKeyEnc: string }

let cached: Promise<Buffer> | null = null
let cachedDir = ''

/** Whether the platform can seal secrets at rest. Throws if it supplies exactly one
 *  of the two hooks — a shell must supply BOTH or NEITHER (programming error). */
function seals(): boolean {
  const p = platform()
  const hasSeal = typeof p.sealSecret === 'function'
  const hasUnseal = typeof p.unsealSecret === 'function'
  if (hasSeal !== hasUnseal) {
    throw new Error('CorePlatform must supply both sealSecret and unsealSecret, or neither')
  }
  return hasSeal
}

const sealedFile = (dir: string): string => path.join(dir, 'node-auth-key.json')
const rawFile = (dir: string): string => path.join(dir, 'node-auth-key.bin')
const legacyFile = (dir: string): string => path.join(dir, 'codex-node-auth-key.json')

/** Decode a #167-shaped sealed body via the platform's unseal hook. Identical shape to
 *  the codex key so adoption reuses this exact path. */
function decodeSealed(raw: string): Buffer {
  const p = platform()
  let stored: StoredSecret
  try {
    stored = JSON.parse(raw) as StoredSecret
  } catch {
    throw new Error('node-auth key is malformed')
  }
  if (stored?.version !== 1 || typeof stored.secretKeyEnc !== 'string') {
    throw new Error('node-auth key is malformed')
  }
  const unsealed = p.unsealSecret!(Buffer.from(stored.secretKeyEnc, 'base64'))
  const secret = Buffer.from(unsealed.toString('utf8'), 'base64')
  if (secret.byteLength !== 32) throw new Error('node-auth key is invalid')
  return secret
}

/** Write bytes atomically: unique tmp with flag 'wx', chmod 0600, rename into place,
 *  unlink the tmp in finally. A reader never observes a partial file. */
async function persistFile(file: string, data: string | Buffer): Promise<void> {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  await fs.mkdir(path.dirname(file), { recursive: true })
  try {
    await fs.writeFile(tmp, data, { mode: 0o600, flag: 'wx' })
    await fs.rename(tmp, file)
    await fs.chmod(file, 0o600)
  } finally {
    await fs.unlink(tmp).catch(() => {})
  }
}

async function persistSealed(dir: string, secret: Buffer): Promise<void> {
  const p = platform()
  const secretKeyEnc = p.sealSecret!(Buffer.from(secret.toString('base64'), 'utf8')).toString('base64')
  const body: StoredSecret = { version: 1, secretKeyEnc }
  await persistFile(sealedFile(dir), `${JSON.stringify(body)}\n`)
}

/** Try to adopt #167's codex-node-auth-key.json (same secret signs codex thread→node
 *  records). Absent or unreadable → null, so the caller mints fresh rather than crashing. */
async function adoptLegacy(dir: string): Promise<Buffer | null> {
  try {
    return decodeSealed(await fs.readFile(legacyFile(dir), 'utf8'))
  } catch {
    return null
  }
}

async function loadSealed(dir: string): Promise<Buffer> {
  try {
    return decodeSealed(await fs.readFile(sealedFile(dir), 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const secret = (await adoptLegacy(dir)) ?? randomBytes(32)
  await persistSealed(dir, secret)
  return secret
}

async function loadRaw(dir: string): Promise<Buffer> {
  const file = rawFile(dir)
  try {
    const buf = await fs.readFile(file)
    if (buf.byteLength !== 32) throw new Error('node-auth key is invalid')
    return buf
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const secret = randomBytes(32)
  await persistFile(file, secret)
  return secret
}

/** Restart-stable 32-byte node-auth secret. Single-flight cached per userDataDir; a
 *  rejection clears the cache so a later call retries. */
export function loadOrCreateNodeAuthSecret(): Promise<Buffer> {
  const dir = platform().userDataDir
  if (cached && cachedDir === dir) return cached
  const pending = seals() ? loadSealed(dir) : loadRaw(dir)
  cached = pending
  cachedDir = dir
  pending.catch(() => {
    if (cached === pending) {
      cached = null
      cachedDir = ''
    }
  })
  return pending
}

export function resetNodeAuthSecretForTests(): void {
  cached = null
  cachedDir = ''
}
