/**
 * The `board` control verb's answer: the kanban board's columns, the session cards filed in each,
 * and the virtual Ungrouped column. Pure, so the two callers — the caller's own project (the
 * dispatch's `case 'board'`) and `board --project <id>` (an own or granted project, issue #1179) —
 * cannot describe a board two ways.
 *
 * `sessions` are the project's session cards (`toKanbanSession` over that project's nodes): the
 * board file only stores column assignments, so a session with no/dangling assignment sits
 * Ungrouped, and an assignment for a node that is not a session is not listed.
 */
import type { ProjectKanban } from '@shared/types'
import { assignedTo, unassigned } from './kanban'

export interface BoardVerbReply {
  message: string
  result: { columns: { id: string; title: string; cards: string[] }[]; ungrouped: string[] }
}

export function boardVerbReply(
  board: ProjectKanban | undefined,
  sessions: readonly { id: string; title?: string }[],
  projectName?: string
): BoardVerbReply {
  const titleOf = new Map(sessions.map((s) => [s.id, s.title || 'Untitled']))
  const sessionIds = sessions.map((s) => s.id)
  const head = projectName ? `Kanban board of project "${projectName}"` : 'Kanban board'
  const fmt = (ids: string[]) => ids.map((id) => `  - ${titleOf.get(id)} (id: ${id})`)
  if (!board) {
    // No board yet (lazy default not written) — every session is Ungrouped.
    return {
      message: [
        `${head}: (no columns yet — default To Do / In Progress / Done appears on first edit)`,
        `Ungrouped (${sessionIds.length}):`,
        ...fmt(sessionIds)
      ].join('\n'),
      result: { columns: [], ungrouped: sessionIds }
    }
  }
  const columns = board.columns.map((c) => ({
    id: c.id,
    title: c.title,
    cards: assignedTo(board, c.id).filter((id) => titleOf.has(id))
  }))
  const ungrouped = unassigned(board, sessionIds)
  return {
    message: [
      `${head}:`,
      ...columns.flatMap((c) => [`${c.title} (${c.cards.length}) [column id: ${c.id}]:`, ...fmt(c.cards)]),
      `Ungrouped (${ungrouped.length}):`,
      ...fmt(ungrouped)
    ].join('\n'),
    result: { columns, ungrouped }
  }
}
