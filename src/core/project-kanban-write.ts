// Pure kanban writes into a project.json's raw text — the host side of the relay
// `projects.ensureBoard` / `projects.setCardColumn` / `projects.editCardLabels` verbs (the phone's
// twin of this logic lives in nodeterm-ios KanbanBoardWriter and writes over direct SSH; both
// converge on one board shape).
//
// Same raw-object discipline as `project-node-append.ts`: the transforms work on the PARSED OBJECT,
// not the typed mirrors, so every field this version does not know (bridges, dino scores, future
// schema — and, crucially, `kanban.meta` / `kanban.labels` / `kanban.github`, which only the desktop
// authors) round-trips untouched. The file is rewritten whole; a decode into a mirror would silently
// drop the parts of the board this surface has no UI for.
//
// Returns null whenever nothing must be written: unparsable/wrong-shape text (a file we could not
// parse must never be invented or overwritten), or a request that is already satisfied (a board that
// exists, a card already in that column) — a retry must not churn `rev`.

import { DEFAULT_BOARD_COLUMNS, makeColumnId } from '../shared/kanban-default-board'
import {
  KANBAN_LABEL_COLORS,
  boardLabels,
  cardMeta,
  createLabel,
  setCardLabels
} from '../shared/kanban-labels'
import type { KanbanLabelColor, ProjectKanban } from '../shared/types'

/** Parse `raw` as the `{version:1, rev, nodes}` project file, or null. */
function parseProjectFile(raw: string): Record<string, unknown> | null {
  let root: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
    root = parsed as Record<string, unknown>
  } catch {
    return null
  }
  if (root.version !== 1 || typeof root.rev !== 'number' || !Array.isArray(root.nodes)) return null
  return root
}

function bumped(root: Record<string, unknown>, now: Date): string {
  root.rev = (root.rev as number) + 1
  root.savedAt = now.toISOString()
  return JSON.stringify(root, null, 2)
}

/** The board block as an object we may extend, or an empty one. A `kanban` of the wrong shape
 *  (hand-edited, a future schema) is NOT overwritten — the caller gets null and says so. */
function boardOf(root: Record<string, unknown>): Record<string, unknown> | null {
  const k = root.kanban
  if (k === undefined || k === null) return {}
  if (typeof k !== 'object' || Array.isArray(k)) return null
  return k as Record<string, unknown>
}

function columnsOf(board: Record<string, unknown>): Array<Record<string, unknown>> {
  return Array.isArray(board.columns) ? (board.columns as Array<Record<string, unknown>>) : []
}

/**
 * Seed the three default columns on a project whose file has no board yet — the write the desktop
 * deliberately does NOT make until the user's first board edit (`defaultKanban`'s lazy-default
 * rule), and which therefore leaves most projects with no board at all. That was invisible on the
 * desktop (the canvas renders the lazy default) and fatal on the phone, whose Board affordance
 * asked "does this file have columns?" and so never appeared.
 *
 * IDEMPOTENT: a project that already has at least one column is left exactly as it is and returns
 * null. That is the whole safety property — the phone may ask on every Board tap, and it can never
 * be the thing that replaces a board someone built.
 */
export function ensureProjectBoard(raw: string, now: Date, mintId = makeColumnId): string | null {
  const root = parseProjectFile(raw)
  if (!root) return null
  const board = boardOf(root)
  if (!board) return null
  if (columnsOf(board).length > 0) return null
  board.columns = DEFAULT_BOARD_COLUMNS.map((c) => ({ id: mintId(), title: c.title, color: c.color }))
  if (!Array.isArray(board.assignments)) board.assignments = []
  root.kanban = board
  return bumped(root, now)
}

