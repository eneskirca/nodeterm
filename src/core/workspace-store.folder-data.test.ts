// A folder project can keep its canvas in app data instead of `<cwd>/.nodeterm/project.json`
// (issue #1145): the FOLDER-DATA-REF, a local-data ref with a working directory. The promise is
// that nothing is written into the folder, and the traps are the ways an existing path would
// break it: the watcher re-reading the folder file, a missing data file falling through to the
// folder branch, an older build writing a fresh file into the folder, and a copy left behind on
// the side a move departs from.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'fs'
import { execFileSync } from 'child_process'
import os from 'os'
import path from 'path'
import { initPlatform, resetPlatformForTests } from './platform'
import { fakePlatform } from './platform-fake'
import { WorkspaceStore } from './workspace-store'
import { readWhiteboard, saveWhiteboard } from './whiteboards'
import type { CanvasNodeState, Project, Workspace } from '../shared/types'

let userData: string
let folder: string
let fake: ReturnType<typeof fakePlatform>

const node = (id: string, over: Partial<CanvasNodeState> = {}): CanvasNodeState => ({
  id, kind: 'terminal', position: { x: 0, y: 0 }, size: { width: 1, height: 1 },
  title: id, color: '#fff', group: null, ...over
})
const project = (over: Partial<Project> = {}): Project => ({
  id: 'project-p1', name: 'client-repo', color: '#7aa2f7', viewport: { x: 4, y: 5, zoom: 2 },
  cwd: folder, storeInAppData: true, nodes: [node('term-1', { cwd: path.join(folder, 'sub') })], ...over
})
const ws = (projects: Project[], active = projects[0]?.id ?? ''): Workspace =>
  ({ version: 2, activeProjectId: active, projects })

const dataFile = (id: string) => path.join(userData, 'inline-projects', `${id}.json`)
const folderFile = () => path.join(folder, '.nodeterm', 'project.json')
const readIndex = async () =>
  JSON.parse(await fs.readFile(path.join(userData, 'workspace.json'), 'utf-8'))
const writeIndex = async (index: unknown) =>
  fs.writeFile(path.join(userData, 'workspace.json'), JSON.stringify(index))
const readData = async (id: string) => JSON.parse(await fs.readFile(dataFile(id), 'utf-8'))
const exists = (p: string) => fs.access(p).then(() => true, () => false)
const ids = (nodes: CanvasNodeState[]) => nodes.map((n) => n.id)
const foreignFile = (nodeId: string) => JSON.stringify({
  version: 1, rev: 99, savedAt: '2026-01-01T00:00:00.000Z', name: 'teammate', color: '#000',
  viewport: { x: 0, y: 0, zoom: 1 }, nodes: [node(nodeId)]
})

beforeEach(async () => {
  userData = await fs.mkdtemp(path.join(os.tmpdir(), 'nt-folder-data-'))
  folder = await fs.mkdtemp(path.join(os.tmpdir(), 'nt-folder-data-repo-'))
  fake = fakePlatform({ userDataDir: userData })
  initPlatform(fake)
})
afterEach(async () => {
  resetPlatformForTests()
  await fs.rm(userData, { recursive: true, force: true })
  await fs.rm(folder, { recursive: true, force: true })
})

