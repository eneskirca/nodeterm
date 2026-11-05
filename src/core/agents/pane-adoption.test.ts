import { describe, expect, it, vi } from 'vitest'
import { PaneAdoptionService, PANE_ADOPTION_DIALOG_MS, validatePaneAdoptions, type PaneAdoptionStorage } from './pane-adoption'
import type { LocalPaneIdentity, PaneAdoptionRecord } from '../../shared/agents/pane-adoption'

const identity = (): LocalPaneIdentity => ({ backend: 'local-session-host-linux', nodeId: 'node-a', projectId: 'private-a', projectCwd: '/synthetic/a',
  bootId: '11111111-1111-4111-8111-111111111111', host: { pid: 10, birth: '100' }, pane: { pid: 20, birth: '200' }, generation: 'generation-a',
  foreground: [{ pid: 30, birth: '300' }], agentId: 'codex', providerSessionId: 'provider-session-a' })
const request = { nodeId: 'node-a', projectId: 'private-a' }
function fixture(initial: PaneAdoptionRecord[] = []) {
  let disk = structuredClone(initial), current = identity(), windowId: number | undefined = 1, clock = 1000, wall = 1000, live = true, fresh: string | undefined
  const commit = vi.fn(async (records: readonly PaneAdoptionRecord[]) => { disk = structuredClone([...records]) })
  const storage: PaneAdoptionStorage = { load: async () => structuredClone(disk), commit }
  const confirm = vi.fn(async (_i: LocalPaneIdentity) => true)
  const capture = vi.fn(async (req: typeof request) => req.nodeId === current.nodeId && req.projectId === current.projectId ? structuredClone(current) : null)
  const deps = { storage, mainWindowId: () => windowId, capture, confirm, stillCurrent: (value: LocalPaneIdentity) => live && JSON.stringify(value) === JSON.stringify(current), freshOwner: () => fresh, now: () => wall, monotonicNow: () => clock, newId: () => '22222222-2222-4222-8222-222222222222' }
  return { service: new PaneAdoptionService(deps), deps, commit, confirm, capture, disk: () => disk,
    mutate: (fn: (i: LocalPaneIdentity) => void) => fn(current), setWindow: (id: number | undefined) => { windowId = id }, setClock: (n: number) => { clock = n; wall = n }, setWall: (n: number) => { wall = n }, setLive: (value: boolean) => { live = value }, setFresh: (value: string | undefined) => { fresh = value } }
}

