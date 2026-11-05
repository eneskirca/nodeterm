import { describe, expect, it } from 'vitest'
import { mailboxQuotaCost, MAILBOX_CLOSED_TRANSPORT_RESERVE_BYTES, MAILBOX_MAX_BYTES,
  MAILBOX_MAX_MESSAGES, validateMailboxRecords, type MailboxStoredMessage } from './agent-mailbox-store'

function row(i = 0): MailboxStoredMessage {
  return { sendKey: `key-${i}`, fingerprint: 'a'.repeat(64), mutations: [], message: {
    messageId: `message-${i}`, idempotencyKey: `key-${i}`, revision: 1,
    source: { nodeId: 'source', projectId: 'project', sessionId: 'source-session', agentId: 'claude' },
    target: { nodeId: 'target', projectId: 'project', sessionId: 'target-session', agentId: 'claude' },
    body: 'SYNTHETIC preserved work', deliveryStatus: 'pending', processingStatus: 'unacknowledged', createdAt: 1, updatedAt: 1
  } }
}
const bytes = (r: unknown): number => Buffer.byteLength(JSON.stringify(r))
function closed(r: MailboxStoredMessage, status: 'completed' | 'rejected'): MailboxStoredMessage {
  const next = structuredClone(r)
  Object.assign(next.message, { processingStatus: status, claimId: 'claim', acceptedAt: 2, completedAt: 3, updatedAt: 3 })
  return next
}
function lateTransport(r: MailboxStoredMessage): MailboxStoredMessage {
  const next = structuredClone(r)
  // Largest allowed reason JSON representation, receipt fields and numeric growth, independent
  // of the production quota calculation. A late outcome cannot change processing or the ledger.
  Object.assign(next.message, { deliveryReason: '\0'.repeat(200), deliveryStatus: 'delivered', receipt: 'observed',
    receiptSignal: 'working', revision: Number.MAX_SAFE_INTEGER, updatedAt: Number.MAX_SAFE_INTEGER })
  return next
}
describe('mailbox lifecycle quota', () => {
  it('keeps a bounded 32-MiB profile store and the existing 4096-record cap', () => {
    expect(MAILBOX_MAX_BYTES).toBe(32 * 1024 * 1024)
    expect(MAILBOX_MAX_MESSAGES).toBe(4096)
  })
  it.each(['completed', 'rejected'] as const)('charges actual immutable %s history plus bounded late metadata', status => {
    const r = closed(row(), status)
    expect(mailboxQuotaCost([r])).toBe(bytes(r) + MAILBOX_CLOSED_TRANSPORT_RESERVE_BYTES)
    expect(mailboxQuotaCost([r])).toBeLessThan(mailboxQuotaCost([row()]) / 10)
    const late = lateTransport(r)
    validateMailboxRecords([late])
    expect(bytes(late)).toBeLessThanOrEqual(mailboxQuotaCost([r]))
    expect(bytes(late) - bytes(r)).toBeLessThanOrEqual(MAILBOX_CLOSED_TRANSPORT_RESERVE_BYTES)
  })
  it.each(['unacknowledged', 'accepted', 'blocked'] as const)('keeps full lifecycle space for %s even when transport is delivered', status => {
    const open = row()
    Object.assign(open.message, { processingStatus: status, deliveryStatus: 'delivered', receipt: 'observed',
      receiptSignal: 'newTurn', ...(status !== 'unacknowledged' ? { claimId: 'claim', acceptedAt: 2 } : {}) })
    validateMailboxRecords([open])
    expect(mailboxQuotaCost([open])).toBeGreaterThan(80 * 1024)
    expect(mailboxQuotaCost([closed(open, 'completed')])).toBeLessThan(mailboxQuotaCost([open]) / 10)
  })
  it('open reserve covers all 256 longest allowed mutation keys, a worst-case final note and transport', () => {
    const open = row(), complete = closed(open, 'completed')
    complete.message.note = '\0'.repeat(4096)
    complete.message.claimId = 'c'.repeat(200)
    complete.mutations = Array.from({ length: 256 }, (_, i) => ({ key: `key-${i}`.padEnd(64, 'x'), fingerprint: 'f'.repeat(64) }))
    const worst = lateTransport(complete)
    validateMailboxRecords([worst])
    // Closing must never increase the budget already promised at admission, including remaining
    // late metadata reserve; snapshots themselves must also fit under that promise.
    expect(mailboxQuotaCost([worst])).toBeLessThanOrEqual(mailboxQuotaCost([open]))
    expect(bytes(worst)).toBeLessThanOrEqual(mailboxQuotaCost([open]))
    expect(mailboxQuotaCost([complete])).toBeLessThanOrEqual(mailboxQuotaCost([open]))
  })
  it('4096 small completed records stay under budget without deleting their bodies or history', () => {
    const history = Array.from({ length: MAILBOX_MAX_MESSAGES }, (_, i) => closed(row(i), i % 2 ? 'completed' : 'rejected'))
    validateMailboxRecords(history)
    expect(mailboxQuotaCost(history)).toBeLessThan(MAILBOX_MAX_BYTES - 65536)
    expect(() => validateMailboxRecords([...history, closed(row(MAILBOX_MAX_MESSAGES), 'completed')])).toThrow()
    expect(history[0].message.body).toBe('SYNTHETIC preserved work')
  })
  it('the last admitted open snapshot remains below the file limit after every allowed lifecycle grows', () => {
    const budget = MAILBOX_MAX_BYTES - 65536
    // IDs and keys have fixed width so the boundary is exact, not a body-size approximation.
    const fixed = (i: number) => {
      const r = row(); r.message.messageId = `mail-${String(i).padStart(5, '0')}`
      r.sendKey = `key-${String(i).padStart(5, '0')}`; r.message.idempotencyKey = r.sendKey; return r
    }
    const unit = mailboxQuotaCost([fixed(0)]), boundary = Math.floor(budget / unit)
    expect(boundary).toBeGreaterThan(30)
    expect(boundary).toBeLessThan(MAILBOX_MAX_MESSAGES)
    const admitted = Array.from({ length: boundary }, (_, i) => fixed(i))
    expect(mailboxQuotaCost(admitted)).toBeLessThanOrEqual(budget)
    expect(mailboxQuotaCost([...admitted, fixed(boundary)])).toBeGreaterThan(budget)
    const completed = admitted.map(r => {
      const next = closed(r, 'completed'); next.message.note = '\0'.repeat(4096)
      next.mutations = Array.from({ length: 256 }, (_, i) => ({ key: `mutation-${i}`.padEnd(64, 'x'), fingerprint: 'e'.repeat(64) }))
      return lateTransport(next)
    })
    validateMailboxRecords(completed)
    expect(bytes({ kind: 'agent-mailbox', version: 1, records: completed })).toBeLessThan(MAILBOX_MAX_BYTES)
    expect(mailboxQuotaCost(completed)).toBeLessThanOrEqual(mailboxQuotaCost(admitted))
  })
})
