import { describe, it, expect } from 'vitest'
import { applyKanbanOp, diffKanbanOps, sanitizeKanbanOp, kanbanOpKey, isKanbanDeletion } from './kanban-ops'
import { DEFAULT_BOARD_COLUMNS, defaultKanbanFor } from './kanban-default-board'
import { UNSAFE_DISPLAY_CHARS } from './presence'
import { columnOrder } from './kanban-order'
import { isValidRank, rankBetween } from './kanban-rank'
import type { KanbanOp, ProjectKanban } from './types'

const P = 'project-1'
const base = (): ProjectKanban => defaultKanbanFor(P)
const [todo, doing] = base().columns.map((c) => c.id)
const live = (...ids: string[]) => new Set(ids)

describe('sanitizeKanbanOp', () => {
  it('refuses a bad id and an unknown op', () => {
    expect(sanitizeKanbanOp({ op: 'kb-card-remove', nodeId: '' })).toBeNull()
    expect(sanitizeKanbanOp({ op: 'kb-nope' })).toBeNull()
  })
  it('repairs label colour, drops bad priority / dueAt / category, keeps good fields', () => {
    expect(sanitizeKanbanOp({ op: 'kb-label', label: { id: 'l1', name: '  Bug ', color: 'neon' } }))
      .toEqual({ op: 'kb-label', label: { id: 'l1', name: 'Bug', color: 'default' } })
    expect(sanitizeKanbanOp({ op: 'kb-meta', meta: { nodeId: 'n1', priority: 'extreme', dueAt: Number.NaN } }))
      .toEqual({ op: 'kb-meta', meta: { nodeId: 'n1' } })
    expect(sanitizeKanbanOp({ op: 'kb-column', column: { id: 'c1', title: 'X', color: '#fff', category: 'weird' } }))
      .toEqual({ op: 'kb-column', column: { id: 'c1', title: 'X', color: '#fff' } })
  })
  // Names and titles are REPAIRED, never refused (ruling R5): the UI has no maxLength, so a refused
  // rename would silently never sync. Only a name that is empty after the repair is refused.
  it('strips control characters and bidi overrides from a label name, and truncates it to 60 code points', () => {
    expect(sanitizeKanbanOp({ op: 'kb-label', label: { id: 'l1', name: 'a\u0007b', color: 'red' } }))
      .toEqual({ op: 'kb-label', label: { id: 'l1', name: 'ab', color: 'red' } })
    expect(sanitizeKanbanOp({ op: 'kb-label', label: { id: 'l1', name: '\u202eevil\u2066\u2069 ', color: 'red' } }))
      .toEqual({ op: 'kb-label', label: { id: 'l1', name: 'evil', color: 'red' } })
    expect(sanitizeKanbanOp({ op: 'kb-label', label: { id: 'l1', name: 'x'.repeat(61), color: 'red' } }))
      .toEqual({ op: 'kb-label', label: { id: 'l1', name: 'x'.repeat(60), color: 'red' } })
    // 60 CODE POINTS: an astral character is one, and is never split in half
    const astral = sanitizeKanbanOp({ op: 'kb-label', label: { id: 'l1', name: '😀'.repeat(61), color: 'red' } }) as Extract<KanbanOp, { op: 'kb-label' }>
    expect([...astral.label.name]).toHaveLength(60)
    expect(astral.label.name).toBe('😀'.repeat(60))
  })
  it('refuses a label name that is empty once repaired', () => {
    expect(sanitizeKanbanOp({ op: 'kb-label', label: { id: 'l1', name: ' \u0007\u202e ', color: 'red' } })).toBeNull()
    expect(sanitizeKanbanOp({ op: 'kb-label', label: { id: 'l1', name: '', color: 'red' } })).toBeNull()
  })
  it('repairs a column title the same way (200 code points), and refuses an empty one', () => {
    expect(sanitizeKanbanOp({ op: 'kb-column', column: { id: 'c1', title: ' In\nProgress\u202d ', color: '#fff' } }))
      .toEqual({ op: 'kb-column', column: { id: 'c1', title: 'InProgress', color: '#fff' } })
    expect(sanitizeKanbanOp({ op: 'kb-column', column: { id: 'c1', title: 'y'.repeat(250), color: '#fff' } }))
      .toEqual({ op: 'kb-column', column: { id: 'c1', title: 'y'.repeat(200), color: '#fff' } })
    expect(sanitizeKanbanOp({ op: 'kb-column', column: { id: 'c1', title: '\u0000 ', color: '#fff' } })).toBeNull()
  })
  it('strips control characters and bidi overrides from an assignee name', () => {
    expect(sanitizeKanbanOp({ op: 'kb-meta', meta: { nodeId: 'n1', assignees: [{ name: 'Ada\u202egnihsihp', color: '#f00' }, { name: '\u0007', color: '#0f0' }] } }))
      .toEqual({ op: 'kb-meta', meta: { nodeId: 'n1', assignees: [{ name: 'Adagnihsihp', color: '#f00' }] } })
  })
  // An id is an ADDRESS, never displayed: a malformed one (not a string, empty, past the ref bound) is
  // refused whole, and any other string is carried byte for byte. Stripping a character would address
  // a different item; refusing it would stop that item (and any order op listing it) ever syncing.
  it('ids are never repaired: a malformed id is refused, any other string is carried as is', () => {
    expect(sanitizeKanbanOp({ op: 'kb-column-remove', id: 'x'.repeat(129) })).toBeNull()
    expect(sanitizeKanbanOp({ op: 'kb-card', assignment: { nodeId: '', columnId: 'c1' } })).toBeNull()
    expect(sanitizeKanbanOp({ op: 'kb-column-remove', id: 'a\u0007\u202eb' })).toEqual({ op: 'kb-column-remove', id: 'a\u0007\u202eb' })
  })
  // D7: ONE unsafe-display set, shared with presence names: the zero-width marks and the BOM too.
  it('strips zero-width marks and the BOM from a display name, like a presence name', () => {
    expect(sanitizeKanbanOp({ op: 'kb-label', label: { id: 'l1', name: '\ufeffB\u200bu\u200fg', color: 'red' } }))
      .toEqual({ op: 'kb-label', label: { id: 'l1', name: 'Bug', color: 'red' } })
    expect(UNSAFE_DISPLAY_CHARS.source).toContain('\\u200b-\\u200f')
  })
  // D7: a column's colour is repaired, not a reason to refuse the column (like a label's).
  it('a column with a missing or invalid colour keeps its place with the default colour', () => {
    const expected = { op: 'kb-column', column: { id: 'c1', title: 'T', color: DEFAULT_BOARD_COLUMNS[0].color } }
    expect(sanitizeKanbanOp({ op: 'kb-column', column: { id: 'c1', title: 'T' } })).toEqual(expected)
    expect(sanitizeKanbanOp({ op: 'kb-column', column: { id: 'c1', title: 'T', color: 7 } })).toEqual(expected)
    expect(sanitizeKanbanOp({ op: 'kb-column', column: { id: 'c1', title: 'T', color: '#f\u0000' } })).toEqual(expected)
    expect(sanitizeKanbanOp({ op: 'kb-column', column: { id: 'c1', title: 'T', color: 'x'.repeat(65) } })).toEqual(expected)
  })
  it('drops an invalid rank rather than the whole op', () => {
    expect(sanitizeKanbanOp({ op: 'kb-card', assignment: { nodeId: 'n1', columnId: 'c1', rank: '!!' } }))
      .toEqual({ op: 'kb-card', assignment: { nodeId: 'n1', columnId: 'c1' } })
  })
})