describe('explicit local human pane adoption', () => {
  it('requires the local main window and exact request keys before any evidence or dialog', async () => {
    const f = fixture()
    expect(await f.service.request(2, request)).toMatchObject({ ok: false, code: 'not-permitted' })
    expect(await f.service.request(1, { ...request, approved: true })).toMatchObject({ ok: false, code: 'invalid-request' })
    expect(await f.service.request(1, { ...request, generation: 'injected' })).toMatchObject({ ok: false, code: 'invalid-request' })
    expect(f.capture).not.toHaveBeenCalled(); expect(f.confirm).not.toHaveBeenCalled(); expect(f.commit).not.toHaveBeenCalled()
  })
  it('persists a separate human provenance before publishing owner authority', async () => {
    const f = fixture()
    expect(f.service.owner('node-a')).toBeUndefined()
    expect(await f.service.request(1, request)).toMatchObject({ ok: true, result: { status: 'adopted', provenance: 'local-human-adoption' } })
    expect(f.confirm).toHaveBeenCalledTimes(1)
    expect(f.disk()).toHaveLength(1)
    expect(f.disk()[0]).toEqual({ grantId: '22222222-2222-4222-8222-222222222222', provenance: 'local-human-adoption', approvedAt: 1000, identity: identity() })
    expect(f.service.owner('node-a')).toBe('private-a')
    expect(await f.service.request(1, request)).toMatchObject({ ok: true, result: { status: 'already-approved' } })
    expect(f.confirm).toHaveBeenCalledTimes(1); expect(f.commit).toHaveBeenCalledTimes(1)
  })
  it('restores nothing from an attach/snapshot without a private proof or actual fresh authority', async () => {
    const f = fixture()
    await f.service.refresh(['node-a'])
    expect(f.service.owner('node-a')).toBeUndefined()
    expect(f.confirm).not.toHaveBeenCalled(); expect(f.commit).not.toHaveBeenCalled()
  })
  it('persists actual fresh-spawn authority after verified evidence without claiming human approval', async () => {
    const f = fixture(); f.setFresh('private-a')
    await f.service.refresh(['node-a'])
    expect(f.disk()).toEqual([{ grantId: '22222222-2222-4222-8222-222222222222', provenance: 'fresh-spawn', observedAt: 1000, identity: identity() }])
    expect(f.disk()[0]).not.toHaveProperty('approvedAt')
    expect(f.confirm).not.toHaveBeenCalled()
    await f.service.refresh(['node-a']); expect(f.commit).toHaveBeenCalledTimes(1)
    f.setFresh(undefined)
    const restarted = new PaneAdoptionService(f.deps)
    expect(restarted.owner('node-a')).toBeUndefined()
    await restarted.refresh(['node-a']); expect(restarted.owner('node-a')).toBe('private-a')
    expect(f.confirm).not.toHaveBeenCalled(); expect(f.commit).toHaveBeenCalledTimes(1)
  })
  it('never reports a restored fresh-spawn proof as an already confirmed human decision', async () => {
    const f = fixture(); f.setFresh('private-a'); await f.service.refresh(['node-a'])
    f.confirm.mockResolvedValue(false)
    expect(await f.service.request(1, request)).toMatchObject({ ok: false, code: 'cancelled' })
    expect(f.confirm).toHaveBeenCalledTimes(1)
    expect(f.disk()).toHaveLength(1); expect(f.disk()[0].provenance).toBe('fresh-spawn')
  })
  it.each([
    ['clone/private project', (i: LocalPaneIdentity) => { i.projectId = 'private-clone' }],
    ['new generation', (i: LocalPaneIdentity) => { i.generation = 'new-generation' }],
    ['reused host PID', (i: LocalPaneIdentity) => { i.host.birth = '101' }]
  ] as const)('does not restore a fresh proof from %s without a new actual spawn authority', async (_name, change) => {
    const f = fixture(); f.setFresh('private-a'); await f.service.refresh(['node-a']); f.setFresh(undefined)
    const g = fixture(f.disk()); g.mutate(change); await g.service.refresh(['node-a'])
    expect(g.service.owner('node-a')).toBeUndefined(); expect(g.commit).not.toHaveBeenCalled(); expect(g.confirm).not.toHaveBeenCalled()
  })
  it('requires actual fresh authority throughout capture and never saves unknown provider/OS evidence', async () => {
    const unknown = fixture(); unknown.setFresh('private-a'); unknown.capture.mockResolvedValue(null)
    await unknown.service.refresh(['node-a']); expect(unknown.commit).not.toHaveBeenCalled()
    const lost = fixture(); lost.setFresh('private-a'); let n = 0
    lost.capture.mockImplementation(async () => { if (++n === 2) lost.setFresh(undefined); return identity() })
    await lost.service.refresh(['node-a']); expect(lost.commit).not.toHaveBeenCalled(); expect(lost.service.owner('node-a')).toBeUndefined()
  })
  it('cancellation and an expired native decision create no grant', async () => {
    const cancelled = fixture(); cancelled.confirm.mockResolvedValue(false)
    expect(await cancelled.service.request(1, request)).toMatchObject({ ok: false, code: 'cancelled' })
    expect(cancelled.disk()).toEqual([])
    const expired = fixture(); expired.confirm.mockImplementation(async () => { expired.setClock(1000 + PANE_ADOPTION_DIALOG_MS + 1); return true })
    expect(await expired.service.request(1, request)).toMatchObject({ ok: false, code: 'expired' })
    expect(expired.disk()).toEqual([])
  })
  it('does not extend the approval deadline while a post-dialog identity probe is in flight', async () => {
    const f = fixture(); let captures = 0
    f.capture.mockImplementation(async () => { if (++captures === 2) f.setClock(1000 + PANE_ADOPTION_DIALOG_MS + 1); return identity() })
    expect(await f.service.request(1, request)).toMatchObject({ ok: false, code: 'expired' })
    expect(f.commit).not.toHaveBeenCalled()
  })
  it('uses monotonic elapsed time so resetting wall time cannot extend native approval', async () => {
    const f = fixture(); f.confirm.mockImplementation(async () => { f.setClock(1000 + PANE_ADOPTION_DIALOG_MS + 1); f.setWall(1000); return true })
    expect(await f.service.request(1, request)).toMatchObject({ ok: false, code: 'expired' })
    expect(f.commit).not.toHaveBeenCalled()
  })
  it.each([
    ['host PID reuse', (i: LocalPaneIdentity) => { i.host.birth = '101' }],
    ['PTY PID reuse', (i: LocalPaneIdentity) => { i.pane.birth = '201' }],
    ['foreground replacement', (i: LocalPaneIdentity) => { i.foreground[0].birth = '301' }],
    ['same-name generation replacement', (i: LocalPaneIdentity) => { i.generation = 'generation-b' }],
    ['provider-session switch', (i: LocalPaneIdentity) => { i.providerSessionId = 'provider-b' }],
    ['private-project switch', (i: LocalPaneIdentity) => { i.projectId = 'private-b' }],
    ['private-folder switch', (i: LocalPaneIdentity) => { i.projectCwd = '/synthetic/b' }]
  ] as const)('refuses %s during the human dialog', async (_name, change) => {
    const f = fixture(); f.confirm.mockImplementation(async () => { f.mutate(change); return true })
    expect(await f.service.request(1, request)).toMatchObject({ ok: false, code: 'identity-changed' })
    expect(f.commit).not.toHaveBeenCalled(); expect(f.service.owner('node-a')).toBeUndefined()
  })
  it('refuses a foreign private project or a conflicting fresh owner', async () => {
    const f = fixture()
    expect(await f.service.request(1, { ...request, projectId: 'foreign' })).toMatchObject({ ok: false, code: 'unsupported-evidence' })
    f.setFresh('foreign')
    expect(await f.service.request(1, request)).toMatchObject({ ok: false, code: 'ownership-conflict' })
    expect(f.confirm).not.toHaveBeenCalled(); expect(f.disk()).toEqual([])
  })
  it('rechecks window authority after async capture and after native confirmation', async () => {
    const f = fixture(); f.capture.mockImplementation(async () => { f.setWindow(2); return identity() })
    expect(await f.service.request(1, request)).toMatchObject({ ok: false, code: 'not-permitted' })
    expect(f.confirm).not.toHaveBeenCalled()
    const g = fixture(); g.confirm.mockImplementation(async () => { g.setWindow(undefined); return true })
    expect(await g.service.request(1, request)).toMatchObject({ ok: false, code: 'not-permitted' })
    expect(g.commit).not.toHaveBeenCalled()
  })
  it('allows only one pending native approval and does not enqueue a second dialog', async () => {
    const f = fixture(); let resolve!: (value: boolean) => void
    f.confirm.mockImplementation(() => new Promise<boolean>(done => { resolve = done }))
    const first = f.service.request(1, request)
    await vi.waitFor(() => expect(f.confirm).toHaveBeenCalledTimes(1))
    expect(await f.service.request(1, request)).toMatchObject({ ok: false, code: 'busy' })
    resolve(true)
    expect(await first).toMatchObject({ ok: true })
    expect(f.confirm).toHaveBeenCalledTimes(1); expect(f.commit).toHaveBeenCalledTimes(1)
  })
  it('never publishes authority after a failed commit or stand-down', async () => {
    const f = fixture(); f.commit.mockRejectedValue(new Error('disk full'))
    expect(await f.service.request(1, request)).toMatchObject({ ok: false, code: 'store-unavailable' })
    expect(f.service.owner('node-a')).toBeUndefined()
    f.service.standDown(); await f.service.refresh(['node-a'])
    expect(f.service.owner('node-a')).toBeUndefined()
  })
  it('cannot commit a late native decision after the service stood down', async () => {
    const f = fixture(); f.confirm.mockImplementation(async () => { f.service.standDown(); return true })
    expect(await f.service.request(1, request)).toMatchObject({ ok: false, code: 'store-unavailable' })
    expect(f.commit).not.toHaveBeenCalled(); expect(f.service.owner('node-a')).toBeUndefined()
  })
  it('restart requires the same prior project, host, generation, OS births and provider identity', async () => {
    const f = fixture(); await f.service.request(1, request)
    const restarted = new PaneAdoptionService(f.deps)
    expect(restarted.owner('node-a')).toBeUndefined()
    await restarted.refresh(['node-a']); expect(restarted.owner('node-a')).toBe('private-a')
    f.mutate(i => { i.foreground[0].birth = '999' })
    expect(restarted.owner('node-a')).toBeUndefined()
    await restarted.refresh(['node-a']); expect(restarted.owner('node-a')).toBeUndefined()
    expect(f.confirm).toHaveBeenCalledTimes(1)
    for (const mutate of [(i: LocalPaneIdentity) => { i.projectId = 'foreign' }, (i: LocalPaneIdentity) => { i.host.birth = '999' }, (i: LocalPaneIdentity) => { i.generation = 'other-generation' }]) {
      const g = fixture(f.disk()); g.mutate(mutate); await g.service.refresh(['node-a']); expect(g.service.owner('node-a')).toBeUndefined()
    }
  })
  it('rejects corrupt or forged-provenance storage instead of trusting it', async () => {
    const f = fixture(); await f.service.request(1, request)
    const forged = structuredClone(f.disk()); (forged[0] as unknown as { provenance: string }).provenance = 'fresh-spawn'
    expect(() => validatePaneAdoptions(forged)).toThrow()
    const g = fixture(forged)
    expect(await g.service.request(1, request)).toMatchObject({ ok: false, code: 'store-unavailable' })
    await g.service.refresh(['node-a']); expect(g.service.owner('node-a')).toBeUndefined()
  })
})
