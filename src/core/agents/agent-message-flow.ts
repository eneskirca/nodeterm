import type { AgentMessageOutcome } from './agent-message-decide'

/**
 * FLOW CONTROL — the first throttle the control surface has ever had.
 *
 * What exists today is timeouts (`SLOWLORIS_MS` → `CONTROL_CEILING_MS`, the 120 s control-forward
 * bound) and a one-at-a-time confirmation serializer (`confirmBusy()`). A timeout is not a throttle
 * and a modal is not a budget — and messaging skips the modal entirely once the per-project switch
 * is on, so even the accidental brake is gone. These two limits are the replacement.
 *
 * Both are PRE-PROBE by construction: they answer from a `Map` lookup, so a refusal costs no tmux
 * round-trip and — on an SSH project whose ControlMaster has died — no real login. That is not a
 * micro-optimisation; `-o ControlMaster=auto` turned exactly this shape into 72k logins/day once
 * already (memory: ssh-controlmaster-fallback). Both refusals are the EXISTING `rateLimited` member
 * of `AgentMessageOutcome`, never a new ad-hoc shape, so `RETRYABLE` already answers for them.
 *
 * ── THREE SURFACES ──────────────────────────────────────────────────────────────────────────────
 *
 * - **Desktop (Electron):** the only surface with the messaging verbs, so the only surface that
 *   consumes budget. The state below is main-process memory, next to `deliverAgentMessage`.
 * - **Server Edition:** this module ships (everything in `src/core` ships on both shells) and has
 *   no consumer — messaging does not exist there, and Task 5.3 makes that a named, terminal
 *   refusal rather than a throttle-shaped one. Nothing here needs a second wiring.
 * - **Mobile (phone):** never a sender — it drives the canvas over relay→IPC, not `/control/*` —
 *   so a phone action never calls `noteSent` and never consumes anyone's budget. It IS a valid
 *   target (Correction C1), and as a target it is covered like any other: the pair budget belongs
 *   to the PAIR, so a phone-spawned node being messaged by two different orchestrators gets two
 *   independent windows, which is the correct answer for two independent conversations.
 *
 * ── WHERE THE STATE LIVES, AND WHICH WAY IT FAILS ───────────────────────────────────────────────
 *
 * Process memory, module scope, for the lifetime of the shell that owns the delivery. Nothing is
 * persisted, and that is a decision rather than an omission:
 *
 * - **A LOST limiter is a brief over-send.** After a restart every pair starts clean, so a pair
 *   that had just been written to could receive one extra message inside its 10 s window, and every
 *   sender starts its next turn with a full fan-out budget. Bounded, self-healing, invisible.
 * - **A STUCK limiter is a permanently silent agent** — an entry that outlives its meaning and
 *   refuses every future delivery with a number nobody can wait out. That is the failure mode this
 *   module refuses to have, so every path that could produce it fails OPEN: entries are evicted on
 *   read (`sweep`), a clock that jumps BACKWARDS drops the entry instead of parking it in the
 *   future, a NON-FINITE clock reading drops everything (every comparison is false for `NaN`, which
 *   would otherwise make an entry immortal — and would silence the fan-out budget while the pair
 *   budget failed open, the worst of both), and a fan-out budget whose reset signal never arrives
 *   expires on its own after `TURN_STALE_MS`.
 *
 * Nothing here reads the clock, the filesystem or a socket; `now` is injected exactly as it is in
 * `decideDelivery`, so the whole thing is testable without fake timers.
 */

/** #98's 10 s, kept: the same number, now enforced. */
export const PAIR_MIN_INTERVAL_MS = 10_000

/** How many DIFFERENT deliveries one sender may make inside a single turn. */
export const FANOUT_PER_TURN = 4

/**
 * The fan-out backstop, and the reason it exists is the failure direction above.
 *
 * The cap's real reset is the sender's own `newTurn`. If that signal never arrives — a shell that
 * forgot to wire `noteNewTurn`, a normalizer that stopped flagging turn starts — the counter would
 * stand forever and the sender would be silent for the rest of the run, which is precisely the
 * stuck-limiter failure. So a budget that has seen no send for this long is treated as belonging to
 * a turn that is over.
 *
 * It does not make the cap leaky: a burst is by definition sends seconds apart, and this window
 * never elapses inside one. The worst case it admits is four extra messages per five idle minutes
 * per sender — and each of those still has to clear the per-pair window.
 */
