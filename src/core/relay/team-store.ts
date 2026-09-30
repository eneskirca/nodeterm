// The hosted team's membership: which device keys may auto-reconnect, with what role, and which
// projects non-editors may see. Pure transforms + a single-writer store.
//
// SEPARATE from the phone's remote-approved-phones.json on purpose: push's `hasPairedPhone` counts
// that file's entries, so a teammate's pin there would read as a paired phone.
//
// Corrupt ⇒ CLOSED: the file is set aside and the store starts with no peers, so nobody
// auto-reconnects. The owner recovers with `team add-owner` over SSH, which is also the
// root of trust.
import { promises as fs, existsSync } from 'node:fs'
import path from 'node:path'
import { writeFileAtomic, renameAtomic } from '../fs-atomic'
import { ensurePrivateDir } from './private-dir'

export type TeamRole = 'owner' | 'editor' | 'commenter' | 'viewer'
export const TEAM_ROLES: readonly TeamRole[] = ['owner', 'editor', 'commenter', 'viewer']
export interface TeamPeer { pubkeyB64: string; label: string; role: TeamRole; addedAt: string; addedBy: string }
export interface TeamDoc { v: 1; peers: TeamPeer[]; sharedProjects: string[] }

/** The longest member label `team.json` accepts. Exported so the admin CLI refuses what this reader would. */
export const TEAM_LABEL_MAX = 60
/** The longest shared project id `team.json` accepts. */
export const TEAM_PROJECT_ID_MAX = 128
const isStr = (v: unknown, max = 512): v is string => typeof v === 'string' && v.length > 0 && v.length <= max

export function emptyTeam(): TeamDoc {
  return { v: 1, peers: [], sharedProjects: [] }
}

export function parseTeam(raw: unknown): TeamDoc | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  if (o.v !== 1 || !Array.isArray(o.peers) || !Array.isArray(o.sharedProjects)) return null
  const peers: TeamPeer[] = []
  // A repeated key is corrupt, not deduped: `peerFor` takes the first entry, so keeping both would
  // let file ORDER decide whether a key is a viewer or an owner.
  const seen = new Set<string>()
  for (const p of o.peers) {
    if (!p || typeof p !== 'object') return null
    const q = p as Record<string, unknown>
    if (!isStr(q.pubkeyB64, 64) || typeof q.label !== 'string' || q.label.length > TEAM_LABEL_MAX) return null
    if (!(TEAM_ROLES as readonly unknown[]).includes(q.role)) return null
    if (!isStr(q.addedAt, 40) || !isStr(q.addedBy, 64)) return null
    if (seen.has(q.pubkeyB64)) return null
    seen.add(q.pubkeyB64)
    peers.push({ pubkeyB64: q.pubkeyB64, label: q.label, role: q.role as TeamRole, addedAt: q.addedAt, addedBy: q.addedBy })
  }
  if (!o.sharedProjects.every((s) => isStr(s, TEAM_PROJECT_ID_MAX))) return null
  return { v: 1, peers, sharedProjects: [...new Set(o.sharedProjects as string[])] }
}

export function peerFor(doc: TeamDoc, pubkeyB64: string): TeamPeer | undefined {
  return doc.peers.find((p) => p.pubkeyB64 === pubkeyB64)
}

export function upsertPeer(doc: TeamDoc, p: TeamPeer): TeamDoc {
  const label = p.label.slice(0, TEAM_LABEL_MAX)
  return { ...doc, peers: [...doc.peers.filter((x) => x.pubkeyB64 !== p.pubkeyB64), { ...p, label }] }
}

export function removePeer(doc: TeamDoc, pubkeyB64: string, force: boolean): TeamDoc | 'last-owner' {
  if (!peerFor(doc, pubkeyB64)) return doc
  const rest = doc.peers.filter((p) => p.pubkeyB64 !== pubkeyB64)
  // "Would an owner remain?", not "is this the only owner ENTRY?". `parseTeam` refuses a repeated
  // key, so this only guards an in-memory doc that lists one: counting entries would let this
  // removal (which drops every entry for the key) leave a team that had an owner with none.
  const hadOwner = doc.peers.some((p) => p.role === 'owner')
  if (hadOwner && !rest.some((p) => p.role === 'owner') && !force) return 'last-owner'
  return { ...doc, peers: rest }
}

export function setShared(doc: TeamDoc, projectId: string, on: boolean): TeamDoc {
  const rest = doc.sharedProjects.filter((p) => p !== projectId)
  return { ...doc, sharedProjects: on ? [...rest, projectId] : rest }
}

export class TeamStore {
  private doc: TeamDoc = emptyTeam()
  /** Whether `doc` reflects the file. Until it does, a write would publish the in-memory empty
   *  doc OVER the real team (an admin `add-owner` while `start()` never loaded is the case). */
  private loaded = false
  private tail: Promise<unknown> = Promise.resolve()
  constructor(private readonly dir: string) {}
  private file(): string { return path.join(this.dir, 'team.json') }
  exists(): boolean { return existsSync(this.file()) }
  current(): TeamDoc { return this.doc }

  /** Queued behind every earlier update, so it never hands back (or resets `current()` to) a file
   *  a queued write is about to replace — the next update would compute from that stale doc. */
  load(): Promise<TeamDoc> {
    return this.serialize(() => this.read())
  }

  update(fn: (d: TeamDoc) => TeamDoc | 'last-owner'): Promise<TeamDoc | 'last-owner'> {
    return this.serialize(async () => {
      // Lazily, INSIDE the chain: a failed read rejects this update and leaves `loaded` false, so
      // nothing is written over a file we could not read and the next update tries again.
      if (!this.loaded) await this.read()
      const next = fn(this.doc)
      if (next === 'last-owner') return next
      // Never publish what our own reader rejects: the write would land, and the NEXT load would set
      // the whole team aside as corrupt. Throwing here leaves both the file and `this.doc` as they were.
      if (!parseTeam(next)) throw new Error('team.json: refusing to write a team doc that fails validation')
      ensurePrivateDir(this.dir)
      await writeFileAtomic(this.file(), JSON.stringify(next, null, 2) + '\n', { mode: 0o600 })
      this.doc = next
      return next
    })
  }

  private serialize<T>(op: () => Promise<T>): Promise<T> {
    const run = this.tail.then(op)
    this.tail = run.catch(() => {})
    return run
  }

  /** The unqueued read. Only ever called from inside `serialize`. */
  private async read(): Promise<TeamDoc> {
    let raw: string
    try {
      raw = await fs.readFile(this.file(), 'utf-8')
    } catch (err) {
      // Unreadable is not absent (#385): refuse rather than start empty over it.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
      return this.adopt(emptyTeam())
    }
    let parsed: TeamDoc | null = null
    try { parsed = parseTeam(JSON.parse(raw)) } catch { parsed = null }
    if (!parsed) {
      await renameAtomic(this.file(), `${this.file()}.corrupt-${Date.now()}`)
      return this.adopt(emptyTeam())
    }
    return this.adopt(parsed)
  }

  private adopt(doc: TeamDoc): TeamDoc {
    this.doc = doc
    this.loaded = true
    return doc
  }
}
