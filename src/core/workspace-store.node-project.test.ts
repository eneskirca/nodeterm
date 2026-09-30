// `projectIdsForNode` is asked once per access decision for every hosted-team viewer (every
// agent:status event, every subagent-activity chunk, every unread-clear, every snapshot element).
// `persistedCanvases()` re-parses every local project's cached project.json on each call, so the
// answer is memoized — and the memo must never serve a stale answer after ANY writer changed a
// project's nodes, including the ones that change the cache without going through save()/load().
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import { initPlatform, resetPlatformForTests } from './platform'
import { fakePlatform } from './platform-fake'
import { WorkspaceStore } from './workspace-store'
import type { CanvasNodeState, Project, Workspace } from '../shared/types'

let userData: string
const roots: string[] = []

const node = (id: string): CanvasNodeState =>
  ({ id, kind: 'terminal', position: { x: 0, y: 0 }, size: { width: 1, height: 1 }, title: id, color: '#fff', group: null }) as CanvasNodeState
const project = (id: string, cwd: string | undefined, nodeIds: string[]): Project => ({
  id,
  name: id,
  color: '#7aa2f7',
  viewport: { x: 0, y: 0, zoom: 1 },
  nodes: nodeIds.map(node),
  ...(cwd ? { cwd } : {})
})
const ws = (projects: Project[]): Workspace => ({ version: 2, activeProjectId: projects[0]?.id ?? '', projects })
const newRoot = async (): Promise<string> => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'nt-np-'))
  roots.push(d)
  return d
}

beforeEach(async () => {
  userData = await fs.mkdtemp(path.join(os.tmpdir(), 'nt-np-ws-'))
  initPlatform(fakePlatform({ userDataDir: userData }))
})
afterEach(async () => {
  resetPlatformForTests()
  await fs.rm(userData, { recursive: true, force: true })
  for (const d of roots.splice(0)) await fs.rm(d, { recursive: true, force: true })
})

/** How many times `JSON.parse` runs inside `fn` (synchronous, so nothing else runs meanwhile). */
function parses(fn: () => void): number {
  const spy = vi.spyOn(JSON, 'parse')
  try {
    fn()
    return spy.mock.calls.length
  } finally {
    spy.mockRestore()
  }
}

describe('WorkspaceStore.projectIdsForNode', () => {
  it('answers exactly what a persistedCanvases scan answers', async () => {
    const [a, b] = [await newRoot(), await newRoot()]
    const store = new WorkspaceStore()
    await store.save(ws([project('pa', a, ['n1', 'n2']), project('pb', b, ['n3']), project('inline', undefined, ['n4'])]))
    const scan = (id: string): string[] => store.persistedCanvases().filter((c) => c.nodes.some((n) => n.id === id)).map((c) => c.id)
    for (const id of ['n1', 'n2', 'n3', 'n4', 'nope']) expect(store.projectIdsForNode(id)).toEqual(scan(id))
    expect(store.projectIdsForNode('n3')).toEqual(['pb'])
    expect(store.projectIdsForNode('nope')).toEqual([])
  })

  it('parses each project file at most once for any number of lookups', async () => {
    const dirs = await Promise.all(Array.from({ length: 5 }, () => newRoot()))
    const store = new WorkspaceStore()
    await store.save(ws(dirs.map((d, i) => project(`p${i}`, d, Array.from({ length: 50 }, (_, j) => `p${i}-n${j}`)))))
    const n = parses(() => {
      for (let k = 0; k < 1000; k++) store.projectIdsForNode(`p${k % 5}-n${k % 50}`)
    })
    // One rebuild after the save (one parse per local project), then pure map lookups.
    expect(n).toBeLessThanOrEqual(5)
    // And a further burst with nothing changed parses nothing at all.
    expect(parses(() => { for (let k = 0; k < 1000; k++) store.projectIdsForNode('p1-n1') })).toBe(0)
  })

  it('a save that adds a node or moves one to another project is seen at once', async () => {
    const [a, b] = [await newRoot(), await newRoot()]
    const store = new WorkspaceStore()
    await store.save(ws([project('pa', a, ['n1']), project('pb', b, ['n2'])]))
    expect(store.projectIdsForNode('n1')).toEqual(['pa'])
    expect(store.projectIdsForNode('n9')).toEqual([])
    await store.save(ws([project('pa', a, ['n9']), project('pb', b, ['n2', 'n1'])]))
    expect(store.projectIdsForNode('n9')).toEqual(['pa'])
    expect(store.projectIdsForNode('n1')).toEqual(['pb'])
    // Into and out of an inline (cwd-less) project, whose nodes live in the index entry itself.
    await store.save(ws([project('pa', a, ['n9']), project('pb', b, ['n2']), project('inline', undefined, ['n1'])]))
    expect(store.projectIdsForNode('n1')).toEqual(['inline'])
  })

  it('a write that bypasses save() (a phone-registered node) is seen at once', async () => {
    const a = await newRoot()
    const store = new WorkspaceStore()
    await store.save(ws([project('pa', a, ['n1'])]))
    expect(store.projectIdsForNode('term-abc123-phone1')).toEqual([])
    expect(await store.appendRemoteNode('pa', { id: 'term-abc123-phone1', title: 'from the phone' })).toBe(true)
    expect(store.projectIdsForNode('term-abc123-phone1')).toEqual(['pa'])
  })

  it('an outside edit picked up by load() (git pull, hand edit) is seen at once', async () => {
    const [a, b] = [await newRoot(), await newRoot()]
    const store = new WorkspaceStore()
    await store.save(ws([project('pa', a, ['n1']), project('pb', b, ['n2'])]))
    expect(store.projectIdsForNode('n1')).toEqual(['pa'])
    // Move n1 from pa's file to pb's file behind the store's back, then reload.
    const fa = path.join(a, '.nodeterm', 'project.json')
    const fb = path.join(b, '.nodeterm', 'project.json')
    const ja = JSON.parse(await fs.readFile(fa, 'utf-8'))
    const jb = JSON.parse(await fs.readFile(fb, 'utf-8'))
    jb.nodes.push(...ja.nodes)
    ja.nodes = []
    ja.rev += 1
    jb.rev += 1
    await fs.writeFile(fa, JSON.stringify(ja, null, 2))
    await fs.writeFile(fb, JSON.stringify(jb, null, 2))
    await store.load()
    expect(store.projectIdsForNode('n1')).toEqual(['pb'])
  })
})

