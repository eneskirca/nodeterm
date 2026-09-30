import type { AgentMessageReply } from '@shared/agents/agent-messaging'
import type { BoardCommentDeliverRequest } from '@shared/board-comment'
import type { SessionSource } from '../session/session'
import { useBoardCommentDelivery } from '../state/boardCommentDelivery'

/**
 * The renderer half of a board comment reaching an agent.
 *
 * The comment composer (`BoardLogPanel`) is the ONLY caller of `deliverCommentMentions`, from its
 * send handler, with the text the user just typed. Nothing that READS the board log — a load, a
 * change push, a render — reaches here: a comment that arrives in the file (git pull, another
 * instance, a relay peer, a team-presence guest) is display-only. `board-comment-panel.test.tsx`
 * pins that by running the panel.
 *
 * The delivery itself goes through Canvas, which registers the deliverer below: it holds the target
 * node's restart lock (a comment must not land inside a wake's un-submitted resume line) and
 * publishes pending canvas edits first (main authorizes against its persisted store) — the same two
 * steps the agent `send` path takes — then calls the desktop's main-window-only IPC channel.
 */

/** Only the desktop app's own window delivers. A relay tab onto another machine and a Server Edition
 *  browser tab are display-only: the comment is posted, its mentions render, nothing is typed. */
export function canDeliverBoardComments(source: SessionSource, browserRuntime: boolean): boolean {
  return source === 'local' && !browserRuntime
}

export type BoardCommentDeliverer = (req: BoardCommentDeliverRequest) => Promise<AgentMessageReply>

let deliverer: BoardCommentDeliverer | null = null

/** Canvas registers how a delivery runs (see `runBoardCommentDelivery`). Returns the unregister. */
export function registerBoardCommentDeliverer(fn: BoardCommentDeliverer): () => void {
  deliverer = fn
  return () => {
    if (deliverer === fn) deliverer = null
  }
}

export interface BoardCommentDeliveryDeps {
  /** `guardConcurrentRestart(target, fn)()` — 'not-eligible' while that node restarts or wakes. */
  guard(target: string, fn: () => Promise<'done'>): Promise<'done' | 'not-eligible'>
  /** `syncMessageScope(...)` for this target. */
  sync(): Promise<{ ok: true } | { ok: false; error: string }>
  deliver(req: BoardCommentDeliverRequest): Promise<AgentMessageReply>
}

/** One mention's delivery, as Canvas runs it: lock the target, publish pending edits, deliver. */
export async function runBoardCommentDelivery(
  req: BoardCommentDeliverRequest,
  deps: BoardCommentDeliveryDeps
): Promise<AgentMessageReply> {
  let reply: AgentMessageReply | null = null
  const outcome = await deps.guard(req.targetNodeId, async () => {
    const scope = await deps.sync()
    reply = scope.ok ? await deps.deliver(req) : { ok: false, error: scope.error }
    return 'done' as const
  })
  if (outcome === 'not-eligible')
    return {
      ok: false,
      error: 'the session is restarting or waking',
      result: { kind: 'targetBusy', state: 'restarting' }
    }
  return reply ?? { ok: false, error: 'delivery produced no reply' }
}

/**
 * One in-flight run of `fn`, shared by every caller that asks while it runs; the next caller after
 * it settles starts a fresh one. A comment mentioning four sessions delivers them in parallel, and
 * each asks `syncMessageScope` to publish pending canvas edits — one save serves them all.
 */
export function coalesce<T>(fn: () => Promise<T>): () => Promise<T> {
  let inFlight: Promise<T> | null = null
  return () => {
    if (inFlight) return inFlight
    let run: Promise<T>
    try {
      run = fn()
    } catch (err) {
      run = Promise.reject(err) // a synchronous throw is a failed run, not a stuck slot
    }
    const shared = run.finally(() => {
      if (inFlight === shared) inFlight = null
    })
    inFlight = shared
    return shared
  }
}

export type MentionResult = { kind: string; reason?: string; error?: string }

/** The typed outcome a reply carries, or a plain failure with the reply's own words. */
export function mentionResultFromReply(reply: AgentMessageReply): MentionResult {
  const r = reply.result as { kind?: unknown; reason?: unknown } | undefined
  if (r && typeof r.kind === 'string')
    return { kind: r.kind, ...(typeof r.reason === 'string' ? { reason: r.reason } : {}) }
  return { kind: 'error', error: reply.error || 'no outcome was reported' }
}

/**
 * Deliver a just-posted comment to each session it mentions, recording "sending…" at once and each
 * target's own outcome as it lands. One call per target, in parallel: each holds only its own
 * target's lock, and the core serializes deliveries per pane.
 */
export async function deliverCommentMentions(
  comment: { projectId: string; commentId: string; author: string; text: string },
  targets: readonly string[]
): Promise<void> {
  const store = useBoardCommentDelivery.getState()
  // Remembered as THIS machine's comment before anything is sent: its row may then trust the log's
  // delivery lines for it after a reload (and no one else's).
  store.markSent(comment.commentId)
  for (const t of targets) store.set(comment.commentId, t, { at: Date.now(), state: 'sending' })
  await Promise.all(
    targets.map(async (targetNodeId) => {
      let result: MentionResult
      try {
        result = deliverer
          ? mentionResultFromReply(await deliverer({ ...comment, targetNodeId }))
          : { kind: 'error', error: 'the canvas is not ready to deliver it' }
      } catch (err) {
        result = { kind: 'error', error: err instanceof Error ? err.message : String(err) }
      }
      useBoardCommentDelivery
        .getState()
        .set(comment.commentId, targetNodeId, { at: Date.now(), state: 'done', ...result })
    })
  )
}