describe('keys and deletions', () => {
  it('uses one k: key space', () => {
    expect(kanbanOpKey({ op: 'kb-card', assignment: { nodeId: 'n1', columnId: 'c' } }, P)).toBe('k:card:n1')
    expect(kanbanOpKey({ op: 'kb-card-remove', nodeId: 'n1' }, P)).toBe('k:card:n1')
  })
  // One CanvasOrder orders every loaded project, so a board's two SINGLETON keys must carry the
  // project (ruling R4) — else our unacked reorder in A holds off a peer's reorder in B (rule 2).
  // Per-item keys need no scope: node ids are global, column ids are per-project seeded or random.
  it('scopes the two singleton order keys by project, and only those', () => {
    expect(kanbanOpKey({ op: 'kb-column-order', ids: [] }, 'A')).toBe('k:colorder:A')
    expect(kanbanOpKey({ op: 'kb-label-order', ids: [] }, 'A')).toBe('k:labelorder:A')
    expect(kanbanOpKey({ op: 'kb-column-order', ids: [] }, 'B')).not.toBe(kanbanOpKey({ op: 'kb-column-order', ids: [] }, 'A'))
    expect(kanbanOpKey({ op: 'kb-column-remove', id: 'c' }, 'A')).toBe(kanbanOpKey({ op: 'kb-column-remove', id: 'c' }, 'B'))
  })
  it('only column/label/view removals are deletions (rule 4); card and meta removals are values', () => {
    expect(isKanbanDeletion({ op: 'kb-column-remove', id: 'c' })).toBe(true)
    expect(isKanbanDeletion({ op: 'kb-card-remove', nodeId: 'n' })).toBe(false)
    expect(isKanbanDeletion({ op: 'kb-meta-remove', nodeId: 'n' })).toBe(false)
  })
})

