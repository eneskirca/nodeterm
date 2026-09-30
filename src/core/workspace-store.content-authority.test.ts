// The store seams the Server Edition canvas authority governs shared projects through: an overlay on
// every whole-workspace save and load, a content read that never queues on `saveChain` (the
// authority calls it from INSIDE a save), and an atomic content write that does a save's
// bookkeeping (self-write record, rev, the inline cache + index, onPersist) without broadcasting.
//
// The load-bearing claim of the write is pinned by comparison, not by listing steps: a file written
// by `writeProjectContent` is byte-identical to the file `save()` writes for the same project,
// apart from `rev` and `savedAt`.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import { initPlatform, resetPlatformForTests } from './platform'
import { fakePlatform } from './platform-fake'
import { WorkspaceStore, type ContentAuthorityHooks, type RemoteWorkspaceIO } from './workspace-store'
import { contentOf, type CanvasContent } from '../shared/canvas-content'
import type { CanvasNodeState, Project, ProjectKanban, Workspace } from '../shared/types'

let userData: string
let projRoot: string
let fake: ReturnType<typeof fakePlatform>

const node = (id: string, over: Partial<CanvasNodeState> = {}): CanvasNodeState => ({
  id, kind: 'terminal', position: { x: 0, y: 0 }, size: { width: 1, height: 1 },
  title: id, color: '#fff', group: null, ...over
})
const project = (over: Partial<Project> = {}): Project => ({
  id: 'P', name: 'foo', color: '#7aa2f7', viewport: { x: 0, y: 0, zoom: 1 },
  nodes: [node('a')], ...over
})
const ws = (projects: Project[]): Workspace =>
  ({ version: 2, activeProjectId: projects[0]?.id ?? '', projects })
const content = (nodes: CanvasNodeState[], over: Partial<CanvasContent> = {}): CanvasContent =>
  ({ nodes, bridges: [], ropes: [], ...over })
const ids = (nodes: Array<{ id: string }>): string[] => nodes.map((n) => n.id)

const SSH = { server: { host: 'h', user: 'u' }, remoteCwd: '~/x' } as unknown as Project['ssh']
const INLINE_ID = 'project-p1'

const projectFile = (root = projRoot): string => path.join(root, '.nodeterm/project.json')
const dataFile = (id = INLINE_ID): string => path.join(userData, 'inline-projects', `${id}.json`)
const readJson = async (file: string): Promise<Record<string, any>> =>
  JSON.parse(await fs.readFile(file, 'utf-8'))
const readIndex = (): Promise<Record<string, any>> => readJson(path.join(userData, 'workspace.json'))
const externalChanges = (): unknown[] =>
  fake.sent.filter((s) => s.channel === 'workspace:external-change')
/** The file minus the two fields a write is allowed to differ in, re-serialized in its own key
 *  order — so a comparison also catches a reordered key. */
const withoutBookkeeping = (raw: string): string => {
  const { rev: _r, savedAt: _s, ...rest } = JSON.parse(raw)
  return JSON.stringify(rest, null, 2)
}

/** Rejects if `p` has not settled within `ms` — the observable shape of a deadlock. */
async function settlesWithin<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`did not settle within ${ms} ms (deadlock)`)), ms)
  })
  try {
    return await Promise.race([p, timeout])
  } finally {
    clearTimeout(timer)
  }
}

const passThrough: ContentAuthorityHooks = {
  overlaySave: async (w) => w,
  overlayLoad: async (w) => w
}

/** An ssh IO whose "server" is one in-memory string, so a mirror write is observable. */
function fakeRemote(): RemoteWorkspaceIO & { content: string | null; writes: number } {
  const io = {
    content: null as string | null,
    writes: 0,
    async read() {
      return io.content === null
        ? ({ status: 'absent' } as const)
        : ({ status: 'ok', content: io.content } as const)
    },
    async write(_id: string, _ssh: never, c: string) {
      io.content = c
      io.writes++
      return true
    }
  }
  return io as never
}

