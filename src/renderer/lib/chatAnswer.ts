import type { ChatMessage } from '@shared/types'
import {
  ANSWER_TEXT_MAX_CHARS,
  ASK_USER_QUESTION_TOOL,
  EXIT_PLAN_MODE_TOOL,
  type ChatQuestion,
  type HeldPermission,
  type PermissionAnswer
} from '@shared/agents/permission-answer'

/**
 * Pure decisions behind the ⌘M panel's answer controls on a Plan / Question card
 * (`nodes/ChatAnswerControls.tsx`): which card the held request belongs to, and what a selection
 * turns into. The renderer only ever builds a `PermissionAnswer`; core validates every field against
 * the pending request file and builds the hook's JSON (`core/agents/permission-decision.ts`).
 */

/** The three ways to approve a plan, in button order. There is deliberately no `auto`
 *  (see `PermissionAnswer`), and the default names what it actually does. */
export const PLAN_CHOICES: ReadonlyArray<{ mode: 'restore' | 'acceptEdits' | 'manual'; label: string; hint: string }> = [
  { mode: 'restore', label: 'Approve · previous mode', hint: 'Continue in the mode you were in before plan mode' },
  { mode: 'acceptEdits', label: 'Approve · accept edits', hint: 'Continue with file edits auto-approved' },
  { mode: 'manual', label: 'Approve · ask before edits', hint: 'Continue, asking before each edit' }
]

/** Typed text limit for "Revise…" and "Other" — the shared limit core enforces. */
export const CHAT_ANSWER_TEXT_MAX = ANSWER_TEXT_MAX_CHARS

/** Where a card lives in the rendered thread. */
export interface AnswerCardRef {
  message: number
  part: number
}

/**
 * The ONE card the node's held request belongs to, or null (every card stays read-only).
 *
 * The candidate is the NEWEST tool part named like the held tool — an older plan or question is
 * history — and it must still be unanswered (no result). A question card must also carry the SAME
 * question texts, in order, as the held request (both come from `readQuestions`): a held ticket
 * whose texts are unknown, or a card whose questions could not be read, gets no controls.
 */
export function activeAnswerCard(messages: readonly ChatMessage[], held: HeldPermission | undefined): AnswerCardRef | null {
  if (!held || (held.toolName !== EXIT_PLAN_MODE_TOOL && held.toolName !== ASK_USER_QUESTION_TOOL)) return null
  for (let i = messages.length - 1; i >= 0; i--) {
    const parts = messages[i].parts
    for (let j = parts.length - 1; j >= 0; j--) {
      const p = parts[j]
      if (p.kind !== 'tool' || p.name !== held.toolName) continue
      if (p.result !== undefined || !p.body) return null
      if (held.toolName === EXIT_PLAN_MODE_TOOL) return { message: i, part: j }
      const texts = held.questions
      const qs = p.questions
      if (!texts || !qs || texts.length !== qs.length || !qs.every((q, k) => q.question === texts[k])) return null
      return { message: i, part: j }
    }
  }
  return null
}

/** A plan or a question: the two held tools whose card in the thread can carry answer controls. */
const isAnswerCardTool = (name: string): boolean => name === EXIT_PLAN_MODE_TOOL || name === ASK_USER_QUESTION_TOOL

/**
 * The newest card of `toolName`, when it is still unanswered — the one card that says "Updating…"
 * while the thread is re-read. Unlike `activeAnswerCard` it needs no matching question texts: it
 * marks where the controls WILL be, it never answers anything.
 */
export function latestUnansweredCard(messages: readonly ChatMessage[], toolName: string): AnswerCardRef | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const parts = messages[i].parts
    for (let j = parts.length - 1; j >= 0; j--) {
      const p = parts[j]
      if (p.kind !== 'tool' || p.name !== toolName) continue
      return p.result === undefined ? { message: i, part: j } : null
    }
  }
  return null
}

