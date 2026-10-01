// Active live links survive an app restart (spec D8). The secret is sealed through the platform's
// secret seam: Electron safeStorage on the desktop, and ABSENT on the Server Edition by design
// (headless, no keychain: raw bytes in a 0600 file, the same rule as its node secrets). On the
// desktop there is no plaintext fallback: if sealing throws, a link that was never sealed is not
// written (it lives in memory for this run; see R45 below for the ones that were); a raw secret found
// on a desktop is refused, never adopted.
//
// What is sealed is the BASE64 TEXT of the secret, never its bytes. The desktop seam is a string
// seam (`safeStorage.encryptString(b.toString('utf8'))` / `Buffer.from(decryptString(b), 'utf8')`),
// so 32 random bytes — almost never valid UTF-8 — come back as different bytes of a different
// length. Same convention as src/core/agents/node-auth-secret.ts. Unsealed entries (Server Edition)
// are the base64 of the raw bytes.
//
// The store never writes over a file it could not read. Only ENOENT means "no links". Any other
// read error, a file over 1 MiB, or a version other than 1 makes `load()` reject and LATCHES the
// store: every later `save()` resolves 'failed' without touching disk, so the file survives for the
// next boot or a newer build. JSON that does not parse is set aside as `<file>.corrupt-<ts>` and the
// store starts empty; if the set-aside fails, the same latch applies.
//
// Loads and saves are SERIALIZED, in call order, on one chain: each waits for the previous one to
// settle. Two overlapping atomic writes can still complete out of order, and the older snapshot would
// then be what stays on disk — a revoked link resurrected at the next boot. And a save issued while a
// load is still reading must not run before that load's verdict: it would write over a file the load
// is about to refuse (a slow EACCES/EIO, a newer build's version), or land between reading a corrupt
// file and setting it aside. The snapshot is taken (and sealed) when `save` is CALLED, so disk order
// is call order; a failed load or write never breaks the chain for what follows.
//
// OPAQUE ENTRIES (controller ruling R42). A sealed secret the keychain REFUSES to unseal this run
// (locked at login, or reset) says nothing about whether the link is gone: the next run may unseal it.
// So such an entry is kept exactly as it was read — never returned by `load()` (nothing can host a
// link without its secret), never erased by a `save()` — and carried back verbatim on every write
// until its own `expiresAt` passes; the first write after that drops it. A sealed secret that unseals
// but is malformed, and a raw secret found on a desktop, are not opaque: they are dropped as before.
// `discardOpaque()` is for "Stop all", whose server revoke has ended every link of the license.
//
// A KEYCHAIN THAT STOPS SEALING MID-RUN (controller ruling R45). The store keeps the sealed form of
// every secret it read or sealed this run and reuses it on every write (it never re-seals), so when
// `seal` starts throwing only a link it NEVER sealed is left out (reported 'memory-only'); links read
// at boot and links sealed earlier stay on disk, and a link no longer in the list is still dropped.
import { promises as fs } from 'node:fs'
import { createHash } from 'node:crypto'
import { renameAtomic, writeFileAtomic } from '../fs-atomic'
import { LINK_ID_RE } from '../../shared/watch-link/link'
import type { WatchLinkRole } from '../../shared/watch-link/protocol'
import { isSafeNodeId } from '../../shared/safe-id'

export interface WatchLinkRecord {
  linkId: string
  nodeId: string
  role: WatchLinkRole
  label: string
  title: string
  createdAt: number
  expiresAt: number
  secret: Uint8Array
}
export type SaveOutcome = 'saved' | 'memory-only' | 'failed'

export type WatchLinkStoreUnreadableReason = 'read-error' | 'too-large' | 'unknown-version' | 'set-aside-failed'

/** `load()` could not read the file and will not write over it: the store is now latched. */
export class WatchLinkStoreUnreadable extends Error {
  constructor(
    readonly reason: WatchLinkStoreUnreadableReason,
    message: string,
    options?: { cause?: unknown }
  ) {
    super(message, options)
    this.name = 'WatchLinkStoreUnreadable'
  }
}

/** A DIGEST of a secret (never its text or bytes: the cache must not be a second plaintext copy)
 *  and the sealed text the file holds for it. */
interface SealedForm {
  digest: string
  sealed: string
}
const digestOf = (secret: Uint8Array): string => createHash('sha256').update(secret).digest('hex')

interface FileEntry {
  linkId: string
  nodeId: string
  role: WatchLinkRole
  label: string
  title: string
  createdAt: number
  expiresAt: number
  secret: string
  sealed: boolean
}

