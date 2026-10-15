// Pure model for the Windows/Linux background-mode tray (./tray.ts owns the Electron Tray).
// Electron-free so the menu's labels, enabled states and actions are testable on any CI box.

/** What the tray shows. Deliberately small: it is fed from facts main already holds (the unread
 *  count the renderer sends for the Dock badge, and the phone-access setting) — no new feed, so a
 *  hook-event burst can never rebuild the menu. */
export interface TrayState {
  unread: number
  phoneAccess: boolean
  /** A downloaded update installable by a restart (its version), fed by the updater. A background-
   *  mode app is rarely quit, so install-on-quit alone could leave it waiting for days. */
  updateReady?: string | null
}

export type TrayAction = 'open' | 'quit' | 'restart-update'

export type TrayMenuItem =
  | { type: 'separator' }
  | { type: 'normal'; label: string; enabled: boolean; action?: TrayAction }

function unreadLabel(n: number): string {
  return n === 1 ? '1 unread session' : `${n} unread sessions`
}

/** Clamp the renderer-sent count: an IPC payload is not a type. */
export function normalizeUnread(n: unknown): number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
}

export function trayMenuModel(state: TrayState): TrayMenuItem[] {
  const items: TrayMenuItem[] = [
    { type: 'normal', label: 'Open nodeterm', enabled: true, action: 'open' },
    { type: 'separator' }
  ]
  const unread = normalizeUnread(state.unread)
  if (unread > 0) items.push({ type: 'normal', label: unreadLabel(unread), enabled: false })
  items.push({ type: 'normal', label: `Phone access: ${state.phoneAccess ? 'on' : 'off'}`, enabled: false })
  items.push({ type: 'separator' })
  // The same guarded restart the update card's button takes (updater.ts `restartToUpdate`).
  if (state.updateReady)
    items.push({ type: 'normal', label: `Restart to update v${state.updateReady}`, enabled: true, action: 'restart-update' })
  // Quit goes through the ordinary app.quit() → before-quit path (confirm dialog included), so a
  // tray quit tears down exactly what the menu Quit (Ctrl+Q on Linux, File → Exit on Windows) does.
  items.push({ type: 'normal', label: 'Quit nodeterm', enabled: true, action: 'quit' })
  return items
}

export function trayTooltip(state: TrayState): string {
  const unread = normalizeUnread(state.unread)
  return unread > 0 ? `nodeterm — ${unreadLabel(unread)}` : 'nodeterm'
}

/** Identity of a state for rebuild de-duplication: the menu is rebuilt only when this changes. */
export function trayStateKey(state: TrayState): string {
  return `${normalizeUnread(state.unread)}|${state.phoneAccess ? 1 : 0}|${state.updateReady ?? ''}`
}

/**
 * Where the tray icon lives. The packaged app carries `icon.png` in resources on every platform
 * (package.json top-level `extraResources`, which electron-builder concatenates with the
 * platform-specific lists); dev reads the generated `build/icon.png` (`npm run make-icon`).
 */
export function trayIconPath(opts: {
  isPackaged: boolean
  resourcesPath: string
  devBuildDir: string
  join: (...parts: string[]) => string
}): string {
  return opts.isPackaged ? opts.join(opts.resourcesPath, 'icon.png') : opts.join(opts.devBuildDir, 'icon.png')
}
