import { describe, expect, it, vi } from 'vitest'
import { createPrivatePaneScope } from './pane-adoption-scope'
describe('private project scope for human adoption', () => {
  const request = { nodeId: 'n1', projectId: 'private-original' }
  const base = () => ({ projects: () => [{ id: 'private-original', nodes: [{ id: 'n1', kind: 'terminal' }] }], privateProject: (id: string) => id === 'private-original' ? { cwd: '/private/original' } : null, isSshNode: () => false, realpath: (cwd: string) => cwd })
  it('requires the actual original private-index ID, not a project file claim or same folder', () => {
    const deps = base(), scope = createPrivatePaneScope(deps)
    expect(scope(request)).toEqual({ projectCwd: '/private/original' })
    expect(scope({ ...request, projectId: 'copied-shared-id' })).toBeNull()
    const foreign = { ...deps, privateProject: () => ({ cwd: '/private/original' }) }
    expect(createPrivatePaneScope(foreign)({ ...request, projectId: 'private-foreign' })).toBeNull()
  })
  it('rejects duplicate or foreign-project node claims and nonterminal nodes', () => {
    const deps = base()
    expect(createPrivatePaneScope({ ...deps, projects: () => [{ id: 'foreign', nodes: [{ id: 'n1', kind: 'terminal' }] }] })(request)).toBeNull()
    expect(createPrivatePaneScope({ ...deps, projects: () => [{ id: request.projectId, nodes: [{ id: 'n1', kind: 'terminal' }, { id: 'n1', kind: 'terminal' }] }] })(request)).toBeNull()
    expect(createPrivatePaneScope({ ...deps, projects: () => [{ id: request.projectId, nodes: [{ id: 'n1', kind: 'browser' }] }] })(request)).toBeNull()
  })
  it('refuses SSH and unknown index/path evidence without trying to infer it', () => {
    const deps = base(), realpath = vi.fn((cwd: string) => cwd)
    expect(createPrivatePaneScope({ ...deps, realpath, isSshNode: () => true })(request)).toBeNull()
    expect(createPrivatePaneScope({ ...deps, realpath, privateProject: () => ({ cwd: '/cache', ssh: {} }) })(request)).toBeNull()
    expect(realpath).not.toHaveBeenCalled()
    expect(createPrivatePaneScope({ ...deps, realpath: () => { throw new Error('unknown') } })(request)).toBeNull()
  })
})
