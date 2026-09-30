// Structured hook-reply decisions — the core half of answering a HELD Claude PermissionRequest with
// more than a bare allow/deny (docs/hook-reply-approvals.md, research:
// docs/superpowers/plans/2026-09-26-answer-paths-research.md).
//
// Division of labour, and why it is this way round:
//   - CORE (here) builds and validates the decision. It reads the pending request file the hook
//     wrote (`~/.nodeterm/pending/<pendingId>.json`) and treats it as the ONLY source of truth for
//     the tool being held and — for a question — the exact `questions` array to echo. Nothing the
//     renderer sends is echoed without being checked against that file: the question keys must be
//     question texts from it, the labels must be its option labels (unless the answer marks the
//     entry as free text), every enum is re-checked, every string is capped.
//   - The HOOK SCRIPT (managed-script.ts) stays trivial sh: it prints a JSON answer verbatim only
//     after a strict prefix/shape/size test (`isBoundedAnswerContent` is the same rule in TS).
//
// Pure except `answerHeldPermission`, which takes its two I/O legs (read the request, write the
// answer) as injected functions so desktop-local, desktop-SSH and Server Edition share ONE body.

import {
  ASK_USER_QUESTION_TOOL,
  ANSWER_TEXT_MAX_CHARS,
  EXIT_PLAN_MODE_TOOL,
  isSafeToolName,
  type PermissionAnswer
} from '../../shared/agents/permission-answer'
import type { NormalizedAgentEvent } from '../../shared/agents/normalize'

/**
 * Every JSON answer core writes starts with exactly these bytes, followed by `"allow"` or `"deny"`.
 * The hook script matches this literal before printing anything, so a stray or hostile file
 * cannot put some other hook's output (or free-form text) on Claude's stdout. Pinned byte-for-byte
 * in managed-script.ts — change both together.
 */
export const PERMISSION_DECISION_PREFIX =
  '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":'

/** Largest JSON answer core will write and the script will print, in UTF-8 BYTES (core measures
 *  with `Buffer.byteLength`; the script with `wc -c` on the file, never `${#…}`, which counts
 *  characters under bash and bytes under dash). A question echo carries the
 *  request's own questions (option descriptions, previews), so it is generous; anything larger is
 *  refused rather than truncated (a truncated decision is invalid JSON). */
export const PERMISSION_DECISION_MAX_BYTES = 64 * 1024

/** How much of the pending request file a reader takes, in UTF-8 BYTES. The file is the raw hook
 *  payload; a plan can be long. Past this the request is treated as unreadable (structured answers
 *  refuse). */
export const PENDING_REQUEST_MAX_BYTES = 512 * 1024

/**
 * Seconds the hook holds an ExitPlanMode / AskUserQuestion request (other tools keep
 * PERM_WAIT_SECS_DEFAULT). People read a plan for minutes. Bounded by the command-hook timeout our
 * installers write EXPLICITLY on the PermissionRequest handler — `timeout: 600`
 * (`PERMISSION_REQUEST_HOOK_TIMEOUT_SECS`, declared in `CLAUDE_HOOK_EVENTS`, shared/agents/hook-events.ts;
 * local, managed-account and SSH installs alike) — so the bound is ours, not a CLI default that
 * could change. 540 leaves a 60 s margin (pinned by tests) so the hook always exits on its own terms. On the main thread the dialog is painted CONCURRENTLY with
 * the hook (research §1), so a long hold blocks nothing; a subagent's request is awaited before
 * its dialog, which is why the script keeps the default hold whenever the payload names an agent_id.
 */
export const PERM_WAIT_SECS_INTERACTIVE = 540

/** Caps on user-typed text, in UTF-16 code units (`string.length`) — a person-sized limit, not a
 *  wire limit; the whole decision's BYTE cap above is what bounds the file. */
export const PLAN_REVISE_MAX_CHARS = ANSWER_TEXT_MAX_CHARS
export const FREE_TEXT_MAX_CHARS = ANSWER_TEXT_MAX_CHARS

