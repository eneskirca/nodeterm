// Item-level kanban mutations — the board half of the canvas:mut vocabulary. Pure: no DOM, no fs.
// Every surface that applies a board change from someone else (a peer client, the Server Edition
// canvas authority) goes through `applyKanbanOp`; every surface that publishes one builds it with
// `diffKanbanOps`. One implementation of each, so a board converges to the same bytes everywhere.
// See docs/team-presence.md for the ordering rules (seq, rule 4) these ops share with nodes/edges.

import { isRefId } from './canvas-mutations'
import { defaultKanbanFor } from './kanban-default-board'
import { boardLabels, KANBAN_LABEL_COLORS, metaList } from './kanban-labels'
import { isValidRank } from './kanban-rank'
import { sanitizeViews } from './kanban-views'
import { SYSTEM_NODE_COLORS } from './node-colors'
import { capCodePoints, UNSAFE_DISPLAY_CHARS } from './presence'
import type {
  KanbanAssignment, KanbanCardMeta, KanbanColumn, KanbanColumnCategory, KanbanLabel,
  KanbanLabelColor, KanbanOp, KanbanPriority, KanbanSavedView, ProjectKanban
} from './types'

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/
/** What a display name must never carry: C0/C1 controls (they break a name out of its one-line chip),
 *  the bidi overrides / isolates and the zero-width marks and BOM (they make a name DISPLAY as
 *  something it is not). ONE set, shared with presence names (@shared/presence). */
const UNSAFE_DISPLAY = UNSAFE_DISPLAY_CHARS
/** A column whose colour is missing or unusable keeps its place in this colour (the default board's
 *  first column), exactly as a label with a colour off its palette becomes `default`. */
const DEFAULT_COLUMN_COLOR = SYSTEM_NODE_COLORS[0]
const TITLE_MAX = 200
const COLOR_MAX = 64
const NAME_MAX = 100
const LABEL_NAME_MAX = 60 // same bound as core/project-kanban-write.ts LABEL_NAME_MAX
const LIST_MAX = 500
const PRIORITIES: readonly KanbanPriority[] = ['low', 'medium', 'high', 'urgent']
const CATEGORIES: readonly KanbanColumnCategory[] = ['unstarted', 'started', 'done', 'closed']
/** 1970 … 3000: a real due date, not a sentinel. */
const DUE_MIN = 0
const DUE_MAX = 32_503_680_000_000

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x)
const text = (x: unknown, max: number): string | null =>
  typeof x === 'string' && x.length <= max && !CONTROL.test(x) ? x : null
/**
 * A label name, column title or assignee name, REPAIRED rather than refused (ruling R5): the UI puts
 * no length cap on them, so refusing an over-long rename would make it silently never sync. Unsafe
 * characters are removed, the rest trimmed, then cut to `max` CODE POINTS (never splitting an astral
 * character in half) and trimmed again. Only what is empty once repaired is refused (`null`). Ids
 * are never passed through here — an id is an address, and a repaired one addresses the wrong thing.
 * Nor are they refused for their characters: ids are never displayed, and refusing one would stop
 * that item, and every order op listing it, ever syncing. Only a malformed id (`isRefId`: not a
 * string, empty, or past the ref bound) is refused.
 */
function displayText(x: unknown, max: number): string | null {
  if (typeof x !== 'string') return null
  const out = capCodePoints(x.replace(UNSAFE_DISPLAY, '').trim(), max).trim()
  return out ? out : null
}
const idList = (x: unknown): string[] | null => {
  if (!Array.isArray(x) || x.length > LIST_MAX || !x.every(isRefId)) return null
  return [...new Set(x as string[])]
}

function column(x: unknown): KanbanColumn | null {
  if (!isObj(x) || !isRefId(x.id)) return null
  const title = displayText(x.title, TITLE_MAX)
  if (title === null) return null
  const out: KanbanColumn = { id: x.id, title, color: text(x.color, COLOR_MAX) ?? DEFAULT_COLUMN_COLOR }
  if (CATEGORIES.includes(x.category as KanbanColumnCategory)) out.category = x.category as KanbanColumnCategory
  return out
}

function assignment(x: unknown): KanbanAssignment | null {
  if (!isObj(x) || !isRefId(x.nodeId) || !isRefId(x.columnId)) return null
  const out: KanbanAssignment = { nodeId: x.nodeId, columnId: x.columnId }
  if (isValidRank(x.rank)) out.rank = x.rank
  return out
}

