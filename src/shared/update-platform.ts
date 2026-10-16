/**
 * Auto-update platform capability — pure, so it unit-tests without an Electron/Node process.
 *
 * electron-updater can only self-install where it knows how to relaunch the new binary. On
 * Linux that path exists only for AppImage installs (the running AppImage's path arrives via
 * the `APPIMAGE` env var, which quitAndInstall re-execs). A .deb / .rpm install has no
 * APPIMAGE, so quitAndInstall throws "APPIMAGE env is not defined" AND every 6h check would
 * still download the full ~231MB AppImage for nothing. For that case we degrade to a
 * manual-download link. macOS (dmg/zip) self-installs as before.
 *
 * The unsigned Windows beta reaches the same manual-download link by a different route: its
 * release package carries the `nodeTermUpdates=manual` build marker (see `updateDelivery`), not a
 * platform rule — so the day a signed Windows release drops the marker it self-installs with
 * nothing to edit here.
 */
import type { UpdateInfo } from './types'

/** True when this OS/install combination cannot self-install and must download manually. */
export function isManualUpdatePlatform(platform: string, hasAppImage: boolean): boolean {
  return platform === 'linux' && !hasAppImage
}

/**
 * The build marker that asks for a feed check WITHOUT self-install: the updater learns which
 * version is out, never downloads it and never installs it. `dist:win:release` stamps it on the
 * unsigned Windows beta — an unsigned auto-update is a downgrade in trust, a "new version is
 * available — download it" card is not.
 */
export const MANUAL_UPDATE_MODE = 'manual'

/** True when updater networking should be initialized for this runtime/build. */
export function shouldEnableUpdater(isPackaged: boolean, updateMode: unknown): boolean {
  return isPackaged && updateMode !== 'disabled'
}

/** Cap on release-notes text forwarded to the renderer: the card shows a few highlights, and a
 *  feed is not a channel for megabytes of IPC. */
const NOTES_MAX = 16 * 1024

/**
 * electron-updater's `releaseNotes` is a string, or — with `fullChangelog` — an array of
 * `{version, note}`. Both become one string; anything else is no notes.
 */
export function releaseNotesText(notes: unknown): string {
  let text = ''
  if (typeof notes === 'string') text = notes
  else if (Array.isArray(notes)) {
    text = notes
      .map((n) => (n && typeof n === 'object' && typeof (n as { note?: unknown }).note === 'string' ? (n as { note: string }).note : ''))
      .filter(Boolean)
      .join('\n')
  }
  return text.length > NOTES_MAX ? text.slice(0, NOTES_MAX) : text
}

/** Reduce an electron-updater update-available info to the renderer's UpdateInfo payload. */
export function toUpdateAvailablePayload(
  info: { version: string; releaseNotes?: unknown },
  manual: boolean
): UpdateInfo {
  return {
    version: info.version,
    notes: releaseNotesText(info.releaseNotes),
    manual
  }
}

/**
 * Whether a staged update can be installed RIGHT NOW.
 *
 * On macOS electron-updater reports `update-downloaded` BEFORE Squirrel.Mac has the update: it
 * dispatches the event and only then asks the native updater to fetch the zip through its localhost
 * proxy, unpack it and verify the signature. Until Electron's own autoUpdater emits
 * `update-downloaded`, `quitAndInstall()` merely queues a listener and returns — so a click there
 * did nothing visible. That window is `preparing`. Every other platform (AppImage, NSIS) installs
 * from the downloaded file itself, so a download is ready.
 */
export type InstallReadiness = 'none' | 'preparing' | 'ready'

export function installReadiness(
  platform: string,
  s: { downloaded: boolean; nativeReady: boolean }
): InstallReadiness {
  if (!s.downloaded) return 'none'
  if (platform === 'darwin' && !s.nativeReady) return 'preparing'
  return 'ready'
}