const PLAN_REVISE_PREFIX = 'The user reviewed the plan and wants changes before you proceed: '

/** The two fields of the held request core needs. */
export interface PendingRequest {
  toolName: string
  toolInput: Record<string, unknown>
}

export type DecisionResult =
  | { ok: true; content: string; decision: 'allow' | 'deny' }
  | { ok: false; reason: string }

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Parse the pending request file (the raw PermissionRequest hook payload). Null = not usable. */
export function parsePendingRequest(text: string): PendingRequest | null {
  if (typeof text !== 'string' || !text || Buffer.byteLength(text, 'utf8') > PENDING_REQUEST_MAX_BYTES) return null
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (!isPlainObject(raw) || raw.hook_event_name !== 'PermissionRequest') return null
  if (!isSafeToolName(raw.tool_name) || !isPlainObject(raw.tool_input)) return null
  return { toolName: raw.tool_name, toolInput: raw.tool_input }
}

/**
 * Narrow an untrusted value (IPC / WS-RPC payload) to a `PermissionAnswer`. Shape only — the
 * semantic checks against the pending request are `buildPermissionDecision`'s. Null = refuse.
 */
export function parsePermissionAnswer(v: unknown): PermissionAnswer | null {
  if (!isPlainObject(v) || typeof v.kind !== 'string') return null
  switch (v.kind) {
    case 'allow':
      return { kind: 'allow' }
    case 'deny':
      return { kind: 'deny' }
    case 'plan':
      return v.mode === 'restore' || v.mode === 'acceptEdits' || v.mode === 'manual'
        ? { kind: 'plan', mode: v.mode }
        : null
    case 'plan-revise':
      return typeof v.message === 'string' ? { kind: 'plan-revise', message: v.message } : null
    case 'question-clarify':
      return { kind: 'question-clarify' }
    case 'question': {
      if (!isPlainObject(v.answers)) return null
      const answers: Record<string, string | string[]> = Object.create(null)
      for (const [k, a] of Object.entries(v.answers)) {
        if (typeof a === 'string') answers[k] = a
        else if (Array.isArray(a) && a.every((x) => typeof x === 'string')) answers[k] = [...(a as string[])]
        else return null
      }
      if (v.freeText === undefined) return { kind: 'question', answers: { ...answers } }
      if (!Array.isArray(v.freeText) || !v.freeText.every((x) => typeof x === 'string')) return null
      return { kind: 'question', answers: { ...answers }, freeText: [...(v.freeText as string[])] }
    }
    default:
      return null
  }
}

/** The decision JSON Claude reads from the hook's stdout. */
function decisionJson(decision: Record<string, unknown>): string {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } })
}

function capped(content: string, decision: 'allow' | 'deny'): DecisionResult {
  // Belt and braces: everything built here must pass the same test the script applies, or the
  // script would silently ignore it and the user would think they answered.
  if (!isBoundedAnswerContent(content)) return { ok: false, reason: 'decision exceeds the answer bounds' }
  return { ok: true, content, decision }
}

interface QuestionShape {
  labels: Set<string>
  multiSelect: boolean
}

/** Index the request's own questions by their exact text. Null = not a shape we can answer. */
function questionIndex(toolInput: Record<string, unknown>): Map<string, QuestionShape> | null {
  const qs = toolInput.questions
  if (!Array.isArray(qs) || qs.length === 0) return null
  const index = new Map<string, QuestionShape>()
  for (const q of qs) {
    if (!isPlainObject(q) || typeof q.question !== 'string' || !q.question) return null
    const labels = new Set<string>()
    if (Array.isArray(q.options)) {
      for (const o of q.options) if (isPlainObject(o) && typeof o.label === 'string') labels.add(o.label)
    }
    // The "extended" variant (kind: text|number) has no options — only free text can answer it.
    index.set(q.question, { labels, multiSelect: q.multiSelect === true })
  }
  return index
}