/** A machine holds a handful of links; anything near this is a hand edit, not our file. */
export const MAX_FILE_BYTES = 1024 * 1024
/** Entries past this are dropped on read. */
export const MAX_ENTRIES = 200
const SECRET_BYTES = 32
const noop = (): void => {}

const str = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const codeOf = (e: unknown): string =>
  typeof e === 'object' && e && 'code' in e ? String((e as { code: unknown }).code) : ''

/** Base64 text → the 32-byte secret, or null. Canonical text only: Node's base64 decoder skips
 *  characters it does not know, so a mangled string could otherwise decode to *some* bytes. */
function decodeSecret(text: string): Uint8Array | null {
  const bytes = Buffer.from(text, 'base64')
  if (bytes.length !== SECRET_BYTES) return null
  if (bytes.toString('base64') !== text) return null
  return new Uint8Array(bytes)
}

export class WatchLinkStore {
  /** The previous load or write, settled either way: the next one starts only after it. */
  private writing: Promise<void> = Promise.resolve()
  /** False once `load()` found a file it could not read: never write over it this run. */
  private writable = true
  /** Valid entries whose sealed secret this run could not unseal (R42), carried back on every write
   *  until their own `expiresAt`. Set by each `load()`. */
  private opaque: FileEntry[] = []
  /** The sealed form of every secret this run read or sealed, by link id, with a digest of the secret
   *  it seals (R45): reused on every write, so a keychain that starts refusing mid-run costs only a
   *  link it never sealed. Replaced by each save's list, so a stopped link's form goes with it. */
  private sealedForms = new Map<string, SealedForm>()

  constructor(
    private readonly o: {
      file: string
      seal?: (b: Buffer) => Buffer
      unseal?: (b: Buffer) => Buffer
      /** Clock for dropping an opaque entry past its `expiresAt` (tests). */
      now?: () => number
    }
  ) {}

  /** Forget every opaque entry: the next write leaves them out ("Stop all" revoked them server-side). */
  discardOpaque(): void {
    this.opaque = []
  }

  /** How many opaque entries are still carried (not past their own expiry): links this machine holds
   *  but cannot host this run. They count against the per-machine cap (R46), or a run with a locked
   *  keychain could create five more and the next launch would find ten. */
  opaqueCount(): number {
    const t = (this.o.now ?? Date.now)()
    return this.opaque.filter((e) => e.expiresAt > t).length
  }

  load(): Promise<WatchLinkRecord[]> {
    const loading = this.writing.then(() => this.read())
    this.writing = loading.then(noop, noop)
    return loading
  }

  private async read(): Promise<WatchLinkRecord[]> {
    let text: string
    try {
      const handle = await fs.open(this.o.file, 'r')
      try {
        const { size } = await handle.stat()
        if (size > MAX_FILE_BYTES) {
          throw this.latch('too-large', `${this.o.file} is ${size} bytes, over the ${MAX_FILE_BYTES}-byte limit`)
        }
        text = await handle.readFile('utf8')
      } finally {
        await handle.close().catch(() => {})
      }
    } catch (e) {
      if (e instanceof WatchLinkStoreUnreadable) throw e
      if (codeOf(e) === 'ENOENT') return []
      throw this.latch('read-error', `could not read ${this.o.file}: ${(e as Error)?.message ?? e}`, e)
    }

    let body: unknown
    try {
      body = JSON.parse(text.replace(/\r\n/g, '\n'))
    } catch {
      body = undefined
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      // Not JSON, or JSON that cannot be any version of this envelope: keep a copy, start empty.
      await this.setAside()
      return []
    }
    const { v, links } = body as { v?: unknown; links?: unknown }
    if (v !== 1) throw this.latch('unknown-version', `${this.o.file} has version ${JSON.stringify(v)}, expected 1`)

    const out: WatchLinkRecord[] = []
    const opaque: FileEntry[] = []
    const sealedForms = new Map<string, SealedForm>()
    for (const e of Array.isArray(links) ? (links.slice(0, MAX_ENTRIES) as Partial<FileEntry>[]) : []) {
      if (!e || !str(e.linkId, 22) || !LINK_ID_RE.test(e.linkId)) continue
      // `isSafeNodeId` does not check the type: `12` and `["n1"]` pass its regex by coercion.
      if (typeof e.nodeId !== 'string' || !isSafeNodeId(e.nodeId)) continue
      if (e.role !== 'viewer' && e.role !== 'commenter') continue
      if (!str(e.label, 40) || !str(e.title, 80) || !num(e.createdAt) || !num(e.expiresAt) || typeof e.secret !== 'string') continue
      const sealed = e.sealed === true
      const secret = this.readSecret(e.secret, sealed)
      if (secret === 'refused') {
        opaque.push({
          linkId: e.linkId, nodeId: e.nodeId, role: e.role, label: e.label, title: e.title,
          createdAt: e.createdAt, expiresAt: e.expiresAt, secret: e.secret, sealed: true
        })
        continue
      }
      if (!secret) continue
      if (sealed) sealedForms.set(e.linkId, { digest: digestOf(secret), sealed: e.secret })
      out.push({ linkId: e.linkId, nodeId: e.nodeId, role: e.role, label: e.label, title: e.title, createdAt: e.createdAt, expiresAt: e.expiresAt, secret })
    }
    this.opaque = opaque
    this.sealedForms = sealedForms
    return out
  }

