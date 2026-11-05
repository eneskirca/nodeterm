import { constants, promises as fs } from 'node:fs'
import path from 'node:path'
import { renameAtomic, tempNameFor } from '../fs-atomic'
import type { PaneAdoptionRecord } from '../../shared/agents/pane-adoption'
import { validatePaneAdoptions, type PaneAdoptionStorage } from './pane-adoption'

const MAX_BYTES = 2 * 1024 * 1024
/** Domain codecs validate their own versioned envelope; filesystem ownership/CAS is shared. */
export interface PrivateRecordCodec<T> {
  decode(envelope: unknown): T[]
  encode(records: readonly T[]): Record<string, unknown>
}

/** Private main-owned records. Unknown, linked or unreadable storage never becomes an empty store.
 * The directory name is a fixed main-side constant, never a project/IPC path.
 */
export class PrivateRecordFileStore<T> {
  private available = false
  private stopped = false
  private expected: string | null | undefined
  private readonly dir: string
  private readonly file: string
  constructor(userDataDir: string, directory: string, private readonly codec: PrivateRecordCodec<T>) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,100}$/.test(directory)) throw new Error('Invalid private record directory')
    this.dir = path.join(userDataDir, directory); this.file = path.join(this.dir, 'records.json')
  }
  standDown(): void { this.stopped = true; this.available = false }
  private async privateDirectory(): Promise<void> {
    const stat = await fs.lstat(this.dir)
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) throw new Error('Unsafe pane adoption directory')
  }
  private async readRecordFile(): Promise<string | null> {
    let handle
    try { handle = await fs.open(this.file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
    try {
      const stat = await handle.stat(), named = await fs.lstat(this.file)
      if (!stat.isFile() || !named.isFile() || named.isSymbolicLink() || stat.ino !== named.ino || stat.dev !== named.dev || stat.size > MAX_BYTES || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) throw new Error('Unsafe pane adoption file')
      const text = await handle.readFile('utf8')
      if (Buffer.byteLength(text) > MAX_BYTES) throw new Error('Oversized pane adoption file')
      return text
    } finally { await handle.close() }
  }
  private async noWriter(): Promise<void> {
    try { await fs.lstat(path.join(this.dir, 'writer.lock')) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
    throw new Error('Pane adoption writer is unresolved')
  }
  async load(): Promise<T[]> {
    if (this.stopped) throw new Error('Pane adoption store unavailable')
    try {
      try { await this.privateDirectory() } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') { this.expected = null; this.available = true; return [] }
        throw error
      }
      await this.noWriter()
      const text = await this.readRecordFile()
      await this.noWriter()
      this.expected = text
      if (text === null) { this.available = true; return [] }
      const records = this.codec.decode(JSON.parse(text))
      if (!Array.isArray(records)) throw new Error('Invalid private record envelope')
      this.available = true
      return records
    } catch (error) { this.available = false; throw error }
  }
  async commit(records: readonly T[]): Promise<void> {
    if (!this.available || this.stopped) throw new Error('Pane adoption store unavailable')
    const text = JSON.stringify(this.codec.encode(records))
    if (Buffer.byteLength(text) > MAX_BYTES) throw new Error('Pane adoption quota exceeded')
    const tmp = tempNameFor(this.file)
    const lockPath = path.join(this.dir, 'writer.lock')
    let lock: Awaited<ReturnType<typeof fs.open>> | undefined
    try {
      await fs.mkdir(this.dir, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error })
      await this.privateDirectory()
      // One writer and exact compare against the bytes loaded by this instance. Never overwrite
      // another writer/user edit. A crash leaves a lock that requires explicit inspection.
      lock = await fs.open(lockPath, 'wx', 0o600)
      await lock.writeFile('private-record-transaction\n', 'utf8')
      await lock.sync()
      if (await this.readRecordFile() !== this.expected) throw new Error('Pane adoption storage changed')
      const handle = await fs.open(tmp, 'wx', 0o600)
      try { await handle.writeFile(text, 'utf8'); await handle.sync() } finally { await handle.close() }
      await this.privateDirectory()
      if (this.stopped) throw new Error('Pane adoption writer stood down')
      await renameAtomic(tmp, this.file)
      for (const dir of [this.dir, path.dirname(this.dir)]) {
        const handle = await fs.open(dir, 'r')
        try { await handle.sync() } finally { await handle.close() }
      }
      this.expected = text
    } catch (error) { this.available = false; await fs.rm(tmp, { force: true }).catch(() => {}); throw error }
    finally {
      if (lock) {
        try {
          const held = await lock.stat(), named = await fs.lstat(lockPath)
          if (held.ino !== named.ino || held.dev !== named.dev) throw new Error('Pane adoption writer lock changed')
          await fs.unlink(lockPath)
          const directory = await fs.open(this.dir, 'r')
          try { await directory.sync() } finally { await directory.close() }
        } catch (error) { this.available = false; throw error }
        finally { await lock.close().catch(() => {}) }
      }
    }
  }
}

/** Existing local schema and readable v1 history stay unchanged. */
export class PaneAdoptionFileStore extends PrivateRecordFileStore<PaneAdoptionRecord> implements PaneAdoptionStorage {
  constructor(userDataDir: string) {
    super(userDataDir, 'pane-ownership-adoptions', {
      decode: (raw) => {
        const envelope = raw as { kind?: unknown; version?: unknown; records?: unknown } | null
        const humanV1 = envelope?.kind === 'local-human-pane-adoptions' && envelope.version === 1
        const ownershipV2 = envelope?.kind === 'pane-ownership-proofs' && envelope.version === 2
        if (!envelope || Object.keys(envelope).length !== 3 || (!humanV1 && !ownershipV2)) throw new Error('Unknown pane adoption format')
        validatePaneAdoptions(envelope.records)
        if (humanV1 && envelope.records.some(record => record.provenance !== 'local-human-adoption')) throw new Error('Invalid v1 human provenance')
        return envelope.records
      },
      encode: (records) => {
        validatePaneAdoptions(records)
        return { kind: 'pane-ownership-proofs', version: 2, records }
      }
    })
  }
}