describe('a folder project stored in app data', () => {
  it('writes its canvas to app data and nothing into the folder', async () => {
    await new WorkspaceStore().save(ws([project()]))

    expect(await fs.readdir(folder)).toEqual([])
    expect(ids((await readData('project-p1')).nodes)).toEqual(['term-1'])
    const entry = (await readIndex()).entries[0]
    expect(entry).toMatchObject({ id: 'project-p1', cwd: folder, dataFile: true })
  })

  it('round-trips with its folder, the flag and absolute node cwds', async () => {
    await new WorkspaceStore().save(ws([project()]))
    const loaded = (await new WorkspaceStore().load()).projects[0]

    expect(loaded).toMatchObject({ id: 'project-p1', cwd: folder, storeInAppData: true })
    expect(loaded.nodes[0].cwd).toBe(path.join(folder, 'sub'))
    expect(loaded.viewport).toEqual({ x: 4, y: 5, zoom: 2 })
  })

  it('stores the index cache without cwd, so an older build opens an inline canvas', async () => {
    await new WorkspaceStore().save(ws([project()]))
    const index = await readIndex()
    expect(index.entries[0].project.cwd).toBeUndefined()
    expect(index.entries[0].project.storeInAppData).toBeUndefined()

    // A build that predates the kind takes the `e.project` branch: the same as this build reading
    // the entry without its `dataFile` flag.
    delete index.entries[0].dataFile
    await writeIndex(index)
    const old = new WorkspaceStore()
    const loaded = (await old.load()).projects[0]
    expect(loaded.cwd).toBeUndefined()
    expect(ids(loaded.nodes)).toEqual(['term-1'])

    await old.save(ws([loaded]))
    expect(await exists(path.join(folder, '.nodeterm'))).toBe(false)
  })

  it('reads its data file, never the folder file a teammate committed', async () => {
    await new WorkspaceStore().save(ws([project()]))
    await fs.mkdir(path.join(folder, '.nodeterm'))
    await fs.writeFile(folderFile(), foreignFile('term-foreign'))

    const loaded = (await new WorkspaceStore().load()).projects[0]
    expect(ids(loaded.nodes)).toEqual(['term-1'])
  })

  it('falls back to its cache, then a placeholder, never to the folder file', async () => {
    await new WorkspaceStore().save(ws([project()]))
    await fs.mkdir(path.join(folder, '.nodeterm'))
    await fs.writeFile(folderFile(), foreignFile('term-foreign'))
    await fs.rm(dataFile('project-p1'))

    const fromCache = (await new WorkspaceStore().load()).projects[0]
    expect(fromCache).toMatchObject({ cwd: folder, storeInAppData: true })
    expect(ids(fromCache.nodes)).toEqual(['term-1'])

    const index = await readIndex()
    delete index.entries[0].project
    await writeIndex(index)
    const store = new WorkspaceStore()
    const placeholder = (await store.load()).projects[0]
    expect(placeholder).toMatchObject({ unavailable: true, storeInAppData: true, cwd: folder })
    expect(placeholder.nodes).toEqual([])

    // Saving the placeholder back keeps the kind, so the next load still does not read the folder.
    await store.save(ws([placeholder]))
    expect((await readIndex()).entries[0]).toMatchObject({ cwd: folder, dataFile: true })
    expect((await new WorkspaceStore().load()).projects[0].unavailable).toBe(true)
  })

  it('is not watched: its folder file is not a local ref path', async () => {
    const store = new WorkspaceStore()
    await store.save(ws([project(), project({ id: 'project-p2', storeInAppData: undefined, cwd: folder + '-b' })]))
    expect(store.localRefPaths()).toEqual([path.join(folder + '-b', '.nodeterm', 'project.json')])
    expect(await store.readLocalRef('project-p1')).toBeNull()
    await fs.rm(folder + '-b', { recursive: true, force: true })
  })

  it('sits beside a folder ref on the same folder without demoting either', async () => {
    const store = new WorkspaceStore()
    await store.save(ws([
      project({ id: 'project-ref', storeInAppData: undefined, nodes: [node('term-ref')] }),
      project()
    ]))
    const [ref, data] = (await new WorkspaceStore().load()).projects
    expect(ids(ref.nodes)).toEqual(['term-ref'])
    expect(ref.storeInAppData).toBeUndefined()
    expect(ids(data.nodes)).toEqual(['term-1'])
    expect(data.storeInAppData).toBe(true)

    // The folder's file belongs to the ref: an outside edit to it reaches the ref, whichever of
    // the two entries comes first in the index.
    const watched = new WorkspaceStore()
    await watched.save(ws([project(), project({ id: 'project-ref', storeInAppData: undefined, nodes: [node('term-ref')] })]))
    expect((await watched.readLocalRefByPath(folderFile()))?.id).toBe('project-ref')
  })
})