export const TURN_STALE_MS = 5 * 60_000

/**
 * What a fan-out refusal reports as `retryAfterMs`, and it is a FLOOR, not a promise.
 *
 * The budget resets on a turn boundary, which is not a clock event, so no number here is exactly
 * right. The two obviously-wrong choices are worse than a floor: `0` would be read as "no limit at
 * all" by `decidePreProbe`, whose refusal is `retryAfterMs > 0` — the cap would silently stop
 * existing — and something enormous would tell a caller to abandon a budget that clears the moment
 * its turn ends. The per-pair interval is the honest lower bound: nothing this sender does can land
 * sooner than that anyway.
 *
 * KNOWN COST, stated so it is not a surprise: in the degenerate case where `noteNewTurn` never
 * arrives, a caller that obeys this floor exactly spends `TURN_STALE_MS / FANOUT_RETRY_AFTER_MS`
 * = 30 refused attempts before the staleness backstop opens the budget. Those 30 are cheap for the
 * host (pre-probe, no pane, no ssh) and expensive for the caller (30 tool calls). The alternative —
 * reporting the true wait — is not available: the number does not exist while the reset is a turn
 * boundary rather than a clock event.
 */
export const FANOUT_RETRY_AFTER_MS = PAIR_MIN_INTERVAL_MS

/** The `rateLimited` member of the delivery outcome union — reused, never re-declared. */
export type RateLimited = Extract<AgentMessageOutcome, { kind: 'rateLimited' }>

export type FlowVerdict = { ok: true } | RateLimited

/** Which of the two budgets refused, for the trace. Deliberately NOT on the outcome: the sender is
 *  told `rateLimited` and a number, because that is all it can act on. */
export type FlowLimit = 'pair' | 'fan-out'

export type FlowCheck = { ok: true } | { ok: false; limit: FlowLimit; outcome: RateLimited }

/**
 * The map key, and the separator is written as the ESCAPE `\u0000` — never as a raw byte.
 *
 * A raw NUL in a source file makes git, grep and ripgrep skip the ENTIRE file in silence. This
 * repo has been bitten twice (commit 4c0e8c3); the plan this task comes from was written with a raw
 * one and was itself invisible to grep until it was caught.
 *
 * -- THE KEY IS INJECTIVE ONLY OVER IDS THAT PASS `isSafeNodeId`, AND THAT IS A PRECONDITION ------
 *
 * An id that CONTAINS the separator collides two different conversations: with S for the separator,
 * `pairKey('x'+S+'y', 'z')` and `pairKey('x', 'y'+S+'z')` are the same string, and the second
 * conversation is then throttled by the first. `isSafeNodeId` (`[A-Za-z0-9._-]`, so no NUL, no
 * space, no slash) is what makes the premise true, and `resolveDeliveryScope` enforces it at the
 * AUTHORIZATION BOUNDARY rather than here: a limiter is the wrong place to decide whether an id is
 * addressable at all, and enforcing it in two places would leave one of them untested in practice.
 *
 * A DIRECT caller of this module that has not gone through `resolveDeliveryScope` — PR 5's verbs,
 * PR 7's queue — must validate first. Nothing in the type system says so, which is why the test
 * asserts the collision EXISTS and asserts the validator refuses exactly the ids that cause it: a
 * precondition pinned by execution instead of by this paragraph.
 */
export function pairKey(src: string, dst: string): string {
  return `${src}\u0000${dst}`
}

/**
 * WHY THE KEY IS THE PAIR, and what each of the two obvious alternatives breaks.
 *
 * - Keyed by SENDER alone, one budget covers everything an orchestrator does: a fan-out to four
 *   workers is four sends inside a second, so three of them are refused and the orchestrator is
 *   starved by its own correct behaviour. (A per-sender budget is the right shape for a *turn*
 *   cap — which is what `checkFanOut` is, with a much larger allowance.)
 * - Keyed by TARGET alone, one busy node throttles every conversation it is part of, and a sender
 *   is refused for something another sender did. Worse, it is trivially abusable: a flooder holds
 *   one target's window shut and nobody else can reach it.
 * - Keyed by the PAIR, the budget belongs to the conversation. A→B being throttled says nothing
 *   about A→C, and — asserted explicitly, because it is the one people get wrong — nothing about
 *   B→A. A reply must never be throttled by the message it answers.
 */
