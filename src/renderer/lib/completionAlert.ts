/**
 * Should a parent agent's turn-end alert be QUIET — no chime, no OS notification?
 *
 * Issue #708. Claude launches background subagents async: each one that finishes is announced back
 * to the PARENT as a queued `<task-notification>` prompt, and the parent's handling of that
 * notification is a full turn — `UserPromptSubmit` → … → `Stop`. `Stop` normalizes to
 * `state: 'done'`, and `done` is what fires the completion alert. So a fan-out of ten background
 * agents produces ten `done` events on ONE node, each of them a chime. The reporter's words: "a
 * chime every few seconds :)))".
 *
 * None of those ten is a lie about the turn — the turn really did end. What they are wrong about is
 * the thing the chime MEANS, which is "this node is finished and wants you". A parent still holding
 * subagents in `working` has not finished; it is going to be woken again by the next one.
 *
 * ## What is suppressed, and what is deliberately not
 *
 * The chime and the OS notification only. **`unread` is NOT suppressed** — read the "Unread +
 * notification" bullet in CLAUDE.md: unread is a durable per-node flag, cleared by looking at the
 * node, and it is idempotent, so ten report-backs raise ONE dot rather than ten. It costs the user
 * no interruption and it is the thing that still tells them "something happened here" if the final
 * chime is ever lost. The chime and the banner are interrupts; the dot is a record. Suppressing the
 * record to fix the interrupt would trade a noisy bug for a silent one.
 *
 * ## Why this fires exactly once at the end, with no deferred-alert bookkeeping
 *
 * The LAST subagent's completion writes its `<task-notification>` into the parent transcript, the
 * context tail sniffs it within one poll (`POLL_MS` = 1 s in `core/context-tail.ts`) and emits the
 * synthetic `subagent-end` that marks the card `done`. Only THEN does the parent wake and run the
 * turn whose `Stop` arrives seconds later. By that point no card is `working`, so the alert fires
 * normally. The "one chime when the whole fan-out is done" is therefore the ordinary alert, not a
 * replayed one — there is no debt to remember and no second alert path that could double-chime.
 *
 * ## The direction of the guess is the OPPOSITE of Eco's
 *
 * `buildHibernationCandidates`' `liveSubagents` asks a related question and answers it
 * conservatively the other way: anything that is not provably `done` counts as LIVE, because being
 * wrong there means `/exit`ing a CLI with live background work in it (issue #402). Here being wrong
 * means SWALLOWING a genuine completion, so the conservative direction is to stay loud: only a card
 * this store positively holds in `working` may silence a chime. That is why this is its own
 * predicate rather than a call into the hibernation adapter — same store, opposite failure cost.
 *
 * The store types `state` as `'working' | 'done'`, so on today's data the two spellings agree; the
 * match is written as `=== 'working'` anyway so a future third state (or a card rehydrated from
 * somewhere with a missing field) falls to the loud side by construction.
 *
 * ## The bounded worst case
 *
 * A subagent whose end never arrives (crashed CLI, killed pane, slept machine) pins its card in
 * `working`, and this would then silence that node's completion chimes. It is bounded by the same
 * decay everything else in this store leans on: Canvas's 60 s sweep runs `sweepStaleWorking`, which
 * marks a card `done` after `WORKING_STALE_MS` (20 min). Past that the node chimes again on its
 * next turn end. The alternative — remembering a suppressed alert and replaying it when the last
 * card lands — was considered and rejected: the replay races the parent's own woken turn, so the
 * normal path would chime twice whenever that turn takes longer than the node's 5 s sound cooldown,
 * which is most of the time.
 */

/** One subagent card, narrowed to what this decision reads. */
export interface FanoutCard {
  parentNodeId: string
  state?: string
}

/**
 * Does this parent still hold at least one subagent card in `working`?
 *
 * Pure; `cards` is `Object.values(useAgentNodes.getState().byId)`.
 */
export function fanoutStillWorking(
  cards: Iterable<FanoutCard>,
  parentNodeId: string
): boolean {
  for (const c of cards) {
    if (c.parentNodeId === parentNodeId && c.state === 'working') return true
  }
  return false
}
