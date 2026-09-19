/**
 * Auto-update platform capability — pure, so it unit-tests without an Electron/Node process.
 *
 * electron-updater can only self-install where it knows how to relaunch the new binary. On
 * Linux that path exists only for AppImage installs (the running AppImage's path arrives via
 * the `APPIMAGE` env var, which quitAndInstall re-execs). A .deb / .rpm install has no
 * APPIMAGE, so quitAndInstall throws "APPIMAGE env is not defined" AND every 6h check would
 * still download the full ~231MB AppImage for nothing. For that case we degrade to a
 * manual-download link. macOS (dmg/zip) and Windows self-install as before.
 */
import type { UpdateInfo } from './types'

/** True when this OS/install combination cannot self-install and must download manually. */
export function isManualUpdatePlatform(platform: string, hasAppImage: boolean): boolean {
  return platform === 'linux' && !hasAppImage
}

/** True when updater networking should be initialized for this runtime/build. */
export function shouldEnableUpdater(isPackaged: boolean, updateMode: unknown): boolean {
  return isPackaged && updateMode !== 'disabled'
}

/** Reduce an electron-updater update-available info to the renderer's UpdateInfo payload. */
export function toUpdateAvailablePayload(
  info: { version: string; releaseNotes?: unknown },
  manual: boolean
): UpdateInfo {
  return {
    version: info.version,
    notes: typeof info.releaseNotes === 'string' ? info.releaseNotes : '',
    manual
  }
}

/**
 * How this build can receive an update. Three delivery paths plus dev, because the REMEDY the
 * user needs differs and the card must not blur them:
 *
 *  - `self-install`   there is a feed and electron-updater can relaunch the new binary: macOS
 *                     dmg/zip, a Linux AppImage, and a Windows release once one is signed and
 *                     published. The ordinary download-progress → "Restart to update" flow.
 *  - `manual-install` there IS a feed, but this install cannot self-install (Linux .deb/.rpm: no
 *                     APPIMAGE, so quitAndInstall throws). We know which version is out; the user
 *                     installs that package themselves.
 *  - `no-channel`     there is no feed AT ALL — the build was packaged with updates switched off
 *                     (`nodeTermUpdates=disabled`, which every `dist*` script sets, and which a
 *                     Windows build carries today because Windows has no signed release job or
 *                     `latest.yml`). This build can never learn that a newer version exists, so a
 *                     check must say so and point at the download page. Reporting "up to date"
 *                     here — what shipped before issue #814 — is a false statement, not feedback.
 *  - `dev`            unpackaged. Deliberately keeps the old quiet "up to date" reply: a developer
 *                     running `npm run dev` is not a user who can be misled about their install.
 *
 * `no-channel` is decided by the BUILD MARKER, never by a platform name. That is what makes the
 * first Windows release with a real channel show the ordinary path with nothing to edit here.
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
  return isManualUpdatePlatform(opts.platform, opts.hasAppImage) ? 'manual-install' : 'self-install'
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
