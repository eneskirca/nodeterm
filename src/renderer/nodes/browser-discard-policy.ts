/**
 * Hidden-webview discard ("Browser Memory Saver", the same idea as Chrome tab discarding): each
 * Electron `<webview>` is a full Chromium renderer PROCESS, and a canvas has no cap on how many
 * browser/web nodes it holds. A page that has sat hidden this long is cheaper to rebuild from its
 * URL on reveal than to keep resident.
 *
 * Three constraints are baked into the predicate:
 *  - **Never discard mid-load.** Restoring would replay a half-finished navigation (and a POST
 *    result or an interstitial would simply be lost).
 *  - **Never discard a page making noise.** Audible = in use, even off-screen (a call, music, a
 *    video the user is listening to). Chrome exempts audible tabs for the same reason.
 *  - **The setting is re-read when the timer FIRES, not when it was armed** — so a user who
 *    switches the saver off during a hidden stretch is not discarded by an older timer. The
 *    symmetry is deliberately incomplete: switching the saver ON mid-hide does NOT discard that
 *    page at the end of the current stretch, because the disabled branch arms no retry (pinned by
 *    `useDiscardWhenHidden.test.tsx`). Such a page is picked up on its next hide→show cycle. The
 *    conservative direction is the right one — a user turning the feature off must be obeyed at
 *    once, one turning it on can wait.
 *
 * The back/forward stack does NOT survive a discard — Electron's `<webview>` cannot serialize it.
 * What survives is the descriptor (the current URL) and the user's own history store, which is the
 * same trade Chrome makes.
 */
export const BROWSER_DISCARD_MS = 5 * 60_000

export function shouldDiscard(i: {
  hiddenMs: number
  loading: boolean
  enabled: boolean
  /** Is the page making sound right now? Optional so a surface that cannot tell says nothing. */
  audible?: boolean
}): boolean {
  return i.enabled && !i.loading && !i.audible && i.hiddenMs > BROWSER_DISCARD_MS
}
