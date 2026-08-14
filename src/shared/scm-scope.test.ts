import { describe, it, expect } from 'vitest'
import { boundGroups, scmScopes, defaultScmScope, selectedScmGroupId, type ScmScopeNode } from './scm-scope'
import type { BoundGroup } from './worktree-reconcile'

const project = { cwd: '/repo', name: 'nodeterm' }
const bound = (groupId: string, branch: string, path: string): BoundGroup => ({
  groupId,
  worktree: { repoPath: '/repo', branch, baseRef: 'main', path, createdByApp: true }
})

const groupNode = (id: string, wt?: { branch: string; path: string }): ScmScopeNode => ({
  id,
  type: 'group',
  data: wt ? { worktree: bound(id, wt.branch, wt.path).worktree } : {}
})
const termNode = (id: string, parentId?: string): ScmScopeNode => ({ id, type: 'terminal', parentId, data: {} })
const select = (n: ScmScopeNode): ScmScopeNode => ({ ...n, selected: true })

describe('boundGroups', () => {
  it('keeps only group nodes with a worktree, in canvas order', () => {
    const nodes = [
      termNode('t1'),
      groupNode('g1', { branch: 'feat', path: '/wt/feat' }),
      groupNode('g2'), // unbound group
      groupNode('g3', { branch: 'fix', path: '/wt/fix' })
    ]
    expect(boundGroups(nodes).map((b) => b.groupId)).toEqual(['g1', 'g3'])
    expect(boundGroups(nodes)[0].worktree.path).toBe('/wt/feat')
  })
})

describe('scmScopes', () => {
  it('always puts the main checkout first', () => {
    const scopes = scmScopes(project, [bound('g1', 'feat', '/wt/feat')])
    expect(scopes[0]).toEqual({ id: 'main', label: 'nodeterm (main checkout)', cwd: '/repo' })
  })

  it('adds one scope per bound worktree, keyed by group id', () => {
    const scopes = scmScopes(project, [bound('g1', 'feat', '/wt/feat')])
    expect(scopes[1]).toEqual({ id: 'g1', label: 'feat (worktree)', cwd: '/wt/feat' })
  })

  it('returns nothing when the project has no cwd', () => {
    expect(scmScopes({ name: 'x' }, [])).toEqual([])
  })
})

describe('selectedScmGroupId', () => {
  const g1 = groupNode('g1', { branch: 'feat', path: '/wt/feat' })

  it('picks a selected group itself', () => {
    expect(selectedScmGroupId([select(g1), termNode('t1')])).toBe('g1')
  })

  it('picks the parent group of a selected child', () => {
    expect(selectedScmGroupId([g1, select(termNode('t1', 'g1'))])).toBe('g1')
  })

  it('inherits a bound Source Control scope through nested unbound groups', () => {
    const inner = { ...groupNode('inner'), parentId: 'g1' }
    expect(selectedScmGroupId([g1, inner, select(termNode('t1', 'inner'))])).toBe('g1')
    expect(selectedScmGroupId([g1, select(inner)])).toBe('g1')
  })

  it('returns null for a selected ungrouped node', () => {
    expect(selectedScmGroupId([g1, select(termNode('t1'))])).toBeNull()
  })

  it('returns null with no selection', () => {
    expect(selectedScmGroupId([g1, termNode('t1', 'g1')])).toBeNull()
  })

  // Box-select spanning a bound group and an unrelated grouped node: the bound group wins by
  // intent, regardless of which node comes first in the nodes array.
  it('prefers a bound group over another candidate, whatever the array order', () => {
    const g2 = groupNode('g2') // unbound group
    const spanning = [select(termNode('t2', 'g2')), select(g1)]
    expect(selectedScmGroupId(spanning)).toBe('g1')
    expect(selectedScmGroupId([g2, ...spanning.reverse()])).toBe('g1')
  })

  it('falls back to the first candidate when none is bound', () => {
    const g2 = groupNode('g2')
    const g3 = groupNode('g3')
    expect(selectedScmGroupId([select(g2), select(g3)])).toBe('g2')
  })
})

describe('defaultScmScope', () => {
  const scopes = scmScopes(project, [bound('g1', 'feat', '/wt/feat'), bound('g2', 'fix', '/wt/fix')])

  it('picks the scope of the selected group', () => {
    expect(defaultScmScope(scopes, 'g2')?.cwd).toBe('/wt/fix')
  })

  it('falls back to the main checkout with no selection', () => {
    expect(defaultScmScope(scopes, null)?.id).toBe('main')
  })

  // A selected group that is not bound is not an error — it just means "main checkout".
  it('falls back to the main checkout when the selected group has no worktree', () => {
    expect(defaultScmScope(scopes, 'g-unbound')?.id).toBe('main')
  })

  // The panel keeps its own active scope id: if that group is unbound or deleted while the panel
  // is open, the scope list loses it and the panel must land back on the main checkout rather than
  // pointing at a checkout that no longer exists.
  it('falls back to the main checkout when the active scope disappears (unbound/deleted group)', () => {
    const after = scmScopes(project, [bound('g1', 'feat', '/wt/feat')]) // g2 unbound while open
    expect(after.find((s) => s.id === 'g2')).toBeUndefined()
    expect(defaultScmScope(after, 'g2')?.id).toBe('main')
    expect(defaultScmScope(after, 'g2')?.cwd).toBe('/repo')
  })
})
