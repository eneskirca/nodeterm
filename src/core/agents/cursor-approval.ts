/**
 * NEEDS YOU for Cursor (`cursor-agent`), which has NO hook for its approval prompt.
 *
 * Measured on cursor-agent 2026.09.28-64d2043 (interactive TUI, project-level hooks logger): a
 * pending "Run this command?" dialog is preceded by `preToolUse` (+ `beforeShellExecution`) and
 * then silence; an MCP one by `preToolUse` (+ `beforeMCPExecution`). No event, no payload flag.
 * Approve AND skip both end the call with `postToolUse` for the same `tool_use_id`.
 *
 * So: a cursor `preToolUse` whose `tool_use_id` has no `postToolUse`/`postToolUseFailure` gets a
 * pane read at each of CURSOR_APPROVAL_READS_MS (the same `captureSession` the context link uses),
 * stopping at the first that shows Cursor's own approval dialog: the node goes `blocked`. The next
 * hook event (postToolUse on approve or skip, stop on Esc) normalizes to `working`/`done` and
 * replaces it. Nothing polls open-endedly: no pending tool and no quiet turn = no timer and no
 * read; at most CURSOR_APPROVAL_READS_MS.length reads per tool call (and per quiet stretch, below)
 * and `blocked` is emitted once, so a long-running approved command never strobes (rule 7).
 *
 * Why more than one read: MEASURED in the dev app (2026-10-02), a single read 1.5 s after
 * `preToolUse` found no dialog yet and the node sat on RUNNING while the dialog waited ~30 s; the
 * same pane text captured later matched. The dialog's draw time is not ours to know.
 *
 * The dialog test is a closed set (rule 7/14): an exact heading line from the bundle's
 * `decision-logic.ts` (`HR`) plus an option line ending in Cursor's approve hint `(y)`. Anything
 * else degrades to nothing: the node keeps RUNNING, exactly as before this file existed.
 *
 * A SUBAGENT's tool call is watched too: its dialog is drawn on the parent's pane. Its `blocked` (and
 * the `working` that clears it, since normalizeCursor drops child events) carries the PARENT's chat id.
 * A parent `stop` with status `completed` arms the same reads for plan mode's `Ready to build?`.
 *
 * The AskQuestion form fires no tool hook at all (measured: show, answer and Esc; the turn's next
 * hook is its `stop`). So a turn that went quiet (after `beforeSubmitPrompt` or a tool post) arms
 * the same reads for the question box, and a match emits `waiting`, as Claude's AskUserQuestion
 * does. A `preToolUse` cancels them (a tool is running); the next parent tool event or `stop`
 * replaces the `waiting`.
 */
import { isCursorChildToolEvent, type NormalizedAgentEvent } from '../../shared/agents/normalize'
import { probeWithin } from './pane-probe'

/**
 * Every heading `decision-logic.ts` can render. Measured in the TUI: `Run this command?` (shell)
 * and `Run this MCP tool?` (MCP). Read from the bundle only: the rest (a default-mode file write
 * was auto-approved, measured, so `Write to this file?` needs a stricter user config).
 */
export const CURSOR_APPROVAL_HEADINGS: ReadonlySet<string> = new Set([
  'Run this command?',
  'Run this command outside the sandbox?',
  'Run this MCP tool?',
  'Delete this file?',
  'Write to this file?',
  'Read this file?',
  'Allow this web search?',
  'Allow this web fetch?'
])

/** Wait this long for the matching postToolUse before the first pane read. An auto-allowed tool
 *  posts well inside it; an approval waits on a human. */
export const CURSOR_APPROVAL_DELAY_MS = 1500
/** When (ms after `preToolUse`) a still-pending call reads the pane; the first match wins.
 *  note: fixed bounded schedule; a dialog first drawn after the last read stays RUNNING. */
export const CURSOR_APPROVAL_READS_MS: readonly number[] = [CURSOR_APPROVAL_DELAY_MS, 4000, 10000]

/**
 * The dialog sits at the bottom of the screen. Only the last few non-blank lines are looked at, so
 * a dialog left in scrollback by an earlier render cannot answer for the current one.
 * note: fixed window, widen if a taller dialog (long command preview) is ever measured.
 */
const TAIL_LINES = 30

/** Strip the box-drawing border and padding Cursor may draw around a row. */
function bare(line: string): string {
  return line.replace(/^[\s│┃|]+|[\s│┃|]+$/g, '')
}

