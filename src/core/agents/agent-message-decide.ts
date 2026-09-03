import type { MirrorEntry } from '../agent-status-mirror'
import type { AgentPaneVerdict } from '../../shared/agents/pane-owner-predicate'
import { MIN_TOKEN_AWARE_REVISION } from './hooks/managed-script'

/**
 * THE PURE DECIDER — every reason a delivery may not happen, decided without a single side effect.
 *
 * The control surface is a boolean all the way down today: `sendText` returns `Promise<boolean>`,
 * the handler turns it into `{ ok, 'sent' | 'failed' }`, the route into 200/400, the shim into
 * exit 1. The caller here is a LANGUAGE MODEL, and an agent that cannot tell "not allowed" from
 * "target busy" retries the wrong one — with a per-pair rate limiter in front of it (PR 4), that is
 * a busy-loop that burns tokens and produces nothing.
 *
 * So the result is a discriminated union, and whether to retry is DATA (`RETRYABLE`), not prose.
 *
 * Nothing in this module reads the clock, the filesystem, a pane or a socket. Every fact arrives in
 * `DeliveryFacts`, which is what lets Task 3.3 test the sequencing without a pty and this file test
 * the policy without either.
 */

/**
 * `unaddressable-node-id` is deliberately its own word rather than a shade of `cross-project`: an
 * id outside `isSafeNodeId` may well be listed in the sender's OWN project file (nothing validates
 * ids on the load path), so calling it a project-scope failure would be a false statement about
 * why it was refused — and it needs a different action from the human. See `agent-message-scope.ts`.
 */
export type NotPermittedReason =
  | 'switch-off'
  | 'cross-project'
  | 'self-send'
  | 'unsupported-edition'
  | 'unaddressable-node-id'
  /** Server Edition's process-local creator ledger says the sender did not spawn this target in
   *  the current server run. This is separate from pane/project ownership: proving which project
   *  spawned a pane does not prove which agent is allowed to control it. */
  | 'caller-not-owner'
  /** The target id names nodes in MORE THAN ONE project while panes are keyed by the bare id —
   *  one global pane, several possible owners, and one of them may be ungranted. Refused because
   *  the per-project grant cannot be attributed (PR #237 review I-1); its own word because the
   *  human's fix is de-duplicating ids, not moving nodes. See `agent-message-scope.ts`. */
  | 'ambiguous-target-node-id'
  /** No proof of which project spawned the target pane: the ledger has neither a fresh-spawn fact
   *  nor a valid generation-bound restart proof, or its owner disagrees with the sole store
   *  claimant (a project.json listing a pane it did not spawn). The store's node-set is
   *  attacker-writable, so ownership is proven at spawn, not read from the file (PR #237 fix
   *  round 2 — the confused deputy driven end-to-end); unprovable ⇒ refuse. Not retryable: the
   *  pane must be freshly (re)spawned by its real owner before it can be messaged. */
  | 'unproven-target-owner'

/** Which signal satisfied the delivery receipt (Task 3.4). */
export type ReceiptSignal = 'newTurn' | 'working'

/** Where a delivery's trace landed. `memory` is a bounded ring, not a durable log — see Task 3.5. */
export type TraceKind = 'board-log' | 'memory'

export type AgentMessageOutcome =
  | { kind: 'delivered'; traceId: string; traced: TraceKind; receipt: 'observed'; signal: ReceiptSignal }
  | { kind: 'queued'; traceId: string; position: number; ttlMs: number }
  | { kind: 'stalled'; traceId: string; traced: TraceKind; waitedMs: number }
  | {
      kind: 'deliveredToReplacedTarget'
      traceId: string
      traced: TraceKind
      wasPane: string
      nowPane: string
    }
  | { kind: 'expired'; traceId: string; queuedForMs: number }
  | { kind: 'rateLimited'; retryAfterMs: number }
  | { kind: 'queueFull'; capacity: number }
  | { kind: 'targetBusy'; state: string }
  | { kind: 'targetNotIdleUnknown'; reason: string }
  | { kind: 'targetStatusUnverified'; note: string } // no token file — needs a human. NOT retryable.
  | { kind: 'targetStatusStale' } // token file exists, no verified event yet. Retryable.
  | { kind: 'targetHookScriptStale'; note: string; observedRevision?: number } // Finding F2. NOT retryable.
  | { kind: 'targetPaneUnreadable' } // the pane probe failed/timed out — says NOTHING about the pane
  | { kind: 'targetNotAgentPane'; observed: string }
  | { kind: 'targetNotPasteAware' }
  | { kind: 'targetGone' }
  | { kind: 'notPermitted'; reason: NotPermittedReason }