/**
 * How long a card waits on "Updating…" before its reload is tried again. The held-request reload can
 * fail (a downed ControlMaster, an unreadable transcript) and nothing else reads the tail while the
 * agent is `blocked`, so without a retry the card would stay on "Updating…" for the whole hold.
 */
export const CHAT_ANSWER_REBIND_RETRY_MS = 2000
/** The retry backs off (doubling) up to this, so a card that never updates costs one read per 30 s. */
export const CHAT_ANSWER_REBIND_RETRY_MAX_MS = 30_000

/** The delay before retry number `attempt` (0-based): 2 s, 4, 8, 16, then 30 s. */
export function rebindRetryDelay(attempt: number): number {
  return Math.min(CHAT_ANSWER_REBIND_RETRY_MS * 2 ** Math.max(0, attempt), CHAT_ANSWER_REBIND_RETRY_MAX_MS)
}

/**
 * A stable name for a card across reads: the tool_use id when the paged reader gives one, else the
 * source line's byte offset + part, else (an unkeyed thread) its position.
 */
export function answerCardKey(messages: readonly ChatMessage[], ref: AnswerCardRef): string {
  const m = messages[ref.message]
  const p = m?.parts[ref.part]
  if (p && p.kind === 'tool' && p.id) return p.id
  return m?.key !== undefined ? `k${m.key}:${ref.part}` : `i${ref.message}:${ref.part}`
}

/** The card a request was last bound to, so a NEW request cannot bind that same card. */
export interface BoundAnswerCard {
  pendingId: string
  cardKey: string
}

/** A plan / question is held that the thread on screen was not read for: the tail must be re-read
 *  (and the card waits on "Updating…") before any card may answer it. */
export function answerRebindPending(held: HeldPermission | undefined, threadHeldFor: string | null | undefined): boolean {
  return !!held && isAnswerCardTool(held.toolName) && threadHeldFor !== held.pendingId
}

/** What the held plan / question card shows: controls bound to one request, or "Updating…". */
export type AnswerCardState =
  | { kind: 'active'; card: AnswerCardRef; cardKey: string; pendingId: string }
  | { kind: 'updating'; card: AnswerCardRef | null }
  | null

/**
 * The answer card for the request held NOW, given the request the thread on screen was READ for
 * (`threadHeldFor`: the held ticket at the START of the last applied tail read; `null` = read with
 * nothing held, `undefined` = not read for this transcript yet).
 *
 * The card may only answer the request the thread was read for. While the hook moves held A → held
 * B (plan A revised into plan B) the thread can still show plan A's card with no result, and a card
 * matched by tool name alone would approve B from A's card. So a request the thread was not read
 * for gets NO controls — only "Updating…" on the latest unanswered card of its tool, until a tail
 * read that started under it lands — and, given `previous` (the card the last request was bound to),
 * until the thread shows a card OTHER than that one. Active controls bind `threadHeldFor`, which is then the held id.
 */
export function answerCardState(
  messages: readonly ChatMessage[],
  held: HeldPermission | undefined,
  threadHeldFor: string | null | undefined,
  previous?: BoundAnswerCard | null
): AnswerCardState {
  if (!held || !isAnswerCardTool(held.toolName)) return null
  if (answerRebindPending(held, threadHeldFor)) return { kind: 'updating', card: latestUnansweredCard(messages, held.toolName) }
  const card = activeAnswerCard(messages, held)
  if (!card) return null
  const cardKey = answerCardKey(messages, card)
  // A read under B that still shows the very card A was bound to has not caught up with B (the
  // transcript may lag the hook): B must surface on a card the thread shows as NEW.
  if (previous && previous.pendingId !== held.pendingId && previous.cardKey === cardKey) return { kind: 'updating', card }
  return { kind: 'active', card, cardKey, pendingId: held.pendingId }
}

/** What the user has picked for one question. `labels` are option labels; `other` + `otherText`
 *  is the free-text "Other" (the only input on a question with no options). */
export interface QuestionSelection {
  labels: string[]
  other: boolean
  otherText: string
}

