/**
 * Size negotiation for a co-attached PTY: several subscribers watch ONE tmux client, each with
 * its own zoom/DPI/window size, so they compute different cols/rows. The pty runs at the
 * SMALLEST of them — a subscriber that renders fewer columns than the pty emits would wrap and
 * corrupt its screen, while a subscriber with room to spare can simply letterbox the remainder.
 *
 * Deliberately pure (no node-pty, no platform): with exactly ONE subscriber the min of a
 * one-element set is that subscriber's own size, which is what keeps the single-user path
 * bit-for-bit identical to the pre-co-attach behavior.
 */
export interface PtySize {
  cols: number
  rows: number
}

/** Smallest cols × smallest rows across all subscribers; null when there are none. */
export function effectiveSize(sizes: Iterable<PtySize>): PtySize | null {
  let cols = Infinity
  let rows = Infinity
  let any = false
  for (const s of sizes) {
    if (Number.isFinite(s.cols)) cols = Math.min(cols, s.cols)
    if (Number.isFinite(s.rows)) rows = Math.min(rows, s.rows)
    any = true
  }
  if (!any) return null
  // node-pty throws on a 0 dimension, and a not-yet-measured subscriber can report 0. It also
  // wants INTEGERS — xterm's fit addon can report a fractional measurement on a zoomed/HiDPI
  // canvas — so floor first (round down: never claim more columns than the smallest client has)
  // and clamp to >= 1 after, so a sub-1 measurement still yields a 1-col pty rather than 0.
  return {
    cols: Number.isFinite(cols) ? Math.max(1, Math.floor(cols)) : 1,
    rows: Number.isFinite(rows) ? Math.max(1, Math.floor(rows)) : 1
  }
}

/**
 * One viewer's vote on a shared session's size, for `latestClaimSize`.
 *
 * `recency` orders the claims (higher = more recently active). `bounding` marks a viewer that
 * cannot adapt to a grid other than its own — today the phone over the relay, whose app ignores
 * the host's `Resized` frame. Such a viewer rendering a pty WIDER or TALLER than its own screen
 * does not letterbox, it wraps and scrolls the other viewer's output into garbage, so its size is
 * a ceiling for everyone rather than just a vote.
 */
export interface SizeClaim extends PtySize {
  recency: number
  bounding?: boolean
}

/**
 * The size a session-host pty runs at when several viewers share it: the MOST RECENTLY ACTIVE
 * viewer's size — tmux's `window-size latest`, which is what a tmux-backed session already does,
 * because there the phone and the desktop are separate tmux clients (issue #914) — clamped
 * componentwise to every `bounding` claim. Null when there are no claims.
 *
 * Why not the minimum any more: min is safe for every viewer, but it means a phone that dismisses
 * its keyboard can never get its rows back while a shorter desktop node is attached, and nothing
 * on the phone says why. The viewers that DO adapt (every renderer xterm, via `pty:size`) render a
 * larger grid by clipping and a smaller one by letterboxing, exactly as a tmux client shows a
 * window of another client's size — so "latest wins" costs them nothing but the clip.
 *
 * Ties go to the claim that comes LAST in iteration order (Map insertion order), so a caller that
 * never bumps recency gets "most recently added" rather than an arbitrary pick.
 */
export function latestClaimSize(claims: Iterable<SizeClaim>): PtySize | null {
  let latest: SizeClaim | null = null
  let capCols = Infinity
  let capRows = Infinity
  for (const claim of claims) {
    if (!latest || claim.recency >= latest.recency) latest = claim
    if (claim.bounding) {
      capCols = Math.min(capCols, claim.cols)
      capRows = Math.min(capRows, claim.rows)
    }
  }
  if (!latest) return null
  return effectiveSize([
    { cols: Math.min(latest.cols, capCols), rows: Math.min(latest.rows, capRows) }
  ])
}