export type AgentMessageOutcomeKind = AgentMessageOutcome['kind']

/**
 * The retry column, as data.
 *
 * The caller is a LANGUAGE MODEL: an outcome that is not retryable must SAY so, or it will try
 * again — and with a per-pair rate limiter in front of it, "try again" on a permanent refusal is a
 * busy-loop that burns tokens and produces nothing. A boolean return could not carry this, which is
 * the whole reason the surface stopped being a boolean.
 *
 * `Record<AgentMessageOutcomeKind, boolean>` makes the table exhaustive BY THE TYPE: a new union
 * member that is not listed here is a compile error, not a runtime `undefined` that reads as
 * "not retryable" and silently strands a whole class of caller.
 */
export const RETRYABLE: Record<AgentMessageOutcomeKind, boolean> = {
  delivered: false,
  queued: false,
  stalled: false,
  deliveredToReplacedTarget: false,
  expired: true,
  rateLimited: true,
  queueFull: true,
  targetBusy: true,
  targetNotIdleUnknown: true,
  targetStatusUnverified: false,
  targetStatusStale: true,
  targetHookScriptStale: false,
  targetPaneUnreadable: true,
  targetNotAgentPane: false,
  targetNotPasteAware: false,
  targetGone: false,
  notPermitted: false
}

/**
 * Order is load-bearing, and it is cheapest-and-most-permanent first.
 *
 * A caller that cannot be helped is told so WITHOUT a pane round-trip and WITHOUT burning
 * rate-limit budget. The two identity refusals sit ahead of the idle gate because an identity a
 * node cannot present is a more permanent fact than a turn it happens to be in the middle of.
 */
export const DECISION_ORDER = [
  'notPermitted',
  'rateLimited',
  'targetGone',
  'targetHookScriptStale',
  'targetStatusUnverified',
  'targetStatusStale',
  'targetNotIdleUnknown',
  'targetBusy',
  'targetPaneUnreadable',
  'targetNotAgentPane',
  'targetNotPasteAware'
] as const

/**
 * Where the free/paid line falls, and it is NOT a style choice.
 *
 * Everything before `targetNotAgentPane` is decidable from a map lookup and a local `existsSync`.
 * Everything from it on costs a tmux round-trip — and on an SSH project, an `ssh` one over a
 * ControlMaster that may be dead, in which case `-o ControlMaster=auto` makes it a real LOGIN.
 *
 * The plan's draft order put the pane verdict ahead of the identity and idle refusals. That reads
 * well and costs badly: `targetBusy` is the most common refusal in an orchestration session and one
 * of only four retryable outcomes, so under the draft order every retry of a busy target paid for a
 * probe. A message sent to a working agent every few seconds would then be the 72k-logins/day shape
 * this codebase already survived once. Free-before-paid wins, and the reported reason for a target
 * that is both busy AND on a stranger's pane changes from `targetNotAgentPane` to `targetBusy` —
 * accepted deliberately: it is retryable, so the caller comes back and learns the rest.
 */
export const FIRST_PAID_DECISION = 'targetNotAgentPane'

