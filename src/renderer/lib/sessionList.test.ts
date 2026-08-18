import { describe, it, expect } from 'vitest'
import {
  buildSessionList,
  buildStatusList,
  groupSessionCount,
  groupSessionRows,
  liveCollapseKeys,
  pruneCollapsedItems,
  sessionStatusKind,
  sessionStateAgeLabel,
  projectIdAtIndex,
  isGroupCollapsed,
  projectHeadClickAction,
  projectSignalCounts,
  type ProjectInput,
  type SessionRowVM,
  type SessionGroup
} from './sessionList'
import type { AgentNodeStatus } from '../state/agentStatus'

const node = (id: string, over: Partial<ProjectInput['nodes'][number]> = {}) => ({
  id,
  kind: 'terminal' as const,
  title: id,
  color: '#888',
  ...over
})

const projects = (): ProjectInput[] => [
  { id: 'p1', name: 'Alpha', color: '#111', cwd: '/a', nodes: [node('t1'), node('a1', { agentId: 'claude' })] },
  { id: 'p2', name: 'Beta', color: '#222', nodes: [node('t2'), node('s1', { kind: 'sticky' }), node('e1', { kind: 'editor' })] }
]

describe('sessionStatusKind', () => {
  it('maps agent states to status kinds', () => {
    expect(sessionStatusKind('working')).toBe('working')
    expect(sessionStatusKind('waiting')).toBe('attention')
    expect(sessionStatusKind('blocked')).toBe('attention')
    // A done turn is its OWN kind, not attention: the unread mark already carries "new for you".
    expect(sessionStatusKind('done')).toBe('done')
    expect(sessionStatusKind(undefined)).toBe('unknown')
  })
})

describe('sessionStateAgeLabel', () => {
  it('formats an observed transition and does not invent an age for unknown history', () => {
    const now = 10 * 60_000
    expect(sessionStateAgeLabel(now - 5 * 60_000, now)).toBe('5m ago')
    expect(sessionStateAgeLabel(undefined, now)).toBeUndefined()
  })
})

describe('projectIdAtIndex', () => {
  const list = [{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }]

  it('maps a 1-based index to the project at that position', () => {
    expect(projectIdAtIndex(list, 1)).toBe('p1')
    expect(projectIdAtIndex(list, 3)).toBe('p3')
  })

  it('returns null past the end of the list', () => {
    expect(projectIdAtIndex(list, 4)).toBeNull()
  })

  it('returns null for index 0 or above 9', () => {
    expect(projectIdAtIndex(list, 0)).toBeNull()
    expect(projectIdAtIndex(list, 10)).toBeNull()
  })

  it('returns null for an empty project list', () => {
    expect(projectIdAtIndex([], 1)).toBeNull()
  })
})

describe('isGroupCollapsed', () => {
  it('defaults to expanded for the active project and collapsed for the rest', () => {
    expect(isGroupCollapsed({}, 'p1', true)).toBe(false)
    expect(isGroupCollapsed({}, 'p2', false)).toBe(true)
  })

  it('lets an explicit override win over the default', () => {
    expect(isGroupCollapsed({ p1: true }, 'p1', true)).toBe(true) // active but user collapsed
    expect(isGroupCollapsed({ p2: false }, 'p2', false)).toBe(false) // inactive but user expanded
  })

  it('with autoCollapse off, everything defaults to expanded (overrides still win)', () => {
    expect(isGroupCollapsed({}, 'p1', true, false)).toBe(false)
    expect(isGroupCollapsed({}, 'p2', false, false)).toBe(false) // inactive stays expanded
    expect(isGroupCollapsed({ p2: true }, 'p2', false, false)).toBe(true) // user collapsed
  })
})

