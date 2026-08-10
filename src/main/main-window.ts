// Live main-window tracking. Everything in the main process that pushes IPC to the
// renderer must resolve the window AT SEND TIME via getMainWindow()/sendToMain() —
// never capture a BrowserWindow in a closure at init. On macOS the window can be
// closed (app stays alive) and recreated from the dock; a captured reference then
// points at a destroyed window and every send is silently dropped (that bug shipped:
// agent status badges died after a close→reopen cycle).

// Structural view of BrowserWindow (keeps this module electron-free and unit-testable).
export interface MainWindowLike {
  isDestroyed(): boolean
  isFocused(): boolean
  isMinimized(): boolean
  restore(): void
  show(): void
  focus(): void
  on(event: 'closed', cb: () => void): void
  // `id` is Electron's webContents id — the same number CorePlatform addresses a UI by
  // (sendTo / the sender id of an ipcMain event). Optional so a test double may omit it.
  webContents: { id?: number; send(channel: string, ...args: unknown[]): void }
}

let current: MainWindowLike | null = null

export function setMainWindow(win: MainWindowLike): void {
  current = win
  win.on('closed', () => {
    // Guard: a late 'closed' from a replaced window must not clear its successor.
    if (current === win) current = null
  })
}

export function getMainWindow(): MainWindowLike | null {
  return current && !current.isDestroyed() ? current : null
}

export function sendToMain(channel: string, ...args: unknown[]): void {
  getMainWindow()?.webContents.send(channel, ...args)
}

/** The attached renderer client ids — Electron has exactly one (the main window's webContents),
 *  or none while the window is closed on macOS. Resolved AT CALL TIME, like sendToMain, so a
 *  recreated window is picked up. Feeds CorePlatform.clientIds(). */
export function mainWindowClientIds(): number[] {
  const id = getMainWindow()?.webContents.id
  return typeof id === 'number' ? [id] : []
}

export type CrashReloadAction = 'reload' | 'give-up' | 'ignore'

// A dead renderer leaves the (single) window a permanent blank page — nothing in Electron
// reloads it. Reload automatically, but bounded: a crash on the boot path would otherwise
// reload forever. 'clean-exit' is a deliberate teardown (window close, navigation), never
// reloaded; everything else — crashed, oom, abnormal-exit, launch-failed, and 'killed'
// (macOS memory-pressure jetsam included) — deserves an attempt.
export function createCrashReloadPolicy(
  opts?: { maxReloads?: number; windowMs?: number }
): (reason: string, now: number) => CrashReloadAction {
  const maxReloads = opts?.maxReloads ?? 2
  const windowMs = opts?.windowMs ?? 60_000
  let granted: number[] = []
  return (reason, now) => {
    if (reason === 'clean-exit') return 'ignore'
    granted = granted.filter((t) => now - t < windowMs)
    if (granted.length >= maxReloads) return 'give-up'
    granted.push(now)
    return 'reload'
  }
}

// macOS convention: closing the window hides it (the app — and its tmux sessions,
// hook server, updater, license watchers — keeps running); a real close only happens
// on quit. Other platforms quit on window close, so never intercept there.
export function shouldHideOnClose(platform: NodeJS.Platform | string, quitting: boolean): boolean {
  return platform === 'darwin' && !quitting
}
