/**
 * What a per-node token BUYS, per route: the policy that turns the three-way verdict from
 * `verifyNodeToken` into allow / allow-with-warning / refuse.
 *
 * The whole identity series up to here is measurement — it can say `verified`, `legacy`, `forged`
 * and it labels events with the answer, but nothing has ever DEPENDED on it. This file is where it
 * starts to. That is the dangerous half, because the population it governs is already running:
 * tmux sessions outlive the app, so on the day this ships there are live agent sessions holding a
 * launcher, a skill shim and an environment from before the token existed. Enforce on day one and
 * their next `manage-nodeterm-canvas` call stops working with no way for them to know why.
 *
 * So enforcement arrives in two moves, and both are here rather than scattered through the routes:
 *
 *  1. TRUST ON FIRST PROOF. A node that has never presented a token this instance minted keeps the
 *     legacy path. A node that HAS is latched: an unverified request naming it afterwards is
 *     refused, because that session demonstrably CAN authenticate and one that suddenly cannot is
 *     either a different process wearing its node id or a forgery this instance cannot name. The
 *     latch costs the legacy population nothing — they never prove anything, so they never latch.
 *
 *  2. A DATED WINDOW. Until `NODE_IDENTITY_STRICT_AFTER` an unverified MUTATION still executes and
 *     the reply carries `IDENTITY_RESTART_NOTE`, which names the fix and the date. After it, the
 *     same situation is a refusal. The date is in the source, not in a comment saying "later":
 *     a tightening with no date is a tightening that never happens.
 */
import { NODE_IDENTITY_STRICT_DATE } from '@shared/node-identity'
import type { NodeTokenVerdict } from './node-auth-token'

/**
 * When an unverified mutation stops executing and starts being refused.
 *
 * Built from the ONE date string in `@shared/node-identity` — the Settings row prints that same
 * string, and the renderer cannot import this file. See there for where the date comes from.
 */
export const NODE_IDENTITY_STRICT_AFTER = new Date(`${NODE_IDENTITY_STRICT_DATE}T00:00:00Z`)

const STRICT_DATE = NODE_IDENTITY_STRICT_DATE

/**
 * How far past the cutoff the LOCAL CLOCK may read before the cutoff stops being believed at all.
 *
 * The cutoff is compared against `Date.now()`, and a machine clock is not evidence. A VM restored
 * from a snapshot, a board whose RTC came up wrong, or a clock somebody set forward on purpose can
 * put a perfectly ordinary install years into the future — and it then enters strict mode on day
 * one, with no warning window, refusing every unverified mutation with a sentence naming a date
 * that has "already passed". The symptom reads as "the token is broken", so nobody looks at the
 * clock, and the escape hatch is the last place they think to go.
 *
 * There is no way to tell that case apart from an install genuinely still running years after the
 * cutoff: an old binary can run forever, so `now` far ahead of anything in this source proves
 * nothing on its own. Since the two are indistinguishable, the tie is broken by which mistake is
 * worse — and the whole series fails OPEN by design, so the answer is to keep the window open.
 *
 * That costs almost nothing, and it is worth being exact about WHY, because the obvious reason is
 * false. **Neither the cutoff nor the latch is a boundary against an attacker.** The latch protects
 * against a MISTAKE — a session that silently stopped presenting its token. It cannot protect
 * against an adversary, because an adversary picks the `kid`: a made-up `kid` is a FOREIGN kid,
 * which invariant 3 requires to be `legacy` and never latched (or cross-instance failover dies), so
 * an invented token walks past the latch AND the cutoff into `/control/list` and every
 * `/context-link/*` read. Measured against the real server and pinned in
 * `hook-identity-enforcement.test.ts` ("an invented kid is admitted"); see docs/node-identity.md.
 *
 * So the clamp is cheap for a smaller and more honest reason: what it relaxes is only the
 * population that has NEVER proven anything, i.e. exactly the pre-token sessions the warning window
 * exists for, and fail-open is that population's designed state. It relaxes the DATE and nothing
 * else — `forged` and the latch are untouched by it.
 *
 * Two years, because that is comfortably longer than the upgrade population survives (tmux sessions
 * and un-updated installs do not last it out) and comfortably shorter than the clock skews that
 * actually occur, which are measured in decades (an RTC default year, an epoch reset, a licence
 * clock set forward).
 *
 * The same reasoning as `license.ts`'s rollback anchor, pointed the other way: there, the clock
 * direction the USER benefits from (setting it back to revive an expired token) is the one that is
 * refused, via `Math.max(Date.now(), lastSeen)`. Here the direction a user benefits from is setting
 * the clock BACK to dodge the cutoff — and that buys them nothing worth defending, because
 * `hookIdentityStrict: false` grants exactly the same thing with one click. So there is no security
 * to trade away by disbelieving a clock that reads absurdly far forward; there is only a silent
 * day-one lockout to remove.
 */