describe('projectHeadClickAction', () => {
  it('switches to an inactive project and toggles the active one (never both, never nothing)', () => {
    expect(projectHeadClickAction(false)).toBe('switch')
    // No dead zone: the active row still does what the whole header used to do.
    expect(projectHeadClickAction(true)).toBe('toggle-collapse')
  })

  it('needs no collapse write on a switch: the target expands from the DEFAULT', () => {
    // With autoCollapse ON the sidebar wipes every override on the activeProjectId change, so
    // a toggle written by the click would be clobbered a tick later anyway — and is pointless,
    // because the newly active project is expanded by the default rule.
    expect(projectHeadClickAction(false)).toBe('switch')
    expect(isGroupCollapsed({}, 'p2', true)).toBe(false)
  })

  it("with autoCollapse off, a switch leaves the target's explicit collapse choice alone", () => {
    // Documented contract: "off = switches never touch the user's choices". The click writes no
    // override, so a project the user collapsed by hand stays collapsed after switching to it.
    const overrides = { p2: true }
    expect(projectHeadClickAction(false)).toBe('switch')
    expect(isGroupCollapsed(overrides, 'p2', true, false)).toBe(true)
  })
})

describe('buildSessionList', () => {
  it('keeps store order (mirrors the tab bar) regardless of which project is active', () => {
    const groups = buildSessionList(projects(), null, 'p2', {}, '')
    expect(groups.map((g) => g.projectId)).toEqual(['p1', 'p2'])
    expect(groups.find((g) => g.projectId === 'p2')!.isActive).toBe(true)
  })

  it('keeps only terminal/agent nodes and flags agents', () => {
    const groups = buildSessionList(projects(), null, 'p1', {}, '')
    const p2 = groups.find((g) => g.projectId === 'p2')!
    expect(p2.ungrouped.map((s) => s.id)).toEqual(['t2']) // sticky + editor dropped
    const p1 = groups.find((g) => g.projectId === 'p1')!
    expect(p1.ungrouped.find((s) => s.id === 'a1')!.isAgent).toBe(true)
    expect(p1.ungrouped.find((s) => s.id === 't1')!.isAgent).toBe(false)
  })

  it('attaches status and unread from the status map', () => {
    const status: Record<string, AgentNodeStatus> = {
      a1: { unread: true, state: 'working', agentId: 'claude', session: 'fix bug', sessionId: 'sess-1' }
    }
    const groups = buildSessionList(projects(), null, 'p1', status, '')
    const a1 = groups[0].ungrouped.find((s) => s.id === 'a1')!
    expect(a1.statusKind).toBe('working')
    expect(a1.unread).toBe(true)
    expect(a1.session).toBe('fix bug')
    expect(a1.sessionId).toBe('sess-1')
    expect(a1.usesContext).toBe(true) // claude is USAGE_CAPABLE
  })

  it('uses live nodes for the active project instead of serialized ones', () => {
    const live = [node('t1', { title: 'renamed live' })]
    const groups = buildSessionList(projects(), live, 'p1', {}, '')
    const p1 = groups.find((g) => g.projectId === 'p1')!
    expect(p1.ungrouped.map((s) => s.title)).toEqual(['renamed live'])
  })

  it('nests sessions under their canvas group and separates ungrouped ones', () => {
    const proj: ProjectInput[] = [
      {
        id: 'p1',
        name: 'Alpha',
        color: '#111',
        nodes: [
          node('g1', { kind: 'group', title: 'Frontend', color: '#abc' }),
          node('t1', { parentId: 'g1' }),
          node('t2', { parentId: 'g1' }),
          node('t3'), // ungrouped
          node('t4', { parentId: 'missing' }) // dangling parent → ungrouped
        ]
      }
    ]
    const [p1] = buildSessionList(proj, null, 'p1', {}, '')
    expect(p1.groups).toHaveLength(1)
    expect(p1.groups[0]).toMatchObject({ id: 'g1', title: 'Frontend', color: '#abc' })
    expect(p1.groups[0].sessions.map((s) => s.id)).toEqual(['t1', 't2'])
    expect(p1.groups[0].children).toEqual([])
    expect(p1.ungrouped.map((s) => s.id)).toEqual(['t3', 't4'])
  })

  it('keeps empty groups without a filter and hides them when filtering', () => {
    const proj: ProjectInput[] = [
      {
        id: 'p1',
        name: 'Alpha',
        color: '#111',
        nodes: [
          node('g1', { kind: 'group', title: 'Empty', color: '#abc' }),
          node('g2', { kind: 'group', title: 'Has match', color: '#def' }),
          node('t1', { title: 'special', parentId: 'g2' })
        ]
      }
    ]
    const unfiltered = buildSessionList(proj, null, 'p1', {}, '')
    expect(unfiltered[0].groups.map((b) => b.id)).toEqual(['g1', 'g2']) // empty g1 kept

    const filtered = buildSessionList(proj, null, 'p1', {}, 'spec')
    expect(filtered[0].groups.map((b) => b.id)).toEqual(['g2']) // empty g1 dropped
    expect(filtered[0].groups[0].sessions.map((s) => s.id)).toEqual(['t1'])
  })

  it('filters by title and session name, hiding empty projects only when filtering', () => {
    const status: Record<string, AgentNodeStatus> = { a1: { unread: false, session: 'special' } }
    const filtered = buildSessionList(projects(), null, 'p1', status, 'spec')
    expect(filtered.map((g) => g.projectId)).toEqual(['p1'])
    expect(filtered[0].ungrouped.map((s) => s.id)).toEqual(['a1'])

    const unfiltered = buildSessionList(projects(), null, 'p1', {}, '')
    expect(unfiltered.length).toBe(2) // both projects kept when no filter
  })

  it('builds nested canvas groups as a recursive tree and preserves ancestors when filtering', () => {
    const proj: ProjectInput[] = [
      {
        id: 'p1',
        name: 'Alpha',
        color: '#111',
        nodes: [
          node('outer', { kind: 'group', title: 'Outer' }),
          node('inner', { kind: 'group', title: 'Inner', parentId: 'outer' }),
          node('deep', { kind: 'group', title: 'Deep', parentId: 'inner' }),
          node('direct', { parentId: 'outer' }),
          node('target', { title: 'Needle session', parentId: 'deep' })
        ]
      }
    ]
    const [all] = buildSessionList(
      proj,
      null,
      'p1',
      { target: { unread: false, state: 'waiting' } },
      ''
    )
    const outer = all.groups[0]
    expect(outer.children[0].children[0].id).toBe('deep')
    expect(groupSessionRows(outer).map((row) => row.id)).toEqual(['direct', 'target'])
    expect(groupSessionCount(outer)).toBe(2)
    // A nested session still reaches the project header badges.
    expect(projectSignalCounts(all)).toEqual({ attention: 1, unread: 0, working: 0 })

    // Filtering keeps the ancestors of a match — otherwise the hit is unreachable in the tree.
    const [filtered] = buildSessionList(proj, null, 'p1', {}, 'needle')
    expect(filtered.groups[0].id).toBe('outer')
    expect(filtered.groups[0].children[0].children[0].sessions.map((row) => row.id)).toEqual([
      'target'
    ])
  })

  it('promotes groups with dangling or cyclic parents to a reachable root', () => {
    const proj: ProjectInput[] = [
      {
        id: 'p1',
        name: 'Alpha',
        color: '#111',
        nodes: [
          node('dangling', { kind: 'group', parentId: 'missing' }),
          node('a', { kind: 'group', parentId: 'b' }),
          node('b', { kind: 'group', parentId: 'a' })
        ]
      }
    ]
    const [group] = buildSessionList(proj, null, 'p1', {}, '')
    expect(new Set(group.groups.map((bucket) => bucket.id))).toEqual(
      new Set(['dangling', 'a', 'b'])
    )
  })
})