function meta(x: unknown): KanbanCardMeta | null {
  if (!isObj(x) || !isRefId(x.nodeId)) return null
  const out: KanbanCardMeta = { nodeId: x.nodeId }
  if (Array.isArray(x.assignees)) {
    const a = x.assignees
      .filter(isObj)
      .map((p) => ({ name: displayText(p.name, NAME_MAX), color: text(p.color, COLOR_MAX) }))
      .filter((p): p is { name: string; color: string } => !!p.name && p.color !== null)
      .slice(0, 50)
    if (a.length) out.assignees = a
  }
  if (typeof x.dueAt === 'number' && Number.isFinite(x.dueAt) && x.dueAt >= DUE_MIN && x.dueAt <= DUE_MAX)
    out.dueAt = x.dueAt
  if (PRIORITIES.includes(x.priority as KanbanPriority)) out.priority = x.priority as KanbanPriority
  const labels = x.labels === undefined ? null : idList(x.labels)
  if (labels && labels.length) out.labels = labels
  return out
}

function label(x: unknown): KanbanLabel | null {
  if (!isObj(x) || !isRefId(x.id)) return null
  const name = displayText(x.name, LABEL_NAME_MAX)
  if (name === null) return null
  const color: KanbanLabelColor = KANBAN_LABEL_COLORS.includes(x.color as KanbanLabelColor)
    ? (x.color as KanbanLabelColor)
    : 'default'
  return { id: x.id, name, color }
}

function view(x: unknown): KanbanSavedView | null {
  const v = sanitizeViews([x])
  return v && v.length === 1 ? v[0] : null
}

/** Is this an op name this module owns? (Shape is `sanitizeKanbanOp`'s job.) */
export function isKanbanOp(m: { op?: unknown }): boolean {
  return typeof m.op === 'string' && m.op.startsWith('kb-')
}

/** The sanitized op, or null to REFUSE it. Refusals are whole-op (a malformed id addresses the wrong
 *  thing); repairable fields are repaired or dropped — colour (a column's to the default colour, a
 *  label's to `default`), rank, priority, dueAt, category, and the display text (label name, column
 *  title, assignee name: see `displayText`). */
export function sanitizeKanbanOp(m: unknown): KanbanOp | null {
  if (!isObj(m)) return null
  switch (m.op) {
    case 'kb-column': { const c = column(m.column); return c && { op: 'kb-column', column: c } }
    case 'kb-column-remove': return isRefId(m.id) ? { op: 'kb-column-remove', id: m.id } : null
    case 'kb-column-order': { const ids = idList(m.ids); return ids && { op: 'kb-column-order', ids } }
    case 'kb-card': { const a = assignment(m.assignment); return a && { op: 'kb-card', assignment: a } }
    case 'kb-card-remove': return isRefId(m.nodeId) ? { op: 'kb-card-remove', nodeId: m.nodeId } : null
    case 'kb-meta': { const x = meta(m.meta); return x && { op: 'kb-meta', meta: x } }
    case 'kb-meta-remove': return isRefId(m.nodeId) ? { op: 'kb-meta-remove', nodeId: m.nodeId } : null
    case 'kb-label': { const l = label(m.label); return l && { op: 'kb-label', label: l } }
    case 'kb-label-remove': return isRefId(m.id) ? { op: 'kb-label-remove', id: m.id } : null
    case 'kb-label-order': { const ids = idList(m.ids); return ids && { op: 'kb-label-order', ids } }
    case 'kb-view': { const v = view(m.view); return v && { op: 'kb-view', view: v } }
    case 'kb-view-remove': return isRefId(m.id) ? { op: 'kb-view-remove', id: m.id } : null
    default: return null
  }
}

/**
 * The ordering key (canvas-order): one `k:` space with a sub-prefix per item kind.
 *
 * The two ORDER ops are per-project SINGLETONS, so their key carries the project (ruling R4): one
 * `CanvasOrder` orders every loaded project, and an unscoped `k:colorder` let our unacked reorder in
 * project A hold off (rule 2) a peer's reorder in project B. Every other key names an item whose id
 * is already unique across projects — a card/meta by its node id (global), a column by a
 * per-project seeded or random id, a label or view by a random id — so it needs no scope.
 */