/** A folder project written by hand at rev 3, with every non-content field a save must keep. */
async function seedFolderAtRev3(): Promise<WorkspaceStore> {
  await fs.mkdir(path.dirname(projectFile()), { recursive: true })
  await fs.writeFile(projectFile(), JSON.stringify({
    version: 1,
    rev: 3,
    savedAt: '2026-09-29T00:00:00.000Z',
    name: 'X',
    color: '#abcdef',
    viewport: { x: 5, y: 5, zoom: 3 },
    nodes: [node('a', { cwd: './sub' })],
    defaultPermissionMode: 'plan',
    agentMessaging: true,
    dinoHighScore: 42,
    kanban: {
      columns: [{ id: 'c1', title: 'To Do', color: '#888' }],
      assignments: [{ nodeId: 'a', columnId: 'c1' }],
      github: { repository: 'a/b', columnMappings: [{ columnId: 'c1', label: 'todo' }] },
      pullLinks: { noAutoMove: ['a'] }
    }
  }, null, 2))
  await fs.writeFile(path.join(userData, 'workspace.json'), JSON.stringify({
    version: 3,
    activeProjectId: 'P',
    entries: [{ id: 'P', name: 'X', color: '#abcdef', cwd: projRoot, execMigrated: true }]
  }))
  const store = new WorkspaceStore()
  await store.load()
  return store
}

/** A project exercising every transform the save path applies to content on the way out. */
const richProject = (cwd: string | undefined, id = 'P'): Project => project({
  id,
  cwd,
  name: 'rich',
  color: '#123456',
  defaultPermissionMode: 'plan',
  agentMessaging: true,
  dinoHighScore: 7,
  nodes: [
    // under the root → a portable `./sub` cwd; `shell` is machine-local and must never be written
    node('a', { cwd: cwd ? path.join(cwd, 'sub') : undefined, shell: '/bin/zsh', position: { x: 40, y: 90 } }),
    // outside the root → the absolute path stays
    node('b', { cwd: '/elsewhere/abs', position: { x: -40, y: 12 } }),
    // a malformed trigger spec is dropped on the way out
    node('t', { kind: 'trigger', trigger: { bogus: true } as never })
  ],
  bridges: [{ id: 'br1', source: 'a', target: 'b' }],
  ropes: [{ id: 'ctrl-a-b', source: 'a', target: 'b' }],
  kanban: {
    columns: [{ id: 'c1', title: 'To Do', color: '#888' }, { id: 'c2', title: 'Done', color: '#8b8' }],
    assignments: [{ nodeId: 'a', columnId: 'c2' }],
    github: { repository: 'a/b', columnMappings: [{ columnId: 'c1', label: 'todo' }] },
    pullLinks: { unlinked: [{ nodeId: 'a', pull: 12 }] }
  } as ProjectKanban
})

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

describe('the save overlay', () => {
  it('replaces a governed project’s content before it is written', async () => {
    const store = new WorkspaceStore()
    store.setContentAuthority({
      overlaySave: async (w) => ({
        ...w,
        projects: w.projects.map((p) => (p.id === 'P' ? { ...p, nodes: [node('b')] } : p))
      }),
      overlayLoad: async (w) => w
    })
    await store.save(ws([project({ cwd: projRoot, nodes: [node('a')] })]))
    expect(ids((await readJson(projectFile())).nodes)).toEqual(['b'])

    // Detached, a save writes exactly what it was handed again.
    store.setContentAuthority(null)
    await store.save(ws([project({ cwd: projRoot, nodes: [node('a')] })]))
    expect(ids((await readJson(projectFile())).nodes)).toEqual(['a'])
  })
})

// N3: the Server Edition's close stops the authority and detaches it. A browser save queued before
// that (still on `saveChain`, behind a slow write) would otherwise run AFTER the detach and write its
// stale content un-overlaid over the final flush. The shell awaits `idle()` first.
describe('idle', () => {
  it('resolves only once every write queued so far has landed, still overlaid', async () => {
    const store = new WorkspaceStore()
    let release!: () => void
    const held = new Promise<void>((r) => (release = r))
    store.setContentAuthority({
      overlaySave: async (w) => {
        await held
        return { ...w, projects: w.projects.map((p) => (p.id === 'P' ? { ...p, nodes: [node('b')] } : p)) }
      },
      overlayLoad: async (w) => w
    })
    const save = store.save(ws([project({ cwd: projRoot, nodes: [node('a')] })]))
    let idle = false
    const idled = store.idle().then(() => {
      idle = true
    })
    await new Promise((r) => setTimeout(r, 20))
    expect(idle).toBe(false)
    release()
    await idled
    // Detached only now, as the shell does once the authority has stopped: nothing queued is left
    // to be written un-overlaid.
    store.setContentAuthority(null)
    await save
    expect(ids((await readJson(projectFile())).nodes)).toEqual(['b'])
  })

  it('never rejects, even when a queued write failed', async () => {
    const store = new WorkspaceStore()
    store.setContentAuthority({ overlaySave: async () => { throw new Error('overlay down') }, overlayLoad: async (w) => w })
    await expect(store.save(ws([project({ cwd: projRoot })]))).rejects.toThrow('overlay down')
    await expect(store.idle()).resolves.toBeUndefined()
  })
})

