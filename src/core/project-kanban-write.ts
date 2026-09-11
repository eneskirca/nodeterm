// Pure kanban writes into a project.json's raw text — the host side of the relay
// `projects.ensureBoard` / `projects.setCardColumn` verbs (the phone's twin of this logic lives in
// nodeterm-ios ProjectNodeRegistrar and writes over direct SSH; both converge on one board shape).
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