/**
 * How this build can receive an update. Three delivery paths plus dev, because the REMEDY the
 * user needs differs and the card must not blur them:
 *
 *  - `self-install`   there is a feed and electron-updater can relaunch the new binary: macOS
 *                     dmg/zip, a Linux AppImage, and a Windows release once one is signed and
 *                     published. The ordinary download-progress → "Restart to update" flow.
 *  - `manual-install` there IS a feed, but this install cannot — or must not — self-install:
 *                     Linux .deb/.rpm (no APPIMAGE, so quitAndInstall throws), and any build
 *                     stamped `nodeTermUpdates=manual` (the unsigned Windows beta, until signing
 *                     lands). We know which version is out; the user installs it themselves.
 *  - `no-channel`     there is no feed AT ALL — the build was packaged with updates switched off
 *                     (`nodeTermUpdates=disabled`, which every LOCAL `dist*` script sets). This
 *                     build can never learn that a newer version exists, so a
 *                     check must say so and point at the download page. Reporting "up to date"
 *                     here — what shipped before issue #814 — is a false statement, not feedback.
 *  - `dev`            unpackaged. Deliberately keeps the old quiet "up to date" reply: a developer
 *                     running `npm run dev` is not a user who can be misled about their install.
 *
 * `no-channel` and the marker-driven `manual-install` are decided by the BUILD MARKER, never by a
 * platform name. That is what makes the first signed Windows release (no marker) take the
 * ordinary self-install path with nothing to edit here.
 */
export type UpdateDelivery = 'self-install' | 'manual-install' | 'no-channel' | 'dev'

export function updateDelivery(opts: {
  isPackaged: boolean
  updateMode: unknown
  platform: string
  hasAppImage: boolean
}): UpdateDelivery {
  if (!opts.isPackaged) return 'dev'
  // Composed from the two primitives above rather than re-deciding either — one definition of
  // "has a feed" and one of "can self-install", so the wiring and the copy cannot drift apart.
  if (!shouldEnableUpdater(opts.isPackaged, opts.updateMode)) return 'no-channel'
  // The marker wins over the platform: it is the build saying "never install yourself".
  if (opts.updateMode === MANUAL_UPDATE_MODE) return 'manual-install'
  return isManualUpdatePlatform(opts.platform, opts.hasAppImage) ? 'manual-install' : 'self-install'
}

/**
 * Whether a "Restart to update" request may reach `autoUpdater.quitAndInstall()`. Only a build
 * that self-installs (or a dev run, which keeps its historical no-op behaviour) may. A
 * `manual-install` build never downloads anything, and on the unsigned Windows beta an install
 * from the feed is exactly the trust downgrade the `manual` marker exists to prevent — so the
 * guard holds in main even if a renderer (or a stale card) asks.
 */
export function mayQuitAndInstall(delivery: UpdateDelivery): boolean {
  return delivery === 'self-install' || delivery === 'dev'
}

/** What the update card says when this build will not install the update by itself. */
export interface NoSelfInstallCopy {
  title: string
  body: string
  /** Label of the button that opens the download page. */
  action: string
}

/**
 * The two "you install it yourself" sentences, side by side so neither can quietly become the
 * other. They are NOT interchangeable: `manual-install` names a version we actually saw on the
 * feed and asks the user to install that package; `no-channel` knows no version at all and can
 * only send the user to look. Swapping them sends someone to the wrong place.
 *
 * `manual-install`'s wording is the one Linux .deb/.rpm installs have always shown — keep it
 * byte-identical, it is the pinned no-change path.
 */
export function noSelfInstallCopy(
  delivery: 'manual-install' | 'no-channel',
  version?: string
): NoSelfInstallCopy {
  if (delivery === 'manual-install') {
    return {
      title: 'Update available',
      body: `nodeterm v${version ?? ''} is available. Download it to update.`,
      action: 'Download'
    }
  }
  return {
    title: 'No update channel',
    body:
      'This build has no update channel, so it cannot tell you when a new version is out. ' +
      'Download the latest installer to update.',
    action: 'Open download page'
  }
}
