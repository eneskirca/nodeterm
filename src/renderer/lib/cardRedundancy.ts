/**
 * What a session card leaves out because where it sits, or what it already shows, says it.
 *
 * The card is small and every chip on it competes for the same glance, so a chip that repeats a
 * fact the card already carries — or one the column contradicts — costs attention and buys
 * nothing. Each rule below hides ONE thing on the CARD only; the card modal and the canvas node
 * keep the full picture (the modal's title, its Members/Due strip's "Overdue" chip).
 *
 * Audited and deliberately NOT hidden, because on a session card they do not exist or do not
 * repeat anything (recorded so the next audit does not re-derive it):
 *   - a column chip: the card never names its column (only the modal and the canvas node's
 *     half-pill do, where the column is NOT visible around them);
 *   - a project chip in the Omni overview's swimlanes: the card carries none;
 *   - a status badge that restates the column's lifecycle category: there is no DONE badge, and
 *     RUNNING / NEEDS YOU describe the agent's turn right now, not the card's lifecycle — an
 *     In Progress card that is idle is exactly what RUNNING distinguishes.
 */
import { isCompletedCategory } from '@shared/kanban-category'
import type { KanbanColumnCategory } from '@shared/types'

function normalized(text: string): string {
  return text.trim().replace(/\s+/g, ' ').toLowerCase()
}

/**
 * The session-name chip repeats the title. An agent node's title auto-tracks its session name
 * (`titleAuto`), so on most agent cards the two are the same words — the canvas node header has
 * always hidden that chip then, and the board card now asks the same question here. Compared
 * after trimming, collapsing whitespace and folding case: "Fix login" and "fix  login " are one
 * name to a reader.
 */
export function sessionNameRepeatsTitle(session: unknown, title: unknown): boolean {
  if (typeof session !== 'string' || !session.trim()) return true // nothing to show at all
  if (typeof title !== 'string') return false
  return normalized(session) === normalized(title)
}

/**
 * Whether the CARD raises the overdue alarm. A card in a done/closed column is finished work, and
 * a red "late" on it is a claim the column already settled — the date stays, the alarm does not.
 * The card modal's Members/Due strip still says "Overdue": the modal keeps every fact.
 */
export function cardShowsOverdue(
  dueAt: number | undefined,
  now: number,
  category: KanbanColumnCategory | undefined
): boolean {
  if (typeof dueAt !== 'number' || !(dueAt < now)) return false
  return !isCompletedCategory(category)
}
