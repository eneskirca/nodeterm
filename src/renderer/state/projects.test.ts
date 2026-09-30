import { describe, it, expect, beforeEach } from 'vitest'
import { useProjects } from './projects'

beforeEach(() => {
  useProjects.getState().hydrate({ version: 2, activeProjectId: '', projects: [] })
})

describe('openFolderProject', () => {
  it('never routes a local folder to a relay tab carrying the same path (another machine)', () => {
    const relay = useProjects.getState().addProject('host', '/Users/me/dev/my-app')
    useProjects.setState((st) => ({ projects: st.projects.map((q) => (q.id === relay.id ? { ...q, remote: true } : q)) }))
    const p = useProjects.getState().openFolderProject('/Users/me/dev/my-app')
    expect(p.id).not.toBe(relay.id)
    expect(p.remote).toBeFalsy()
  })

  it('creates a new project named after the folder and activates it', () => {
    const p = useProjects.getState().openFolderProject('/Users/me/dev/my-app')
    expect(p.name).toBe('my-app')
    expect(p.cwd).toBe('/Users/me/dev/my-app')
    const s = useProjects.getState()
    expect(s.activeProjectId).toBe(p.id)
    expect(s.projects.filter((q) => !q.closed)).toHaveLength(1)
  })

  it('reuses an existing open project with the same folder instead of duplicating', () => {
    const first = useProjects.getState().addProject('my-app', '/Users/me/dev/my-app')
    const p = useProjects.getState().openFolderProject('/Users/me/dev/my-app')
    expect(p.id).toBe(first.id)
    expect(useProjects.getState().projects).toHaveLength(1)
    expect(useProjects.getState().activeProjectId).toBe(first.id)
  })

  // Regression: "Open folder" on a folder whose project was previously closed used to
  // activate the still-closed project — the canvas switched to it but the tab bar and
  // sidebar (which filter `closed`) showed nothing.
  it('reopens a closed project with the same folder so it is visible again', () => {
    const first = useProjects.getState().addProject('my-app', '/Users/me/dev/my-app')
    useProjects.getState().closeProject(first.id)
    expect(useProjects.getState().projects.filter((q) => !q.closed)).toHaveLength(0)

    const p = useProjects.getState().openFolderProject('/Users/me/dev/my-app')
    expect(p.id).toBe(first.id)
    const s = useProjects.getState()
    expect(s.activeProjectId).toBe(first.id)
    expect(s.projects.filter((q) => !q.closed).map((q) => q.id)).toEqual([first.id])
  })

  it('falls back to a generic name for a root-ish folder', () => {
    const p = useProjects.getState().openFolderProject('/')
    expect(p.name).toBe('Project')
  })
})

describe('adopting a folder whose canvas is shared (no id in the file)', () => {
  // The file names no project any more, so `probeFolder` mints one per adoption. Re-opening the
  // same folder must therefore be answered by the CWD lookup, never by a second adoption — that
  // lookup is the only thing standing between "open my repo again" and a duplicate tab.
  const probed = (id: string) => ({
    id, name: 'my-app', color: '#7aa2f7', cwd: '/Users/me/dev/my-app',
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [{
      id: 'term-a', kind: 'terminal' as const, position: { x: 0, y: 0 },
      size: { width: 1, height: 1 }, title: 'a', color: '#fff', group: null
    }]
  })

  it('re-opening the same folder yields ONE project, keyed by cwd', () => {
    const first = useProjects.getState().adoptProject(probed('project-minted-1'))
    expect(first.id).toBe('project-minted-1')
    const again = useProjects.getState().openFolderProject('/Users/me/dev/my-app')
    expect(again.id).toBe(first.id)
    expect(useProjects.getState().projects).toHaveLength(1)
    expect(useProjects.getState().projects[0].nodes.map((n) => n.id)).toEqual(['term-a'])
  })

  it('a SECOND folder holding the same canvas becomes its own project', () => {
    const a = useProjects.getState().adoptProject(probed('project-minted-1'))
    const b = useProjects.getState()
      .adoptProject({ ...probed('project-minted-2'), cwd: '/Users/me/dev/my-app-worktree' })
    expect(b.id).not.toBe(a.id)
    expect(useProjects.getState().projects.map((p) => p.cwd))
      .toEqual(['/Users/me/dev/my-app', '/Users/me/dev/my-app-worktree'])
  })
})

