// A board comment that @mentions a session node is delivered to that agent through the agent
// messaging core (src/core/agents/agent-messaging.ts, `deliverBoardCommentFromUi`). This file is the
// part three places must agree on: the comment composer that inserts a mention, the main-process
// handler that decides what reaches the pane, and the feed that renders the token and the outcome.
//
// ── WHO MAY TRIGGER A DELIVERY ─────────────────────────────────────────────────────────────────
//
// Only the local user, typing in THIS app. A comment is text in `.nodeterm/board-log.jsonl`, which
// is shared: a git pull, another instance writing the file, a relay peer or a team-presence guest can
// all put a comment carrying mention tokens into it. None of those may type into a local pane —
// that is cross-user prompt injection. So a delivery is started only by the composer's own send
// handler, with the text the user just typed, and NOTHING that reads the log (load, change push,
// render) has a path to it. A token that arrives in the file is display-only, forever.
//
// ── THE TOKEN ───────────────────────────────────────────────────────────────────────────────────
//
// `@[<label>](node:<id>)`. The id is the authority; the label is only a fallback for rendering a
// node that no longer exists. The id alphabet is `isSafeNodeId`'s, so a token can never name an id
// the messaging scope would refuse as unaddressable, and a label can hold no bracket or control
// character, so a title cannot close the label early and name a different id.
import { isSafeNodeId } from './safe-id'
import { sanitizeChatText } from './mobile-chat'
import { oneLine as oneLineText } from './one-line'

/** Longest label a token carries. A label is a hint for a node that is gone, not a title store. */
export const BOARD_MENTION_LABEL_MAX = 60

/** How many sessions one comment may mention. Equal to the messaging core's per-turn fan-out cap
 *  (`FANOUT_PER_TURN`, pinned by a core test), because each comment is one turn of the person who
 *  wrote it. A comment over the cap is refused whole, before anything is posted or delivered,
 *  rather than delivered to the first four and silently not to the rest. */
export const BOARD_COMMENT_MENTION_MAX = 4

/** Longest body delivered to an agent, after sanitizing. The same bound as a stored comment
 *  (`BOARD_LOG_TEXT_MAX`), so what the agent reads is what the board shows. */
export const BOARD_COMMENT_BODY_MAX = 16_384

/** How long after a `queued` outcome a comment row stops presenting it as live: the core's
 *  deliver-on-idle TTL (`DELIVERY_QUEUE_TTL_MS`, 5 min — pinned by a core test) plus a minute. The
 *  queue is durable and a clean restart expires a waiting comment at boot (writing its end), but a
 *  crash inside the queue's save window, or a second instance that does not own the queue, still
 *  never writes one — and a row reading "queued" forever would be a silent lie. */
export const BOARD_COMMENT_QUEUE_STALE_MS = 6 * 60_000

/** The trace/queue identity of a delivery started by a board comment: `board-comment:<commentId>`.
 *  A node id is `[A-Za-z0-9._-]`, so the ':' guarantees this never names, or collides with, a
 *  node. The comment id is what lets the comment row find its own delivery outcomes in the log. */
export const BOARD_COMMENT_SOURCE_PREFIX = 'board-comment:'

/** The envelope's `from:` line for a board comment starts with this. Agent-facing text quotes it. */
export const BOARD_COMMENT_FROM_PREFIX = 'board comment by '

/** The envelope's `reply-to:` value for a board comment. There is no node to `reply` to: a person
 *  wrote it, and they read the answer in the session's pane. */
export const BOARD_COMMENT_REPLY_TO =
  'none (a person wrote this on the project kanban board; answer here in your session)'

const COMMENT_ID_RE = /^[A-Za-z0-9-]{1,64}$/
const AUTHOR_MAX = 60
const PROJECT_ID_MAX = 256

// The label group excludes brackets and line breaks; the id group is `isSafeNodeId`'s alphabet.
// Every match is re-checked with `isSafeNodeId` (which also refuses `.`/`..`).
const MENTION_RE = /@\[([^[\]\r\n]{0,60})\]\(node:([A-Za-z0-9._-]{1,128})\)/g

/** A title made safe to sit inside a token's label: one line, no brackets, capped. */
export function mentionLabel(title: string): string {
  const flat = oneLineText(String(title ?? '')).replace(/[[\]]/g, '')
  return flat.length > BOARD_MENTION_LABEL_MAX ? flat.slice(0, BOARD_MENTION_LABEL_MAX).trimEnd() : flat
}

/** The token the composer's @ picker inserts for a session node. */
export function mentionToken(nodeId: string, title: string): string {
  return `@[${mentionLabel(title)}](node:${nodeId})`
}