export const NODE_IDENTITY_CLOCK_HORIZON_MS = 2 * 365 * 24 * 60 * 60 * 1000

/**
 * Is `now` an instant at which the dated cutoff should be enforced?
 *
 * Clamped at BOTH ends: before the cutoff the window is open (the point of the window), and beyond
 * `NODE_IDENTITY_CLOCK_HORIZON_MS` past it the clock is not believed and the window is open again.
 * Exported so the clamp is testable as a rule rather than only through `controlPolicy`'s table.
 */
export function isStrictInstant(now: Date): boolean {
  const t = now.getTime()
  const cutoff = NODE_IDENTITY_STRICT_AFTER.getTime()
  // NaN (an invalid Date from a broken injected clock) fails both comparisons ⇒ not strict, which
  // is the fail-open direction this whole file takes.
  return t >= cutoff && t < cutoff + NODE_IDENTITY_CLOCK_HORIZON_MS
}

/**
 * Prefixed onto the reply of an unverified mutation that STILL RAN.
 *
 * It says what could not be established, that the command ran anyway, the exact action that fixes
 * it, and the date after which it stops being a note and starts being a refusal. One line, because
 * it is a prefix and a multi-line prefix buries the reply the agent actually asked for.
 */
export const IDENTITY_RESTART_NOTE =
  'NodeTerm could not confirm which node sent this command: this session is not presenting its ' +
  'node identity, so it ran unverified. Restart this node (right-click it, "Restart agent") to ' +
  `pick one up — from ${STRICT_DATE} commands from a session without one are refused.`

/**
 * The same situation once it is refused — after the cutoff, or once the node has proven itself and
 * an unverified caller turns up anyway.
 *
 * Deliberately carries NO date: it fires on both sides of the cutoff (the latch does not wait for
 * it), and a sentence that says "since <date>" would be false for half of the cases it answers.
 */
export const IDENTITY_REFUSED_NOTE =
  'NodeTerm could not confirm which node sent this command, so it did not run: this session is ' +
  'not presenting its node identity. Restart this node (right-click it, "Restart agent") to pick ' +
  'one up.'

/**
 * The refusal for a node that can NEVER have an identity, however many times it is restarted.
 *
 * Two populations land here, and both are permanent until a FILE is edited:
 *
 *  - a node whose id case-folds onto another id on the same canvas. The materialiser refuses tokens
 *    for the whole colliding set on purpose (`node-token-service.ts`) — on APFS they would be one
 *    file, and that is the hijack.
 *  - a node whose id is outside `[A-Za-z0-9._-]`, or `.`/`..`/empty/over-length. `fileToProject`
 *    does not validate ids read out of `project.json`, so such an id reaches the canvas intact and
 *    `nodeAuthToken` returns '' for it forever.
 *
 * Giving those `IDENTITY_REFUSED_NOTE` is the worst kind of wrong answer: it names an action
 * ("Restart this node… to pick one up") that is guaranteed not to work, so the user restarts in a
 * loop while the only real signal — a `console.warn` in the main-process log — sits somewhere they
 * will never look. This sentence names the cause instead, refuses to advise a restart, and points
 * at both real ways out: fix the id, or use the escape hatch, which does release this.
 *
 * It is one of a PAIR: this is the refusal, `IDENTITY_UNMINTABLE_WARN_NOTE` is the same cause said
 * during the warning window, where the command ran. The two differ in one clause and share the
 * rest, because the cause and the way out do not depend on which side of the cutoff you are on.
 */
const UNMINTABLE_CAUSE =
  'this node can never present an identity, so restarting it will not help: its node id is ' +
  "invalid, or it collides with another node id in this project's project.json when letter case " +
  'is ignored. Fix the duplicate or invalid id there, or turn off Settings → Agents → "Require ' +
  'verified node identity for canvas control".'

export const IDENTITY_UNMINTABLE_NOTE =
  'NodeTerm could not confirm which node sent this command, so it did not run — and ' +
  UNMINTABLE_CAUSE

