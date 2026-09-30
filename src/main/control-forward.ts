// Desktop main's half of a canvas-control call: forward it to the renderer's dispatch and wait for
// the one answer, bounded. Pulled out of `src/main/index.ts` (it was the `pendingControl` map) so
// the timeout and what follows it are tested by EFFECT rather than by reading index.ts.
//
// A TIMEOUT HERE IS NOT A REFUSAL. Main gives up waiting; the renderer is not told and does not
// stop. A confirm dialog dismisses itself at the same deadline (ConfirmState.expiresAt), but a verb
// with no dialog — an `open-worktree` whose `git worktree add` outlives the wait, an open whose
// issue lookup is slow — goes on and does its work after the caller was told it got no answer. So
// the timeout answers `indeterminate: true` (the request ledger then refuses a retry as "unknown"
// instead of running it a second time), and an answer that arrives afterwards is handed to the
// caller's `onLate` so the ledger can replay what really happened to the next retry.
//
// WHATEVER MAIN DOES WITH AN ANSWER RUNS ON BOTH. Main post-processes the renderer's answer
// (recording who owns an opened browser, a project grant). That step is `finish`, and the forwarder
// applies it to the on-time answer AND to a late one before handing it off: the late answer is the
// one the ledger replays, and replaying "opened browser b1" without the ownership record told the
// agent it had a browser it could never drive.
import { randomUUID } from 'node:crypto'
import { isDestructiveVerb } from '../shared/control-verbs'

export interface ControlForwardReply {
  ok: boolean
  message?: string
  result?: unknown
  error?: string
  indeterminate?: boolean
}

/**
 * The timeout's sentence, by what the verb could still be doing. Only a confirm-gated verb may be
 * called safe to retry: its dialog is gone, so nothing was confirmed. Anything else may still
 * complete, and telling an agent it is safe to retry an open is how a second node gets opened.
 *
 * `claimed` = the request ledger holds a row for this call (the forwarder was given `onLate`). Then
 * the ROUTE, which holds the id, adds the line that names it and says to pass it as `--request-id`
 * (`requestIdRetryHint`); this sentence must not point at the flag itself, because the forwarder
 * never sees the id — and a flag with no value to pass is how an agent came to re-run the bare
 * command, get a fresh id, and open a second one. Without a claim there is no id to pass at all:
 * the only honest advice is to look before retrying.
 */
export function controlTimeoutError(verb: string, timeoutMs: number, claimed: boolean): string {
  const lead = `no answer within ${timeoutMs / 1000}s`
  if (isDestructiveVerb(verb)) return `${lead} — the confirmation dialog has been dismissed; safe to retry`
  if (claimed) return `${lead} — the request was not cancelled and may still complete, so it may have taken effect`
  return `${lead} — the request was not cancelled and may still complete; check the canvas for its effect before retrying`
}

/**
 * The reply when main's own finishing step throws on an answer the renderer DID give. The effect may
 * well have happened (the renderer answered), so this is indeterminate like a timeout — and worded by
 * the same claim rule: with a ledger row the route adds the id to pass back, without one the only
 * honest advice is to look first.
 */
export function controlFinishError(verb: string, claimed: boolean): string {
  const lead = `${verb}: the app could not finish processing the answer, so it may have taken effect`
  return claimed ? lead : `${lead}; check the canvas for its effect before retrying`
}

/** How long a late renderer answer is still worth handing back. Past it the ledger row stays
 *  unknown and a retry is told to `list`. */
export const LATE_CONTROL_ANSWER_MS = 30 * 60 * 1000

export function createControlForwarder(opts: {
  timeoutMs: number
  lateWindowMs?: number
  newId?: () => string
}): {
  /**
   * Send via `send(requestId)` and wait for `answer` with that id, at most `timeoutMs`. `finish`
   * post-processes whichever answer arrives (on time, or late before it goes to `onLate`); it never
   * runs on the timeout's own reply, which is not an answer.
   */
  forward(
    verb: string,
    send: (requestId: string) => void,
    opts?: {
      onLate?: (reply: ControlForwardReply) => void
      finish?: (reply: ControlForwardReply) => ControlForwardReply
    }
  ): Promise<ControlForwardReply>
  /** The renderer's answer (the `agentControlResult` IPC). */
  answer(payload: { requestId: string } & ControlForwardReply): void
} {
  const newId = opts.newId ?? randomUUID
  const lateWindowMs = opts.lateWindowMs ?? LATE_CONTROL_ANSWER_MS
  type Finish = (r: ControlForwardReply) => ControlForwardReply
  const same: Finish = (r) => r
  // `finish` runs after the pending entry is gone, inside the IPC listener. A throw there must not
  // escape (nothing would resolve the route's handler, and its ledger row would sit in flight until
  // stale): it becomes an indeterminate reply on time, and on the late path no answer at all — the
  // row stays unknown, because an answer main could not finish is not one to replay.
  const guarded = (verb: string, finish: Finish, reply: ControlForwardReply): ControlForwardReply | null => {
    try {
      return finish(reply)
    } catch (e) {
      console.warn(`[canvas-control] finishing the ${verb} answer failed`, e)
      return null
    }
  }
  const pending = new Map<
    string,
    {
      resolve: (r: ControlForwardReply) => void
      verb: string
      claimed: boolean
      finish: Finish
      timer: NodeJS.Timeout
    }
  >()
  const late = new Map<
    string,
    { onLate: (r: ControlForwardReply) => void; verb: string; finish: Finish; timer: NodeJS.Timeout }
  >()
  return {
    forward(verb, send, { onLate, finish = same } = {}) {
      const requestId = newId()
      return new Promise<ControlForwardReply>((resolve) => {
        const timer = setTimeout(() => {
          pending.delete(requestId)
          if (onLate) {
            const lateTimer = setTimeout(() => late.delete(requestId), lateWindowMs)
            late.set(requestId, { onLate, verb, finish, timer: lateTimer })
          }
          resolve({
            ok: false,
            error: controlTimeoutError(verb, opts.timeoutMs, onLate !== undefined),
            indeterminate: true
          })
        }, opts.timeoutMs)
        pending.set(requestId, { resolve, verb, claimed: onLate !== undefined, finish, timer })
        send(requestId)
      })
    },
    answer({ requestId, ...reply }) {
      const waiting = pending.get(requestId)
      if (waiting) {
        clearTimeout(waiting.timer)
        pending.delete(requestId)
        const finished = guarded(waiting.verb, waiting.finish, reply)
        waiting.resolve(
          finished ?? {
            ok: false,
            error: controlFinishError(waiting.verb, waiting.claimed),
            indeterminate: true
          }
        )
        return
      }
      const after = late.get(requestId)
      if (!after) return
      clearTimeout(after.timer)
      late.delete(requestId)
      const finished = guarded(after.verb, after.finish, reply)
      if (finished) after.onLate(finished)
    }
  }
}