/**
 * What Claude Code tells the model when the user picks "Chat about this" in its own question picker
 * — MEASURED verbatim on 2.1.283 (the tool result after the native choice), minus the template's
 * stray indentation. The question texts come from the PENDING FILE, never from the renderer.
 */
export function clarifyMessage(questions: readonly string[]): string {
  return [
    'The user wants to clarify these questions.',
    'This means they may have additional information, context or questions for you.',
    'Take their response into account and then reformulate the questions if appropriate.',
    'Start by asking them what they would like to clarify.',
    '',
    'Questions asked:',
    ...questions.map((q) => `- "${q}"\n  (No answer provided)`)
  ].join('\n')
}

function buildQuestionDecision(
  pending: PendingRequest,
  answers: Record<string, string | string[]>,
  freeText: readonly string[] | undefined
): DecisionResult {
  const index = questionIndex(pending.toolInput)
  if (!index) return { ok: false, reason: 'the held question has no readable questions' }
  const entries = Object.entries(answers)
  if (entries.length === 0) return { ok: false, reason: 'no answers' }
  const free = new Set(freeText ?? [])
  for (const k of free) if (!Object.prototype.hasOwnProperty.call(answers, k)) {
    return { ok: false, reason: 'freeText names a question that is not answered' }
  }
  // Null prototype: a question text of "__proto__" must become an own key, not a prototype write.
  const out: Record<string, string> = Object.create(null)
  for (const [question, answer] of entries) {
    const shape = index.get(question)
    if (!shape) return { ok: false, reason: 'unknown question' }
    if (free.has(question)) {
      const text = typeof answer === 'string' ? answer.trim() : ''
      if (!text || text.length > FREE_TEXT_MAX_CHARS) return { ok: false, reason: 'invalid free-text answer' }
      out[question] = text
    } else if (typeof answer === 'string') {
      if (!shape.labels.has(answer)) return { ok: false, reason: 'unknown option label' }
      out[question] = answer
    } else {
      if (!shape.multiSelect) return { ok: false, reason: 'several labels for a single-select question' }
      if (answer.length === 0 || new Set(answer).size !== answer.length) {
        return { ok: false, reason: 'empty or duplicate labels' }
      }
      if (!answer.every((l) => shape.labels.has(l))) return { ok: false, reason: 'unknown option label' }
      // The TUI's own transcript format for a multi-select answer (hooks docs: "Multi-select
      // answers join labels with commas").
      out[question] = answer.join(', ')
    }
  }
  // Every question the request asks must be answered — the TUI never submits a half-answered
  // picker, and `updatedInput` would hand Claude a question the user never saw answered. Counted on
  // the null-prototype `out`, whose keys are all validated question texts ("__proto__" included).
  if (Object.keys(out).length !== index.size) return { ok: false, reason: 'not every question is answered' }
  // `updatedInput` REPLACES the whole input, so everything the request carried (questions,
  // title/metadata on the extended variant) is echoed from the PENDING FILE, never from the renderer.
  const updatedInput = { ...pending.toolInput, answers: out }
  return capped(decisionJson({ behavior: 'allow', updatedInput }), 'allow')
}

/**
 * Build the answer-file content for a held request. `content` is either a legacy verb
 * (`allow` | `deny`, which the script already understands — and maps, for ExitPlanMode) or a JSON
 * decision starting with `PERMISSION_DECISION_PREFIX`. `decision` is the verb the optimistic
 * "answered" event and the script's own answered POST report.
 *
 * `pending === null` (request file missing/unreadable): the legacy verbs are written anyway — that
 * is exactly today's behavior, and the script is the one that knows the tool. A structured answer
 * refuses, because it cannot be validated (and a missing file usually means the hold is over).
 */