/** PURE. Does the bottom of this capture hold one of `headings` followed by an option ending `hint`? */
function dialogIn(text: string, headings: ReadonlySet<string>, hint: string): boolean {
  const lines = text.split('\n').map(bare).filter(Boolean).slice(-TAIL_LINES)
  const at = lines.findIndex((l) => headings.has(l))
  if (at < 0) return false
  return lines.slice(at + 1).some((l) => l.endsWith(hint))
}

/** PURE. Does this pane capture end in a Cursor approval dialog? */
export function cursorApprovalIn(text: string): boolean {
  return dialogIn(text, CURSOR_APPROVAL_HEADINGS, '(y)')
}

/**
 * Plan mode's hand-off. MEASURED on 2026.10.01-e373342 (`--mode plan`): the turn ENDS (`stop`,
 * status `completed`, normalized `done`) and then the pane shows `Ready to build?` /
 * `→ 1. Yes, build locally (b)` / [`2. Yes, build in cloud (c)`] / `No, propose changes (p or Esc)`.
 * No hook marks it. Claude's equivalent (ExitPlanMode, a PermissionRequest) is `blocked`, so this is
 * too. Answering `b` fires no beforeSubmitPrompt; the build's first parent tool event clears it.
 */
export const CURSOR_PLAN_HEADINGS: ReadonlySet<string> = new Set(['Ready to build?'])

/** A plan box border row once `bare` has stripped its side bars. */
const BORDER = /^[─━└┘╰╯┌┐╭╮\s]+$/

/**
 * PURE. Does this pane capture END in plan mode's "Ready to build?" prompt? Stricter than the
 * approval test: the answered prompt STAYS in the transcript, and measured, the build's own `stop`
 * found it 30 lines up with the finished build below it. So nothing but option rows (ending in a
 * `(key)` hint) and the box border may follow the heading.
 */
export function cursorPlanPromptIn(text: string): boolean {
  const lines = text.split('\n').map(bare).filter(Boolean).slice(-TAIL_LINES)
  let at = lines.length - 1
  while (at >= 0 && !CURSOR_PLAN_HEADINGS.has(lines[at])) at--
  if (at < 0) return false
  const tail = lines.slice(at + 1)
  return tail.some((l) => l.endsWith('(b)')) && tail.every((l) => /\([^()]*\)$/.test(l) || BORDER.test(l))
}

/**
 * The AskQuestion box (bundle: `ask-question-tool-ui.tsx`). Its title is the model's own (measured
 * `Color preference`, `Quick preferences`) or the default `Clarifying Questions`, so it is not
 * matched. Rows as `bare` leaves them: `Question 1 of 2`, an option `› [ ] Red` / `[x] Blue`, and the
 * fixed footer, which wraps on a narrow pane (measured at 60 columns: `... · Enter` / `next/submit ·
 * Esc to skip`).
 */
const QUESTION_ROW = /^Question \d+ of \d+$/
const OPTION_ROW = /^(› )?\[[ x]\] /
const QUESTION_FOOTER_END = 'Esc to skip'

/**
 * PURE. Does this pane capture END in an AskQuestion box? The answered box stays in the transcript
 * as a summary (`AskQuestion <title> (1)` and `[x]` rows) without the footer, so the footer must be
 * the last row above the bottom border, with a `Question N of M` row and an option row above it.
 */
export function cursorQuestionIn(text: string): boolean {
  const lines = text.split('\n').map(bare).filter(Boolean).slice(-TAIL_LINES)
  let end = lines.length
  while (end > 0 && BORDER.test(lines[end - 1])) end--
  if (end === 0 || !lines[end - 1].endsWith(QUESTION_FOOTER_END)) return false
  let at = end - 1
  while (at >= 0 && !QUESTION_ROW.test(lines[at])) at--
  return at >= 0 && lines.slice(at + 1, end).some((l) => OPTION_ROW.test(l))
}

export interface CursorApprovalWatchDeps {
  /** The node's pane text ('' or null = cannot see it). */
  readPane: (nodeId: string) => Promise<string | null>
  /** Where the synthetic `blocked` goes: the hook server's normalized listener. */
  emit: (ev: NormalizedAgentEvent) => void
  /** Override the whole read schedule (tests). Default CURSOR_APPROVAL_READS_MS. */
  readsMs?: readonly number[]
}

