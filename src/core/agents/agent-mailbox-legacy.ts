import { createHash } from 'node:crypto'
import { isRecord } from '../../shared/is-record'
import { DurableFactFile, DURABLE_STATE_MAX_BYTES } from '../durable-state'
import { QUEUE_FACT, QUEUE_PERSIST_MAX, sanitizePersistedQueueEntry, type PersistedQueueEntry } from './delivery-queue'
import { MailboxFileStore, type MailboxStorage } from './agent-mailbox-store'

/** An audit record, NOT a message addressed to a currently running agent. The old queue never
 * recorded a verified source project/session; its target binding is merely historical data.
 * Even a matching current session is not a migration authorization. No transport consumes this.
 */
export interface LegacyMailboxRecord {
  legacyId: string
  origin: 'delivery-queue-v1'
  deliveryStatus: 'held'
  processingStatus: 'unacknowledged'
  sourceEvidence: 'missing'
  targetEvidence: 'missing' | 'recorded-unverified'
  reason: 'missing-verified-project-and-session-bindings'
  importedAt: number
  occurrence: number
  entry: PersistedQueueEntry
}
const LEGACY_AUDIT_MAX_BYTES = 32 * 1024 * 1024

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (isRecord(value)) return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`
  return JSON.stringify(value)
}
function legacyId(entry: PersistedQueueEntry, occurrence: number): string {
  return `legacy-${createHash('sha256').update(canonical([entry, occurrence])).digest('hex')}`
}
export function validateLegacyQueue(raw: unknown): asserts raw is PersistedQueueEntry[] {
  if (!Array.isArray(raw) || raw.length > QUEUE_PERSIST_MAX || raw.some(r => !sanitizePersistedQueueEntry(r)))
    throw new Error('legacy queue cannot be losslessly audited')
}
export function validateLegacyMailbox(raw: unknown): asserts raw is LegacyMailboxRecord[] {
  if (!Array.isArray(raw) || raw.length > 4 * QUEUE_PERSIST_MAX) throw new Error('invalid legacy mailbox')
  const ids = new Set<string>()
  for (const r of raw) {
    if (!isRecord(r) || typeof r.legacyId !== 'string' || !/^legacy-[a-f0-9]{64}$/.test(r.legacyId) ||
        ids.has(r.legacyId) || r.origin !== 'delivery-queue-v1' || r.deliveryStatus !== 'held' ||
        r.processingStatus !== 'unacknowledged' || r.sourceEvidence !== 'missing' ||
        !['missing', 'recorded-unverified'].includes(String(r.targetEvidence)) ||
        r.reason !== 'missing-verified-project-and-session-bindings' ||
        !Number.isSafeInteger(r.importedAt) || Number(r.importedAt) < 0 || !sanitizePersistedQueueEntry(r.entry) ||
        !Number.isSafeInteger(r.occurrence) || Number(r.occurrence) < 0 || Number(r.occurrence) >= QUEUE_PERSIST_MAX ||
        r.legacyId !== legacyId(r.entry as PersistedQueueEntry, Number(r.occurrence)) ||
        r.targetEvidence !== ((r.entry as PersistedQueueEntry).binding?.sessionId ? 'recorded-unverified' : 'missing'))
      throw new Error('invalid legacy mailbox record')
    ids.add(r.legacyId)
  }
}

/** Startup barrier. The source is read ONLY: no DurableFactFile sanitizer that drops records,
 * sidelines corruption or rewrites the source. Commit the audit before any new queue can restore.
 * Multiplicity is preserved even for identical legacy rows. Retry after any interrupted startup
 * merges the same deterministic IDs; a changed payload never overwrites a previous witness.
 */
export async function auditLegacyQueue(
  source: Pick<MailboxStorage<PersistedQueueEntry>, 'load'>,
  audit: MailboxStorage<LegacyMailboxRecord>,
  now: () => number = Date.now
): Promise<{ held: number; added: number }> {
  const entries = await source.load()
  validateLegacyQueue(entries)
  const previous = await audit.load()
  validateLegacyMailbox(previous)
  const seen = new Set(previous.map(r => r.legacyId)), occurrences = new Map<string, number>()
  const next = previous.slice()
  for (const entry of entries) {
    const fingerprint = canonical(entry), occurrence = occurrences.get(fingerprint) ?? 0
    occurrences.set(fingerprint, occurrence + 1)
    const id = legacyId(entry, occurrence)
    if (seen.has(id)) continue
    next.push({ legacyId: id, origin: 'delivery-queue-v1', deliveryStatus: 'held', processingStatus: 'unacknowledged',
      sourceEvidence: 'missing', targetEvidence: entry.binding?.sessionId ? 'recorded-unverified' : 'missing',
      reason: 'missing-verified-project-and-session-bindings', importedAt: now(), occurrence, entry: structuredClone(entry) })
    seen.add(id)
  }
  if (next.length !== previous.length) await audit.commit(next)
  return { held: next.length, added: next.length - previous.length }
}

export async function prepareMailboxLegacy(userDataDir: string): Promise<{ held: number; added: number }> {
  const source = new MailboxFileStore<PersistedQueueEntry>(userDataDir, {
    kind: QUEUE_FACT.kind, maxBytes: DURABLE_STATE_MAX_BYTES, validate: validateLegacyQueue
  })
  const audit = legacyAuditFile(userDataDir)
  return auditLegacyQueue(source, audit)
}

function legacyAuditFile(userDataDir: string): MailboxFileStore<LegacyMailboxRecord> {
  return new MailboxFileStore<LegacyMailboxRecord>(userDataDir, {
    kind: 'agent-mailbox-legacy', maxBytes: LEGACY_AUDIT_MAX_BYTES, validate: validateLegacyMailbox
  })
}

/** Strict read-only recovery entry point. No source queue loading, migration or file mutation. */
export async function loadLegacyMailboxAudit(userDataDir: string): Promise<LegacyMailboxRecord[]> {
  return legacyAuditFile(userDataDir).load()
}

/** New volatile hints have a separate durable owner. The old delivery-queue file is never
 * restored into this queue or overwritten by it; historical work is owned solely by the audit.
 */
export function createDeliveryHintsFile(userDataDir: string): DurableFactFile<PersistedQueueEntry> {
  return new DurableFactFile({ ...QUEUE_FACT, kind: 'delivery-hints' }, { userDataDir })
}
