import { create } from 'zustand'
import { readLocal, writeLocal } from '../lib/localStore'

/** localStorage key for the comments THIS machine delivered (id → when). */
export const SENT_COMMENTS_KEY = 'nodeterm.boardCommentsSent'
const SENT_MAX = 500
const COMMENT_ID_RE = /^[A-Za-z0-9-]{1,64}$/

/**
 * The comments this machine delivered, as stored. A comment row trusts the board log's delivery
 * lines ONLY for these: the log is shared, and a teammate's comment arrives with THEIR machine's
 * trace lines, which on this row would read as "delivered here". Per viewer and best-effort by
 * design (a cleared store only means an old row shows no status). Every entry is re-checked.
 */
export function readSentComments(): Record<string, number> {
  const out: Record<string, number> = {}
  try {
    const raw = readLocal(SENT_COMMENTS_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : null
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return out
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>))
      if (COMMENT_ID_RE.test(k) && typeof v === 'number' && Number.isFinite(v)) out[k] = v
  } catch {
    // unreadable ⇒ nothing remembered
  }
  return out
}

/** Best-effort (`writeLocal` never throws); the in-memory copy still answers for this app run. */
function writeSent(sent: Record<string, number>): void {
  writeLocal(SENT_COMMENTS_KEY, JSON.stringify(sent))
}

/**
 * What THIS app run knows about the deliveries of the board comments the local user posted:
 * `byComment[commentId][targetNodeId]`. Transient on purpose — the durable record is the delivery
 * trace in the board log itself (one `agent-message` line per outcome, `from: board-comment:<id>`),
 * which a reloaded comment row reads. This store only covers what the log cannot: "sending…" before
 * any outcome exists, and a failure that never reached the core (no canvas to deliver through, a
 * canvas that could not publish its edits, a node mid-restart, an IPC that threw).
 */
export type MentionDelivery =
  | { at: number; state: 'sending' }
  | { at: number; state: 'done'; kind: string; reason?: string; error?: string }

/** Comments whose deliveries are remembered. Oldest forgotten first; a forgotten one falls back to
 *  its log lines, which is exactly the post-reload behaviour. */
const MAX_COMMENTS = 200

interface BoardCommentDeliveryState {
  byComment: Record<string, Record<string, MentionDelivery>>
  /** Comments this machine delivered (persisted — see `readSentComments`). */
  sent: Record<string, number>
  markSent(commentId: string): void
  set(commentId: string, targetNodeId: string, d: MentionDelivery): void
  reset(): void
}

export const useBoardCommentDelivery = create<BoardCommentDeliveryState>((set) => ({
  byComment: {},
  sent: readSentComments(),
  markSent: (commentId) =>
    set((s) => {
      const next = { ...s.sent, [commentId]: Date.now() }
      const ids = Object.keys(next).sort((a, b) => next[a] - next[b])
      for (const id of ids.slice(0, Math.max(0, ids.length - SENT_MAX))) delete next[id]
      writeSent(next)
      return { sent: next }
    }),
  set: (commentId, targetNodeId, d) =>
    set((s) => {
      const next = { ...s.byComment, [commentId]: { ...s.byComment[commentId], [targetNodeId]: d } }
      const ids = Object.keys(next)
      for (const id of ids.slice(0, Math.max(0, ids.length - MAX_COMMENTS))) delete next[id]
      return { byComment: next }
    }),
  reset: () => set({ byComment: {}, sent: {} })
}))
