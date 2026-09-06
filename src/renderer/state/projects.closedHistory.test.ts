import { describe, it, expect } from 'vitest'
import { useProjects } from './projects'
import { CLOSED_SESSIONS_CAP } from '@shared/types'
import type { ClosedSessionEntry } from '@shared/types'

const entry = (id: string, closedAt = 1): ClosedSessionEntry => ({
  id, closedAt,
  node: { id: 'n1', kind: 'terminal', position: { x: 0, y: 0 }, size: { width: 1, height: 1 }, title: 't', color: '#fff', group: null },
  absolutePosition: { x: 0, y: 0 }
})

const setup = () => {
  useProjects.getState().hydrate({
    version: 2,
    activeProjectId: 'p1',
    projects: [{ id: 'p1', name: 'x', color: '#fff', viewport: { x: 0, y: 0, zoom: 1 }, nodes: [] }]
  })
}

describe('closeProject stamps closedAt', () => {
  it('sets closedAt alongside closed', () => {
    setup()
    const before = Date.now()
    useProjects.getState().closeProject('p1')
    const p = useProjects.getState().getProject('p1')
    expect(p?.closed).toBe(true)
    expect(p?.closedAt).toBeGreaterThanOrEqual(before)
  })
})

describe('recordClosedSessions', () => {
  it('prepends new entries newest-first and caps at 20', () => {
    setup()
    useProjects.getState().recordClosedSessions('p1', [entry('a')])
    useProjects.getState().recordClosedSessions('p1', [entry('b')])
    expect(useProjects.getState().getProject('p1')?.closedSessions?.map((e) => e.id)).toEqual(['b', 'a'])

    setup()
    const many = Array.from({ length: CLOSED_SESSIONS_CAP + 5 }, (_, i) => entry(`e${i}`))
    useProjects.getState().recordClosedSessions('p1', many)
    expect(useProjects.getState().getProject('p1')?.closedSessions).toHaveLength(
      CLOSED_SESSIONS_CAP
    )
  })

  it('is a no-op for an unknown project', () => {
    setup()
    useProjects.getState().recordClosedSessions('missing', [entry('a')])
    expect(useProjects.getState().getProject('missing')).toBeUndefined()
  })
})

describe('consumeClosedSession', () => {
  it('removes and returns the matching entry', () => {
    setup()
    useProjects.getState().recordClosedSessions('p1', [entry('a'), entry('b')])
    const found = useProjects.getState().consumeClosedSession('p1', 'a')
    expect(found?.id).toBe('a')
    expect(useProjects.getState().getProject('p1')?.closedSessions?.map((e) => e.id)).toEqual(['b'])
  })

  it('returns undefined for a missing id', () => {
    setup()
    useProjects.getState().recordClosedSessions('p1', [entry('a')])
    expect(useProjects.getState().consumeClosedSession('p1', 'nope')).toBeUndefined()
    expect(useProjects.getState().getProject('p1')?.closedSessions).toHaveLength(1)
  })
})

describe('discardClosedSession', () => {
  it('removes an entry without returning it', () => {
    setup()
    useProjects.getState().recordClosedSessions('p1', [entry('a'), entry('b')])
    useProjects.getState().discardClosedSession('p1', 'a')
    expect(useProjects.getState().getProject('p1')?.closedSessions?.map((e) => e.id)).toEqual(['b'])
  })
})