const pairLastSentAt = new Map<string, number>()

/**
 * WHAT IDENTIFIES A TURN: the existence of this entry, delimited by the sender's own `newTurn`.
 *
 * There is no turn id to key on, and the three candidates that look like one are each wrong in a
 * way that matters:
 *
 * - **A state transition (`working` → `done`)** would reset the cap several times inside one turn:
 *   a tool-event burst flips the mirror repeatedly, which is exactly why the renderer's own
 *   per-turn fan-out is keyed on `newTurn` and not on state (`normalize.ts` — *"true only for a
 *   genuine new turn … so the renderer can clear per-turn fan-out without clearing on every
 *   mid-turn tool event"*). A cap that resets mid-turn is not a cap.
 * - **The session id** spans an entire session — hours, hundreds of turns. A cap keyed on it never
 *   resets in practice: four messages per session is a permanent block wearing a budget's clothes.
 * - **Wall-clock windows** refill in the middle of a long turn and refuse at the start of a short
 *   one, which is the same objection as the first, plus arbitrariness.
 *
 * So the entry IS the turn: it is created by the turn's first send, incremented by each subsequent
 * one, and destroyed by `noteNewTurn(src)` — the same edge `normalize.ts` already flags for exactly
 * this purpose. `TURN_STALE_MS` is its only other exit, and that exit exists to fail open.
 */
interface TurnBudget {
  /** Sends recorded in the current turn. */
  sent: number
  /** When the last of them was recorded — the staleness backstop's input, nothing else. */
  lastSentAt: number
}
const senderTurns = new Map<string, TurnBudget>()

/**
 * EVICTION, not a read cap.
 *
 * Both maps are swept here and the checks below read whatever survives — so an entry that is still
 * present is, by construction, still in force. There is deliberately no "is it expired?" branch in
 * the readers: a limiter that decides expiry at read time while the map keeps growing looks correct
 * from every test that reads through the same bound, and leaks. `flowStats()` exists so a test can
 * assert the eviction directly instead of inferring it from a verdict.
 *
 * The `at > now` arm is the clock-jump guard. An NTP step backwards would otherwise leave an entry
 * dated in the future, and `PAIR_MIN_INTERVAL_MS - (now - at)` would then refuse for as long as the
 * step was large — an agent silenced for an hour by a time correction, with no way to wait it out.
 * Dropping it over-sends by at most one message per pair. That is the direction this module always
 * takes.
 *
 * A NON-FINITE `now` gets the same treatment, and it is not a hypothetical tidy-up: EVERY comparison
 * below is false for `NaN`, so without this line an entry becomes immortal — and the two budgets
 * then fail in OPPOSITE directions, which is the worst of both. The pair limiter fails open by
 * accident (its `retryAfterMs` is `NaN`, and `decidePreProbe` refuses on `retryAfterMs > 0`, which
 * `NaN` is not), while a fan-out budget already at the cap returns a real `FANOUT_RETRY_AFTER_MS`
 * forever — a permanently silent sender that only a `newTurn` can rescue, which is exactly the
 * failure this module claims not to have. Unreachable while `now` is `Date.now()`; the guard costs
 * one comparison and makes the claim true instead of true-by-luck.
 *
 * NaN is the only value this line is load-bearing for, and the test says so: `+Infinity` is already
 * dropped by the staleness arm and `-Infinity` by the future arm below. It is written as
 * `!Number.isFinite` rather than `Number.isNaN` because that is the intent — a clock reading that
 * is not a position on the number line — and because a mutation swapping the two is EQUIVALENT
 * rather than a defect the sweep would let through.
 */
function sweep(now: number): void {
  if (!Number.isFinite(now)) {
    pairLastSentAt.clear()
    senderTurns.clear()
    return
  }
  for (const [key, at] of pairLastSentAt)
    if (at > now || now - at >= PAIR_MIN_INTERVAL_MS) pairLastSentAt.delete(key)
  for (const [id, b] of senderTurns)
    if (b.lastSentAt > now || now - b.lastSentAt >= TURN_STALE_MS) senderTurns.delete(id)
}

