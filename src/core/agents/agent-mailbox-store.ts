import { promises as fs } from 'node:fs'
import path from 'node:path'
import { renameAtomic, tempNameFor } from '../fs-atomic'
import type { MailboxMessage } from '../../shared/agents/agent-mailbox'
import { isRecord as object } from '../../shared/is-record'

export interface MailboxMutation {
  key: string
  fingerprint: string
}
export interface MailboxStoredMessage {
  message: MailboxMessage
  sendKey: string
  fingerprint: string
  mutations: MailboxMutation[]
  attempting?: boolean
}
export interface MailboxStorage<T = MailboxStoredMessage> {
  load(): Promise<T[]>
  commit(records: readonly T[]): Promise<void>
}
export const MAILBOX_MAX_BYTES = 32 * 1024 * 1024
export const MAILBOX_MAX_MESSAGES = 4096
export const MAILBOX_BODY_MAX_BYTES = 64 * 1024
/** Closed work cannot acquire new notes, claims or mutation keys. A transport already in flight
 * (or restart recovery) can still add a reason/receipt and grow two integer fields. 2 KiB covers
 * a 200-code-unit reason even with six-byte JSON escapes (1200 bytes), receipt/status fields,
 * two maximum safe integers and their JSON keys. Existing payload and history are charged exactly.
 */
export const MAILBOX_CLOSED_TRANSPORT_RESERVE_BYTES = 2 * 1024
/** Open work reserves the complete bounded mutation ledger and worst-case JSON escaping of a
 * future note. Closed processing is immutable: only bounded late transport metadata can grow.
 * Admission budgets lifecycle space, so later ACK/completion cannot exhaust the mailbox quota.
 */
export function mailboxQuotaCost(records: readonly MailboxStoredMessage[]): number {
  return records.reduce((sum, r) => {
    if (r.message.processingStatus === 'completed' || r.message.processingStatus === 'rejected')
      return sum + Buffer.byteLength(JSON.stringify(r)) + MAILBOX_CLOSED_TRANSPORT_RESERVE_BYTES
    return sum + 80 * 1024 + Buffer.byteLength(JSON.stringify({ ...r,
      mutations: [], message: { ...r.message, note: undefined } }))
  }, 0)
}
const HASH = /^[a-f0-9]{64}$/
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/
const bounded = (v: unknown, n: number): v is string => typeof v === 'string' && v.length <= n
const integer = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0

function identity(v: unknown): boolean {
  return object(v) && ['nodeId', 'projectId', 'sessionId', 'agentId'].every(k =>
    typeof v[k] === 'string' && ID.test(v[k] as string))
}
function message(v: unknown): v is MailboxMessage {
  if (!object(v)) return false
  return typeof v.messageId === 'string' && ID.test(v.messageId) && bounded(v.idempotencyKey, 64) && ID.test(v.idempotencyKey) && integer(v.revision) && v.revision > 0 &&
    identity(v.source) && identity(v.target) && bounded(v.body, MAILBOX_BODY_MAX_BYTES) &&
    Buffer.byteLength(v.body) <= MAILBOX_BODY_MAX_BYTES && integer(v.createdAt) && integer(v.updatedAt) &&
    v.updatedAt >= v.createdAt && ['pending', 'queued', 'delivered', 'uncertain', 'failed'].includes(String(v.deliveryStatus)) &&
    ['unacknowledged', 'accepted', 'blocked', 'completed', 'rejected'].includes(String(v.processingStatus)) &&
    (v.inReplyTo === undefined || (typeof v.inReplyTo === 'string' && ID.test(v.inReplyTo))) &&
    (v.claimId === undefined || (typeof v.claimId === 'string' && ID.test(v.claimId))) &&
    (v.note === undefined || bounded(v.note, 4096)) &&
    (v.deliveryReason === undefined || bounded(v.deliveryReason, 200)) &&
    (v.acceptedAt === undefined || integer(v.acceptedAt)) && (v.completedAt === undefined || integer(v.completedAt)) &&
    (v.receipt === undefined || v.receipt === 'observed') &&
    (v.receiptSignal === undefined || ['newTurn', 'working'].includes(String(v.receiptSignal))) &&
    (v.processingStatus === 'unacknowledged' || typeof v.claimId === 'string') &&
    (!['completed', 'rejected'].includes(String(v.processingStatus)) || integer(v.completedAt))
}

