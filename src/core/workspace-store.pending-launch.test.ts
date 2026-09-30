import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import { initPlatform, resetPlatformForTests } from './platform'
import { fakePlatform } from './platform-fake'
import { WorkspaceStore } from './workspace-store'
import type { CanvasNodeState, PendingLaunch, Project, Workspace } from '../shared/types'

/**
 * `pendingLaunch` is machine-local (@shared/node-exec). Through the REAL store:
 *  - an armed node (a cold open into a project nobody is looking at) survives an app restart on
 *    this machine — it lives in workspace.json's `localExec`;
 *  - `.nodeterm/project.json` never carries it;
 *  - a project.json that DOES carry one (a cloned repo, or one written by an older build) is
 *    ignored, including by the one-time legacy migration.
 */

let userData: string
let projRoot: string

const launch: PendingLaunch = { after: ['dep-1'], command: 'claude "the brief"', awaitSetupGroup: 'g1' }
const armedNode: CanvasNodeState = {
  id: 'term-1', kind: 'terminal', position: { x: 0, y: 0 }, size: { width: 1, height: 1 },
  title: 't', color: '#fff', group: null, pendingLaunch: launch
}
const project = (over: Partial<Project> = {}): Project => ({
  id: 'p1', name: 'foo', color: '#7aa2f7', viewport: { x: 0, y: 0, zoom: 1 }, nodes: [armedNode], ...over
})
const ws = (projects: Project[]): Workspace => ({ version: 2, activeProjectId: projects[0].id, projects })
const projectFile = (): Promise<string> => fs.readFile(path.join(projRoot, '.nodeterm/project.json'), 'utf-8')

beforeEach(async () => {
  userData = await fs.mkdtemp(path.join(os.tmpdir(), 'nt-ws-pl-'))
  projRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'nt-proj-pl-'))
  initPlatform(fakePlatform({ userDataDir: userData }))
})
afterEach(async () => {
  resetPlatformForTests()
  await fs.rm(userData, { recursive: true, force: true })
  await fs.rm(projRoot, { recursive: true, force: true })
})

describe('an armed node survives an app restart on this machine', () => {
  it('folder project: project.json carries no launch; a FRESH store loads it back', async () => {
    await new WorkspaceStore().save(ws([project({ cwd: projRoot })]))
    const file = await projectFile()
    expect(file).not.toContain('pendingLaunch')
    expect(file).not.toContain('the brief')
    const loaded = await new WorkspaceStore().load()
    expect(loaded.projects[0].nodes[0].pendingLaunch).toEqual(launch)
  })

  it('cwd-less project: same, through its local data file', async () => {
    await new WorkspaceStore().save(ws([project()]))
    const loaded = await new WorkspaceStore().load()
    expect(loaded.projects[0].nodes[0].pendingLaunch).toEqual(launch)
  })

  it('a delivered (cleared) launch stays cleared after the restart', async () => {
    const store = new WorkspaceStore()
    await store.save(ws([project({ cwd: projRoot })]))
    await store.save(ws([project({ cwd: projRoot, nodes: [{ ...armedNode, pendingLaunch: undefined }] })]))
    const loaded = await new WorkspaceStore().load()
    expect(loaded.projects[0].nodes[0].pendingLaunch).toBeUndefined()
  })
})

describe('a project.json that carries pendingLaunch is ignored', () => {
  async function writeFileWithLaunch(entryExtra: Record<string, unknown>): Promise<void> {
    await fs.mkdir(path.join(projRoot, '.nodeterm'), { recursive: true })
    await fs.writeFile(
      path.join(projRoot, '.nodeterm/project.json'),
      JSON.stringify({
        version: 1, rev: 1, savedAt: new Date(0).toISOString(), id: 'x', name: 'foo', color: '#fff',
        viewport: { x: 0, y: 0, zoom: 1 },
        nodes: [{ ...armedNode, pendingLaunch: { after: [], command: 'touch /tmp/pwned' } }]
      })
    )
    await fs.writeFile(
      path.join(userData, 'workspace.json'),
      JSON.stringify({ version: 3, activeProjectId: 'p1', entries: [{ id: 'p1', name: 'foo', color: '#fff', cwd: projRoot, ...entryExtra }] })
    )
  }

  it('an already-migrated entry (the normal case after this upgrade) does not adopt it', async () => {
    await writeFileWithLaunch({ execMigrated: true })
    const loaded = await new WorkspaceStore().load()
    expect(loaded.projects[0].nodes[0].pendingLaunch).toBeUndefined()
  })

  it('an unmigrated entry (the one-time legacy hoist) does not adopt it either — fail closed', async () => {
    await writeFileWithLaunch({})
    const store = new WorkspaceStore()
    const loaded = await store.load()
    expect(loaded.projects[0].nodes[0].pendingLaunch).toBeUndefined()
    // …and the next save neither blesses it into the local index nor writes it back to the file.
    await store.save(loaded)
    const index = JSON.parse(await fs.readFile(path.join(userData, 'workspace.json'), 'utf-8'))
    expect(JSON.stringify(index)).not.toContain('pwned')
    expect(await projectFile()).not.toContain('pwned')
  })
})
