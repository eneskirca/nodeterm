import { describe, it, expect } from 'vitest'
import { buildClosedSessionEntries, stateToReopenSnapshot, mergeClosedHistory } from './closedHistory'
import type { CanvasNode } from '@renderer/state/workspace'
import type { ClosedSessionEntry, Project } from '@shared/types'

const node = (over: Partial<CanvasNode> = {}): CanvasNode =>
  ({
    id: 'n1', type: 'terminal', position: { x: 5, y: 5 }, width: 400, height: 300,
    data: { title: 'shell', color: '#fff', group: null, cwd: '/tmp/x' },
    ...over
  }) as CanvasNode

describe('buildClosedSessionEntries', () => {
  it('builds one entry per deleted, restorable node', () => {
    const nodes = [node({ id: 'n1' }), node({ id: 'n2' })]
    const entries = buildClosedSessionEntries(new Set(['n1']), nodes, 999, (_nodeId) => 'fresh-id')
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ id: 'fresh-id', closedAt: 999 })
    expect(entries[0].node.id).toBe('n1')
    expect(entries[0].node.cwd).toBe('/tmp/x')
    expect(entries[0].absolutePosition).toEqual({ x: 5, y: 5 })
  })

  it('excludes group/subagent/loop nodes and the account-login node, same as snapshotNode', () => {
    const groupNode = node({ id: 'g1', type: 'group' })
    const loginNode = node({ id: 'login', data: { title: 'Claude login', color: '#fff', group: null, initialCommand: 'claude /login' } })
    const entries = buildClosedSessionEntries(new Set(['g1', 'login']), [groupNode, loginNode], 1, () => 'x')
    expect(entries).toHaveLength(0)
  })

  it('only builds entries for ids actually in deletedIds', () => {
    const nodes = [node({ id: 'n1' }), node({ id: 'n2' })]
    const entries = buildClosedSessionEntries(new Set(['n2']), nodes, 1, () => 'x')
    expect(entries.map((e) => e.node.id)).toEqual(['n2'])
  })

  it('hands makeId the SOURCE node id, not called bare — the correlation deleteNodes relies on', () => {
    const nodes = [node({ id: 'n1' }), node({ id: 'n2' })]
    const seen: string[] = []
    buildClosedSessionEntries(new Set(['n1', 'n2']), nodes, 1, (nodeId) => {
      seen.push(nodeId)
      return `id-for-${nodeId}`
    })
    expect(seen).toEqual(['n1', 'n2'])
  })
})

describe('stateToReopenSnapshot', () => {
  it('carries position/parent/size/data through for recreateNodeFromSnapshot', () => {
    const entry: ClosedSessionEntry = {
      id: 'e1', closedAt: 1,
      node: {
        id: 'n1', kind: 'terminal', position: { x: 1, y: 2 }, size: { width: 10, height: 20 },
        title: 'shell', color: '#fff', group: null, parentId: 'grp-1', cwd: '/tmp/x', agentId: 'claude'
      },
      absolutePosition: { x: 100, y: 200 }
    }
    const snap = stateToReopenSnapshot(entry)
    expect(snap.type).toBe('terminal')
    expect(snap.position).toEqual({ x: 1, y: 2 })
    expect(snap.absolutePosition).toEqual({ x: 100, y: 200 })
    expect(snap.parentId).toBe('grp-1')
    expect(snap.extent).toBe('parent')
    expect(snap.size).toEqual({ width: 10, height: 20 })
    expect(snap.data.cwd).toBe('/tmp/x')
    expect(snap.data.agentId).toBe('claude')
  })

  it('omits parentId/extent when the node was never parented', () => {
    const entry: ClosedSessionEntry = {
      id: 'e1', closedAt: 1,
      node: { id: 'n1', kind: 'sticky', position: { x: 0, y: 0 }, size: { width: 10, height: 10 }, title: 'note', color: '#fff', group: null, text: 'hi' },
      absolutePosition: { x: 0, y: 0 }
    }
    const snap = stateToReopenSnapshot(entry)
    expect(snap.parentId).toBeUndefined()
    expect(snap.extent).toBeUndefined()
    expect(snap.data.text).toBe('hi')
  })

  // Belt-and-braces behind validClosedSessions (which is what actually rejects these at the file
  // boundary). recreateNodeFromSnapshot assigns node.position from one of these two UNGUARDED and
  // React Flow dereferences position.x, so any path that reaches here with an entry the validator
  // never saw must land the node at a real point, not white-screen the renderer.
  it('falls back rather than emitting an undefined position when one point is missing', () => {
    const node = {
      id: 'n1', kind: 'terminal', position: { x: 3, y: 4 },
      size: { width: 1, height: 1 }, title: 't', color: '#fff', group: null
    }
    const noAbs = { id: 'e1', closedAt: 1, node } as unknown as ClosedSessionEntry
    expect(stateToReopenSnapshot(noAbs).absolutePosition).toEqual({ x: 3, y: 4 })

    const { position: _dropped, ...positionless } = node
    const noPos = {
      id: 'e1', closedAt: 1, node: positionless, absolutePosition: { x: 7, y: 8 }
    } as unknown as ClosedSessionEntry
    expect(stateToReopenSnapshot(noPos).position).toEqual({ x: 7, y: 8 })

    const neither = { id: 'e1', closedAt: 1, node: positionless } as unknown as ClosedSessionEntry
    expect(stateToReopenSnapshot(neither).position).toEqual({ x: 0, y: 0 })
    expect(stateToReopenSnapshot(neither).absolutePosition).toEqual({ x: 0, y: 0 })
  })
})

describe('mergeClosedHistory', () => {
  const proj = (over: Partial<Project>): Project =>
    ({ id: 'p', name: 'p', color: '#fff', viewport: { x: 0, y: 0, zoom: 1 }, nodes: [], ...over }) as Project

  it('merges closed projects and closed sessions across all projects, sorted newest-first', () => {
    const entry = (id: string, closedAt: number): ClosedSessionEntry => ({
      id, closedAt,
      node: { id: 'n', kind: 'terminal', position: { x: 0, y: 0 }, size: { width: 1, height: 1 }, title: 't', color: '#fff', group: null },
      absolutePosition: { x: 0, y: 0 }
    })
    const projects = [
      proj({ id: 'a', closed: true, closedAt: 50 }),
      proj({ id: 'b', closedSessions: [entry('s1', 100), entry('s2', 10)] })
    ]
    const rows = mergeClosedHistory(projects)
    expect(rows.map((r) => (r.kind === 'project' ? r.projectId : r.entry.id))).toEqual(['s1', 'a', 's2'])
  })

  it('sorts a project with no closedAt last', () => {
    const projects = [proj({ id: 'a', closed: true }), proj({ id: 'b', closed: true, closedAt: 5 })]
    const rows = mergeClosedHistory(projects)
    expect(rows.map((r) => (r.kind === 'project' ? r.projectId : ''))).toEqual(['b', 'a'])
  })

  it('ignores an open project with no closedSessions', () => {
    const rows = mergeClosedHistory([proj({ id: 'a' })])
    expect(rows).toHaveLength(0)
  })

  it('excludes an unavailable closed project', () => {
    const rows = mergeClosedHistory([proj({ id: 'a', closed: true, unavailable: true, closedAt: 5 })])
    expect(rows).toHaveLength(0)
  })
})