describe('its side files', () => {
  it('canvas images take the app-data fallback; the board log gets a userData root', async () => {
    const store = new WorkspaceStore()
    await store.save(ws([project(), project({ id: 'project-ref', storeInAppData: undefined, cwd: folder + '-b' })]))

    // Terminals still run in the folder…
    expect(store.localCwdForProject('project-p1')).toBe(folder)
    // …but nodeterm writes nothing there.
    expect(store.sideFilesFolderForProject('project-p1')).toBeUndefined()
    expect(store.boardLogRootForProject('project-p1')).toBe(path.join(userData, 'project-files', 'project-p1'))

    // A folder ref is unchanged: both answer its folder.
    expect(store.sideFilesFolderForProject('project-ref')).toBe(folder + '-b')
    expect(store.boardLogRootForProject('project-ref')).toBe(folder + '-b')
    await fs.rm(folder + '-b', { recursive: true, force: true })
  })

  it("whiteboards live in its app-data root, never in the folder, and are not shared by node id", async () => {
    // Two folders holding the same committed canvas (a worktree, a second checkout) share node ids.
    // In their folders each board has its own file; in app data they must not share one either.
    const store = new WorkspaceStore()
    await store.save(ws([project(), project({ id: 'project-p2', cwd: folder + '-b' })]))
    const board = (id: string) => ({ ...store.whiteboardLocationForProject(id), userDataDir: userData })
    const scene = JSON.stringify({ type: 'excalidraw', elements: [{ id: 'mine' }] })

    const saved = await saveWhiteboard(board('project-p1'), 'whiteboard-1', scene)
    expect(saved).toMatchObject({
      ok: true,
      path: path.join(userData, 'project-files', 'project-p1', '.nodeterm', 'whiteboards', 'whiteboard-1.excalidraw')
    })
    expect(await fs.readdir(folder)).toEqual([])
    expect(await readWhiteboard(board('project-p2'), 'whiteboard-1')).toBeNull()

    // Deleting the project takes its boards with its other app-data side files.
    await store.save(ws([project({ id: 'project-p2', cwd: folder + '-b' })]))
    expect(await readWhiteboard(board('project-p1'), 'whiteboard-1')).toBeNull()
    await fs.rm(folder + '-b', { recursive: true, force: true })
  })

  it('whiteboard locations: a folder ref writes its folder; a cwd-less canvas has none', async () => {
    const store = new WorkspaceStore()
    await store.save(ws([
      project({ id: 'project-ref', storeInAppData: undefined }),
      project({ id: 'project-inline', storeInAppData: undefined, cwd: undefined })
    ]))
    // A folder ref writes its folder and reads, after it, what it drew while it was in app data.
    expect(store.whiteboardLocationForProject('project-ref')).toEqual({
      projectCwd: folder, readOnlyRoot: path.join(userData, 'project-files', 'project-ref')
    })
    // A cwd-less canvas (and an unknown id) takes the app folder alone.
    expect(store.whiteboardLocationForProject('project-inline')).toEqual({})
    expect(store.whiteboardLocationForProject('no-such-project')).toEqual({})
    // A folder project in app data writes its app-data root and only reads its folder.
    await store.save(ws([project({ id: 'project-ref' })]))
    expect(store.whiteboardLocationForProject('project-ref')).toEqual({
      projectCwd: path.join(userData, 'project-files', 'project-ref'), createRoot: true, readOnlyRoot: folder
    })
  })
})

describe('the phone writers', () => {
  const changes = () => fake.sent.filter((m) => m.channel === 'workspace:external-change').map((m) => m.args[0])

  it('a session registered from the phone lands in the data file, rooted in the folder', async () => {
    const store = new WorkspaceStore()
    await store.save(ws([project({ nodes: [] })]))
    fake.sent.length = 0

    expect(await store.appendRemoteNode('project-p1', { id: 'term-zz1-1', title: 'Mobile' })).toBe(true)
    expect(await fs.readdir(folder)).toEqual([])
    const added = (await readData('project-p1')).nodes.find((n: CanvasNodeState) => n.id === 'term-zz1-1')
    // The append's portable '.' default is resolved: this file keeps absolute cwds.
    expect(added.cwd).toBe(folder)
    // The canvas hears about it with its folder and the flag, so the next save stays in app data.
    expect(changes()).toHaveLength(1)
    expect(changes()[0]).toMatchObject({ id: 'project-p1', cwd: folder, storeInAppData: true })

    const loaded = (await new WorkspaceStore().load()).projects[0]
    expect(ids(loaded.nodes)).toEqual(['term-zz1-1'])
    expect(loaded.nodes[0].cwd).toBe(folder)
  })

  it('ending a session from the phone removes it from the data file', async () => {
    const store = new WorkspaceStore()
    await store.save(ws([project()]))
    expect(await store.removeRemoteNode('term-1')).toBe(true)
    expect((await readData('project-p1')).nodes).toEqual([])
    expect(await fs.readdir(folder)).toEqual([])
    expect(await store.removeRemoteNode('term-nowhere')).toBe(false)
  })

  it('the phone board lands in the data file', async () => {
    const store = new WorkspaceStore()
    await store.save(ws([project()]))
    const columns = await store.ensureRemoteBoard('project-p1')
    expect(columns?.length).toBeGreaterThan(0)
    expect((await readData('project-p1')).kanban.columns).toHaveLength(columns!.length)
    expect(await fs.readdir(folder)).toEqual([])
  })
})

