import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import { initPlatform, resetPlatformForTests } from './platform'
import { fakePlatform } from './platform-fake'
import { WorkspaceStore } from './workspace-store'
import { IPC } from '../shared/ipc'
import type { Project, Workspace } from '../shared/types'
import type { SaveScope } from './workspace-scope'

/**
 * Pop-out windows: two renderers save the SAME workspace, each from its own copy. The scope is
 * what stops one window's stale copy of a project from going back over the other window's write.
 * These run the real store against a temp dir, through the same `save`/`load` the IPC handlers
 * call, so the rule is checked where it is enforced rather than in the pure merge alone.
 */

let userData: string
let root: string
let fake: ReturnType<typeof fakePlatform>

const MAIN = 1
const POPOUT = 2

const project = (id: string, over: Partial<Project> = {}): Project => ({
  id,
  name: id,
  color: '#7aa2f7',
  cwd: path.join(root, id),
  viewport: { x: 0, y: 0, zoom: 1 },
  nodes: [
    {
      id: `${id}-term`,
      kind: 'terminal',
      position: { x: 0, y: 0 },
      size: { width: 1, height: 1 },
      title: 't',
      color: '#fff',
      group: null
    }
  ],
  ...over
})
const ws = (projects: Project[], active = projects[0]?.id ?? ''): Workspace => ({
  version: 2,
  activeProjectId: active,
  projects
})
const fileOf = async (id: string): Promise<{ name: string; nodes: unknown[]; rev: number }> =>
  JSON.parse(await fs.readFile(path.join(root, id, '.nodeterm/project.json'), 'utf-8'))
const indexOf = async (): Promise<{ activeProjectId: string; entries: Array<{ id: string; name: string }> }> =>
  JSON.parse(await fs.readFile(path.join(userData, 'workspace.json'), 'utf-8'))

beforeEach(async () => {
  userData = await fs.mkdtemp(path.join(os.tmpdir(), 'nt-ws-scope-'))
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'nt-proj-scope-'))
  fake = fakePlatform({ userDataDir: userData })
  initPlatform(fake)
})
afterEach(async () => {
  resetPlatformForTests()
  await fs.rm(userData, { recursive: true, force: true })
  await fs.rm(root, { recursive: true, force: true })
})

/** A store wired the way the Electron shell wires it: the sender decides the scope. */
function scopedStore(detached: () => string[]): WorkspaceStore {
  const store = new WorkspaceStore()
  store.setSaveScopeResolver((sender): SaveScope | undefined => {
    if (sender === POPOUT) return { kind: 'popout', projectId: 'b' }
    return { kind: 'main', detached: [...detached()] } // a copy: production hands out a fresh array per call
  })
  store.registerIpc()
  return store
}

