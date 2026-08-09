import type { BoardLogAuthor, CanvasNodeState, KanbanAssignment, KanbanCardMeta, KanbanColumn, KanbanLabel, KanbanLabelColor, KanbanPriority, Project, ProjectKanban } from '@shared/types'
import { NODE_COLORS } from '../state/workspace'

// Pure kanban board transforms — the ONLY place board structure changes. The UI computes
// the next board here and hands it whole to setProjectKanban (no second live source).
// Every function returns a new board; unknown ids are no-ops returning the input.
// Cards are the project's SESSION NODES — the board stores only column assignments; a
// session with no (or dangling) assignment sits in the virtual Ungrouped column.

const kid = (prefix: string): string => `${prefix}-${Math.random().toString(36).slice(2, 10)}`

/** Default board for a project whose file has no `kanban` yet. NOT written to disk
 *  until the first user edit (the spec's lazy-default rule). */
export function defaultKanban(): ProjectKanban {
  return {
    columns: [
      { id: kid('kcol'), title: 'To Do', color: NODE_COLORS[0] },
      { id: kid('kcol'), title: 'In Progress', color: NODE_COLORS[2] },
      { id: kid('kcol'), title: 'Done', color: NODE_COLORS[1] }
    ],
    assignments: []
  }
}

/** Color for the next added column — cycles the node palette. */
export function nextColumnColor(k: ProjectKanban): string {
  return NODE_COLORS[k.columns.length % NODE_COLORS.length]
}

export function addColumn(k: ProjectKanban, title: string, color: string): ProjectKanban {
  return { ...k, columns: [...k.columns, { id: kid('kcol'), title, color }] }
}

export function renameColumn(k: ProjectKanban, columnId: string, title: string): ProjectKanban {
  return { ...k, columns: k.columns.map((c) => (c.id === columnId ? { ...c, title } : c)) }
}

export function recolorColumn(k: ProjectKanban, columnId: string, color: string): ProjectKanban {
  return { ...k, columns: k.columns.map((c) => (c.id === columnId ? { ...c, color } : c)) }
}

/** Moves a column before `beforeId` (null = to the end). */
export function moveColumn(k: ProjectKanban, columnId: string, beforeId: string | null): ProjectKanban {
  if (columnId === beforeId) return k
  const dragged = k.columns.find((c) => c.id === columnId)
  if (!dragged) return k
  const without = k.columns.filter((c) => c.id !== columnId)
  const idx = beforeId ? without.findIndex((c) => c.id === beforeId) : -1
  const at = idx === -1 ? without.length : idx
  return { ...k, columns: [...without.slice(0, at), dragged, ...without.slice(at)] }
}

/** Deletes a user column; its assigned sessions return to Ungrouped (assignments drop).
 *  Non-destructive by design — sessions are untouched, so no confirm dialog and no
 *  last-column rule (the virtual Ungrouped column always remains). */
export function deleteColumn(k: ProjectKanban, columnId: string): ProjectKanban {
  if (!k.columns.some((c) => c.id === columnId)) return k
  const github = (() => {
    if (!k.github) return undefined
    const { completionColumnId, ...rest } = k.github
    return {
      ...rest,
      columnMappings: k.github.columnMappings.filter((mapping) => mapping.columnId !== columnId),
      ...(completionColumnId && completionColumnId !== columnId ? { completionColumnId } : {})
    }
  })()
  return {
    ...k,
    columns: k.columns.filter((c) => c.id !== columnId),
    assignments: k.assignments.filter((a) => a.columnId !== columnId),
    ...(github ? { github } : {})
  }
}

/** Node ids assigned to `columnId`, in board order. */
export function assignedTo(k: ProjectKanban, columnId: string): string[] {
  return k.assignments.filter((a) => a.columnId === columnId).map((a) => a.nodeId)
}

/** Ids from `sessionIds` with no live assignment — never assigned, or assigned to a column
 *  that no longer exists (e.g. a git merge kept the assignment but lost the column). Order
 *  follows `sessionIds` (= canvas order). */
export function unassigned(k: ProjectKanban, sessionIds: string[]): string[] {
  const cols = new Set(k.columns.map((c) => c.id))
  const assigned = new Set(
    k.assignments.filter((a) => cols.has(a.columnId)).map((a) => a.nodeId)
  )
  return sessionIds.filter((id) => !assigned.has(id))
}

/** Assigns/moves a session card. `columnId` null = back to Ungrouped (assignment removed;
 *  Ungrouped order is canvas order, so `beforeNodeId` is ignored there). Inserts before
 *  `beforeNodeId`'s assignment when that assignment is in the target column, else at the
 *  end. Unknown target column is a no-op. */