describe('WorkspaceStore.projectIdsForNode — an id in more than one project (M4)', () => {
  it('answers EVERY project holding the id, in index order, never just the first', async () => {
    // Node ids travel in git-shared project files, so the same id can sit in two projects.
    const [a, b] = [await newRoot(), await newRoot()]
    const store = new WorkspaceStore()
    await store.save(ws([project('pa', a, ['dup', 'n1']), project('pb', b, ['dup']), project('inline', undefined, ['dup'])]))
    expect(store.projectIdsForNode('dup')).toEqual(['pa', 'pb', 'inline'])
    expect(store.projectIdsForNode('n1')).toEqual(['pa'])
  })
})

describe('WorkspaceStore.projectIdsForNode — the memo keys (D1)', () => {
  // The memo is keyed on the IDENTITY of every input persistedCanvases reads. The node array itself
  // is one of them: a writer that replaces `entry.project.nodes` / `entry.cache.nodes` on the SAME
  // entry and project/cache object must still be seen, and so must an in-place re-key of an inline
  // project's id.
  type Entry = { id: string; project?: { id: string; nodes: CanvasNodeState[] }; cache?: { nodes: CanvasNodeState[] } }
  const entriesOf = (store: WorkspaceStore): Entry[] => (store as unknown as { index: { entries: Entry[] } }).index.entries

  it('an inline project whose node array is replaced in place, or whose id is re-keyed in place', async () => {
    const store = new WorkspaceStore()
    await store.save(ws([project('inline', undefined, ['n1'])]))
    expect(store.projectIdsForNode('n1')).toEqual(['inline'])
    const e = entriesOf(store)[0]
    e.project!.nodes = [node('n2')]
    expect(store.projectIdsForNode('n2')).toEqual(['inline'])
    expect(store.projectIdsForNode('n1')).toEqual([])
    e.project!.id = 'renamed'
    expect(store.projectIdsForNode('n2')).toEqual(['renamed'])
  })

  it('an SSH entry whose cached node array is replaced in place', async () => {
    const store = new WorkspaceStore()
    await store.save(ws([project('inline', undefined, ['n1'])]))
    entriesOf(store).push({ id: 'ssh1', cache: { nodes: [node('s1')] } })
    expect(store.projectIdsForNode('s1')).toEqual(['ssh1'])
    const e = entriesOf(store)[1]
    e.cache!.nodes = [node('s2')]
    expect(store.projectIdsForNode('s2')).toEqual(['ssh1'])
    expect(store.projectIdsForNode('s1')).toEqual([])
  })
})

