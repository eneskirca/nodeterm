// Hosted teams this desktop has joined, one bookmark per host (keyed by hostId).
//
// The join code is PUBLIC material. The device token is a relay credential scoped to this device
// and that host: it lets us ASK to join (the host still decides who gets in), and minting a new one
// spends a damped free-tier mint, so it is kept rather than re-minted. It is a credential all the
// same, so the file is written 0600.
//
// `approvedAt` is the JOINER-SIDE pin: set once both humans approved this device on that host, it is
// what lets a reconnect confirm our half without a SAS dialog — but only for the exact host key it
// was recorded against (see hosted-join.ts). It deliberately does NOT live in the desktop's
// phone pin store (approved-devices.ts), which counts paired phones.
import { constants as fsConstants, promises as fs } from 'node:fs'
import { dirname } from 'node:path'
import { writeFileAtomic } from '../../core/fs-atomic'

export interface RelayBookmark {
  hostId: string
  /** The team's `nodeterm://join?code=…` string (public). */
  code: string
  /** The host's own label, from the code. */
  label: string
  /** This device's relay device token for that host, or null before the first mint. */
  deviceToken: string | null
  /** ISO time both humans first approved this device on that host, or null. */
  approvedAt: string | null
  source: 'code' | 'ssh'
}

/** What the renderer is shown of a bookmark: never its device token. */
export function publicBookmark(b: RelayBookmark): { hostId: string; label: string; approved: boolean; code: string } {
  return { hostId: b.hostId, label: b.label, approved: b.approvedAt !== null, code: b.code }
}

function valid(b: unknown): b is RelayBookmark {
  if (!b || typeof b !== 'object') return false
  const o = b as Record<string, unknown>
  return (
    typeof o.hostId === 'string' &&
    typeof o.code === 'string' &&
    typeof o.label === 'string' &&
    (o.deviceToken === null || typeof o.deviceToken === 'string') &&
    (o.approvedAt === null || typeof o.approvedAt === 'string') &&
    (o.source === 'code' || o.source === 'ssh')
  )
}

export class BookmarkStore {
  // Every write re-reads the file and is queued behind the previous one, so two concurrent writes
  // (a join persisting its token while an earlier join records its approval) never lose each other.
  private tail: Promise<unknown> = Promise.resolve()

  private readonly access: (p: string, mode: number) => Promise<void>

  /** @param file the bookmarks file; public so a refusal can name it (a path, never contents).
   *  @param io.access test seam for the directory check (`fs.access`). */
  constructor(
    readonly file: string,
    io: { access?: (p: string, mode: number) => Promise<void> } = {}
  ) {
    this.access = io.access ?? ((p, mode) => fs.access(p, mode))
  }

  /** The bookmarks on disk, for DISPLAY. A missing or unreadable file reads as none; malformed
   *  entries are dropped. Reading never writes. Never build a write on this: see `readForWrite`. */
  async list(): Promise<RelayBookmark[]> {
    try {
      const j = JSON.parse(await fs.readFile(this.file, 'utf-8')) as unknown
      return Array.isArray(j) ? j.filter(valid) : []
    } catch {
      return []
    }
  }

  /**
   * The bookmarks every write starts from. Only a MISSING file is "none". A file that cannot be read,
   * or does not parse, or holds an entry this build does not understand, rejects: rewriting it from
   * a guess would silently drop other teams' device tokens and approvals (unknown trust state is
   * never overwritten). The refusal names the file, never its contents: they hold tokens.
   *
   * It also refuses when no write could LAND: a readable file in a directory this process cannot
   * write to (a read-only mount, a root-owned data dir) reads fine and then fails every rename. A
   * join probes this before minting, so such a directory must answer here, not after a device mint
   * that nothing could keep (every launch would otherwise spend one of the team's damped mints).
   */
  async readForWrite(): Promise<RelayBookmark[]> {
    try {
      await this.access(dirname(this.file), fsConstants.W_OK)
    } catch (err) {
      throw new Error(`relay bookmarks directory is not writable (${(err as NodeJS.ErrnoException)?.code ?? 'unknown error'}); not writing to it`)
    }
    let raw: string
    try {
      raw = await fs.readFile(this.file, 'utf-8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return []
      throw new Error(`relay bookmarks could not be read (${(err as NodeJS.ErrnoException)?.code ?? 'unknown error'}); not rewriting them`)
    }
    let j: unknown
    try {
      j = JSON.parse(raw)
    } catch {
      throw new Error('relay bookmarks file is not valid JSON; not rewriting it')
    }
    if (!Array.isArray(j) || !j.every(valid)) throw new Error('relay bookmarks file holds entries this build cannot read; not rewriting it')
    return j
  }

  private write(fn: (l: RelayBookmark[]) => RelayBookmark[] | null): Promise<void> {
    const run = this.tail.then(async () => {
      const next = fn(await this.readForWrite())
      if (next) await writeFileAtomic(this.file, JSON.stringify(next, null, 2), { mode: 0o600 })
    })
    this.tail = run.catch(() => {})
    return run
  }

  /** Insert or replace the bookmark for `b.hostId`. */
  upsert(b: RelayBookmark): Promise<void> {
    return this.write((l) => [...l.filter((x) => x.hostId !== b.hostId), b])
  }

  /** Change fields of an EXISTING bookmark; a no-op when there is none, or when the stored one no
   *  longer satisfies `onlyIf`. For updates that follow a connection's events: a bookmark the user
   *  removed meanwhile is not brought back, and one another attempt rewrote is not clobbered. */
  update(
    hostId: string,
    patch: Partial<Pick<RelayBookmark, 'deviceToken' | 'approvedAt'>>,
    onlyIf: (current: RelayBookmark) => boolean = () => true
  ): Promise<void> {
    return this.write((l) => {
      const current = l.find((x) => x.hostId === hostId)
      if (!current || !onlyIf(current)) return null
      return l.map((x) => (x === current ? { ...x, ...patch } : x))
    })
  }

  remove(hostId: string): Promise<void> {
    return this.write((l) => l.filter((x) => x.hostId !== hostId))
  }
}