/**
 * May `src` write into `dst` right now? Pure read — a check NEVER starts a window.
 *
 * That matters: if merely asking extended the window, a delivery refused for any other reason (a
 * busy target, an unverified identity — the two most common refusals in an orchestration session)
 * would consume the budget it never used, and a caller told to retry would be rate-limited for
 * doing what it was told. Only `noteSent` records, and only a delivery that actually reached the
 * pane calls it.
 */
export function checkPairRate(src: string, dst: string, now: number): FlowVerdict {
  sweep(now)
  const last = pairLastSentAt.get(pairKey(src, dst))
  if (last === undefined) return { ok: true }
  return { kind: 'rateLimited', retryAfterMs: PAIR_MIN_INTERVAL_MS - (now - last) }
}

/** Has `src` used up this turn's fan-out budget? Pure read, same contract as `checkPairRate`. */
export function checkFanOut(src: string, now: number): FlowVerdict {
  sweep(now)
  const budget = senderTurns.get(src)
  if (!budget || budget.sent < FANOUT_PER_TURN) return { ok: true }
  return { kind: 'rateLimited', retryAfterMs: FANOUT_RETRY_AFTER_MS }
}

/**
 * Both budgets in one call, because two of them is one too many to remember.
 *
 * A caller that consults the pair limit and forgets the fan-out cap has shipped half a feature that
 * looks whole, and nothing would fail.
 *
 * When BOTH refuse, the fan-out cap is the one reported, because its wait is never the shorter of
 * the two: a pair remainder is at most `PAIR_MIN_INTERVAL_MS`, which is what the fan-out floor is.
 * Reporting the smaller of two live limits would invite a retry already known to fail. The test
 * pins that relationship between the constants, so weakening either one fails there rather than
 * quietly turning this precedence into the wrong answer.
 */
export function checkFlowLimits(src: string, dst: string, now: number): FlowCheck {
  const pair = checkPairRate(src, dst, now)
  const fanOut = checkFanOut(src, now)
  if (!('ok' in fanOut)) return { ok: false, limit: 'fan-out', outcome: fanOut }
  if (!('ok' in pair)) return { ok: false, limit: 'pair', outcome: pair }
  return { ok: true }
}

/**
 * IN-FLIGHT RESERVATIONS — what makes check + record atomic across a sender's CONCURRENT sends.
 *
 * `checkFlowLimits` is a pure read and `noteSent` records only after the pane write, so between
 * the two sits the whole delivery (probes, the framed write — and on SSH a real round-trip). N
 * parallel sends to N DISTINCT targets therefore all passed the fan-out cap before any of them
 * recorded: the plan's blast-radius limit held only for a sender polite enough to send
 * sequentially, and a language model firing tool calls in parallel is not that sender. The pair
 * limiter had the narrower version of the same hole (two same-pair sends serialized at the target
 * lock, but the second delivered with the verdict it read before waiting).
 *
 * `reserveFlow` closes both: the check and a provisional hold happen with NO await between them —
 * which, single-threaded, IS the critical section — and the hold is released when the delivery
 * ends. A hold counts against the fan-out budget exactly like a recorded send, and holds a pair
 * shut exactly like a fresh `noteSent`; a delivery that never reaches the pane releases its hold
 * and costs nothing, preserving `noteSent`'s contract. The maps cannot leak holds: every release
 * runs in the caller's `finally`, and a process that dies loses the maps with the process.
 */
const pendingPairs = new Set<string>()
const pendingBySender = new Map<string, number>()

export interface FlowReservation {
  ok: true
  /** Give the slot back. Idempotent — a double release must not free a sibling's hold. */
  release(): void
}

/**
 * Check BOTH budgets and take a provisional hold in one synchronous step.
 *
 * A refused reservation reports the same `rateLimited` shape `checkFlowLimits` does. A pair held
 * by an in-flight delivery reports the full `PAIR_MIN_INTERVAL_MS` — a floor, same reasoning as
 * `FANOUT_RETRY_AFTER_MS`: if the in-flight send lands, that is the real wait; if it fails, the
 * caller retries early and merely gets refused zero times instead of once.
 */
