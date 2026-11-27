// A renderer's save may only delete projects that renderer held.
//
// Field report (Server Edition, 2026-11-26/27, after the empty-index guard of #1468): with several
// browser tabs open on one server, each on its own project, the index was still emptied five times
// in two days (each caught by `.pre-empty-<ts>`), and a tab that loaded inside the window got no
// projects at all. Every renderer save is its WHOLE workspace, so a tab that had not loaded yet, a
// tab whose load failed, or a tab that loaded an empty index during another tab's window, rebuilt
// the index from nothing; and a tab that never saw a project another tab created dropped it (and
// the partial-delete sweep removed its data file). These tests drive the real IPC handlers with two
// client ids and pin that a save speaks only for the ids its client loaded or saved.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'fs'
import path from 'path'
import { initPlatform, resetPlatformForTests } from './platform'
import { fakePlatform, type FakePlatform } from './platform-fake'
import { WorkspaceStore } from './workspace-store'
import { IPC } from '../shared/ipc'
import type { CanvasNodeState, Project, Workspace } from '../shared/types'

let fake: FakePlatform
let store: WorkspaceStore

const node = (id: string): CanvasNodeState => ({
  id, kind: 'terminal', position: { x: 0, y: 0 }, size: { width: 1, height: 1 },
  title: id, color: '#fff', group: null
})
const project = (id: string, nodes: string[] = [`term-${id}`]): Project => ({
  id, name: id, color: '#7aa2f7', viewport: { x: 0, y: 0, zoom: 1 }, nodes: nodes.map(node)
})
const ws = (projects: Project[]): Workspace =>
  ({ version: 2, activeProjectId: projects[0]?.id ?? '', projects })
const indexPath = () => path.join(fake.userDataDir, 'workspace.json')
const indexIds = async (): Promise<string[]> =>
  (JSON.parse(await fs.readFile(indexPath(), 'utf-8')).entries as Array<{ id: string }>).map((e) => e.id)
const dataFile = (id: string) => path.join(fake.userDataDir, 'inline-projects', `${id}.json`)
const exists = (f: string) => fs.stat(f).then(() => true, () => false)
const backups = async () =>
  (await fs.readdir(fake.userDataDir)).filter((n) => n.startsWith('workspace.json.pre-empty-'))

const TAB_A = 1
const TAB_B = 2
const load = (sender: number): Promise<Workspace> =>
  Promise.resolve(fake.handlers[IPC.workspaceLoad](sender) as Promise<Workspace>)
const save = (sender: number, w: Workspace): Promise<unknown> =>
  Promise.resolve(fake.handlers[IPC.workspaceSave](sender, w))

beforeEach(async () => {
  fake = fakePlatform()
  initPlatform(fake)
  store = new WorkspaceStore()
  store.registerIpc()
  // The long-running server: an index with two cwd-less canvases, already read by the store.
  await store.save(ws([project('p1'), project('p2')]))
  await store.load()
})
afterEach(() => {
  vi.restoreAllMocks()
  resetPlatformForTests()
})

describe('a renderer save speaks only for the projects its client held', () => {
  it('a tab that never saw a project another tab created cannot drop it (or its data file)', async () => {
    const a = await load(TAB_A)
    const b = await load(TAB_B)
    expect(a.projects.map((p) => p.id)).toEqual(['p1', 'p2'])
    await save(TAB_B, ws([...b.projects, project('p3')]))
    expect(await indexIds()).toEqual(['p1', 'p2', 'p3'])

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await save(TAB_A, a) // tab A's autosave: its store has never held p3
    expect(await indexIds()).toEqual(['p1', 'p2', 'p3'])
    expect(await exists(dataFile('p3'))).toBe(true)
    expect(warn.mock.calls.flat().join('\n')).toMatch(/client 1 omitted 1 project\(s\) it never loaded \(p3\); kept/)
  })

  it('a client that has not loaded yet and saves [] changes nothing', async () => {
    const before = await fs.readFile(indexPath(), 'utf-8')
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await save(TAB_A, ws([]))
    expect(await fs.readFile(indexPath(), 'utf-8')).toBe(before)
    expect(await exists(dataFile('p1'))).toBe(true)
    expect(await exists(dataFile('p2'))).toBe(true)
    expect(await backups()).toEqual([])
  })

  it('a save sent before the boot load answered still speaks for nothing once the load lands', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const loading = load(TAB_A) // the reloaded page's boot load is in flight…
    const early = save(TAB_A, ws([])) // …when an autosave fires with the still-empty store
    await loading
    await early
    expect(await indexIds()).toEqual(['p1', 'p2'])
    expect(await backups()).toEqual([])
  })

  it('a reload starts the client over: what its previous page held no longer counts', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await load(TAB_A)
    const reloading = load(TAB_A) // the desktop keeps its sender id across a page reload
    await save(TAB_A, ws([]))
    await reloading
    expect(await indexIds()).toEqual(['p1', 'p2'])
  })

  it('a project the client held and removed is deleted, data file included', async () => {
    const a = await load(TAB_A)
    await save(TAB_A, ws(a.projects.filter((p) => p.id !== 'p2')))
    expect(await indexIds()).toEqual(['p1'])
    expect(await exists(dataFile('p2'))).toBe(false)
  })

  it('deleting every project the client held still empties the index, with the backup', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await load(TAB_A)
    await save(TAB_A, ws([]))
    expect(await indexIds()).toEqual([])
    expect(await backups()).toHaveLength(1)
  })

  it('a project the client created and saved is its own to delete', async () => {
    const a = await load(TAB_A)
    await save(TAB_A, ws([...a.projects, project('p4')]))
    await save(TAB_A, a)
    expect(await indexIds()).toEqual(['p1', 'p2'])
  })
})