describe('its project settings', () => {
  it('live in its app-data root, still as the shared document', async () => {
    const store = new WorkspaceStore()
    await store.save(ws([project()]))
    // A settings.json committed in the folder is not this project's.
    await fs.mkdir(path.join(folder, '.nodeterm'))
    await fs.writeFile(path.join(folder, '.nodeterm', 'settings.json'), JSON.stringify({ version: 1, rev: 5, savedAt: '', terminal: { shell: '/bin/evil' } }))

    expect((await store.readProjectSettings('project-p1'))?.shared).toBeNull()
    expect(await store.writeProjectSettings('project-p1', { terminal: { shell: '/bin/zsh' } })).toBe(true)

    const own = path.join(userData, 'project-files', 'project-p1', '.nodeterm', 'settings.json')
    expect(JSON.parse(await fs.readFile(own, 'utf-8')).terminal.shell).toBe('/bin/zsh')
    expect(JSON.parse(await fs.readFile(path.join(folder, '.nodeterm', 'settings.json'), 'utf-8')).terminal.shell).toBe('/bin/evil')
    // Read back as `shared` (never folded into the machine-local overlay), so every consent rule
    // that guards a shared value still applies.
    const read = await new WorkspaceStore().load().then(async () => store.readProjectSettings('project-p1'))
    expect(read?.shared?.terminal?.shell).toBe('/bin/zsh')
    expect(read?.local).toBeUndefined()
  })
})

describe('moving a folder project between the two locations', () => {
  it('to app data: writes the data file and clears an older copy of its own first', async () => {
    const store = new WorkspaceStore()
    // A leftover from an earlier stay in app data: same id, populated.
    await fs.mkdir(path.dirname(dataFile('project-p1')), { recursive: true })
    await fs.writeFile(dataFile('project-p1'), foreignFile('term-stale'))
    await store.save(ws([project({ storeInAppData: undefined, nodes: [] })]))

    await store.save(ws([project({ nodes: [] })]))
    const loaded = (await new WorkspaceStore().load()).projects[0]
    expect(loaded.nodes).toEqual([])
    expect(loaded.storeInAppData).toBe(true)
  })

  it('to the folder: writes the folder file, then deletes the data file', async () => {
    const store = new WorkspaceStore()
    await store.save(ws([project()]))
    await store.save(ws([project({ storeInAppData: undefined })]))

    expect(await exists(dataFile('project-p1'))).toBe(false)
    const file = JSON.parse(await fs.readFile(folderFile(), 'utf-8'))
    expect(ids(file.nodes)).toEqual(['term-1'])
    // The folder file carries portable cwds, as every folder project's does.
    expect(file.nodes[0].cwd).toBe('./sub')
    const loaded = (await new WorkspaceStore().load()).projects[0]
    expect(loaded.storeInAppData).toBeUndefined()
    expect(loaded.nodes[0].cwd).toBe(path.join(folder, 'sub'))

    // The rev continues across the move: the project's counter was not reset with the sweep.
    const rev = file.rev
    await store.save(ws([project({ storeInAppData: undefined, nodes: [node('term-1'), node('term-2')] })]))
    expect(JSON.parse(await fs.readFile(folderFile(), 'utf-8')).rev).toBe(rev + 1)
  })

  it('to the folder: keeps the data file while the folder write cannot land', async () => {
    const store = new WorkspaceStore()
    await store.save(ws([project()]))
    // A FILE where the `.nodeterm` directory would go: the folder leg's mkdir fails.
    await fs.writeFile(path.join(folder, '.nodeterm'), 'not a directory')
    await store.save(ws([project({ storeInAppData: undefined })]))

    expect(ids((await readData('project-p1')).nodes)).toEqual(['term-1'])
  })

  it('to the folder: a write that cannot land leaves the project in app data, index included', async () => {
    const store = new WorkspaceStore()
    await store.save(ws([project()]))
    await fs.writeFile(path.join(folder, '.nodeterm'), 'not a directory')
    await store.save(ws([project({ storeInAppData: undefined })]))

    // The store says where the canvas is, so the menu can say the move did not happen…
    expect(await store.projectStorage('project-p1')).toBe('appData')
    expect((await readIndex()).entries[0]).toMatchObject({ cwd: folder, dataFile: true })
    // …and a restart still finds it.
    const loaded = (await new WorkspaceStore().load()).projects[0]
    expect(loaded).toMatchObject({ cwd: folder, storeInAppData: true })
    expect(ids(loaded.nodes)).toEqual(['term-1'])

    // Once the folder can be written, the next save completes the move.
    await fs.rm(path.join(folder, '.nodeterm'))
    await store.save(ws([project({ storeInAppData: undefined })]))
    expect(await store.projectStorage('project-p1')).toBe('folder')
    expect(ids(JSON.parse(await fs.readFile(folderFile(), 'utf-8')).nodes)).toEqual(['term-1'])
    expect(await exists(dataFile('project-p1'))).toBe(false)
  })

  it('"Set folder…" on a cwd-less canvas no longer leaves its data file behind', async () => {
    const store = new WorkspaceStore()
    await store.save(ws([project({ cwd: undefined, storeInAppData: undefined })]))
    expect(await exists(dataFile('project-p1'))).toBe(true)

    await store.save(ws([project({ storeInAppData: undefined })]))
    expect(await exists(dataFile('project-p1'))).toBe(false)
    expect(await exists(folderFile())).toBe(true)
  })
})

