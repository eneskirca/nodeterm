import type { MirrorEntry } from '../agent-status-mirror'
import type { AgentState } from '../../shared/agents/normalize'
import type { PaneOwner } from '../../shared/agents/pane-owner-predicate'
import { agentPidIn, isAgentPane } from '../../shared/agents/pane-owner-predicate'
import { buildEnvelope, newFrameNonce } from './agent-message-envelope'
import { PANE_PROBE_TIMEOUT_MS, probeWithin } from './pane-probe'
import {
  decideDelivery,
  decidePreProbe,
  type AgentMessageOutcome,
  type DeliveryFacts,
  type NotPermittedReason,
  type ReceiptSignal,
  type TraceKind
} from './agent-message-decide'
import type { DeliveryTraceInput } from './agent-message-trace'

/**
 * `deliverAgentMessage` — ONE primitive: lock, pre-flight, paste-framed write, post-write re-verify,
 * receipt.
 *
 * EVERY side effect is an injected dep. That is not testing ceremony: it is what lets the
 * SEQUENCING be tested without a pty (this file's sibling unit test) while the PANE BEHAVIOUR is
 * tested against a real tmux pane and a real reader (`agent-message.realtty.test.ts`). A structural
 * test can only catch the tricks it was taught, and this repo has twice shipped a defect that a
 * hand-rolled parser passed and a real reader caught.
 *
 * ── THE RESIDUAL RISK THAT NO GATE CLOSES (recorded here, not only in the design) ────────────────
 *
 * hook-idle ≠ nobody typing. A human's half-composed draft in a genuinely idle agent's composer
 * gets the message appended and the Enter submits both. That is the literal 2026-07-16 objection, it
 * is undetectable from hooks, and G4 plus the trace are what make it diagnosable rather than
 * invisible.
 *
 * ── WHAT IS DELIBERATELY NOT IN v1: CATCH-UP AFTER RESTART ───────────────────────────────────────
 *
 * PR 7's deliver-on-idle queue is IN-MEMORY (`delivery-queue.ts`), and its existence must not imply
 * a persisted one. Catch-up after an app restart is NOT built. A persisted queue would need the same
 * TTL AND a "stale — the sender may have moved on" marker, because `--resume` can land the message
 * in a conversation that no longer expects it — and whether an agent given a stale-marked message
 * behaves better than one given none is a PROMPT question, unverified, to be measured before that
 * queue is built.
 */

/** How long the receipt waits for the target's own next turn.
 *
 * 8 s, and deliberately nowhere near the transport ceiling. `CONTROL_CEILING_MS` is 130 s and the
 * desktop's own control await is 120 s, but that headroom exists so a HUMAN CONFIRMATION DIALOG can
 * stay open. Borrowing it for an automated wait makes a stuck receipt look like a stuck dialog,
 * which is the one thing the person debugging this must be able to tell apart. herdr uses ~5 s; 8
 * gives a slow codex start room without approaching either bound.
 *
 * The receipt is also what makes deliver-on-idle safe (PR 7): a queued message that is never
 * consumed surfaces as an error instead of vanishing.
 */
export const RECEIPT_DEADLINE_MS = 8000

/** The subset of a normalized hook event the receipt reads. Deliberately narrow: the receipt must
 *  not become a second status pipeline. */
export interface ReceiptEvent {
  nodeId: string
  newTurn?: boolean
  state?: AgentState
  /** The POST presented a per-node token this instance minted for this node id. */
  verified?: boolean
}

export interface DeliveryRequest {
  targetNodeId: string
  sourceNodeId: string
  sourceTitle: string
  body: string
  /** The agent the TARGET node is configured to run — gate 1 checks the pane against its binaries. */
  targetAgentId: string
  /** `binariesFor(agentId, settings.customAgents)`. Null/absent ⇒ the pane cannot be named ⇒ the
   *  verdict is `unknown` ⇒ refuse. A caller holding the settings should always pass it, or every
   *  custom agent is permanently unreachable behind a retryable-looking error. */
  targetBinaries?: readonly string[] | null
  /** Is the target on an SSH project? Only changes which ACTION a stale-script refusal names. */
  targetIsRemote?: boolean
  /** Set by PR 5 / PR 6. Present ⇒ the cheapest possible refusal, with no round-trip at all. */
  notPermitted?: NotPermittedReason
  /** Set by PR 4's per-pair limiter. */
  retryAfterMs?: number
  /**
   * Does a live session exist for this node at all? Supplied by the caller (the shell knows;
   * `src/core` does not), defaulting to true.
   *
   * Deliberately NOT derived from an unreadable pane. `paneOwner` answers null for a dead pane AND
   * for a tmux that is missing, a `ps` that failed, a lapsed deadline — calling all of those "the
   * node is gone" would be a confident answer to a question we did not ask. An unreadable pane is
   * `targetNotAgentPane` with `observed: 'unknown'`; only a node with no session is `targetGone`.
   */
  targetLive?: boolean
}