describe('toWorkspace', () => {
  // Tripwire for Stage 4a: a project's session binding is RUNTIME-ONLY (resolved by
  // src/renderer/session/session.ts `sessionForProject`). The persisted workspace shape must
  // never gain a session field — workspace.json / project.json are shared across machines and a
  // session id is meaningless anywhere but the machine that minted it. If this fails, someone
  // started persisting the session dimension; that is a design change, not a bug fix.
  it('toWorkspace does not persist any session dimension', () => {
    useProjects.getState().addProject('my-app', '/Users/me/dev/my-app')
    const ws = useProjects.getState().toWorkspace()
    const json = JSON.stringify(ws)
    expect(json).not.toMatch(/"session/i)
  })

  // A relay tab is a LIVE connection to another machine's project, not a workspace on this
  // disk. `project.remote` is runtime-only; toWorkspace must drop the whole project so it can
  // never be written into this client's workspace.json.
  it('excludes remote (relay) projects but keeps normal ones', () => {
    const normal = useProjects.getState().addProject('my-app', '/Users/me/dev/my-app')
    const relay = useProjects.getState().addProject('shared')
    useProjects.setState((s) => ({
      projects: s.projects.map((p) => (p.id === relay.id ? { ...p, remote: true } : p))
    }))
    const ws = useProjects.getState().toWorkspace()
    expect(ws.projects.map((p) => p.id)).toEqual([normal.id])
  })
})

// Regression (field bug 2026-08-10): `reloadActiveProject` used to re-run Canvas's load effect by
// flipping the active id to '' and back on a microtask. React coalesces both writes into ONE
// render, so the effect's dependency never changed and the reload silently never happened: the
// store held disk's version while React Flow still showed the old nodes, and the next debounced
// persist wrote those old nodes back over disk. A monotonic nonce is a dependency that always
// changes, even for a reload of the SAME project.
describe('requestReload', () => {
  it('bumps a monotonic nonce on every call', () => {
    const start = useProjects.getState().reloadNonce
    useProjects.getState().requestReload()
    expect(useProjects.getState().reloadNonce).toBe(start + 1)
    useProjects.getState().requestReload()
    useProjects.getState().requestReload()
    expect(useProjects.getState().reloadNonce).toBe(start + 3)
  })

  it('leaves the active project (and the projects) untouched — it only nudges the effect', () => {
    const p = useProjects.getState().openFolderProject('/Users/me/dev/my-app')
    useProjects.getState().requestReload()
    const s = useProjects.getState()
    expect(s.activeProjectId).toBe(p.id)
    expect(s.projects).toHaveLength(1)
  })

  // hydrate() replaces the persisted dimensions only: a nonce that reset on load would let a
  // pre-hydrate reload request be re-delivered (or lost) after it.
  it('survives hydrate, so the nonce never goes backwards', () => {
    useProjects.getState().requestReload()
    const n = useProjects.getState().reloadNonce
    useProjects.getState().hydrate({ version: 2, activeProjectId: '', projects: [] })
    expect(useProjects.getState().reloadNonce).toBe(n)
  })

  // The nonce is a RUNTIME nudge, never part of the shared workspace file.
  it('is not persisted', () => {
    useProjects.getState().requestReload()
    expect(JSON.stringify(useProjects.getState().toWorkspace())).not.toMatch(/reloadNonce/)
  })
})

describe('setDinoHighScore', () => {
  it('raises the project record and never lowers it', () => {
    const p = useProjects.getState().addProject('game', '/tmp/game')
    useProjects.getState().setDinoHighScore(p.id, 120)
    expect(useProjects.getState().getProject(p.id)?.dinoHighScore).toBe(120)
    // A lower report (second dino node / stale game) must not shrink the record.
    useProjects.getState().setDinoHighScore(p.id, 40)
    expect(useProjects.getState().getProject(p.id)?.dinoHighScore).toBe(120)
    useProjects.getState().setDinoHighScore(p.id, 200)
    expect(useProjects.getState().getProject(p.id)?.dinoHighScore).toBe(200)
  })

  it('ignores unknown project ids', () => {
    useProjects.getState().setDinoHighScore('nope', 99)
    expect(useProjects.getState().projects).toHaveLength(0)
  })
})

// Regression: "Connect over SSH…" used to create a brand-new project (fresh id, empty canvas)
// every time, even when a project for the same server+folder already existed — the empty canvas
// then mirrored over the server's .nodeterm/project.json and wiped it. Same contract as
// openFolderProject: reuse, reopen, never duplicate.
describe('openSshProject', () => {
  const server = { id: 's1', label: 'niova', host: 'h', user: 'root' } as never
  const ssh = { server, remoteCwd: '~/app' }

  it('creates a new ssh project and activates it when none matches', () => {
    const p = useProjects.getState().openSshProject('app · niova', ssh)
    expect(p.ssh).toEqual(ssh)
    expect(p.name).toBe('app · niova')
    const s = useProjects.getState()
    expect(s.activeProjectId).toBe(p.id)
    expect(s.projects).toHaveLength(1)
  })

  it('reuses the existing project for the same server+remoteCwd instead of duplicating', () => {
    const first = useProjects.getState().openSshProject('app · niova', ssh)
    // Re-added server entry: different SshServer id/label, same endpoint.
    const readded = { id: 's2', label: 'renamed', host: 'h', user: 'root' } as never
    const again = useProjects.getState().openSshProject('app · renamed', { server: readded, remoteCwd: '~/app' })
    expect(again.id).toBe(first.id)
    expect(useProjects.getState().projects).toHaveLength(1)
    expect(useProjects.getState().activeProjectId).toBe(first.id)
  })

  it('reopens a closed matching project so it is visible again', () => {
    const first = useProjects.getState().openSshProject('app · niova', ssh)
    useProjects.getState().closeProject(first.id)
    const p = useProjects.getState().openSshProject('app · niova', ssh)
    expect(p.id).toBe(first.id)
    const s = useProjects.getState()
    expect(s.activeProjectId).toBe(first.id)
    expect(s.projects.filter((q) => !q.closed).map((q) => q.id)).toEqual([first.id])
  })

  it('a different remoteCwd on the same server is a separate project', () => {
    const first = useProjects.getState().openSshProject('app · niova', ssh)
    const other = useProjects.getState().openSshProject('web · niova', { server, remoteCwd: '~/web' })
    expect(other.id).not.toBe(first.id)
    expect(useProjects.getState().projects).toHaveLength(2)
  })

  it('a different port on the same host is a separate project', () => {
    const first = useProjects.getState().openSshProject('app · niova', ssh)
    const alt = { id: 's3', label: 'alt', host: 'h', user: 'root', port: 2222 } as never
    const other = useProjects.getState().openSshProject('app · alt', { server: alt, remoteCwd: '~/app' })
    expect(other.id).not.toBe(first.id)
  })
})

describe('setProjectColor', () => {
  it('updates the project color', () => {
    const p = useProjects.getState().addProject('demo', '/tmp/demo')
    useProjects.getState().setProjectColor(p.id, '#ff453a')
    expect(useProjects.getState().getProject(p.id)?.color).toBe('#ff453a')
  })

  it('ignores unknown project ids', () => {
    useProjects.getState().setProjectColor('nope', '#ff453a')
    expect(useProjects.getState().projects).toHaveLength(0)
  })
})

// Issue #318: the AgentsSection capability toggle (and the clone-notice answers) mutate the store
// only — nothing scheduled a workspace save, so the choice was lost on restart unless an unrelated
// canvas edit happened to dirty the workspace afterwards. The setters own the persist now, through
// the same markWorkspaceDirty seam PR #317's identity edits use.
describe('capability setters schedule a workspace save', () => {
  it('setProjectCapability rings the workspace-dirty seam (on and off)', async () => {
    const { registerWorkspaceDirty } = await import('./workspaceDirty')
    const p = useProjects.getState().addProject('my-app', '/Users/me/dev/my-app')
    let dirtied = 0
    const unregister = registerWorkspaceDirty(() => dirtied++)
    try {
      useProjects.getState().setProjectCapability(p.id, 'agentMessaging', true)
      expect(dirtied).toBe(1)
      useProjects.getState().setProjectCapability(p.id, 'agentMessaging', false)
      expect(dirtied).toBe(2)
    } finally {
      unregister()
    }
  })

  it('recordProjectCapabilityAck rings it too (the notice answer must survive restart)', async () => {
    const { registerWorkspaceDirty } = await import('./workspaceDirty')
    const p = useProjects.getState().addProject('my-app', '/Users/me/dev/my-app')
    let dirtied = 0
    const unregister = registerWorkspaceDirty(() => dirtied++)
    try {
      useProjects.getState().recordProjectCapabilityAck(p.id, 'agentMessaging', 'kept')
      expect(dirtied).toBe(1)
    } finally {
      unregister()
    }
  })
})

// #925: canvas-control `--run-now` into a "Recently closed" project restores its tab but must not
// travel the user's view — `reopenProject` is the human path and also activates.
describe('unhideProject (#925)', () => {
  it('restores a closed project WITHOUT activating it', () => {
    const a = useProjects.getState().addProject('A')
    const b = useProjects.getState().addProject('B')
    useProjects.getState().closeProject(b.id)
    useProjects.getState().setActive(a.id)

    useProjects.getState().unhideProject(b.id)
    const s = useProjects.getState()
    expect(s.projects.find((p) => p.id === b.id)?.closed).toBe(false)
    expect(s.activeProjectId).toBe(a.id)
  })

  it('is a no-op for an unknown id', () => {
    const a = useProjects.getState().addProject('A')
    useProjects.getState().setActive(a.id)
    useProjects.getState().unhideProject('zzz')
    expect(useProjects.getState().projects).toHaveLength(1)
    expect(useProjects.getState().activeProjectId).toBe(a.id)
  })
})

describe('rebindNode', () => {
  const seed = () => {
    const node = (id: string, accountId?: string) => ({
      id, kind: 'terminal' as const, position: { x: 0, y: 0 }, size: { width: 1, height: 1 },
      title: id, color: '#fff', group: null, agentId: 'claude', ...(accountId ? { accountId } : {})
    })
    useProjects.getState().hydrate({
      version: 2,
      activeProjectId: 'p2',
      projects: [
        { id: 'p1', name: 'one', color: '#fff', viewport: { x: 0, y: 0, zoom: 1 }, nodes: [node('n1', 'a'), node('n2', 'a')] },
        { id: 'p2', name: 'two', color: '#fff', viewport: { x: 0, y: 0, zoom: 1 }, nodes: [node('n3', 'a')] }
      ]
    })
  }
  const stored = (p: string, n: string) =>
    useProjects.getState().projects.find((x) => x.id === p)?.nodes.find((x) => x.id === n)

  it('writes the account into a background project\'s serialized node, touching nothing else', () => {
    seed()
    useProjects.getState().rebindNode('p1', 'n1', { agentId: 'claude', accountId: 'b' })
    expect(stored('p1', 'n1')?.accountId).toBe('b')
    expect(stored('p1', 'n2')?.accountId).toBe('a')
    expect(stored('p2', 'n3')?.accountId).toBe('a')
  })

  it('an explicit undefined account moves the node to the system account', () => {
    seed()
    useProjects.getState().rebindNode('p1', 'n1', { agentId: 'claude', accountId: undefined })
    expect(stored('p1', 'n1')?.accountId).toBeUndefined()
  })

  it('an absent account key leaves the account alone', () => {
    seed()
    useProjects.getState().rebindNode('p1', 'n1', { agentId: 'claude' })
    expect(stored('p1', 'n1')?.accountId).toBe('a')
  })
})
