// The two keyboard bits a RENDERER owns and main mirrors (see the long comment above
// `clearRendererKeyState` in index.ts), kept PER WINDOW since pop-out project windows
// (docs/popout-windows.md). With one global pair, a pop-out's intercepts followed the MAIN window's
// terminal focus under the `terminal-first` policy, and a recorder armed in a pop-out's Settings
// could not stand anything down. Each window now reports its own bits and its own intercepts read
// them; the application MENU, which is one per app, follows the focused app window.
//
// The fail-safe direction is unchanged: a window with no entry reads as `false` for both (intercepts
// ON), and a window's entry is cleared at exactly the sites the global pair was — its page ending
// (closed, render-process-gone, a main-frame navigation).
export interface WindowKeyState {
  shortcutRecording: boolean
  terminalFocused: boolean
}

const NONE: WindowKeyState = Object.freeze({ shortcutRecording: false, terminalFocused: false })
const byWindow = new Map<number, WindowKeyState>()

/** The bits one window (by webContents id) last reported; both false when it reported nothing. */
export function keyStateOf(webContentsId: number | undefined | null): WindowKeyState {
  return (webContentsId != null && byWindow.get(webContentsId)) || NONE
}

export function setKeyState(webContentsId: number, patch: Partial<WindowKeyState>): void {
  byWindow.set(webContentsId, { ...keyStateOf(webContentsId), ...patch })
}

/** The window's page is gone: forget both bits (never under a live page — see index.ts). */
export function clearKeyState(webContentsId: number): void {
  byWindow.delete(webContentsId)
}

export function resetKeyStateForTests(): void {
  byWindow.clear()
}