export type CommentSegment =
  | { kind: 'text'; text: string }
  | { kind: 'mention'; nodeId: string; label: string }

/** Split a comment into text runs and mentions, in order — what the feed renders. A token whose id
 *  is not addressable stays as plain text. */
export function commentSegments(text: string): CommentSegment[] {
  const out: CommentSegment[] = []
  let at = 0
  for (const m of text.matchAll(MENTION_RE)) {
    const nodeId = m[2]
    if (!isSafeNodeId(nodeId)) continue
    const start = m.index ?? 0
    if (start > at) out.push({ kind: 'text', text: text.slice(at, start) })
    out.push({ kind: 'mention', nodeId, label: m[1] })
    at = start + m[0].length
  }
  if (at < text.length) out.push({ kind: 'text', text: text.slice(at) })
  return out
}

/** The session ids a comment mentions, each once, in the order they first appear. */
export function parseMentions(text: string): string[] {
  const seen: string[] = []
  for (const s of commentSegments(text))
    if (s.kind === 'mention' && !seen.includes(s.nodeId)) seen.push(s.nodeId)
  return seen
}

/** Longest @name the agent reads for a mention. */
export const MENTION_AGENT_NAME_MAX = 40

/**
 * The name a mention becomes in the text the AGENT reads: the label its author saw when they wrote it
 * (never the store's title at delivery time, which can have changed under them), reduced to words —
 * letters, digits, spaces and `. _ - #` — and capped. A node title is chosen by whoever wrote the
 * project file (a cloned repo, a team guest), and this lands in another agent's prompt, so it keeps
 * nothing that reads as syntax. Nothing left ⇒ the node id, addressable by construction.
 */
