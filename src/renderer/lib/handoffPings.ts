/**
 * Handoff pings: tell a card's ASSIGNEE when the work is handed to them — and at no other moment.
 *
 * A handoff is a card assigned to this user (by presence name) ENTERING a column that means "your
 * turn": a `done` column, or a `started` column other than the board's first one (Review / QA after
 * In Progress). Everything else is a routine move and pings nobody: into the first started column,
 * back to not-started, into `closed` (won't do), into an uncategorized column — a board with no
 * categories has not said what a handoff is, so it never pings. "Needs you" is not decided here:
 * the existing agent-status path already notifies it for every agent node, and a second
 * notification for the same fact would be noise.
 *
 * Double-notify with the turn-end ("finished") notification: an agent that files its card into
 * Done does so INSIDE its turn, and the turn's Stop hook follows seconds later — two notifications
 * for one event. So a handoff ping arms a one-shot fold for its node: the next "finished"
 * notification for that node within `HANDOFF_FOLD_MS` is not sent (the unread dot still is — only
 * the interrupt is folded). A later turn end notifies as always, and so does the next one after the
 * window comes back to the foreground (`installHandoffFocusReset`): the fold stands for "the user is
 * away and was just told", and a refocus ends that — otherwise the next chime, maybe for a turn that
 * had nothing to do with the handoff, was silently swallowed while the user sat watching.
 *
 * Consent and delivery are the existing path's: `notifyOnClaudeDone` + the one-time consent prompt,
 * an OS notification only while the window is in the background, the per-node cooldown.
 */
import type { KanbanColumnCategory, ProjectKanban } from '@shared/types'
import { columnCategory } from '@shared/kanban-category'
import { cardAssignees, cardMeta } from './kanban'

export const HANDOFF_FOLD_MS = 2 * 60_000

export interface Handoff {
  nodeId: string
  columnId: string
  columnTitle: string
  category: Extract<KanbanColumnCategory, 'started' | 'done'>
}

/** The handoffs a board change makes to `me` (see the module note). Pure. */
export function handoffsFor(prev: ProjectKanban, next: ProjectKanban, me: string): Handoff[] {
  const firstStarted = next.columns.find((c) => columnCategory(c) === 'started')?.id
  const before = new Map(prev.assignments.map((a) => [a.nodeId, a.columnId]))
  const out: Handoff[] = []
  for (const a of next.assignments) {
    if (!a || before.get(a.nodeId) === a.columnId) continue
    const column = next.columns.find((c) => c.id === a.columnId)
    const category = columnCategory(column)
    const handoff = category === 'done' || (category === 'started' && a.columnId !== firstStarted)
    if (!column || !handoff) continue
    if (!cardAssignees(cardMeta(next, a.nodeId)).some((p) => p.name === me)) continue
    out.push({ nodeId: a.nodeId, columnId: a.columnId, columnTitle: column.title, category: category as Handoff['category'] })
  }
  return out
}

const pinged = new Map<string, number>()

/** A handoff ping went out for `nodeId` at `now`: arm the one-shot fold. */
export function noteHandoff(nodeId: string, now: number): void {
  pinged.set(nodeId, now)
}

/** Should the turn-end notification for `nodeId` be folded into a handoff ping just sent?
 *  Consumes the fold, so it swallows at most one notification per handoff. */
export function suppressDoneAfterHandoff(nodeId: string, now: number): boolean {
  const at = pinged.get(nodeId)
  if (at === undefined) return false
  pinged.delete(nodeId)
  return now - at <= HANDOFF_FOLD_MS
}

/** Drops every armed fold when the window gains focus; returns the teardown. The ping is only
 *  sent while the window is in the background, so a focus after it means the user is back. */
export function installHandoffFocusReset(target: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>): () => void {
  const drop = (): void => pinged.clear()
  target.addEventListener('focus', drop)
  return () => target.removeEventListener('focus', drop)
}

/** Tests only. */
export function resetHandoffsForTests(): void {
  pinged.clear()
}