export function assignNode(
  k: ProjectKanban,
  nodeId: string,
  columnId: string | null,
  beforeNodeId: string | null
): ProjectKanban {
  if (nodeId === beforeNodeId) return k
  if (columnId === null) {
    if (!k.assignments.some((a) => a.nodeId === nodeId)) return k
    return { ...k, assignments: k.assignments.filter((a) => a.nodeId !== nodeId) }
  }
  if (!k.columns.some((c) => c.id === columnId)) return k
  const moved: KanbanAssignment = { nodeId, columnId }
  const without = k.assignments.filter((a) => a.nodeId !== nodeId)
  const before = beforeNodeId
    ? without.find((a) => a.nodeId === beforeNodeId && a.columnId === columnId)
    : undefined
  const idx = before ? without.indexOf(before) : -1
  const at = idx === -1 ? without.length : idx
  return { ...k, assignments: [...without.slice(0, at), moved, ...without.slice(at)] }
}

/** Drops assignments of nodes that no longer exist. Returns the SAME object when nothing
 *  changed, so callers can cheaply skip a no-op persist. */
export function pruneAssignments(k: ProjectKanban, liveIds: string[]): ProjectKanban {
  const live = new Set(liveIds)
  const assignments = k.assignments.filter((a) => live.has(a.nodeId))
  const meta = metaList(k).filter((m) => m && live.has(m.nodeId))
  const sameAssignments = assignments.length === k.assignments.length
  const sameMeta = meta.length === metaList(k).length
  if (sameAssignments && sameMeta) return k
  const next: ProjectKanban = { ...k, assignments }
  if (Array.isArray(k.meta)) {
    if (meta.length) next.meta = meta
    else delete next.meta
  }
  return next
}

/** The column a node is assigned to, resolved against a project's board — undefined when
 *  unassigned, dangling (column deleted elsewhere), or the project has no board yet. All
 *  three mean Ungrouped, and the canvas shows no column pill for Ungrouped. */
export function columnForNode(
  k: ProjectKanban | undefined,
  nodeId: string
): KanbanColumn | undefined {
  if (!k) return undefined
  const a = k.assignments.find((x) => x.nodeId === nodeId)
  return a ? k.columns.find((c) => c.id === a.columnId) : undefined
}

/** Tolerant read of a card's metadata — `meta` may be absent or (hand-edited) malformed. */
export function cardMeta(k: ProjectKanban, nodeId: string): KanbanCardMeta | undefined {
  if (!Array.isArray(k.meta)) return undefined
  return k.meta.find((m) => m && m.nodeId === nodeId)
}

const metaList = (k: ProjectKanban): KanbanCardMeta[] => (Array.isArray(k.meta) ? k.meta : [])

/** Writes one card's meta back; an entry with no fields left is DROPPED (absent = clean file),
 *  and an emptied meta array drops the key entirely. */
function withCardMeta(
  k: ProjectKanban,
  nodeId: string,
  next: Omit<KanbanCardMeta, 'nodeId'> | null
): ProjectKanban {
  const rest = metaList(k).filter((m) => m && m.nodeId !== nodeId)
  const keep =
    next &&
    ((next.assignees?.length ?? 0) > 0 ||
      next.dueAt !== undefined ||
      next.priority !== undefined ||
      (next.labels?.length ?? 0) > 0)
  const meta = keep ? [...rest, { nodeId, ...next }] : rest
  const { meta: _m, ...bare } = k
  return meta.length ? { ...bare, meta } : bare
}

/** Adds the person to the card (or removes them if already assigned — matched by NAME, the
 *  presence identity's stable part; color is display-only and may drift per machine). */
export function toggleAssignee(
  k: ProjectKanban,
  nodeId: string,
  person: BoardLogAuthor
): ProjectKanban {
  const cur = cardMeta(k, nodeId)
  const had = (cur?.assignees ?? []).some((a) => a.name === person.name)
  const assignees = had
    ? (cur?.assignees ?? []).filter((a) => a.name !== person.name)
    : [...(cur?.assignees ?? []), person]
  return withCardMeta(k, nodeId, {
    assignees,
    dueAt: cur?.dueAt,
    priority: cur?.priority,
    labels: cur?.labels
  })
}

