import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Project } from '@shared/types'
import { OWNERSHIP_EXEMPT, OWNERSHIP_GUARDED, useProjects } from './projects'
import { setPopoutProjectIdForTests, useWindows } from './windows'

// PR #804 review, blocking 1: the main window could still rename, close and END THE SESSIONS of a
// popped-out project from the sessions sidebar and the Omni Kanban lanes. Every one of those
// surfaces writes through this store, so the refusal lives here and a surface nobody gated fails
// closed.

const project = (id: string): Project => ({
  id,
  name: id,
  color: '#7aa2f7',
  viewport: { x: 0, y: 0, zoom: 1 },
  nodes: [
    { id: `${id}-t`, kind: 'terminal', position: { x: 0, y: 0 }, size: { width: 1, height: 1 }, title: 't', color: '#fff', group: null }
  ]
})

beforeEach(() => {
  setPopoutProjectIdForTests(null)
  useWindows.getState().setDetached([])
  useProjects.getState().hydrate({ version: 2, activeProjectId: 'a', projects: [project('a'), project('b')] })
})
afterEach(() => {
  setPopoutProjectIdForTests(null)
  useWindows.getState().setDetached([])
})

describe('project ownership guard (pop-out windows)', () => {
  it('the main window cannot edit, close or delete a popped-out project', () => {
    useWindows.getState().setDetached(['b'])
    const s = useProjects.getState()
    s.renameProject('b', 'renamed-in-main')
    s.setProjectColor('b', '#000')
    s.setProjectCwd('b', '/tmp/x')
    s.removeNode('b', 'b-t')
    s.renameNode('b', 'b-t', 'x')
    expect(s.applyNodeMutation('b', { op: 'remove', ids: ['b-t'] } as never)).toBe(false)
    expect(s.closeProject('b')).toBe('a')
    expect(s.deleteProject('b')).toBe('a')
    const b = useProjects.getState().getProject('b')!
    expect(b.name).toBe('b')
    expect(b.color).toBe('#7aa2f7')
    expect(b.cwd).toBeUndefined()
    expect(b.closed).toBeUndefined()
    expect(b.nodes.map((n) => [n.id, n.title])).toEqual([['b-t', 't']])
  })

  it('the owner\'s save still refreshes the main window\'s mirror', () => {
    useWindows.getState().setDetached(['b'])
    useProjects.getState().replaceProject({ ...project('b'), name: 'B-from-popout' })
    expect(useProjects.getState().getProject('b')?.name).toBe('B-from-popout')
  })

  it('projects this window owns are untouched by the guard', () => {
    useWindows.getState().setDetached(['b'])
    useProjects.getState().renameProject('a', 'A2')
    expect(useProjects.getState().getProject('a')?.name).toBe('A2')
    useWindows.getState().setDetached([])
    useProjects.getState().renameProject('b', 'B2')
    expect(useProjects.getState().getProject('b')?.name).toBe('B2')
  })

  it('a pop-out writes only its own project', () => {
    setPopoutProjectIdForTests('b')
    useProjects.getState().renameProject('a', 'nope')
    useProjects.getState().renameProject('b', 'yes')
    expect(useProjects.getState().getProject('a')?.name).toBe('a')
    expect(useProjects.getState().getProject('b')?.name).toBe('yes')
  })

  it('every store method is either guarded or exempt with a reason', () => {
    const methods = Object.entries(useProjects.getState())
      .filter(([, v]) => typeof v === 'function')
      .map(([k]) => k)
    const unclassified = methods.filter((m) => !(m in OWNERSHIP_GUARDED) && !(m in OWNERSHIP_EXEMPT))
    expect(unclassified).toEqual([])
    for (const m of Object.keys(OWNERSHIP_GUARDED)) expect(methods).toContain(m)
  })
})