/**
 * Move one card to `columnId`, or to the virtual Ungrouped column (`columnId === null`).
 *
 * Only `kanban.assignments` is touched: `meta` (assignees / due / priority / labels) is independent
 * of placement on the desktop too, and a move must not disturb it.
 *
 * Refused (null, nothing written):
 * - the file is not the shape we know;
 * - `columnId` names a column this board does not have — the phone's board could be a few seconds
 *   stale, and inventing the column (or writing a dangling assignment that every reader then
 *   buckets as Ungrouped) would silently do something other than what the user asked;
 * - the card is already exactly where it was asked to go.
 *
 * A `nodeId` that is not on this canvas is NOT refused: node ids are also tmux session names, and a
 * session registered a moment ago by the other write path may not be in the copy we just read. The
 * assignment simply waits for it — dangling assignments are already normal (a deleted node leaves
 * one) and every reader prunes them lazily.
 */
export function setProjectCardColumn(
  raw: string,
  nodeId: string,
  columnId: string | null,
  now: Date
): string | null {
  if (typeof nodeId !== 'string' || !nodeId) return null
  const root = parseProjectFile(raw)
  if (!root) return null
  const board = boardOf(root)
  if (!board) return null
  const columns = columnsOf(board)
  if (columnId !== null && !columns.some((c) => c?.id === columnId)) return null

  const before = Array.isArray(board.assignments)
    ? (board.assignments as Array<Record<string, unknown>>)
    : []
  const current = before.find((a) => a?.nodeId === nodeId)?.columnId
  // Already there — including "already Ungrouped", which is what an ABSENT assignment means.
  if ((current ?? null) === columnId) return null

  const kept = before.filter((a) => a?.nodeId !== nodeId)
  board.assignments = columnId === null ? kept : [...kept, { nodeId, columnId }]
  if (!Array.isArray(board.columns)) board.columns = columns
  root.kanban = board
  return bumped(root, now)
}

// ── Card labels (the phone's `projects.editCardLabels` verb) ─────────────────────────────────────

/** Longest label name the phone may create. The desktop picker has no cap of its own; this one is
 *  a write-site bound on hostile input (the verb's params are client-sent), generous for a chip. */
export const LABEL_NAME_MAX = 60
/** Most label ids / creations one edit may carry — a sheet toggles one or two at a time. */
export const LABEL_EDIT_MAX = 32
/** Longest label id accepted from the wire. Minted ids are `klbl-xxxxxxxx`; hand-edited ones can
 *  be anything, which is why this is a length/charset bound rather than the minted shape. */
const LABEL_ID_MAX = 128

// C0 + DEL + C1. A label name is rendered on three surfaces and written into a git-shared file;
// a newline or an ESC in it has no legitimate use and is exactly what hand-edited input smuggles.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/

/** One label edit on one card, as the phone sends it. All three lists are optional; at least one
 *  entry overall is required. `create`d labels are added to the palette AND applied to the card. */
export interface CardLabelEdit {
  add?: string[]
  remove?: string[]
  create?: Array<{ name: string; color: KanbanLabelColor }>
}

const validId = (x: unknown): x is string =>
  typeof x === 'string' && x.length > 0 && x.length <= LABEL_ID_MAX && !CONTROL_CHARS.test(x)

/** Label-name identity: the same trim + case fold `LabelPicker` uses to hide "Create" on an exact
 *  match and `migrateTagsToLabels` uses to reuse a label — so the phone cannot mint a duplicate the
 *  desktop picker would never have let the user create. */
const nameKey = (s: string): string => s.trim().toLowerCase()

/**
 * Validate a client-sent label edit at the write site, or return null (refused, nothing written).
 *
 * The params come off the wire and end up in a git-shared, hand-editable file every collaborator's
 * canvas renders, so nothing is coerced into shape: an id that is not a bounded, control-free
 * string, a name that is empty / too long / carries control characters, a colour outside the closed
 * palette, an id both added and removed, or an edit with nothing in it — each refuses the whole
 * edit rather than writing a "nearest" version of it.
 */
