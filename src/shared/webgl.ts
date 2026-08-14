/**
 * WebGL context-cap coordination between the desktop shell and the renderer.
 *
 * Chromium caps live WebGL contexts per page (default ~16); past it the browser force-evicts the
 * least-recently-used context, which is what flashes a dead canvas on a visible terminal. The
 * renderer's budget coordinator (`renderer/terminal/webgl-budget.ts`) keeps our own count under a
 * budget so the cap is never hit — but the default cap leaves room for only ~12 GPU-rendered
 * terminals on a busy canvas.
 *
 * On DESKTOP we control the browser too: main raises Chromium's cap via the
 * `--max-active-webgl-contexts` switch (added for exactly this in crbug.com/771792), and the
 * renderer raises the budget to match at boot (`main.tsx` → `setWebglBudget`). The two constants
 * live together here so the "budget comfortably under the cap" invariant is visible in one place.
 * A BROWSER tab (Server Edition) cannot raise its cap, so it stays on the default budget.
 */

/** Chromium's per-page WebGL context cap on desktop (`--max-active-webgl-contexts`). */
export const WEBGL_CONTEXT_CAP_DESKTOP = 32

/** Renderer budget on desktop — comfortably under `WEBGL_CONTEXT_CAP_DESKTOP`, same margin
 *  philosophy as the default 12-under-16. */
export const WEBGL_BUDGET_DESKTOP = 24

/**
 * Renderer budget on MAC desktop, still below the shared-desktop 24 — but no longer 10, and the
 * history of the number is the point. 10 was calibrated against "terminals composite BLACK after
 * a zoom-out grant burst", which was later root-caused to the addon-webgl 0.19 dispose crash
 * (dependency skew, fixed by the 0.18.0 pin + release heal) — evidence that no longer argues
 * for any particular ceiling. What remains genuinely macOS-specific is one UNCONFIRMED
 * 2026-07-30 whole-window-flicker report, filed while the mac budget was 24 (and while the 0.19
 * skew was live, so even that is confounded). 16 is the deliberate middle: enough that roaming
 * a busy canvas rarely hits budget-contention reclaims (the visible DOM→WebGL upgrade at the
 * pan frontier), while not re-creating the exact budget-24 configuration of the flicker report
 * in one step. Equalizing to `WEBGL_BUDGET_DESKTOP` is the next move if a device soak at 16
 * stays clean; if flicker returns, this constant is where the answer goes back down.
 */
export const WEBGL_BUDGET_DESKTOP_MAC = 16

/** How a terminal actually paints: xterm's own DOM renderer, one budgeted WebGL context per
 *  terminal (the coordinator described above), or glyphgrid — ONE context for the whole canvas,
 *  into which every terminal paints. */
export type TerminalRenderer = 'dom' | 'webgl' | 'shared'

/**
 * Resolve the `terminalGpuRendering` setting to the renderer the terminals should use. THE single
 * resolver: there is deliberately no second "is GPU rendering on?" boolean helper, because
 * 'shared' is a GPU mode whose PER-TERMINAL budget must be off, so a boolean answer is wrong for
 * one of its two callers no matter which way it goes.
 *
 * 'auto' (the default) is per-terminal WebGL on EVERY platform. The macOS branch has moved
 * twice before, and the history is the justification for collapsing it:
 *
 *   - It was 'dom', then 'shared' (2026-08-05): per-terminal WebGL on macOS composited BLACK
 *     after zoom-out bursts and was blamed on the OS compositor, so the default first avoided
 *     the GPU and then avoided per-terminal contexts.
 *   - It is now 'webgl', because that macOS evidence collapsed. The blackout was root-caused to
 *     a dependency skew — addon-webgl 0.19's dispose crashed on the 5.5 core and aborted its own
 *     DOM-renderer restore, on every platform (pinned + healed; see
 *     `renderer/terminal/webgl-addon-pair.test.ts`) — and the mass swap waves that amplified it
 *     went with the zoom gate when the context lifecycle became budget-only. What actually
 *     guards macOS is `WEBGL_BUDGET_DESKTOP_MAC` (16), which caps compositor pressure at every
 *     zoom. The one unconfirmed macOS report left is the 2026-07-30 whole-window flicker, whose
 *     escape hatches survive unchanged: 'off' (no GPU) and 'shared' (one canvas-wide context)
 *     are both explicit choices. If a field report contradicts this promotion, the macOS branch
 *     comes back and 'shared' is where it points.
 *
 * The four-way setting is unchanged: 'on' is per-terminal WebGL (now the same as 'auto'), 'off'
 * is the DOM renderer, 'shared' is the canvas-wide glyph renderer on every platform.
 *
 * Legacy booleans still mean their own explicit choice ('on'/'off'); anything unrecognised
 * resolves exactly like 'auto' — the settings-store migration normalizes the file, and a value
 * that slipped past it must land on the DEFAULT.
 */
export function resolveTerminalRenderer(
  value: 'auto' | 'on' | 'off' | 'shared' | boolean | undefined
): TerminalRenderer {
  if (value === 'shared') return 'shared'
  if (value === 'on' || value === true) return 'webgl'
  if (value === 'off' || value === false) return 'dom'
  return 'webgl'
}
