import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import { initPlatform, resetPlatformForTests } from './platform'
import { fakePlatform } from './platform-fake'
import { WorkspaceStore, type RemoteWorkspaceIO } from './workspace-store'
import { DEFAULT_BOARD_COLUMNS } from '../shared/kanban-default-board'
import type { Project, Workspace } from '../shared/types'

// The host side of the phone's Board sheet (`projects.ensureBoard` / `projects.setCardColumn`).
// Two project kinds, deliberately covered separately: a LOCAL ref writes its own file, and an SSH
// ref's file is on a third machine — the phone can never reach it, so the write lands in this
// desktop's cache and rides the ordinary mirror. That second half is the whole reason the verbs
// exist rather than more direct SSH from the phone.

let userData: string
let projRoot: string
let fake: ReturnType<typeof fakePlatform>

const project = (over: Partial<Project> = {}): Project => ({
  id: 'p1', name: 'foo', color: '#7aa2f7', viewport: { x: 0, y: 0, zoom: 1 },
  nodes: [{ id: 'term-1', kind: 'terminal', position: { x: 0, y: 0 }, size: { width: 1, height: 1 }, title: 't', color: '#fff', group: null }],
  ...over
})
const ws = (projects: Project[]): Workspace =>
  ({ version: 2, activeProjectId: projects[0]?.id ?? '', projects })
const SSH = { server: { host: 'h', user: 'u' }, remoteCwd: '~/x' } as unknown as Project['ssh']

const projectFile = (): string => path.join(projRoot, '.nodeterm/project.json')
const readFile = async (): Promise<Record<string, any>> =>
  JSON.parse(await fs.readFile(projectFile(), 'utf-8'))
const externalChanges = (): Record<string, any>[] =>
  fake.sent.filter((s) => s.channel === 'workspace:external-change').map((s) => s.args[0])

/** An ssh IO whose "server" is one in-memory string, so a mirror write is observable. */
function fakeRemote(initial: string | null = null): RemoteWorkspaceIO & { content: string | null; writes: number } {
  const io = {
    content: initial,
    writes: 0,
    async read() {
      return io.content === null
        ? ({ status: 'absent' } as const)
        : ({ status: 'ok', content: io.content } as const)
    },
    async write(_id: string, _ssh: never, content: string) {
      io.content = content
      io.writes++
      return true
    }
  }
  return io as never
}

beforeEach(async () => {
  userData = await fs.mkdtemp(path.join(os.tmpdir(), 'nt-ws-'))
  projRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'nt-proj-'))
  fake = fakePlatform({ userDataDir: userData })
  initPlatform(fake)
})
afterEach(async () => {
  resetPlatformForTests()
  await fs.rm(userData, { recursive: true, force: true })
  await fs.rm(projRoot, { recursive: true, force: true })
})

describe('ensureRemoteBoard (the phone creating a board that never existed)', () => {
  // The gap this closes: the desktop writes `kanban` only on the user's FIRST board edit, so most
  // project files have no board at all — and the phone, which knows a project only by its file,
  // showed no Board button on any of them.
  it('seeds the shared default columns into a local ref project file and announces it', async () => {
    const store = new WorkspaceStore()
    await store.save(ws([project({ cwd: projRoot })]))
    expect((await readFile()).kanban).toBeUndefined()
    fake.sent.length = 0

    const columns = await store.ensureRemoteBoard('p1')
    expect(columns?.map((c) => c.title)).toEqual(DEFAULT_BOARD_COLUMNS.map((c) => c.title))
    expect(columns?.map((c) => c.color)).toEqual(DEFAULT_BOARD_COLUMNS.map((c) => c.color))

    const file = await readFile()
    expect(file.kanban.columns).toHaveLength(3)
    expect(file.rev).toBe(2)
    // Ours, and announced by us — the renderer must adopt it or the next autosave reverts it.
    expect(store.isSelfWrite(projectFile(), await fs.readFile(projectFile(), 'utf-8'))).toBe(true)
    expect(externalChanges()).toHaveLength(1)
    expect(externalChanges()[0].kanban.columns).toHaveLength(3)
  })

  it('is idempotent: an existing board comes back untouched, with no second write', async () => {
    const store = new WorkspaceStore()
    const kanban = { columns: [{ id: 'kcol-mine', title: 'Mine', color: '#fff' }], assignments: [] }
    await store.save(ws([project({ cwd: projRoot, kanban })]))
    const before = await readFile()

    const columns = await store.ensureRemoteBoard('p1')
    expect(columns).toEqual(kanban.columns)
    expect(await readFile()).toEqual(before) // rev included: no churn
  })

  it('refuses a project it cannot write a file for', async () => {
    const store = new WorkspaceStore()
    await store.save(ws([project({ cwd: projRoot }), project({ id: 'inline1' })]))
    expect(await store.ensureRemoteBoard('nope')).toBeNull()
    expect(await store.ensureRemoteBoard('inline1')).toBeNull()
    await fs.writeFile(projectFile(), '{ not json')
    expect(await store.ensureRemoteBoard('p1')).toBeNull()
    expect(await fs.readFile(projectFile(), 'utf-8')).toBe('{ not json') // untouched
  })
})

