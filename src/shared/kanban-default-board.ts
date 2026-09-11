/**
 * The starting board every project gets when it first grows one: To Do / In Progress / Done.
 *
 * It lives in `shared` because THREE writers must mint the same board and none of them may own the
 * definition: the renderer's `defaultKanban()` (the desktop's lazy default, seeded on the user's
 * first board edit), the core's `ensureProjectBoard` (the host side of the relay
 * `projects.ensureBoard` verb — the phone creating a board on a project that has never had one),
 * and, across the repo boundary, nodeterm-ios `KanbanDefaults` (which cannot import this file and
 * therefore copies it verbatim under a pinning test).
 *
 * Only the TITLES, their ORDER and their COLORS are shared. Column ids are minted per board and are
 * deliberately random: a board is created exactly once, by whichever surface got there first, and
 * every later reader addresses columns by the ids that board carries — so two surfaces agreeing on
 * an id would buy nothing and a fixed id would collide across projects.
 */
import { SYSTEM_NODE_COLORS } from './node-colors'

export interface DefaultBoardColumn {
  title: string
  color: string
}

/** The three starting columns, in board order. */
export const DEFAULT_BOARD_COLUMNS: readonly DefaultBoardColumn[] = [
  { title: 'To Do', color: SYSTEM_NODE_COLORS[0] },
  { title: 'In Progress', color: SYSTEM_NODE_COLORS[2] },
  { title: 'Done', color: SYSTEM_NODE_COLORS[1] }
] as const

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
