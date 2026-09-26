// The relay-guest scope jail's classifier. What these pin:
//   - every project-naming channel we serve today is classified AND has its projectId read, so the
//     refactor from per-feature switches changed no existing decision;
//   - a method inside a scoped class with NO table row fails CLOSED on a scoped session (the old
//     `default: not project-scoped` arm waved it through);
//   - the phone dialect's board verbs, `projects.editCardLabels` included, are judged by the shared
//     project should they ever arrive on this tunnel;
//   - an unscoped session is never affected, and unrelated methods are never classified.
import { describe, expect, it } from 'vitest'
import { IPC } from '../../shared/ipc'
import { outOfProjectScope, projectScopeOf, PROJECT_SCOPED_PREFIXES } from './relay-project-scope'

describe('projectScopeOf', () => {
  it.each([
    [IPC.githubIssuesSubscribe, [{ projectId: 'p1' }]],
    [IPC.githubIssuesQuery, [{ projectId: 'p1' }]],
    [IPC.githubIssuesLookup, [{ projectId: 'p1', number: 1 }]],
    [IPC.githubIssuesSearch, [{ projectId: 'p1', search: 'x' }]],
    [IPC.githubIssuesMove, [{ projectId: 'p1' }]],
    [IPC.githubIssuesRefresh, ['p1', true]],
    [IPC.githubIssuesCreateLabels, ['p1']],
    [IPC.githubIssuesClearCache, ['p1']],
    [IPC.githubIssuesUnsubscribe, ['p1']],
    [IPC.boardLogAppend, ['p1', {}]],
    [IPC.boardLogRead, ['p1']],
    [IPC.boardLogSubscribe, ['p1']],
    [IPC.boardLogUnsubscribe, ['p1']],
    ['projects.ensureBoard', [{ projectId: 'p1' }]],
    ['projects.setCardColumn', [{ projectId: 'p1', nodeId: 'n', columnId: null }]],
    ['projects.editCardLabels', [{ projectId: 'p1', nodeId: 'n', add: ['l'] }]]
  ])('reads the projectId of %s', (method, args) => {
    expect(projectScopeOf(method, args)).toEqual({ scoped: true, projectId: 'p1' })
  })

  it('every IPC channel in a scoped class has a table row (no silent fail-closed of a live verb)', () => {
    const live = (Object.values(IPC) as unknown[]).filter(
      (v): v is string => typeof v === 'string' && PROJECT_SCOPED_PREFIXES.some((p) => v.startsWith(p))
    )
    expect(live.length).toBeGreaterThan(0)
    for (const method of live) {
      expect(projectScopeOf(method, ['p1']).projectId ?? projectScopeOf(method, [{ projectId: 'p1' }]).projectId, method)
        .toBe('p1')
    }
  })

  it('leaves unrelated methods unclassified', () => {
    expect(projectScopeOf(IPC.gitStatus, ['/w'])).toEqual({ scoped: false, projectId: undefined })
    expect(projectScopeOf(IPC.workspaceLoad, [])).toEqual({ scoped: false, projectId: undefined })
  })
})

describe('outOfProjectScope', () => {
  it('refuses another project and permits the shared one', () => {
    expect(outOfProjectScope('p1', 'projects.editCardLabels', [{ projectId: 'p2' }])).toBe(true)
    expect(outOfProjectScope('p1', 'projects.editCardLabels', [{ projectId: 'p1' }])).toBe(false)
  })

  it('fails CLOSED for an unlisted method in a scoped class, even naming the shared project', () => {
    expect(outOfProjectScope('p1', 'githubIssues:delete-everything', ['p1'])).toBe(true)
    expect(outOfProjectScope('p1', 'board-log:truncate', ['p1'])).toBe(true)
    expect(outOfProjectScope('p1', 'projects.deleteLabel', [{ projectId: 'p1' }])).toBe(true)
  })

  it('refuses a scoped method whose projectId is missing or not a string', () => {
    expect(outOfProjectScope('p1', 'projects.editCardLabels', [])).toBe(true)
    expect(outOfProjectScope('p1', IPC.boardLogRead, [{ projectId: 'p1' }])).toBe(true)
  })

  it('never affects an unscoped session', () => {
    expect(outOfProjectScope(undefined, 'githubIssues:delete-everything', ['p2'])).toBe(false)
    expect(outOfProjectScope(undefined, 'projects.editCardLabels', [{ projectId: 'p2' }])).toBe(false)
  })
})