/** All-or-nothing validation: accepted work is never silently dropped or truncated. */
export function validateMailboxRecords(raw: unknown): asserts raw is MailboxStoredMessage[] {
  if (!Array.isArray(raw) || raw.length > MAILBOX_MAX_MESSAGES) throw new Error('invalid mailbox records')
  const ids = new Set<string>(), keys = new Set<string>()
  for (const r of raw) {
    if (!object(r) || !message(r.message) || !bounded(r.sendKey, 64) || !ID.test(r.sendKey) ||
        typeof r.fingerprint !== 'string' || !HASH.test(r.fingerprint) || !Array.isArray(r.mutations) ||
        r.mutations.length > 256 || (r.attempting !== undefined && typeof r.attempting !== 'boolean'))
      throw new Error('invalid mailbox record')
    if (r.message.idempotencyKey !== r.sendKey) throw new Error('inconsistent mailbox key')
    const source = r.message.source
    const key = JSON.stringify([source.nodeId, source.projectId, source.sessionId, source.agentId, r.sendKey])
    if (ids.has(r.message.messageId) || keys.has(key)) throw new Error('duplicate mailbox identity')
    ids.add(r.message.messageId); keys.add(key)
    const mutationKeys = new Set<string>()
    for (const m of r.mutations) {
      if (!object(m) || typeof m.key !== 'string' || !ID.test(m.key) || m.key.length > 64 ||
          typeof m.fingerprint !== 'string' || !HASH.test(m.fingerprint) || mutationKeys.has(m.key))
        throw new Error('invalid mailbox mutation')
      mutationKeys.add(m.key)
    }
  }
}

export class MailboxCommitError extends Error {
  constructor(readonly uncertain: boolean) { super(uncertain ? 'mailbox commit uncertain' : 'mailbox store unavailable') }
}

/** Single writer supplied by the owning hook instance. No debouncing, no swallowed I/O failures.
 * A failed load/commit poisons this instance: it cannot overwrite an unread or uncertain store.
 * Windows has no portable directory fsync; renameAtomic gives its existing bounded retries.
 */
export class MailboxFileStore<T = MailboxStoredMessage> implements MailboxStorage<T> {
  readonly file: string
  private available = false
  private stoodDown = false
  private readonly kind: string
  private readonly maxBytes: number
  private readonly validate: (raw: unknown) => void
  constructor(userDataDir: string, spec?: {
    kind: string
    maxBytes: number
    validate(raw: unknown): asserts raw is T[]
  }) {
    this.kind = spec?.kind ?? 'agent-mailbox'
    if (!/^[a-z0-9-]+$/.test(this.kind)) throw new Error('invalid mailbox store kind')
    this.maxBytes = spec?.maxBytes ?? MAILBOX_MAX_BYTES
    this.validate = spec?.validate ?? validateMailboxRecords
    this.file = path.join(userDataDir, 'orchestration-state', `${this.kind}.json`)
  }
  standDown(): void { this.stoodDown = true; this.available = false }
  async load(): Promise<T[]> {
    if (this.stoodDown) throw new MailboxCommitError(false)
    let existed = false
    try {
      const stat = await fs.lstat(this.file)
      existed = true
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > this.maxBytes) throw new Error('invalid store file')
      const handle = await fs.open(this.file, 'r')
      let text: string
      try {
        const checked = await handle.stat()
        if (!checked.isFile() || checked.size > this.maxBytes) throw new Error('invalid store file')
        text = await handle.readFile('utf8')
      } finally { await handle.close() }
      if (Buffer.byteLength(text) > this.maxBytes) throw new Error('oversized store')
      const env: unknown = JSON.parse(text)
      if (!object(env) || env.kind !== this.kind || env.version !== 1) throw new Error('unknown mailbox format')
      this.validate(env.records)
      this.available = true
      return env.records as T[]
    } catch (e) {
      if (!existed && (e as NodeJS.ErrnoException).code === 'ENOENT') { this.available = true; return [] }
      this.available = false
      throw new MailboxCommitError(false)
    }
  }
  async commit(records: readonly T[]): Promise<void> {
    if (!this.available || this.stoodDown) throw new MailboxCommitError(false)
    this.validate(records)
    const text = JSON.stringify({ kind: this.kind, version: 1, records })
    if (Buffer.byteLength(text) > this.maxBytes) throw new Error('mailbox byte quota exceeded')
    const dir = path.dirname(this.file), tmp = tempNameFor(this.file)
    let published = false
    try {
      await fs.mkdir(dir, { recursive: true, mode: 0o700 })
      const handle = await fs.open(tmp, 'wx', 0o600)
      try { await handle.writeFile(text, 'utf8'); await handle.sync() } finally { await handle.close() }
      if (this.stoodDown) throw new Error('writer stood down')
      await renameAtomic(tmp, this.file)
      published = true
      if (process.platform !== 'win32') {
        const directory = await fs.open(dir, 'r')
        try { await directory.sync() } finally { await directory.close() }
        // The first commit may have created orchestration-state itself.
        const parent = await fs.open(path.dirname(dir), 'r')
        try { await parent.sync() } finally { await parent.close() }
      }
    } catch {
      this.available = false
      await fs.rm(tmp, { force: true }).catch(() => undefined)
      throw new MailboxCommitError(published)
    }
  }
}
