// An OWNER's relay tab on a hosted team: listen for devices asking to join and answer them.
//
// Subscribe FIRST, then pull (R25). The host tells a connected owner every open request as it
// arrives and replays the open ones when the owner's session opens — that replay can land before
// this tab subscribed, and the pull (`relay:hosted:pending`) is what makes that safe. The queue
// de-dupes, so the two overlapping is harmless. See docs/hosted-team-relay.md.
import type { HostedPendingClosedReason, HostedRole, HostedSessionApi } from '@shared/types'
import type { QueuedRequest } from './hostedPendingQueue'
import { stripIpcPrefix } from './hostedTeam'

export interface OwnerQueueSink {
  /** This owner tab's subscription is live. */
  attach(projectId: string): void
  add(item: QueuedRequest): void
  close(pendingId: string, reason: HostedPendingClosedReason): void
  /** The tab is going away: drop its requests. */
  drop(projectId: string): void
}

/** Start feeding one owner tab's requests into the queue. Returns its teardown (idempotent). */
export function attachHostedOwner(
  hosted: HostedSessionApi,
  ctx: { projectId: string; teamLabel: string },
  sink: OwnerQueueSink
): () => void {
  let live = true
  sink.attach(ctx.projectId)
  const add = (pending: unknown): void => {
    if (live) sink.add({ projectId: ctx.projectId, teamLabel: ctx.teamLabel, pending: pending as QueuedRequest['pending'], answerer: hosted })
  }
  const unPending = hosted.onPeerPending(add)
  const unClosed = hosted.onPendingClosed((c) => {
    if (live && c && typeof c.pendingId === 'string') sink.close(c.pendingId, c.reason)
  })
  hosted.pending().then(
    (list) => {
      if (Array.isArray(list)) for (const p of list) add(p)
    },
    // A failed pull (the tab dropped, the host refused) costs only the replay safety net: the push
    // deltas keep arriving, and a reconnect pulls again.
    () => {}
  )
  return () => {
    if (!live) return
    live = false
    unPending()
    unClosed()
    sink.drop(ctx.projectId)
  }
}

export type HostedAnswer = { kind: 'approve'; role: HostedRole } | { kind: 'deny' }

/** Where an answer's progress is recorded (the queue store's `beginAnswer` / `finishAnswer`). */
export interface AnswerLedger {
  begin(pendingId: string): void
  /** `landed` = the host answered (true or false); false = it never did. */
  finish(item: QueuedRequest, landed: boolean): void
}

/** Send an owner's answer. The request leaves the screen at once, and is settled only if the host
 *  ANSWERED (true or false) — an answer that never landed leaves it answerable (R40). Resolves with
 *  the line to show the owner, or null when it landed. */
export async function answerHostedRequest(
  item: QueuedRequest,
  answer: HostedAnswer,
  ledger: AnswerLedger
): Promise<{ kind: 'info' | 'error'; text: string } | null> {
  const id = item.pending.pendingId
  ledger.begin(id)
  try {
    const ok = answer.kind === 'approve' ? await item.answerer.approve(id, answer.role) : await item.answerer.deny(id)
    ledger.finish(item, true)
    // False is an answer, not a failure: another owner got there first, or the device left.
    return ok ? null : { kind: 'info', text: 'That request was already answered or has gone.' }
  } catch (err) {
    ledger.finish(item, false)
    return { kind: 'error', text: `Could not answer the request: ${stripIpcPrefix(err instanceof Error ? err.message : String(err))}` }
  }
}