describe('a rejecting save overlay (D8)', () => {
  it('fails closed: save() rejects and the file keeps its bytes', async () => {
    const store = new WorkspaceStore()
    await store.save(ws([project({ cwd: projRoot, nodes: [node('a')] })]))
    const before = await fs.readFile(projectFile(), 'utf-8')
    const indexBefore = JSON.stringify(await readIndex())
    store.setContentAuthority({ overlaySave: async () => { throw new Error('overlay down') }, overlayLoad: async (w) => w })
    // The stale copy the overlay exists to overrule: it must not be written instead.
    await expect(store.save(ws([project({ cwd: projRoot, name: 'stale', nodes: [node('stale')] })]))).rejects.toThrow('overlay down')
    expect(await fs.readFile(projectFile(), 'utf-8')).toBe(before)
    expect(JSON.stringify(await readIndex())).toBe(indexBefore)
  })
})

describe('the load overlay', () => {
  it('rewrites the load result only; the file is untouched', async () => {
    const store = new WorkspaceStore()
    await store.save(ws([project({ cwd: projRoot, nodes: [node('a')] })]))
    const before = await fs.readFile(projectFile(), 'utf-8')

    store.setContentAuthority({
      overlaySave: async (w) => w,
      overlayLoad: async (w) => ({ ...w, projects: w.projects.map((p) => ({ ...p, nodes: [node('b')] })) })
    })
    const loaded = await store.load()
    expect(ids(loaded.projects[0].nodes)).toEqual(['b'])
    expect(await fs.readFile(projectFile(), 'utf-8')).toBe(before)
    expect(ids((await new WorkspaceStore().load()).projects[0].nodes)).toEqual(['a'])
  })

  it('a failing overlay still answers the load (a thrown one leaves the index unguarded against the next save)', async () => {
    const store = new WorkspaceStore()
    await store.save(ws([project({ cwd: projRoot, nodes: [node('a')] })]))
    store.setContentAuthority({
      overlaySave: async (w) => w,
      overlayLoad: async () => { throw new Error('authority unavailable') }
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const loaded = await store.load()
    expect(loaded.projects.map((p) => p.id)).toEqual(['P'])
    expect(ids(loaded.projects[0].nodes)).toEqual(['a'])
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })
})

describe('readProjectContent', () => {
  it('does not deadlock inside a save (it never queues on saveChain)', async () => {
    const store = new WorkspaceStore()
    await store.save(ws([project({ cwd: projRoot, nodes: [node('a')] })]))
    let seen: CanvasContent | null | undefined
    store.setContentAuthority({
      overlaySave: async (w) => {
        seen = await store.readProjectContent('P')
        return w
      },
      overlayLoad: async (w) => w
    })
    await expect(
      settlesWithin(store.save(ws([project({ cwd: projRoot, nodes: [node('a'), node('c')] })])), 2000)
    ).resolves.toBeUndefined()
    // What the store knew when the save began: the file before this save.
    expect(ids(seen!.nodes)).toEqual(['a'])
    expect(ids((await readJson(projectFile())).nodes)).toEqual(['a', 'c'])
  })

  it('answers a folder project with resolved cwds and this machine’s exec values re-applied', async () => {
    const store = new WorkspaceStore()
    await store.save(ws([project({
      cwd: projRoot,
      nodes: [node('a', { cwd: path.join(projRoot, 'sub'), shell: '/bin/zsh' })],
      ropes: [{ id: 'r1', source: 'a', target: 'a' }]
    })]))
    expect((await readJson(projectFile())).nodes[0].shell).toBeUndefined()

    const c = await store.readProjectContent('P')
    expect(c?.nodes[0]).toMatchObject({ id: 'a', cwd: path.join(projRoot, 'sub'), shell: '/bin/zsh' })
    expect(c?.bridges).toEqual([])
    expect(c?.ropes).toEqual([{ id: 'r1', source: 'a', target: 'a' }])
    expect(c?.kanban).toBeUndefined()
  })

  it('answers what the store last wrote, not an unprocessed outside edit', async () => {
    const store = new WorkspaceStore()
    await store.save(ws([project({ cwd: projRoot, nodes: [node('a')] })]))
    const outside = { ...(await readJson(projectFile())), nodes: [node('zz')] }
    await fs.writeFile(projectFile(), JSON.stringify(outside, null, 2))
    expect(ids((await store.readProjectContent('P'))!.nodes)).toEqual(['a'])
  })

  it('answers a cwd-less canvas from its cache', async () => {
    const store = new WorkspaceStore()
    await store.save(ws([project({ id: INLINE_ID, nodes: [node('a'), node('b')] })]))
    expect(ids((await store.readProjectContent(INLINE_ID))!.nodes)).toEqual(['a', 'b'])
  })

  it('answers null for an unknown id, an SSH project and an unreadable folder', async () => {
    const store = new WorkspaceStore(fakeRemote())
    await store.save(ws([project({ id: 's1', ssh: SSH, cwd: undefined })]))
    expect(await store.readProjectContent('s1')).toBeNull()
    expect(await store.readProjectContent('nope')).toBeNull()

    // A folder whose project file could not be read at load (and was never written by us).
    await fs.writeFile(path.join(userData, 'workspace.json'), JSON.stringify({
      version: 3, activeProjectId: 'P',
      entries: [{ id: 'P', name: 'gone', color: '#fff', cwd: path.join(projRoot, 'missing') }]
    }))
    const cold = new WorkspaceStore()
    await cold.load()
    expect(await cold.readProjectContent('P')).toBeNull()
  })
})

describe('writeProjectContent — folder project', () => {
  it('keeps non-content fields and kanban.github/pullLinks, bumps rev, is a self-write', async () => {
    const store = await seedFolderAtRev3()
    const ok = await store.writeProjectContent('P', content(
      [node('b', { cwd: path.join(projRoot, 'sub') })],
      // The content's own GitHub config is NOT what lands: those two fields are the file's.
      { kanban: { columns: [], assignments: [], github: { repository: 'evil/x', columnMappings: [] } } as ProjectKanban }
    ))
    expect(ok).toBe(true)

    const raw = await fs.readFile(projectFile(), 'utf-8')
    const f = JSON.parse(raw)
    expect(f).toMatchObject({
      name: 'X', color: '#abcdef', defaultPermissionMode: 'plan', agentMessaging: true, dinoHighScore: 42
    })
    expect(f.rev).toBe(4)
    expect(ids(f.nodes)).toEqual(['b'])
    expect(f.nodes[0].cwd).toBe('./sub')
    // The file's viewport is DERIVED from its nodes (`framingViewport`), so it moves with them.
    expect(f.viewport).toEqual({ x: 80, y: 80, zoom: 1 })
    expect(f.kanban.columns).toEqual([])
    expect(f.kanban.assignments).toEqual([])
    expect(f.kanban.github).toEqual({ repository: 'a/b', columnMappings: [{ columnId: 'c1', label: 'todo' }] })
    expect(f.kanban.pullLinks).toEqual({ noAutoMove: ['a'] })
    // An empty list never ADDS a key the file did not have (a no-op flush must not diff the repo).
    expect('bridges' in f).toBe(false)
    expect('ropes' in f).toBe(false)
    expect(store.isSelfWrite(projectFile(), raw)).toBe(true)
    // Every client already has the change from the reflector: nothing is broadcast.
    expect(externalChanges()).toHaveLength(0)
    // The store's own record moved with it.
    expect(ids((await store.readProjectContent('P'))!.nodes)).toEqual(['b'])
  })

  it('is byte-identical to a normal save of the same content, apart from rev and savedAt', async () => {
    const rich = richProject(projRoot)
    const store = new WorkspaceStore()
    await store.save(ws([rich]))
    const viaSave = await fs.readFile(projectFile(), 'utf-8')

    // Move the file off that content first, so the comparison is against a REAL write.
    expect(await store.writeProjectContent('P', content([node('z')]))).toBe(true)
    expect(ids((await readJson(projectFile())).nodes)).toEqual(['z'])
    expect(await store.writeProjectContent('P', contentOf(rich))).toBe(true)
    const viaWrite = await fs.readFile(projectFile(), 'utf-8')

    expect(JSON.parse(viaWrite).rev).toBe(3)
    expect(withoutBookkeeping(viaWrite)).toBe(withoutBookkeeping(viaSave))
  })

  it('stays byte-identical for a project with no edge lists and no board', async () => {
    const plain = project({ cwd: projRoot, nodes: [node('a', { cwd: path.join(projRoot, 'w') })] })
    const store = new WorkspaceStore()
    await store.save(ws([plain]))
    const viaSave = await fs.readFile(projectFile(), 'utf-8')
    expect(await store.writeProjectContent('P', content([node('z')]))).toBe(true)
    expect(await store.writeProjectContent('P', contentOf(plain))).toBe(true)
    expect(withoutBookkeeping(await fs.readFile(projectFile(), 'utf-8'))).toBe(withoutBookkeeping(viaSave))
  })

  it('never writes a rev below the one on disk (an outside edit the store has not reloaded yet)', async () => {
    const store = new WorkspaceStore()
    await store.save(ws([project({ cwd: projRoot, nodes: [node('a')] })]))
    const outside = { ...(await readJson(projectFile())), rev: 9 }
    await fs.writeFile(projectFile(), JSON.stringify(outside, null, 2))
    expect(await store.writeProjectContent('P', content([node('b')]))).toBe(true)
    expect((await readJson(projectFile())).rev).toBe(10)
  })

  it('keeps the file’s board when the content has none', async () => {
    const store = await seedFolderAtRev3()
    expect(await store.writeProjectContent('P', content([node('a')]))).toBe(true)
    const f = await readJson(projectFile())
    expect(f.kanban.columns.map((c: { id: string }) => c.id)).toEqual(['c1'])
    expect(f.kanban.github.repository).toBe('a/b')
  })

  it('does not rewrite a file that already holds this content', async () => {
    const store = new WorkspaceStore()
    const p = project({ cwd: projRoot, nodes: [node('a')] })
    await store.save(ws([p]))
    const before = await fs.readFile(projectFile(), 'utf-8')
    expect(await store.writeProjectContent('P', contentOf(p))).toBe(true)
    expect(await fs.readFile(projectFile(), 'utf-8')).toBe(before)
  })

  it('never writes an empty canvas over a populated file it has not read', async () => {
    // The folder's file was missing at load, and has since appeared (a remount, a checkout).
    await fs.writeFile(path.join(userData, 'workspace.json'), JSON.stringify({
      version: 3, activeProjectId: 'P',
      entries: [{ id: 'P', name: 'foo', color: '#fff', cwd: projRoot, execMigrated: true }]
    }))
    const store = new WorkspaceStore()
    await store.load()
    await fs.mkdir(path.dirname(projectFile()), { recursive: true })
    const populated = JSON.stringify({ version: 1, rev: 5, savedAt: 'x', name: 'foo', color: '#fff', nodes: [node('keep')] }, null, 2)
    await fs.writeFile(projectFile(), populated)

    expect(await store.writeProjectContent('P', content([]))).toBe(false)
    expect(await fs.readFile(projectFile(), 'utf-8')).toBe(populated)
  })
})

describe('writeProjectContent — cwd-less canvas', () => {
  it('writes its data file and the index cache', async () => {
    const store = new WorkspaceStore()
    await store.save(ws([project({
      id: INLINE_ID,
      nodes: [node('a')],
      kanban: {
        columns: [{ id: 'c1', title: 'To Do', color: '#888' }],
        assignments: [],
        github: { repository: 'a/b', columnMappings: [] }
      } as ProjectKanban
    })]))

    const ok = await store.writeProjectContent(INLINE_ID, content([node('b')], {
      kanban: { columns: [{ id: 'c2', title: 'Doing', color: '#88f' }], assignments: [] }
    }))
    expect(ok).toBe(true)

    const raw = await fs.readFile(dataFile(), 'utf-8')
    const f = JSON.parse(raw)
    expect(f.rev).toBe(2)
    expect(ids(f.nodes)).toEqual(['b'])
    expect(f.kanban.columns.map((c: { id: string }) => c.id)).toEqual(['c2'])
    expect(f.kanban.github).toEqual({ repository: 'a/b', columnMappings: [] })
    expect(store.isSelfWrite(dataFile(), raw)).toBe(true)

    const entry = (await readIndex()).entries[0]
    expect(entry.dataFile).toBe(true)
    expect(ids(entry.project.nodes)).toEqual(['b'])
    expect(entry.project.kanban.github).toEqual({ repository: 'a/b', columnMappings: [] })
    expect(ids((await store.readProjectContent(INLINE_ID))!.nodes)).toEqual(['b'])
    expect(ids((await new WorkspaceStore().load()).projects[0].nodes)).toEqual(['b'])
    expect(externalChanges()).toHaveLength(0)
  })

  it('is byte-identical to a normal save of the same content, apart from rev and savedAt', async () => {
    const rich = richProject(undefined, INLINE_ID)
    const store = new WorkspaceStore()
    await store.save(ws([rich]))
    const viaSave = await fs.readFile(dataFile(), 'utf-8')
    expect(await store.writeProjectContent(INLINE_ID, content([node('z')]))).toBe(true)
    expect(await store.writeProjectContent(INLINE_ID, contentOf(rich))).toBe(true)
    const viaWrite = await fs.readFile(dataFile(), 'utf-8')
    expect(JSON.parse(viaWrite).rev).toBe(3)
    expect(withoutBookkeeping(viaWrite)).toBe(withoutBookkeeping(viaSave))
  })

  it('refuses when the file on disk carries a rev ahead of ours (another instance wrote it)', async () => {
    const store = new WorkspaceStore()
    await store.save(ws([project({ id: INLINE_ID, nodes: [node('a')] })]))
    const theirs = JSON.stringify({ version: 1, rev: 9, savedAt: 'x', name: 'other', color: '#000', nodes: [node('other')] }, null, 2)
    await fs.writeFile(dataFile(), theirs)
    store.onPersist = vi.fn()

    expect(await store.writeProjectContent(INLINE_ID, content([node('b')]))).toBe(false)
    expect(await fs.readFile(dataFile(), 'utf-8')).toBe(theirs)
    expect(ids((await readIndex()).entries[0].project.nodes)).toEqual(['a'])
    expect(ids((await store.readProjectContent(INLINE_ID))!.nodes)).toEqual(['a'])
    expect(store.onPersist).not.toHaveBeenCalled()
  })
})

/**
 * The content handed to `writeProjectContent` carries no exec fields (the authority strips them on
 * the way in), but a cwd-less canvas's index `project` is where this machine's exec values live: for
 * a pre-file canvas it is the ONLY place, and for a data-ref it is the cache a missing data file
 * falls back to. The write keeps the cached values and never takes the incoming ones.
 */
describe('writeProjectContent — this machine’s exec values in the index cache', () => {
  const PRE_FILE = 'pre-file'
  const sshConn = { host: 'h', user: 'u', extraArgs: '-J jump', execTrusted: true } as NonNullable<CanvasNodeState['ssh']>
  const withExec = (x = 0): CanvasNodeState => node('a', { shell: '/bin/zsh', ssh: sshConn, position: { x, y: 0 } })

  /** A cwd-less canvas stored IN the index (no `dataFile`): the index is its only storage. */
  async function seedPreFile(nodes: CanvasNodeState[]): Promise<WorkspaceStore> {
    await fs.writeFile(path.join(userData, 'workspace.json'), JSON.stringify({
      version: 3,
      activeProjectId: PRE_FILE,
      entries: [{ id: PRE_FILE, name: 'X', color: '#fff', viewport: { x: 0, y: 0, zoom: 1 }, project: project({ id: PRE_FILE, nodes }) }]
    }))
    const store = new WorkspaceStore()
    await store.load()
    return store
  }

  it('a pre-file canvas keeps its shell and ssh args across a write of stripped content', async () => {
    const store = await seedPreFile([withExec(), node('b')])
    const stripped = node('a', { ssh: { host: 'h', user: 'u' } as NonNullable<CanvasNodeState['ssh']>, position: { x: 5, y: 0 } })
    expect(await store.writeProjectContent(PRE_FILE, content([stripped, node('b')]))).toBe(true)

    const entry = (await readIndex()).entries[0]
    expect(entry.dataFile).toBeUndefined()
    const a = entry.project.nodes.find((n: CanvasNodeState) => n.id === 'a')
    expect(a.position.x).toBe(5)
    expect(a.shell).toBe('/bin/zsh')
    expect(a.ssh.extraArgs).toBe('-J jump')
    const loaded = (await new WorkspaceStore().load()).projects[0].nodes.find((n) => n.id === 'a')!
    expect(loaded.position.x).toBe(5)
    expect(loaded.shell).toBe('/bin/zsh')
    expect(loaded.ssh?.extraArgs).toBe('-J jump')
  })

  it('never takes exec values from the incoming content into the index', async () => {
    const store = await seedPreFile([node('a'), node('b')])
    expect(await store.writeProjectContent(PRE_FILE, content([node('a', { shell: '/bin/evil' }), node('b')]))).toBe(true)
    const a = (await readIndex()).entries[0].project.nodes.find((n: CanvasNodeState) => n.id === 'a')
    expect(a.shell).toBeUndefined()
  })

  it('a data-ref keeps them in its cache too, so the fallback load (data file gone) still has them', async () => {
    const store = new WorkspaceStore()
    await store.save(ws([project({ id: INLINE_ID, nodes: [withExec(), node('b')] })]))
    expect(await store.writeProjectContent(INLINE_ID, content([node('a', { position: { x: 5, y: 0 } }), node('b')]))).toBe(true)

    const f = JSON.parse(await fs.readFile(dataFile(), 'utf-8'))
    expect(f.nodes.find((n: CanvasNodeState) => n.id === 'a').shell).toBeUndefined() // the file stays exec-free
    const entry = (await readIndex()).entries[0]
    expect(entry.dataFile).toBe(true)
    expect(entry.project.nodes.find((n: CanvasNodeState) => n.id === 'a').shell).toBe('/bin/zsh')

    await fs.rm(dataFile())
    const loaded = (await new WorkspaceStore().load()).projects[0].nodes.find((n) => n.id === 'a')!
    expect(loaded.position.x).toBe(5)
    expect(loaded.shell).toBe('/bin/zsh')
  })
})

describe('writeProjectContent — bookkeeping and refusals', () => {
  it('calls onPersist once per landed write', async () => {
    const store = new WorkspaceStore()
    await store.save(ws([project({ cwd: projRoot }), project({ id: INLINE_ID })]))
    store.onPersist = vi.fn()

    expect(await store.writeProjectContent('P', content([node('b')]))).toBe(true)
    expect(store.onPersist).toHaveBeenCalledTimes(1)
    expect(await store.writeProjectContent(INLINE_ID, content([node('b')]))).toBe(true)
    expect(store.onPersist).toHaveBeenCalledTimes(2)
  })

  it('refuses an SSH project and an unknown id, writing nothing', async () => {
    const remote = fakeRemote()
    const store = new WorkspaceStore(remote)
    store.setContentAuthority(passThrough)
    await store.save(ws([project({ id: 's1', ssh: SSH, cwd: undefined })]))
    const writes = remote.writes
    const index = await fs.readFile(path.join(userData, 'workspace.json'), 'utf-8')
    store.onPersist = vi.fn()

    expect(await store.writeProjectContent('s1', content([node('b')]))).toBe(false)
    expect(await store.writeProjectContent('nope', content([node('b')]))).toBe(false)
    expect(remote.writes).toBe(writes)
    expect(await fs.readFile(path.join(userData, 'workspace.json'), 'utf-8')).toBe(index)
    expect(store.onPersist).not.toHaveBeenCalled()
  })

  it('is queued on saveChain: it lands after a save already in flight', async () => {
    const store = new WorkspaceStore()
    await store.save(ws([project({ cwd: projRoot, nodes: [node('a')] })]))
    const save = store.save(ws([project({ cwd: projRoot, nodes: [node('s')] })]))
    const write = store.writeProjectContent('P', content([node('w')]))
    await Promise.all([save, write])
    expect(ids((await readJson(projectFile())).nodes)).toEqual(['w'])
  })
})
