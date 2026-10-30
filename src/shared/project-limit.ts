/**
 * The free-tier open-project limit (docs/project-limit.md).
 */

/**
 * How many of `projects` are OPEN — the one definition, shared by the open-project report and the
 * gate (spec §3). A project is open when it is in the workspace, not `closed` (a "Recently closed"
 * entry) and not a relay tab (`remote` — a live connection to another machine's project, never a
 * workspace on this disk). SSH projects, cwd-less canvases and unavailable placeholders all count:
 * each is a tab on the user's screen.
 */
export function countOpenProjects(projects: readonly { closed?: boolean; remote?: boolean }[]): number {
  let open = 0
  for (const p of projects) if (!p.closed && !p.remote) open++
  return open
}

/**
 * The compiled FREE: how many open projects a non-Pro install may have before the server has said
 * otherwise. The server owns the real number (spec §4) and sends it on every check while the limit
 * is on, so changing FREE never needs a release; this is only the value used until it has spoken.
 */
export const PROJECT_LIMIT_DEFAULT_FREE = 5

/**
 * The embedded deadline (spec §5): past this instant a client that never heard from the server —
 * DO_NOT_TRACK, `NODETERM_TELEMETRY_DISABLED`, a blocked host — treats the limit as on. In practice
 * that only means "ask the server (claim) before opening beyond FREE"; a `not_active` answer turns
 * it off again. Compared against the clock anchor, never the bare wall clock.
 *
 * RELEASE CHECKLIST: this is BUMPED IN EVERY RELEASE BEFORE THE FLIP, to a date past the planned
 * flip — otherwise DNT users are gated before anyone else. At the flip it is set to the flip date
 * and `PROJECT_LIMIT_DEADLINE_FROZEN` becomes `true`. See docs/project-limit.md.
 *
 * Keep the literal form `Date.parse('<ISO instant>')` on one line: the release deadline guard
 * (docs/project-limit.md) reads it from this source text.
 */
export const PROJECT_LIMIT_DEADLINE_MS = Date.parse('2027-01-31T00:00:00Z')

/**
 * `true` once the flip has happened and the deadline above is the flip date for good: the release
 * guard then stops asking for it to be bumped. See docs/project-limit.md.
 */
export const PROJECT_LIMIT_DEADLINE_FROZEN = false

/** What the renderer's gate needs to decide one open. Core computes it (src/core/project-limit.ts). */
export interface ProjectLimitState {
  /** The limit is on for this install (server latch or embedded deadline; never in a dev build). */
  active: boolean
  /** Pro for the purposes of the limit: unlimited open projects, no claim. */
  pro: boolean
  /** FREE as the server last sent it, else `PROJECT_LIMIT_DEFAULT_FREE`. */
  free: number
  /** The allowance a verified, server-signed token grants this device; `null` = not claimed yet. */
  allowance: number | null
  /** DO_NOT_TRACK is set: a claim (and a purchase) needs the user's consent first (spec §7.4). */
  dnt: boolean
}

/**
 * The answer while the limit is off, and the Server Edition's permanent answer (spec §10): every
 * open is allowed synchronously, nothing is claimed, nothing is shown.
 */
export const INACTIVE_PROJECT_LIMIT: ProjectLimitState = {
  active: false,
  pro: false,
  free: PROJECT_LIMIT_DEFAULT_FREE,
  allowance: null,
  dnt: false
}

/**
 * Why a claim did not produce an allowance. `consent_required` = DO_NOT_TRACK without consent;
 * `disabled` = this build or shell never talks to the license server (an unpackaged desktop build
 * without `NODETERM_API_BASE`, the Server Edition).
 */
export type ClaimError = 'offline' | 'server' | 'machine_mismatch' | 'consent_required' | 'disabled'

/**
 * The outcome of one claim, always carrying the state after it. A server answering `not_active` is
 * `ok: true` with `state.active === false`: the limit is off, which is an answer, not a failure.
 * `retryAfter` (unix seconds) rides `machine_mismatch`: when this device may move machines again.
 */
export type ClaimResult =
  | { ok: true; state: ProjectLimitState }
  | { ok: false; error: ClaimError; retryAfter?: number; state: ProjectLimitState }

/** `claim` = ask the server for this device's allowance first, then decide again. */
export type OpenDecision = 'allow' | 'claim' | 'block'

/**
 * How many open projects this install may have. Never below FREE: an allowance issued before the
 * server raised FREE must not undercut the new FREE.
 */
export function effectiveLimit(s: ProjectLimitState): number {
  return Math.max(s.allowance ?? s.free, s.free)
}

/**
 * Whether ONE new open may proceed with `openCount` projects already open. Off or Pro → allow;
 * under the limit → allow; at it with no allowance yet → claim; at or above a known allowance →
 * block. Above it is reachable (a Pro lapse, for one): the gate blocks the new open and closes
 * nothing.
 */
export function decideOpen(s: ProjectLimitState, openCount: number): OpenDecision {
  if (!s.active || s.pro) return 'allow'
  if (openCount < effectiveLimit(s)) return 'allow'
  if (s.allowance === null) return 'claim'
  return 'block'
}
