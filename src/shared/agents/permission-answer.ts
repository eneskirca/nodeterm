// Structured answers to a HELD Claude PermissionRequest (docs/hook-reply-approvals.md).
//
// The managed hook holds a PermissionRequest open and polls an answer file. The legacy answer is
// one word, `allow` | `deny`. That cannot answer the two tools that set `requiresUserInteraction`:
// Claude Code DROPS a bare allow for them (`if(!I.updatedInput&&e.requiresUserInteraction?.())
// return null` — docs/superpowers/plans/2026-09-26-answer-paths-research.md §2), so approving a plan
// or answering a question needs a decision that carries `updatedInput`. These are the shapes the
// renderer may ask for; core (`core/agents/permission-decision.ts`) validates every field against the
// pending request file and builds the JSON the hook prints. The renderer never builds hook JSON.
//
// Shared (not core) because the renderer and both shells' IPC types name it.

/** Claude's plan-approval tool. Its hold is long, and a plain `allow` maps to "restore the mode
 *  that preceded plan mode" (`updatedInput:{}`) inside the hook script itself. */
export const EXIT_PLAN_MODE_TOOL = 'ExitPlanMode'
/** Claude's question picker. A plain `allow` cannot answer it; only `{kind:'question'}` can. */
export const ASK_USER_QUESTION_TOOL = 'AskUserQuestion'

/** The two tools a person reads for minutes rather than seconds — the hook holds them for
 *  `PERM_WAIT_SECS_INTERACTIVE` instead of the 45 s default. */
export const INTERACTIVE_HOLD_TOOLS: readonly string[] = [EXIT_PLAN_MODE_TOOL, ASK_USER_QUESTION_TOOL]

/**
 * What an answerer may send. `allow` / `deny` are the legacy verbs (phone, older desktop, the header
 * buttons) and still travel as the one-word answer file.
 *
 *  - `plan` — approve an ExitPlanMode. `restore` = the mode that preceded plan mode (no
 *    `updatedPermissions`; the tool's own call() restores it, including auto's dangerous-rule
 *    strip). `acceptEdits` / `manual` add a session `setMode`. There is deliberately no `auto`:
 *    a hook `setMode auto` skips that strip (research §2(A)).
 *  - `plan-revise` — "No, keep planning": a deny whose message is the user's feedback.
 *  - `question` — answer an AskUserQuestion. Keys are the EXACT question texts; a string is one
 *    option label, a string[] is several labels of a multiSelect question. A key listed in
 *    `freeText` carries typed text (the picker's "Other") instead of a label — that is the ONLY way
 *    an answer may be something other than an existing label.
 *  - `question-clarify` — "Chat about this": decline the question so the user can talk it over. A
 *    deny whose message is Claude Code's own for that choice, built by core from the held request.
 */
export type PermissionAnswer =
  | { kind: 'allow' }
  | { kind: 'deny' }
  | { kind: 'plan'; mode: 'restore' | 'acceptEdits' | 'manual' }
  | { kind: 'plan-revise'; message: string }
  | { kind: 'question'; answers: Record<string, string | string[]>; freeText?: string[] }
  | { kind: 'question-clarify' }

/** Typed text in an answer ("Revise…" feedback, a question's "Other"), in UTF-16 code units. ONE
 *  definition: core refuses past it and the answer fields stop at it, so a field can never accept
 *  text core would then refuse. A person-sized limit; the decision's byte cap bounds the file. */
export const ANSWER_TEXT_MAX_CHARS = 8000

/** The payload of `window.nodeTerminal.answerPermission`. `decision` is the pre-structured
 *  contract and still works alone; when `answer` is present it wins. */
export interface AnswerPermissionPayload {
  nodeId: string
  pendingId: string
  decision?: 'allow' | 'deny'
  answer?: PermissionAnswer
}

/**
 * The request a node's managed hook is currently holding: its answer-file ticket plus the tool it
 * is asking about. Lets the renderer tell a plan / question hold from an ordinary permission and
 * render the right controls. Deliberately SEPARATE from the approve/deny `pendingId`, which the
 * mirror strips from a question (approve/deny is the wrong UX for a picker) — so adding this lights
 * no existing button.
 */
export interface HeldPermission {
  pendingId: string
  toolName: string
  /** AskUserQuestion only: the held request's EXACT question texts (`readQuestions`), so a surface
   *  can tell which question card the ticket belongs to. Absent = unreadable input = no controls. */
  questions?: string[]
}

/** One AskUserQuestion option, as a surface renders it. */
export interface ChatQuestionOption {
  label: string
  description?: string
}

/** One AskUserQuestion question, read for the answer controls. `question` and each `label` are
 *  ANSWER KEYS (core matches them byte for byte against the pending request), so they are carried
 *  exactly or not at all. `options` is empty for the free-text variant. */
export interface ChatQuestion {
  question: string
  header?: string
  multiSelect: boolean
  options: ChatQuestionOption[]
}

/** Bounds for `readQuestions`. Exceeding one refuses the input (an answer key cannot be truncated);
 *  far above anything the picker shows, which lists a handful of questions with a handful of options. */
export const QUESTIONS_MAX = 16
export const QUESTION_OPTIONS_MAX = 32
export const QUESTION_TEXT_MAX_CHARS = 4000

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
const keyText = (v: unknown): v is string =>
  typeof v === 'string' && v !== '' && v.length <= QUESTION_TEXT_MAX_CHARS
/** A display-only string (header, description): kept when readable, dropped (never refused) when not. */
const displayText = (v: unknown): string | undefined => (keyText(v) && v.trim() !== '' ? v : undefined)

/**
 * The ONE reader of an AskUserQuestion `tool_input` for the answer UI — used for the question card
 * (`core/transcript-reader.ts`) AND for the held request's texts (`normalizeClaude`), so the two can
 * be compared without either side drifting. All or nothing: a question it cannot read, a duplicate
 * question text or anything over the bounds refuses the whole input, because a partial list would
 * let the UI submit an answer that silently skips a question. Undefined = no controls, read-only card.
 */
export function readQuestions(input: unknown): ChatQuestion[] | undefined {
  if (!isRecord(input) || !Array.isArray(input.questions)) return undefined
  const qs = input.questions
  if (qs.length === 0 || qs.length > QUESTIONS_MAX) return undefined
  const out: ChatQuestion[] = []
  const seen = new Set<string>()
  for (const q of qs) {
    if (!isRecord(q) || !keyText(q.question) || seen.has(q.question)) return undefined
    seen.add(q.question)
    const options: ChatQuestionOption[] = []
    if (q.options !== undefined) {
      if (!Array.isArray(q.options) || q.options.length > QUESTION_OPTIONS_MAX) return undefined
      for (const o of q.options) {
        if (!isRecord(o) || !keyText(o.label)) return undefined
        const description = displayText(o.description)
        options.push(description ? { label: o.label, description } : { label: o.label })
      }
    }
    const header = displayText(q.header)
    out.push({ question: q.question, ...(header ? { header } : {}), multiSelect: q.multiSelect === true, options })
  }
  return out
}

/** Tool names are agent-controlled text (MCP tools are `mcp__<server>__<tool>`); only a plain
 *  identifier ever rides an event. Anything else is dropped, never repaired. */
const TOOL_NAME_RE = /^[A-Za-z0-9_.:-]{1,128}$/

export function isSafeToolName(name: unknown): name is string {
  return typeof name === 'string' && TOOL_NAME_RE.test(name)
}
