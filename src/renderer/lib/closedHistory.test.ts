import { describe, it, expect } from 'vitest'
import {
  buildClosedSessionEntries,
  closedTranscriptTarget,
  filterClosedProjects,
  mergeClosedHistory,
  recentlyClosedProjects,
  stateToReopenSnapshot
} from './closedHistory'
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

  // The persisted twin lives in workspace.json — hand-editable — so the icon is re-validated
  // here rather than trusted: a reopened session keeps its icon, a garbage one is dropped.
  it('carries the node icon through, and drops one that fails validation', () => {
    const entry = (icon: unknown): ClosedSessionEntry => ({
      id: 'e1', closedAt: 1,
      node: {
        id: 'n1', kind: 'terminal', position: { x: 0, y: 0 }, size: { width: 10, height: 10 },
        title: 'db', color: '#fff', group: null, icon: icon as never
      },
      absolutePosition: { x: 0, y: 0 }
    })
    expect(stateToReopenSnapshot(entry({ type: 'lucide', name: 'database' })).data.icon).toEqual({
      type: 'lucide',
      name: 'database'
    })
    expect(stateToReopenSnapshot(entry({ type: 'emoji', value: '\u{1F680}' })).data.icon).toEqual({
      type: 'emoji',
      value: '\u{1F680}'
    })
    expect(stateToReopenSnapshot(entry({ type: 'lucide', name: 'nope' })).data.icon).toBeUndefined()
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

// Issue #531: closing a node used to destroy the ONLY pointer to its transcript (the live session
// id, held in the transient agent-status store), so finished work could never be read back.
describe('the closed-session transcript pointer', () => {
  const agentNode = (over: Record<string, unknown> = {}): CanvasNode =>
    node({
      id: 'a1',
      data: { title: 'reviewer', color: '#fff', group: null, cwd: '/repo', agentId: 'claude', ...over }
    } as Partial<CanvasNode>)

  it('records the LIVE session id at close', () => {
    const entries = buildClosedSessionEntries(
      new Set(['a1']),
      [agentNode()],
      1,
      () => 'e1',
      (id) => (id === 'a1' ? 'live-sess' : undefined)
    )
    expect(entries[0].sessionId).toBe('live-sess')
  })

  it('falls back to the minted agentSessionId when no hook event ever named a live one', () => {
    const entries = buildClosedSessionEntries(
      new Set(['a1']),
      [agentNode({ agentSessionId: 'minted-sess' })],
      1,
      () => 'e1',
      () => undefined
    )
    expect(entries[0].sessionId).toBe('minted-sess')
  })

  it('prefers the live id over the minted one — a resume replaces the session that was minted', () => {
    const entries = buildClosedSessionEntries(
      new Set(['a1']),
      [agentNode({ agentSessionId: 'minted-sess' })],
      1,
      () => 'e1',
      () => 'live-sess'
    )
    expect(entries[0].sessionId).toBe('live-sess')
  })

  it('omits the field entirely when neither id exists, rather than writing undefined', () => {
    const entries = buildClosedSessionEntries(new Set(['n1']), [node()], 1, () => 'e1')
    expect('sessionId' in entries[0]).toBe(false)
  })
})

describe('closedTranscriptTarget', () => {
  const entry = (
    over: Partial<ClosedSessionEntry> = {},
    nodeOver: Record<string, unknown> = {}
  ): ClosedSessionEntry =>
    ({
      id: 'e1',
      closedAt: 1,
      absolutePosition: { x: 0, y: 0 },
      node: {
        id: 'a1', kind: 'terminal', position: { x: 0, y: 0 }, title: 'reviewer', color: '#fff',
        group: null, cwd: '/repo', agentId: 'claude', ...nodeOver
      },
      ...over
    }) as ClosedSessionEntry

  it('hands back exactly the arguments the Cmd+M reader takes', () => {
    const t = closedTranscriptTarget(entry({ sessionId: 's1' }, { accountId: 'acc-2' }))
    expect(t).toEqual({
      ok: true, sessionId: 's1', agentId: 'claude', cwd: '/repo', accountId: 'acc-2', nodeId: 'a1'
    })
  })

  it('refuses a node whose agent has no readable transcript, as the kind a surface may hide', () => {
    expect(closedTranscriptTarget(entry({ sessionId: 's1' }, { agentId: undefined }))).toMatchObject({
      ok: false, kind: 'no-agent'
    })
  })

  it('refuses a REMOTE session by name — its transcript is on the host', () => {
    expect(closedTranscriptTarget(entry({ sessionId: 's1' }, { sshRemoteTmux: true }))).toMatchObject({
      ok: false, kind: 'remote'
    })
    expect(closedTranscriptTarget(entry({ sessionId: 's1' }, { ssh: { host: 'h', user: 'u' } }))).toMatchObject({
      ok: false, kind: 'remote'
    })
  })

  it('refuses an entry with no recorded id (closed by a pre-#531 build) with its own reason', () => {
    const t = closedTranscriptTarget(entry())
    expect(t).toMatchObject({ ok: false, kind: 'no-session-id' })
    // Not the hideable kind: the user closed a real agent session and the record is genuinely gone.
    expect(t.ok === false && t.kind !== 'no-agent').toBe(true)
  })
})

describe('recentlyClosedProjects — the heading promises recency (issue #506)', () => {
  type Probe = { id: string; name: string; closed?: boolean; unavailable?: boolean; closedAt?: number }
  const p = (id: string, over: Partial<Probe> = {}): Probe => ({ id, name: id, ...over })

  it('orders newest-closed first, NOT tab order', () => {
    // Tab order here is old, new, mid — the project shut most recently must lead regardless.
    const rows = recentlyClosedProjects([
      p('old', { closed: true, closedAt: 10 }),
      p('new', { closed: true, closedAt: 300 }),
      p('mid', { closed: true, closedAt: 100 })
    ])
    expect(rows.map((r) => r.id)).toEqual(['new', 'mid', 'old'])
  })

  it('drops open and unavailable projects', () => {
    const rows = recentlyClosedProjects([
      p('open'),
      p('gone', { closed: true, unavailable: true, closedAt: 999 }),
      p('kept', { closed: true, closedAt: 1 })
    ])
    expect(rows.map((r) => r.id)).toEqual(['kept'])
  })

  it('sorts a project closed before the field existed last, never as NaN', () => {
    const rows = recentlyClosedProjects([p('legacy', { closed: true }), p('known', { closed: true, closedAt: 5 })])
    expect(rows.map((r) => r.id)).toEqual(['known', 'legacy'])
  })
})

describe('filterClosedProjects', () => {
  const rows = [
    { id: 'a', name: 'Website', cwd: '/repos/site' },
    { id: 'b', name: 'API', cwd: '/repos/api-server' }
  ]

  it('matches the project name', () => {
    expect(filterClosedProjects(rows, 'web').map((r) => r.id)).toEqual(['a'])
  })

  it('matches the folder, which is what the row already shows as its title', () => {
    expect(filterClosedProjects(rows, 'api-server').map((r) => r.id)).toEqual(['b'])
  })

  it('is case-insensitive and returns everything for an empty or blank query', () => {
    expect(filterClosedProjects(rows, 'WEBSITE').map((r) => r.id)).toEqual(['a'])
    expect(filterClosedProjects(rows, '')).toHaveLength(2)
    expect(filterClosedProjects(rows, '   ')).toHaveLength(2)
  })

  it('returns nothing when nothing matches (the caller says so, it does not fall back)', () => {
    expect(filterClosedProjects(rows, 'zzz')).toHaveLength(0)
  })
})
