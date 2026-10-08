import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import nodeFs, { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { initPlatform, resetPlatformForTests } from './platform'
import { fakePlatform } from './platform-fake'
import { WorkspaceStore, type RemoteWorkspaceIO } from './workspace-store'
import { readSshActionFile, SshActionsService, SSH_ACTIONS_MAX_BYTES, SSH_ACTIONS_RETRY_MS, safeSshActionStat, startSshActionsService } from './ssh-actions'
import type { Project, Workspace } from '../shared/types'

let root: string
let cwd: string
let fake: ReturnType<typeof fakePlatform>
let store: WorkspaceStore
let service: SshActionsService
const node = { id: 'term-one', kind: 'terminal', position: { x: 0, y: 0 }, size: { width: 1, height: 1 }, title: 'one', color: '#fff', group: null } as const
const project = (extra: Partial<Project> = {}): Project => ({ id: 'p1', name: 'one', color: '#fff', viewport: { x: 0, y: 0, zoom: 1 }, nodes: [node], ...extra })
const workspace = (projects: Project[]): Workspace => ({ version: 2, activeProjectId: 'p1', projects })
const read = async () => JSON.parse(await fs.readFile(path.join(cwd, '.nodeterm/project.json'), 'utf8'))
const times = new Map<string, number>()
async function send(method: string, params: Record<string, unknown>, nonce = randomUUID(), instance = service.instance) {
  const issuedAt = times.get(nonce) ?? Date.now(); times.set(nonce, issuedAt)
  const file = path.join(service.directory, nonce + '.request')
  await fs.writeFile(file, JSON.stringify({ version: 1, instance, nonce, issuedAt, method, params }), { mode: 0o600 })
  await service.tick()
  return JSON.parse(await readSshActionFile(path.join(service.directory, nonce + '.response')))
}
beforeEach(async () => {
  times.clear()
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'nt-ssh-actions-'))
  cwd = path.join(root, 'project'); await fs.mkdir(cwd)
  fake = fakePlatform({ userDataDir: root }); initPlatform(fake)
  store = new WorkspaceStore(); await store.save(workspace([project({ cwd })]))
  service = new SshActionsService(root, store)
  await service.start()
})
afterEach(async () => {
  await service.stop()
  vi.restoreAllMocks(); resetPlatformForTests()
  await fs.rm(root, { force: true, recursive: true })
})