describe('scoped saves (pop-out windows)', () => {
  it('a pop-out writes only its own project; its stale copy of the others never reaches disk', async () => {
    const detached: string[] = []
    const store = scopedStore(() => detached)
    const save = fake.handlers[IPC.workspaceSave] as (sender: number, w: Workspace) => Promise<void>

    // Boot: main owns everything, saves A + B.
    await save(MAIN, ws([project('a'), project('b')]))
    // B is torn off. Main edits A and autosaves — carrying B unchanged.
    detached.push('b')
    await save(MAIN, ws([project('a', { name: 'A2' }), project('b')]))
    expect((await fileOf('a')).name).toBe('A2')

    // The pop-out edits B and autosaves — carrying the A it loaded at boot (name 'a', stale).
    await save(POPOUT, ws([project('a'), project('b', { name: 'B2' })], 'b'))
    expect((await fileOf('a')).name).toBe('A2') // NOT clobbered back to 'a'
    expect((await fileOf('b')).name).toBe('B2')
    // The index keeps main's order and main's active project; B's entry is the pop-out's.
    const index = await indexOf()
    expect(index.entries.map((e) => e.name)).toEqual(['A2', 'B2'])
    expect(index.activeProjectId).toBe('a')

    // Main autosaves again with ITS stale B (still 'b'): B stays the pop-out's.
    await save(MAIN, ws([project('a', { name: 'A3' }), project('b')]))
    expect((await fileOf('b')).name).toBe('B2')
    expect((await fileOf('a')).name).toBe('A3')
    expect((await indexOf()).entries.map((e) => e.name)).toEqual(['A3', 'B2'])
    expect(store.lastSavedProject('b')?.name).toBe('B2')
    expect(store.lastSavedProject('a')?.name).toBe('A3')
  })

  it('main cannot delete or reorder-away a detached project, and nothing can introduce one', async () => {
    const detached = ['b']
    const store = scopedStore(() => detached)
    void store
    const save = fake.handlers[IPC.workspaceSave] as (sender: number, w: Workspace) => Promise<void>
    detached.length = 0
    await save(MAIN, ws([project('a'), project('b'), project('c')]))
    detached.push('b')
    // Main "deletes" B and reorders the rest.
    await save(MAIN, ws([project('c'), project('a')], 'c'))
    const index = await indexOf()
    expect(index.entries.map((e) => e.id)).toEqual(['c', 'a', 'b'])
    expect(index.activeProjectId).toBe('c')
    // The pop-out cannot bring a project the store does not know into the index.
    await save(POPOUT, ws([project('b'), project('zzz')], 'b'))
    expect((await indexOf()).entries.map((e) => e.id)).toEqual(['c', 'a', 'b'])
    await expect(fs.access(path.join(root, 'zzz'))).rejects.toThrow()
  })

  it('a pop-out is booted as a one-project slice of the project as it now stands', async () => {
    const detached: string[] = []
    scopedStore(() => detached)
    const save = fake.handlers[IPC.workspaceSave] as (sender: number, w: Workspace) => Promise<void>
    const load = fake.handlers[IPC.workspaceLoad] as (sender: number) => Promise<Workspace>
    await save(MAIN, ws([project('a'), project('b', { name: 'B-main' })]))
    detached.push('b')
    const slice = await load(POPOUT)
    expect(slice.activeProjectId).toBe('b')
    expect(slice.projects.map((p) => p.name)).toEqual(['B-main'])
    // Main's own load is the ordinary full one.
    const full = await load(MAIN)
    expect(full.projects.map((p) => p.id)).toEqual(['a', 'b'])
  })

  // The reviewer's probe (PR #804): a write the store makes itself while the project is popped out
  // — here the phone's appendRemoteNode — must be what a reloading pop-out sees, and so must
  // survive that pop-out's next save. Booting from the renderer's last save erased it.
  it('a pop-out reload sees a store-side write made while it was open, and its next save keeps it', async () => {
    const detached: string[] = []
    const store = scopedStore(() => detached)
    const save = fake.handlers[IPC.workspaceSave] as (sender: number, w: Workspace) => Promise<void>
    const load = fake.handlers[IPC.workspaceLoad] as (sender: number) => Promise<Workspace>
    await save(MAIN, ws([project('a'), project('b')]))
    detached.push('b')
    const first = await load(POPOUT)
    await save(POPOUT, first)
    expect(await store.appendRemoteNode('b', { id: 'term-mabc123-xyz789' })).toBe(true)
    const reloaded = await load(POPOUT)
    const ids = reloaded.projects[0].nodes.map((n) => n.id)
    expect(ids).toContain('term-mabc123-xyz789')
    await save(POPOUT, reloaded)
    expect((await fileOf('b')).nodes.map((n) => (n as { id: string }).id)).toContain('term-mabc123-xyz789')
  })

  it('a pop-out with no recorded save falls back to a disk load filtered to its project', async () => {
    // Save with a plain (unscoped) store so nothing is recorded under the scoped one.
    await new WorkspaceStore().save(ws([project('a'), project('b')]))
    scopedStore(() => ['b'])
    const load = fake.handlers[IPC.workspaceLoad] as (sender: number) => Promise<Workspace>
    const slice = await load(POPOUT)
    expect(slice.activeProjectId).toBe('b')
    expect(slice.projects.map((p) => p.id)).toEqual(['b'])
  })

  it('reports each save to the shell once per OWNED project, with the sender\'s scope', async () => {
    const detached = ['b']
    const store = scopedStore(() => detached)
    const seen: Array<[string, string, SaveScope | undefined]> = []
    store.onProjectSaved = (id, p, scope) => seen.push([id, p.name, scope])
    const save = fake.handlers[IPC.workspaceSave] as (sender: number, w: Workspace) => Promise<void>
    detached.length = 0
    await save(MAIN, ws([project('a'), project('b')]))
    detached.push('b')
    await save(POPOUT, ws([project('a'), project('b', { name: 'B2' })], 'b'))
    await save(MAIN, ws([project('a', { name: 'A2' }), project('b')]))
    expect(seen).toEqual([
      ['a', 'a', { kind: 'main', detached: [] }],
      ['b', 'b', { kind: 'main', detached: [] }],
      ['b', 'B2', { kind: 'popout', projectId: 'b' }],
      ['a', 'A2', { kind: 'main', detached: ['b'] }]
    ])
  })

  it('an unscoped save (no resolver — the Server Edition) is byte-identical to before', async () => {
    const store = new WorkspaceStore()
    store.registerIpc()
    const save = fake.handlers[IPC.workspaceSave] as (sender: number, w: Workspace) => Promise<void>
    await save(MAIN, ws([project('a'), project('b')]))
    await save(99, ws([project('b', { name: 'B2' })], 'b'))
    // No scope: the second save is the whole truth, exactly as it always was.
    expect((await indexOf()).entries.map((e) => e.name)).toEqual(['B2'])
    expect(store.lastSavedProject('b')?.name).toBe('B2')
  })
})