/**
 * Every side effect, injected.
 *
 * ── G5: NOTHING HERE TOUCHES THE UNREAD BIT ─────────────────────────────────────────────────────
 *
 * There is deliberately no `clearUnread`, no `setActive`, and no way to reach either: a delivery is
 * not a human reading a node, and a feature that quietly marks a node read on every message would
 * erase exactly the signal the human relies on. The unit test asserts this over the dep record's
 * KEYS, by running a delivery through a Proxy that refuses any key outside this interface — so the
 * guarantee is checked by execution, not by grepping this file for a name.
 */
export interface DeliveryDeps {
  /** Kernel truth about the target's pane. Unbounded by contract — this module bounds it. */
  paneOwner(nodeId: string): Promise<PaneOwner | null>
  /**
   * Did the target's pane request bracketed paste? UNIMPLEMENTED — nothing wires this yet, and
   * `PtyManager.bracketPasteRequested` (which read `#{bracket_paste_flag}`, a tmux-3.7+ format) was
   * deleted when `sendText` stopped needing to ask. See the long note at the refusal that uses it.
   */
  bracketPasteRequested(nodeId: string): Promise<boolean>
  /**
   * Deliver and submit the PLAIN envelope. Desktop uses one tmux command list; Server Edition
   * separates paste from Enter until pane capture proves the fresh composer settled. The payload
   * must carry no ESC byte of ours, because tmux ≥ 3.7 passes paste-buffer content through vis(3),
   * which renders an embedded frame as literal `^[` text (issue #453). Resolves false only when
   * the envelope did not reach the pane; a post-paste submit failure remains eligible for the
   * receipt watch's honest `stalled` outcome.
   */
  sendEnvelope(nodeId: string, envelope: string, expected?: PaneOwner): Promise<boolean>
  /** The target's status mirror entry — gate 2's whole input. */
  mirrorEntry(nodeId: string): MirrorEntry | undefined
  /** `nodeTokenFilePresent(nodeId)`. */
  tokenFilePresent(nodeId: string): boolean
  /** Serialises everything below against the same target. */
  lock<T>(nodeId: string, fn: () => Promise<T>): Promise<T>
  now(): number
  /** Per-delivery frame nonce. Injected so a test can pin it; defaults to `newFrameNonce`. */
  nonce?(): string
  /** Records the outcome (Task 3.5) and answers where it landed. */
  trace(input: DeliveryTraceInput): Promise<{ traceId: string; traced: TraceKind }>
  /** Subscribe to hook events for the receipt. Returns an unsubscribe. */
  subscribeEvents(cb: (e: ReceiptEvent) => void): () => void
}

/**
 * Is the pane we just wrote into still the pane we checked — and is the same agent PROCESS still in
 * it?
 *
 * Four things must all hold, and each closes a different way the answer can be yes-but-wrong:
 *
 *  1. **`paneId`** (`#{pane_id}`). tmux guarantees it unique for the life of the server and never
 *     reuses it. A tty number, by contrast, is recycled aggressively, so `/dev/pts/9` after is not
 *     evidence of `/dev/pts/9` before.
 *  2. **`tty`** — kept as the cheap corroboration, and the only one an older read carries.
 *  3. **`panePid`** — the pane's ROOT process. Necessary but nowhere near sufficient: it is the
 *     login shell, which OUTLIVES the agent it launched. Isolated by its own test, because a test
 *     that changes the tty and the pane pid together proves neither.
 *  4. **The agent's OWN pid** (`agentPidIn`). This is the one that closes the exploit:
 *
 *         pane root = bash(1000), claude(2000) in the foreground group  → we write
 *         claude exits before reading; bash reads the pasted lines and EXECUTES them
 *         a wrapper (`while :; do claude; done`) starts claude(2100)
 *         post-probe: same pane id, same tty, same pane pid, an agent in the group
 *
 *     On names alone that is "unchanged", and the body that just ran as shell commands would be
 *     reported `delivered`. The pid moved; comparing it is what makes the window OBSERVABLE. It
 *     still cannot un-send the bytes — nothing can — but the sender is told and the trace records
 *     it, which is the whole and only job of a post-write check.
 *
 * NOT argv equality: an agent's foreground group grows a member every time it runs a tool, so argv
 * equality would cry "replaced" on every busy pane and turn a real signal into noise nobody reads.
 *
 * Every UNKNOWN is a "no". A lapsed probe, a read with no `paneId`, a read with no `pids` — none of
 * them can confirm anything, and the fail direction here is to TELL the sender:
 * `deliveredToReplacedTarget` with `nowPane: 'unknown'`, never `delivered`.
 */
