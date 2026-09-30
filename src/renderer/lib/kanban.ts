import type {
  CanvasNodeState, KanbanColumn, KanbanColumnCategory, Project, ProjectKanban
} from '@shared/types'
import { columnCategory } from '@shared/kanban-category'
import { columnOrder, placeAssignment, type CardAnchor } from '@shared/kanban-order'
import { SYSTEM_NODE_COLORS } from '../state/workspace'
import { defaultKanbanFor } from '@shared/kanban-default-board'
import { autoLabelColor, boardLabels, cardMeta, createLabel, metaList, setCardLabels } from '@shared/kanban-labels'
import { prunePullLinks } from '@shared/kanban-pull-links'

// The card-meta + label transforms live in `@shared/kanban-labels` (the host core applies the
// same ones for the phone's label verb); re-exported so every renderer import stays as it was.
export * from '@shared/kanban-labels'

// Pure kanban board transforms — the ONLY place board structure changes. The UI computes
// the next board here and hands it whole to setProjectKanban (no second live source).
// Every function returns a new board; unknown ids are no-ops returning the input.
// Cards are the project's SESSION NODES — the board stores only column assignments; a
// session with no (or dangling) assignment sits in the virtual Ungrouped column.

const kid = (prefix: string): string => `${prefix}-${Math.random().toString(36).slice(2, 10)}`

/** Default board for a project whose file has no `kanban` yet. NOT written to disk
 *  until the first user edit (the spec's lazy-default rule) — EXCEPT when the phone asks for one
 *  outright (relay `projects.ensureBoard`), which seeds the same three columns from the same
 *  shared definition so a board born on either surface is the same board.
 *
 *  Its column ids are DETERMINISTIC per project (`defaultKanbanFor`): every client renders this
 *  board until someone edits it, and with boards syncing live two clients' first edits must land on
 *  the same three columns, not six. So it takes the project it is the default OF — never pass the
 *  active project's default for another project's board. */
export function defaultKanban(projectId: string): ProjectKanban {
  return defaultKanbanFor(projectId)
}

/** Color for the next added column — cycles the node palette. */
export function nextColumnColor(k: ProjectKanban): string {
  return SYSTEM_NODE_COLORS[k.columns.length % SYSTEM_NODE_COLORS.length]
}

export function addColumn(k: ProjectKanban, title: string, color: string): ProjectKanban {
  const column = { id: kid('kcol'), title, color }
  if (!k.github) return { ...k, columns: [...k.columns, column] }
  const base = `status:${title.trim().toLocaleLowerCase('en-US')
    .normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '') || 'column'}`
  const used = new Set(k.github.columnMappings.map((mapping) =>
    mapping.label.normalize('NFKC').toLocaleLowerCase('en-US')))
  let label = base.slice(0, 50)
  for (let suffix = 2; used.has(label.toLocaleLowerCase('en-US')); suffix++) {
    const ending = `-${suffix}`
    label = `${base.slice(0, 50 - ending.length)}${ending}`
  }
  return {
    ...k,
    columns: [...k.columns, column],
    github: {
      ...k.github,
      columnMappings: [...k.github.columnMappings, { columnId: column.id, label }]
    }
  }
}

export function renameColumn(k: ProjectKanban, columnId: string, title: string): ProjectKanban {
  return { ...k, columns: k.columns.map((c) => (c.id === columnId ? { ...c, title } : c)) }
}

export function recolorColumn(k: ProjectKanban, columnId: string, color: string): ProjectKanban {
  return { ...k, columns: k.columns.map((c) => (c.id === columnId ? { ...c, color } : c)) }
}

/** Sets (or, with `undefined`, clears) a column's lifecycle category. Returns the SAME board when
 *  nothing changes (unknown column, or the value it already reads as), so a caller can skip a
 *  no-op persist. The UI confirms first when the column holds cards (`categoryChangeImpact`). */
