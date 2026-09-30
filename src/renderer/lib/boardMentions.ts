import { mentionToken } from '@shared/board-comment'
import type { KanbanSession } from '../components/kanban/KanbanView'
import { toKanbanSession } from '../canvas/toKanbanSession'
import type { CanvasNode } from '../state/workspace'

/** A session a board comment may @mention: an AGENT terminal on this board. Notes, browsers and
 *  plain shells are not offered — the messaging gate refuses a pane with no agent in it, and typing
 *  a comment into a bare shell would run it. */
export interface MentionCandidate {
  id: string
  title: string
}

/** The candidates, from the board's own session list — the canvas flyout and the card modal both
 *  build it through here (via `toKanbanSession`), so the two views of a node offer the same people. */
export function mentionCandidatesFrom(
  sessions: readonly Pick<KanbanSession, 'id' | 'title' | 'kind' | 'agentId'>[]
): MentionCandidate[] {
  return sessions
    .filter((s) => s.kind === 'terminal' && !!s.agentId)
    .map((s) => ({ id: s.id, title: s.title || s.id }))
}

/** The same candidates from live canvas nodes — through `toKanbanSession`, the single definition of
 *  what a node is called on the board, so the canvas flyout and the card modal agree. */
export function mentionCandidatesFromNodes(nodes: readonly CanvasNode[]): MentionCandidate[] {
  const sessions: KanbanSession[] = []
  for (const n of nodes) {
    const s = toKanbanSession(n)
    if (s) sessions.push(s)
  }
  return mentionCandidatesFrom(sessions)
}

/** Is the caret right after an `@query` that should open the picker? The `@` must start a word
 *  (so an e-mail address does not), and the query runs to the caret with no whitespace or bracket. */
export function mentionQueryAt(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret)
  const at = before.lastIndexOf('@')
  if (at < 0) return null
  if (at > 0 && !/\s/.test(before[at - 1])) return null
  const query = before.slice(at + 1)
  if (/[\s[\]()]/.test(query)) return null
  return { start: at, query }
}

/** The picker's rows for a query: title (or id) contains it, case-insensitively, in board order. */
export function mentionOptions(
  candidates: readonly MentionCandidate[],
  query: string,
  max = 8
): MentionCandidate[] {
  const q = query.toLowerCase()
  return candidates
    .filter((c) => c.title.toLowerCase().includes(q) || c.id.toLowerCase().includes(q))
    .slice(0, max)
}

/** Replace `text[start, caret)` (the `@query`) with the candidate's token and a space. */
export function insertMention(
  text: string,
  start: number,
  caret: number,
  c: MentionCandidate
): { text: string; caret: number } {
  const token = `${mentionToken(c.id, c.title)} `
  return { text: text.slice(0, start) + token + text.slice(caret), caret: start + token.length }
}