export interface CursorApprovalWatch {
  /** Feed every cursor hook payload, after its normalized event was emitted. */
  observe(nodeId: string, payload: Record<string, unknown>, verified: boolean): void
  /** The node was closed or recycled: drop its timers, and let no read still in flight emit. */
  release(nodeId: string): void
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)

/** The pending key of the one plan-prompt watch per node (a tool_use_id is never empty). */
const PLAN = ''
/** The pending key of the one question-box watch per node (no measured tool_use_id has a NUL). */
const QUESTION = '\0question'

interface Pending {
  /** The next read, null while a read is in flight or once the reads are spent. */
  timer: ReturnType<typeof setTimeout> | null
  /** A SUBAGENT's tool call: normalizeCursor drops its events, so this watch also clears its block. */
  child: boolean
  /** Its read matched a dialog. */
  blocked: boolean
}

interface NodeWatch {
  /** tool_use_id (or PLAN) → its watch. */
  calls: Map<string, Pending>
  /** The PARENT chat id, learned from the node's parent events. A synthetic event for a child's
   *  call carries this, never the child's id, which would overwrite the node's resume id. */
  sessionId?: string
  /** This watch has the node in `blocked`: one dialog is one `blocked`, however many pending calls
   *  read it (measured: a parent call and a child call both read the child's dialog). */
  blocked: boolean
  /** A read came back empty or timed out: no more reads until the next turn edge. pane-probe.ts's
   *  rule: retrying an unreadable pane on a short timer stacks ssh children, then logins. */
  broken: boolean
}

