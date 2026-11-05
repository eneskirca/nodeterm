import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { PaneAdoptionFileStore, PrivateRecordFileStore, type PrivateRecordCodec } from './pane-adoption-store'
import { PaneAdoptionService } from './pane-adoption'
import type { PaneAdoptionRecord } from '../../shared/agents/pane-adoption'

const record: PaneAdoptionRecord = { grantId: '22222222-2222-4222-8222-222222222222', provenance: 'local-human-adoption', approvedAt: 1000,
  identity: { backend: 'local-session-host-linux', nodeId: 'n1', projectId: 'p1', projectCwd: '/synthetic', bootId: '11111111-1111-4111-8111-111111111111',
    host: { pid: 10, birth: '100' }, pane: { pid: 20, birth: '200' }, foreground: [{ pid: 30, birth: '300' }], generation: 'generation-a', agentId: 'codex', providerSessionId: 'session-a' } }
describe.skipIf(process.platform !== 'linux')('private atomic ownership proofs', () => {
  let root: string
  const directory = () => path.join(root, 'pane-ownership-adoptions')
  const file = () => path.join(directory(), 'records.json')
  beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'pane-adoption-')) })
  afterEach(async () => { await fs.rm(root, { recursive: true, force: true }) })
  const otherCodec: PrivateRecordCodec<{ id: string }> = {
    decode: (raw) => {
      const e = raw as { kind?: unknown; version?: unknown; records?: unknown } | null
      if (!e || e.kind !== 'synthetic-observed-records' || e.version !== 1 || Object.keys(e).length !== 3 ||
          !Array.isArray(e.records) || e.records.some(r => !r || typeof r.id !== 'string' || Object.keys(r).length !== 1))
        throw new Error('Unknown synthetic observed records')
      return e.records
    },
    encode: (records) => {
      const envelope = { kind: 'synthetic-observed-records', version: 1, records }
      otherCodec.decode(envelope)
      return envelope
    }
  }
  it('shares private filesystem guarantees while keeping local and observer schemas separate', async () => {
    const local = new PaneAdoptionFileStore(root), other = new PrivateRecordFileStore(root, 'synthetic-observed-proofs', otherCodec)
    await local.load(); await other.load()
    await local.commit([record]); await other.commit([{ id: 'synthetic-launch' }])
    expect(await new PaneAdoptionFileStore(root).load()).toEqual([record])
    expect(await new PrivateRecordFileStore(root, 'synthetic-observed-proofs', otherCodec).load()).toEqual([{ id: 'synthetic-launch' }])
    const otherFile = path.join(root, 'synthetic-observed-proofs', 'records.json')
    expect((await fs.stat(otherFile)).mode & 0o777).toBe(0o600)
    const localBytes = await fs.readFile(file(), 'utf8')
    await fs.writeFile(otherFile, localBytes)
    await expect(new PrivateRecordFileStore(root, 'synthetic-observed-proofs', otherCodec).load()).rejects.toThrow('Unknown synthetic')
    expect(await fs.readFile(file(), 'utf8')).toBe(localBytes)
  })
  it('preserves independent compare-and-swap and unresolved-lock refusal for another codec', async () => {
    const first = new PrivateRecordFileStore(root, 'synthetic-observed-proofs', otherCodec),
      second = new PrivateRecordFileStore(root, 'synthetic-observed-proofs', otherCodec)
    await first.load(); await second.load(); await first.commit([{ id: 'first' }])
    await expect(second.commit([{ id: 'second' }])).rejects.toThrow('storage changed')
    const lock = path.join(root, 'synthetic-observed-proofs', 'writer.lock')
    await fs.writeFile(lock, 'unresolved', { mode: 0o600 })
    await expect(new PrivateRecordFileStore(root, 'synthetic-observed-proofs', otherCodec).load()).rejects.toThrow('writer is unresolved')
    expect(await fs.readFile(lock, 'utf8')).toBe('unresolved')
  })
  it.each(['', '.', '..', '../foreign', '/absolute', 'nested/path'])('refuses a nonliteral private directory %j', name => {
    expect(() => new PrivateRecordFileStore(root, name, otherCodec)).toThrow('Invalid private record directory')
  })
  it('commits a private versioned record and reads it after a simulated main restart', async () => {
    const store = new PaneAdoptionFileStore(root)
    expect(await store.load()).toEqual([])
    await store.commit([record])
    expect((await fs.stat(directory())).mode & 0o777).toBe(0o700)
    expect((await fs.stat(file())).mode & 0o777).toBe(0o600)
    expect(await new PaneAdoptionFileStore(root).load()).toEqual([record])
    expect(await fs.readdir(directory())).toEqual(['records.json'])
  })
  it('never overwrites corrupt/unknown storage as empty', async () => {
    await fs.mkdir(directory(), { mode: 0o700 }); await fs.writeFile(file(), '{bad', { mode: 0o600 })
    const store = new PaneAdoptionFileStore(root)
    await expect(store.load()).rejects.toThrow(); await expect(store.commit([record])).rejects.toThrow()
    expect(await fs.readFile(file(), 'utf8')).toBe('{bad')
  })
  it('refuses symlinked or nonprivate storage and leaves foreign data intact', async () => {
    const elsewhere = path.join(root, 'foreign'); await fs.mkdir(elsewhere, { mode: 0o700 }); await fs.writeFile(path.join(elsewhere, 'records.json'), 'foreign', { mode: 0o600 })
    await fs.symlink(elsewhere, directory())
    await expect(new PaneAdoptionFileStore(root).load()).rejects.toThrow()
    expect(await fs.readFile(path.join(elsewhere, 'records.json'), 'utf8')).toBe('foreign')
    await fs.unlink(directory()); await fs.mkdir(directory(), { mode: 0o755 })
    // mkdir respects the caller's umask; make the negative fixture genuinely nonprivate.
    await fs.chmod(directory(), 0o755)
    expect((await fs.stat(directory())).mode & 0o777).toBe(0o755)
    await expect(new PaneAdoptionFileStore(root).load()).rejects.toThrow()
  })
  it('refuses unknown record provenance before changing disk', async () => {
    const store = new PaneAdoptionFileStore(root); await store.load(); await store.commit([record])
    const before = await fs.readFile(file(), 'utf8')
    const bad = { ...record, provenance: 'fresh-spawn' } as unknown as PaneAdoptionRecord
    await expect(store.commit([bad])).rejects.toThrow()
    expect(await fs.readFile(file(), 'utf8')).toBe(before)
  })
  it('refuses a second writer that loaded stale bytes instead of losing an approved record', async () => {
    const first = new PaneAdoptionFileStore(root), second = new PaneAdoptionFileStore(root)
    await first.load(); await second.load(); await first.commit([record])
    await expect(second.commit([])).rejects.toThrow('storage changed')
    expect(await new PaneAdoptionFileStore(root).load()).toEqual([record])
  })
  it('does not automatically reclaim a writer lock left by an interrupted operation', async () => {
    await fs.mkdir(directory(), { mode: 0o700 }); await fs.writeFile(path.join(directory(), 'writer.lock'), 'unresolved', { mode: 0o600 })
    await expect(new PaneAdoptionFileStore(root).load()).rejects.toThrow('writer is unresolved')
    expect(await fs.readFile(path.join(directory(), 'writer.lock'), 'utf8')).toBe('unresolved')
  })
  it('refuses a linked record file and an unknown store version without replacing either', async () => {
    await fs.mkdir(directory(), { mode: 0o700 })
    const foreign = path.join(root, 'foreign.json'); await fs.writeFile(foreign, 'synthetic foreign data', { mode: 0o600 }); await fs.symlink(foreign, file())
    await expect(new PaneAdoptionFileStore(root).load()).rejects.toThrow()
    expect(await fs.readFile(foreign, 'utf8')).toBe('synthetic foreign data')
    await fs.unlink(file())
    const future = JSON.stringify({ kind: 'local-human-pane-adoptions', version: 99, records: [record] })
    await fs.writeFile(file(), future, { mode: 0o600 })
    const store = new PaneAdoptionFileStore(root)
    await expect(store.load()).rejects.toThrow('Unknown'); await expect(store.commit([])).rejects.toThrow()
    expect(await fs.readFile(file(), 'utf8')).toBe(future)
  })
  it('does not publish after the local writer stood down', async () => {
    const store = new PaneAdoptionFileStore(root); await store.load(); store.standDown()
    await expect(store.commit([record])).rejects.toThrow('unavailable')
    await expect(store.load()).rejects.toThrow('unavailable')
    await expect(fs.lstat(directory())).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it.each(['local-human-adoption', 'fresh-spawn'] as const)('restores a real %s file only for the same identity and leaves legacy bytes untouched', async provenance => {
    const legacy = path.join(root, 'orchestration-state', 'agent-mailbox-legacy.json')
    const held = '{"synthetic":"held/unacknowledged/unverified; never rebound"}\n'
    await fs.mkdir(path.dirname(legacy), { mode: 0o700 }); await fs.writeFile(legacy, held, { mode: 0o600 })
    let generation = record.identity.generation
    let fresh: string | undefined = provenance === 'fresh-spawn' ? 'p1' : undefined
    const deps = {
      mainWindowId: () => 1,
      capture: async () => ({ ...structuredClone(record.identity), generation }),
      stillCurrent: (i: typeof record.identity) => i.generation === generation,
      confirm: async () => { if (provenance === 'fresh-spawn') throw new Error('Fresh persistence must not claim human approval'); return true },
      freshOwner: () => fresh, now: () => 1000
    }
    const first = new PaneAdoptionService({ ...deps, storage: new PaneAdoptionFileStore(root) })
    if (provenance === 'fresh-spawn') await first.refresh(['n1'])
    else expect(await first.request(1, { nodeId: 'n1', projectId: 'p1' })).toMatchObject({ ok: true, result: { provenance: 'local-human-adoption' } })
    const stored = await new PaneAdoptionFileStore(root).load()
    expect(stored[0].provenance).toBe(provenance)
    if (provenance === 'fresh-spawn') expect(stored[0]).not.toHaveProperty('approvedAt')
    fresh = undefined // A new GUI has no current-run fresh-spawn ledger.
    const restarted = new PaneAdoptionService({ ...deps, storage: new PaneAdoptionFileStore(root) })
    expect(restarted.owner('n1')).toBeUndefined()
    await restarted.refresh(['n1']); expect(restarted.owner('n1')).toBe('p1')
    generation = 'replacement-generation'
    await restarted.refresh(['n1']); expect(restarted.owner('n1')).toBeUndefined()
    expect(await fs.readFile(legacy, 'utf8')).toBe(held)
  })
  it('stores fresh origin separately and reads genuine human v1 records without relabeling them', async () => {
    const store = new PaneAdoptionFileStore(root); await store.load()
    const fresh: PaneAdoptionRecord = { grantId: record.grantId, provenance: 'fresh-spawn', observedAt: 1000, identity: record.identity }
    await store.commit([fresh])
    const envelope = JSON.parse(await fs.readFile(file(), 'utf8'))
    expect(envelope.kind).toBe('pane-ownership-proofs'); expect(envelope.version).toBe(2)
    expect(envelope.records[0].provenance).toBe('fresh-spawn'); expect(envelope.records[0]).not.toHaveProperty('approvedAt')
    expect(await new PaneAdoptionFileStore(root).load()).toEqual([fresh])
    const v1 = JSON.stringify({ kind: 'local-human-pane-adoptions', version: 1, records: [record] })
    await fs.writeFile(file(), v1)
    expect(await new PaneAdoptionFileStore(root).load()).toEqual([record])
    expect(await fs.readFile(file(), 'utf8')).toBe(v1) // Read-only migration, no surprise write.
    await fs.writeFile(file(), JSON.stringify({ kind: 'local-human-pane-adoptions', version: 1, records: [fresh] }))
    await expect(new PaneAdoptionFileStore(root).load()).rejects.toThrow('v1 human provenance')
  })
})
