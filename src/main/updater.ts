// Auto-update client (electron-updater). The packaged app downloads updates automatically
// and forwards the full lifecycle (available → progress → downloaded → error/not-available)
// to the renderer's UpdateCard. Version lookup, manual check, and restart work in dev too;
// the automatic feed checks and event wiring are packaged-only. On macOS, silent self-install
// requires a signed + notarized build; unsigned builds still surface the card for a manual
// download.
import { app, ipcMain, Notification } from 'electron'
import fs from 'fs'
import path from 'path'
// Named import — the default-import + destructure pattern returns undefined under
// electron-vite v5's CJS interop.
import { autoUpdater } from 'electron-updater'
import { IPC } from '../shared/ipc'
import {
  isManualUpdatePlatform,
  shouldEnableUpdater,
  toUpdateAvailablePayload
} from '../shared/update-platform'
import { getMainWindow, sendToMain } from './main-window'
import { retainUntilDismissed } from './notifications'

const SIX_HOURS = 6 * 60 * 60 * 1000

/** Local unsigned packages carry this marker in their packaged package.json via extraMetadata. */
function packagedUpdateMode(): unknown {
  if (!app.isPackaged) return undefined
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(app.getAppPath(), 'package.json'), 'utf8')) as {
      nodeTermUpdates?: unknown
    }
    return pkg.nodeTermUpdates
  } catch (err) {
    // A normal release without the marker must preserve the established updater behavior.
    console.warn('[updater] could not read packaged update mode:', err)
    return undefined
  }
}

/**
 * The window is resolved AT EVENT TIME (getMainWindow/sendToMain) — never captured in a closure.
 * On macOS the window can be closed (the app lives on) and recreated from the dock, so a captured
 * reference is a DESTROYED window: touching it throws `TypeError: Object has been destroyed`. That
 * shipped — an update finishing downloading after a close→dock-reopen crashed the main process on
 * `win.isFocused()`.
 *
 * @param onBeforeRestart Run right before `quitAndInstall()`. Required so the caller can flip its
 *   "quitting" flag: `quitAndInstall()` closes all windows and only then calls `app.quit()`, but
 *   our `win.on('close')` hides the window (keeps the app alive) unless we're already quitting — so
 *   without this the window just hides, `app.quit()` never fires, and the update never installs.
 */
export function initUpdater(onBeforeRestart?: () => void): void {
  const send = (channel: string, payload?: unknown) => sendToMain(channel, payload)

  // Always available, even in dev: current version, manual check, restart.
  ipcMain.handle(IPC.appGetVersion, () => app.getVersion())
  ipcMain.on(IPC.appRestartToUpdate, () => {
    onBeforeRestart?.()
    autoUpdater.quitAndInstall()
  })

  if (!shouldEnableUpdater(app.isPackaged, packagedUpdateMode())) {
    // Dev and explicitly local/unsigned packages have no update channel. A manual check reports
    // "up to date" for feedback; automatic networking and updater event wiring stay disabled.
    ipcMain.on(IPC.appCheckForUpdates, () => send(IPC.appUpdateNotAvailable))
    return
  }

  // A Linux .deb/.rpm install (no APPIMAGE env) cannot self-install and would re-download the
  // full AppImage every 6h only to throw on install. Degrade to a manual-download link: don't
  // auto-download; surface update-available with `manual: true` so the card shows a Download link.
  const manualUpdates = isManualUpdatePlatform(process.platform, !!process.env.APPIMAGE)

  autoUpdater.autoDownload = !manualUpdates
  autoUpdater.autoInstallOnAppQuit = !manualUpdates

  autoUpdater.on('update-available', (info) => {
    send(IPC.appUpdateAvailable, toUpdateAvailablePayload(info, manualUpdates))
  })

  autoUpdater.on('download-progress', (p) => {
    send(IPC.appUpdateProgress, {
      percent: p.percent,
      transferred: p.transferred,
      total: p.total,
      bytesPerSecond: p.bytesPerSecond
    })
  })

  autoUpdater.on('update-downloaded', (info) => {
    send(IPC.appUpdateDownloaded, { version: info.version })
    // OS notification only when the window is in the background; the card covers the foreground.
    // Resolve the window HERE, not at init: a download can finish long after a close→dock-reopen.
    // No live window (closed on macOS) reads as "not focused", which is exactly when we notify.
    if (!getMainWindow()?.isFocused() && Notification.isSupported()) {
      const n = new Notification({
        title: 'Update ready',
        body: `nodeterm ${info.version} is ready to install.`
      })
      n.on('click', () => {
        // Resolve again on click — the window may have been closed or recreated since.
        const w = getMainWindow()
        if (!w) return
        if (w.isMinimized()) w.restore()
        w.show()
        w.focus()
      })
      // Keep a reference or GC silently kills the click handler (electron/electron#16922).
      retainUntilDismissed(n)
      n.show()
    }
  })

  autoUpdater.on('update-not-available', () => send(IPC.appUpdateNotAvailable))

  autoUpdater.on('error', (err) => {
    const message = err?.message ?? String(err)
    console.error('[updater]', message)
    send(IPC.appUpdateError, message)
  })

  // Manual check from Settings; surfaces failures to the card.
  ipcMain.on(IPC.appCheckForUpdates, () => {
    autoUpdater.checkForUpdates().catch((err) => {
      const message = err?.message ?? String(err)
      console.error('[updater]', message)
      send(IPC.appUpdateError, message)
    })
  })

  // Automatic checks: on launch and every six hours.
  const check = () => {
    autoUpdater.checkForUpdates().catch((err) => console.error('[updater]', err?.message ?? err))
  }
  check()
  setInterval(check, SIX_HOURS)
}