export function kanbanOpKey(m: KanbanOp, projectId: string): string {
  switch (m.op) {
    case 'kb-column': return `k:col:${m.column.id}`
    case 'kb-column-remove': return `k:col:${m.id}`
    case 'kb-column-order': return `k:colorder:${projectId}`
    case 'kb-card': return `k:card:${m.assignment.nodeId}`
    case 'kb-card-remove': return `k:card:${m.nodeId}`
    case 'kb-meta': return `k:meta:${m.meta.nodeId}`
    case 'kb-meta-remove': return `k:meta:${m.nodeId}`
    case 'kb-label': return `k:label:${m.label.id}`
    case 'kb-label-remove': return `k:label:${m.id}`
    case 'kb-label-order': return `k:labelorder:${projectId}`
    case 'kb-view': return `k:view:${m.view.id}`
    case 'kb-view-remove': return `k:view:${m.id}`
  }
}

/** Rule-4 deletions: the thing is gone. A card/meta removal is a VALUE ("no placement", "no meta")
 *  and orders like any other write. */
export function isKanbanDeletion(m: KanbanOp): boolean {
  return m.op === 'kb-column-remove' || m.op === 'kb-label-remove' || m.op === 'kb-view-remove'
}

// The board's lists, read TOLERANTLY. A board reaches a project through the load seam
// (`sanitizeKanban`), which admits a non-list `meta` / `labels` / `views` and non-record entries in
// them (types.ts: "tolerated as absent/malformed by every reader") — and the reducer and the diff
// are readers. A throw here is not a refused op, it is a dead board sync for that project on every
// edit. Malformed entries are invisible to both: the diff never casts them, and the one op that
// writes a list back writes it clean.
const isEntry = <K extends string>(key: K) => (x: unknown): x is Record<K, string> =>
  isObj(x) && typeof x[key] === 'string'
const columnsOf = (b: ProjectKanban): KanbanColumn[] =>
  Array.isArray(b.columns) ? b.columns.filter(isEntry('id')) as KanbanColumn[] : []
const assignmentsOf = (b: ProjectKanban): KanbanAssignment[] =>
  Array.isArray(b.assignments)
    ? (b.assignments.filter((a) => isEntry('nodeId')(a) && typeof (a as { columnId?: unknown }).columnId === 'string') as KanbanAssignment[])
    : []
const metaOf = (b: ProjectKanban): KanbanCardMeta[] => metaList(b).filter(isEntry('nodeId')) as KanbanCardMeta[]
const labelsOf = (b: ProjectKanban): KanbanLabel[] => boardLabels(b)
const viewsOf = (b: ProjectKanban): KanbanSavedView[] =>
  Array.isArray(b.views) ? b.views.filter(isEntry('id')) as KanbanSavedView[] : []
/** Every node id a board's cards and card metadata name, read tolerantly. */
export function boardNodeIds(b: ProjectKanban | undefined): string[] {
  if (!b) return []
  return [...assignmentsOf(b).map((a) => a.nodeId), ...metaOf(b).map((x) => x.nodeId)]
}

/** A card's label ids, whatever a malformed file put there. */
const cardLabelIds = (x: KanbanCardMeta): string[] =>
  Array.isArray(x.labels) ? x.labels.filter((l): l is string => typeof l === 'string') : []

/**
 * Order `list` by an order op's `ids`: the listed items first, in that order, then every item the op
 * does not list, SORTED BY ID. An order op names only the ids its sender knew, so an item a teammate
 * added concurrently is unlisted, and appending the unlisted ones in each replica's own (arrival)
 * order left three concurrent adds in different orders on different boards (D5). Sorted, every
 * replica that applies the winning op to the same set of items lands on the same list; the sender
 * applies its own winning op too (canvas-order `accept`). Compared by code unit, never by locale.
 */
function reorder<T extends { id: string }>(list: T[], ids: string[]): T[] {
  const byId = new Map(list.map((x) => [x.id, x]))
  const head = ids.map((id) => byId.get(id)).filter((x): x is T => !!x)
  const listed = new Set(head.map((x) => x.id))
  const rest = list.filter((x) => !listed.has(x.id)).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return [...head, ...rest]
}

function upsertById<T extends { id: string }>(list: T[] | undefined, item: T): T[] {
  const cur = list ?? []
  const i = cur.findIndex((x) => x.id === item.id)
  if (i === -1) return [...cur, item]
  const next = cur.slice()
  next[i] = item
  return next
}

/** Insert a placement so its column stays in rank order in the ARRAY (a build that ignores `rank`
 *  reads array order, see ProjectKanban.assignments). An INVALID rank is treated exactly as an absent
 *  one, on both sides — the rule `columnOrder` reads by: the incoming card goes to the end of its
 *  column, and an entry already placed with an invalid rank sits with its array predecessor, so it
 *  is never the one a valid rank is compared against (`'zz' > 'a1'` as strings, but `zz` is no rank). */