describe('applyKanbanOp', () => {
  it('seeds the deterministic default board when the project has none', () => {
    const b = applyKanbanOp(undefined, { op: 'kb-card', assignment: { nodeId: 'n1', columnId: todo } }, P)
    expect(b.columns.map((c) => c.id)).toEqual(base().columns.map((c) => c.id))
    expect(b.assignments).toEqual([{ nodeId: 'n1', columnId: todo }])
  })
  it('a card op replaces the card and keeps its column in rank order', () => {
    let b = base()
    b = applyKanbanOp(b, { op: 'kb-card', assignment: { nodeId: 'n1', columnId: todo, rank: 'm' } }, P)
    b = applyKanbanOp(b, { op: 'kb-card', assignment: { nodeId: 'n2', columnId: todo, rank: 'c' } }, P)
    b = applyKanbanOp(b, { op: 'kb-card', assignment: { nodeId: 'n1', columnId: doing, rank: 'm' } }, P)
    expect(b.assignments.filter((a) => a.columnId === todo).map((a) => a.nodeId)).toEqual(['n2'])
    expect(b.assignments.filter((a) => a.columnId === doing).map((a) => a.nodeId)).toEqual(['n1'])
  })
  // With REAL ranks and several cards: the array keeps each column in rank order (the reader an
  // older build uses), and it agrees with `columnOrder` (the reader this build uses).
  it('places cards with valid ranks in rank order, several per column', () => {
    const r = ['a0', 'a1', 'a2', 'a3']
    expect(r.every(isValidRank)).toBe(true)
    let b = base()
    b = applyKanbanOp(b, { op: 'kb-card', assignment: { nodeId: 'c', columnId: todo, rank: r[2] } }, P)
    b = applyKanbanOp(b, { op: 'kb-card', assignment: { nodeId: 'x', columnId: doing, rank: r[0] } }, P)
    b = applyKanbanOp(b, { op: 'kb-card', assignment: { nodeId: 'a', columnId: todo, rank: r[0] } }, P)
    b = applyKanbanOp(b, { op: 'kb-card', assignment: { nodeId: 'd', columnId: todo, rank: r[3] } }, P)
    b = applyKanbanOp(b, { op: 'kb-card', assignment: { nodeId: 'b', columnId: todo, rank: r[1] } }, P)
    const between = rankBetween(r[1], r[2])
    b = applyKanbanOp(b, { op: 'kb-card', assignment: { nodeId: 'bc', columnId: todo, rank: between } }, P)
    const inArray = b.assignments.filter((a) => a.columnId === todo).map((a) => a.nodeId)
    expect(inArray).toEqual(['a', 'b', 'bc', 'c', 'd'])
    expect(columnOrder(b.assignments, todo).map((a) => a.nodeId)).toEqual(inArray)
    // moving the top card to the bottom of the same column
    b = applyKanbanOp(b, { op: 'kb-card', assignment: { nodeId: 'a', columnId: todo, rank: rankBetween(r[3], null) } }, P)
    expect(b.assignments.filter((a) => a.columnId === todo).map((a) => a.nodeId)).toEqual(['b', 'bc', 'c', 'd', 'a'])
  })
  it('an invalid rank is treated as absent — incoming (goes to the end) and already placed (reads as its predecessor)', () => {
    let b = base()
    b = applyKanbanOp(b, { op: 'kb-card', assignment: { nodeId: 'n1', columnId: todo, rank: 'a0' } }, P)
    b = applyKanbanOp(b, { op: 'kb-card', assignment: { nodeId: 'n3', columnId: todo, rank: 'a2' } }, P)
    // incoming invalid rank: not compared as a string (`'!!'` sorts before every real rank)
    const incoming = applyKanbanOp(b, { op: 'kb-card', assignment: { nodeId: 'z', columnId: todo, rank: '!!' } }, P)
    expect(incoming.assignments.filter((a) => a.columnId === todo).map((a) => a.nodeId)).toEqual(['n1', 'n3', 'z'])
    // an already-placed entry with an invalid rank ('zz') sits with its predecessor (a0), so a card
    // ranked a1 lands AFTER it — not before, which a plain string compare ('zz' > 'a1') would do
    const legacy: ProjectKanban = {
      ...base(),
      assignments: [
        { nodeId: 'n1', columnId: todo, rank: 'a0' },
        { nodeId: 'n2', columnId: todo, rank: 'zz' },
        { nodeId: 'n3', columnId: todo, rank: 'a2' }
      ]
    }
    const placed = applyKanbanOp(legacy, { op: 'kb-card', assignment: { nodeId: 'x', columnId: todo, rank: 'a1' } }, P)
    expect(columnOrder(placed.assignments, todo).map((a) => a.nodeId)).toEqual(['n1', 'n2', 'x', 'n3'])
    expect(placed.assignments.map((a) => a.nodeId)).toEqual(['n1', 'n2', 'x', 'n3'])
  })
  it('a column removal also drops the column’s placements', () => {
    let b = applyKanbanOp(base(), { op: 'kb-card', assignment: { nodeId: 'n1', columnId: todo } }, P)
    b = applyKanbanOp(b, { op: 'kb-column-remove', id: todo }, P)
    expect(b.columns.some((c) => c.id === todo)).toBe(false)
    expect(b.assignments).toEqual([])
  })
  it('a label removal strips it from every card', () => {
    let b = applyKanbanOp(base(), { op: 'kb-label', label: { id: 'l1', name: 'Bug', color: 'red' } }, P)
    b = applyKanbanOp(b, { op: 'kb-meta', meta: { nodeId: 'n1', labels: ['l1'] } }, P)
    b = applyKanbanOp(b, { op: 'kb-label-remove', id: 'l1' }, P)
    expect(b.labels).toEqual([])
    expect(b.meta ?? []).toEqual([])
  })
  it('column order: listed ids first, unlisted kept after, unknown ignored', () => {
    const ids = base().columns.map((c) => c.id)
    const b = applyKanbanOp(base(), { op: 'kb-column-order', ids: [ids[2], 'ghost', ids[0]] }, P)
    expect(b.columns.map((c) => c.id)).toEqual([ids[2], ids[0], ids[1]])
  })
  // D5: the unlisted ids are ones teammates added concurrently, in each replica's own arrival order;
  // sorted, every replica applying the same op to the same set lands on the same list.
  it('order ops put the unlisted ids after the listed ones SORTED BY ID, whatever order they arrived in', () => {
    const col = (id: string) => ({ id, title: id, color: '#123456' })
    const listed = ['kcol-a']
    const one = { columns: [col('kcol-a'), col('kcol-z'), col('kcol-m')], assignments: [] }
    const two = { columns: [col('kcol-m'), col('kcol-a'), col('kcol-z')], assignments: [] }
    const order = { op: 'kb-column-order', ids: listed } as const
    expect(applyKanbanOp(one, order, P).columns.map((c) => c.id)).toEqual(['kcol-a', 'kcol-m', 'kcol-z'])
    expect(applyKanbanOp(two, order, P).columns.map((c) => c.id)).toEqual(['kcol-a', 'kcol-m', 'kcol-z'])
    const lab = (id: string) => ({ id, name: id, color: 'red' as const })
    const labels = { columns: [], assignments: [], labels: [lab('l-b'), lab('l-z'), lab('l-a')] }
    expect(applyKanbanOp(labels, { op: 'kb-label-order', ids: ['l-z'] }, P).labels?.map((l) => l.id)).toEqual(['l-z', 'l-a', 'l-b'])
  })
})

