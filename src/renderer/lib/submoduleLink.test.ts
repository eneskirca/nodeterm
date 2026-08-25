import { describe, it, expect } from 'vitest'
import { planSubmoduleLinks, existingDependencyLinkKeys, type RefGroup, type OpenProjectByCwd } from './submoduleLink'
import type { SubmoduleEntry } from '@shared/worktree'

const sub = (path: string, sha = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0'): SubmoduleEntry => ({ path, sha })

describe('planSubmoduleLinks', () => {
  const refGroup: RefGroup = { groupId: 'g-parent', projectId: 'proj-parent' }

  it('draws a dependency link from the submodule group to the referencing group for an OPEN submodule', () => {
    const openProjects: OpenProjectByCwd[] = [{ cwd: '/repo/vendor/lib', projectId: 'proj-sub' }]
    const existingGroup = new Map([['proj-sub', 'g-sub']])
    const plan = planSubmoduleLinks(refGroup, '/repo', [sub('vendor/lib')], openProjects, existingGroup, new Set())
    expect(plan.links).toHaveLength(1)
    expect(plan.links[0].kind).toBe('dependency')
    expect(plan.links[0].source).toEqual({ ref: 'node', nodeId: 'g-sub' })
    expect(plan.links[0].target).toEqual({ ref: 'node', nodeId: 'g-parent' })
    expect(plan.links[0].id).toBe('dep-g-sub-g-parent')
    expect(plan.groupsToCreate).toEqual([])
  })

  it('joins the relative submodule path against the repo root to match a cwd', () => {
    const openProjects: OpenProjectByCwd[] = [{ cwd: '/repo/outer/inner', projectId: 'proj-inner' }]
    const existingGroup = new Map([['proj-inner', 'g-inner']])
    const plan = planSubmoduleLinks(refGroup, '/repo', [sub('outer/inner')], openProjects, existingGroup, new Set())
    expect(plan.links).toHaveLength(1)
  })

  it('tolerates a trailing slash on the repo root when joining the path', () => {
    const openProjects: OpenProjectByCwd[] = [{ cwd: '/repo/vendor/lib', projectId: 'proj-sub' }]
    const existingGroup = new Map([['proj-sub', 'g-sub']])
    const plan = planSubmoduleLinks(refGroup, '/repo/', [sub('vendor/lib')], openProjects, existingGroup, new Set())
    expect(plan.links).toHaveLength(1)
  })

  it('skips an unopened submodule (no matching cwd) — no link, no group to create', () => {
    const plan = planSubmoduleLinks(refGroup, '/repo', [sub('vendor/lib')], [], new Map(), new Set())
    expect(plan.links).toEqual([])
    expect(plan.groupsToCreate).toEqual([])
  })

  it('requests a new projectRef group when the submodule project has no group yet (and adds NO link — never a dangling edge)', () => {
    const openProjects: OpenProjectByCwd[] = [{ cwd: '/repo/vendor/lib', projectId: 'proj-sub' }]
    // No existing group for proj-sub:
    const plan = planSubmoduleLinks(refGroup, '/repo', [sub('vendor/lib')], openProjects, new Map(), new Set())
    expect(plan.links).toEqual([]) // deferred to the next run once the group exists
    expect(plan.groupsToCreate).toEqual([{ projectId: 'proj-sub', color: undefined }])
  })

  it('is idempotent: a dependency link already present is not re-added', () => {
    const openProjects: OpenProjectByCwd[] = [{ cwd: '/repo/vendor/lib', projectId: 'proj-sub' }]
    const existingGroup = new Map([['proj-sub', 'g-sub']])
    const existing = new Set(['dep-g-sub-g-parent'])
    const plan = planSubmoduleLinks(refGroup, '/repo', [sub('vendor/lib')], openProjects, existingGroup, existing)
    expect(plan.links).toEqual([])
  })

  it('handles multiple submodules, some open and some not', () => {
    const openProjects: OpenProjectByCwd[] = [
      { cwd: '/repo/vendor/lib', projectId: 'proj-lib' },
      { cwd: '/repo/vendor/other', projectId: 'proj-other' }
    ]
    const existingGroup = new Map([
      ['proj-lib', 'g-lib'],
      ['proj-other', 'g-other']
    ])
    const plan = planSubmoduleLinks(
      refGroup,
      '/repo',
      [sub('vendor/lib'), sub('vendor/other'), sub('vendor/closed')],
      openProjects,
      existingGroup,
      new Set()
    )
    expect(plan.links).toHaveLength(2)
    expect(plan.links.map((l) => l.id).sort()).toEqual(['dep-g-lib-g-parent', 'dep-g-other-g-parent'])
  })
})

describe('existingDependencyLinkKeys', () => {
  it('collects only dependency-link ids', () => {
    const links = [
      { id: 'dep-a-b', kind: 'dependency', source: { ref: 'node', nodeId: 'a' }, target: { ref: 'node', nodeId: 'b' } },
      { id: 'bridge-c-d', kind: 'context', source: { ref: 'node', nodeId: 'c' }, target: { ref: 'node', nodeId: 'd' } },
      { id: 'ctrl-e-f', kind: 'lineage', source: { ref: 'node', nodeId: 'e' }, target: { ref: 'node', nodeId: 'f' } }
    ] as const
    expect(existingDependencyLinkKeys(links as never)).toEqual(new Set(['dep-a-b']))
  })

  it('returns an empty set for undefined links', () => {
    expect(existingDependencyLinkKeys(undefined)).toEqual(new Set())
  })
})