export interface DeliveryFacts {
  /** The sender. Compared to `targetNodeId` for the self-send backstop; absent skips that check. */
  sourceNodeId?: string
  targetNodeId?: string
  /** Set by PR 5/PR 6 (the verbs and the per-project switch). Cheapest gate: pure caller state. */
  notPermitted?: NotPermittedReason
  /** Set by PR 4's per-pair limiter. `> 0` means refuse now and say when. */
  retryAfterMs?: number
  /** Is there a live session for this node at all? False ⇒ `targetGone`. */
  targetLive: boolean
  /**
   * Gate 1, from `isAgentPane` over `PtyManager.paneOwner` — kernel truth, three-valued.
   *
   * ── WHAT THIS VERDICT DOES NOT PROVE (carried from `pane-owner-predicate.ts` deliberately) ────
   *
   * `agent` proves the agent is IN the pane's foreground process group. It does NOT prove the agent
   * is the thing READING the tty. `sh -c "sleep 600 | claude"` answers `agent`, correctly — claude
   * really is in the group — but claude's stdin is the PIPE, so bytes written to the pane sit in
   * the tty buffer until the shell reads them after the pipeline exits. That is the
   * "rename splice = lost launch" shape: the write succeeds and the payload surfaces later,
   * somewhere else. The delivery RECEIPT (Task 3.4) is what makes that case observable rather than
   * silent — it is the only thing in this feature that can tell "B read it" from "the bytes are
   * sitting in a buffer" — and it is why a `stalled` outcome exists at all.
   *
   * Two false negatives are expected here and are NOT papered over: an agent script path containing
   * a SPACE (the argv split cannot tell it from two tokens) and a differently-named SYMLINK to the
   * agent binary (argv carries the name it was invoked as, not the target). Both answer `not-agent`
   * ⇒ `targetNotAgentPane`, a refusal, which is the safe direction. Do not "fix" either by matching
   * a substring of the command line: `vim /etc/claude.conf` would then be a claude pane.
   */
  pane: AgentPaneVerdict
  /** `#{pane_current_command}` (or 'unknown'), reported back so a refusal names what was seen. */
  paneObserved?: string
  /** The target's mirror entry — gate 2's entire input. `undefined` = this node has never posted. */
  target: MirrorEntry | undefined
  /** `nodeTokenFilePresent(targetNodeId)` — injected, so the decider stays pure. */
  tokenFilePresent: boolean
  /** Is the target on an SSH project? Only affects which ACTION a stale-script note names. */
  targetIsRemote?: boolean
  /**
   * Did the target's pane request bracketed paste? Deliberately OPTIONAL and deliberately last.
   *
   * `deliverAgentMessage` probes this only AFTER the gate passes, because the probe is a second
   * tmux round-trip and there is no point paying for it to tell a rate-limited caller something it
   * cannot act on. `undefined` therefore means "not asked yet", not "no".
   */
  pasteAware?: boolean
}

/** The one non-refusal. Kept out of `AgentMessageOutcome` so no caller can return it as a result. */
export interface Proceed {
  kind: 'proceed'
}

/**
 * Gate 2 — the target must be KNOWN idle on a VERIFIED status, and unknown is NOT idle.
 *
 * Modelled on `hibernation-policy.planHibernation` (`c.state === 'done'`, plus a never-seen node
 * being permanently ineligible), NOT on `restartEligibility`, whose `BUSY_STATES` is only
 * `{working, blocked}` — so `waiting` and `undefined` pass it. That is acceptable for a
 * user-initiated restart with a human watching the pane. It is not acceptable for an autonomous
 * write into somebody else's session.
 *
 * Refused, each with its own reason:
 *  - `undefined` (post-relaunch, or right after a `sessionPhase:'start'` reset — a CLI that has
 *    just launched is the most fragile moment a pane has),
 *  - `working` / `blocked` / `waiting` (busy, and retryable),
 *  - a RESTORED entry: 6-hour-old evidence off disk about a pane that has since done anything at
 *    all, including being replaced,
 *  - a `done` inferred from `idle_prompt` (`idleInferred`): a node blocked on an approval is also
 *    "idle at the prompt",
 *  - any `done` whose evidence was `stateVerified: false` — handled EARLIER, by the three identity
 *    refusals, because an unprovable identity is the more permanent fact.
 */
function idleRefusal(e: MirrorEntry | undefined): AgentMessageOutcome | null {
  if (!e) return { kind: 'targetNotIdleUnknown', reason: 'no status has ever been posted for this node' }
  if (e.restored)
    return {
      kind: 'targetNotIdleUnknown',
      reason: 'the last known status was restored from disk at startup, not observed this run'
    }
  if (e.state === undefined)
    return { kind: 'targetNotIdleUnknown', reason: 'the node is between sessions (no current state)' }
  if (e.state !== 'done') return { kind: 'targetBusy', state: e.state }
  if (e.idleInferred)
    return {
      kind: 'targetNotIdleUnknown',
      reason: 'the last `done` was inferred from the CLI going idle at its prompt, which a node ' +
        'waiting on an approval also does'
    }
  return null
}