describe('the move steps', () => {
  const settingsIn = (root: string) => path.join(root, '.nodeterm', 'settings.json')
  const appRoot = () => path.join(userData, 'project-files', 'project-p1')
  const seedFolder = async () => {
    await fs.mkdir(path.join(folder, '.nodeterm'), { recursive: true })
    await fs.writeFile(settingsIn(folder), JSON.stringify({ version: 1, rev: 3, savedAt: '', terminal: { shell: '/bin/zsh' } }))
  }

  it('release: carries settings into app data and removes the folder files', async () => {
    const store = new WorkspaceStore()
    await seedFolder()
    await store.save(ws([project({ storeInAppData: undefined })]))
    expect(await exists(folderFile())).toBe(true)

    await store.save(ws([project()]))
    const res = await store.releaseFolderFiles('project-p1', false)
    expect(res).toEqual({ ok: true, removed: [folderFile(), settingsIn(folder)], kept: [] })
    expect(await exists(path.join(folder, '.nodeterm'))).toBe(false)
    expect(JSON.parse(await fs.readFile(settingsIn(appRoot()), 'utf-8')).terminal.shell).toBe('/bin/zsh')
    expect((await store.readProjectSettings('project-p1'))?.shared?.terminal?.shell).toBe('/bin/zsh')
  })

  it("release: the folder's current settings win over a leftover app-data copy", async () => {
    const store = new WorkspaceStore()
    await seedFolder()
    await fs.mkdir(path.dirname(settingsIn(appRoot())), { recursive: true })
    await fs.writeFile(settingsIn(appRoot()), JSON.stringify({ version: 1, rev: 9, savedAt: '', terminal: { shell: '/bin/stale' } }))
    await store.save(ws([project({ storeInAppData: undefined })]))
    await store.save(ws([project()]))

    expect((await store.releaseFolderFiles('project-p1', false)).ok).toBe(true)
    const own = JSON.parse(await fs.readFile(settingsIn(appRoot()), 'utf-8'))
    expect(own.terminal.shell).toBe('/bin/zsh')
    expect(own.rev).toBe(10)
  })

  it('release: keeps files git tracks unless told to remove them', async () => {
    execFileSync('git', ['init', '-q'], { cwd: folder })
    const store = new WorkspaceStore()
    await store.save(ws([project({ storeInAppData: undefined })]))
    execFileSync('git', ['add', '.nodeterm/project.json'], { cwd: folder })

    await store.save(ws([project()]))
    expect(await store.releaseFolderFiles('project-p1', false)).toEqual({ ok: true, removed: [], kept: [folderFile()] })
    expect(await exists(folderFile())).toBe(true)
    expect(await store.releaseFolderFiles('project-p1', true)).toEqual({ ok: true, removed: [folderFile()], kept: [] })
    expect(await exists(folderFile())).toBe(false)
  })

  it('release: refused for a project whose canvas is still in its folder', async () => {
    const store = new WorkspaceStore()
    await store.save(ws([project({ storeInAppData: undefined })]))
    expect(await store.releaseFolderFiles('project-p1', true)).toEqual({ ok: false, reason: 'not-app-data' })
    expect(await exists(folderFile())).toBe(true)
  })

  it('a round trip with an unchanged canvas writes the folder file again before the data file goes', async () => {
    const store = new WorkspaceStore()
    await store.save(ws([project({ storeInAppData: undefined })]))
    await store.save(ws([project()]))
    await store.releaseFolderFiles('project-p1', false)
    expect(await exists(folderFile())).toBe(false)

    expect(await store.prepareFolderStorage('project-p1')).toEqual({ ok: true })
    await store.save(ws([project({ storeInAppData: undefined })]))
    expect(ids(JSON.parse(await fs.readFile(folderFile(), 'utf-8')).nodes)).toEqual(['term-1'])
    expect(await exists(dataFile('project-p1'))).toBe(false)
  })

  it('prepare: refuses a folder that already holds a canvas or settings', async () => {
    const store = new WorkspaceStore()
    await store.save(ws([project()]))
    await fs.mkdir(path.join(folder, '.nodeterm'))
    await fs.writeFile(folderFile(), foreignFile('term-foreign'))
    expect(await store.prepareFolderStorage('project-p1')).toEqual({ ok: false, reason: 'occupied' })

    await fs.rm(folderFile())
    await fs.writeFile(settingsIn(folder), JSON.stringify({ version: 1, rev: 1, savedAt: '' }))
    expect(await store.prepareFolderStorage('project-p1')).toEqual({ ok: false, reason: 'settings-occupied' })
  })

  it('prepare + save: the settings follow the canvas into the folder, and leave app data', async () => {
    const store = new WorkspaceStore()
    await store.save(ws([project()]))
    await store.writeProjectSettings('project-p1', { terminal: { shell: '/bin/fish' } })

    expect(await store.prepareFolderStorage('project-p1')).toEqual({ ok: true })
    expect(JSON.parse(await fs.readFile(settingsIn(folder), 'utf-8')).terminal.shell).toBe('/bin/fish')
    await store.save(ws([project({ storeInAppData: undefined })]))
    expect(await exists(settingsIn(appRoot()))).toBe(false)
    expect((await store.readProjectSettings('project-p1'))?.shared?.terminal?.shell).toBe('/bin/fish')
  })

  it('a round trip with a board edited in app data opens the edited board, not the folder copy', async () => {
    const store = new WorkspaceStore()
    const board = () => ({ ...store.whiteboardLocationForProject('project-p1'), userDataDir: userData })
    const sceneOf = (tag: string) => JSON.stringify({ type: 'excalidraw', elements: [{ id: tag }] })
    // Drawn while the canvas was in the folder, then moved into app data and edited there…
    await store.save(ws([project({ storeInAppData: undefined })]))
    await saveWhiteboard(board(), 'whiteboard-1', sceneOf('before'))
    await store.save(ws([project()]))
    await store.releaseFolderFiles('project-p1', false)
    const opened = await readWhiteboard(board(), 'whiteboard-1')
    expect(opened?.scene).toBe(sceneOf('before'))
    expect(await saveWhiteboard(board(), 'whiteboard-1', sceneOf('edited'), undefined, opened!.rev)).toMatchObject({ ok: true })
    // The folder still holds the board as it was before the move.
    const inFolder = path.join(folder, '.nodeterm', 'whiteboards', 'whiteboard-1.excalidraw')
    expect(await fs.readFile(inFolder, 'utf-8')).toBe(sceneOf('before'))

    // …and moved back: the edit comes with it.
    expect(await store.prepareFolderStorage('project-p1')).toEqual({ ok: true })
    await store.save(ws([project({ storeInAppData: undefined })]))
    expect((await readWhiteboard(board(), 'whiteboard-1'))?.scene).toBe(sceneOf('edited'))
    expect(await fs.readFile(inFolder, 'utf-8')).toBe(sceneOf('edited'))
  })

  it('a move back that skipped prepare keeps the app-data settings', async () => {
    const store = new WorkspaceStore()
    await store.save(ws([project()]))
    await store.writeProjectSettings('project-p1', { terminal: { shell: '/bin/fish' } })
    await store.save(ws([project({ storeInAppData: undefined })]))
    expect(await exists(settingsIn(appRoot()))).toBe(true)
  })
})

