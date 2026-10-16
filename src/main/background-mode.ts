// Windows/Linux "background mode" — closing the window hides it to the notification-area tray
// instead of quitting (the analogue of macOS keeping the app alive in the Dock), so the phone relay
// host, hook server, agent-status notifications and the updater outlive the window.
//
// Pure + Electron-free so the policy is pressable on any CI box. The controller is ./tray.ts; the
// close-event decision is `closeAction` in ./main-window.ts, which takes the resolved flag.

import { writeFileSync } from 'fs'
import type { BackgroundOnCloseSetting } from '../shared/types'

/**
 * Whether a window close should hide to the tray on this platform.
 *
 * - macOS: always `false` — it hides on close regardless (main-window.ts), and has no tray to add.
 * - `'on'` / `'off'`: the user's explicit choice.
 * - `'auto'`: on for Windows, where the notification area always exists and a running background
 *   app there is the norm; OFF for Linux, whose tray depends on the desktop environment (stock
 *   GNOME has none without an extension) — hiding a window into a tray the user cannot see would
 *   look like a quit that did not happen. A Linux user who has a tray opts in with `'on'`.
 *
 * Any value that is not one of the three reads as `'auto'` (settings.json is hand-editable; the
 * store already normalizes, this is the interpolation-site re-check).
 */
export function resolveBackgroundOnClose(
  setting: BackgroundOnCloseSetting | unknown,
  platform: NodeJS.Platform | string
): boolean {
  if (platform === 'darwin') return false
  if (setting === 'on') return true
  if (setting === 'off') return false
  return platform === 'win32'
}

/** Marker file (under userData) recording that the one-time "still running in the tray" notice was
 *  shown. A file rather than a settings key: the renderer saves FULL settings snapshots from its own
 *  copy, so a main-side settings write would be overwritten by the next renderer save. */
export const BACKGROUND_HINT_MARKER = 'background-close-hint-shown'

export const BACKGROUND_HINT = {
  title: 'nodeterm is still running',
  body: 'Closing the window keeps nodeterm in the notification area so your phone and agent notifications stay connected. Quit from the tray icon.'
} as const

/**
 * Should the first-hide notice show now? Only on an actual background-mode hide (never on macOS,
 * whose Dock already says the app is running), and only once per install.
 */
export function shouldShowBackgroundHint(opts: {
  platform: NodeJS.Platform | string
  backgroundOnClose: boolean
  alreadyShown: boolean
}): boolean {
  return opts.platform !== 'darwin' && opts.backgroundOnClose && !opts.alreadyShown
}

/**
 * Claim a once-per-install marker file in ONE step: an exclusive create (`wx` = O_CREAT|O_EXCL).
 * `'claimed'` — we just created it, so this is the first time; `'already'` — it existed;
 * `'failed'` — it could not be written for another reason (unwritable userData), which the caller
 * treats like the old write failure: warn and still show. An exists-check followed by a separate
 * write is a check-then-use race (CodeQL js/file-system-race) — two hides in quick succession could
 * both see "absent" — and this answers both questions with one syscall.
 */
export function claimOnceMarker(file: string, content: string): 'claimed' | 'already' | 'failed' {
  try {
    writeFileSync(file, content, { flag: 'wx' })
    return 'claimed'
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EEXIST' ? 'already' : 'failed'
  }
}