function samePane(
  before: PaneOwner,
  after: PaneOwner | null,
  agentId: string,
  binaries: readonly string[] | null | undefined
): boolean {
  if (!after) return false
  if (after.tty !== before.tty || after.panePid !== before.panePid) return false
  if (!before.paneId || !after.paneId || before.paneId !== after.paneId) return false
  if (isAgentPane(after, agentId, binaries) !== 'agent') return false
  const wasPid = agentPidIn(before, agentId, binaries)
  const nowPid = agentPidIn(after, agentId, binaries)
  if (before.processBirths) {
    const beforeIndex = before.pids?.indexOf(wasPid ?? -1) ?? -1
    const afterIndex = after.pids?.indexOf(nowPid ?? -1) ?? -1
    if (!before.processBirths[beforeIndex] ||
        before.processBirths[beforeIndex] !== after.processBirths?.[afterIndex]) return false
  }
  return wasPid !== null && nowPid !== null && wasPid === nowPid
}

/**
 * Wait for the target's own next turn, or give up and say so.
 *
 * rev. 2 had NO receipt at all, so it could not distinguish "B read it" from "the body is sitting
 * in B's composer with no submit" — the failure herdr's CHANGELOG records twice, and the exact
 * failure `isAgentPane`'s first caveat predicts (an agent in the foreground group whose stdin is a
 * pipe never reads the bytes).
 *
 * `newTurn` is the signal, and it is emitted by ALL FIVE supported agents on turn start (claude
 * UserPromptSubmit, codex, gemini, opencode, grok — measured in their normalizers). The bare
 * `working` transition is a documented FALLBACK for an agent whose hooks are misconfigured, not for
 * a whole agent, and the outcome records which of the two was used so a stalling install is
 * diagnosable from the trace.
 *
 * The receipt must itself be VERIFIED. An adversary that could fake a receipt could confirm its own
 * deliveries, which is the same hole gate 2 exists to close — the cost of an unverified receipt is
 * not "a slightly wrong log", it is that PR 7's queue would consider a message consumed.
 */
export interface ReceiptWatch {
  /** Wait up to `deadlineMs` for the advance, or return null. Consumes the watch. */
  wait(deadlineMs?: number): Promise<ReceiptSignal | null>
  /** Drop the subscription without waiting (a refused or failed write has no receipt to collect). */
  cancel(): void
}

/**
 * Start watching BEFORE the write, and buffer.
 *
 * ── THE RACE THIS CLOSES, AND WHY IT CAUSED A DOUBLE DELIVERY ───────────────────────────────────
 *
 * Subscribing after the write looks harmless — the target cannot answer before it is asked — but
 * between the write and the subscription sat the POST-WRITE PROBE, bounded by
 * `PANE_PROBE_TIMEOUT_MS` (2 s) and, on an SSH project, a real round-trip over the ControlMaster. A
 * fast target submits its turn inside that window; `newTurn` fires with nobody listening; the
 * delivery reports `stalled` while the target demonstrably advanced. `RETRYABLE.stalled` is false,
 * but a language model reading "stalled, waited 8000ms" retries anyway — and the retry is a SECOND
 * delivery of a message that already landed.
 *
 * So the subscription opens before the bytes go out and holds anything that arrives. The deadline
 * still starts at `wait()`, i.e. after the write and the probe: the 8 s is a budget for the
 * target's response, not for our own round-trips, and letting a slow probe eat a quarter of it
 * would make the timeout mean something different on SSH than on local.
 */