describe('sidebar disclosure keys', () => {
  const proj: ProjectInput[] = [
    {
      id: 'p1',
      name: 'Alpha',
      color: '#111',
      nodes: [
        node('outer', { kind: 'group', title: 'Outer' }),
        node('inner', { kind: 'group', title: 'Inner', parentId: 'outer' }),
        node('t1', { parentId: 'inner' })
      ]
    }
  ]

  it('lists a key for the project and for every frame at any depth', () => {
    const keys = liveCollapseKeys(buildSessionList(proj, null, 'p1', {}, ''))
    expect(keys).toEqual(
      new Set(['project:p1', 'project:p1:group:outer', 'project:p1:group:inner'])
    )
  })

  it('drops keys whose project or frame is gone, and keeps the key being written', () => {
    const live = liveCollapseKeys(buildSessionList(proj, null, 'p1', {}, ''))
    const stored = {
      'project:p1': true,
      'project:p1:group:inner': true,
      'project:p1:group:deleted': true,
      'project:closed-long-ago': true
    }
    expect(pruneCollapsedItems(stored, live)).toEqual({
      'project:p1': true,
      'project:p1:group:inner': true
    })
    // A filtered tree does not list every frame, so the key being toggled is always kept.
    expect(pruneCollapsedItems(stored, new Set<string>(), 'project:p1:group:deleted')).toEqual({
      'project:p1:group:deleted': true
    })
  })

  it('returns the same object when there is nothing to prune (no needless settings write)', () => {
    const live = liveCollapseKeys(buildSessionList(proj, null, 'p1', {}, ''))
    const stored = { 'project:p1': true }
    expect(pruneCollapsedItems(stored, live)).toBe(stored)
  })
})

