import type { BoardLogAuthor, KanbanCardMeta, KanbanLabel, KanbanLabelColor, KanbanPriority, ProjectKanban } from './types'

// Per-card board metadata and the board LABEL palette — pure transforms shared by the renderer
// (the canvas node's "+ Label" row, the kanban card, `LabelPicker`) and the host core (the phone's
// relay `projects.editCardLabels` verb, `core/project-kanban-write.ts`). There is exactly ONE label
// model: a per-project palette in `project.kanban.labels` plus per-card id lists in
// `kanban.meta[].labels`. Both surfaces write it through these functions so a label edited on the
// phone and one edited on the desktop are byte-for-byte the same edit. `renderer/lib/kanban.ts`
// re-exports everything here, so renderer call sites are unchanged.
//
// Every function returns a new board; unknown ids are no-ops returning an equivalent board.

const kid = (prefix: string): string => `${prefix}-${Math.random().toString(36).slice(2, 10)}`

/** Tolerant read of a card's metadata — `meta` may be absent or (hand-edited) malformed. */
export function cardMeta(k: ProjectKanban, nodeId: string): KanbanCardMeta | undefined {
  if (!Array.isArray(k.meta)) return undefined
  return k.meta.find((m) => m && m.nodeId === nodeId)
}

export const metaList = (k: ProjectKanban): KanbanCardMeta[] => (Array.isArray(k.meta) ? k.meta : [])

/** Writes one card's meta back; an entry with no fields left is DROPPED (absent = clean file),
 *  and an emptied meta array drops the key entirely. */
export function withCardMeta(
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