/** Sets (or clears, with null) the card's due timestamp. */
export function setCardDue(k: ProjectKanban, nodeId: string, dueAt: number | null): ProjectKanban {
  const cur = cardMeta(k, nodeId)
  return withCardMeta(k, nodeId, {
    assignees: cur?.assignees,
    priority: cur?.priority,
    labels: cur?.labels,
    ...(dueAt === null ? {} : { dueAt })
  })
}

/** Sets (or clears, with null) the card's priority. */
export function setCardPriority(
  k: ProjectKanban,
  nodeId: string,
  priority: KanbanPriority | null
): ProjectKanban {
  const cur = cardMeta(k, nodeId)
  return withCardMeta(k, nodeId, {
    assignees: cur?.assignees,
    dueAt: cur?.dueAt,
    labels: cur?.labels,
    ...(priority === null ? {} : { priority })
  })
}

// ── Board labels (Notion-style palette) ──────────────────────────────────────────────────────

/** Ordered color palette for the picker (also the fallback order). Chip colors live in the UI
 *  (`kanbanLabelColors.ts`); this is the closed set of names only. */
export const KANBAN_LABEL_COLORS: KanbanLabelColor[] = [
  'default',
  'gray',
  'brown',
  'orange',
  'yellow',
  'green',
  'blue',
  'purple',
  'pink',
  'red'
]

/** Normalize any read color to a known palette value ('default' for garbage from a hand-edited file). */
export function labelColor(c: unknown): KanbanLabelColor {
  return KANBAN_LABEL_COLORS.includes(c as KanbanLabelColor) ? (c as KanbanLabelColor) : 'default'
}

/** The board's label palette (defensive against a missing/garbage array), ids+names deduped-safe. */
export function boardLabels(k: ProjectKanban): KanbanLabel[] {
  if (!Array.isArray(k.labels)) return []
  return k.labels.filter(
    (l): l is KanbanLabel => !!l && typeof l.id === 'string' && typeof l.name === 'string'
  )
}

/** The resolved labels applied to a card, in palette order, dropping ids with no matching label. */
export function labelsForCard(k: ProjectKanban, nodeId: string): KanbanLabel[] {
  const ids = cardMeta(k, nodeId)?.labels
  if (!Array.isArray(ids) || !ids.length) return []
  const set = new Set(ids)
  return boardLabels(k).filter((l) => set.has(l.id))
}

/** Create a new board label; returns the next board AND the new id (so the caller can select it). */
export function createLabel(
  k: ProjectKanban,
  name: string,
  color: KanbanLabelColor
): { k: ProjectKanban; id: string } {
  const id = kid('klbl')
  const label: KanbanLabel = { id, name: name.trim(), color: labelColor(color) }
  return { k: { ...k, labels: [...boardLabels(k), label] }, id }
}

export function renameLabel(k: ProjectKanban, id: string, name: string): ProjectKanban {
  return { ...k, labels: boardLabels(k).map((l) => (l.id === id ? { ...l, name: name.trim() } : l)) }
}

export function recolorLabel(k: ProjectKanban, id: string, color: KanbanLabelColor): ProjectKanban {
  return {
    ...k,
    labels: boardLabels(k).map((l) => (l.id === id ? { ...l, color: labelColor(color) } : l))
  }
}

/** Deletes a board label AND strips its id from every card's meta (no dangling references). */
export function deleteLabel(k: ProjectKanban, id: string): ProjectKanban {
  const labels = boardLabels(k).filter((l) => l.id !== id)
  const meta = metaList(k)
    .map((m) => (m?.labels?.includes(id) ? { ...m, labels: m.labels.filter((x) => x !== id) } : m))
    // an entry emptied to nothing but the nodeId is dropped, matching withCardMeta's invariant
    .filter(
      (m) =>
        (m.assignees?.length ?? 0) > 0 ||
        m.dueAt !== undefined ||
        m.priority !== undefined ||
        (m.labels?.length ?? 0) > 0
    )
  const { labels: _l, meta: _m, ...bare } = k
  return {
    ...bare,
    ...(labels.length ? { labels } : {}),
    ...(meta.length ? { meta } : {})
  }
}

/** Moves a label before `beforeId` (null = to the end) — the palette's display order. */
export function reorderLabels(k: ProjectKanban, id: string, beforeId: string | null): ProjectKanban {
  if (id === beforeId) return k
  const labels = boardLabels(k)
  const dragged = labels.find((l) => l.id === id)
  if (!dragged) return k
  const without = labels.filter((l) => l.id !== id)
  const idx = beforeId ? without.findIndex((l) => l.id === beforeId) : -1
  const at = idx === -1 ? without.length : idx
  return { ...k, labels: [...without.slice(0, at), dragged, ...without.slice(at)] }
}