// A move into a folder deletes the data file. The store may do that only once the folder file
// really holds the canvas, and its record of what it last wrote to a folder is not proof: a file
// can leave the folder behind the store's back (`git rm`, a branch checkout, by hand) while the
// record stays, and an unchanged canvas is then "already written" and skipped.
describe('a move into a folder never loses the canvas', () => {
  it('a kept tracked folder file that later disappears: the unchanged move back still writes it', async () => {
    execFileSync('git', ['init', '-q'], { cwd: folder })
    const store = new WorkspaceStore()
    await store.save(ws([project({ storeInAppData: undefined })]))
    execFileSync('git', ['add', '.nodeterm/project.json'], { cwd: folder })
    await store.save(ws([project()]))
    // "Delete anyway?" answered no: the tracked file stays in the folder.
    expect(await store.releaseFolderFiles('project-p1', false)).toMatchObject({ kept: [folderFile()] })
    // Later it leaves the folder outside the app.
    await fs.rm(folderFile())

    expect(await store.prepareFolderStorage('project-p1')).toEqual({ ok: true })
    await store.save(ws([project({ storeInAppData: undefined })]))

    expect(ids(JSON.parse(await fs.readFile(folderFile(), 'utf-8')).nodes)).toEqual(['term-1'])
    const loaded = (await new WorkspaceStore().load()).projects[0]
    expect(loaded.unavailable).toBeFalsy()
    expect(ids(loaded.nodes)).toEqual(['term-1'])
  })

  it('"Set folder…" onto a folder this store once wrote for another project keeps the canvas', async () => {
    const store = new WorkspaceStore()
    // Another project used this folder and was then deleted; its file was removed by hand.
    await store.save(ws([project({ id: 'project-old', storeInAppData: undefined })]))
    await store.save(ws([project({ id: 'project-p1', cwd: undefined, storeInAppData: undefined })]))
    await fs.rm(folderFile())
    expect(await exists(dataFile('project-p1'))).toBe(true)

    // The same canvas content, now bound to the folder.
    await store.save(ws([project({ storeInAppData: undefined })]))

    const onDisk = (await exists(folderFile())) || (await exists(dataFile('project-p1')))
    expect(onDisk).toBe(true)
    const loaded = (await new WorkspaceStore().load()).projects[0]
    expect(loaded.unavailable).toBeFalsy()
    expect(ids(loaded.nodes)).toEqual(['term-1'])
  })
})