/** The action a stale hook script needs, named per surface — because they genuinely differ. */
export function hookScriptStaleNote(targetIsRemote: boolean | undefined): string {
  return targetIsRemote
    ? 'the target runs a hook script that predates per-node identity; reconnect the SSH project ' +
        'from the desktop that owns it (RemoteHooks.setup() is the only writer of a remote script)'
    : 'the target runs a hook script that predates per-node identity; restart the nodeterm app on ' +
        'that host (the boot install rewrites the script unconditionally)'
}

/** The action an unmintable node needs — `IDENTITY_RESTART_NOTE`'s shape, never a bare code. */
export const NO_TOKEN_FILE_NOTE =
  'the target has no per-node identity on this host: relaunch the node from the desktop, or open ' +
  'its project so its token is materialised, then try again'

/**
 * The THREE unverified refusals — three populations, three ACTIONS. Collapsing them is worse than a
 * bare refusal, because two of the three would otherwise be told to retry something that can never
 * succeed.
 *
 * 1. STALE SCRIPT (`clientRevision` absent or `< MIN_TOKEN_AWARE_REVISION`). The session runs a
 *    hook script that predates per-node identity and cannot read the token dir at all — the token
 *    file may well be sitting right there. Checked FIRST because it is the OUTER CAUSE: fixing it
 *    is what makes the other two checks mean anything. The action differs by surface — a local
 *    host's script is rewritten unconditionally at every boot (`install-helper.ts`), a remote
 *    host's only inside `RemoteHooks.setup()` on CONNECT, so an already-connected project needs a
 *    reconnect. NOT retryable: no number of retries reinstalls a script.
 * 2. NO TOKEN FILE. The node cannot prove itself at all. NOT retryable — it needs a human.
 * 3. TOKEN FILE PRESENT, CURRENT SCRIPT, no verified event yet. It simply has not posted since the
 *    file appeared. Retryable — wait for its next turn.
 *
 * The trap #1 closes: before the script stamped itself (`X-Nodeterm-Hook-Client`), an old script
 * POSTing `version=2` with no token header was byte-identical on the wire to a current script whose
 * token file was merely missing. A token-file check alone would answer "retry after its next turn"
 * for the old-script case — forever, because the script cannot read the file. A permanently wrong
 * retry is worse than a refusal.
 *
 * Measured 2026-08-15: a PHONE-SPAWNED session lands in NONE of these on a host running nodeterm.
 * It sources the 0600 endpoint file it was handed, reads `$NODETERM_NODE_TOKEN_DIR/$NODETERM_NODE_ID`
 * and presents it, and verifies. rev. 3 of the design claimed the opposite; it was wrong, and the
 * reason it is wrong is the PERSIST-TIME token sweep (`refreshNodeTokens` on `onPersist`), NOT
 * `ptyManager.create` — which a phone-spawned session never touches.
 */
function identityRefusal(
  f: Pick<DeliveryFacts, 'target' | 'tokenFilePresent' | 'targetIsRemote'>
): AgentMessageOutcome | null {
  const e = f.target
  if (e?.stateVerified === true) return null
  // "Observed this run" is the precondition for reading a client revision at all: a restored entry
  // and a never-seen node carry no observation, so calling their script stale would be an
  // accusation we have no evidence for. They fall through to the token-file question, which is
  // answerable without an event.
  const observed = !!e && e.restored !== true
  if (observed && !(typeof e.clientRevision === 'number' && e.clientRevision >= MIN_TOKEN_AWARE_REVISION))
    return {
      kind: 'targetHookScriptStale',
      note: hookScriptStaleNote(f.targetIsRemote),
      ...(typeof e.clientRevision === 'number' ? { observedRevision: e.clientRevision } : {})
    }
  if (!f.tokenFilePresent) return { kind: 'targetStatusUnverified', note: NO_TOKEN_FILE_NOTE }
  return { kind: 'targetStatusStale' }
}

/**
 * The gates that cost NOTHING to evaluate — decided before any pane is touched.
 *
 * This split is the reason `DECISION_ORDER` is ordered the way it is, made real: everything
 * decidable from a map lookup and a local stat is decided BEFORE anything touches a pane. Without
 * the split the order would be a comment — the refusal text would be right and the round-trip would
 * be paid anyway, which is exactly the kind of gap a source-reading test cannot see.
 *
 * The set is exhaustive as of `FIRST_PAID_DECISION`: `notPermitted`, self-send, `rateLimited`,
 * `targetGone`, the three identity refusals and the two idle ones. If a future gate is free, it
 * belongs here; if it needs a probe, it belongs after. The test asserts the boundary by RUNNING a
 * delivery and counting `paneOwner` calls, not by reading this sentence.
 *
 * `null` means "nothing decidable yet"; the caller probes and then calls `decideDelivery`.
 */
