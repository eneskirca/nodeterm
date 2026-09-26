import { describe, it, expect, beforeEach } from 'vitest'
import { useProjects } from './projects'
import type { Project } from '@shared/types'
import { PROJECT_NAME_MAX } from '@shared/project-name'

/**
 * Issue #338 Task 2.1 — `registerProject`, the NON-ACTIVATING create/find used by the
 * `open-project` control verb (spec §2.1 steps 2–4).
 *
 * The one property every test here re-asserts is spec P6: `registerProject` NEVER writes
 * `activeProjectId`. The human paths (`openFolderProject`/`adoptProject`/`reopenProject`) all
 * activate — deliberately untouched (Decision 4) — so the agent verb needs its own store action,
 * and the mutation this suite is checked against is exactly "reuse the activating path".
 */

beforeEach(() => {
  useProjects.getState().hydrate({ version: 2, activeProjectId: '', projects: [] })
})

const probed = (id: string): Project => ({
  id,
  name: 'shared-app',
  color: '#7aa2f7',
  cwd: '/Users/me/dev/shared-app',
  viewport: { x: 0, y: 0, zoom: 1 },
  nodes: [
    {
      id: 'term-a',
      kind: 'terminal' as const,
      position: { x: 0, y: 0 },
      size: { width: 1, height: 1 },
      title: 'a',
      color: '#fff',
      group: null
    }
  ]
})

describe('registerProject — idempotent hit (spec B1)', () => {
  it('returns the same project twice without duplicating, and never activates', () => {
    const active = useProjects.getState().addProject('elsewhere', '/tmp/elsewhere')
    useProjects.getState().setActive(active.id)

    const first = useProjects.getState().registerProject({ resolvedCwd: '/Users/me/dev/my-app' })
    expect(first.created).toBe(true)
    expect(first.adopted).toBe(false)
    const second = useProjects.getState().registerProject({ resolvedCwd: '/Users/me/dev/my-app' })
    expect(second.created).toBe(false)
    expect(second.adopted).toBe(false)
    expect(second.project.id).toBe(first.project.id)
    expect(useProjects.getState().projects.filter((p) => p.cwd === '/Users/me/dev/my-app')).toHaveLength(1)
    // P6 — the visible tab never moved.
    expect(useProjects.getState().activeProjectId).toBe(active.id)
  })

  it('dedupes on the trailing-slash-normalized cwd', () => {
    const first = useProjects.getState().registerProject({ resolvedCwd: '/Users/me/dev/my-app' })
    const second = useProjects.getState().registerProject({ resolvedCwd: '/Users/me/dev/my-app/' })
    expect(second.created).toBe(false)
    expect(second.project.id).toBe(first.project.id)
  })

  it('un-closes a closed project WITHOUT activating it', () => {
    const active = useProjects.getState().addProject('elsewhere', '/tmp/elsewhere')
    useProjects.getState().setActive(active.id)
    const closedOne = useProjects.getState().addProject('my-app', '/Users/me/dev/my-app')
    useProjects.getState().closeProject(closedOne.id)

    const hit = useProjects.getState().registerProject({ resolvedCwd: '/Users/me/dev/my-app' })
    expect(hit.created).toBe(false)
    expect(hit.project.id).toBe(closedOne.id)
    const s = useProjects.getState()
    // The tab is back (closed cleared)…
    expect(s.projects.find((p) => p.id === closedOne.id)?.closed).toBeFalsy()
    // …but the view did not travel (P6): reopenProject would have activated it.
    expect(s.activeProjectId).toBe(active.id)
  })

  it('an idempotent hit never mutates the existing name or color on the agent’s say-so', () => {
    const first = useProjects.getState().registerProject({ resolvedCwd: '/x/app', name: 'Real Name', color: '#123456' })
    const hit = useProjects
      .getState()
      .registerProject({ resolvedCwd: '/x/app', name: 'Impostor', color: '#ff0000' })
    expect(hit.created).toBe(false)
    expect(hit.project.name).toBe('Real Name')
    expect(hit.project.color).toBe('#123456')
    expect(first.project.id).toBe(hit.project.id)
  })
})

describe('registerProject — create (spec §2.1 step 4)', () => {
  it('creates with the given name and color, defaulting the name to the folder basename', () => {
    const named = useProjects.getState().registerProject({ resolvedCwd: '/a/b', name: 'Named', color: '#abcdef' })
    expect(named.created).toBe(true)
    expect(named.project.name).toBe('Named')
    expect(named.project.color).toBe('#abcdef')
    expect(named.project.cwd).toBe('/a/b')

    const unnamed = useProjects.getState().registerProject({ resolvedCwd: '/a/some-repo' })
    expect(unnamed.project.name).toBe('some-repo')
  })

  it('never activates the created project — activeProjectId is untouched in every branch', () => {
    const active = useProjects.getState().addProject('elsewhere', '/tmp/elsewhere')
    useProjects.getState().setActive(active.id)
    useProjects.getState().registerProject({ resolvedCwd: '/a/b' })
    expect(useProjects.getState().activeProjectId).toBe(active.id)
  })
})

describe('registerProject — adopt (spec §2.1 step 3)', () => {
  it('adopts a probed project keeping its minted id, without activating', () => {
    const active = useProjects.getState().addProject('elsewhere', '/tmp/elsewhere')
    useProjects.getState().setActive(active.id)

    const r = useProjects
      .getState()
      .registerProject({ resolvedCwd: '/Users/me/dev/shared-app', probed: probed('project-minted') })
    expect(r.adopted).toBe(true)
    expect(r.created).toBe(false)
    expect(r.project.id).toBe('project-minted')
    expect(r.project.nodes).toHaveLength(1)
    expect(useProjects.getState().activeProjectId).toBe(active.id)
  })

  it('defends against an id collision exactly as adoptProject does (derived id, nodes kept)', () => {
    const taken = useProjects.getState().addProject('other', '/tmp/other')
    const r = useProjects
      .getState()
      .registerProject({ resolvedCwd: '/Users/me/dev/shared-app', probed: probed(taken.id) })
    expect(r.adopted).toBe(true)
    expect(r.project.id).not.toBe(taken.id)
    expect(r.project.nodes.map((n) => n.id)).toEqual(['term-a'])
    // Both projects present, ids unique.
    const ids = useProjects.getState().projects.map((p) => p.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('registerProject — the name an agent passes (issue #940)', () => {
  it('cuts an over-long --name to PROJECT_NAME_MAX', () => {
    const long = 'x'.repeat(PROJECT_NAME_MAX * 5)
    const { project } = useProjects
      .getState()
      .registerProject({ resolvedCwd: '/Users/me/dev/long-name', name: long })
    expect(project.name).toBe('x'.repeat(PROJECT_NAME_MAX))
  })

  it('caps the folder name it falls back to when no --name is given', () => {
    const folder = 'f'.repeat(PROJECT_NAME_MAX + 20)
    const { project } = useProjects
      .getState()
      .registerProject({ resolvedCwd: `/Users/me/dev/${folder}` })
    expect(project.name).toBe('f'.repeat(PROJECT_NAME_MAX))
  })

  it('falls back to the folder name for a blank --name', () => {
    const { project } = useProjects
      .getState()
      .registerProject({ resolvedCwd: '/Users/me/dev/blank-name', name: '   ' })
    expect(project.name).toBe('blank-name')
  })
})
