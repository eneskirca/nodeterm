import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { initPlatform, resetPlatformForTests } from './platform'
import { fakePlatform } from './platform-fake'
import { WorkspaceStore } from './workspace-store'
import { IPC } from '../shared/ipc'
import type { CanvasNodeState, Project } from '../shared/types'

let root: string, cwd: string, store: WorkspaceStore, platform: ReturnType<typeof fakePlatform>, project: Project
const node = (): CanvasNodeState => ({ id: 'term-owned-abcdef', kind: 'terminal', title: 'Claude', color: '#fff', group: null,
  position: { x: 100, y: 100 }, size: { width: 900, height: 560 }, cwd, shell: '/bin/bash', agentId: 'claude', accountId: 'personal',
  pendingLaunch: { command: 'claude --session-id owned', after: [], attempted: true, manualOnly: true, executor: 'server' } })
const file = () => path.join(cwd, '.nodeterm/project.json')
const read = async () => JSON.parse(await fs.readFile(file(), 'utf8'))
const indexFile = () => path.join(root, 'workspace.json')
const readIndex = async () => JSON.parse(await fs.readFile(indexFile(), 'utf8'))
const held = async () => (await readIndex()).entries.find((e: { id: string }) => e.id === 'p1').localExec[node().id]?.pendingLaunch
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'nt-managed-workspace-')); cwd = path.join(root, 'project'); await fs.mkdir(cwd)
  platform = fakePlatform({ userDataDir: root }); initPlatform(platform); store = new WorkspaceStore()
  project = { id: 'p1', name: 'owned', cwd, color: '#fff', viewport: { x: 0, y: 0, zoom: 1 }, nodes: [
    { ...node(), id: 'term-remote-donor', cwd: '/wrong-machine', ssh: { host: 'foreign', user: 'other' }, sshRemoteTmux: true } ] }
  await store.save({ version: 2, activeProjectId: 'p1', projects: [project] }); platform.sent.length = 0
})
afterEach(async () => { vi.restoreAllMocks(); resetPlatformForTests(); await fs.rm(root, { force: true, recursive: true }) })