describe('setRemoteCardColumn (the phone moving a card)', () => {
  const withBoard = (): Project =>
    project({
      cwd: projRoot,
      kanban: {
        columns: [
          { id: 'kcol-a', title: 'To Do', color: '#0a84ff' },
          { id: 'kcol-b', title: 'Done', color: '#32d74b' }
        ],
        assignments: []
      }
    })

  it('writes the assignment into a local ref project file and announces it', async () => {
    const store = new WorkspaceStore()
    await store.save(ws([withBoard()]))
    fake.sent.length = 0

    expect(await store.setRemoteCardColumn('p1', 'term-1', 'kcol-b')).toBe(true)
    expect((await readFile()).kanban.assignments).toEqual([{ nodeId: 'term-1', columnId: 'kcol-b' }])
    expect(externalChanges()).toHaveLength(1)
    expect(externalChanges()[0].kanban.assignments).toEqual([{ nodeId: 'term-1', columnId: 'kcol-b' }])
  })

  it('null moves the card to Ungrouped', async () => {
    const store = new WorkspaceStore()
    await store.save(ws([withBoard()]))
    await store.setRemoteCardColumn('p1', 'term-1', 'kcol-a')
    expect(await store.setRemoteCardColumn('p1', 'term-1', null)).toBe(true)
    expect((await readFile()).kanban.assignments).toEqual([])
  })

  // False is an ANSWER the phone shows the user, not a silent no-op — the behaviour this whole
  // change exists to remove.
  it('answers false, writing nothing, for an unknown column / project and a no-op move', async () => {
    const store = new WorkspaceStore()
    await store.save(ws([withBoard()]))
    const before = await readFile()
    expect(await store.setRemoteCardColumn('p1', 'term-1', 'kcol-gone')).toBe(false)
    expect(await store.setRemoteCardColumn('nope', 'term-1', 'kcol-a')).toBe(false)
    expect(await store.setRemoteCardColumn('p1', 'term-1', null)).toBe(false) // already Ungrouped
    expect(await readFile()).toEqual(before)
  })

  it('leaves card metadata the phone cannot author alone', async () => {
    const store = new WorkspaceStore()
    const p = withBoard()
    p.kanban!.meta = [{ nodeId: 'term-1', priority: 'high', assignees: [], labels: [] } as never]
    await store.save(ws([p]))
    await store.setRemoteCardColumn('p1', 'term-1', 'kcol-a')
    expect((await readFile()).kanban.meta).toEqual([
      { nodeId: 'term-1', priority: 'high', assignees: [], labels: [] }
    ])
  })

  // The save chain is the same invariant appendRemoteNode documents: this rewrites the very file a
  // save rewrites whole, and unserialized the save's copy — which never saw the move — lands last.
  it('is serialized with saves', async () => {
    const store = new WorkspaceStore()
    await store.save(ws([withBoard()]))
    const saving = store.save(ws([{ ...withBoard(), name: 'renamed' }]))
    const moving = store.setRemoteCardColumn('p1', 'term-1', 'kcol-a')
    expect(await moving).toBe(true)
    await saving
    const file = await readFile()
    expect(file.kanban.assignments).toEqual([{ nodeId: 'term-1', columnId: 'kcol-a' }])
    expect(file.name).toBe('renamed')
  })
})