export function parseCardLabelEdit(raw: unknown): CardLabelEdit | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  const list = (x: unknown): string[] | null => {
    if (x === undefined || x === null) return []
    if (!Array.isArray(x) || x.length > LABEL_EDIT_MAX || !x.every(validId)) return null
    return [...new Set(x)]
  }
  const add = list(r.add)
  const remove = list(r.remove)
  if (!add || !remove) return null
  if (add.some((id) => remove.includes(id))) return null

  const create: Array<{ name: string; color: KanbanLabelColor }> = []
  if (r.create !== undefined && r.create !== null) {
    if (!Array.isArray(r.create) || r.create.length > LABEL_EDIT_MAX) return null
    for (const c of r.create) {
      if (!c || typeof c !== 'object') return null
      const { name, color } = c as { name?: unknown; color?: unknown }
      if (typeof name !== 'string' || CONTROL_CHARS.test(name)) return null
      const trimmed = name.trim()
      if (!trimmed || [...trimmed].length > LABEL_NAME_MAX) return null
      if (!KANBAN_LABEL_COLORS.includes(color as KanbanLabelColor)) return null
      if (create.some((x) => nameKey(x.name) === nameKey(trimmed))) continue
      create.push({ name: trimmed, color: color as KanbanLabelColor })
    }
  }
  if (!add.length && !remove.length && !create.length) return null
  return { add, remove, create }
}

/**
 * Apply one label edit to one card in the project file's raw text — through the SAME pure
 * transforms the desktop's `LabelPicker` uses (`@shared/kanban-labels`), so a label added on the
 * phone is the same palette entry + the same `meta[].labels` id the desktop would have written.
 *
 * Order: creations first (a name matching an existing label, case-insensitively, REUSES that label
 * instead of minting a duplicate — the desktop picker offers no "Create" on an exact match either),
 * then removals, then additions. `kanban.columns` / `assignments` / `github` and every other card's
 * meta round-trip untouched (the same raw-object discipline as the rest of this file).
 *
 * A project with no board gets the default one seeded first, exactly as the desktop's first
 * "+ Label" does (`NodeLabels` edits `kanban ?? defaultKanban()`) — but only when the edit actually
 * changes something, so a no-op never writes a board nobody asked for.
 *
 * Returns null (nothing written) for a file of the wrong shape, an unusable `kanban` block, an
 * `add` naming a label this palette does not have (the phone's copy is stale — applying a dangling
 * id would show nothing anywhere), or an edit that leaves the card and palette exactly as they were.
 */
export function editProjectCardLabels(
  raw: string,
  nodeId: string,
  edit: CardLabelEdit,
  now: Date,
  mintId = makeColumnId
): string | null {
  if (!validId(nodeId)) return null
  const root = parseProjectFile(raw)
  if (!root) return null
  const block = boardOf(root)
  if (!block) return null
  // The shared transforms are typed on ProjectKanban and spread `...k`, so every field we do not
  // type survives; the cast only lends them the arrays they read (both tolerated when absent).
  let k = block as unknown as ProjectKanban
  const before = JSON.stringify([boardLabels(k), cardMeta(k, nodeId)?.labels ?? []])

  const apply: string[] = []
  for (const c of edit.create ?? []) {
    const existing = boardLabels(k).find((l) => nameKey(l.name) === nameKey(c.name))
    if (existing) {
      apply.push(existing.id)
      continue
    }
    const res = createLabel(k, c.name, c.color)
    k = res.k
    apply.push(res.id)
  }
  const known = new Set(boardLabels(k).map((l) => l.id))
  if ((edit.add ?? []).some((id) => !known.has(id))) return null

  const drop = new Set(edit.remove ?? [])
  const current = cardMeta(k, nodeId)?.labels
  const kept = (Array.isArray(current) ? current : []).filter((id) => !drop.has(id))
  k = setCardLabels(k, nodeId, [...kept, ...(edit.add ?? []).filter((id) => !drop.has(id)), ...apply])

  if (JSON.stringify([boardLabels(k), cardMeta(k, nodeId)?.labels ?? []]) === before) return null

  const next = k as unknown as Record<string, unknown>
  if (columnsOf(next).length === 0) {
    next.columns = DEFAULT_BOARD_COLUMNS.map((c) => ({ id: mintId(), title: c.title, color: c.color }))
  }
  if (!Array.isArray(next.assignments)) next.assignments = []
  root.kanban = next
  return bumped(root, now)
}