export function buildPermissionDecision(pending: PendingRequest | null, answer: PermissionAnswer): DecisionResult {
  switch (answer.kind) {
    case 'deny':
      return { ok: true, content: 'deny', decision: 'deny' }
    case 'allow':
      // Claude drops a bare allow on AskUserQuestion, and the script keeps holding on one; saying
      // "answered" here would flip the badge for an answer that did nothing.
      if (pending?.toolName === ASK_USER_QUESTION_TOOL) {
        return { ok: false, reason: 'a question needs answers, not a plain allow' }
      }
      return { ok: true, content: 'allow', decision: 'allow' }
    case 'plan': {
      if (pending?.toolName !== EXIT_PLAN_MODE_TOOL) return { ok: false, reason: 'the held request is not a plan' }
      // `updatedInput:{}` — NOT the echoed input, whose `plan` would read as "edited by user".
      // No setMode `auto` exists in this table on purpose (research §2(A)).
      const setMode = answer.mode === 'acceptEdits' ? 'acceptEdits' : answer.mode === 'manual' ? 'default' : null
      if (answer.mode !== 'restore' && !setMode) return { ok: false, reason: 'unknown plan mode' }
      return capped(
        decisionJson({
          behavior: 'allow',
          updatedInput: {},
          ...(setMode ? { updatedPermissions: [{ type: 'setMode', mode: setMode, destination: 'session' }] } : {})
        }),
        'allow'
      )
    }
    case 'plan-revise': {
      if (pending?.toolName !== EXIT_PLAN_MODE_TOOL) return { ok: false, reason: 'the held request is not a plan' }
      const text = typeof answer.message === 'string' ? answer.message.trim() : ''
      if (!text || text.length > PLAN_REVISE_MAX_CHARS) return { ok: false, reason: 'invalid feedback' }
      // No `interrupt`: the turn continues in plan mode and Claude revises (= "No, keep planning").
      return capped(decisionJson({ behavior: 'deny', message: `${PLAN_REVISE_PREFIX}${text}` }), 'deny')
    }
    case 'question':
      if (pending?.toolName !== ASK_USER_QUESTION_TOOL) return { ok: false, reason: 'the held request is not a question' }
      return buildQuestionDecision(pending, answer.answers, answer.freeText)
    case 'question-clarify': {
      if (pending?.toolName !== ASK_USER_QUESTION_TOOL) return { ok: false, reason: 'the held request is not a question' }
      const index = questionIndex(pending.toolInput)
      if (!index) return { ok: false, reason: 'the held question has no readable questions' }
      // No `interrupt`: the turn continues and Claude asks what the user wants to clarify, then
      // stops at the prompt — exactly where the native "Chat about this" leaves it.
      return capped(decisionJson({ behavior: 'deny', message: clarifyMessage([...index.keys()]) }), 'deny')
    }
    default:
      return { ok: false, reason: 'unknown answer' }
  }
}

/**
 * The bound the hook script applies before printing an answer file, in TS: a legacy verb, or a
 * single-line JSON decision with the exact prefix, a `"allow"`/`"deny"` behavior, a closing brace,
 * no control characters and at most PERMISSION_DECISION_MAX_BYTES. Both writers refuse anything
 * else, so a file the script would ignore is never reported as answered.
 */
export function isBoundedAnswerContent(content: string): boolean {
  if (content === 'allow' || content === 'deny') return true
  if (typeof content !== 'string') return false
  if (Buffer.byteLength(content, 'utf8') > PERMISSION_DECISION_MAX_BYTES) return false
  // JSON.stringify escapes every U+0000–U+001F, so a raw one means the file is not ours.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(content)) return false
  if (!content.endsWith('}')) return false
  return (
    content.startsWith(`${PERMISSION_DECISION_PREFIX}"allow"`) ||
    content.startsWith(`${PERMISSION_DECISION_PREFIX}"deny"`)
  )
}

/**
 * The first managed-script revision that understands a JSON answer (and maps a plain `allow` on a
 * plan). `MANAGED_SCRIPT_REVISION` must be >= this — pinned in managed-script.answer.test.ts. It
 * lives HERE rather than in managed-script.ts because that module imports this one.
 *
 * Why a revision gate at all: an SSH host gets a new script only at CONNECT, so a long-connected
 * project can hold a request with an older script. That script reads a JSON answer as neither
 * `allow` nor `deny`, deletes it and prints nothing — the TUI dialog stays — while the write itself
 * succeeded. Without this gate core would report success and the shells would flip NEEDS YOU to
 * "working" over an agent still waiting in its TUI.
 */