function placeCard(assignments: KanbanAssignment[], a: KanbanAssignment): KanbanAssignment[] {
  const rest = assignments.filter((x) => x.nodeId !== a.nodeId)
  const sameCol: number[] = []
  rest.forEach((x, i) => { if (x.columnId === a.columnId) sameCol.push(i) })
  if (!sameCol.length) return [...rest, a]
  const rank = a.rank
  const before = isValidRank(rank)
    ? sameCol.find((i) => { const r = rest[i].rank; return isValidRank(r) && r > rank })
    : undefined
  const at = before ?? sameCol[sameCol.length - 1] + 1
  return [...rest.slice(0, at), a, ...rest.slice(at)]
}

/** Apply one (already sanitized) op. Pure; returns a new board. An absent board is the project's
 *  deterministic lazy default — exactly what every client was showing. */
export function applyKanbanOp(board: ProjectKanban | undefined, m: KanbanOp, projectId: string): ProjectKanban {
  const b: ProjectKanban = board ?? defaultKanbanFor(projectId)
  switch (m.op) {
    case 'kb-column': return { ...b, columns: upsertById(columnsOf(b), m.column) }
    case 'kb-column-remove':
      return {
        ...b,
        columns: columnsOf(b).filter((c) => c.id !== m.id),
        assignments: assignmentsOf(b).filter((a) => a.columnId !== m.id)
      }
    case 'kb-column-order': return { ...b, columns: reorder(columnsOf(b), m.ids) }
    case 'kb-card': return { ...b, assignments: placeCard(assignmentsOf(b), m.assignment) }
    case 'kb-card-remove': return { ...b, assignments: assignmentsOf(b).filter((a) => a.nodeId !== m.nodeId) }
    case 'kb-meta': {
      const cur = metaOf(b)
      const i = cur.findIndex((x) => x.nodeId === m.meta.nodeId)
      const next = i === -1 ? [...cur, m.meta] : cur.map((x, j) => (j === i ? m.meta : x))
      return { ...b, meta: next }
    }
    case 'kb-meta-remove': {
      const next = metaOf(b).filter((x) => x.nodeId !== m.nodeId)
      return { ...b, meta: next }
    }
    case 'kb-label': return { ...b, labels: upsertById(labelsOf(b), m.label) }
    case 'kb-label-remove': {
      const meta = metaOf(b)
        // Any `labels` field is rewritten from its valid ids minus the removed one, which also
        // repairs a malformed list; a card with no field is left exactly as it was.
        .map((x) => (x.labels === undefined ? x : { ...x, labels: cardLabelIds(x).filter((l) => l !== m.id) }))
        .map((x) => (x.labels && x.labels.length === 0 ? (({ labels: _l, ...rest }) => rest)(x) : x))
        .filter((x) => Object.keys(x).length > 1) // an entry with only nodeId is "no metadata"
      return { ...b, labels: labelsOf(b).filter((l) => l.id !== m.id), meta }
    }
    case 'kb-label-order': return { ...b, labels: reorder(labelsOf(b), m.ids) }
    case 'kb-view': return { ...b, views: upsertById(viewsOf(b), m.view) }
    case 'kb-view-remove': return { ...b, views: viewsOf(b).filter((v) => v.id !== m.id) }
  }
}

function stable(v: unknown): string {
  return JSON.stringify(v, (_k, val) =>
    isObj(val) ? Object.fromEntries(Object.keys(val).sort().map((k) => [k, val[k]])) : val)
}
const same = (a: unknown, b: unknown): boolean => stable(a) === stable(b)

/**
 * Does a list need its order op? When it GAINED an id, or the relative order of the ids both sides
 * share changed (ruling R3). The first half is what makes a list converge: an item op only says the
 * item exists, and a peer that applies it alone appends it — so a column inserted mid-list (the
 * UI's add-then-move, a git pull) landed last everywhere else, and two people adding a column at
 * once ended A at …,X,Y and B at …,Y,X. With the order op every replica lands on the LATER order
 * op's list. A pure removal needs none: dropping an id never reorders the rest.
 * An order op lists only the ids its sender knew, so ids added concurrently by OTHER clients are not
 * in it. They follow the listed ones sorted by id (`reorder`), and the op's own sender re-applies it
 * on its echo (canvas-order `accept`), so three or more concurrent adds converge on every replica
 * in every interleaving (kanban-ops.convergence.test.ts enumerates them).
 */
