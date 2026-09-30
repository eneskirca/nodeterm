import type { BoardLogEntry } from '@shared/types'
import {
  BOARD_COMMENT_QUEUE_STALE_MS,
  boardCommentOutcomeText,
  commentIdOfSource,
  parseMentions,
  type BoardCommentOutcomeView
} from '@shared/board-comment'
import type { MentionDelivery } from '../state/boardCommentDelivery'

/** One mention's delivery, as a comment row shows it. */
export interface MentionStatus {
  nodeId: string
  view: BoardCommentOutcomeView
}

interface TraceOutcome {
  ts: number
  kind: string
  reason?: string
}

/** Is this log line a delivery outcome a board comment produced? (`agent-message` with a
 *  `board-comment:<id>` source.) Such lines belong ON their comment's row, not as rows of their own. */
export function isBoardCommentTrace(e: BoardLogEntry): boolean {
  return e.kind === 'event' && e.event?.type === 'agent-message' && commentIdOfSource(e.event.from) !== null
}

/** Every board-comment delivery outcome in a log, reduced to the LATEST per (comment, target). The
 *  log is a shared file, so every field is re-checked as the type it must be before it is used. */
export function boardCommentTraces(
  entries: readonly BoardLogEntry[]
): Map<string, Map<string, TraceOutcome>> {
  const out = new Map<string, Map<string, TraceOutcome>>()
  for (const e of entries) {
    if (!isBoardCommentTrace(e)) continue
    const ev = e.event!
    const commentId = commentIdOfSource(ev.from)!
    if (typeof ev.to !== 'string' || typeof ev.title !== 'string' || typeof e.ts !== 'number') continue
    const byTarget = out.get(commentId) ?? new Map<string, TraceOutcome>()
    const prev = byTarget.get(ev.to)
    if (!prev || e.ts >= prev.ts)
      byTarget.set(ev.to, {
        ts: e.ts,
        kind: ev.title,
        ...(typeof ev.reason === 'string' ? { reason: ev.reason } : {})
      })
    out.set(commentId, byTarget)
  }
  return out
}

/** A log line dated after "now" is not an outcome this machine recorded (the core stamps its own
 *  clock), so it is ignored rather than allowed to outrank what this app run saw. */
const FUTURE_SLACK_MS = 60_000

const STALE_QUEUED: BoardCommentOutcomeView = {
  tone: 'warn',
  text: 'queued, but no outcome was recorded — the app may have closed before it was delivered'
}
const NOTHING_RECORDED: BoardCommentOutcomeView = { tone: 'warn', text: 'no delivery outcome was recorded' }

function viewOf(d: MentionDelivery, now: number): BoardCommentOutcomeView {
  if (d.state === 'sending') return { tone: 'pending', text: 'sending…' }
  if (d.kind === 'error') return { tone: 'error', text: `not delivered — ${d.error ?? 'unknown error'}` }
  if (d.kind === 'queued' && now - d.at > BOARD_COMMENT_QUEUE_STALE_MS) return STALE_QUEUED
  return boardCommentOutcomeText(d.kind, d.reason)
}

/**
 * The delivery status of each session a comment mentions, in the order the text mentions them.
 *
 * Only for a comment THIS machine sent (`own`). The log is shared: a teammate's comment arrives with
 * their machine's trace lines, and a forged line is one append away — on this row either would read
 * as a delivery that happened here. A comment that is not ours shows no status at all; its lines stay
 * visible in the feed as what they are (`eventBody`).
 *
 * For our own: the newer of this app run's record (`transient`) and the latest outcome the log holds.
 * A `queued` older than the queue can hold a message says it never finished. A mention with neither
 * record says nothing was recorded — a silence here could be read as success.
 */
export function mentionStatuses(
  comment: BoardLogEntry,
  traces: Map<string, Map<string, TraceOutcome>>,
  transient: Record<string, MentionDelivery> | undefined,
  opts: { own: boolean; now: number }
): MentionStatus[] {
  if (comment.kind !== 'comment' || typeof comment.text !== 'string') return []
  if (!opts.own && !transient) return []
  const logged = opts.own ? traces.get(comment.id) : undefined
  const out: MentionStatus[] = []
  for (const nodeId of parseMentions(comment.text)) {
    const raw = logged?.get(nodeId)
    const t = raw && raw.ts <= opts.now + FUTURE_SLACK_MS ? raw : undefined
    const live = transient?.[nodeId]
    if (live && (!t || live.at >= t.ts)) out.push({ nodeId, view: viewOf(live, opts.now) })
    else if (t)
      out.push({
        nodeId,
        view: viewOf({ at: t.ts, state: 'done', kind: t.kind, reason: t.reason }, opts.now)
      })
    else if (opts.own) out.push({ nodeId, view: NOTHING_RECORDED })
  }
  return out
}
