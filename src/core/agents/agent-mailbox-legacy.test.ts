import { afterEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { auditLegacyQueue, createDeliveryHintsFile, prepareMailboxLegacy, type LegacyMailboxRecord } from './agent-mailbox-legacy'
import type { PersistedQueueEntry } from './delivery-queue'
import type { MailboxStorage } from './agent-mailbox-store'

// Migration never resolves an agent profile, project or session. Only fabricated entries and
// private temporary files are used; neither HOME nor live Nodeterm paths are changed.
const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map(d => fs.rm(d, { recursive: true, force: true }))) })
function entry(): PersistedQueueEntry {
  return { req: { verb: 'send', sourceNodeId: 'old-source', targetNodeId: 'old-target', sourceTitle: 'Old source', body: 'pending work' },
    enqueuedAt: 1, ttlMs: 300000, queuedTraceId: 'old-trace', binding: { sessionId: 'old-session', agentId: 'codex' } }
}
function memoryAudit() {
  let disk: LegacyMailboxRecord[] = []
  const commit = vi.fn(async (rows: readonly LegacyMailboxRecord[]) => { disk = structuredClone([...rows]) })
  const store: MailboxStorage<LegacyMailboxRecord> = { load: async () => structuredClone(disk), commit }
  return { store, commit, disk: () => disk }
}
async function sourceFile(entries: unknown[]) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nt-mailbox-legacy-')); dirs.push(dir)
  const source = path.join(dir, 'orchestration-state', 'delivery-queue.json')
  await fs.mkdir(path.dirname(source))
  const text = JSON.stringify({ kind: 'delivery-queue', version: 1, savedAt: 123, records: entries })
  await fs.writeFile(source, text)
  return { dir, source, text }
}

describe('legacy queue startup barrier', () => {
  it('keeps expired work held, records absent source proof and never invents a current target', async () => {
    const audit = memoryAudit()
    const result = await auditLegacyQueue({ load: async () => [entry()] }, audit.store, () => 10 * 86400000)
    expect(result).toEqual({ held: 1, added: 1 })
    expect(audit.disk()[0]).toMatchObject({ deliveryStatus: 'held', processingStatus: 'unacknowledged',
      sourceEvidence: 'missing', targetEvidence: 'recorded-unverified', entry: entry() })
    expect(audit.disk()[0]).not.toHaveProperty('source')
    expect(audit.disk()[0]).not.toHaveProperty('target')
    expect(audit.disk()[0]).not.toHaveProperty('claimId')
  })
  it('repeated startup after commit preserves IDs and does not duplicate the audit', async () => {
    const audit = memoryAudit(), source = { load: async () => [entry()] }
    await auditLegacyQueue(source, audit.store, () => 100)
    const before = structuredClone(audit.disk())
    expect(await auditLegacyQueue(source, audit.store, () => 99999999)).toEqual({ held: 1, added: 0 })
    expect(audit.disk()).toEqual(before)
    expect(audit.commit).toHaveBeenCalledTimes(1)
  })
  it('preserves multiplicity, changed payloads and missing bodies without replacing prior evidence', async () => {
    const audit = memoryAudit(), one = entry()
    await auditLegacyQueue({ load: async () => [one, one] }, audit.store)
    expect(new Set(audit.disk().map(r => r.legacyId)).size).toBe(2)
    const changed = entry(); changed.req.body = ''; changed.bodyOmitted = true; delete changed.binding
    await auditLegacyQueue({ load: async () => [changed] }, audit.store)
    expect(audit.disk()).toHaveLength(3)
    expect(audit.disk()[2]).toMatchObject({ targetEvidence: 'missing', entry: { bodyOmitted: true } })
  })
  it('requires the confirmed audit commit before releasing the startup barrier', async () => {
    const audit = memoryAudit()
    audit.commit.mockRejectedValueOnce(new Error('disk full'))
    const restore = vi.fn()
    await expect(auditLegacyQueue({ load: async () => [entry()] }, audit.store).then(restore)).rejects.toThrow()
    expect(restore).not.toHaveBeenCalled()
    expect(audit.disk()).toHaveLength(0)
  })
  it('reads the old file without changes and gives the active hints queue no legacy entries', async () => {
    const { dir, source, text } = await sourceFile([entry()])
    expect(await prepareMailboxLegacy(dir)).toEqual({ held: 1, added: 1 })
    const auditFile = path.join(path.dirname(source), 'agent-mailbox-legacy.json')
    const persisted = JSON.parse(await fs.readFile(auditFile, 'utf8'))
    expect(persisted.records[0].entry).toEqual(entry())
    expect(await fs.readFile(source, 'utf8')).toBe(text)
    expect(await prepareMailboxLegacy(dir)).toEqual({ held: 1, added: 0 })
    const hints = createDeliveryHintsFile(dir)
    expect(hints.load()).toEqual([])
    hints.save([]); hints.dispose()
    expect(path.basename(hints.path)).toBe('delivery-hints.json')
    expect(await fs.readFile(source, 'utf8')).toBe(text)
    expect(await fs.readFile(auditFile, 'utf8')).toContain('"deliveryStatus":"held"')
  })
  it('fails closed on one malformed source row without dropping or sidelining the original', async () => {
    const { dir, source, text } = await sourceFile([entry(), { confirmedButUnreadable: true }])
    await expect(prepareMailboxLegacy(dir)).rejects.toThrow()
    expect(await fs.readFile(source, 'utf8')).toBe(text)
    expect(await fs.readdir(path.dirname(source))).toEqual(['delivery-queue.json'])
  })
  it('preserves an unknown audit format and blocks any fallback into the old scheduler', async () => {
    const { dir, source, text } = await sourceFile([entry()])
    const auditFile = path.join(path.dirname(source), 'agent-mailbox-legacy.json')
    const unknown = '{"kind":"agent-mailbox-legacy","version":99,"records":[]}'
    await fs.writeFile(auditFile, unknown)
    const restore = vi.fn()
    await expect(prepareMailboxLegacy(dir).then(restore)).rejects.toThrow()
    expect(restore).not.toHaveBeenCalled()
    expect(await fs.readFile(auditFile, 'utf8')).toBe(unknown)
    expect(await fs.readFile(source, 'utf8')).toBe(text)
  })
})
