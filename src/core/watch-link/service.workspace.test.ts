// The node-gone rule against the REAL workspace store (ruling R44). A lost or corrupt workspace.json
// is rebuilt from nothing during the run: the renderer's load sets the corrupt file aside and its
// unconditional boot save writes an EMPTY index. That index must not read as a complete read of every
// project — every node would be "absent" and every live link revoked a second after launch, while
// each project's own `.nodeterm/project.json` still holds its nodes.
import { describe, it, expect, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { testTmpDir } from '../test-tmp'
import { initPlatform, resetPlatformForTests } from '../platform'
import { fakePlatform } from '../platform-fake'
import { WorkspaceStore } from '../workspace-store'
import { createWatchLinkService, workspaceNodeState, type WatchLinkService } from './service'
import type { WatchLinkRecord } from './store'
import type { WatchLinkApi as ApiClient } from './api'
import type { LinkHost } from './link-host'
import type { Project, Workspace } from '../../shared/types'

const services: WatchLinkService[] = []
afterEach(async () => {
  for (const s of services.splice(0)) await s.shutdown()
  resetPlatformForTests()
})

const project = (cwd: string): Project => ({
  id: 'p1', name: 'foo', color: '#7aa2f7', viewport: { x: 0, y: 0, zoom: 1 }, cwd,
  nodes: [{ id: 'term-1', kind: 'terminal', position: { x: 0, y: 0 }, size: { width: 1, height: 1 }, title: 't', color: '#fff', group: null }]
})
const ws = (projects: Project[]): Workspace => ({ version: 2, activeProjectId: projects[0]?.id ?? '', projects })

/** A machine with one folder project holding node `term-1`, its index written by a previous run. */
async function machine() {
  const userData = testTmpDir('nt-wl-ws-')
  const projRoot = testTmpDir('nt-wl-proj-')
  initPlatform(fakePlatform({ userDataDir: userData }))
  await new WorkspaceStore().save(ws([project(projRoot)]))
  return { userData, projRoot, index: path.join(userData, 'workspace.json') }
}

/** The live-link service over this store, resuming one link to `term-1`. */
function linksOver(store: WorkspaceStore) {
  const calls: string[] = []
  const stopped: string[] = []
  const api: ApiClient = {
    create: async () => ({ ok: false, error: 'network' }),
    hostToken: async () => ({ ok: false, kind: 'network' }),
    status: async () => 'live',
    revoke: async (id) => {
      calls.push(`revoke ${id}`)
      return true
    },
    revokeAll: async () => true
  }
  const record: WatchLinkRecord = {
    linkId: 'Keep000000000000000000', nodeId: 'term-1', role: 'viewer', label: 'A', title: 't',
    createdAt: 0, expiresAt: Date.now() + 3_600_000, secret: new Uint8Array(32).fill(1)
  }
  const s = createWatchLinkService({
    api,
    relayUrl: 'wss://r',
    store: { load: async () => [record], save: async () => 'saved', discardOpaque: () => {}, opaqueCount: () => 0 },
    entitlement: () => 'ent',
    relayAllowed: () => true,
    nodeState: (id) => workspaceNodeState(store, id),
    clients: { attach: () => 1, detach: () => {} },
    pty: {
      join: async () => null, leave: () => {}, captureVisible: async () => ({ screen: '', cursor: null }),
      syncSize: async () => true, alive: () => true
    },
    emit: () => {},
    createHost: (): LinkHost => ({
      start: () => {}, stop: (r) => { stopped.push(r) }, kick: () => false, postSharerChat: () => null,
      chatHistory: () => [], status: () => 'live', viewers: () => []
    })
  })
  services.push(s)
  store.onPersist = () => s.onWorkspaceChanged()
  return { s, calls, stopped }
}
const settle = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

describe('an index rebuilt from nothing is never a complete read (R44)', () => {
  it('control: with a readable index, a node that leaves every project IS absent and its link ends', async () => {
    await machine()
    const store = new WorkspaceStore()
    await store.load({ sideline: false })
    const links = linksOver(store)
    await links.s.init()
    expect(workspaceNodeState(store, 'term-1')).toBe('present')
    await store.save(ws([])) // the user removed the project
    expect(workspaceNodeState(store, 'term-1')).toBe('absent')
    await settle()
    expect(links.calls).toEqual(['revoke Keep000000000000000000'])
    expect(links.stopped).toEqual(['node-gone'])
  })

  it('a CORRUPT index: boot read, the renderer sets it aside, its empty boot save — the node stays unknown, no link is revoked', async () => {
    const m = await machine()
    await fs.writeFile(m.index, '{nope')
    const store = new WorkspaceStore()
    await store.load({ sideline: false }) // the desktop's boot read (bootWorkspaceLoad)
    const links = linksOver(store)
    await links.s.init()
    expect(links.s.list()).toHaveLength(1)
    await store.load() // the renderer's load: sets the corrupt file aside
    expect((await fs.readdir(m.userData)).some((n) => n.startsWith('workspace.json.corrupt-'))).toBe(true)
    await store.save(ws([])) // the renderer's unconditional boot save: an EMPTY index
    expect(JSON.parse(await fs.readFile(m.index, 'utf8')).entries).toEqual([])
    expect(workspaceNodeState(store, 'term-1')).toBe('unknown')
    expect(store.knownNodeIdsStrict()).toBeUndefined()
    await settle()
    expect(links.calls).toEqual([])
    expect(links.stopped).toEqual([])
    expect(links.s.list()).toHaveLength(1)
    // The project file still holds the node: reopening the folder brings it back with the same id.
    expect(await fs.readFile(path.join(m.projRoot, '.nodeterm/project.json'), 'utf8')).toContain('term-1')
  })

  it('a DELETED index is the same (for the rest of the run, even once projects are added back)', async () => {
    const m = await machine()
    await fs.rm(m.index)
    const store = new WorkspaceStore()
    await store.load({ sideline: false })
    const links = linksOver(store)
    await links.s.init()
    await store.load()
    await store.save(ws([]))
    expect(workspaceNodeState(store, 'term-1')).toBe('unknown')
    const other = testTmpDir('nt-wl-other-')
    await store.save(ws([{ ...project(other), id: 'p2', nodes: [] }])) // a project added back, not the node's
    expect(workspaceNodeState(store, 'term-1')).toBe('unknown')
    await settle()
    expect(links.calls).toEqual([])
  })

  it('an index that could not be READ (EIO, EACCES) is the same: a failed read is never evidence', async () => {
    const m = await machine()
    await fs.rm(m.index)
    await fs.mkdir(m.index) // readFile answers EISDIR: the store falls back to an empty workspace
    const store = new WorkspaceStore()
    await store.load({ sideline: false })
    expect(store.knownNodeIdsStrict()).toBeUndefined()
    await fs.rmdir(m.index)
    await store.save(ws([]))
    expect(workspaceNodeState(store, 'term-1')).toBe('unknown')
  })

  // NEW-1: a file that PARSES but is no index this build recognises falls through to an empty
  // workspace just like an unparsable one — and its empty boot save must not read as complete either.
  for (const [label, body] of [
    ['{}', '{}'],
    ['[]', '[]'],
    ['null', 'null'],
    ['a v2 without its projects list', '{"version":2}'],
    ['a v3 without entries', '{"version":3}'],
    ['a v3 whose entries are not objects', '{"version":3,"entries":[5]}'],
    ['a newer build\'s index', '{"version":4,"entries":[]}']
  ] as const) {
    it(`a PARSABLE but unrecognised index (${label}) is the same: unknown after the empty boot save, and load() answers`, async () => {
      const m = await machine()
      await fs.writeFile(m.index, body)
      const store = new WorkspaceStore()
      await expect(store.load({ sideline: false })).resolves.toMatchObject({ projects: [] })
      const links = linksOver(store)
      await links.s.init()
      await store.load()
      await store.save(ws([]))
      expect(workspaceNodeState(store, 'term-1')).toBe('unknown')
      await settle()
      expect(links.calls).toEqual([])
      expect(links.s.list()).toHaveLength(1)
    })
  }

  // …while an index that says, readably, that there is nothing IS a complete read.
  for (const [label, body] of [
    ['v3', '{"version":3,"entries":[]}'],
    ['v2', '{"version":2,"activeProjectId":"","projects":[]}']
  ] as const) {
    it(`a genuinely empty ${label} index stays a complete read: the node is absent`, async () => {
      const m = await machine()
      await fs.writeFile(m.index, body)
      const store = new WorkspaceStore()
      await store.load()
      await store.save(ws([]))
      expect(store.knownNodeIdsStrict()).toEqual(new Set())
      expect(workspaceNodeState(store, 'term-1')).toBe('absent')
    })
  }
})
