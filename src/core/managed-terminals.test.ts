import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import { initPlatform, resetPlatformForTests } from './platform'
import { fakePlatform } from './platform-fake'
import { WorkspaceStore } from './workspace-store'
import { ManagedTerminals, parseManagedTerminalRequest, type ManagedTerminalDependencies, type ManagedTerminalPlan, MANAGED_RECOVERY_COMMAND } from './managed-terminals'
import { SshActionsService, readSshActionFile } from './ssh-actions'
import type { ManagedPaneReceipt } from '../shared/managed-terminal'
import type { Project } from '../shared/types'

let root: string, cwd: string, store: WorkspaceStore, deps: ManagedTerminalDependencies, creator: ManagedTerminals, instance: string, fake: ReturnType<typeof fakePlatform>
const shell = () => ({ creationId: randomUUID(), projectId: 'p1', kind: 'shell', cols: 80, rows: 24 })
const agent = () => ({ ...shell(), kind: 'agent', agentId: 'claude', accountId: 'personal', title: 'Owned Claude' })
const file = () => path.join(cwd, '.nodeterm/project.json')
const read = async () => JSON.parse(await fs.readFile(file(), 'utf8'))
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>((r) => { resolve = r }); return { promise, resolve } }
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'nt-managed-create-')); cwd = path.join(root, 'project'); await fs.mkdir(cwd)
  fake = fakePlatform({ userDataDir: root }); initPlatform(fake); store = new WorkspaceStore(); instance = randomUUID()
  const project: Project = { id: 'p1', name: 'owned', color: '#fff', cwd, nodes: [], viewport: { x: 0, y: 0, zoom: 1 } }
  await store.save({ version: 2, activeProjectId: 'p1', projects: [project] })
  deps = {
    supported: () => true,
    plan: vi.fn(async (request, nodeId): Promise<ManagedTerminalPlan> => ({
      node: { id: nodeId, kind: 'terminal', title: request.title ?? 'Mobile session', titleAuto: true, color: '#fff',
        cwd, position: { x: 100, y: 100 }, size: { width: 900, height: 560 }, group: null,
        ...(request.agentId ? { agentId: request.agentId, accountId: request.accountId } : {}) },
      options: { persistKey: nodeId, ownerProjectId: request.projectId, cwd, cols: request.cols, rows: request.rows,
        agentId: request.agentId, accountId: request.accountId },
      ...(request.kind === 'agent' ? { command: 'claude --session-id ' + request.creationId } : {})
    })),
    revalidate: vi.fn(async () => true),
    create: vi.fn(async (options, creationId): Promise<ManagedPaneReceipt> => ({ version: 1, creationId, nodeId: options.persistKey!,
      projectId: options.ownerProjectId!, socket: 'node-terminal', session: 'nt-' + options.persistKey,
      paneId: '%7', panePid: 4123, paneBirth: 'linux:owned-boot:100', sessionCreated: '1700000000' })),
    verify: vi.fn(async () => true), deliver: vi.fn(async () => true)
  }
  creator = new ManagedTerminals(root, store, deps)
})
afterEach(async () => { vi.restoreAllMocks(); resetPlatformForTests(); await fs.rm(root, { recursive: true, force: true }) })

