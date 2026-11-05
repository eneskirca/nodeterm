import { afterEach, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { auditLegacyQueue, loadLegacyMailboxAudit, prepareMailboxLegacy, type LegacyMailboxRecord } from './agent-mailbox-legacy'
import { createLegacyMailboxViewHandler, registerLegacyMailboxViewIpc } from './agent-mailbox-legacy-view'
import type { PersistedQueueEntry } from './delivery-queue'
import type { LegacyMailboxViewReply } from '../../shared/agents/agent-mailbox-legacy'
import { IPC } from '../../shared/ipc'

const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map(d => fs.rm(d, { recursive: true, force: true }))) })
const body = 'SYNTHETIC PRIVATE OLD WORK: $(do-not-execute)'
function entry(omitted = false): PersistedQueueEntry {
  return { req: { verb: 'send', sourceNodeId: 'deleted-source', targetNodeId: 'deleted-target', sourceTitle: 'Historical source',
    body: omitted ? '' : body }, enqueuedAt: 1, ttlMs: 300000, queuedTraceId: omitted ? 'trace-two' : 'trace-one',
    ...(omitted ? { bodyOmitted: true as const } : { binding: { sessionId: 'historical-session', agentId: 'claude' } }) }
}
async function fixture() {
  let records: LegacyMailboxRecord[] = []
  const commit = vi.fn(async (next: readonly LegacyMailboxRecord[]) => { records = structuredClone([...next]) })
  await auditLegacyQueue({ load: async () => [entry(), entry(true)] }, { load: async () => [], commit }, () => 1000)
  commit.mockClear()
  const load = vi.fn(async () => records)
  let windowId: number | undefined = 41
  const handler = createLegacyMailboxViewHandler({ mainWindowId: () => windowId, load })
  return { handler, load, commit, records, window: (id: number | undefined) => { windowId = id } }
}
it('local recovery lists metadata without bodies and reads a held/unverified body by exact ID', async () => {
  const h = await fixture(), before = JSON.stringify(h.records)
  const list = await h.handler(41, { kind: 'list', limit: 1 })
  expect(list).toMatchObject({ ok: true, result: { schemaVersion: 1, records: [{ legacyId: h.records[0].legacyId,
    deliveryStatus: 'held', processingStatus: 'unacknowledged', unverified: true, sourceEvidence: 'missing',
    targetEvidence: 'recorded-unverified', bodyAvailable: true }] } })
  expect(JSON.stringify(list)).not.toContain(body)
  expect(JSON.stringify(list)).not.toContain('"body"')
  if (!list.ok || !('records' in list.result)) throw new Error('expected list')
  expect(await h.handler(41, { kind: 'list', cursor: list.result.cursor })).toMatchObject({ ok: true,
    result: { records: [{ legacyId: h.records[1].legacyId, bodyAvailable: false, missingBodyReason: 'omitted-by-legacy-queue' }] } })
  expect(await h.handler(41, { kind: 'read', legacyId: h.records[0].legacyId })).toMatchObject({ ok: true,
    result: { record: { body, sourceNodeId: 'deleted-source', targetNodeId: 'deleted-target', unverified: true } } })
  const absent = await h.handler(41, { kind: 'read', legacyId: h.records[1].legacyId })
  expect(absent).toMatchObject({ ok: true, result: { record: { bodyAvailable: false, missingBodyReason: 'omitted-by-legacy-queue' } } })
  expect(JSON.stringify(absent)).not.toContain('"body"')
  expect(JSON.stringify(h.records)).toBe(before)
  expect(h.commit).not.toHaveBeenCalled()
})
it('foreign WebContents, relay identities and absent MainWindow get no audit read or mutation', async () => {
  const h = await fixture()
  for (const sender of [0, 42, 999, NaN]) expect(await h.handler(sender, { kind: 'list' }))
    .toMatchObject({ ok: false, code: 'not-permitted' })
  expect(await h.handler(999, { kind: 'list', senderId: 41 })).toMatchObject({ ok: false, code: 'not-permitted' })
  h.window(undefined)
  expect(await h.handler(41, { kind: 'list' })).toMatchObject({ ok: false, code: 'not-permitted' })
  expect(h.load).not.toHaveBeenCalled(); expect(h.commit).not.toHaveBeenCalled()
})
it('refuses an ownership change while disk reading is in flight', async () => {
  const h = await fixture()
  h.load.mockImplementationOnce(async () => { h.window(42); return h.records })
  expect(await h.handler(41, { kind: 'read', legacyId: h.records[0].legacyId })).toMatchObject({ ok: false, code: 'not-permitted' })
})
it.each([
  { kind: 'ack' }, { kind: 'resend' }, { kind: 'rebind' }, { kind: 'read', legacyId: '../private' },
  { kind: 'list', limit: 0 }, { kind: 'list', limit: 101 }, { kind: 'list', limit: '1' },
  { kind: 'list', projectId: 'invented' }
])('rejects unknown/mutating or malformed requests before loading (%j)', async raw => {
  const h = await fixture()
  expect(await h.handler(41, raw)).toMatchObject({ ok: false, code: 'invalid-request' })
  expect(h.load).not.toHaveBeenCalled(); expect(h.commit).not.toHaveBeenCalled()
})
it('registers only a local IPC handler and uses Electron sender identity, never payload identity', async () => {
  const h = await fixture()
  let registered = '', callback: ((e: { sender: { id: number } }, raw: unknown) => Promise<LegacyMailboxViewReply>) | undefined
  registerLegacyMailboxViewIpc({ handle: (channel, fn) => { registered = channel; callback = fn } },
    { mainWindowId: () => 41, load: h.load })
  expect(registered).toBe(IPC.agentMailboxLegacyView)
  expect(await callback!({ sender: { id: 999 } }, { kind: 'list', senderId: 41 })).toMatchObject({ ok: false, code: 'not-permitted' })
  expect(h.load).not.toHaveBeenCalled()
  expect(await callback!({ sender: { id: 41 } }, { kind: 'list' })).toMatchObject({ ok: true })
  expect(h.commit).not.toHaveBeenCalled()
})
it('strict recovery reads do not rewrite, migrate, expire or execute file-backed historical work', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nt-legacy-view-')); dirs.push(dir)
  const root = path.join(dir, 'orchestration-state'); await fs.mkdir(root)
  const queue = path.join(root, 'delivery-queue.json'), audit = path.join(root, 'agent-mailbox-legacy.json')
  await fs.writeFile(queue, JSON.stringify({ kind: 'delivery-queue', version: 1, records: [entry()] }))
  await prepareMailboxLegacy(dir)
  const snapshot = await Promise.all([fs.readFile(queue, 'utf8'), fs.readFile(audit, 'utf8'), fs.readdir(root)])
  const handler = createLegacyMailboxViewHandler({ mainWindowId: () => 41, load: () => loadLegacyMailboxAudit(dir) })
  const records = await loadLegacyMailboxAudit(dir)
  expect(await handler(41, { kind: 'list' })).toMatchObject({ ok: true })
  expect(await handler(41, { kind: 'read', legacyId: records[0].legacyId })).toMatchObject({ ok: true, result: { record: { body } } })
  expect(await Promise.all([fs.readFile(queue, 'utf8'), fs.readFile(audit, 'utf8'), fs.readdir(root)])).toEqual(snapshot)
  await fs.writeFile(audit, '{"kind":"agent-mailbox-legacy","version":99,"records":[]}')
  expect(await handler(41, { kind: 'list' })).toMatchObject({ ok: false, code: 'store-unavailable' })
  expect(await fs.readFile(audit, 'utf8')).toContain('"version":99')
  expect(await fs.readdir(root)).toEqual(snapshot[2])
})