describe('deleting a folder project kept in app data', () => {
  it('removes its data file and its app-data side files, and leaves the folder alone', async () => {
    const store = new WorkspaceStore()
    await store.save(ws([project()]))
    await store.writeProjectSettings('project-p1', { terminal: { shell: '/bin/fish' } })
    const side = path.join(userData, 'project-files', 'project-p1')
    await fs.writeFile(path.join(side, '.nodeterm', 'board-log.jsonl'), '{}\n')
    await fs.writeFile(path.join(folder, 'README.md'), 'mine')
    // Another project stays open: a save that empties the WHOLE index deletes nothing by design
    // (workspace-store.empty-index.test.ts), so the sweep is exercised by a partial delete.
    const keep: Project = { id: 'project-keep', name: 'keep', color: '#fff', viewport: { x: 0, y: 0, zoom: 1 }, nodes: [] }
    await store.save(ws([project(), keep]))

    await store.save(ws([keep]))

    expect(await exists(dataFile('project-p1'))).toBe(false)
    expect(await exists(side)).toBe(false)
    expect(await fs.readdir(folder)).toEqual(['README.md'])
  })

  it('a project that only moved back into its folder keeps its app-data board log', async () => {
    const store = new WorkspaceStore()
    await store.save(ws([project()]))
    const log = path.join(userData, 'project-files', 'project-p1', '.nodeterm', 'board-log.jsonl')
    await fs.mkdir(path.dirname(log), { recursive: true })
    await fs.writeFile(log, '{}\n')

    await store.save(ws([project({ storeInAppData: undefined })]))
    expect(await exists(dataFile('project-p1'))).toBe(false)
    expect(await exists(log)).toBe(true)
  })
})
