import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initPlatform, resetPlatformForTests } from './platform'
import { fakePlatform } from './platform-fake'
import { WorkspaceStore } from './workspace-store'
import { IPC } from '../shared/ipc'
import type { Project, Workspace } from '../shared/types'

let dir: string
let userData: string
let fake: ReturnType<typeof fakePlatform>
let store: WorkspaceStore
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-adopt-'))
  userData = path.join(dir, 'data')
  fs.mkdirSync(userData)
  fake = fakePlatform({ userDataDir: userData })
  initPlatform(fake)
  store = new WorkspaceStore()
})
afterEach(() => {
  resetPlatformForTests()
  fs.rmSync(dir, { recursive: true, force: true })
})

const folder = (name: string): string => {
  const f = path.join(dir, name)
  fs.mkdirSync(f, { recursive: true })
  return f
}
const projectFile = (cwd: string): string => path.join(cwd, '.nodeterm', 'project.json')
const writeProjectFile = (cwd: string, nodes: unknown[], rev = 3): void => {
  fs.mkdirSync(path.join(cwd, '.nodeterm'), { recursive: true })
  fs.writeFileSync(projectFile(cwd), JSON.stringify({ version: 1, name: 'Shared', color: '#0a84ff', rev, nodes }))
}
const indexFile = (): string => path.join(userData, 'workspace.json')
const indexIds = (): string[] =>
  (JSON.parse(fs.readFileSync(indexFile(), 'utf8')) as { entries: { id: string }[] }).entries.map((e) => e.id)
const emptyProject = (id: string, name: string, cwd: string): Project =>
  ({ id, name, color: '#7aa2f7', cwd, viewport: { x: 0, y: 0, zoom: 1 }, nodes: [] })

