import { afterEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MailboxFileStore, MailboxCommitError, validateMailboxRecords, type MailboxStoredMessage } from './agent-mailbox-store'

// All I/O is under a private temporary directory; no profile APIs, agent modules or HOME reads.
const dirs: string[] = []
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(dirs.splice(0).map(d => fs.rm(d, { recursive: true, force: true }))) })
async function store() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nt-mailbox-store-')); dirs.push(dir)
  return { dir, file: new MailboxFileStore(dir) }
}
function row(): MailboxStoredMessage {
  return { sendKey: 'key', fingerprint: 'a'.repeat(64), mutations: [], message: {
    messageId: 'message1', idempotencyKey: 'key', revision: 1, source: { nodeId: 'a', projectId: 'p', sessionId: 'sa', agentId: 'codex' },
    target: { nodeId: 'b', projectId: 'p', sessionId: 'sb', agentId: 'codex' }, body: 'private text',
    deliveryStatus: 'queued', processingStatus: 'unacknowledged', createdAt: 1, updatedAt: 1
  } }
}
describe('strict mailbox file storage', () => {
  it('roundtrips without an expiry and writes private permissions', async () => {
    const { dir, file } = await store()
    expect(await file.load()).toEqual([])
    await file.commit([row()])
    expect(await new MailboxFileStore(dir).load()).toEqual([row()])
    if (process.platform !== 'win32') expect((await fs.stat(file.file)).mode & 0o777).toBe(0o600)
  })
  it.each(['not json', '{"kind":"agent-mailbox","version":99,"records":[]}',
    '{"kind":"agent-mailbox","version":1,"records":[{}]}'])('preserves an unreadable store and refuses writes (%s)', async text => {
    const { file } = await store()
    await fs.mkdir(path.dirname(file.file), { recursive: true })
    await fs.writeFile(file.file, text)
    await expect(file.load()).rejects.toBeInstanceOf(MailboxCommitError)
    await expect(file.commit([])).rejects.toBeInstanceOf(MailboxCommitError)
    expect(await fs.readFile(file.file, 'utf8')).toBe(text)
  })
  it('refuses record truncation, duplicate IDs and inconsistent mutation history', () => {
    expect(() => validateMailboxRecords([row(), row()])).toThrow()
    const r = row(); r.message.processingStatus = 'completed'
    expect(() => validateMailboxRecords([r])).toThrow()
  })
  it('surfaces an ENOSPC-style write failure and preserves the prior committed snapshot', async () => {
    const { dir, file } = await store(); await file.load(); await file.commit([row()])
    const originalOpen = fs.open.bind(fs)
    vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      if (args[1] === 'wx') throw Object.assign(new Error('disk full'), { code: 'ENOSPC' })
      return originalOpen(...args)
    })
    await expect(file.commit([])).rejects.toMatchObject({ uncertain: false })
    expect(await new MailboxFileStore(dir).load()).toEqual([row()])
    await expect(file.commit([])).rejects.toBeInstanceOf(MailboxCommitError)
  })
  it('a non-owning instance neither loads nor overwrites the store', async () => {
    const { file } = await store(); await file.load(); await file.commit([row()]); file.standDown()
    await expect(file.load()).rejects.toBeInstanceOf(MailboxCommitError)
    await expect(file.commit([])).rejects.toBeInstanceOf(MailboxCommitError)
  })
  it.skipIf(process.platform === 'win32')('reports uncertain if publication succeeded but the directory sync failed', async () => {
    const { dir, file } = await store(); await file.load(); await file.commit([row()])
    const originalOpen = fs.open.bind(fs)
    vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await originalOpen(...args)
      if (args[0] === path.dirname(file.file) && args[1] === 'r')
        handle.sync = async () => { throw new Error('directory sync failure') }
      return handle
    })
    await expect(file.commit([])).rejects.toMatchObject({ uncertain: true })
    expect(await new MailboxFileStore(dir).load()).toEqual([])
    await expect(file.commit([row()])).rejects.toBeInstanceOf(MailboxCommitError)
  })
})
