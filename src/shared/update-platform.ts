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