export function mentionNameForAgent(label: string, nodeId: string): string {
  const words = String(label ?? '')
    .replace(/[^\p{L}\p{M}\p{N} ._#-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MENTION_AGENT_NAME_MAX)
    .trimEnd()
  return words || nodeId
}

/** The comment as the agent reads it: every token becomes `@<name>` (`mentionNameForAgent`). */
export function commentTextForAgent(text: string): string {
  return commentSegments(text)
    .map((s) => (s.kind === 'text' ? s.text : `@${mentionNameForAgent(s.label, s.nodeId)}`))
    .join('')
}

/** The body that reaches the envelope: every control character except `\n`/`\t` removed (ESC above
 *  all — the paste-injection rule; `sanitizeChatText` is the one shared definition), then capped. */
export function boardCommentBody(text: string): string {
  const clean = sanitizeChatText(text)
  return clean.length > BOARD_COMMENT_BODY_MAX ? clean.slice(0, BOARD_COMMENT_BODY_MAX) + '…' : clean
}

export function boardCommentSourceId(commentId: string): string {
  return `${BOARD_COMMENT_SOURCE_PREFIX}${commentId}`
}

/** The comment id a trace's `from` names, or null when it is not a board-comment delivery. Reads a
 *  value from the shared log, so anything that is not a well-formed id is null. */
export function commentIdOfSource(from: unknown): string | null {
  if (typeof from !== 'string' || !from.startsWith(BOARD_COMMENT_SOURCE_PREFIX)) return null
  const id = from.slice(BOARD_COMMENT_SOURCE_PREFIX.length)
  return COMMENT_ID_RE.test(id) ? id : null
}

/** The envelope's `from:` value: `board comment by <author>`, one line, capped. */
export function boardCommentFrom(author: string): string {
  const name = oneLineText(String(author ?? '')).slice(0, AUTHOR_MAX).trim() || 'someone'
  return `${BOARD_COMMENT_FROM_PREFIX}${name}`
}

/** What the comment composer sends to main for ONE mentioned session (one call per mention, so the
 *  renderer can hold each target's restart lock around its own delivery, as the agent path does).
 *  `text` is the whole comment: main parses the mentions out of it, so the text is the only
 *  authority on who is addressed. */
export interface BoardCommentDeliverRequest {
  projectId: string
  commentId: string
  author: string
  text: string
  targetNodeId: string
}

/** Guard for the IPC boundary. Refuses a target the text does not mention and a comment over the
 *  mention cap — a request main cannot reconcile with its own text is malformed, not partial. */
export function isBoardCommentDeliverRequest(x: unknown): x is BoardCommentDeliverRequest {
  if (!x || typeof x !== 'object') return false
  const r = x as Record<string, unknown>
  if (typeof r.projectId !== 'string' || !r.projectId || r.projectId.length > PROJECT_ID_MAX) return false
  // eslint-disable-next-line no-control-regex -- a project id is a map key; controls have no place in it
  if (/[\x00-\x1f\x7f-\x9f]/.test(r.projectId)) return false
  if (typeof r.commentId !== 'string' || !COMMENT_ID_RE.test(r.commentId)) return false
  if (typeof r.author !== 'string' || r.author.length > 200) return false
  if (typeof r.text !== 'string' || r.text.length > BOARD_COMMENT_BODY_MAX + 1) return false
  if (typeof r.targetNodeId !== 'string' || !isSafeNodeId(r.targetNodeId)) return false
  const mentions = parseMentions(r.text)
  if (mentions.length > BOARD_COMMENT_MENTION_MAX) return false
  return mentions.includes(r.targetNodeId)
}

/** How a row presents one mention's delivery. `tone` picks the colour; `text` is the whole sentence. */
export interface BoardCommentOutcomeView {
  tone: 'ok' | 'pending' | 'warn' | 'error'
  text: string
}

// Keyed by the core's outcome kinds (`AgentMessageOutcome['kind']`, which lives in src/core and so
// cannot be imported here). A core test walks `RETRYABLE` against this table, so a new outcome kind
// cannot reach a comment row as silence.
const OUTCOME_TEXT: Record<string, BoardCommentOutcomeView> = {
  delivered: { tone: 'ok', text: 'delivered' },
  // Held for the session's turn to end, or for the ten-second window after the last comment to it.
  queued: { tone: 'pending', text: 'queued — delivered as soon as the session can take it' },
  stalled: {
    tone: 'warn',
    text: 'reached the session, but it started no turn — check its prompt'
  },
  deliveredToReplacedTarget: {
    tone: 'warn',
    text: 'the session changed while it was being delivered — check its pane'
  },
  expired: { tone: 'error', text: 'expired — the session stayed busy until the queue gave up' },
  rateLimited: {
    tone: 'error',
    text: 'not delivered — this session got a board comment moments ago; wait ten seconds'
  },
  queueFull: { tone: 'error', text: 'not delivered — this session\'s message queue is full' },
  targetBusy: { tone: 'error', text: 'not delivered — the session is busy' },
  targetNotIdleUnknown: {
    tone: 'error',
    text: 'not delivered — the session has not reported that it is idle'
  },
  targetStatusUnverified: {
    tone: 'error',
    text: 'not delivered — the session cannot prove its identity (restart it)'
  },
  targetStatusStale: {
    tone: 'error',
    text: 'not delivered — the session has not reported a verified status yet'
  },
  targetHookScriptStale: {
    tone: 'error',
    text: 'not delivered — the session runs an old status hook (restart it)'
  },
  targetPaneUnreadable: {
    tone: 'error',
    text: 'not delivered — the session\'s pane could not be read'
  },
  targetNotAgentPane: {
    tone: 'error',
    text: 'not delivered — its agent is not running in the session right now'
  },
  targetNotPasteAware: {
    tone: 'error',
    text: 'not delivered — the session cannot take a multi-line message'
  },
  targetGone: { tone: 'error', text: 'not delivered — the session is not running' },
  notPermitted: { tone: 'error', text: 'not delivered — not permitted' }
}

const NOT_PERMITTED_TEXT: Record<string, string> = {
  'switch-off':
    'not delivered — agent messaging is off for this project (Settings → Agents)',
  'cross-project': 'not delivered — that session is not on this board',
  'unaddressable-node-id': 'not delivered — that session id cannot be addressed safely',
  'ambiguous-target-node-id':
    'not delivered — that session id exists in more than one project',
  'unproven-target-owner':
    'not delivered — the session was not started in this app run (end it and start it again)',
  'unsupported-edition': 'not delivered — board comments reach agents only in the desktop app'
}

/** The sentence a comment row shows for one delivery outcome. `reason` is the `notPermitted`
 *  reason when there is one. Both come from the shared log for a reloaded row, so an unknown value
 *  still yields a sentence — never an empty one. */
export function boardCommentOutcomeText(kind: string, reason?: unknown): BoardCommentOutcomeView {
  // Own keys only: `kind`/`reason` come from a shared file, and a bare `table[key]` answers
  // `constructor` or `toString` with an inherited function instead of "unknown".
  if (kind === 'notPermitted' && typeof reason === 'string' && Object.hasOwn(NOT_PERMITTED_TEXT, reason))
    return { tone: 'error', text: NOT_PERMITTED_TEXT[reason] }
  return Object.hasOwn(OUTCOME_TEXT, kind) ? OUTCOME_TEXT[kind] : { tone: 'error', text: 'not delivered' }
}
