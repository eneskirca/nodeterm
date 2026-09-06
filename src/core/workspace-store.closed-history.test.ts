import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import { initPlatform, resetPlatformForTests } from './platform'
import { fakePlatform } from './platform-fake'
import { WorkspaceStore } from './workspace-store'
import { CLOSED_SESSIONS_CAP } from '../shared/types'
import type { ClosedSessionEntry, Project, Workspace } from '../shared/types'

let userData: string
let projRoot: string

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
  initPlatform(fakePlatform({ userDataDir: userData }))
})
afterEach(async () => {
  resetPlatformForTests()
  await fs.rm(userData, { recursive: true, force: true })
  await fs.rm(projRoot, { recursive: true, force: true })
})

/**
 * A pre-v3 (v2) workspace.json skips loadV3 entirely — `migrateLegacy` assembles it in memory and
 * the first save() is what actually migrates it to v3. Without its OWN sanitize pass, a malformed
 * `closedSessions` on a hand-edited legacy file reaches `mergeClosedHistory` (a `for...of` over a
 * non-array throws) on the very FIRST load, before any save ever runs.
 */
describe('a legacy (v2) workspace.json sanitizes closedSessions on migration', () => {
  it('drops a malformed closedSessions rather than crashing the sidebar render', async () => {
    await fs.writeFile(
      path.join(userData, 'workspace.json'),
      JSON.stringify({
        version: 2,
        activeProjectId: 'p1',
        projects: [{
          id: 'p1', name: 'foo', color: '#7aa2f7', viewport: { x: 0, y: 0, zoom: 1 }, nodes: [],
          closedSessions: { not: 'an array' }
        }]
      }),
      'utf-8'
    )
    const loaded = await new WorkspaceStore().load()
    expect(loaded.projects[0].closedSessions).toBeUndefined()
  })

  it('keeps a well-formed legacy closedSessions entry', async () => {
    await fs.writeFile(
      path.join(userData, 'workspace.json'),
      JSON.stringify({
        version: 2,
        activeProjectId: 'p1',
        projects: [{
          id: 'p1', name: 'foo', color: '#7aa2f7', viewport: { x: 0, y: 0, zoom: 1 }, nodes: [],
          closedSessions: [{
            id: 'e1', closedAt: 1, absolutePosition: { x: 0, y: 0 },
            node: { id: 'n1', kind: 'terminal', position: { x: 0, y: 0 }, size: { width: 1, height: 1 }, title: 't', color: '#fff', group: null }
          }]
        }]
      }),
      'utf-8'
    )
    const loaded = await new WorkspaceStore().load()
    expect(loaded.projects[0].closedSessions).toHaveLength(1)
    expect(loaded.projects[0].closedSessions?.[0].id).toBe('e1')
  })
})

describe('closedAt round trip (machine-local index)', () => {
  it('persists closedAt on the index entry and never on the shared project file', async () => {
    const store = new WorkspaceStore()
    await store.save(ws([project({ cwd: projRoot, closed: true, closedAt: 12345 })]))

    const index = JSON.parse(await fs.readFile(path.join(userData, 'workspace.json'), 'utf-8'))
    expect(index.entries[0].closed).toBe(true)
    expect(index.entries[0].closedAt).toBe(12345)

    const file = JSON.parse(await fs.readFile(path.join(projRoot, '.nodeterm/project.json'), 'utf-8'))
    expect(file.closedAt).toBeUndefined()

    const loaded = await store.load()
    expect(loaded.projects[0].closed).toBe(true)
    expect(loaded.projects[0].closedAt).toBe(12345)
  })

  it('omits closedAt from the index when the project was never closed', async () => {
    const store = new WorkspaceStore()
    await store.save(ws([project({ cwd: projRoot })]))
    const index = JSON.parse(await fs.readFile(path.join(userData, 'workspace.json'), 'utf-8'))
    expect(index.entries[0].closedAt).toBeUndefined()
  })
})

/**
 * The maintainer's own storage-move requirement (PR #510 review): closed-session history is a
 * per-machine fact, like `viewport`/`breadcrumbs` — a REF'D (cwd) project's history must live in
 * the machine-local `workspace.json` index entry, never in the git-shared `.nodeterm/project.json`
 * a teammate would also see. This is the round trip nothing else exercises end-to-end: every other
 * test covers one layer (`projectToFile`/`fileToProject` in isolation, or the inline-project path,
 * which is ALREADY machine-local by construction and so proves nothing about this move).
 */