// This authenticated creation path and its private UID/fsync journal are POSIX-only.
describe.skipIf(process.platform === 'win32')('host-owned managed terminal creation', () => {
  it('creates a real pane before publishing its explicit local shell facts and returns a versioned handoff', async () => {
    const request = shell()
    vi.mocked(deps.create).mockImplementationOnce(async (options, id, current) => {
      expect(current()).toBe(true); expect((await read()).nodes).toHaveLength(0)
      const accepted = JSON.parse(await fs.readFile(path.join(creator.directory, id + '.json'), 'utf8'))
      expect(accepted.phase).toBe('prepared'); expect(accepted.node.id).toBe(options.persistKey)
      return { version: 1, creationId: id, nodeId: options.persistKey!, projectId: 'p1', socket: 'node-terminal', session: 'nt-' + options.persistKey,
        paneId: '%7', panePid: 4123, paneBirth: 'linux:owned-boot:100', sessionCreated: '1700000000' }
    })
    const receipt = await creator.create(request, instance, () => true)
    expect(receipt).toMatchObject({ version: 1, hostInstance: instance, creationId: request.creationId, projectId: 'p1', socket: 'node-terminal' })
    const node = (await read()).nodes[0]
    expect(node).toMatchObject({ id: receipt.nodeId, cwd: '.', kind: 'terminal' }); expect(node.pendingLaunch).toBeUndefined()
    expect(deps.deliver).not.toHaveBeenCalled(); expect(deps.verify).toHaveBeenCalled()
    expect((await fs.stat(creator.directory)).mode & 0o777).toBe(0o700)
    expect((await fs.stat(path.join(creator.directory, request.creationId + '.json'))).mode & 0o777).toBe(0o600)
  })
  it('publishes guarded manual agent intent before one launch and clears it only after confirmed submission', async () => {
    const request = agent(); let nodeId = ''
    vi.mocked(deps.deliver).mockImplementationOnce(async (receipt, command, current) => {
      nodeId = receipt.nodeId; expect(current()).toBe(true)
      expect((await read()).nodes[0]).toMatchObject({ id: nodeId, cwd: '.', agentId: 'claude', accountId: 'personal',
        pendingLaunch: { command: MANAGED_RECOVERY_COMMAND, after: [], attempted: true, manualOnly: true, executor: 'server' } })
      const privateRecord = JSON.parse(await fs.readFile(path.join(creator.directory, request.creationId + '.json'), 'utf8'))
      expect(privateRecord.phase).toBe('launchAttempted'); expect(privateRecord.command).toBe(command)
      return true
    })
    const receipt = await creator.create(request, instance, () => true)
    expect(receipt.nodeId).toBe(nodeId); expect((await read()).nodes[0].pendingLaunch).toBeUndefined()
    expect(deps.deliver).toHaveBeenCalledTimes(1)
  })
  it('keeps host-expanded credential text out of the shared project and renderer intent', async () => {
    const original = deps.plan
    deps.plan = vi.fn(async (...args: Parameters<typeof original>) => ({ ...await original(...args), command: 'SECRET_TOKEN=private-synthetic-secret claude' }))
    deps.deliver = vi.fn(async (_receipt, command) => {
      expect(command).toContain('private-synthetic-secret')
      expect(await fs.readFile(file(), 'utf8')).not.toContain('private-synthetic-secret')
      expect((await read()).nodes[0].pendingLaunch.command).toBe(MANAGED_RECOVERY_COMMAND)
      return false
    })
    await expect(creator.create(agent(), instance, () => true)).rejects.toMatchObject({ uncertain: true })
    expect(await fs.readFile(file(), 'utf8')).not.toContain('private-synthetic-secret')
    expect(JSON.stringify(fake.sent)).not.toContain('private-synthetic-secret')
  })
  it('syncs each private phase file and parent before pane creation and launch submission', async () => {
    const probe = await fs.open(path.join(root, 'sync-probe'), 'wx', 0o600)
    const prototype = Object.getPrototypeOf(probe), originalSync = prototype.sync; await probe.close()
    const ownerInode = (await fs.stat(root)).ino
    const events: string[] = []
    vi.spyOn(prototype, 'sync').mockImplementation(async function (this: any) {
      const stat = await this.stat()
      events.push(stat.isDirectory() ? stat.ino === ownerInode ? 'owner' : 'directory' : 'file')
      return originalSync.call(this)
    })
    const originalCreate = deps.create, originalDeliver = deps.deliver
    deps.create = vi.fn(async (...args: Parameters<typeof originalCreate>) => { expect(events).toEqual(['owner', 'file', 'directory']); events.push('create'); return originalCreate(...args) })
    deps.deliver = vi.fn(async (...args: Parameters<typeof originalDeliver>) => { expect(events.slice(-2)).toEqual(['file', 'directory']); events.push('deliver'); return originalDeliver(...args) })
    await creator.create(agent(), instance, () => true)
    expect(events.filter((event) => event === 'file')).toHaveLength(5)
    expect(events.filter((event) => event === 'directory')).toHaveLength(5)
    expect(events).toContain('create'); expect(events).toContain('deliver')
  })
  it('refuses creation before journaling when the new directory parent cannot be synced', async () => {
    const probe = await fs.open(path.join(root, 'sync-probe'), 'wx', 0o600)
    const prototype = Object.getPrototypeOf(probe), originalSync = prototype.sync; await probe.close()
    const ownerInode = (await fs.stat(root)).ino
    vi.spyOn(prototype, 'sync').mockImplementation(async function (this: any) {
      const stat = await this.stat()
      if (stat.isDirectory() && stat.ino === ownerInode) throw new Error('synthetic owner sync failure')
      return originalSync.call(this)
    })
    const request = agent()
    await expect(creator.create(request, instance, () => true)).rejects.toThrow(/owner sync failure/)
    expect(deps.plan).not.toHaveBeenCalled(); expect(deps.create).not.toHaveBeenCalled(); expect(deps.deliver).not.toHaveBeenCalled()
    await expect(fs.stat(path.join(creator.directory, request.creationId + '.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await read()).nodes).toHaveLength(0)
  })
  it('accepts an owned readable parent but refuses writable or symlinked profile parents before creation', async () => {
    await fs.chmod(root, 0o755)
    await creator.create(shell(), instance, () => true)
    expect(deps.create).toHaveBeenCalledTimes(1)
    await fs.chmod(root, 0o777)
    await expect(creator.create(shell(), instance, () => true)).rejects.toThrow(/Unsafe.*parent/)
    await fs.chmod(root, 0o700)
    const link = root + '-link'
    await fs.symlink(root, link)
    try { await expect(new ManagedTerminals(link, store, deps).create(shell(), instance, () => true)).rejects.toThrow(/Unsafe.*parent/) }
    finally { await fs.unlink(link) }
    expect(deps.create).toHaveBeenCalledTimes(1)
  })
  it.each(['file', 'directory'])('never creates a pane after the prepared %s sync barrier failed', async (failure) => {
    const probe = await fs.open(path.join(root, 'sync-probe'), 'wx', 0o600)
    const prototype = Object.getPrototypeOf(probe), originalSync = prototype.sync; await probe.close()
    const ownerInode = (await fs.stat(root)).ino
    vi.spyOn(prototype, 'sync').mockImplementation(async function (this: any) {
      const stat = await this.stat()
      const kind = stat.isDirectory() ? stat.ino === ownerInode ? 'owner' : 'directory' : 'file'
      if (kind === failure) throw new Error('synthetic sync failure')
      return originalSync.call(this)
    })
    const request = agent()
    await expect(creator.create(request, instance, () => true)).rejects.toMatchObject({ uncertain: true })
    expect(deps.create).not.toHaveBeenCalled(); expect(deps.deliver).not.toHaveBeenCalled()
    if (failure === 'directory') expect(JSON.parse(await fs.readFile(path.join(creator.directory, request.creationId + '.json'), 'utf8')).phase).toBe('prepared')
  })
  it('leaves visible recovery without submitting after the launch-attempt directory sync failed', async () => {
    const probe = await fs.open(path.join(root, 'sync-probe'), 'wx', 0o600)
    const prototype = Object.getPrototypeOf(probe), originalSync = prototype.sync; await probe.close()
    const request = agent()
    const ownerInode = (await fs.stat(root)).ino
    vi.spyOn(prototype, 'sync').mockImplementation(async function (this: any) {
      const stat = await this.stat()
      if (stat.isDirectory() && stat.ino !== ownerInode) {
        const phase = JSON.parse(await fs.readFile(path.join(creator.directory, request.creationId + '.json'), 'utf8')).phase
        if (phase === 'launchAttempted') throw new Error('synthetic sync failure')
      }
      return originalSync.call(this)
    })
    await expect(creator.create(request, instance, () => true)).rejects.toMatchObject({ uncertain: true })
    expect(deps.deliver).not.toHaveBeenCalled(); expect((await read()).nodes[0].pendingLaunch.manualOnly).toBe(true)
  })
  it('serializes concurrent identical creations and verifies the same pane without a second launch', async () => {
    const request = agent(); const gate = deferred(); const entered = deferred()
    vi.mocked(deps.create).mockImplementationOnce(async (options, id) => { entered.resolve(); await gate.promise; return {
      version: 1, creationId: id, nodeId: options.persistKey!, projectId: 'p1', socket: 'node-terminal', session: 'nt-' + options.persistKey,
      paneId: '%7', panePid: 4123, paneBirth: 'linux:owned-boot:100', sessionCreated: '1700000000' } })
    const a = creator.create(request, instance, () => true); await entered.promise
    const b = creator.create({ ...request }, instance, () => true); gate.resolve()
    expect(await b).toEqual(await a); expect(deps.create).toHaveBeenCalledTimes(1); expect(deps.deliver).toHaveBeenCalledTimes(1)
    expect((await read()).nodes).toHaveLength(1); expect(deps.verify).toHaveBeenCalledTimes(2)
  })
  it('refuses changed choices under the same durable creation id, including dimensions', async () => {
    const request = shell(); const receipt = await creator.create(request, instance, () => true)
    await expect(creator.create({ ...request, cols: 90 }, instance, () => true)).rejects.toMatchObject({ uncertain: true, recoveryNodeId: receipt.nodeId })
    expect(deps.create).toHaveBeenCalledTimes(1)
  })
  it('never rehydrates a completed journal into pane ownership after service restart', async () => {
    const request = agent(); const receipt = await creator.create(request, instance, () => true)
    creator = new ManagedTerminals(root, store, deps)
    await expect(creator.create(request, randomUUID(), () => true)).rejects.toMatchObject({ uncertain: true, recoveryNodeId: receipt.nodeId })
    expect(deps.create).toHaveBeenCalledTimes(1); expect(deps.deliver).toHaveBeenCalledTimes(1)
  })
  it('does not return a cached success when the original pane was replaced', async () => {
    const request = shell(); const receipt = await creator.create(request, instance, () => true)
    vi.mocked(deps.verify).mockResolvedValue(false)
    await expect(creator.create(request, instance, () => true)).rejects.toMatchObject({ uncertain: true, recoveryNodeId: receipt.nodeId })
    expect(deps.create).toHaveBeenCalledTimes(1)
  })
  it('does not reuse a confirmed receipt after the saved node was deleted', async () => {
    const request = shell(); const receipt = await creator.create(request, instance, () => true)
    const doc = await read(); doc.nodes = []; await fs.writeFile(file(), JSON.stringify(doc))
    await expect(creator.create(request, instance, () => true)).rejects.toMatchObject({ uncertain: true, recoveryNodeId: receipt.nodeId })
    expect(deps.create).toHaveBeenCalledTimes(1)
  })
  it('refuses launch after the saved pending command was removed while policy resolution awaited', async () => {
    const original = deps.revalidate; let calls = 0
    deps.revalidate = vi.fn(async (...args: Parameters<typeof original>) => {
      if (++calls === 3) { const doc = await read(); delete doc.nodes[0].pendingLaunch; await fs.writeFile(file(), JSON.stringify(doc)) }
      return original(...args)
    })
    await expect(creator.create(agent(), instance, () => true)).rejects.toMatchObject({ uncertain: true })
    expect(deps.deliver).not.toHaveBeenCalled()
  })
  it('passes a saved-intent fence through delayed pane attestation before launch input', async () => {
    const gate = deferred(), entered = deferred(); let wrote = false
    deps.deliver = vi.fn(async (_receipt, _command, current) => { entered.resolve(); await gate.promise; if (current()) wrote = true; return wrote })
    const operation = creator.create(agent(), instance, () => true); await entered.promise
    const doc = await read(); doc.nodes[0].accountId = 'replacement'; await fs.writeFile(file(), JSON.stringify(doc)); gate.resolve()
    await expect(operation).rejects.toMatchObject({ uncertain: true })
    expect(wrote).toBe(false); expect((await read()).nodes[0].pendingLaunch).toBeDefined()
  })
  it('does not issue a shell handoff after workspace deletion during the final pane proof', async () => {
    deps.verify = vi.fn(async () => { const doc = await read(); doc.nodes = []; await fs.writeFile(file(), JSON.stringify(doc)); return true })
    await expect(creator.create(shell(), instance, () => true)).rejects.toMatchObject({ uncertain: true })
  })
  it('retains an unconfirmed launch as manual-only visible recovery and never retries it', async () => {
    const request = agent(); vi.mocked(deps.deliver).mockResolvedValue(false)
    await expect(creator.create(request, instance, () => true)).rejects.toMatchObject({ uncertain: true })
    const node = (await read()).nodes[0]
    expect(node.pendingLaunch).toMatchObject({ attempted: true, manualOnly: true, executor: 'server' })
    await expect(creator.create(request, instance, () => true)).rejects.toMatchObject({ uncertain: true, recoveryNodeId: node.id })
    expect(deps.deliver).toHaveBeenCalledTimes(1)
  })
  it('retains a failed primitive as recovery without destructively guessing whether a pane exists', async () => {
    vi.mocked(deps.create).mockRejectedValue(new Error('lost backend response'))
    const request = agent()
    await expect(creator.create(request, instance, () => true)).rejects.toMatchObject({ uncertain: true })
    expect((await read()).nodes).toHaveLength(1)
    expect((await read()).nodes[0].pendingLaunch.manualOnly).toBe(true)
    creator = new ManagedTerminals(root, store, deps)
    await expect(creator.create(request, randomUUID(), () => true)).rejects.toMatchObject({ uncertain: true })
    expect(deps.create).toHaveBeenCalledTimes(1); expect(deps.deliver).not.toHaveBeenCalled()
  })
  it('does not create or publish when trust resolution loses the instance', async () => {
    const gate = deferred(), entered = deferred(); let current = true
    const original = deps.plan
    deps.plan = vi.fn(async (...args: Parameters<typeof original>) => { entered.resolve(); await gate.promise; return original(...args) })
    const operation = creator.create(agent(), instance, () => current); await entered.promise; current = false; gate.resolve()
    await expect(operation).rejects.toThrow(/instance changed/)
    expect(deps.create).not.toHaveBeenCalled(); expect((await read()).nodes).toHaveLength(0)
  })
  it('fences a primitive finishing after STOP and performs no later publication or launch', async () => {
    const gate = deferred(), entered = deferred(); let current = true
    const original = deps.create
    deps.create = vi.fn(async (...args: Parameters<typeof original>) => { entered.resolve(); await gate.promise; return original(...args) })
    const operation = creator.create(agent(), instance, () => current); await entered.promise; current = false; gate.resolve()
    await expect(operation).rejects.toMatchObject({ uncertain: true })
    expect((await read()).nodes).toHaveLength(0); expect(deps.deliver).not.toHaveBeenCalled()
  })
  it('revalidates host launch policy before delivery and leaves recovery intent if it changed', async () => {
    vi.mocked(deps.revalidate).mockResolvedValueOnce(true).mockResolvedValueOnce(true).mockResolvedValue(false)
    await expect(creator.create(agent(), instance, () => true)).rejects.toMatchObject({ uncertain: true })
    expect(deps.deliver).not.toHaveBeenCalled(); expect((await read()).nodes[0].pendingLaunch.attempted).toBe(true)
  })
  it('fails closed when registration is refused and does not submit an unregistered launch', async () => {
    vi.spyOn(store, 'appendManagedTerminal').mockResolvedValue(false)
    await expect(creator.create(agent(), instance, () => true)).rejects.toMatchObject({ uncertain: true })
    expect(deps.deliver).not.toHaveBeenCalled(); expect((await read()).nodes).toHaveLength(0)
  })
  it('cannot clear a replacement recovery intent after successful submission', async () => {
    deps.deliver = vi.fn(async () => { const doc = await read(); doc.nodes[0].cwd = '/replacement'; await fs.writeFile(file(), JSON.stringify(doc)); return true })
    await expect(creator.create(agent(), instance, () => true)).rejects.toMatchObject({ uncertain: true })
    expect((await read()).nodes[0].pendingLaunch.manualOnly).toBe(true)
  })
  it.each(['cwd', 'shell', 'agentId', 'accountId', 'agentModel', 'cols'])('refuses inconsistent host-plan %s identity before mutation', async (key) => {
    const original = deps.plan
    deps.plan = vi.fn(async (...args: Parameters<typeof original>) => {
      const plan = await original(...args)
      ;(plan.options as unknown as Record<string, unknown>)[key] = key === 'cols' ? 90 : 'replacement'
      return plan
    })
    await expect(creator.create(agent(), instance, () => true)).rejects.toThrow(/Invalid host/)
    expect(deps.create).not.toHaveBeenCalled(); expect((await read()).nodes).toHaveLength(0)
  })
  it('refuses a forged primitive identity without launch or confirmed handoff', async () => {
    const original = deps.create; deps.create = vi.fn(async (...args: Parameters<typeof original>) => ({ ...await original(...args), nodeId: 'term-forged-0' }))
    await expect(creator.create(agent(), instance, () => true)).rejects.toMatchObject({ uncertain: true })
    expect(deps.deliver).not.toHaveBeenCalled()
  })
  it('refuses unsafe journal directories and symlink records without touching their target', async () => {
    const request = shell(), foreign = path.join(root, 'foreign'); await fs.mkdir(foreign, { mode: 0o700 })
    await fs.symlink(foreign, creator.directory)
    await expect(creator.create(request, instance, () => true)).rejects.toThrow(/Unsafe/)
    await fs.unlink(creator.directory); await fs.mkdir(creator.directory, { mode: 0o700 })
    const target = path.join(foreign, 'public'); await fs.writeFile(target, 'do not read', { mode: 0o600 })
    await fs.symlink(target, path.join(creator.directory, request.creationId + '.json'))
    await expect(creator.create(request, instance, () => true)).rejects.toThrow()
    expect(await fs.readFile(target, 'utf8')).toBe('do not read'); expect(deps.create).not.toHaveBeenCalled()
  })
  it('cannot turn an unsafe completed journal into a cached success', async () => {
    const request = shell(); await creator.create(request, instance, () => true)
    await fs.chmod(path.join(creator.directory, request.creationId + '.json'), 0o644)
    await expect(creator.create(request, instance, () => true)).rejects.toMatchObject({ uncertain: true })
    expect(deps.create).toHaveBeenCalledTimes(1)
  })
  it('rejects unsafe journal file modes and never launches after operator-corrupted recovery', async () => {
    const request = agent(); vi.mocked(deps.deliver).mockResolvedValue(false)
    await expect(creator.create(request, instance, () => true)).rejects.toMatchObject({ uncertain: true })
    const journal = path.join(creator.directory, request.creationId + '.json'); await fs.chmod(journal, 0o644)
    await expect(creator.create(request, instance, () => true)).rejects.toMatchObject({ uncertain: true })
    expect(deps.deliver).toHaveBeenCalledTimes(1)
  })
  it.each([
    { cwd: '/caller' }, { command: 'echo injected' }, { nodeId: 'term-target-0' }, { kind: 'shell', agentId: 'claude' },
    { kind: 'agent', agentId: 'custom:untrusted' }, { accountId: '../account' }, { kind: 'agent', agentId: 'claude', accountId: '../account' }, { cols: 0 }, { rows: 501 }, { title: '\u001btitle' }
  ])('refuses caller launch/identity fields and malformed choices %j', (changes) => {
    expect(() => parseManagedTerminalRequest({ ...shell(), ...changes })).toThrow(/Invalid/)
  })
  it('refuses unsupported backends without journaling, planning or spawning', async () => {
    deps.supported = () => false
    await expect(creator.create(shell(), instance, () => true)).rejects.toThrow(/enabled POSIX tmux/)
    expect(deps.plan).not.toHaveBeenCalled(); expect(deps.create).not.toHaveBeenCalled()
  })
  it('advertises creation only with an enabled host coordinator and executes the real service/store path', async () => {
    const service = new SshActionsService(root, store, undefined, false, creator); await service.start()
    try {
      expect(service.methods).toContain('sessions.createManagedV1')
      const nonce = randomUUID(), request = agent()
      await fs.writeFile(path.join(service.directory, nonce + '.request'), JSON.stringify({ version: 1, instance: service.instance,
        nonce, issuedAt: Date.now(), method: 'sessions.createManagedV1', params: request }), { mode: 0o600 })
      await service.tick()
      const response = JSON.parse(await readSshActionFile(path.join(service.directory, nonce + '.response')))
      expect(response).toMatchObject({ ok: true, result: { hostInstance: service.instance, creationId: request.creationId, socket: 'node-terminal' } })
      expect((await read()).nodes[0].id).toBe(response.result.nodeId)
    } finally { await service.stop() }
    deps.supported = () => false
    expect(new SshActionsService(root, store, undefined, false, creator).methods).not.toContain('sessions.createManagedV1')
    expect(new SshActionsService(root, store).methods).not.toContain('sessions.createManagedV1')
  })
  it('returns explicit uncertainty and a safe recovery id after a private launch failure', async () => {
    deps.deliver = vi.fn(async () => { throw new Error('synthetic-secret-backend-error') })
    const service = new SshActionsService(root, store, undefined, false, creator); await service.start()
    try {
      const nonce = randomUUID(); await fs.writeFile(path.join(service.directory, nonce + '.request'), JSON.stringify({ version: 1,
        instance: service.instance, nonce, issuedAt: Date.now(), method: 'sessions.createManagedV1', params: agent() }), { mode: 0o600 })
      await service.tick()
      const raw = await readSshActionFile(path.join(service.directory, nonce + '.response')), response = JSON.parse(raw)
      expect(response).toMatchObject({ ok: false, uncertain: true, recoveryNodeId: (await read()).nodes[0].id })
      expect(raw).not.toContain('synthetic-secret-backend-error')
      expect((await read()).nodes[0].pendingLaunch).toMatchObject({ attempted: true, manualOnly: true, executor: 'server' })
    } finally { await service.stop() }
  })
  it('keeps service claim until canceled in-flight creation settles and never publishes its late receipt', async () => {
    const gate = deferred(), entered = deferred(), original = deps.create
    deps.create = vi.fn(async (...args: Parameters<typeof original>) => { entered.resolve(); await gate.promise; return original(...args) })
    const service = new SshActionsService(root, store, undefined, false, creator); await service.start()
    const nonce = randomUUID(); await fs.writeFile(path.join(service.directory, nonce + '.request'), JSON.stringify({ version: 1,
      instance: service.instance, nonce, issuedAt: Date.now(), method: 'sessions.createManagedV1', params: agent() }), { mode: 0o600 })
    const processing = service.tick(); await entered.promise; const stopping = service.stop()
    expect(await fs.stat(path.join(service.root, 'claim'))).toBeTruthy()
    gate.resolve(); await stopping; await expect(processing).rejects.toThrow(/instance changed/)
    expect((await read()).nodes).toHaveLength(0); expect(deps.deliver).not.toHaveBeenCalled()
    await expect(fs.stat(path.join(service.directory, nonce + '.response'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