// This authenticated creation path and its private UID/fsync journal are POSIX-only.
describe.skipIf(process.platform === 'win32')('host-managed workspace publication', () => {
  it('persists explicit local cwd/account/shell without copying a remote sibling and announces the mounted renderer', async () => {
    const owned = node(); const doc = await read(); doc.future = { retained: true }; await fs.writeFile(file(), JSON.stringify(doc)); await fs.chmod(file(), 0o644)
    expect(await store.appendManagedTerminal('p1', owned, { current: () => true })).toBe(true)
    const appended = (await read()).nodes.find((n: CanvasNodeState) => n.id === owned.id)
    expect(appended).toMatchObject({ cwd: '.', accountId: 'personal', agentId: 'claude' })
    expect(appended.shell).toBeUndefined();
    const index = JSON.parse(await fs.readFile(path.join(root, 'workspace.json'), 'utf8'))
    expect(index.entries[0].localExec[owned.id].shell).toBe('/bin/bash')
    expect(appended.ssh).toBeUndefined(); expect(appended.sshRemoteTmux).toBeUndefined()
    expect((await read()).future).toEqual({ retained: true }); expect((await fs.stat(file())).mode & 0o777).toBe(0o644)
    expect(platform.sent).toContainEqual({ to: 'broadcast', channel: IPC.workspaceServerChange, args: [expect.objectContaining({ id: 'p1', nodes: expect.arrayContaining([expect.objectContaining({ id: owned.id, cwd })]) })] })
    expect(platform.sent.some((event) => event.channel === IPC.workspaceExternalChange)).toBe(false)
  })
  it('preserves guarded attempted launch until only the matching host submission completes', async () => {
    const owned = node(); expect(await store.appendManagedTerminal('p1', owned, { current: () => true })).toBe(true)
    expect((await read()).nodes.find((n: CanvasNodeState) => n.id === owned.id).pendingLaunch).toBeUndefined()
    expect(await held()).toEqual(owned.pendingLaunch)
    const sharedBefore = await fs.readFile(file(), 'utf8')
    expect(await store.finishManagedTerminal('p1', owned, { current: () => true })).toBe(true)
    expect(await held()).toBeUndefined()
    expect((await readIndex()).entries[0].localExec[owned.id].shell).toBe('/bin/bash')
    expect(await fs.readFile(file(), 'utf8')).toBe(sharedBefore)
    expect(store.managedTerminalCurrent('p1', owned)).toBe(true)
  })
  it.each(['cwd', 'shell', 'agentId', 'accountId', 'command', 'manualOnly', 'executor', 'ssh', 'agentSessionId', 'agentModel'])('does not clear a changed %s recovery node', async (key) => {
    const owned = node(); await store.appendManagedTerminal('p1', owned, { current: () => true })
    const doc = await read(), saved = doc.nodes.find((n: CanvasNodeState) => n.id === owned.id)
    if (['command', 'manualOnly', 'executor', 'shell'].includes(key)) {
      const index = await readIndex(), local = index.entries[0].localExec[owned.id]
      if (key === 'command') local.pendingLaunch.command = 'replacement'
      else if (key === 'manualOnly') local.pendingLaunch.manualOnly = false
      else if (key === 'executor') delete local.pendingLaunch.executor
      else local.shell = '/replacement'
      await fs.writeFile(indexFile(), JSON.stringify(index)); await store.load({ sideline: false })
    } else if (key === 'ssh') saved.ssh = { host: 'foreign', user: 'other' }
    else saved[key] = 'replacement'
    await fs.writeFile(file(), JSON.stringify(doc))
    expect(await store.finishManagedTerminal('p1', owned, { current: () => true })).toBe(false)
    expect(await held()).toBeDefined()
  })
  it('reopens managed recovery from the local index without trusting a shared launch', async () => {
    const owned = node(); expect(await store.appendManagedTerminal('p1', owned, { current: () => true })).toBe(true)
    const shared = await read()
    shared.nodes.find((n: CanvasNodeState) => n.id === owned.id).pendingLaunch = { command: 'foreign command', after: [] }
    await fs.writeFile(file(), JSON.stringify(shared))
    const reopened = new WorkspaceStore(); await reopened.load({ sideline: false })
    expect(reopened.managedTerminalCurrent('p1', owned, true)).toBe(true)
    expect(await reopened.finishManagedTerminal('p1', owned, { current: () => true })).toBe(true)
    expect(await held()).toBeUndefined()
    expect(reopened.managedTerminalCurrent('p1', owned)).toBe(true)
    expect((await read()).nodes.find((n: CanvasNodeState) => n.id === owned.id).pendingLaunch.command).toBe('foreign command')
  })
  it('announces the fresh machine-local shell overlay when a load replaces the index during its publication', async () => {
    const owned = node(), original = fs.writeFile.bind(fs), indexFile = path.join(root, 'workspace.json')
    let replaced = false
    vi.spyOn(fs, 'writeFile').mockImplementation(async (...args: any[]) => {
      const result = await original(...args as Parameters<typeof fs.writeFile>)
      if (!replaced && String(args[0]).startsWith(indexFile + '.') && String(args[0]).endsWith('.tmp')) {
        replaced = true; await store.load({ sideline: false })
      }
      return result
    })
    expect(await store.appendManagedTerminal('p1', owned, { current: () => true })).toBe(true)
    expect(replaced).toBe(true)
    const announced = platform.sent.filter((event) => event.channel === IPC.workspaceServerChange).at(-1)!.args[0] as Project
    expect(announced.nodes.find((n) => n.id === owned.id)).toMatchObject({ cwd, shell: '/bin/bash', agentId: 'claude', accountId: 'personal' })
  })
  it('recognizes canonical portable cwd and machine-local shell after an ordinary desktop save', async () => {
    const owned = node(); await store.appendManagedTerminal('p1', owned, { current: () => true })
    expect(store.managedTerminalCurrent('p1', owned, true)).toBe(true)
    const loaded = await store.load({ sideline: false }); await store.save(loaded)
    expect((await read()).nodes.find((n: CanvasNodeState) => n.id === owned.id).shell).toBeUndefined()
    expect(store.managedTerminalCurrent('p1', owned, true)).toBe(true)
    expect(await store.finishManagedTerminal('p1', owned, { current: () => true })).toBe(true)
    expect(await store.managedTerminalPresent('p1', owned, () => true)).toBe(true)
  })
  it('rejects publication when the owning project target changes during the source read', async () => {
    const original = fs.readFile.bind(fs)
    vi.spyOn(fs, 'readFile').mockImplementation(async (...args: any[]) => {
      const result = await original(...args as Parameters<typeof fs.readFile>)
      if (args[0] === file()) (store as any).index.entries[0].closed = true
      return result
    })
    expect(await store.appendManagedTerminal('p1', node(), { current: () => true })).toBe(false)
    expect((await read()).nodes).toHaveLength(1)
  })
  it('does not append duplicate ids or unsafe/remote node facts', async () => {
    const owned = node(); expect(await store.appendManagedTerminal('p1', owned, { current: () => true })).toBe(true)
    const before = await fs.readFile(file(), 'utf8')
    expect(await store.appendManagedTerminal('p1', owned, { current: () => true })).toBe(false)
    for (const unsafe of [{ ...owned, id: 'term-../target' }, { ...owned, id: 'term-new-a', sshRemoteTmux: true }, { ...owned, id: 'term-new-b', cwd: '' }]) {
      expect(await store.appendManagedTerminal('p1', unsafe, { current: () => true })).toBe(false)
    }
    expect(await fs.readFile(file(), 'utf8')).toBe(before)
  })
  it('refuses a cwd-less or SSH-owned project even when it carries a local-looking cwd', async () => {
    const ssh = { server: { host: 'foreign', user: 'other' }, remoteCwd: '/remote' } as unknown as Project['ssh']
    await store.save({ version: 2, activeProjectId: 'p1', projects: [{ ...project, ssh, cwd }, { ...project, id: 'inline', cwd: undefined }] })
    expect(await store.appendManagedTerminal('p1', node(), { current: () => true })).toBe(false)
    expect(await store.appendManagedTerminal('inline', node(), { current: () => true })).toBe(false)
    await store.save({ version: 2, activeProjectId: 'p1', projects: [project] })
    // A malformed machine index can contain both: a local-looking cwd never grants a remote ref ownership.
    ;(store as any).index.entries[0].ssh = ssh
    const before = await fs.readFile(file(), 'utf8')
    expect(await store.appendManagedTerminal('p1', node(), { current: () => true })).toBe(false)
    expect(await fs.readFile(file(), 'utf8')).toBe(before)
  })
  it('cancels a publication queued behind a save without staging its node', async () => {
    let release!: () => void; const blocking = new Promise<void>((r) => { release = r })
    const entered = vi.fn(); const original = fs.readFile.bind(fs)
    vi.spyOn(fs, 'readFile').mockImplementation(async (...args: any[]) => {
      if (args[0] === file() && !entered.mock.calls.length) { entered(); await blocking }
      return original(...args as Parameters<typeof fs.readFile>)
    })
    const first = store.appendManagedTerminal('p1', { ...node(), id: 'term-first-abcd' }, { current: () => true })
    await vi.waitFor(() => expect(entered).toHaveBeenCalled())
    let current = true
    const queued = store.appendManagedTerminal('p1', node(), { current: () => current }); current = false; release()
    expect(await first).toBe(true); expect(await queued).toBe(false)
    expect((await read()).nodes.map((n: CanvasNodeState) => n.id)).not.toContain(node().id)
  })
  it('checks the instance again after the staged write and never publishes stale intent', async () => {
    const original = fs.writeFile.bind(fs); let current = true
    vi.spyOn(fs, 'writeFile').mockImplementation(async (...args: any[]) => {
      const result = await original(...args as Parameters<typeof fs.writeFile>)
      if (String(args[0]).startsWith(file() + '.') && String(args[0]).endsWith('.tmp')) current = false
      return result
    })
    expect(await store.appendManagedTerminal('p1', node(), { current: () => current })).toBe(false)
    expect((await read()).nodes.map((n: CanvasNodeState) => n.id)).not.toContain(node().id)
    expect((await fs.readdir(path.dirname(file()))).filter((n) => n.endsWith('.tmp'))).toHaveLength(0)
  })
  it('does not overwrite a changed recovery command edited while completion was staged', async () => {
    const owned = node(); await store.appendManagedTerminal('p1', owned, { current: () => true })
    const original = fs.writeFile.bind(fs)
    vi.spyOn(fs, 'writeFile').mockImplementation(async (...args: any[]) => {
      const result = await original(...args as Parameters<typeof fs.writeFile>)
      if (String(args[0]).startsWith(indexFile() + '.') && String(args[0]).endsWith('.tmp')) {
        const index = await readIndex(); index.entries[0].localExec[owned.id].pendingLaunch.command = 'changed by user'
        await original(indexFile(), JSON.stringify(index))
      }
      return result
    })
    expect(await store.finishManagedTerminal('p1', owned, { current: () => true })).toBe(false)
    expect((await held()).command).toBe('changed by user')
  })
  it('preserves a newer local intent loaded after completion renamed the index', async () => {
    const owned = node(); await store.appendManagedTerminal('p1', owned, { current: () => true })
    platform.sent.length = 0
    const replacement = { ...owned.pendingLaunch!, command: 'replacement after rename' }
    const original = fs.unlink.bind(fs); let replaced = false
    vi.spyOn(fs, 'unlink').mockImplementation(async (...args: any[]) => {
      if (!replaced && String(args[0]).startsWith(indexFile() + '.') && String(args[0]).endsWith('.tmp')) {
        replaced = true
        const index = await readIndex(); index.entries[0].localExec[owned.id].pendingLaunch = replacement
        await fs.writeFile(indexFile(), JSON.stringify(index)); await store.load({ sideline: false })
      }
      return original(...args as Parameters<typeof fs.unlink>)
    })
    expect(await store.finishManagedTerminal('p1', owned, { current: () => true })).toBe(false)
    expect(replaced).toBe(true)
    expect(await held()).toEqual(replacement)
    expect(store.managedTerminalCurrent('p1', { ...owned, pendingLaunch: replacement }, true)).toBe(true)
    expect(platform.sent.filter((event) => event.channel === IPC.workspaceServerChange)).toHaveLength(0)
  })
  it('preserves unrelated shared metadata changed while completion was staged', async () => {
    const owned = node(); await store.appendManagedTerminal('p1', owned, { current: () => true })
    const original = fs.writeFile.bind(fs)
    vi.spyOn(fs, 'writeFile').mockImplementation(async (...args: any[]) => {
      const result = await original(...args as Parameters<typeof fs.writeFile>)
      if (String(args[0]).startsWith(indexFile() + '.') && String(args[0]).endsWith('.tmp')) {
        const doc = await read(); doc.future = { concurrentEdit: 'preserve this' }; await original(file(), JSON.stringify(doc))
      }
      return result
    })
    expect(await store.finishManagedTerminal('p1', owned, { current: () => true })).toBe(false)
    expect((await read()).future).toEqual({ concurrentEdit: 'preserve this' })
    expect(await held()).toBeDefined()
  })
  it('publishes completion in queue order without erasing a following ordinary save', async () => {
    const owned = node(); await store.appendManagedTerminal('p1', owned, { current: () => true })
    const finishing = store.finishManagedTerminal('p1', owned, { current: () => true })
    const saving = store.save({ version: 2, activeProjectId: 'p1', projects: [{ ...project, nodes: [project.nodes[0], { ...owned, pendingLaunch: undefined, title: 'Renamed' }] }] })
    expect(await finishing).toBe(true); await saving
    const final = (await read()).nodes.find((n: CanvasNodeState) => n.id === owned.id)
    expect(final.title).toBe('Renamed'); expect(final.pendingLaunch).toBeUndefined()
  })
})