describe('a ref\'d project\'s closedSessions rides the machine-local index, never the shared file', () => {
  const entry = (id: string, closedAt: number): ClosedSessionEntry => ({
    id, closedAt,
    node: { id: 'term-1', kind: 'terminal', position: { x: 0, y: 0 }, size: { width: 1, height: 1 }, title: 't', color: '#fff', group: null },
    absolutePosition: { x: 0, y: 0 }
  })

  it('lands in workspace.json but never in .nodeterm/project.json, and survives a reload', async () => {
    const store = new WorkspaceStore()
    await store.save(ws([project({ cwd: projRoot, closedSessions: [entry('e1', 1), entry('e2', 2)] })]))

    const index = JSON.parse(await fs.readFile(path.join(userData, 'workspace.json'), 'utf-8'))
    expect(index.entries[0].closedSessions?.map((e: { id: string }) => e.id)).toEqual(['e1', 'e2'])

    const file = JSON.parse(await fs.readFile(path.join(projRoot, '.nodeterm/project.json'), 'utf-8'))
    expect(file.closedSessions).toBeUndefined()
    expect(JSON.stringify(file)).not.toContain('closedSessions')

    // A fresh store instance, so this is a genuine reload off disk, not the same in-memory index.
    const loaded = await new WorkspaceStore().load()
    expect(loaded.projects[0].closedSessions?.map((e) => e.id)).toEqual(['e1', 'e2'])
  })

  it('survives an unavailable window (folder briefly unreadable) via the old-entry restore', async () => {
    const store = new WorkspaceStore()
    await store.save(ws([project({ cwd: projRoot, closedSessions: [entry('e1', 1)] })]))

    // The folder becomes unreadable — save() must not let splitWorkspace's header-only placeholder
    // erase the machine-local history it can't currently see.
    await store.save(ws([project({ cwd: projRoot, unavailable: true })]))
    const index = JSON.parse(await fs.readFile(path.join(userData, 'workspace.json'), 'utf-8'))
    expect(index.entries[0].closedSessions?.map((e: { id: string }) => e.id)).toEqual(['e1'])
  })

  it('caps and re-sanitizes a hand-edited oversized/hostile index entry on load', async () => {
    await fs.writeFile(
      path.join(userData, 'workspace.json'),
      JSON.stringify({
        version: 3,
        activeProjectId: 'p1',
        entries: [{
          id: 'p1', name: 'foo', color: '#7aa2f7', cwd: projRoot,
          closedSessions: Array.from({ length: CLOSED_SESSIONS_CAP + 5 }, (_, i) => entry(`e${i}`, i))
        }]
      }),
      'utf-8'
    )
    await fs.mkdir(path.join(projRoot, '.nodeterm'), { recursive: true })
    await fs.writeFile(
      path.join(projRoot, '.nodeterm/project.json'),
      JSON.stringify({ version: 1, rev: 1, savedAt: 'now', name: 'foo', color: '#7aa2f7', nodes: [] }),
      'utf-8'
    )
    const loaded = await new WorkspaceStore().load()
    expect(loaded.projects[0].closedSessions).toHaveLength(CLOSED_SESSIONS_CAP)
    expect(loaded.projects[0].closedSessions?.[0].id).toBe('e0')
  })
})

/**
 * An INLINE (cwd-less) project is stored verbatim in workspace.json and never passes through
 * `fileToProject`, so it bypasses every guard that lives there. The branch already re-applies
 * `validKanban` and `sanitizeNodeTriggers` for exactly this reason ("workspace.json is
 * hand-editable input too") — `closedSessions` owes the same, or a malformed value reaches
 * `mergeClosedHistory`, which iterates it (a non-array throws and takes the sidebar render down)
 * and hands each node to React Flow.
 */
describe('inline (cwd-less) projects sanitize closedSessions on load', () => {
  const writeIndex = async (entries: unknown[]): Promise<void> => {
    await fs.writeFile(
      path.join(userData, 'workspace.json'),
      JSON.stringify({ version: 3, activeProjectId: 'p1', entries }),
      'utf-8'
    )
  }
  const inline = (closedSessions: unknown) => [
    {
      id: 'p1',
      name: 'foo',
      color: '#7aa2f7',
      project: {
        id: 'p1', name: 'foo', color: '#7aa2f7',
        viewport: { x: 0, y: 0, zoom: 1 }, nodes: [],
        closedSessions
      }
    }
  ]

  it('drops a non-array closedSessions rather than letting it reach the sidebar', async () => {
    await writeIndex(inline({ not: 'an array' }))
    const loaded = await new WorkspaceStore().load()
    expect(loaded.projects[0].closedSessions).toBeUndefined()
  })

  it('drops entries with no position data (the recreate-time crash shape)', async () => {
    await writeIndex(
      inline([
        {
          id: 'e1', closedAt: 1,
          node: { id: 'n1', kind: 'terminal', title: 't', color: '#fff', group: null }
        }
      ])
    )
    const loaded = await new WorkspaceStore().load()
    expect(loaded.projects[0].closedSessions).toBeUndefined()
  })

  it('keeps a well-formed entry but strips a trigger spec off its node, same as live nodes', async () => {
    await writeIndex(
      inline([
        {
          id: 'e1', closedAt: 1,
          absolutePosition: { x: 0, y: 0 },
          node: {
            id: 'n1', kind: 'terminal', position: { x: 0, y: 0 },
            size: { width: 1, height: 1 }, title: 't', color: '#fff', group: null,
            // A spec on a NON-trigger node — sanitizeNodeTriggers drops it outright.
            trigger: { kind: 'cron', expr: '* * * * *' }
          }
        }
      ])
    )
    const loaded = await new WorkspaceStore().load()
    expect(loaded.projects[0].closedSessions).toHaveLength(1)
    expect(loaded.projects[0].closedSessions?.[0].node.trigger).toBeUndefined()
    expect(loaded.projects[0].closedSessions?.[0].node.title).toBe('t')
  })

  it('caps an oversized inline history', async () => {
    await writeIndex(
      inline(
        Array.from({ length: CLOSED_SESSIONS_CAP + 5 }, (_, i) => ({
          id: `e${i}`, closedAt: i,
          absolutePosition: { x: 0, y: 0 },
          node: {
            id: `n${i}`, kind: 'terminal', position: { x: 0, y: 0 },
            size: { width: 1, height: 1 }, title: 't', color: '#fff', group: null
          }
        }))
      )
    )
    const loaded = await new WorkspaceStore().load()
    expect(loaded.projects[0].closedSessions).toHaveLength(CLOSED_SESSIONS_CAP)
  })
})
