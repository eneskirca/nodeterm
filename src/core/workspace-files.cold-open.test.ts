import { describe, it, expect } from 'vitest'
import {
  projectToFile,
  fileToProject,
  serializeProjectFile,
  splitWorkspace,
  type IndexEntryV3
} from './workspace-files'
import type { CanvasNodeState, PendingLaunch, Project, Workspace } from '../shared/types'

/**
 * Issue #338 Task 2.0, pin (c) — the DISK half of the cold-open round-trip. A `--project`-targeted
 * open writes its node into the target project's serialized store with the launch command in
 * `pendingLaunch: { after: [], command }`, then `writeDisk` persists it. The target project may
 * not be viewed until after an app restart — so the armed launch has to survive a save → load.
 *
 * It survives in the MACHINE-LOCAL index (`IndexEntryV3.localExec`), never in the shared
 * `.nodeterm/project.json`: a held launch is a command that is typed into a shell as soon as its
 * wait is over, so a project file carrying one (a cloned repo, an SSH host's copy) would run a
 * stranger's command on "Open folder…" (@shared/node-exec). The live↔store pins (a)/(b) live in
 * `src/renderer/state/workspace.cold-open.test.ts`.
 */
const pending: PendingLaunch = { after: [], command: 'claude "do the thing"' }
const armed: CanvasNodeState = {
  id: 'term-cold1',
  kind: 'terminal',
  position: { x: 40, y: 60 },
  size: { width: 600, height: 400 },
  title: 'Claude',
  color: '#d97757',
  group: null,
  agentId: 'claude',
  pendingLaunch: pending
}

function roundTrip(project: Project): { file: unknown; entry: IndexEntryV3; loaded: Project } {
  const ws: Workspace = { version: 2, activeProjectId: project.id, projects: [project] } as Workspace
  const { index, files, dataFiles } = splitWorkspace(ws, () => 1, new Date(0).toISOString())
  // workspace.json is JSON on disk: the index entry must survive a serialize → parse too.
  const entry = JSON.parse(JSON.stringify(index.entries[0])) as IndexEntryV3
  const shared =
    (project.ssh ? entry.cache : project.cwd ? files.get(project.cwd) : dataFiles.get(project.id))!
  const file = JSON.parse(serializeProjectFile(shared))
  const loaded = fileToProject(file, {
    id: entry.id,
    ...(project.cwd ? { cwd: project.cwd } : {}),
    ...(project.ssh ? { ssh: project.ssh } : {}),
    localExec: entry.localExec
  })
  return { file, entry, loaded }
}

describe('cold-open pin (c): pendingLaunch survives a restart ON THIS MACHINE', () => {
  it('folder project: the file carries no launch, the local index does, the load restores it', () => {
    const { file, entry, loaded } = roundTrip({
      id: 'project-a',
      name: 'repoA',
      color: '#888',
      cwd: '/tmp/repoA',
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [armed]
    })
    expect(JSON.stringify(file)).not.toContain('pendingLaunch')
    expect(JSON.stringify(file)).not.toContain('do the thing')
    expect(entry.localExec?.['term-cold1']?.pendingLaunch).toEqual(pending)
    expect(loaded.nodes[0].pendingLaunch).toEqual(pending)
  })

  it('SSH project: the mirrored cache carries no launch; the local entry does', () => {
    const { file, entry, loaded } = roundTrip({
      id: 'project-s',
      name: 'remote',
      color: '#888',
      ssh: { server: { host: 'h', user: 'u' }, remoteCwd: '/srv/x' } as unknown as Project['ssh'],
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [armed]
    })
    expect(JSON.stringify(file)).not.toContain('pendingLaunch')
    expect(entry.localExec?.['term-cold1']?.pendingLaunch).toEqual(pending)
    expect(loaded.nodes[0].pendingLaunch).toEqual(pending)
  })

  it('cwd-less (local-data ref) project: same split', () => {
    const { file, entry, loaded } = roundTrip({
      id: 'project-inline',
      name: 'scratch',
      color: '#888',
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [armed]
    })
    expect(JSON.stringify(file)).not.toContain('pendingLaunch')
    expect(entry.localExec?.['term-cold1']?.pendingLaunch).toEqual(pending)
    expect(loaded.nodes[0].pendingLaunch).toEqual(pending)
  })

  it('worktree setup gate (awaitSetupGroup) survives the local round-trip', () => {
    const gated: CanvasNodeState = { ...armed, pendingLaunch: { ...pending, awaitSetupGroup: 'g1' } }
    const { loaded } = roundTrip({
      id: 'project-a',
      name: 'repoA',
      color: '#888',
      cwd: '/tmp/repoA',
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [gated]
    })
    expect(loaded.nodes[0].pendingLaunch?.awaitSetupGroup).toBe('g1')
  })
})

describe('a project file that carries pendingLaunch contributes NOTHING', () => {
  it('a hostile / cloned project.json: the launch is dropped on read', () => {
    const project: Project = {
      id: 'project-a',
      name: 'repoA',
      color: '#888',
      cwd: '/tmp/repoA',
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: []
    }
    const file = { ...projectToFile(project, 1, new Date(0).toISOString()), nodes: [armed] }
    // Adopted folder: no machine-local entry at all.
    const loaded = fileToProject(JSON.parse(serializeProjectFile(file)), { id: 'x', cwd: '/tmp/repoA' })
    expect(loaded.nodes[0].pendingLaunch).toBeUndefined()
    // An existing entry that holds exec values for OTHER fields does not bless the file's launch.
    const withShell = fileToProject(JSON.parse(serializeProjectFile(file)), {
      id: 'x',
      cwd: '/tmp/repoA',
      localExec: { 'term-cold1': { shell: '/bin/zsh' } }
    })
    expect(withShell.nodes[0].pendingLaunch).toBeUndefined()
    expect(withShell.nodes[0].shell).toBe('/bin/zsh')
  })
})