export const MIN_STRUCTURED_ANSWER_REVISION = 5

/** Tickets whose PermissionRequest was posted by a script >= MIN_STRUCTURED_ANSWER_REVISION.
 *  Process-local and bounded: the only producer is this process's hook server, so a ticket we never
 *  heard about (another instance's, or from before a restart) is simply not capable. */
const structuredTickets = new Set<string>()
const STRUCTURED_TICKETS_MAX = 1024

export function isStructuredTicket(pendingId: string): boolean {
  return structuredTickets.has(pendingId)
}

/** Test seam. */
export function _resetStructuredTicketsForTest(): void {
  structuredTickets.clear()
}

/**
 * Label a normalized hook event by the posting script's revision (called by the hook server, the
 * one place `clientRevision` is known, so both shells get it). A held request from a capable
 * script is recorded as a structured ticket and keeps `held`; from an older (or unstamped) script
 * `held` is DROPPED, so no surface offers controls the hook cannot honor. Everything else passes
 * through untouched (same reference).
 */
export function labelHeldForRevision(
  ev: NormalizedAgentEvent,
  clientRevision: number | undefined
): NormalizedAgentEvent {
  if (!ev.held) return ev
  if (typeof clientRevision === 'number' && clientRevision >= MIN_STRUCTURED_ANSWER_REVISION) {
    structuredTickets.delete(ev.held.pendingId)
    structuredTickets.add(ev.held.pendingId)
    while (structuredTickets.size > STRUCTURED_TICKETS_MAX) {
      const oldest = structuredTickets.values().next().value
      if (oldest === undefined) break
      structuredTickets.delete(oldest)
    }
    return ev
  }
  const { held: _dropped, ...rest } = ev
  return rest
}

/** The I/O legs of one answer: read the pending request text (null = missing), write the answer. */
export interface HeldPermissionIo {
  readPending(): Promise<string | null>
  write(content: string): Promise<boolean>
}

/**
 * Answer a held request: pick the answer (a structured `answer` wins over the legacy `decision`),
 * read the pending request, build + validate, write. Both shells call this — desktop with a local
 * or ControlMaster I/O pair, the Server Edition with the local one — so the rules live once.
 * Resolves `{ok:false}` without writing on any refusal; never throws.
 */
export async function answerHeldPermission(
  pendingId: string,
  payload: { decision?: unknown; answer?: unknown },
  io: HeldPermissionIo
): Promise<{ ok: boolean; decision?: 'allow' | 'deny' }> {
  const answer =
    payload.answer !== undefined
      ? parsePermissionAnswer(payload.answer)
      : payload.decision === 'allow' || payload.decision === 'deny'
        ? ({ kind: payload.decision } as PermissionAnswer)
        : null
  if (!answer) return { ok: false }
  const capable = isStructuredTicket(pendingId)
  // A structured answer to an OLDER script would be written, silently ignored, and reported as
  // success (see MIN_STRUCTURED_ANSWER_REVISION). Refuse before touching the host.
  if (answer.kind !== 'allow' && answer.kind !== 'deny' && !capable) return { ok: false }
  let text: string | null = null
  try {
    text = await io.readPending()
  } catch {
    text = null
  }
  const pending = text === null ? null : parsePendingRequest(text)
  // Same false success for a plain allow on a plan: an older script prints a BARE allow, which
  // Claude drops. Only refused when we positively know it is a plan held by a non-capable script —
  // an unreadable request keeps the legacy fail-open write.
  if (answer.kind === 'allow' && pending?.toolName === EXIT_PLAN_MODE_TOOL && !capable) return { ok: false }
  const built = buildPermissionDecision(pending, answer)
  if (!built.ok) return { ok: false }
  let written = false
  try {
    written = await io.write(built.content)
  } catch {
    written = false
  }
  return written ? { ok: true, decision: built.decision } : { ok: false }
}