describe('an SSH project (the case the phone can never write itself)', () => {
  // The phone reaches THIS desktop. An ssh ref's `.nodeterm/project.json` is on a third machine it
  // has no credentials for, so the write goes exactly where a desktop card drag's goes: into this
  // entry's cache, rev-bumped, then out on the ordinary mirror — which is why it needs nothing new
  // from `reconcileSsh` (that decides by rev and unions only `nodes`).
  const sshProject = (kanban?: Project['kanban']): Project =>
    project({ id: 'ssh1', cwd: undefined, ssh: SSH, ...(kanban ? { kanban } : {}) })

  it('seeds a board into the entry cache and mirrors it to the server', async () => {
    const io = fakeRemote()
    const store = new WorkspaceStore(io)
    await store.save(ws([sshProject()]))
    const mirrorsBefore = io.writes
    fake.sent.length = 0

    const columns = await store.ensureRemoteBoard('ssh1')
    expect(columns?.map((c) => c.title)).toEqual(DEFAULT_BOARD_COLUMNS.map((c) => c.title))
    expect(io.writes).toBeGreaterThan(mirrorsBefore)
    expect(JSON.parse(io.content!).kanban.columns).toHaveLength(3)
    // Announced, so the live canvas adopts it instead of the next autosave writing the old board back.
    expect(externalChanges()[0]).toMatchObject({ id: 'ssh1' })
    expect(externalChanges()[0].kanban.columns).toHaveLength(3)
  })

  it('moves a card and mirrors it, and the reloaded workspace carries the move', async () => {
    const io = fakeRemote()
    const store = new WorkspaceStore(io)
    await store.save(ws([sshProject({
      columns: [{ id: 'kcol-a', title: 'To Do', color: '#0a84ff' }],
      assignments: []
    })]))

    expect(await store.setRemoteCardColumn('ssh1', 'term-1', 'kcol-a')).toBe(true)
    expect(JSON.parse(io.content!).kanban.assignments).toEqual([{ nodeId: 'term-1', columnId: 'kcol-a' }])
    const reloaded = await new WorkspaceStore(io).load()
    expect(reloaded.projects.find((p) => p.id === 'ssh1')?.kanban?.assignments)
      .toEqual([{ nodeId: 'term-1', columnId: 'kcol-a' }])
  })

  // Every refusal reason stays a refusal on this path too — a cache write that cannot be described
  // as the requested change must not be mirrored as if it were.
  it('answers false for an unknown column and writes nothing', async () => {
    const io = fakeRemote()
    const store = new WorkspaceStore(io)
    await store.save(ws([sshProject({ columns: [{ id: 'kcol-a', title: 'To Do', color: '#0a84ff' }], assignments: [] })]))
    const mirrored = io.content
    const writes = io.writes
    expect(await store.setRemoteCardColumn('ssh1', 'term-1', 'kcol-gone')).toBe(false)
    expect(io.content).toBe(mirrored)
    expect(io.writes).toBe(writes)
  })

  // A mirror that cannot land (host asleep, dial flapped) must leave the change OWED, not lost: the
  // answer to the phone is about the board, and the next save retries the push. The save here
  // carries the board because the renderer ADOPTED the broadcast — which is the contract this path
  // depends on, and the reason the broadcast is not optional: a renderer that never heard about the
  // change would serialize its old board over it on the very next autosave.
  it('keeps the change when the mirror write fails, and a later save pushes it', async () => {
    const io = fakeRemote()
    let allowWrite = false
    const flaky = { ...io, write: async (id: string, ssh: never, content: string) => allowWrite && io.write(id, ssh, content) }
    const store = new WorkspaceStore(flaky as never)
    await store.save(ws([sshProject()]))
    fake.sent.length = 0

    expect(await store.ensureRemoteBoard('ssh1')).toHaveLength(3)
    expect(io.content).toBeNull() // nothing reached the server yet

    allowWrite = true
    const adopted = externalChanges()[0] as Project
    await store.save(ws([adopted]))
    expect(JSON.parse(io.content!).kanban.columns).toHaveLength(3)
  })

  // The ssh cache is not on this machine's disk as a project.json — it lives in workspace.json, so
  // a change kept only in memory is one an app restart silently drops.
  it('persists the cache change to the index, so a restart still has the board', async () => {
    const io = fakeRemote()
    const store = new WorkspaceStore(io)
    await store.save(ws([sshProject()]))
    await store.ensureRemoteBoard('ssh1')

    const index = JSON.parse(await fs.readFile(path.join(userData, 'workspace.json'), 'utf-8'))
    const entry = index.entries.find((x: { id: string }) => x.id === 'ssh1')
    expect(entry.cache.kanban.columns).toHaveLength(3)
  })
})