/** Toggle a label on a card (add if absent, remove if present). Preserves the card's other meta. */
export function toggleCardLabel(k: ProjectKanban, nodeId: string, labelId: string): ProjectKanban {
  const cur = cardMeta(k, nodeId)
  const has = (cur?.labels ?? []).includes(labelId)
  const labels = has
    ? (cur?.labels ?? []).filter((x) => x !== labelId)
    : [...(cur?.labels ?? []), labelId]
  return withCardMeta(k, nodeId, {
    assignees: cur?.assignees,
    dueAt: cur?.dueAt,
    priority: cur?.priority,
    labels
  })
}

/** Does a card pass the label filter? Empty filter = everything; otherwise the card must carry
 *  AT LEAST ONE of the selected labels (OR semantics, like Trello's default). */
export function cardMatchesLabelFilter(
  k: ProjectKanban,
  nodeId: string,
  filterIds: readonly string[]
): boolean {
  if (!filterIds.length) return true
  const on = new Set(cardMeta(k, nodeId)?.labels ?? [])
  return filterIds.some((id) => on.has(id))
}

/** Set a card's exact label list (dedup; empty drops the field/entry). */
export function setCardLabels(k: ProjectKanban, nodeId: string, ids: string[]): ProjectKanban {
  const cur = cardMeta(k, nodeId)
  const labels = [...new Set(ids)]
  return withCardMeta(k, nodeId, {
    assignees: cur?.assignees,
    dueAt: cur?.dueAt,
    priority: cur?.priority,
    ...(labels.length ? { labels } : {})
  })
}

/** Auto-color for a created label: rotate the palette skipping 'default' (Notion-style). */
export function autoLabelColor(k: ProjectKanban): KanbanLabelColor {
  const colors = KANBAN_LABEL_COLORS.filter((c) => c !== 'default')
  return colors[boardLabels(k).length % colors.length]
}

// ── Unification: legacy free-text node tags → board labels ────────────────────────────────────

/** Fold each node's free-text tags into board labels: reuse an existing label by name (case-
 *  insensitive) or create one (auto-colored), then apply its id to that card. Pure; the caller
 *  clears the nodes' `tags`. Idempotent by construction (an empty tag list contributes nothing). */
export function migrateTagsToLabels(
  k: ProjectKanban,
  nodeTags: Array<{ nodeId: string; tags: string[] }>
): ProjectKanban {
  let board = k
  for (const { nodeId, tags } of nodeTags) {
    const names = [...new Set(tags.map((t) => t.trim()).filter(Boolean))]
    if (!names.length) continue
    const ids: string[] = []
    for (const name of names) {
      const existing = boardLabels(board).find((l) => l.name.toLowerCase() === name.toLowerCase())
      if (existing) ids.push(existing.id)
      else {
        const res = createLabel(board, name, autoLabelColor(board))
        board = res.k
        ids.push(res.id)
      }
    }
    const cur = cardMeta(board, nodeId)?.labels ?? []
    board = setCardLabels(board, nodeId, [...cur, ...ids])
  }
  return board
}

/**
 * One-time per-project unification, run at workspace hydrate (idempotent — a project whose nodes
 * carry no `tags` is returned UNCHANGED, by identity). For every node with `tags`:
 *  - the legacy `['claude']` MARKER is honored (agentId ← 'claude' when unset) — it was never a
 *    user tag, so it is NOT turned into a label (mirrors nodeStatesToFlow's own claude migration);
 *  - every other tag becomes a board label (reused/created) applied to that card;
 *  - the node's `tags` field is dropped (so the next hydrate is a no-op).
 */
export function migrateProjectTags(project: Project): Project {
  const tagged = project.nodes.filter((n) => Array.isArray(n.tags) && n.tags.length > 0)
  if (!tagged.length) return project
  const nodeTags = tagged
    .map((n) => ({ nodeId: n.id, tags: (n.tags as string[]).filter((t) => t !== 'claude') }))
    .filter((x) => x.tags.length > 0)
  const kanban = migrateTagsToLabels(project.kanban ?? defaultKanban(), nodeTags)
  const nodes: CanvasNodeState[] = project.nodes.map((n) => {
    if (!Array.isArray(n.tags) || !n.tags.length) return n
    const hadClaude = n.tags.includes('claude')
    const { tags: _t, ...rest } = n
    return !n.agentId && hadClaude ? { ...rest, agentId: 'claude' } : rest
  })
  return { ...project, nodes, kanban }
}