export function watchForReceipt(
  nodeId: string,
  subscribe: DeliveryDeps['subscribeEvents']
): ReceiptWatch {
  let buffered: ReceiptSignal | null = null
  let deliver: ((s: ReceiptSignal) => void) | null = null
  const unsub = subscribe((e) => {
    if (e.nodeId !== nodeId) return // another node's turn is not this node's receipt
    if (e.verified !== true) return // an unverifiable event is not evidence, here as everywhere
    const signal: ReceiptSignal | null =
      e.newTurn === true ? 'newTurn' : e.state === 'working' ? 'working' : null
    if (!signal || buffered) return // first advance wins; later ones are the turn proceeding
    buffered = signal
    deliver?.(signal)
  })
  const drop = (): void => {
    try {
      unsub()
    } catch {
      // an unsubscribe that throws must not turn a delivered message into a rejection
    }
  }
  return {
    cancel: drop,
    wait(deadlineMs: number = RECEIPT_DEADLINE_MS): Promise<ReceiptSignal | null> {
      if (buffered !== null) {
        // The advance landed while we were writing or probing. Nothing to wait for — and this is
        // exactly the case that used to report `stalled`.
        drop()
        return Promise.resolve(buffered)
      }
      return new Promise<ReceiptSignal | null>((resolve) => {
        let done = false
        const finish = (signal: ReceiptSignal | null): void => {
          if (done) return
          done = true
          clearTimeout(timer)
          deliver = null
          drop()
          resolve(signal)
        }
        const timer = setTimeout(() => finish(null), deadlineMs)
        deliver = finish
      })
    }
  }
}

/**
 * Subscribe and wait, as one call.
 *
 * Kept because it is the honest expression of "watch for the receipt with nothing else going on",
 * and it is what the receipt's own unit tests exercise. `deliverAgentMessage` does NOT use it: it
 * needs the subscription open across the write, which is the whole point of `watchForReceipt`.
 */
export async function awaitReceipt(
  nodeId: string,
  subscribe: DeliveryDeps['subscribeEvents'],
  deadlineMs: number = RECEIPT_DEADLINE_MS
): Promise<ReceiptSignal | null> {
  return watchForReceipt(nodeId, subscribe).wait(deadlineMs)
}

/**
 * Deliver one message into one target node's pane.
 *
 * The whole run is inside the lock — not just the write. `guardConcurrentRestart`'s own comment is
 * the reason: *"a second /exit arriving while the resume line sits un-submitted…"*. A pre-flight
 * that is outside the lock is a pre-flight whose answer can be false before the write happens.
 */
