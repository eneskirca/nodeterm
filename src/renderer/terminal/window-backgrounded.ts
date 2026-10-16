/**
 * "The window is put away" — one module-level flag the terminal levers read beside viewport
 * visibility.
 *
 * Every renderer reclaim lever (offscreen release, the WebGL budget, the hibernation sweep's
 * "is anybody watching") takes visibility from a per-node IntersectionObserver, and that observer
 * measures against the PAGE's viewport — which a hidden BrowserWindow still has. So a window closed
 * to the tray (the Windows default), hidden on close (macOS) or minimized kept every on-screen
 * terminal, its WebGL context and its PTY client resident for as long as it stayed hidden.
 *
 * The fix is one more INPUT, not a parallel release path: while backgrounded, every node reports
 * itself offscreen (`effectiveVisible`), so the existing state machine runs with all of its gates
 * intact — the live-work deferral (a plain-shell agent mid-turn is never killed), the held-launch
 * and Eco deferrals, the remote/SSH exclusion, the selected-node refusal and the setting's
 * `0 = never`. On show the observer's real verdict flows again and released nodes revive through
 * the ordinary warm re-attach.
 *
 * Fed ONLY by the desktop shell's explicit signal (`onWindowVisibility`), never by
 * `document.visibilityState`: an occluded window must not release, and the Server Edition's tab
 * switches must not either (its bridge declares the signal a no-op). Fail-safe direction: `false`
 * (not backgrounded = keep everything), which is what a fresh page or a missed event resolves to.
 */

/** How long the window must stay hidden before the levers run. A quick close/reopen (or a minimize
 *  to glance at something) stays warm; a window put away for longer gives memory back. */
export const BACKGROUND_RELEASE_DWELL_MS = 2 * 60_000

let backgrounded = false
const listeners = new Set<(backgrounded: boolean) => void>()

export function isWindowBackgrounded(): boolean {
  return backgrounded
}

/** Set the flag; listeners hear CHANGES only (a repeated `'shown'` is a no-op). */
export function setWindowBackgrounded(next: boolean): void {
  if (next === backgrounded) return
  backgrounded = next
  for (const l of [...listeners]) {
    // One node's failure must not stop the rest of the canvas hearing the edge.
    try {
      l(next)
    } catch (err) {
      console.warn('[window-backgrounded] listener failed (continuing)', err)
    }
  }
}

export function subscribeWindowBackgrounded(listener: (backgrounded: boolean) => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** What a node reports to the levers: the observer's verdict, unless the window is put away. */
export function effectiveVisible(intersecting: boolean, windowBackgrounded: boolean): boolean {
  return intersecting && !windowBackgrounded
}

/**
 * The offscreen-release delay for a node that goes offscreen BECAUSE the window was put away: the
 * shorter of the user's offscreen window and the background dwell. `null` (the setting's
 * "never") stays `null` — backgrounding never overrides an explicit opt-out.
 */
export function backgroundReleaseMs(
  disposeMs: number | null,
  windowBackgrounded: boolean
): number | null {
  if (disposeMs === null || !windowBackgrounded) return disposeMs
  return Math.min(disposeMs, BACKGROUND_RELEASE_DWELL_MS)
}

/** Test seam: reset module state between tests. */
export function resetWindowBackgroundedForTests(): void {
  backgrounded = false
  listeners.clear()
}
