import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Project } from '@shared/types'

// The ids the canvas mints are tmux session names and persistence keys. `nextId` used a
// module-level `let idCounter = 0`, which restarted at zero on every renderer start AND on every
// HMR reload — `term-<ms36>-1` was minted over and over, and only millisecond resolution kept two
// nodes from co-attaching to one terminal. These tests pin the replacement.

/** Re-imports the module with a fresh module registry — a renderer restart / HMR reload. */
async function freshModule(): Promise<typeof import('./workspace')> {
  vi.resetModules()
  return import('./workspace')
}

const SAFE = /^[A-Za-z0-9._-]+$/

beforeEach(() => {
  vi.resetModules()
})

describe('minted node/project ids', () => {
  it('never repeats across a simulated module reload', async () => {
    // The clock is FROZEN, so the `Date.now()` segment cannot do the work: this pins the tail
    // itself. A module-level counter restarts at 0 on every reload and repeats immediately.
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_770_000_000_000)
    try {
      const seen = new Set<string>()
      for (let reload = 0; reload < 20; reload++) {
        const { createProject } = await freshModule()
        for (let i = 0; i < 25; i++) {
          const id = createProject(i).id
          expect(seen.has(id)).toBe(false)
          seen.add(id)
        }
      }
      expect(seen.size).toBe(500)
    } finally {
      now.mockRestore()
    }
  })

  it('stays inside the safe charset (tmux session names) and keeps its prefix', async () => {
    const { createProject } = await freshModule()
    for (let i = 0; i < 50; i++) {
      const id = createProject(i).id
      expect(id).toMatch(SAFE)
      expect(id.startsWith('project-')).toBe(true)
      expect(id.length).toBeLessThan(40)
    }
  })

  it('does not repeat within one tick (bulk duplicate / "spawn a team")', async () => {
    const { createProject } = await freshModule()
    const ids = Array.from({ length: 2000 }, (_, i) => createProject(i).id)
    expect(new Set(ids).size).toBe(2000)
  })

  // The relay's `projects.registerNode` guard (core/project-node-append `SAFE_NODE_ID`, whose twin
  // lives in nodeterm-ios) refuses anything outside this shape — a phone-registered session would
  // silently never appear. Pinned here as a literal because the renderer bundle may not import core.
  it('node ids keep the shape the relay id guard accepts', async () => {
    const { createTerminalNode } = await freshModule()
    for (let i = 0; i < 20; i++) {
      expect(createTerminalNode(i).id).toMatch(/^term-[a-z0-9]+-[a-z0-9]{1,16}$/)
    }
  })
})

describe('duplicateNode', () => {
  it('mints a fresh id for every copy, even in one tick', async () => {
    const { duplicateNode } = await freshModule()
    const node = {
      id: 'term-abc-1', type: 'terminal', position: { x: 0, y: 0 },
      data: {}
    } as unknown as import('./workspace').CanvasNode
    const ids = Array.from({ length: 200 }, () => duplicateNode(node).id)
    expect(new Set(ids).size).toBe(200)
    expect(ids.every((id) => SAFE.test(id))).toBe(true)
  })
})

// The consequence the ids exist to prevent: `commitCanvas` maps by id, so two projects under one
// id both receive the ACTIVE canvas — and the next save flushes it into the other folder's
// project.json. Cross-folder data loss, on every autosave.
describe('commitCanvas can never write one canvas into two projects', () => {
  const project = (over: Partial<Project>): Project => ({
    id: 'project-dup', name: 'p', color: '#fff', viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [], ...over
  })

  it('hydrate re-keys a duplicate, so a commit lands in exactly one project', async () => {
    const { useProjects } = await import('./projects')
    useProjects.getState().hydrate({
      version: 2,
      activeProjectId: 'project-dup',
      projects: [
        project({ cwd: '/root/nodeterm-ios', nodes: [{ id: 'term-a' } as never] }),
        project({ cwd: '/root/nodeterm-ios-keyux', nodes: [{ id: 'term-b' } as never] })
      ]
    })
    const ids = useProjects.getState().projects.map((p) => p.id)
    expect(new Set(ids).size).toBe(2)
    expect(ids[0]).toBe('project-dup') // first holder keeps it

    useProjects.getState().commitCanvas(ids[0], [{ id: 'term-new' } as never], { x: 1, y: 2, zoom: 3 })
    const [first, second] = useProjects.getState().projects
    expect(first.nodes.map((n) => n.id)).toEqual(['term-new'])
    // The OTHER folder's canvas is untouched — this is the data loss.
    expect(second.nodes.map((n) => n.id)).toEqual(['term-b'])
    expect(second.viewport).toEqual({ x: 0, y: 0, zoom: 1 })
    expect(second.cwd).toBe('/root/nodeterm-ios-keyux')
  })

  it('the re-key is deterministic — a re-hydrate of the same workspace gives the same ids', async () => {
    const { useProjects } = await import('./projects')
    const ws = {
      version: 2 as const,
      activeProjectId: 'project-dup',
      projects: [project({ cwd: '/a' }), project({ cwd: '/b' }), project({ cwd: '/c' })]
    }
    useProjects.getState().hydrate(ws)
    const first = useProjects.getState().projects.map((p) => p.id)
    useProjects.getState().hydrate(ws)
    expect(useProjects.getState().projects.map((p) => p.id)).toEqual(first)
    expect(new Set(first).size).toBe(3)
  })

  it('deleteProject removes exactly one of two once-colliding projects', async () => {
    const { useProjects } = await import('./projects')
    useProjects.getState().hydrate({
      version: 2,
      activeProjectId: 'project-dup',
      projects: [project({ cwd: '/a' }), project({ cwd: '/b' })]
    })
    const ids = useProjects.getState().projects.map((p) => p.id)
    useProjects.getState().deleteProject(ids[0])
    expect(useProjects.getState().projects.map((p) => p.id)).toEqual([ids[1]])
  })
})