function orderChanged(prevIds: string[], nextIds: string[]): boolean {
  const had = new Set(prevIds)
  if (nextIds.some((id) => !had.has(id))) return true
  const kept = new Set(nextIds)
  const common = prevIds.filter((id) => kept.has(id))
  const commonSet = new Set(common)
  return !same(common, nextIds.filter((id) => commonSet.has(id)))
}

/**
 * The item-level ops that turn `prev` into `next`. Never casts `github` / `pullLinks` (outside the
 * vocabulary). Never casts the removal of a DEAD card's placement or meta: pruning is a local, lazy
 * cleanup, and a peer whose node op has not arrived yet would otherwise delete a fresh card.
 * Batch order: upserts (columns, column order, labels, label order, views, cards, meta), then
 * removals (meta, cards, views, labels, columns). Reads both boards tolerantly (see `metaOf`), so a
 * malformed list on either side is never a throw — its junk entries are simply not ops.
 */
export function diffKanbanOps(
  prev: ProjectKanban | undefined,
  next: ProjectKanban | undefined,
  projectId: string,
  liveNodeIds: ReadonlySet<string>
): KanbanOp[] {
  if (!next) return []
  const p = prev ?? defaultKanbanFor(projectId)
  const up: KanbanOp[] = []
  const down: KanbanOp[] = []

  const pColumns = columnsOf(p)
  const nColumns = columnsOf(next)
  const pCols = new Map(pColumns.map((c) => [c.id, c]))
  for (const c of nColumns) if (!same(pCols.get(c.id), c)) up.push({ op: 'kb-column', column: c })
  const nColIds = nColumns.map((c) => c.id)
  if (orderChanged(pColumns.map((c) => c.id), nColIds)) up.push({ op: 'kb-column-order', ids: nColIds })

  const pLabelList = labelsOf(p)
  const nLabelList = labelsOf(next)
  const pLabels = new Map(pLabelList.map((l) => [l.id, l]))
  for (const l of nLabelList) if (!same(pLabels.get(l.id), l)) up.push({ op: 'kb-label', label: l })
  const nLabelIds = nLabelList.map((l) => l.id)
  if (orderChanged(pLabelList.map((l) => l.id), nLabelIds)) up.push({ op: 'kb-label-order', ids: nLabelIds })

  const pViewList = viewsOf(p)
  const pViews = new Map(pViewList.map((v) => [v.id, v]))
  for (const v of viewsOf(next)) if (!same(pViews.get(v.id), v)) up.push({ op: 'kb-view', view: v })

  const pAssignments = assignmentsOf(p)
  const nAssignments = assignmentsOf(next)
  const pCards = new Map(pAssignments.map((a) => [a.nodeId, a]))
  for (const a of nAssignments) if (!same(pCards.get(a.nodeId), a)) up.push({ op: 'kb-card', assignment: a })
  const pMetaList = metaOf(p)
  const nMetaList = metaOf(next)
  const pMeta = new Map(pMetaList.map((x) => [x.nodeId, x]))
  for (const x of nMetaList) if (!same(pMeta.get(x.nodeId), x)) up.push({ op: 'kb-meta', meta: x })

  const nMeta = new Set(nMetaList.map((x) => x.nodeId))
  for (const x of pMetaList) if (!nMeta.has(x.nodeId) && liveNodeIds.has(x.nodeId)) down.push({ op: 'kb-meta-remove', nodeId: x.nodeId })
  const nCards = new Set(nAssignments.map((a) => a.nodeId))
  const nColSet = new Set(nColIds)
  for (const a of pAssignments) {
    // A placement that vanished because its COLUMN was removed is covered by kb-column-remove.
    if (!nCards.has(a.nodeId) && liveNodeIds.has(a.nodeId) && nColSet.has(a.columnId))
      down.push({ op: 'kb-card-remove', nodeId: a.nodeId })
  }
  const nViews = new Set(viewsOf(next).map((v) => v.id))
  for (const v of pViewList) if (!nViews.has(v.id)) down.push({ op: 'kb-view-remove', id: v.id })
  const nLabels = new Set(nLabelIds)
  for (const l of pLabelList) if (!nLabels.has(l.id)) down.push({ op: 'kb-label-remove', id: l.id })
  for (const c of pColumns) if (!nColSet.has(c.id)) down.push({ op: 'kb-column-remove', id: c.id })

  return [...up, ...down]
}