export const emptySelection = (questions: readonly ChatQuestion[]): QuestionSelection[] =>
  questions.map(() => ({ labels: [], other: false, otherText: '' }))

/** Add or remove one label (a checkbox). */
export function toggleLabel(labels: readonly string[], label: string, on: boolean): string[] {
  const rest = labels.filter((l) => l !== label)
  return on ? [...rest, label] : rest
}

/**
 * The typed "Other" as one item of a multi-select answer, quoted the way Claude Code's own picker
 * quotes it — MEASURED on 2.1.283: `Red, Blue, "teal, sort of"`, `Green, "say \"hi\""`, but
 * `Red, teal`. Quoted (with the inner quotes escaped) only when it contains a comma or a quote, so
 * the model can always tell where the user's own words start and end in the joined list.
 */
export function quoteCustomItem(text: string): string {
  return /[,"]/.test(text) ? JSON.stringify(text) : text
}

/**
 * The free text a question's answer would carry, or null when it is not a free-text answer. ONE
 * definition, so the text that is capped is the text that is sent: on a multi choice with "Other" it
 * is the ticked labels (in option order) plus the typed text (`quoteCustomItem`), joined with ", " —
 * the TUI's own multi-select format, and one string because core carries one free-text answer per
 * question. Core caps THAT string, so capping only the typed part let a long answer through to a
 * refusal. A single choice's "Other" is the typed text as-is: it is the whole answer.
 */
function freeTextOf(q: ChatQuestion, sel: QuestionSelection): string | null {
  if (!sel.other && q.options.length > 0) return null
  const typed = sel.otherText.trim()
  if (!q.multiSelect || typed === '') return typed
  const labels = q.options.map((o) => o.label).filter((l) => sel.labels.includes(l))
  return [...labels, quoteCustomItem(typed)].join(', ')
}

/** The first question whose free-text answer is over the shared cap (core would refuse it), or null.
 *  The controls name it instead of leaving Submit disabled without a reason. */
export function answerTooLong(
  questions: readonly ChatQuestion[],
  selections: readonly QuestionSelection[]
): string | null {
  for (let i = 0; i < questions.length && i < selections.length; i++) {
    const text = freeTextOf(questions[i], selections[i])
    if (text !== null && text.length > CHAT_ANSWER_TEXT_MAX) return questions[i].question
  }
  return null
}

/**
 * The structured answer for a set of selections, or null while any question is unanswered, a pick is
 * not one of that question's own options, or a free-text answer is over the cap (never sent — core
 * would refuse it anyway).
 *
 *  - single choice → the label; multi choice → its labels in OPTION order;
 *  - "Other" (or a question with no options) → `freeTextOf`, listed in `freeText`.
 */
export function questionAnswerFrom(
  questions: readonly ChatQuestion[],
  selections: readonly QuestionSelection[]
): Extract<PermissionAnswer, { kind: 'question' }> | null {
  if (questions.length === 0 || selections.length !== questions.length) return null
  const answers: Record<string, string | string[]> = {}
  const freeText: string[] = []
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i]
    const sel = selections[i]
    const known = q.options.map((o) => o.label)
    if (!sel.labels.every((l) => known.includes(l))) return null
    const labels = known.filter((l) => sel.labels.includes(l))
    const text = freeTextOf(q, sel)
    if (text !== null) {
      if (!text || text.length > CHAT_ANSWER_TEXT_MAX) return null
      answers[q.question] = text
      freeText.push(q.question)
    } else if (q.multiSelect) {
      if (labels.length === 0) return null
      answers[q.question] = labels
    } else {
      if (labels.length !== 1) return null
      answers[q.question] = labels[0]
    }
  }
  return freeText.length ? { kind: 'question', answers, freeText } : { kind: 'question', answers }
}

/** "Revise…": the feedback message, or null while it is blank. */
export function planReviseAnswer(text: string): Extract<PermissionAnswer, { kind: 'plan-revise' }> | null {
  const message = text.trim()
  return message && message.length <= CHAT_ANSWER_TEXT_MAX ? { kind: 'plan-revise', message } : null
}