describe('projectSignalCounts', () => {
  const group = (sessions: Partial<SessionRowVM>[]): SessionGroup => ({
    projectId: 'p1',
    projectName: 'P',
    projectColor: '#111',
    isActive: false,
    groups: [],
    ungrouped: sessions.map((s, i) => ({
      id: `s${i}`,
      title: `s${i}`,
      color: '#888',
      isAgent: false,
      statusKind: 'unknown' as const,
      stateLabel: 'Unknown',
      statusRestored: false,
      unread: false,
      usesContext: false,
      ...s
    }))
  })

  // Restored from before the working badge: the original a–f matrix. It pins the row-glyph
  // PRECEDENCE (attention beats unread, a working session is not yet unread) across both
  // ungrouped and grouped sessions, which the narrower fixtures below do not reach. The working
  // count is asserted alongside it rather than replacing it.
  it('counts attention and unread across ungrouped and grouped sessions', () => {
    const proj: ProjectInput[] = [
      {
        id: 'p1',
        name: 'P1',
        color: '#123',
        nodes: [
          node('g1', { kind: 'group', title: 'G', color: '#abc' }),
          node('a'), // waiting → attention
          node('b', { parentId: 'g1' }), // blocked → attention
          node('c'), // done + unread → unread ('done' is not attention; unread carries the signal)
          node('d'), // unknown + unread → unread (state lost, unread persisted)
          node('e'), // working + unread → NOT counted (mirrors the row glyph precedence)
          node('f') // plain unknown → neither
        ]
      }
    ]
    const status: Record<string, AgentNodeStatus> = {
      a: { unread: false, state: 'waiting' },
      b: { unread: true, state: 'blocked' }, // attention wins over unread
      c: { unread: true, state: 'done' },
      d: { unread: true },
      e: { unread: true, state: 'working' }
    }
    const [g] = buildSessionList(proj, null, 'p1', status, '')
    // `e` is the load-bearing one: it is the single working session AND carries an unread mark,
    // so it must land in `working` and NOT in `unread`. `c` (done+unread) now counts as unread,
    // not attention — the user's call: unread already signals "there's something new here".
    expect(projectSignalCounts(g)).toEqual({ attention: 2, unread: 2, working: 1 })
  })

  it('returns zeros for a quiet project', () => {
    const [g] = buildSessionList(
      [{ id: 'p1', name: 'P1', color: '#123', nodes: [node('x')] }],
      null,
      'p1',
      {},
      ''
    )
    expect(projectSignalCounts(g)).toEqual({ attention: 0, unread: 0, working: 0 })
  })

  it('counts working sessions alongside attention/unread', () => {
    const g = group([
      { statusKind: 'working' },
      { statusKind: 'working' },
      { statusKind: 'attention' },
      { statusKind: 'unknown' }
    ])
    expect(projectSignalCounts(g)).toEqual({ attention: 1, unread: 0, working: 2 })
  })

  it('workflow attention wins over unread when nothing is running', () => {
    const g = group([{ statusKind: 'unknown' }, { statusKind: 'attention', unread: true }])
    expect(projectSignalCounts(g)).toEqual({ attention: 1, unread: 0, working: 0 })
  })

  it('drives through buildSessionList: counts grouped sessions, attention wins over unread, working is not double-counted as unread', () => {
    const proj: ProjectInput[] = [
      {
        id: 'p1',
        name: 'Alpha',
        color: '#111',
        nodes: [
          node('g1', { kind: 'group', title: 'Frontend', color: '#abc' }),
          node('a1', { agentId: 'claude', parentId: 'g1' }), // attention + unread -> attention only
          node('a2', { agentId: 'claude', parentId: 'g1' }), // working + unread -> working only
          node('t1') // ungrouped, unknown
        ]
      }
    ]
    const status: Record<string, AgentNodeStatus> = {
      a1: { unread: true, state: 'blocked', agentId: 'claude', session: 'blocked task', sessionId: 'sess-a1' },
      a2: { unread: true, state: 'working', agentId: 'claude', session: 'working task', sessionId: 'sess-a2' }
    }
    const [p1] = buildSessionList(proj, null, 'p1', status, '')
    expect(p1.groups[0].sessions.map((s) => s.id)).toEqual(['a1', 'a2']) // sanity: sessions really live under group.groups
    expect(projectSignalCounts(p1)).toEqual({ attention: 1, unread: 0, working: 1 })
  })
})

