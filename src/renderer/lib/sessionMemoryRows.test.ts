import { describe, it, expect } from 'vitest'
import { resolveSessionRows, totalMb } from './sessionMemoryRows'
import type { SessionMemoryRow } from '@shared/types'

const row = (nodeId: string, mb: number): SessionMemoryRow => ({
  session: `nt-${nodeId}`,
  nodeId,
  panePid: 1,
  selfMb: mb,
  childrenMb: 0,
  childCount: 0,
  totalMb: mb,
  command: 'claude'
})

const project = (id: string, name: string, nodeIds: string[], closed = false): any => ({
  id,
  name,
  color: '#fff',
  viewport: { x: 0, y: 0, zoom: 1 },
  closed,
  nodes: nodeIds.map((n) => ({ id: n, kind: 'terminal', title: `T ${n}`, position: { x: 0, y: 0 } }))
})

describe('resolveSessionRows', () => {
  it('resolves a node title and project name from the OPEN project', () => {
    const [v] = resolveSessionRows([row('a', 100)], [project('p1', 'Web', ['a'])], { a: 'working' })
    expect(v).toMatchObject({ title: 'T a', projectId: 'p1', projectName: 'Web', orphan: false, state: 'working' })
  })

  it('resolves across ALL projects, not just the active one', () => {
    const [v] = resolveSessionRows(
      [row('b', 100)],
      [project('p1', 'Web', ['a']), project('p2', 'API', ['b'])],
      {}
    )
    expect(v).toMatchObject({ projectId: 'p2', projectName: 'API', orphan: false })
  })

  it('a CLOSED project is not an orphan — its nodes are still on disk', () => {
    // closeProject keeps the project and its nodes; calling these orphans would invite the user to
    // kill sessions they deliberately parked.
    const [v] = resolveSessionRows([row('c', 100)], [project('p3', 'Old', ['c'], true)], {})
    expect(v.orphan).toBe(false)
    expect(v.projectName).toBe('Old')
  })

  it('marks a session with no node on any canvas as an orphan with no state', () => {
    const [v] = resolveSessionRows([row('ghost', 100)], [project('p1', 'Web', ['a'])], {
      ghost: 'working'
    })
    expect(v).toMatchObject({ orphan: true, projectId: null, projectName: null, state: null })
    expect(v.title).toContain('ghost')
  })

  it('preserves core ordering (already sorted by size)', () => {
    const vs = resolveSessionRows([row('big', 900), row('small', 10)], [], {})
    expect(vs.map((v) => v.row.nodeId)).toEqual(['big', 'small'])
  })
})

describe('totalMb', () => {
  it('sums every row', () => {
    expect(totalMb(resolveSessionRows([row('a', 100), row('b', 250)], [], {}))).toBe(350)
  })

  it('sums the row TOTAL, not just the pane process', () => {
    // childCount counts every descendant of the pane — the agent CLI plus anything it spawned —
    // and their memory lives in childrenMb, so a header that summed selfMb would under-report by
    // most of the session. The other fixtures have no children, so only this one pins the field.
    const withChildren: SessionMemoryRow = {
      ...row('a', 100),
      childrenMb: 400,
      childCount: 3,
      totalMb: 500
    }
    expect(totalMb(resolveSessionRows([withChildren], [], {}))).toBe(500)
  })
})