  private latch(reason: WatchLinkStoreUnreadableReason, message: string, cause?: unknown): WatchLinkStoreUnreadable {
    this.writable = false
    return new WatchLinkStoreUnreadable(reason, message, cause === undefined ? undefined : { cause })
  }

  private async setAside(): Promise<void> {
    const aside = `${this.o.file}.corrupt-${Date.now()}`
    try {
      await renameAtomic(this.o.file, aside)
    } catch (e) {
      throw this.latch('set-aside-failed', `${this.o.file} does not parse and could not be set aside as ${aside}`, e)
    }
  }

  /** The secret; null for a malformed one (dropped); 'refused' for a sealed one this run cannot
   *  unseal — no keychain here, or it refused (kept as an opaque entry, R42). */
  private readSecret(stored: string, sealed: boolean): Uint8Array | null | 'refused' {
    if (sealed) {
      if (!this.o.unseal) return 'refused'
      let text: string
      try {
        text = this.o.unseal(Buffer.from(stored, 'base64')).toString('utf8')
      } catch {
        return 'refused'
      }
      return decodeSecret(text)
    }
    // A desktop (it can seal) never adopts a raw secret it finds on disk.
    return this.o.seal ? null : decodeSecret(stored)
  }

  /** The opaque entries this write carries: none past its own expiry (dropped for good), none a live
   *  record replaces. */
  private carriedOpaque(live: readonly FileEntry[]): FileEntry[] {
    const t = (this.o.now ?? Date.now)()
    this.opaque = this.opaque.filter((e) => e.expiresAt > t)
    const ids = new Set(live.map((e) => e.linkId))
    return this.opaque.filter((e) => !ids.has(e.linkId))
  }

  async save(records: readonly WatchLinkRecord[]): Promise<SaveOutcome> {
    const links: FileEntry[] = []
    let outcome: SaveOutcome = 'saved'
    // Only the records in THIS list keep a cached sealed form: a stopped link's goes with it.
    const sealedNext = new Map<string, SealedForm>()
    try {
      for (const r of records) {
        const text = Buffer.from(r.secret).toString('base64')
        let secret = text
        if (this.o.seal) {
          const known = this.sealedForms.get(r.linkId)
          const digest = digestOf(r.secret)
          if (known && known.digest === digest) {
            // Never re-sealed: the form read at boot or sealed earlier this run is still valid, and a
            // keychain that has started refusing must not cost a link it already holds sealed (R45).
            secret = known.sealed
          } else {
            try {
              secret = this.o.seal(Buffer.from(text, 'utf8')).toString('base64')
            } catch {
              // The keychain refused and this link was never sealed: no plaintext fallback. It is left
              // out of the file (it lives in memory this run); every other link is written.
              outcome = 'memory-only'
              continue
            }
          }
          sealedNext.set(r.linkId, { digest, sealed: secret })
        }
        links.push({
          linkId: r.linkId, nodeId: r.nodeId, role: r.role, label: r.label, title: r.title,
          createdAt: r.createdAt, expiresAt: r.expiresAt, secret, sealed: !!this.o.seal
        })
      }
    } catch {
      // Not a seal failure (a malformed record): leave the old file exactly as it is.
      return 'failed'
    }
    if (this.o.seal) this.sealedForms = sealedNext
    // Everything above ran synchronously at call time, so the chain is extended in call order. The
    // opaque entries are joined at WRITE time: a save issued while a load was still reading carries
    // what that load found.
    const write = this.writing.then(() => {
      if (!this.writable) throw new Error('watch-link store is latched: it could not read its file')
      const data = JSON.stringify({ v: 1, links: [...links, ...this.carriedOpaque(links)] })
      return writeFileAtomic(this.o.file, data, { mode: 0o600 })
    })
    this.writing = write.catch(() => {})
    try {
      await write
      return outcome
    } catch {
      return 'failed'
    }
  }
}
