import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import { initPlatform, resetPlatformForTests } from './platform'
import { fakePlatform } from './platform-fake'
import { WorkspaceStore } from './workspace-store'

// `ropes` / `bridges` reach the renderer through three load seams that are not `fileToProject`'s
// alone: a folder project's file (fileToProject), an INLINE project stored verbatim in
// workspace.json, and a pre-v3 workspace.json that skips loadV3. Each owes `sanitizeLinks`, or a
// hand-edited `null` rope throws in the canvas's rope restore on project load.

let userData: string
let projRoot: string
const rope = (source: string, target: string) => ({ id: `ctrl-${source}-${target}`, source, target })
const HOSTILE = [null, 5, { id: 'x', source: {}, target: 'b' }, rope('a', 'b')]

beforeEach(async () => {
  userData = await fs.mkdtemp(path.join(os.tmpdir(), 'nt-ws-'))
  projRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'nt-proj-'))
  initPlatform(fakePlatform({ userDataDir: userData }))
})
afterEach(async () => {
  resetPlatformForTests()
  await fs.rm(userData, { recursive: true, force: true })
  await fs.rm(projRoot, { recursive: true, force: true })
})

const writeIndex = (index: unknown): Promise<void> =>
  fs.writeFile(path.join(userData, 'workspace.json'), JSON.stringify(index), 'utf-8')

describe('the canvas links are admitted on every load seam', () => {
  it('an inline (cwd-less) project stored verbatim in workspace.json', async () => {
    await writeIndex({
      version: 3,
      activeProjectId: 'p1',
      entries: [{
        id: 'p1', name: 'foo', color: '#7aa2f7',
        project: {
          id: 'p1', name: 'foo', color: '#7aa2f7', viewport: { x: 0, y: 0, zoom: 1 }, nodes: [],
          ropes: HOSTILE, bridges: 'not a list'
        }
      }]
    })
    const loaded = await new WorkspaceStore().load()
    expect(loaded.projects[0].ropes).toEqual([rope('a', 'b')])
    expect(loaded.projects[0].bridges).toBeUndefined()
  })

  it('a legacy (v2) workspace.json, which skips loadV3', async () => {
    await writeIndex({
      version: 2,
      activeProjectId: 'p1',
      projects: [{
        id: 'p1', name: 'foo', color: '#7aa2f7', viewport: { x: 0, y: 0, zoom: 1 }, nodes: [],
        ropes: HOSTILE, bridges: [rope('a', 'b')]
      }]
    })
    const loaded = await new WorkspaceStore().load()
    expect(loaded.projects[0].ropes).toEqual([rope('a', 'b')])
    expect(loaded.projects[0].bridges).toEqual([rope('a', 'b')])
  })

  it("a folder project's git-shared project.json", async () => {
    await fs.mkdir(path.join(projRoot, '.nodeterm'), { recursive: true })
    await fs.writeFile(
      path.join(projRoot, '.nodeterm', 'project.json'),
      JSON.stringify({
        version: 1, rev: 3, savedAt: '2026-09-29T00:00:00.000Z', id: 'legacy', name: 'foo',
        color: '#7aa2f7', viewport: { x: 0, y: 0, zoom: 1 }, nodes: [], ropes: HOSTILE
      }),
      'utf-8'
    )
    await writeIndex({
      version: 3,
      activeProjectId: 'p1',
      entries: [{ id: 'p1', name: 'foo', color: '#7aa2f7', cwd: projRoot }]
    })
    const loaded = await new WorkspaceStore().load()
    expect(loaded.projects[0].ropes).toEqual([rope('a', 'b')])
  })

  it('persistedCanvases hands the context-link map only readable bridges (inline and folder legs)', async () => {
    await fs.mkdir(path.join(projRoot, '.nodeterm'), { recursive: true })
    await fs.writeFile(
      path.join(projRoot, '.nodeterm', 'project.json'),
      JSON.stringify({
        version: 1, rev: 3, savedAt: '2026-09-29T00:00:00.000Z', id: 'legacy', name: 'bar',
        color: '#7aa2f7', viewport: { x: 0, y: 0, zoom: 1 }, nodes: [], bridges: HOSTILE
      }),
      'utf-8'
    )
    await writeIndex({
      version: 3,
      activeProjectId: 'p1',
      entries: [
        {
          id: 'p1', name: 'foo', color: '#7aa2f7',
          project: {
            id: 'p1', name: 'foo', color: '#7aa2f7', viewport: { x: 0, y: 0, zoom: 1 }, nodes: [],
            bridges: HOSTILE
          }
        },
        { id: 'p2', name: 'bar', color: '#7aa2f7', cwd: projRoot }
      ]
    })
    const store = new WorkspaceStore()
    await store.load()
    const canvases = store.persistedCanvases()
    expect(canvases.map((c) => c.id)).toEqual(['p1', 'p2'])
    for (const c of canvases) expect(c.bridges).toEqual([rope('a', 'b')])
  })

  it('persistedCanvases hands the station-notice recipient rule only readable ropes', async () => {
    // `stationRecipient` reads each rope's source/target; a hand-edited `null` would throw there.
    await fs.mkdir(path.join(projRoot, '.nodeterm'), { recursive: true })
    await fs.writeFile(
      path.join(projRoot, '.nodeterm', 'project.json'),
      JSON.stringify({
        version: 1, rev: 3, savedAt: '2026-09-29T00:00:00.000Z', id: 'legacy', name: 'bar',
        color: '#7aa2f7', viewport: { x: 0, y: 0, zoom: 1 }, nodes: [], ropes: HOSTILE
      }),
      'utf-8'
    )
    await writeIndex({
      version: 3,
      activeProjectId: 'p1',
      entries: [
        {
          id: 'p1', name: 'foo', color: '#7aa2f7',
          project: {
            id: 'p1', name: 'foo', color: '#7aa2f7', viewport: { x: 0, y: 0, zoom: 1 }, nodes: [],
            ropes: HOSTILE
          }
        },
        { id: 'p2', name: 'bar', color: '#7aa2f7', cwd: projRoot }
      ]
    })
    const store = new WorkspaceStore()
    await store.load()
    // Read the RAW index/file legs, not an admitted project (see persistedCanvases' own comment).
    for (const c of store.persistedCanvases()) expect(c.ropes).toEqual([rope('a', 'b')])
  })
})
