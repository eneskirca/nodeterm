// Main-window visibility → the renderer's "backgrounded" signal (renderer/terminal/
// window-backgrounded.ts). Pure + Electron-free so the mapping is pressable on any CI box.
//
// Why an explicit signal and not `document.visibilityState`: Chromium's occlusion tracking also
// flips that to `hidden` for a window that is merely COVERED by another app, and a covered window
// must keep its terminals warm — the user is one ⌘Tab away. Only a window the user actually put
// away (close-to-tray / macOS hide-on-close / minimize) is backgrounded.
//
// The same trap exists one layer down, in Electron itself: on macOS `BrowserWindow` emits `hide`
// and `show` from `windowDidChangeOcclusionState:` — i.e. for a window that is merely fully
// covered by another app, switched away from on another Space, or hidden with ⌘H. Forwarding a
// raw `hide` would therefore release every terminal of a Mac user who had a browser maximized over
// nodeterm for two minutes. So `hide` counts ONLY when the app itself put the window away (the
// close-to-tray / hide-on-close branch sets `hiddenByApp` right before its `win.hide()`).
// `minimize` is unambiguous on every platform. `show` / `restore` always map to `'shown'`, which
// the renderer treats idempotently.

/** The BrowserWindow events that change whether the user can see the window at all. */
export type WindowVisibilityEvent = 'hide' | 'show' | 'minimize' | 'restore'

export type WindowVisibilitySignal = 'hidden' | 'shown'

export const WINDOW_VISIBILITY_EVENTS: readonly WindowVisibilityEvent[] = [
  'hide',
  'show',
  'minimize',
  'restore'
]

export interface WindowVisibilityContext {
  /** True while the window is hidden because the APP hid it (close-to-tray / hide-on-close). */
  hiddenByApp: boolean
}

/**
 * Map one window event to the signal the renderer gets, or `null` for "say nothing". `restore` can
 * also arrive for a window that was never minimized (some Linux window managers emit it on
 * un-maximize); that maps to `'shown'`, which the renderer treats idempotently. A `hide` the app
 * did not ask for (macOS occlusion, ⌘H) is `null`: the fail-safe direction is "keep everything".
 */
export function windowVisibilitySignal(
  event: WindowVisibilityEvent,
  ctx: WindowVisibilityContext
): WindowVisibilitySignal | null {
  if (event === 'minimize') return 'hidden'
  if (event === 'hide') return ctx.hiddenByApp ? 'hidden' : null
  return 'shown'
}