export type FlowReserve = { ok: false; limit: FlowLimit; outcome: RateLimited } | FlowReservation

/**
 * `fanOutKey` names whose PER-TURN budget this delivery spends; it defaults to the sender, which is
 * every agent. A board comment passes its own key (`board:<project>:<comment>`), because a person's
 * turn is one comment: its pair window stays the board's (`src`), but one comment's in-flight holds
 * and later sends must not spend the next comment's budget.
 */
export function reserveFlow(src: string, dst: string, now: number, fanOutKey: string = src): FlowReserve {
  sweep(now)
  const sent = senderTurns.get(fanOutKey)?.sent ?? 0
  const pending = pendingBySender.get(fanOutKey) ?? 0
  if (sent + pending >= FANOUT_PER_TURN) {
    return {
      ok: false,
      limit: 'fan-out',
      outcome: { kind: 'rateLimited', retryAfterMs: FANOUT_RETRY_AFTER_MS }
    }
  }
  const key = pairKey(src, dst)
  const last = pairLastSentAt.get(key)
  if (last !== undefined) {
    return {
      ok: false,
      limit: 'pair',
      outcome: { kind: 'rateLimited', retryAfterMs: PAIR_MIN_INTERVAL_MS - (now - last) }
    }
  }
  if (pendingPairs.has(key)) {
    return {
      ok: false,
      limit: 'pair',
      outcome: { kind: 'rateLimited', retryAfterMs: PAIR_MIN_INTERVAL_MS }
    }
  }
  pendingPairs.add(key)
  pendingBySender.set(fanOutKey, pending + 1)
  let released = false
  return {
    ok: true,
    release(): void {
      if (released) return
      released = true
      pendingPairs.delete(key)
      const n = (pendingBySender.get(fanOutKey) ?? 1) - 1
      if (n <= 0) pendingBySender.delete(fanOutKey)
      else pendingBySender.set(fanOutKey, n)
    }
  }
}

/**
 * Record a delivery that ACTUALLY reached the pane — the single write path for both budgets.
 *
 * Called after the write, not before the gate. A refusal puts nothing in anybody's pane, so it
 * costs nobody's budget; the cost of that choice is that refusals are unthrottled, which is
 * acceptable precisely because they are pre-probe and free. The cost of the alternative is not: a
 * sender whose four attempts were all refused as `targetBusy` — a RETRYABLE outcome it was told to
 * come back from — would find itself silent for the rest of its turn, blocked by the retries the
 * feature asked it to make.
 */
export function noteSent(src: string, dst: string, now: number, fanOutKey: string = src): void {
  sweep(now)
  pairLastSentAt.set(pairKey(src, dst), now)
  const budget = senderTurns.get(fanOutKey)
  if (budget) {
    budget.sent += 1
    budget.lastSentAt = now
  } else {
    senderTurns.set(fanOutKey, { sent: 1, lastSentAt: now })
  }
}

/**
 * The sender started a new turn — its fan-out budget is gone with the old one.
 *
 * Wired (in Task 5.1) to the same `newTurn` edge the renderer's own per-turn fan-out uses. Deleting
 * rather than zeroing keeps the map bounded by "senders with an in-flight turn" instead of "senders
 * seen this run", and makes an absent entry mean exactly one thing.
 *
 * Only the SOURCE's own turn resets it. A `newTurn` on the target is another node's business — if
 * it reset the sender's budget, every message would refill the budget that sent it, because a
 * delivery is what starts the target's turn.
 */
export function noteNewTurn(nodeId: string): void {
  senderTurns.delete(nodeId)
}

/** Live entry counts, so a test can assert EVICTION rather than infer it from a verdict. */
export function flowStats(): { pairs: number; senders: number } {
  return { pairs: pairLastSentAt.size, senders: senderTurns.size }
}

/** Drop every budget. Test isolation, and the honest teardown for a shell that is shutting down —
 *  forgetting is always the safe direction here (see the failure directions above). */
export function resetMessageFlow(): void {
  pairLastSentAt.clear()
  senderTurns.clear()
  pendingPairs.clear()
  pendingBySender.clear()
}