export async function deliverAgentMessage(
  req: DeliveryRequest,
  deps: DeliveryDeps
): Promise<AgentMessageOutcome> {
  const bodyChars = req.body.length
  /**
   * Record the outcome — EVERY outcome, including the refusals that never reach a pane.
   *
   * The refusals are the ones an audit actually wants: an agent hammering a target it may not
   * reach, a rate limiter firing over and over, a pane that keeps reading as a stranger's shell.
   * Tracing only the writes would leave exactly that pattern with no record anywhere, which is the
   * opposite of what a security core is for.
   *
   * The amplification is bounded on both legs and deliberately so: the in-memory ring evicts at
   * `TRACE_RING_CAPACITY`, and the board log rotates at `MAX_BOARD_LOG_BYTES` — the rotation this
   * same PR added, which a per-refusal trace is precisely the workload that needs.
   *
   * The refusal OUTCOMES do not gain a `traceId`: the trace is a record for the human, not a handle
   * for the sender, and widening ten union members to carry an id nobody correlates would be shape
   * for its own sake.
   */
  const trace = async (
    outcome: AgentMessageOutcome['kind'],
    receipt?: ReceiptSignal
  ): Promise<{ traceId: string; traced: TraceKind }> =>
    deps.trace({
      sourceNodeId: req.sourceNodeId,
      sourceTitle: req.sourceTitle,
      targetNodeId: req.targetNodeId,
      outcome,
      ...(receipt ? { receipt } : {}),
      bodyChars
    })
  const refuse = async (o: AgentMessageOutcome): Promise<AgentMessageOutcome> => {
    await trace(o.kind)
    return o
  }

  return deps.lock(req.targetNodeId, async () => {
    // The free gates first, and this ordering is load-bearing rather than tidy: a caller that is
    // not permitted, is talking to itself, is over its rate budget, cannot prove its target's
    // identity, or is aiming at a busy target must be refused WITHOUT a tmux round-trip (and, on an
    // SSH project, without an `ssh` one). The unit test asserts the probe never happens.
    const cheap = decidePreProbe({
      sourceNodeId: req.sourceNodeId,
      targetNodeId: req.targetNodeId,
      notPermitted: req.notPermitted,
      retryAfterMs: req.retryAfterMs,
      targetLive: req.targetLive ?? true,
      target: deps.mirrorEntry(req.targetNodeId),
      tokenFilePresent: deps.tokenFilePresent(req.targetNodeId),
      targetIsRemote: req.targetIsRemote
    })
    if (cheap) return refuse(cheap)

    // ── DO NOT RETRY AN `unknown` PANE VERDICT ON A FIXED SHORT TIMER WITHOUT A CIRCUIT BREAKER ──
    //
    // `probeWithin` abandons the WAIT, not the WORK. Measured: it answers null at 2.0s while the
    // `ssh` child it started lives until `runAsync`'s own 15s reap, so a 2s retry loop stacks ~7
    // overlapping children per pane. `childArgs` carries `-o ControlMaster=auto`, so against a DEAD
    // master each of those children does not multiplex — it opens a full connection, i.e. a REAL
    // LOGIN. A pane that is unreadable *because* its master died is therefore the worst case, and
    // it is the shape this repo already lived through at 72k logins/day (memory:
    // ssh-controlmaster-fallback). This module probes AT MOST TWICE per delivery and never loops;
    // any caller that wants to retry an `unknown` needs backoff plus a per-target cap BEFORE its
    // second attempt, not after the incident.
    const before = await probeWithin(() => deps.paneOwner(req.targetNodeId), PANE_PROBE_TIMEOUT_MS)
    const verdict = isAgentPane(before, req.targetAgentId, req.targetBinaries)
    const facts: DeliveryFacts = {
      notPermitted: req.notPermitted,
      retryAfterMs: req.retryAfterMs,
      targetLive: req.targetLive ?? true,
      pane: verdict,
      paneObserved: before?.command,
      target: deps.mirrorEntry(req.targetNodeId),
      tokenFilePresent: deps.tokenFilePresent(req.targetNodeId),
      targetIsRemote: req.targetIsRemote
      // `pasteAware` deliberately absent: the flag costs a second tmux round-trip and there is no
      // point paying for it to tell a rate-limited caller something it cannot act on.
    }
    const gate = decideDelivery(facts)
    if (gate.kind !== 'proceed') return refuse(gate)
    // `before` is non-null here: `isAgentPane(null, …)` is `unknown`, which the gate refused
    // (as `targetPaneUnreadable` since issue #460 — unreadable is not evidence of not-agent).
    const owner = before as PaneOwner

    // herdr :260 — a multi-line envelope on the UNFRAMED fallback would be submitted line by line
    // as separate turns. It is refused, never sent and hoped for.
    //
    // ── THE ROLLOUT BLOCKER THAT USED TO BE HERE IS GONE; THIS PROBE IS NOW THE ONLY ONE LEFT ───
    //
    // It used to read: `PtyManager.bracketPasteRequested` reads `#{bracket_paste_flag}`, a format
    // that FIRST SHIPPED IN TMUX 3.7, so on Ubuntu 24.04 (3.4), 22.04 (3.2a), Debian 12/13
    // (3.3a/3.5a), Ubuntu 26.04 (3.6a), every SSH target and the Server Edition it expanded to ''
    // and this refusal fired for every delivery — messaging inert on most Linux hosts.
    //
    // That method no longer exists. `sendText` stopped asking whether to frame and hands the
    // payload to `tmux paste-buffer -p`, which consults the pane's real bracketed-paste state
    // inside tmux and has done since tmux 1.7 (2012). There is no version floor on the DELIVERY.
    //
    // WHAT IS STILL OWED HERE, and why this is not simply deleted: this gate is not the delivery,
    // it is a REFUSAL — messaging declines to send a multi-line envelope into a pane that would
    // submit it line by line (herdr :260). Answering that still needs to know whether the target
    // asked for bracketed paste, and `DeliveryDeps.bracketPasteRequested` is still declared with
    // no implementation wired anywhere. Whoever wires it inherits the same three-way problem the
    // old note described ('1' = aware, '0' = genuinely unaware, '' or error = CANNOT ASK), because
    // `targetNotPasteAware` says "the pane did not ask" when the truth may be "we could not ask".
    // Since #453 the delivery below IS that `paste-buffer -p` path — tmux frames the envelope
    // correctly or not at all — so the residual exposure is exactly one shape: a supported agent
    // CLI idling with bracketed paste OFF would receive the multi-line envelope unframed and
    // splice it line by line. No such CLI is known (claude/codex/gemini all keep DECSET 2004 on
    // at the composer, and #453 measured `bracket_paste_flag` = 1 on every Claude pane checked);
    // whoever meets one wires this dep for real instead of widening the delivery.
    if (!(await deps.bracketPasteRequested(req.targetNodeId)))
      return refuse({ kind: 'targetNotPasteAware' })

    // The envelope goes out PLAIN — tmux applies the bracketed-paste frame itself. Desktop's Enter
    // rides the same tmux command list (`PtyManager.sendEnvelope`); Server Edition waits for pane
    // settlement and submits separately. Both replaced a JS-composed frame
    // (`bracketedInjection`, deleted): tmux ≥ 3.7 passes paste-buffer content through vis(3), so a
    // payload-carried `ESC[200~` arrived as the literal text `^[[200~` and the `\r` riding inside
    // the frameless burst never submitted (issue #453, measured on the bundled tmux 3.7b).
    //
    // herdr :48 — the desktop Enter arrives after tmux's own `ESC[201~` close marker. Server's
    // fresh-composer path additionally observes that the TUI rendered the paste before sending it;
    // this closes the asynchronous boot-window case where the boundary was written but not yet
    // consumed by Claude's composer.
    //
    // herdr :116 — framing an unaware app made OpenCode read `A != B` as shell mode; `-p` frames
    // only when the pane's app really requested bracketed paste, so that failure mode is tmux's
    // to prevent now, not ours.
    const payload = buildEnvelope({
      nonce: (deps.nonce ?? newFrameNonce)(),
      sourceId: req.sourceNodeId,
      sourceTitle: req.sourceTitle,
      replyTo: req.sourceNodeId,
      body: req.body
    })
    // The receipt watch opens BEFORE the bytes go out. A fast target can submit its next turn while
    // the post-write probe is still in flight — 2s locally, a real ssh round-trip remotely — and a
    // subscription opened after that probe would miss it and report `stalled` for a message that
    // demonstrably landed. See `watchForReceipt`: that miss is what makes an LLM send it twice.
    const watch = watchForReceipt(req.targetNodeId, deps.subscribeEvents)
    const wrote = await deps.sendEnvelope(req.targetNodeId, payload, owner)
    // The pane went away between the gate and the write. Not a failure of ours and not retryable:
    // the node is gone. It IS traced: a `sendEnvelope` that fails after a partial write has left
    // bytes in somebody's pane, and that must not be the one event with no record.
    if (!wrote) {
      watch.cancel()
      return refuse({ kind: 'targetGone' })
    }

    // G3, post-write. rev. 2's gate 3 was check-then-act — a TOCTOU where the body lands in a
    // stranger's shell. The post-check CANNOT un-send the bytes; the residual window is unchanged.
    // What it buys is that the sender is TOLD and the trace records it, and that
    // `deliveredToReplacedTarget` is never reported as success.
    const after = await probeWithin(() => deps.paneOwner(req.targetNodeId), PANE_PROBE_TIMEOUT_MS)
    if (!samePane(owner, after, req.targetAgentId, req.targetBinaries)) {
      watch.cancel()
      const t = await trace('deliveredToReplacedTarget')
      return {
        kind: 'deliveredToReplacedTarget',
        traceId: t.traceId,
        traced: t.traced,
        wasPane: owner.command,
        nowPane: after?.command ?? 'unknown'
      }
    }

    const signal = await watch.wait(RECEIPT_DEADLINE_MS)
    if (!signal) {
      const t = await trace('stalled')
      return { kind: 'stalled', traceId: t.traceId, traced: t.traced, waitedMs: RECEIPT_DEADLINE_MS }
    }
    const t = await trace('delivered', signal)
    return { kind: 'delivered', traceId: t.traceId, traced: t.traced, receipt: 'observed', signal }
  })
}
