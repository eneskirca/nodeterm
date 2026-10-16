// Windows app identity for toasts, and the per-OS notification-settings deep link.
// Pure + Electron-free (the caller passes platform/isPackaged/execPath) so it is testable anywhere.

/**
 * The AppUserModelID Windows attributes our toasts, taskbar button and jump list to. It MUST equal
 * package.json `build.appId`: the NSIS installer stamps that id onto the Start-menu shortcut
 * (app-builder-lib's installer.nsh `SetLnkAUMI`), and Windows only delivers a toast — attributed,
 * with our name and icon — when the process's AUMID matches a shortcut's. Without an explicit call
 * Electron falls back to a generated `electron.app.<name>` id that matches nothing, so toasts were
 * dropped or mis-attributed with no error at all (Windows never emits Notification 'failed').
 * `app-identity.test.ts` pins the two together.
 */
export const APP_USER_MODEL_ID = 'com.nodeterm.app'

/**
 * The id to pass to `app.setAppUserModelId`, or null where there is nothing to set.
 * - Off Windows: null (the concept does not exist; macOS/Linux behavior is untouched).
 * - Packaged: the build appId, matching the installer's shortcut.
 * - Dev (`electron .`): `process.execPath`, Electron's documented dev value — there is no
 *   shortcut for the build id in a dev checkout, and using it would attribute a dev instance's
 *   toasts to an installed nodeterm on the same machine.
 */
export function appUserModelIdFor(opts: {
  platform: NodeJS.Platform | string
  isPackaged: boolean
  execPath: string
}): string | null {
  if (opts.platform !== 'win32') return null
  return opts.isPackaged ? APP_USER_MODEL_ID : opts.execPath
}

/**
 * The OS notification-settings page to deep-link to so a user can re-enable notifications, or
 * null where there is no such page we can open. A main-side constant — never routed through the
 * renderer-facing openExternal allowlist (which is http(s)-only on purpose).
 */
export function notificationSettingsTarget(platform: NodeJS.Platform | string): string | null {
  if (platform === 'darwin') return 'x-apple.systempreferences:com.apple.Notifications-Settings.extension'
  if (platform === 'win32') return 'ms-settings:notifications'
  return null
}