describe('WorkspaceStore.projectIdsForNode — the per-frame cost (R46)', () => {
  // A hosted-team relay asks this once per terminal FRAME for every non-editor viewer, and each ask
  // snapshots the memo's inputs. That snapshot used to `path.join` every local ref's project-file
  // path (85% of ~78 µs/frame at 100 entries). The path depends on the cwd string alone, so it is
  // memoized per cwd — and the memo must keep invalidating on every input kind it did before.
  type Entry = {
    id: string
    cwd?: string
    project?: { id: string; nodes: CanvasNodeState[] }
    cache?: { nodes: CanvasNodeState[] }
  }
  type Internals = { index: { entries: Entry[] }; lastWritten: Map<string, string> }
  const internals = (store: WorkspaceStore): Internals => store as unknown as Internals

  it('a lookup against an unchanged store builds no project-file path', async () => {
    const dirs = await Promise.all(Array.from({ length: 20 }, () => newRoot()))
    const store = new WorkspaceStore()
    await store.save(ws(dirs.map((d, i) => project(`p${i}`, d, [`p${i}-n1`]))))
    expect(store.projectIdsForNode('p3-n1')).toEqual(['p3'])
    const join = vi.spyOn(path, 'join')
    try {
      for (let k = 0; k < 100; k++) store.projectIdsForNode(`p${k % 20}-n1`)
      expect(join).not.toHaveBeenCalled()
    } finally {
      join.mockRestore()
    }
  })

  /** Local refs pa (cwd a) and pb (cwd b), an inline project and an SSH cache, memo warmed. */
  async function fixture(): Promise<{ store: WorkspaceStore; entries: Entry[]; a: string; b: string }> {
    const [a, b] = [await newRoot(), await newRoot()]
    const store = new WorkspaceStore()
    await store.save(ws([project('pa', a, ['n1']), project('pb', b, ['n2']), project('inline', undefined, ['n3'])]))
    internals(store).index.entries.push({ id: 'ssh1', cache: { nodes: [node('s1')] } })
    expect(store.projectIdsForNode('n1')).toEqual(['pa'])
    return { store, entries: internals(store).index.entries, a, b }
  }

  const kinds: Array<[string, (f: Awaited<ReturnType<typeof fixture>>) => void, string, string[]]> = [
    ['the index object is reassigned', ({ store, entries }) => {
      internals(store).index = { ...internals(store).index, entries: entries.filter((e) => e.id !== 'pa') }
    }, 'n1', []],
    ['an entry is replaced in the array', ({ entries }) => { entries[0] = { ...entries[0], id: 'pa2' } }, 'n1', ['pa2']],
    ['a local ref is re-keyed in place', ({ entries }) => { entries[0].id = 'pa3' }, 'n1', ['pa3']],
    ['an inline project is replaced', ({ entries }) => { entries[2].project = { ...entries[2].project!, nodes: [node('n9')] } }, 'n9', ['inline']],
    ['an inline project is re-keyed in place', ({ entries }) => { entries[2].project!.id = 'renamed' }, 'n3', ['renamed']],
    ['an inline node array is replaced', ({ entries }) => { entries[2].project!.nodes = [node('n8')] }, 'n8', ['inline']],
    ['an SSH cache is replaced', ({ entries }) => { entries[3].cache = { ...entries[3].cache!, nodes: [node('s9')] } }, 's9', ['ssh1']],
    ['an SSH cached node array is replaced', ({ entries }) => { entries[3].cache!.nodes = [node('s8')] }, 's8', ['ssh1']],
    ["a local ref's cwd changes in place", ({ entries, b }) => { entries[0].cwd = b }, 'n2', ['pa', 'pb']],
    ["a local ref's project file text changes", ({ store, a }) => {
      const file = path.join(a, '.nodeterm', 'project.json')
      const lw = internals(store).lastWritten
      lw.set(file, JSON.stringify({ ...JSON.parse(lw.get(file)!), nodes: [node('n7')] }))
    }, 'n7', ['pa']]
  ]

  it.each(kinds)('invalidates when %s', async (_kind, change, id, want) => {
    const f = await fixture()
    expect(f.store.projectIdsForNode(id)).not.toEqual(want)
    change(f)
    expect(f.store.projectIdsForNode(id)).toEqual(want)
  })

  it("after a cwd moves in place, the memo watches the NEW folder's file text", async () => {
    // The path memo is keyed on the cwd STRING. A memo keyed on anything else (the entry object,
    // its id) keeps handing out the old folder's path, so the snapshot watches a file nothing
    // reads any more and a later edit of the new folder's file is never seen. The new folder is
    // one no other entry points at, so no other input can invalidate the memo on its behalf.
    const f = await fixture()
    const c = await newRoot()
    const file = path.join(c, '.nodeterm', 'project.json')
    const lw = internals(f.store).lastWritten
    const template = JSON.parse(lw.get(path.join(f.a, '.nodeterm', 'project.json'))!)
    lw.set(file, JSON.stringify({ ...template, nodes: [node('n5')] }))
    f.entries[0].cwd = c
    expect(f.store.projectIdsForNode('n5')).toEqual(['pa'])
    lw.set(file, JSON.stringify({ ...template, nodes: [node('n6')] }))
    expect(f.store.projectIdsForNode('n6')).toEqual(['pa'])
    expect(f.store.projectIdsForNode('n5')).toEqual([])
  })
})