export function setColumnCategory(
  k: ProjectKanban,
  columnId: string,
  category: KanbanColumnCategory | undefined
): ProjectKanban {
  const target = k.columns.find((c) => c.id === columnId)
  if (!target || columnCategory(target) === columnCategory({ category })) return k
  return {
    ...k,
    columns: k.columns.map((c) => {
      if (c.id !== columnId) return c
      const { category: _old, ...rest } = c
      return category ? { ...rest, category } : rest
    })
  }
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

/** Node ids assigned to `columnId`, in board order — rank first, array order for entries without
 *  one (@shared/kanban-order). Every board reader goes through this. */
export function assignedTo(k: ProjectKanban, columnId: string): string[] {
  return columnOrder(k.assignments, columnId).map((a) => a.nodeId)
}

/**
 * Resolve a user-supplied column reference (from the canvas-control `assign` verb) to a column
 * id. Empty or 'ungrouped' (case-insensitive) → `null` (the virtual Ungrouped column = unassign).
 * Otherwise match by exact id first, then by case-insensitive title. Unknown → `undefined`, so the
 * caller can distinguish "send to Ungrouped" (null) from "no such column" (undefined) and report
 * the available columns. Agents naturally pass a title ("In Progress"); ids come from `board`.
 */
export function resolveColumnRef(k: ProjectKanban, ref: string): string | null | undefined {
  const raw = ref.trim()
  if (!raw || raw.toLowerCase() === 'ungrouped') return null
  const byId = k.columns.find((c) => c.id === raw)
  if (byId) return byId.id
  const byTitle = k.columns.find((c) => c.title.toLowerCase() === raw.toLowerCase())
  return byTitle ? byTitle.id : undefined
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

/** The explicit "bottom of the column" anchor for `assignNode` — a drop BELOW the last card, or on
 *  the column's empty space under its cards. Everything else that names no card lands at the top. */
export const AT_COLUMN_END: unique symbol = Symbol('kanban.atColumnEnd')

/** Assigns/moves a session card. `columnId` null = back to Ungrouped (assignment removed;
 *  Ungrouped order is canvas order, so the anchor is ignored there).
 *
 *  Placement in the destination column:
 *  - `beforeNodeId` names a card IN that column → just above it;
 *  - `AT_COLUMN_END` → at the bottom (only a positional drop asks for this);
 *  - anything else — `null`, or a card that is not in that column — is UNANCHORED and lands at
 *    the TOP. An unanchored move is "file this here" (the card menu, the agent `assign` verb, a
 *    card created from a column): appended at the bottom of a long "Done" column, the card an
 *    agent just finished read as having disappeared.
 *
 *  The move writes one `rank` and keeps the array in rank order (`placeAssignment`, which the
 *  relay's move verb shares). Unknown target column, or a card already exactly there, returns the
 *  SAME board. */
export function assignNode(
  k: ProjectKanban,
  nodeId: string,
  columnId: string | null,
  beforeNodeId: string | null | typeof AT_COLUMN_END
): ProjectKanban {
  if (nodeId === beforeNodeId) return k
  if (columnId === null) {
    if (!k.assignments.some((a) => a.nodeId === nodeId)) return k
    return { ...k, assignments: k.assignments.filter((a) => a.nodeId !== nodeId) }
  }
  if (!k.columns.some((c) => c.id === columnId)) return k
  const anchor: CardAnchor =
    beforeNodeId === AT_COLUMN_END ? 'end' : typeof beforeNodeId === 'string' ? { before: beforeNodeId } : 'top'
  const assignments = placeAssignment(k.assignments, nodeId, columnId, anchor)
  return assignments === k.assignments ? k : { ...k, assignments }
}

/** Drops assignments of nodes that no longer exist. Returns the SAME object when nothing
 *  changed, so callers can cheaply skip a no-op persist. */
export function pruneAssignments(k: ProjectKanban, liveIds: string[]): ProjectKanban {
  const live = new Set(liveIds)
  const assignments = k.assignments.filter((a) => live.has(a.nodeId))
  const meta = metaList(k).filter((m) => m && live.has(m.nodeId))
  const sameAssignments = assignments.length === k.assignments.length
  const sameMeta = meta.length === metaList(k).length
  // Pull request tombstones/opt-outs name cards too, and prune with them.
  const pruned = prunePullLinks(k, live)
  if (sameAssignments && sameMeta) return pruned
  const next: ProjectKanban = { ...pruned, assignments }
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
  const kanban = migrateTagsToLabels(project.kanban ?? defaultKanban(project.id), nodeTags)
  const nodes: CanvasNodeState[] = project.nodes.map((n) => {
    if (!Array.isArray(n.tags) || !n.tags.length) return n
    const hadClaude = n.tags.includes('claude')
    const { tags: _t, ...rest } = n
    return !n.agentId && hadClaude ? { ...rest, agentId: 'claude' } : rest
  })
  return { ...project, nodes, kanban }
}