export function createCursorApprovalWatch(deps: CursorApprovalWatchDeps): CursorApprovalWatch {
  const reads = deps.readsMs ?? CURSOR_APPROVAL_READS_MS
  const nodes = new Map<string, NodeWatch>()
  // Nodes with a pane capture outstanding. At most one per node, and it outlives release, turn
  // edges and sessionEnd: it is cleared only when the capture itself settles, because a probe that
  // timed out abandons the WAIT, not the ssh child (pane-probe.ts), so a replacement session must not
  // start a second one beside it. A due read finding its node here is skipped, never handed the
  // other read's result: that snapshot may belong to another turn.
  const inFlight = new Set<string>()
  const nodeFor = (nodeId: string): NodeWatch => {
    let w = nodes.get(nodeId)
    if (!w) nodes.set(nodeId, (w = { calls: new Map(), blocked: false, broken: false }))
    return w
  }

  const drop = (w: NodeWatch, id: string): void => {
    const p = w.calls.get(id)
    if (p?.timer) clearTimeout(p.timer)
    w.calls.delete(id)
  }
  /** Turn edge: nothing of the old turn is still waiting, and the breaker gets a fresh turn. */
  const dropAll = (w: NodeWatch): void => {
    for (const id of [...w.calls.keys()]) drop(w, id)
    w.blocked = false
    w.broken = false
  }

  const emit = (nodeId: string, w: NodeWatch, state: 'blocked' | 'waiting' | 'working', verified: boolean): void => {
    const sessionId = w.sessionId
    deps.emit({ nodeId, agentId: 'cursor', ...(sessionId ? { sessionId } : {}), kind: 'state', state, verified })
  }

  const schedule = (nodeId: string, w: NodeWatch, id: string, p: Pending, verified: boolean, step: number): void => {
    const next = step + 1
    if (next >= reads.length) return
    p.timer = setTimeout(() => void check(nodeId, w, id, verified, next), reads[next] - reads[step])
  }

  const check = async (nodeId: string, w: NodeWatch, id: string, verified: boolean, step: number): Promise<void> => {
    const p = w.calls.get(id)
    if (!p) return
    p.timer = null
    if (w.broken) return
    if (inFlight.has(nodeId)) return schedule(nodeId, w, id, p, verified, step)
    inFlight.add(nodeId)
    const raw = Promise.resolve().then(() => deps.readPane(nodeId))
    void raw.catch(() => null).then(() => inFlight.delete(nodeId))
    const text = await probeWithin(() => raw)
    // Re-check: a release, a post or a new turn that landed during the read already ended the watch.
    if (nodes.get(nodeId) !== w || w.calls.get(id) !== p) return
    if (!text) {
      w.broken = true
      for (const q of w.calls.values()) {
        if (q.timer) clearTimeout(q.timer)
        q.timer = null
      }
      return
    }
    const seen = id === PLAN ? cursorPlanPromptIn : id === QUESTION ? cursorQuestionIn : cursorApprovalIn
    if (seen(text)) {
      p.blocked = true
      if (!w.blocked) emit(nodeId, w, id === QUESTION ? 'waiting' : 'blocked', verified)
      w.blocked = true
      return // the call stays pending only so a post can still end it
    }
    schedule(nodeId, w, id, p, verified, step)
  }

  const arm = (nodeId: string, w: NodeWatch, id: string, child: boolean, verified: boolean): void => {
    drop(w, id)
    if (w.broken) return
    const p: Pending = { timer: null, child, blocked: false }
    w.calls.set(id, p)
    p.timer = setTimeout(() => void check(nodeId, w, id, verified, 0), reads[0])
  }

  return {
    observe(nodeId, payload, verified) {
      const ev = payload.hook_event_name
      const isTool = ev === 'preToolUse' || ev === 'postToolUse' || ev === 'postToolUseFailure'
      // A subagent's tool call (the SAME predicate normalizeCursor uses: captured children carry no
      // parent_tool_call_id, only generation_id === conversation_id). It applies to TOOL events only:
      // the parent's own sessionStart/sessionEnd carry generation_id === conversation_id too.
      // A child's dialog is drawn on the PARENT's pane (measured 2026.10.01), so it is watched like
      // the parent's own calls.
      const child = isTool && isCursorChildToolEvent(payload)
      if (ev === 'sessionEnd') {
        if (payload.is_background_agent === true) return // not this node's session (normalizeCursor)
        const w = nodes.get(nodeId)
        if (w) dropAll(w)
        nodes.delete(nodeId)
        return
      }
      const w = nodeFor(nodeId)
      // Only a parent event names the node's session: any event with generation_id ===
      // conversation_id (a child's tool call, or a child's non-tool event such as
      // beforeShellExecution) carries the CHILD's chat id, which would replace the resume id.
      if (!isCursorChildToolEvent(payload)) {
        const sid = str(payload.conversation_id) ?? str(payload.session_id)
        if (sid) w.sessionId = sid
      }
      const id = str(payload.tool_use_id)
      if (ev === 'preToolUse') {
        drop(w, PLAN) // the agent is building after all
        drop(w, QUESTION) // a tool is running: the question box is not up
        if (!child && w.blocked) {
          // A parent tool call means the node is working. A plain call already normalizes to
          // `working`, but a `Task` normalizes to `subagent-start` and its child's events to
          // nothing, so a plan prompt answered with a delegated build would otherwise stay blocked.
          w.blocked = false
          emit(nodeId, w, 'working', verified)
        }
        // The parent's `Task` never gets a postToolUse (measured), so a read hung on it could only
        // see its CHILD's dialog, which the child's own call already watches and later clears.
        if (!id || (!child && payload.tool_name === 'Task')) return
        arm(nodeId, w, id, child, verified)
      } else if (isTool && id) {
        const p = w.calls.get(id)
        drop(w, id)
        if (!child) {
          w.blocked = false // normalizes to `working`, which already replaced any block
        } else if (p?.blocked && ![...w.calls.values()].some((q) => q.blocked)) {
          // A child's post normalizes to nothing, so the block this watch raised would stick.
          w.blocked = false
          emit(nodeId, w, 'working', verified)
        }
        // Quiet again: the model may ask next. A child's post counts too: the parent's `Task`
        // never posts, and the parent may ask once its child is done.
        if (!w.blocked) arm(nodeId, w, QUESTION, false, verified)
      } else if (ev === 'stop' || ev === 'beforeSubmitPrompt') {
        dropAll(w)
        // A completed turn may end on plan mode's "Ready to build?": the same bounded reads.
        if (ev === 'stop' && payload.status === 'completed') arm(nodeId, w, PLAN, false, verified)
        // A new turn may open on a question: the same bounded reads.
        // note: fixed schedule; a box first drawn after the last read of a quiet stretch stays RUNNING.
        if (ev === 'beforeSubmitPrompt') arm(nodeId, w, QUESTION, false, verified)
      }
    },
    release(nodeId) {
      const w = nodes.get(nodeId)
      if (!w) return
      dropAll(w)
      nodes.delete(nodeId)
    }
  }
}