describe('diffKanbanOps', () => {
  it('one move of one card is one kb-card op', () => {
    const prev = applyKanbanOp(base(), { op: 'kb-card', assignment: { nodeId: 'n1', columnId: todo } }, P)
    const next = applyKanbanOp(prev, { op: 'kb-card', assignment: { nodeId: 'n1', columnId: doing } }, P)
    expect(diffKanbanOps(prev, next, P, live('n1'))).toEqual([
      { op: 'kb-card', assignment: { nodeId: 'n1', columnId: doing } }
    ])
  })
  it('an absent prev board diffs against the deterministic default (no column ops for the seed)', () => {
    const next = applyKanbanOp(undefined, { op: 'kb-card', assignment: { nodeId: 'n1', columnId: todo } }, P)
    expect(diffKanbanOps(undefined, next, P, live('n1'))).toEqual([
      { op: 'kb-card', assignment: { nodeId: 'n1', columnId: todo } }
    ])
  })
  it('prune removals of dead cards are never cast', () => {
    const prev = applyKanbanOp(base(), { op: 'kb-card', assignment: { nodeId: 'dead', columnId: todo } }, P)
    expect(diffKanbanOps(prev, base(), P, live())).toEqual([])
  })
  it('prune removals of a dead card\'s meta are never cast; a live card\'s cleared meta is', () => {
    const prev = applyKanbanOp(base(), { op: 'kb-meta', meta: { nodeId: 'dead', priority: 'high' } }, P)
    expect(diffKanbanOps(prev, base(), P, live())).toEqual([])
    expect(diffKanbanOps(prev, base(), P, live('dead'))).toEqual([{ op: 'kb-meta-remove', nodeId: 'dead' }])
  })
  it('a live card moved to Ungrouped is a kb-card-remove', () => {
    const prev = applyKanbanOp(base(), { op: 'kb-card', assignment: { nodeId: 'n1', columnId: todo } }, P)
    expect(diffKanbanOps(prev, base(), P, live('n1'))).toEqual([{ op: 'kb-card-remove', nodeId: 'n1' }])
  })
  it('batch order: upserts before removals; a removed column covers its own cards', () => {
    const prev = applyKanbanOp(base(), { op: 'kb-card', assignment: { nodeId: 'n1', columnId: todo } }, P)
    let next = applyKanbanOp(prev, { op: 'kb-column-remove', id: todo }, P)
    next = applyKanbanOp(next, { op: 'kb-label', label: { id: 'l1', name: 'x', color: 'red' } }, P)
    const ops = diffKanbanOps(prev, next, P, live('n1')).map((o) => o.op)
    // No separate kb-card-remove: applyKanbanOp drops the column's placements with the column. The
    // label set grew, so its order op rides along (R3), after the label it orders.
    expect(ops).toEqual(['kb-label', 'kb-label-order', 'kb-column-remove'])
  })
  // RULING R3 — an order op rides whenever the id set GAINED an id, or the relative order of the ids
  // both sides share changed. `kb-column` alone appends on a peer, so without it a column inserted
  // mid-list (the UI's add-then-move, a git pull) lands last everywhere else.
  const replay = (prev: ProjectKanban, ops: KanbanOp[]): ProjectKanban =>
    ops.reduce((b, o) => applyKanbanOp(b, o, P), prev)
  it('a new column NOT at the end emits the order op, and a peer replaying the ops gets the same order', () => {
    const prev = base()
    const [a, b2, c] = prev.columns
    const next: ProjectKanban = { ...prev, columns: [a, { id: 'kcol-new', title: 'New', color: '#123456' }, b2, c] }
    const ops = diffKanbanOps(prev, next, P, live())
    expect(ops).toEqual([
      { op: 'kb-column', column: { id: 'kcol-new', title: 'New', color: '#123456' } },
      { op: 'kb-column-order', ids: next.columns.map((x) => x.id) }
    ])
    expect(replay(prev, ops).columns.map((x) => x.id)).toEqual(next.columns.map((x) => x.id))
  })
  it('a new column at the end still emits the order op (the id set grew)', () => {
    const prev = base()
    const next: ProjectKanban = { ...prev, columns: [...prev.columns, { id: 'kcol-new', title: 'New', color: '#123456' }] }
    expect(diffKanbanOps(prev, next, P, live()).map((o) => o.op)).toEqual(['kb-column', 'kb-column-order'])
  })
  it('moving a column emits exactly one kb-column-order with the whole next order', () => {
    const prev = base()
    const [a, b2, c] = prev.columns
    const next: ProjectKanban = { ...prev, columns: [c, a, b2] }
    expect(diffKanbanOps(prev, next, P, live())).toEqual([{ op: 'kb-column-order', ids: [c.id, a.id, b2.id] }])
  })
  it('renaming a column or removing one emits no order op', () => {
    const prev = base()
    const renamed: ProjectKanban = { ...prev, columns: prev.columns.map((x, i) => (i === 1 ? { ...x, title: 'Doing' } : x)) }
    expect(diffKanbanOps(prev, renamed, P, live()).map((o) => o.op)).toEqual(['kb-column'])
    const removed: ProjectKanban = { ...prev, columns: prev.columns.slice(1) }
    expect(diffKanbanOps(prev, removed, P, live()).map((o) => o.op)).toEqual(['kb-column-remove'])
  })
  it('adding a label emits kb-label-order; reordering labels emits exactly the order op', () => {
    const l1 = { id: 'l1', name: 'Bug', color: 'red' as const }
    const l2 = { id: 'l2', name: 'Feat', color: 'blue' as const }
    const prev: ProjectKanban = { ...base(), labels: [l1] }
    expect(diffKanbanOps(prev, { ...prev, labels: [l2, l1] }, P, live())).toEqual([
      { op: 'kb-label', label: l2 },
      { op: 'kb-label-order', ids: ['l2', 'l1'] }
    ])
    const two: ProjectKanban = { ...base(), labels: [l1, l2] }
    expect(diffKanbanOps(two, { ...two, labels: [l2, l1] }, P, live())).toEqual([{ op: 'kb-label-order', ids: ['l2', 'l1'] }])
  })
  it('never diffs github or pullLinks', () => {
    const prev = base()
    const next: ProjectKanban = {
      ...prev,
      github: { repository: 'a/b', columnMappings: [{ columnId: todo, label: 'status:todo' }] },
      pullLinks: { unlinked: [{ nodeId: 'n1', pull: 7 }], noAutoMove: ['n1'] }
    }
    expect(diffKanbanOps(prev, next, P, live('n1'))).toEqual([])
  })
})