describe('WorkspaceStore.adoptFolder', () => {
  it('a folder with no project file becomes an empty project named after the folder, saved', async () => {
    const f = folder('alpha')
    const r = await store.adoptFolder(f, { home: dir })
    expect(r.created).toBe(true)
    expect(r.projectName).toBe('alpha')
    const ws = await store.load({ sideline: false })
    expect(ws.projects.map((p) => p.id)).toContain(r.projectId)
    expect(await store.readProjectContent(r.projectId)).not.toBeNull() // the authority can read it now
  })

  it('an existing project.json keeps its node ids and content, gets a fresh project id, and its ~ cwds expand', async () => {
    const f = folder('beta')
    writeProjectFile(f, [
      { id: 'term-a.1', kind: 'terminal', position: { x: 1, y: 2 }, title: 'A', color: '#fff', cwd: '~/beta', sshRemoteTmux: true, agentId: 'claude' }
    ])
    const r = await store.adoptFolder(f, { home: '/home/u' })
    expect(r.created).toBe(true)
    expect(r.projectId).toMatch(/^project-/)
    const p = (await store.load({ sideline: false })).projects.find((x) => x.id === r.projectId)!
    expect(p.nodes.map((n) => n.id)).toEqual(['term-a.1'])
    expect(p.nodes[0].cwd).toBe('/home/u/beta')
    expect(p.nodes[0].sshRemoteTmux).toBeUndefined()
    expect(p.cwd).toBe(fs.realpathSync(f))
  })

  // Symlinks need a privilege a stock Windows account does not hold; the real-path rule itself is
  // platform-neutral, and the feature it serves (a Linux host's server) never runs there.
  it.skipIf(process.platform === 'win32')('the same folder again — by any path that resolves to it — reuses the id (created:false)', async () => {
    const f = folder('gamma')
    const link = path.join(dir, 'gamma-link')
    fs.symlinkSync(f, link)
    const a = await store.adoptFolder(f, { home: dir })
    const b = await store.adoptFolder(link, { home: dir })
    expect(b).toEqual({ projectId: a.projectId, projectName: a.projectName, created: false })
    expect((await store.load({ sideline: false })).projects.filter((p) => p.cwd === fs.realpathSync(f))).toHaveLength(1)
  })

  // Same reason as above. The other direction: the index holds the folder by a symlinked path (a
  // browser opened it that way), and the real path must still find it.
  it.skipIf(process.platform === 'win32')('reuses a project the index already holds under a path that resolves to the same folder', async () => {
    const f = folder('theta')
    const link = path.join(dir, 'theta-link')
    fs.symlinkSync(f, link)
    await store.save({ version: 2, activeProjectId: 'p-l', projects: [emptyProject('p-l', 'theta', link)] })
    const r = await store.adoptFolder(f, { home: dir })
    expect(r).toEqual({ projectId: 'p-l', projectName: 'theta', created: false })
    expect((await store.load({ sideline: false })).projects).toHaveLength(1)
  })

  it('runs on the save chain: a save queued before it is part of the workspace it writes', async () => {
    const a = folder('zeta')
    const b = folder('eta')
    const saving = store.save({ version: 2, activeProjectId: 'p-a', projects: [emptyProject('p-a', 'zeta', a)] })
    const r = await store.adoptFolder(b, { home: dir })
    await saving
    const ids = (await store.load({ sideline: false })).projects.map((p) => p.id)
    expect(ids).toEqual(['p-a', r.projectId])
  })

  it('E_BAD_CWD for a relative, missing or non-directory path', async () => {
    await expect(store.adoptFolder('rel/x', { home: dir })).rejects.toMatchObject({ code: 'E_BAD_CWD' })
    await expect(store.adoptFolder(path.join(dir, 'nope'), { home: dir })).rejects.toMatchObject({ code: 'E_BAD_CWD' })
    const file = path.join(dir, 'file.txt')
    fs.writeFileSync(file, 'x')
    await expect(store.adoptFolder(file, { home: dir })).rejects.toMatchObject({ code: 'E_BAD_CWD' })
  })

  it('E_BAD_CWD for the home directory, the root, or a folder that contains the home (nothing saved)', async () => {
    // Every teammate, Viewers included, may read any file under a shared folder.
    const home = folder('home/u')
    await expect(store.adoptFolder(home, { home })).rejects.toMatchObject({ code: 'E_BAD_CWD' })
    await expect(store.adoptFolder(path.join(dir, 'home'), { home })).rejects.toMatchObject({ code: 'E_BAD_CWD' })
    await expect(store.adoptFolder(path.parse(dir).root, { home })).rejects.toMatchObject({ code: 'E_BAD_CWD' })
    // Judged on real paths: a home reached through a link is still the home.
    if (process.platform !== 'win32') {
      const link = path.join(dir, 'home-link')
      fs.symlinkSync(home, link)
      await expect(store.adoptFolder(link, { home })).rejects.toMatchObject({ code: 'E_BAD_CWD' })
      await expect(store.adoptFolder(home, { home: link })).rejects.toMatchObject({ code: 'E_BAD_CWD' })
    }
    expect(fs.existsSync(indexFile())).toBe(false)
    // A folder inside the home, or beside it, is fine.
    expect((await store.adoptFolder(folder('home/u/proj'), { home })).created).toBe(true)
    expect((await store.adoptFolder(folder('home/u2'), { home })).created).toBe(true)
  })

  it('E_ADOPT_FAILED for a corrupt project file, which is left in place (never sidelined, never adopted empty)', async () => {
    const f = folder('delta')
    fs.mkdirSync(path.join(f, '.nodeterm'))
    fs.writeFileSync(path.join(f, '.nodeterm', 'project.json'), '{ not json')
    await expect(store.adoptFolder(f, { home: dir })).rejects.toMatchObject({ code: 'E_ADOPT_FAILED' })
    expect(fs.readFileSync(path.join(f, '.nodeterm', 'project.json'), 'utf8')).toBe('{ not json')
    expect((await store.load({ sideline: false })).projects).toHaveLength(0)
    expect(fs.existsSync(indexFile())).toBe(false) // nothing was saved at all
  })

  it('E_ADOPT_FAILED when the folder is already a project whose file cannot be read (an unavailable placeholder)', async () => {
    const f = folder('zeta')
    await store.adoptFolder(f, { home: dir })
    fs.writeFileSync(projectFile(f), '<<<<<<< HEAD')
    await expect(store.adoptFolder(f, { home: dir })).rejects.toMatchObject({ code: 'E_ADOPT_FAILED' })
    expect(fs.readFileSync(projectFile(f), 'utf8')).toBe('<<<<<<< HEAD')
  })

  it('a reused project is localized too: its ~ cwds expand and its SSH-session flags go', async () => {
    const f = folder('eta')
    await store.save({
      version: 2, activeProjectId: 'p-r',
      projects: [{
        ...emptyProject('p-r', 'eta', f),
        nodes: [{ id: 'term-r', kind: 'terminal', position: { x: 0, y: 0 }, title: 'R', color: '#fff', cwd: '~/eta', sshRemoteTmux: true } as Project['nodes'][number]]
      }]
    })
    expect((await store.load({ sideline: false })).projects[0].nodes[0].sshRemoteTmux).toBe(true) // the precondition is real
    const r = await store.adoptFolder(f, { home: '/home/u' })
    expect(r).toMatchObject({ projectId: 'p-r', created: false })
    const n = (await store.load({ sideline: false })).projects[0].nodes[0]
    expect(n.cwd).toBe('/home/u/eta')
    expect(n.sshRemoteTmux).toBeUndefined()
  })

  it('keeps the adopted file\'s rev monotonic: a file at rev 7 is written back at rev 8', async () => {
    const f = folder('theta-rev')
    writeProjectFile(f, [{ id: 'term-v', kind: 'terminal', position: { x: 0, y: 0 }, title: 'V', color: '#fff' }], 7)
    await store.adoptFolder(f, { home: dir })
    expect(JSON.parse(fs.readFileSync(projectFile(f), 'utf8')).rev).toBe(8)
  })

  it('E_ADOPT_FAILED, and the index left byte for byte, when this server\'s workspace index cannot be read', async () => {
    const f = folder('iota')
    fs.writeFileSync(indexFile(), '{ garbage')
    await expect(store.adoptFolder(f, { home: dir })).rejects.toMatchObject({ code: 'E_ADOPT_FAILED' })
    expect(fs.readFileSync(indexFile(), 'utf8')).toBe('{ garbage')
    // A shape this build does not recognise (a newer build's index) is just as unreadable to it.
    fs.writeFileSync(indexFile(), '{"version":99,"entries":[]}')
    await expect(store.adoptFolder(f, { home: dir })).rejects.toMatchObject({ code: 'E_ADOPT_FAILED' })
    expect(fs.readFileSync(indexFile(), 'utf8')).toBe('{"version":99,"entries":[]}')
  })

  it('a readable index with no projects is not a failure (a server opened in a browser once, never used)', async () => {
    fs.writeFileSync(indexFile(), JSON.stringify({ version: 3, entries: [] }))
    const r = await store.adoptFolder(folder('kappa'), { home: dir })
    expect(r.created).toBe(true)
    expect(indexIds()).toEqual([r.projectId])
  })

  describe('a renderer that loaded before the adoption', () => {
    // Load and save take the caller's client id first (both are registered with their sender).
    const OWNER = 1
    const save = (ws: Workspace): Promise<unknown> => Promise.resolve(fake.handlers[IPC.workspaceSave](OWNER, ws))
    const load = (sender = OWNER): Promise<Workspace> =>
      Promise.resolve(fake.handlers[IPC.workspaceLoad](sender) as Workspace)

    it('cannot drop the adopted project with its stale autosave; once a renderer has loaded it, it can', async () => {
      store.registerIpc()
      const a = folder('lam-a')
      const stale = await load() // an open browser tab, loaded before the bootstrap
      expect(stale.projects).toHaveLength(0)
      const withA: Workspace = { ...stale, activeProjectId: 'p-a', projects: [emptyProject('p-a', 'lam-a', a)] }
      await save(withA)
      const r = await store.adoptFolder(folder('lam-b'), { home: dir })
      await save(withA) // that tab's next autosave knows nothing of the adoption
      expect(indexIds()).toEqual(['p-a', r.projectId])
      const fresh = await load()
      expect(fresh.projects.map((p) => p.id)).toContain(r.projectId)
      await save(withA) // a renderer that HAS seen it and saves without it is deleting it
      expect(indexIds()).toEqual(['p-a'])
    })

    it('a load by a client that cannot save (a relay peer, a hosted guest) does not hand the adoption out', async () => {
      fake.isOwnerClient = (id: number) => id === OWNER
      store.registerIpc()
      const stale = await load(OWNER) // the owner's tab, loaded before the bootstrap
      const withA: Workspace = { ...stale, activeProjectId: 'p-a', projects: [emptyProject('p-a', 'mu-a', folder('mu-a'))] }
      await save(withA)
      const r = await store.adoptFolder(folder('mu-b'), { home: dir })
      const guest = await load(7) // a teammate joins and loads: it sees the project, but it can never save
      expect(guest.projects.map((p) => p.id)).toContain(r.projectId)
      await save(withA) // the owner's stale tab autosaves
      expect(indexIds()).toEqual(['p-a', r.projectId])
      await load(OWNER) // the owner's tab reloads: now its saves speak for the project
      await save(withA)
      expect(indexIds()).toEqual(['p-a'])
    })
  })

  it('a closed adopted project is reopened when adopted again', async () => {
    const f = folder('eps')
    const a = await store.adoptFolder(f, { home: dir })
    const ws = await store.load({ sideline: false })
    ws.projects.find((p) => p.id === a.projectId)!.closed = true
    await store.save(ws)
    await store.adoptFolder(f, { home: dir })
    expect((await store.load({ sideline: false })).projects.find((p) => p.id === a.projectId)!.closed).toBeFalsy()
  })
})
