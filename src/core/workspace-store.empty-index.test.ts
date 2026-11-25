// A long-running store must never turn "a client holding no projects" into "every project gone".
//
// Field report (Server Edition, 2026-11-25): the server had been up 11 days, so `saveNow`'s
// never-read guard (`!this.index`) no longer applied. A browser save carrying zero projects
// rewrote workspace.json as `entries: []`, and the same save swept every cwd-less canvas's data
// file, the only copy of those canvases. These tests pin the three guards that close it:
//   1. a non-ENOENT read failure of the index throws instead of answering "no projects";
//   2. a save that empties a populated index keeps the old index as `.pre-empty-<ts>`;
//   3. that save deletes no inline data file.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import { initPlatform, resetPlatformForTests } from './platform'
import { fakePlatform } from './platform-fake'
import { WorkspaceStore } from './workspace-store'
import type { CanvasNodeState, Project, Workspace } from '../shared/types'

let userData: string

const node = (id: string): CanvasNodeState => ({
  id, kind: 'terminal', position: { x: 0, y: 0 }, size: { width: 1, height: 1 },
  title: id, color: '#fff', group: null
})
const project = (id: string, nodes: string[]): Project => ({
  id, name: id, color: '#7aa2f7', viewport: { x: 0, y: 0, zoom: 1 }, nodes: nodes.map(node)
})
const ws = (projects: Project[]): Workspace =>
  ({ version: 2, activeProjectId: projects[0]?.id ?? '', projects })
const indexPath = () => path.join(userData, 'workspace.json')
const dataFile = (id: string) => path.join(userData, 'inline-projects', `${id}.json`)
const exists = (f: string) => fs.stat(f).then(() => true, () => false)
const backups = async () => (await fs.readdir(userData)).filter((n) => n.startsWith('workspace.json.pre-empty-'))

beforeEach(async () => {
  userData = await fs.mkdtemp(path.join(os.tmpdir(), 'nt-empty-index-'))
  initPlatform(fakePlatform({ userDataDir: userData }))
})
afterEach(async () => {
  vi.restoreAllMocks()
  resetPlatformForTests()
  await fs.rm(userData, { recursive: true, force: true })
})

describe('an index the store cannot read is not an empty one', () => {
  it('a non-ENOENT read failure rejects the load and leaves the file untouched', async () => {
    const store = new WorkspaceStore()
    await store.save(ws([project('project-a', ['term-1'])]))
    const before = await fs.readFile(indexPath(), 'utf-8')

    const real = fs.readFile
    vi.spyOn(fs, 'readFile').mockImplementation(((file: unknown, ...rest: unknown[]) => {
      if (file === indexPath()) return Promise.reject(Object.assign(new Error('EIO: i/o error'), { code: 'EIO' }))
      return (real as (...a: unknown[]) => Promise<unknown>)(file, ...rest)
    }) as typeof fs.readFile)

    await expect(store.load()).rejects.toMatchObject({ code: 'EIO' })
    vi.restoreAllMocks()
    expect(await fs.readFile(indexPath(), 'utf-8')).toBe(before)
  })

  it('a missing index is still a first run: empty workspace, no throw', async () => {
    const loaded = await new WorkspaceStore().load()
    expect(loaded.projects).toEqual([])
  })
})

describe('a save that empties a populated index', () => {
  it('keeps the previous index as .pre-empty-<ts> and deletes no inline canvas file', async () => {
    const store = new WorkspaceStore()
    await store.save(ws([project('project-a', ['term-1']), project('project-b', ['term-2', 'term-3'])]))
    await store.load() // the long-running case: this store HAS read the index
    const before = await fs.readFile(indexPath(), 'utf-8')
    expect(await exists(dataFile('project-a'))).toBe(true)

    await store.save(ws([]))

    expect(JSON.parse(await fs.readFile(indexPath(), 'utf-8')).entries).toEqual([])
    const kept = await backups()
    expect(kept).toHaveLength(1)
    expect(await fs.readFile(path.join(userData, kept[0]), 'utf-8')).toBe(before)
    // The only copies of both canvases survive the emptying save.
    expect(await exists(dataFile('project-a'))).toBe(true)
    expect(await exists(dataFile('project-b'))).toBe(true)
  })

  it('removing ONE project still sweeps its file and leaves no backup', async () => {
    const store = new WorkspaceStore()
    await store.save(ws([project('project-a', ['term-1']), project('project-b', ['term-2'])]))
    await store.save(ws([project('project-a', ['term-1'])]))
    expect(await exists(dataFile('project-b'))).toBe(false)
    expect(await backups()).toEqual([])
  })

  it('an empty save over an already-empty index writes no backup', async () => {
    const store = new WorkspaceStore()
    await store.save(ws([]))
    await store.load()
    await store.save(ws([]))
    expect(await backups()).toEqual([])
  })
})