describe('selected-profile SSH actions filesystem service', () => {
  it('suppresses unavailable namespace discovery without breaking native startup', async () => {
    if (process.platform !== 'linux') return
    await service.stop()
    vi.spyOn(nodeFs, 'readlinkSync').mockImplementation(() => { throw new Error('private proc is unavailable') })
    expect(await startSshActionsService(root, store)).toBeUndefined()
    expect(nodeFs.existsSync(path.join(service.root, 'advertisement.json'))).toBe(false)
  })
  it('retires monotonically during blocked startup and never publishes afterward', async () => {
    await service.stop(); service = new SshActionsService(root, store)
    let release!: () => void, entered!: () => void
    const blocked = new Promise<void>((r) => { release = r }), sawDirectory = new Promise<void>((r) => { entered = r })
    const original = fs.lstat.bind(fs)
    vi.spyOn(fs, 'lstat').mockImplementation(async (...args: any[]) => {
      const stat = await original(...args as Parameters<typeof fs.lstat>)
      if (args[0] === service.directory) { entered(); await blocked }
      return stat
    })
    const starting = service.start(); await sawDirectory
    const stopping = service.stop(); release()
    await expect(starting).rejects.toThrow(/stopped during startup/); await stopping
    vi.restoreAllMocks()
    expect(nodeFs.existsSync(path.join(service.root, 'advertisement.json'))).toBe(false)
    expect(nodeFs.existsSync(path.join(service.root, 'claim'))).toBe(false)
    await expect(service.start()).rejects.toThrow(/already started or stopped/)
    await service.tick()
    expect(nodeFs.existsSync(path.join(service.root, 'advertisement.json'))).toBe(false)
  })
  it('retires during post-publication cleanup without installing a polling timer', async () => {
    await service.stop(); service = new SshActionsService(root, store)
    let release!: () => void, entered!: () => void
    const blocked = new Promise<void>((r) => { release = r }), published = new Promise<void>((r) => { entered = r })
    const original = fs.unlink.bind(fs)
    vi.spyOn(fs, 'unlink').mockImplementation(async (...args: any[]) => {
      if (String(args[0]).includes('advertisement.json.') && String(args[0]).endsWith('.tmp')) { entered(); await blocked }
      return original(...args as Parameters<typeof fs.unlink>)
    })
    const timer = vi.spyOn(globalThis, 'setInterval')
    const starting = service.start(); await published
    expect(nodeFs.existsSync(path.join(service.root, 'advertisement.json'))).toBe(true)
    const stopping = service.stop(); release()
    await expect(starting).rejects.toThrow(/stopped during startup/); await stopping
    expect(timer).not.toHaveBeenCalled()
    vi.restoreAllMocks()
    expect(nodeFs.existsSync(path.join(service.root, 'advertisement.json'))).toBe(false)
    expect(nodeFs.existsSync(path.join(service.root, 'claim'))).toBe(false)
  })
  it('refuses dispatch if its exclusive claim changes even while the old advertisement looks current', async () => {
    const claim = path.join(service.root, 'claim/owner.json')
    const owner = JSON.parse(await readSshActionFile(claim)); owner.instance = randomUUID()
    await fs.writeFile(claim, JSON.stringify(owner), { mode: 0o600 })
    const nonce = randomUUID()
    await fs.writeFile(path.join(service.directory, nonce + '.request'), JSON.stringify({ version: 1, instance: service.instance, nonce, issuedAt: Date.now(), method: 'projects.ensureBoard', params: { projectId: 'p1' } }), { mode: 0o600 })
    await service.tick()
    expect((await read()).kanban).toBeUndefined()
    expect(nodeFs.existsSync(path.join(service.directory, nonce + '.response'))).toBe(false)
    await service.stop()
    expect(JSON.parse(await readSshActionFile(claim)).instance).toBe(owner.instance)
  })
  it('rejects a repeated start without retiring its existing active owner', async () => {
    const before = await readSshActionFile(path.join(service.root, 'advertisement.json'))
    await expect(service.start()).rejects.toThrow(/already started or stopped/)
    expect(await readSshActionFile(path.join(service.root, 'advertisement.json'))).toBe(before)
    expect((await send('projects.ensureBoard', { projectId: 'p1' })).ok).toBe(true)
  })
  it('permits only one simultaneous startup and cannot overwrite its live owner', async () => {
    await service.stop()
    const first = new SshActionsService(root, store), second = new SshActionsService(root, store)
    const attempts = await Promise.allSettled([first.start(), second.start()])
    expect(attempts.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    service = attempts[0].status === 'fulfilled' ? first : second
    const loser = service === first ? second : first
    const before = await readSshActionFile(path.join(service.root, 'advertisement.json'))
    await loser.stop()
    expect(await readSshActionFile(path.join(service.root, 'advertisement.json'))).toBe(before)
    expect((await send('projects.ensureBoard', { projectId: 'p1' })).ok).toBe(true)
  })
  it('keeps its exclusive lifetime claim during an accepted master write and releases it after cleanup', async () => {
    await service.stop()
    let release!: () => void, entered!: () => void
    const blocked = new Promise<void>((r) => { release = r }), sawWrite = new Promise<void>((r) => { entered = r })
    let blocking = false, writes = 0
    const io: RemoteWorkspaceIO = { read: async () => ({ status: 'absent' }), write: async () => { writes++; if (blocking) { entered(); await blocked } return true } }
    store = new WorkspaceStore(io)
    const ssh = { server: { host: 'synthetic', user: 'synthetic' }, remoteCwd: '/synthetic' } as unknown as Project['ssh']
    await store.save(workspace([project({ ssh })]))
    service = new SshActionsService(root, store); await service.start(); blocking = true
    const nonce = randomUUID()
    await fs.writeFile(path.join(service.directory, nonce + '.request'), JSON.stringify({ version: 1, instance: service.instance, nonce, issuedAt: Date.now(), method: 'projects.ensureBoard', params: { projectId: 'p1' } }), { mode: 0o600 })
    const operation = service.tick(); await sawWrite
    const stopping = service.stop()
    const successor = new SshActionsService(root, store)
    await expect(successor.start()).rejects.toThrow(/already served/)
    expect(nodeFs.existsSync(path.join(service.root, 'claim/owner.json'))).toBe(true)
    release(); await stopping; await expect(operation).rejects.toThrow(/instance changed/)
    expect(nodeFs.existsSync(path.join(service.root, 'advertisement.json'))).toBe(false)
    expect(nodeFs.existsSync(path.join(service.root, 'claim'))).toBe(false)
    await successor.start(); service = successor
    expect(JSON.parse(await readSshActionFile(path.join(service.root, 'advertisement.json'))).instance).toBe(successor.instance)
    expect(writes).toBe(2)
  })
  it('refuses an unverifiable foreign namespace claim or unsafe partial startup claim', async () => {
    await service.stop()
    const claim = path.join(service.root, 'claim'); await fs.mkdir(claim, { mode: 0o700 })
    await fs.writeFile(path.join(claim, 'owner.json'), JSON.stringify({ version: 1, instance: randomUUID(), pid: 2147483647, namespace: 'foreign' }), { mode: 0o600 })
    await expect(new SshActionsService(root, store).start()).rejects.toThrow(/Unverifiable/)
    await fs.unlink(path.join(claim, 'owner.json'))
    await expect(new SshActionsService(root, store).start()).rejects.toThrow(/Unsafe/)
  })
  it('publishes a bounded uncertain receipt for an oversized applied result and never repeats it', async () => {
    const huge = Array.from({ length: 4000 }, (_, i) => ({ id: 'column-' + i, title: 'x'.repeat(60), color: '#fff' }))
    await store.save(workspace([project({ cwd, kanban: { columns: huge, assignments: [] } })]))
    const spy = vi.spyOn(store, 'ensureRemoteBoard')
    const nonce = randomUUID()
    const response = await send('projects.ensureBoard', { projectId: 'p1' }, nonce)
    expect(response.ok).toBe(false); expect(response.uncertain).toBe(true)
    expect(response.error).toMatch(/response too large/)
    expect((await fs.stat(path.join(service.directory, nonce + '.response'))).size).toBeLessThan(1024)
    expect(await send('projects.ensureBoard', { projectId: 'p1' }, nonce)).toEqual(response)
    expect(spy).toHaveBeenCalledTimes(1)
  })
  it('keeps an idle advertisement inode unchanged, then refreshes its live heartbeat at5s', async () => {
    const file = path.join(service.root, 'advertisement.json')
    const original = await fs.stat(file)
    const advert = JSON.parse(await readSshActionFile(file))
    vi.spyOn(Date, 'now').mockReturnValue(advert.updatedAt + 1000)
    await service.tick(); await service.tick()
    expect((await fs.stat(file)).ino).toBe(original.ino)
    expect(JSON.parse(await readSshActionFile(file)).updatedAt).toBe(advert.updatedAt)
    vi.spyOn(Date, 'now').mockReturnValue(advert.updatedAt + 5001)
    await service.tick()
    const refreshed = JSON.parse(await readSshActionFile(file))
    expect(refreshed.updatedAt).toBe(advert.updatedAt + 5001)
    expect(refreshed.instance).toBe(service.instance)
    expect(refreshed.remoteProjects).toBe(true)
    expect((await fs.stat(file)).ino).not.toBe(original.ino)
  })
  it('consumes a completed request once while retaining its outcome for a same-nonce retry', async () => {
    const nonce = randomUUID()
    const first = await send('projects.ensureBoard', { projectId: 'p1' }, nonce)
    await expect(fs.stat(path.join(service.directory, nonce + '.request'))).rejects.toMatchObject({ code: 'ENOENT' })
    const resultFile = path.join(service.directory, nonce + '.response')
    const receipt = await fs.stat(resultFile)
    await service.tick(); await service.tick()
    expect((await fs.stat(resultFile)).ino).toBe(receipt.ino)
    expect(await send('projects.ensureBoard', { projectId: 'p1' }, nonce)).toEqual(first)
  })
  it('rejects foreign UID ownership facts even when modes and inode kind match', async () => {
    const actual = await fs.stat(path.join(service.root, 'advertisement.json'))
    expect(safeSshActionStat(actual, false, actual.uid)).toBe(true)
    expect(safeSshActionStat(actual, false, actual.uid + 1)).toBe(false)
  })
  it('refuses FIFOs and hard links without blocking or treating them as requests', async () => {
    const fifo = path.join(service.directory, randomUUID() + '.request')
    execFileSync('mkfifo', ['-m', '600', fifo])
    await expect(readSshActionFile(fifo)).rejects.toThrow(/Unsafe/)
    const original = path.join(root, 'hardlink-original'); await fs.writeFile(original, '{}', { mode: 0o600 })
    const linked = path.join(service.directory, randomUUID() + '.request'); await fs.link(original, linked)
    await expect(readSshActionFile(linked)).rejects.toThrow(/Unsafe/)
  }, 3000)
  it('retains an uncertain callback outcome and does not repeat a potentially delivered nudge', async () => {
    await service.stop()
    const actions = { wake: vi.fn(() => { throw new Error('lost after dispatch') }), refresh: () => true, rename: () => true }
    service = new SshActionsService(root, store, actions); await service.start()
    const nonce = randomUUID()
    const first = await send('node.wake', { nodeId: 'term-one' }, nonce)
    expect(first.ok).toBe(false); expect(first.uncertain).toBe(true)
    expect(await send('node.wake', { nodeId: 'term-one' }, nonce)).toEqual(first)
    expect(actions.wake).toHaveBeenCalledTimes(1)
  })
  it('refuses future or changed immutable issuedAt without mutating the Board', async () => {
    const nonce = randomUUID(); times.set(nonce, Date.now() + 31_000)
    expect((await send('projects.ensureBoard', { projectId: 'p1' }, nonce)).ok).toBe(false)
    expect((await read()).kanban).toBeUndefined()
    const normal = randomUUID(); expect((await send('projects.ensureBoard', { projectId: 'p1' }, normal)).ok).toBe(true)
    times.set(normal, times.get(normal)! + 1)
    expect((await send('projects.ensureBoard', { projectId: 'p1' }, normal)).error).toMatch(/nonce.*different/)
  })
  it('accepts normal0755 selected profiles but refuses writable0775 profiles', async () => {
    await service.stop(); await fs.chmod(root, 0o755)
    service = new SshActionsService(root, store); await service.start()
    expect((await send('projects.ensureBoard', { projectId: 'p1' })).ok).toBe(true)
    await service.stop(); await fs.chmod(root, 0o775)
    await expect(new SshActionsService(root, store).start()).rejects.toThrow(/Unsafe.*profile/)
    await fs.chmod(root, 0o700)
  })
  it('expires completed outcomes without reexecuting a replay or requiring a desktop restart', async () => {
    await service.stop()
    const actions = { wake: vi.fn(() => true), refresh: vi.fn(() => true), rename: vi.fn(() => true) }
    service = new SshActionsService(root, store, actions); await service.start()
    const nonce = randomUUID()
    expect((await send('node.wake', { nodeId: 'term-one' }, nonce)).ok).toBe(true)
    const issuedAt = times.get(nonce)!
    vi.spyOn(Date, 'now').mockReturnValue(issuedAt + SSH_ACTIONS_RETRY_MS + 1)
    await service.tick()
    await expect(fs.stat(path.join(service.directory, nonce + '.request'))).rejects.toMatchObject({ code: 'ENOENT' })
    const expired = await send('node.wake', { nodeId: 'term-one' }, nonce)
    expect(expired.ok).toBe(false); expect(expired.uncertain).toBe(true)
    expect(actions.wake).toHaveBeenCalledTimes(1)
    expect((await send('node.wake', { nodeId: 'term-one' })).ok).toBe(true)
    expect(actions.wake).toHaveBeenCalledTimes(2)
  })
  it('creates, moves and labels through the actual save queue and announces the mounted Board', async () => {
    const seeded = await send('projects.ensureBoard', { projectId: 'p1' })
    expect(seeded.ok).toBe(true); expect(seeded.result.columns).toHaveLength(3)
    const columnId = seeded.result.columns[1].id
    const moved = await send('projects.setCardColumn', { projectId: 'p1', nodeId: 'term-one', columnId })
    expect(moved.result).toEqual({ moved: true })
    const labeled = await send('projects.editCardLabels', { projectId: 'p1', nodeId: 'term-one', create: [{ name: 'Mobile', color: 'blue' }] })
    expect(labeled.ok).toBe(true); expect(labeled.result.edited).toBe(true)
    expect(labeled.result.labels[0].name).toBe('Mobile')
    const persisted = await read()
    expect(persisted.kanban.assignments).toEqual([{ nodeId: 'term-one', columnId }])
    expect(persisted.kanban.meta[0].labels).toEqual(labeled.result.cardLabelIds)
    expect(fake.sent.filter((m) => m.channel === 'workspace:server-change')).toHaveLength(3)
    const loaded = await store.load({ sideline: false }); await store.save(loaded)
    expect((await read()).kanban).toEqual(persisted.kanban)
  })
  it('retains the original outcome after a lost reply, and refuses nonce reuse with another payload', async () => {
    const nonce = randomUUID()
    const first = await send('projects.ensureBoard', { projectId: 'p1' }, nonce)
    const before = await read()
    await fs.unlink(path.join(service.directory, nonce + '.response'))
    const replay = await send('projects.ensureBoard', { projectId: 'p1' }, nonce)
    expect(replay).toEqual(first); expect(await read()).toEqual(before)
    const changed = await send('projects.ensureBoard', { projectId: 'different' }, nonce)
    expect(changed.ok).toBe(false); expect(changed.error).toMatch(/nonce.*different/)
    expect(await read()).toEqual(before)
  })
  it('dispatches a node nudge once even if its response is lost; reports delivery only', async () => {
    await service.stop()
    const actions = { wake: vi.fn(() => true), refresh: vi.fn(() => false), rename: vi.fn(() => true) }
    service = new SshActionsService(root, store, actions); await service.start()
    const nonce = randomUUID()
    expect((await send('node.wake', { nodeId: 'term-one' }, nonce)).result).toEqual({ delivered: true })
    await fs.unlink(path.join(service.directory, nonce + '.response'))
    expect((await send('node.wake', { nodeId: 'term-one' }, nonce)).ok).toBe(true)
    expect(actions.wake).toHaveBeenCalledTimes(1)
    expect((await send('node.refresh', { nodeId: 'term-one' })).ok).toBe(false)
    expect((await send('node.rename', { nodeId: 'term-one', title: ' Renamed ' })).ok).toBe(true)
    expect(actions.rename).toHaveBeenCalledWith('term-one', 'Renamed')
    expect((await send('node.rename', { nodeId: 'term-one', title: '\u001bcommand' })).ok).toBe(false)
    expect(actions.rename).toHaveBeenCalledTimes(1)
  })
  it('refuses stale project, foreign node, invalid label/title and unsupported managed New without writes', async () => {
    const before = await read()
    for (const [method, params] of [
      ['projects.ensureBoard', { projectId: 'foreign-profile' }],
      ['projects.setCardColumn', { projectId: 'p1', nodeId: 'foreign-node', columnId: null }],
      ['projects.editCardLabels', { projectId: 'p1', nodeId: 'term-one', create: [{ name: 'x', color: 'bogus' }] }],
      ['projects.registerNode', { projectId: 'p1', node: { id: 'invented' } }],
      ['node.wake', { nodeId: 'term-one' }]
    ] as Array<[string, Record<string, unknown>]>) expect((await send(method, params)).ok).toBe(false)
    expect(await read()).toEqual(before)
    expect(service.methods).not.toContain('projects.registerNode')
  })
  it('refuses a node ambiguously present in two persisted projects', async () => {
    await store.save(workspace([project({ cwd }), project({ id: 'p2' })]))
    expect((await send('projects.setCardColumn', { projectId: 'p1', nodeId: 'term-one', columnId: null })).ok).toBe(false)
  })
  it('routes SSH project Board changes through the existing master mirror, never a local path', async () => {
    await service.stop()
    let remote: string | null = null
    const writes: string[] = []
    const io: RemoteWorkspaceIO = { read: async () => remote ? { status: 'ok', content: remote } : { status: 'absent' }, write: async (_id, _ssh, raw) => { writes.push(raw); remote = raw; return true } }
    store = new WorkspaceStore(io)
    const ssh = { server: { host: 'synthetic', user: 'synthetic' }, remoteCwd: '/synthetic' } as unknown as Project['ssh']
    await store.save(workspace([project({ ssh })]))
    service = new SshActionsService(root, store); await service.start()
    const before = writes.length
    expect((await send('projects.ensureBoard', { projectId: 'p1' })).ok).toBe(true)
    expect(writes).toHaveLength(before + 1); expect(JSON.parse(remote!).kanban.columns).toHaveLength(3)
    expect(fake.sent.some((m) => m.channel === 'workspace:server-change')).toBe(true)
    await service.stop(); service = new SshActionsService(root, store, undefined, false); await service.start()
    const count = writes.length
    expect((await send('projects.ensureBoard', { projectId: 'p1' })).ok).toBe(false)
    expect(writes).toHaveLength(count)
  })
  it('does not serve a previous instance or another selected profile', async () => {
    expect((await send('projects.ensureBoard', { projectId: 'p1' }, randomUUID(), randomUUID())).ok).toBe(false)
    const before = await read()
    const otherRoot = path.join(root, 'other'); await fs.mkdir(otherRoot, { mode: 0o700 })
    const other = new SshActionsService(otherRoot, new WorkspaceStore())
    await other.start()
    try {
      const nonce = randomUUID()
      await fs.writeFile(path.join(other.directory, nonce + '.request'), JSON.stringify({ version: 1, instance: service.instance, nonce, issuedAt: Date.now(), method: 'projects.ensureBoard', params: { projectId: 'p1' } }), { mode: 0o600 })
      await other.tick()
      expect(JSON.parse(await readSshActionFile(path.join(other.directory, nonce + '.response'))).ok).toBe(false)
    } finally { await other.stop() }
    expect(await read()).toEqual(before)
  })
  it('refuses an unsafe request inode, size and permissions before dispatch', async () => {
    const nonce = randomUUID(); const request = path.join(service.directory, nonce + '.request')
    const outside = path.join(root, 'outside'); await fs.writeFile(outside, JSON.stringify({ version: 1, instance: service.instance, nonce, issuedAt: Date.now(), method: 'projects.ensureBoard', params: { projectId: 'p1' } }), { mode: 0o600 })
    await fs.symlink(outside, request); await service.tick()
    expect(JSON.parse(await readSshActionFile(path.join(service.directory, nonce + '.response'))).ok).toBe(false)
    await fs.unlink(request); await fs.writeFile(request, JSON.stringify({ version: 1, instance: service.instance, nonce, issuedAt: Date.now(), method: 'projects.ensureBoard', params: { projectId: 'p1', padding: 'x'.repeat(SSH_ACTIONS_MAX_BYTES) } }), { mode: 0o600 })
    await service.tick(); expect((await read()).kanban).toBeUndefined()
    await fs.writeFile(request, await fs.readFile(outside)); await fs.chmod(request, 0o644)
    await service.tick(); expect((await read()).kanban).toBeUndefined()
  })
  it('refuses a symlink or shared directory and an already live profile owner', async () => {
    await expect(new SshActionsService(root, store).start()).rejects.toThrow(/already served/)
    await service.stop()
    await fs.rm(service.root, { force: true, recursive: true })
    const elsewhere = path.join(root, 'elsewhere'); await fs.mkdir(elsewhere, { mode: 0o700 })
    await fs.symlink(elsewhere, service.root)
    await expect(new SshActionsService(root, store).start()).rejects.toThrow(/Unsafe/)
    await fs.unlink(service.root); await fs.mkdir(service.root, { mode: 0o755 })
    // Set the unsafe fixture's actual mode even when the runner inherits umask 0077.
    await fs.chmod(service.root, 0o755)
    await expect(new SshActionsService(root, store).start()).rejects.toThrow(/Unsafe/)
  })
  it('fences a queued local write after stop, without publishing a success or changing the file', async () => {
    let release!: () => void
    let entered!: () => void
    const blocked = new Promise<void>((r) => { release = r })
    const sawRead = new Promise<void>((r) => { entered = r })
    const writeSpy = vi.spyOn(fs, 'writeFile')
    const original = fs.readFile.bind(fs)
    vi.spyOn(fs, 'readFile').mockImplementation(async (...args: any[]) => {
      if (args[0] === path.join(cwd, '.nodeterm/project.json')) { entered(); await blocked }
      return original(...args as Parameters<typeof fs.readFile>)
    })
    const nonce = randomUUID()
    await fs.writeFile(path.join(service.directory, nonce + '.request'), JSON.stringify({ version: 1, instance: service.instance, nonce, issuedAt: Date.now(), method: 'projects.ensureBoard', params: { projectId: 'p1' } }), { mode: 0o600 })
    const tick = service.tick()
    await sawRead; const stopping = service.stop(); release()
    await stopping
    await expect(tick).rejects.toThrow(/instance changed/)
    const staleTempWrites = writeSpy.mock.calls.filter(([file]) => String(file).includes('/.nodeterm/project.json.'))
    expect(staleTempWrites).toHaveLength(0)
    vi.restoreAllMocks()
    expect((await read()).kanban).toBeUndefined()
    await expect(fs.stat(path.join(service.directory, nonce + '.response'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('preserves0644 shared project permissions while control files remain0600', async () => {
    const file = path.join(cwd, '.nodeterm/project.json')
    await fs.chmod(file, 0o644)
    expect((await send('projects.ensureBoard', { projectId: 'p1' })).ok).toBe(true)
    expect((await fs.stat(file)).mode & 0o777).toBe(0o644)
    expect((await fs.stat(path.join(service.root, 'advertisement.json'))).mode & 0o777).toBe(0o600)
  })
  it('rechecks the instance after writing its temp and before publishing the shared project', async () => {
    let release!: () => void
    let entered!: () => void
    const blocked = new Promise<void>((r) => { release = r })
    const sawTemp = new Promise<void>((r) => { entered = r })
    const original = fs.writeFile.bind(fs)
    vi.spyOn(fs, 'writeFile').mockImplementation(async (...args: any[]) => {
      const result = await original(...args as Parameters<typeof fs.writeFile>)
      if (String(args[0]).includes('/.nodeterm/project.json.') && String(args[1]).includes('"kanban"')) { entered(); await blocked }
      return result
    })
    const nonce = randomUUID()
    await fs.writeFile(path.join(service.directory, nonce + '.request'), JSON.stringify({ version: 1, instance: service.instance, nonce, issuedAt: Date.now(), method: 'projects.ensureBoard', params: { projectId: 'p1' } }), { mode: 0o600 })
    const tick = service.tick()
    await sawTemp; const stopping = service.stop(); release()
    await stopping
    await expect(tick).rejects.toThrow(/instance changed/)
    vi.restoreAllMocks()
    expect((await read()).kanban).toBeUndefined()
    const litter = (await fs.readdir(path.join(cwd, '.nodeterm'))).filter((n) => n.endsWith('.tmp'))
    expect(litter).toEqual([])
  })
  it('rechecks the node in the file at the queued commit, instead of assigning an orphan card', async () => {
    const board = await send('projects.ensureBoard', { projectId: 'p1' })
    const columnId = board.result.columns[1].id
    const current = await read(); current.nodes = []
    await fs.writeFile(path.join(cwd, '.nodeterm/project.json'), JSON.stringify(current))
    expect((await send('projects.setCardColumn', { projectId: 'p1', nodeId: 'term-one', columnId })).result).toEqual({ moved: false })
    expect((await read()).kanban).toEqual(current.kanban)
  })
})