export function decidePreProbe(
  f: Pick<
    DeliveryFacts,
    | 'sourceNodeId'
    | 'targetNodeId'
    | 'notPermitted'
    | 'retryAfterMs'
    | 'targetLive'
    | 'target'
    | 'tokenFilePresent'
    | 'targetIsRemote'
  >
): AgentMessageOutcome | null {
  if (f.notPermitted) return { kind: 'notPermitted', reason: f.notPermitted }
  // SELF-SEND, and it is a backstop rather than the only guard.
  //
  // Gate 2 covers it by accident today: a sender is mid-turn, so its own mirror entry says
  // `working` and the delivery refuses as `targetBusy`. "By accident" is the problem — PR 7's
  // deliver-on-idle queue exists precisely to deliver to a node that is NOT mid-turn, and a node
  // messaging itself from its own queue is a loop with a rate limiter for a brake. Two lines here,
  // and no later caller can forget it.
  if (f.sourceNodeId && f.targetNodeId && f.sourceNodeId === f.targetNodeId)
    return { kind: 'notPermitted', reason: 'self-send' }
  if (typeof f.retryAfterMs === 'number' && f.retryAfterMs > 0)
    return { kind: 'rateLimited', retryAfterMs: f.retryAfterMs }
  if (!f.targetLive) return { kind: 'targetGone' }
  // Identity and idleness are BOTH free — a map lookup and a local stat — so they belong here,
  // ahead of anything that touches a pane. See FIRST_PAID_DECISION.
  const identity = identityRefusal(f)
  if (identity) return identity
  return idleRefusal(f.target)
}

/**
 * Decide whether a delivery may proceed. Pure.
 *
 * The sequence below IS `DECISION_ORDER`, and the ordering test walks it by clearing one fact at a
 * time — asserted by RUNNING this function, never by reading its source.
 */
export function decideDelivery(f: DeliveryFacts): AgentMessageOutcome | Proceed {
  const cheap = decidePreProbe(f)
  if (cheap) return cheap
  // Gate 1, in two honest halves — and BOTH refuse, because the one thing neither may do is admit
  // a pane we could not read. This gate must stay FAIL-CLOSED: `sendEnvelope` types bytes plus an
  // Enter into whatever owns the pane, and an unverified pane can be a bare shell — delivering
  // there EXECUTES the message body ("text into a pane is injection"; the herdr-shaped incidents
  // this module's history records). A probe outage may therefore delay a delivery, never widen it.
  //
  // `unknown` is NOT a shade of `not-agent`, and since issue #460 it is not REPORTED as one
  // either: the field failure was a live, idle claude pane refused as "not running its agent
  // (observed: unknown)" for as long as the host link stayed saturated — a probe that could not
  // answer in its 2s budget (each ssh exec silently becomes a full LOGIN when the master cannot
  // serve a channel; measured in `remotePaneOwnerCombinedArgs`). Telling a language model the
  // pane is "not an agent" when the truth is "we could not look" teaches it a wrong, sticky fact.
  // `targetPaneUnreadable` says the true thing, and it IS retryable — the per-pair rate limiter
  // sits in front of every delivery, so a retry is bounded, and the probe itself is now ONE
  // round-trip, so a retry in the degraded state costs one fallback login, not two. That bound is
  // what the old DO-NOT-RETRY note (a 2s loop stacking ~7 ssh children per pane — the 72k-logins
  // shape, memory: ssh-controlmaster-fallback) was protecting; the limiter + the halved probe are
  // what make honesty affordable now.
  if (f.pane === 'unknown') return { kind: 'targetPaneUnreadable' }
  if (f.pane !== 'agent')
    return { kind: 'targetNotAgentPane', observed: f.paneObserved ?? 'not-agent' }
  // Last, and only when everything else passed: the pane must have ASKED for bracketed paste.
  // herdr :260 — a multi-line envelope on the unframed fallback would be submitted line-by-line as
  // separate turns. It is refused, never sent and hoped for.
  if (f.pasteAware === false) return { kind: 'targetNotPasteAware' }
  return { kind: 'proceed' }
}