/**
 * The same cause during the WARNING WINDOW, where the command still ran.
 *
 * This sentence is the whole reason the unmintable case needed a second one. `IDENTITY_UNMINTABLE_
 * NOTE` is a refusal and says "so it did not run"; the window is `allow-with-warning`, so pasting
 * the refusal on top of a reply that plainly DID run swaps one false sentence for another. And
 * `IDENTITY_RESTART_NOTE` — what these nodes got until now — is the exact loop the unmintable
 * wording exists to break, delivered for the entire window the note was written to serve: the user
 * restarts, the node still cannot mint, the note comes back unchanged.
 *
 * It keeps `IDENTITY_RESTART_NOTE`'s closing clause verbatim, because the deadline is the same one
 * and it is the part that makes the advice urgent: on the cutoff this stops being a note.
 */
export const IDENTITY_UNMINTABLE_WARN_NOTE =
  'NodeTerm could not confirm which node sent this command, so it ran unverified — and ' +
  UNMINTABLE_CAUSE +
  ` From ${STRICT_DATE} commands from a session without an identity are refused.`

/**
 * Control verbs that an unproven, unverified caller may still run after the cutoff.
 *
 * `list` is the whole bucket: it leaks the shape of the canvas — node ids, titles, which agent is
 * where — and it changes nothing. Refusing it would break every legacy client's ability to even
 * ORIENT itself, permanently, for a leak that a caller already holding the shared bearer could get
 * from a dozen other places. Nothing that acts on the canvas belongs in here, and in particular not
 * the confirm-gated pair (`write`, `close`): tolerance would be the one way this feature could
 * weaken the human confirmation, which it must never do.
 */
export const TOLERANT_CONTROL_VERBS = new Set(['list'])

/**
 * The verb `/context-link/*` presents to `controlPolicy`.
 *
 * Every context-link verb is a READ — the route hands back a rendered transcript, summary or
 * terminal capture and changes nothing — so the whole route belongs in the same bucket as `list`.
 * Saying that with a named constant keeps it ONE bucket rather than two lists that drift.
 */
export const CONTEXT_LINK_POLICY_VERB = 'list'

export type IdentityDecision = 'allow' | 'allow-with-warning' | 'refuse'

export interface ControlPolicyInput {
  /** What `verifyNodeToken` made of the presented header. */
  verdict: NodeTokenVerdict
  /**
   * Has THIS node ever presented a token this instance minted for it?
   *
   * The caller is responsible for one subtlety: a FOREIGN kid (another instance's token — the
   * documented cross-instance failover) must arrive here as `proven: false`, even for a node that
   * has latched. It is `legacy` for the same reason it is `legacy` in `verifyNodeToken`: this
   * instance has no standing to judge another instance's credential, and latching against one
   * would break failover on the day a second instance appears.
   */
  proven: boolean
  /** The control verb; `CONTEXT_LINK_POLICY_VERB` for a context-link read. */
  verb: string
  /** Injected, never `Date.now()` inside: a suite has to be able to stand on both sides of the
   *  cutoff without touching the machine clock. */
  now: Date
  /** `settings.hookIdentityStrict`. `undefined` ⇒ follow the constant. */
  override?: boolean
}

/**
 * Pure. Every route decision in this feature comes from this one table:
 *
 *   forged                                    → refuse   (the one unambiguous attack signal)
 *   verified                                  → allow
 *   legacy + latched                          → refuse   (trust on first proof)
 *   legacy + tolerant verb                    → allow    (the legacy population's read path)
 *   legacy + mutation, inside the window      → allow-with-warning
 *   legacy + mutation, past the cutoff        → refuse
 *
 * `override === false` is the escape hatch: it releases the LATCH as well as the cutoff, because
 * the latch is the likelier of the two to have stranded a user whose upgrade went wrong, and a
 * hatch that does not rescue them is not a hatch. It never releases `forged`.
 */
export function controlPolicy({
  verdict,
  proven,
  verb,
  now,
  override
}: ControlPolicyInput): IdentityDecision {
  if (verdict === 'forged') return 'refuse'
  if (verdict === 'verified') return 'allow'
  if (override === false) {
    return TOLERANT_CONTROL_VERBS.has(verb) ? 'allow' : 'allow-with-warning'
  }
  if (proven) return 'refuse'
  if (TOLERANT_CONTROL_VERBS.has(verb)) return 'allow'
  // `isStrictInstant`, not a bare `>=`: a machine clock years ahead of the cutoff would otherwise
  // put this install in strict mode on day one with no warning window at all. See the constant.
  const strict = override ?? isStrictInstant(now)
  return strict ? 'refuse' : 'allow-with-warning'
}