describe('buildStatusList', () => {
  // Two projects, sessions in various states spread across them.
  const status: Record<string, AgentNodeStatus> = {
    a1: { unread: false, state: 'waiting', lastEventAt: 100 }, // attention, oldest
    a2: { unread: false, state: 'blocked', lastEventAt: 300 }, // attention, newest
    d1: { unread: false, state: 'done', lastEventAt: 200 }, // completed turn → Done
    w1: { unread: false, state: 'working', lastEventAt: 400 }, // working
    i1: { unread: false } // unknown (no state or transition time)
  }
  const proj: ProjectInput[] = [
    {
      id: 'p1',
      name: 'Alpha',
      color: '#111',
      cwd: '/a',
      nodes: [node('a1', { title: 'zebra' }), node('d1', { title: 'apple' }), node('i1', { title: 'unknown1' })]
    },
    {
      id: 'p2',
      name: 'Beta',
      color: '#222',
      nodes: [node('a2', { title: 'mid' }), node('w1', { title: 'runner' }), node('s1', { kind: 'sticky' })]
    }
  ]

  it('groups by workflow status in the fixed order attention → done → unknown → working', () => {
    const sections = buildStatusList(proj, null, 'p1', status, '')
    expect(sections.map((s) => s.kind)).toEqual(['attention', 'done', 'unknown', 'working'])
  })

  it('flattens across projects and tags each row with its project', () => {
    const sections = buildStatusList(proj, null, 'p1', status, '')
    const attention = sections.find((s) => s.kind === 'attention')!
    expect(attention.rows.map((r) => r.id).sort()).toEqual(['a1', 'a2'])
    expect(sections.find((s) => s.kind === 'done')!.rows.map((r) => r.id)).toEqual(['d1'])
    const a1 = attention.rows.find((r) => r.id === 'a1')!
    expect(a1.projectId).toBe('p1')
    expect(a1.projectName).toBe('Alpha')
    expect(a1.projectColor).toBe('#111')
    expect(a1.statusUpdatedAt).toBe(100)
    const a2 = attention.rows.find((r) => r.id === 'a2')!
    expect(a2.projectId).toBe('p2')
  })

  it('sorts rows within a section by descending state-change time', () => {
    const sections = buildStatusList(proj, null, 'p1', status, '')
    // a2 (300) before a1 (100); d1 sits in Done, not between them.
    expect(sections.find((s) => s.kind === 'attention')!.rows.map((r) => r.id)).toEqual([
      'a2',
      'a1'
    ])
    expect(sections.find((s) => s.kind === 'done')!.rows.map((r) => r.id)).toEqual(['d1'])
  })

  it('keeps only terminal nodes (drops stickies/editors)', () => {
    const sections = buildStatusList(proj, null, 'p1', status, '')
    const ids = sections.flatMap((s) => s.rows.map((r) => r.id))
    expect(ids).not.toContain('s1')
  })

  it('uses live nodes for the active project', () => {
    const live = [node('a1', { title: 'renamed live', agentId: 'claude' })]
    const sections = buildStatusList(proj, live, 'p1', status, '')
    const a1 = sections.flatMap((s) => s.rows).find((r) => r.id === 'a1')!
    expect(a1.title).toBe('renamed live')
  })

  it('keeps empty sections while filtering rows by title/session', () => {
    // 'runner' only matches w1 (working)
    const filtered = buildStatusList(proj, null, 'p1', status, 'runner')
    expect(filtered.map((s) => s.kind)).toEqual(['attention', 'done', 'unknown', 'working'])
    expect(filtered.find((s) => s.kind === 'working')!.rows.map((r) => r.id)).toEqual(['w1'])
    expect(filtered.filter((s) => s.kind !== 'working').every((s) => s.rows.length === 0)).toBe(true)
  })

  it('returns every section even when some headers have no sessions', () => {
    // Waiting → attention, done → Done; unknown/working stay present and empty.
    const onlyTwo: ProjectInput[] = [
      { id: 'p1', name: 'Alpha', color: '#111', nodes: [node('a1'), node('d1')] }
    ]
    const two: Record<string, AgentNodeStatus> = { a1: { unread: false, state: 'waiting' }, d1: { unread: false, state: 'done' } }
    const sections = buildStatusList(onlyTwo, null, 'p1', two, '')
    expect(sections.map((s) => s.kind)).toEqual(['attention', 'done', 'unknown', 'working'])
    expect(sections.find((s) => s.kind === 'attention')!.rows.map((row) => row.id)).toEqual(['a1'])
    expect(sections.find((s) => s.kind === 'done')!.rows.map((row) => row.id)).toEqual(['d1'])
    expect(sections.find((s) => s.kind === 'unknown')!.rows).toEqual([])
    expect(sections.find((s) => s.kind === 'working')!.rows).toEqual([])
  })

  it('keeps unread as row metadata without changing the workflow section', () => {
    const glowing: Record<string, AgentNodeStatus> = {
      d1: { unread: true, state: 'done' },
      i1: { unread: true },
      w1: { unread: true, state: 'working' }
    }
    const sections = buildStatusList(proj, null, 'p1', glowing, '')
    const done = sections.find((s) => s.kind === 'done')!
    expect(done.label).toBe('Done')
    expect(done.rows.map((r) => r.id)).toEqual(['d1'])
    expect(done.rows[0].unread).toBe(true)

    const unknownI1 = sections.find((s) => s.kind === 'unknown')!.rows.find((r) => r.id === 'i1')!
    expect(unknownI1.unread).toBe(true)

    const working = sections.find((s) => s.kind === 'working')!
    expect(working.rows.map((r) => r.id)).toEqual(['w1'])
    expect(working.rows[0].unread).toBe(true)
    expect(sections.find((s) => s.kind === 'attention')!.rows).toEqual([])
  })

  it('falls through to Unknown when no live state is known', () => {
    const sections = buildStatusList(proj, null, 'p1', status, '')
    const unknown = sections.find((s) => s.kind === 'unknown')!
    expect(unknown.label).toBe('Unknown')
    expect(unknown.rows.map((r) => r.id)).toEqual(['i1'])
  })

  it('never emits a node twice during a cross-project switch window', () => {
    // Simulates the duplication bug: `activeProjectId` has already flipped to p2 (the focus
    // target), but `liveActiveNodes` still holds p1's nodes (React Flow hasn't flushed yet).
    // The naive "active = liveActiveNodes" read tagged the stale nodes with p2 while p1's
    // just-committed p.nodes emitted them again — same node under two project tags.
    const p1Nodes = [node('a1', { title: 'Align to Grid', agentId: 'claude' })]
    const proj2: ProjectInput[] = [
      { id: 'p1', name: 'nodeterm', color: '#111', nodes: p1Nodes },
      { id: 'p2', name: 'ImmyBot', color: '#222', nodes: [node('b1', { title: 'other' })] }
    ]
    // activeProjectId is now p2, but liveActiveNodes still carries p1's a1 (stale window).
    const sections = buildStatusList(proj2, p1Nodes, 'p2', { a1: { unread: false } }, '')
    const allRows = sections.flatMap((s) => s.rows)
    // a1 appears exactly once…
    expect(allRows.filter((r) => r.id === 'a1')).toHaveLength(1)
    // …owned by its real project (p1), NOT mis-tagged as p2.
    expect(allRows.find((r) => r.id === 'a1')!.projectId).toBe('p1')
  })
})
