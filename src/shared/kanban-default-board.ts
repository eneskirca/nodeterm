/**
 * The starting board every project gets when it first grows one: To Do / In Progress / Done.
 *
 * It lives in `shared` because THREE writers must mint the same board and none of them may own the
 * definition: the renderer's `defaultKanban(projectId)` (the desktop's lazy default, seeded on the
 * user's first board edit), the core's `ensureProjectBoard` (the host side of the relay
 * `projects.ensureBoard` verb — the phone creating a board on a project that has never had one),
 * and, across the repo boundary, nodeterm-ios `KanbanDefaults` (which cannot import this file and
 * therefore copies it verbatim under a pinning test).
 *
 * Only the TITLES, their ORDER, their COLORS and their lifecycle CATEGORY are shared (the category
 * is additive: a surface whose copy lacks it seeds uncategorized columns, which every reader
 * tolerates — see @shared/kanban-category).
 *
 * Column ids come in two kinds, and which one a board gets depends on how it was born:
 *  - the LAZY default (the renderer's `defaultKanban(projectId)` → `defaultKanbanFor`): what every
 *    client renders for a project whose file has no `kanban` yet. It is not written until the first
 *    edit, and with the board syncing live between clients, TWO people can make that first edit at
 *    once. Random ids per client turned that into six columns; so the lazy default seeds ids that
 *    are a pure function of the project id and the column's index (`seededColumnId`) — the same on
 *    every client for one project, different across projects.
 *  - an EXPLICITLY created board (the core's `ensureProjectBoard`, the phone's first board): minted
 *    once, by one writer, and then read by id — so its ids stay random (`makeColumnId`).
 * Both kinds have the same `kcol-<8 base36>` shape, so every reader of existing files is unaffected
 * and existing boards keep the ids they carry.
 */
import { SYSTEM_NODE_COLORS } from './node-colors'
import type { KanbanColumn, KanbanColumnCategory, ProjectKanban } from './types'

export interface DefaultBoardColumn {
  title: string
  color: string
  category: KanbanColumnCategory
}

/** The three starting columns, in board order. */
export const DEFAULT_BOARD_COLUMNS: readonly DefaultBoardColumn[] = [
  { title: 'To Do', color: SYSTEM_NODE_COLORS[0], category: 'unstarted' },
  { title: 'In Progress', color: SYSTEM_NODE_COLORS[2], category: 'started' },
  { title: 'Done', color: SYSTEM_NODE_COLORS[1], category: 'done' }
] as const

/** The default columns with freshly minted ids — the ONE place a seeded column's shape is spelled,
 *  so the renderer's lazy default and the core's relay seeding cannot drift apart. */
export function defaultBoardColumns(mintId: () => string = makeColumnId): KanbanColumn[] {
  return DEFAULT_BOARD_COLUMNS.map((c) => ({
    id: mintId(),
    title: c.title,
    color: c.color,
    category: c.category
  }))
}

/**
 * A column id in the desktop's shape: `kcol-<8 chars of base36>`.
 *
 * `Math.random().toString(36).slice(2, 10)` is what `lib/kanban.ts` has always minted, and the ids
 * it produces are what live in every project file on disk — so the SHAPE is a compatibility
 * surface even though the value is random. Kept here next to the titles so the two halves of
 * "what a fresh board looks like" cannot drift apart.
 */
export function makeColumnId(): string {
  return `kcol-${Math.random().toString(36).slice(2, 10)}`
}

/** FNV-1a 32-bit — a stable, dependency-free hash (no crypto: this is identity, not security). */
function fnv1a32(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

/**
 * The id of the i-th default column of `projectId`'s lazy board: the same on every client that
 * renders that project, so two people's first-ever board edits land on the SAME three columns
 * (random ids per client made that six). Different across projects. Same `kcol-` + 8 base36 shape
 * `makeColumnId` has always produced, so every reader of existing files is unaffected.
 */
export function seededColumnId(projectId: string, index: number): string {
  return `kcol-${fnv1a32(`${projectId}:${index}`).toString(36).padStart(8, '0').slice(-8)}`
}

/** The lazy default board of one project (the renderer's `kanban ?? defaultKanban(id)`). */
export function defaultKanbanFor(projectId: string): ProjectKanban {
  let i = 0
  return { columns: defaultBoardColumns(() => seededColumnId(projectId, i++)), assignments: [] }
}
