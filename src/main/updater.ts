// Auto-update client (electron-updater). The packaged app downloads updates automatically
// and forwards the lifecycle (available → progress → downloaded → error/not-available) to the
// renderer's UpdateCard — filtered by the pure gate in shared/update-gate.ts, so a staged update
// is announced once per version and a background failure never becomes an error card. Version lookup, manual check, and restart work in dev too;
// the automatic feed checks and event wiring are packaged-only. On macOS, silent self-install
// requires a signed + notarized build; unsigned builds still surface the card for a manual
// download.
import { app, autoUpdater as nativeUpdater, ipcMain, Notification } from 'electron'
import fs from 'fs'
import path from 'path'
// Named import — the default-import + destructure pattern returns undefined under
// electron-vite v5's CJS interop.
import { autoUpdater } from 'electron-updater'
import { IPC } from '../shared/ipc'
import {
  installReadiness,
  MANUAL_UPDATE_MODE,
  mayQuitAndInstall,
  releaseNotesText,
  toUpdateAvailablePayload,
  updateDelivery
} from '../shared/update-platform'
import {
  classifyUpdaterError,
  createUpdateGate,
  friendlyUpdateErrorMessage,
  nextDownloadRetryMs,
  type UpdateErrorOrigin
} from '../shared/update-gate'
import type { UpdateInstalling } from '../shared/types'
import { getMainWindow, sendToMain } from './main-window'
import { retainUntilDismissed } from './notifications'
import { requestRendererFlush } from './renderer-flush'
import { consumeUpdateFailedMarker, describeUpdateInstallFailure } from './update-install-marker'

const SIX_HOURS = 6 * 60 * 60 * 1000

/** The outcome of the most recent feed check (any trigger). Recorded so a check-only build's
 *  silent automatic failures are still observable — see the 'error' handler. */
export interface UpdateCheckRecord {
  at: number
  ok: boolean
  message?: string
}
let lastCheck: UpdateCheckRecord | null = null
export function lastUpdateCheck(): UpdateCheckRecord | null {
  return lastCheck
}

/**
 * One actionable log line for a failed check in a check-only build. A 404 on a `latest*.yml` is
 * the feed itself missing — the nodeterm.dev/updates mirror not serving that platform's file —
 * which is an ops fix, not a network blip, and reads like one in a device report. Pure; exported
 * for tests.
 */
export function describeCheckFailure(message: string): string {
  const feedMissing = /\b404\b/.test(message) && /latest[\w.-]*\.yml/i.test(message)
  return feedMissing
    ? `update feed is missing this platform's latest*.yml (${message}); the passive update notice cannot fire until the update mirror serves it`
    : `update check failed: ${message}`
}

/**
 * How long a restart-to-update may sit in `preparing` (macOS: Squirrel.Mac re-reading the zip and
 * verifying its signature) before we give up on THIS click. The update is not cancelled — Squirrel
 * keeps going and a later click (or the next quit) still installs it.
 */
export const PREPARE_TIMEOUT_MS = 5 * 60 * 1000

/**
 * The `nodeTermUpdates` marker a LOCAL package carries in its packaged package.json, injected by
 * the `dist*` scripts via electron-builder's `extraMetadata`. `release` does not set it, so a
 * promoted build is untouched and keeps updating itself. The one RELEASE that carries a marker is
 * the unsigned Windows beta (`dist:win:release` → `manual`): it checks the feed but never
 * downloads or installs — see `updateDelivery`.
 *
 * It exists because a locally packaged app is indistinguishable from a release at runtime —
 * `app.isPackaged` is true for both — so it polled the production feed for a version that was
 * never published there and logged a 404 on `latest*.yml` every six hours.
 *
 * The trade-off, stated plainly: a `dist*` package can no longer smoke-test the updater wiring
 * itself — a manual check there does not go near the network. The old behaviour at least proved
 * the wiring was live, at the cost of a recurring 404 in every local build's log. Verifying the
 * real feed is the job of a `release` package, which carries no marker.
 *
 * The marker is therefore also what `no-channel` means at runtime (see `updateDelivery`): such a
 * build now SAYS it has no channel instead of claiming to be up to date, which is issue #814.
 */
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

export interface UpdaterHooks {
  /**
   * Run right before `quitAndInstall()` — and ONLY once the install can actually start (on macOS:
   * after Squirrel.Mac staged it). Required so the caller can flip its "quitting" flag:
   * `quitAndInstall()` closes all windows and only then calls `app.quit()`, but our
   * `win.on('close')` hides the window (keeps the app alive) unless we're already quitting — so
   * without this the window just hides, `app.quit()` never fires, and the update never installs.
   */
  onBeforeRestart?: () => void
  /** The install failed AFTER `onBeforeRestart` ran: undo what it set (quitting flags). */
  onRestartAborted?: () => void
  /** A version is staged and installable on restart (`null` = none). Feeds the tray item. */
  onUpdateReady?: (version: string | null) => void
  /** Write the renderer's pending canvas edits; must never reject or hang (defaults to
   *  `requestRendererFlush`, capped at ~1 s). */
  flushRenderer?: () => Promise<unknown>
}

export interface UpdaterHandle {
  /** The one guarded restart-to-update path, shared by the card (IPC) and the tray item. */
  restartToUpdate(): void
}

/**
 * The window is resolved AT EVENT TIME (getMainWindow/sendToMain) — never captured in a closure.
 * On macOS the window can be closed (the app lives on) and recreated from the dock, so a captured
 * reference is a DESTROYED window: touching it throws `TypeError: Object has been destroyed`. That
 * shipped — an update finishing downloading after a close→dock-reopen crashed the main process on
 * `win.isFocused()`.
 */
export function initUpdater(hooks: UpdaterHooks = {}): UpdaterHandle {
  const send = (channel: string, payload?: unknown) => sendToMain(channel, payload)
  const flushRenderer =
    hooks.flushRenderer ?? (() => requestRendererFlush(getMainWindow()?.webContents, ipcMain))
  const platform = process.platform

  // A self-update the installer refused on the way in (build/installer.nsh writes this note and
  // restarts the previous version). Read once and deleted; Windows only, a no-op elsewhere.
  const failedInstall = consumeUpdateFailedMarker({
    platform: process.platform,
    localAppData: process.env.LOCALAPPDATA
  })
  if (failedInstall) console.warn('[updater]', describeUpdateInstallFailure(failedInstall))

  const updateMode = packagedUpdateMode()
  const delivery = updateDelivery({
    isPackaged: app.isPackaged,
    updateMode,
    platform,
    hasAppImage: !!process.env.APPIMAGE
  })

  const gate = createUpdateGate()
  // What is staged and whether the OS updater can install it yet (installReadiness).
  let stagedVersion: string | null = null
  let stagedNotes = ''
  let nativeReady = false
  let nativeFailed: string | null = null
  // A failed Squirrel.Mac staging run must be retried: with autoDownload off once staged (the
  // gate), nothing else would ever re-stage the same version in this process — the card would
  // say "ready" while every click failed, until a relaunch. Set by the native 'error' listener,
  // consumed by the next check's 'update-available'; `requestRestage` starts that check now.
  let restageNeeded = false
  let requestRestage: (() => void) | null = null
  // One restart at a time: a double click (or card + tray) must not queue a second install.
  const restart = {
    requested: false,
    waitingForNative: false,
    beforeRestartRan: false,
    timer: undefined as ReturnType<typeof setTimeout> | undefined
  }

  const installing = (phase: UpdateInstalling['phase']): void =>
    send(IPC.appUpdateInstalling, { phase, version: stagedVersion } satisfies UpdateInstalling)

  const abortRestart = (raw: string): void => {
    if (!restart.requested) return
    if (restart.timer) clearTimeout(restart.timer)
    const ranBefore = restart.beforeRestartRan
    restart.requested = false
    restart.waitingForNative = false
    restart.beforeRestartRan = false
    restart.timer = undefined
    // The app was flagged as quitting for a quit that is not coming: without the reset a later
    // window close actually closes (instead of hiding) and the next ⌘Q skips its confirm.
    if (ranBefore) hooks.onRestartAborted?.()
    send(IPC.appUpdateError, friendlyUpdateErrorMessage(raw))
  }

  const proceed = async (): Promise<void> => {
    restart.waitingForNative = false
    if (restart.timer) clearTimeout(restart.timer)
    restart.timer = undefined
    installing('restarting')
    // The last canvas edits, BEFORE quitAndInstall: on macOS it closes every window first, so a
    // flush in before-quit would find no renderer. Capped and never throws.
    await flushRenderer().catch(() => undefined)
    if (!restart.requested) return // aborted while flushing
    restart.beforeRestartRan = true
    hooks.onBeforeRestart?.()
    try {
      autoUpdater.quitAndInstall()
    } catch (err) {
      console.error('[updater] quitAndInstall failed:', err)
      abortRestart(err instanceof Error ? err.message : String(err))
    }
  }

  const restartToUpdate = (): void => {
    // A build that must not self-install refuses here, in main — not only by the card never
    // offering the button. The unsigned Windows beta (`nodeTermUpdates=manual`) is the reason:
    // quitAndInstall must never run there, whatever the renderer sends. It also skips
    // onBeforeRestart, which would otherwise leave the app flagged as quitting with no quit.
    if (!mayQuitAndInstall(delivery)) {
      console.warn(`[updater] restart-to-update ignored: this build does not self-install (${delivery})`)
      return
    }
    if (delivery === 'dev') {
      // Historical dev behaviour: nothing is ever staged, the call is a logged no-op.
      hooks.onBeforeRestart?.()
      autoUpdater.quitAndInstall()
      return
    }
    if (restart.requested) return
    const readiness = installReadiness(platform, { downloaded: stagedVersion !== null, nativeReady })
    if (readiness === 'none') {
      console.warn('[updater] restart-to-update ignored: no update has been downloaded yet')
      return
    }
    restart.requested = true
    if (readiness === 'ready') {
      void proceed()
      return
    }
    // macOS, Squirrel.Mac still staging. Do NOT flag the app as quitting yet — just say so and
    // wait for the native 'update-downloaded' (the listener below calls proceed()).
    if (nativeFailed) {
      abortRestart(nativeFailed)
      // Try staging again in the background so a later click can succeed.
      requestRestage?.()
      return
    }
    restart.waitingForNative = true
    installing('preparing')
    restart.timer = setTimeout(
      () =>
        abortRestart(
          'Preparing the update is taking longer than expected. It will still install the next time you quit.'
        ),
      PREPARE_TIMEOUT_MS
    )
  }

  // Always available, even in dev: current version, manual check, restart.
  ipcMain.handle(IPC.appGetVersion, () => app.getVersion())
  ipcMain.on(IPC.appRestartToUpdate, () => restartToUpdate())
  // A renderer that (re)loads after the one-time announcement — ⌘R, a window recreated after a
  // renderer crash — starts with an empty card, and the gate suppresses repeats (autoDownload is
  // off once staged), so it would never hear about the staged update again. It asks on mount.
  ipcMain.handle(IPC.appGetStagedUpdate, () =>
    stagedVersion === null ? null : { version: stagedVersion, notes: stagedNotes }
  )
  const handle: UpdaterHandle = { restartToUpdate }

  if (delivery === 'dev' || delivery === 'no-channel') {
    // Neither can reach a feed, so automatic networking and updater event wiring stay off — but
    // the two answer a MANUAL check differently, because only one of them has a user to mislead.
    //
    // `no-channel` is a packaged app someone installed from a local `dist*` package. Telling them "up to date" is a statement this build is structurally
    // unable to make — it was issue #814's actual complaint, read by the reporter as a dead
    // button. It now says it has no channel and points at the download page.
    //
    // `dev` keeps the old quiet "up to date": `npm run dev` has no install to be wrong about.
    ipcMain.on(IPC.appCheckForUpdates, () =>
      send(delivery === 'no-channel' ? IPC.appUpdateNoChannel : IPC.appUpdateNotAvailable)
    )
    return handle
  }

  // A Linux .deb/.rpm install (no APPIMAGE env) cannot self-install and would re-download the
  // full AppImage every 6h only to throw on install; the unsigned Windows beta must not
  // self-install. Degrade both to a manual-download link: don't auto-download; surface
  // update-available with `manual: true` so the card shows a Download link. (electron-updater's
  // NsisUpdater verifies a signature only at install time, which this path never reaches.)
  const manualUpdates = delivery === 'manual-install'

  autoUpdater.autoDownload = !manualUpdates
  autoUpdater.autoInstallOnAppQuit = !manualUpdates

  // The flow an error belongs to (classifyUpdaterError): who started the check, and whether a
  // download is running.
  let userFlow = false
  let downloading = false
  let downloadFailures = 0
  let retryTimer: ReturnType<typeof setTimeout> | undefined

  const recordCheck = (ok: boolean, message?: string): void => {
    lastCheck = { at: Date.now(), ok, ...(message === undefined ? {} : { message }) }
  }

  autoUpdater.on('update-available', (info) => {
    recordCheck(true)
    const d = gate.onAvailable(info.version, { userInitiated: userFlow })
    if (!d.download && restageNeeded && info.version === stagedVersion) {
      // Squirrel.Mac failed to stage this version: hand it the (cached) download again.
      restageNeeded = false
      downloading = true
      void autoUpdater.downloadUpdate().catch(() => undefined) // failures arrive as 'error'
    } else if (d.download) {
      // Newer than what is staged. autoDownload is off once something is staged (a re-check must
      // not re-download and re-stage the same zip), so this one is fetched on purpose.
      downloading = true
      void autoUpdater.downloadUpdate().catch(() => undefined) // failures arrive as 'error'
    } else if (!manualUpdates && autoUpdater.autoDownload) {
      downloading = true
    }
    if (d.forward) send(IPC.appUpdateAvailable, toUpdateAvailablePayload(info, manualUpdates))
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
    downloading = false
    userFlow = false
    downloadFailures = 0
    const d = gate.onDownloaded(info.version)
    if (!d.forward) {
      // Our own re-stage of the version already staged (autoDownload is off, so nothing else
      // downloads it): a new Squirrel.Mac staging run starts now, the card already says ready.
      if (info.version === stagedVersion) {
        nativeReady = false
        nativeFailed = null
      }
      return
    }
    stagedVersion = info.version
    // A new staging run starts now (MacUpdater hands the zip to Squirrel.Mac right after this
    // event); the native 'update-downloaded' marks it installable.
    nativeReady = false
    nativeFailed = null
    // Staged: from here on a re-check must not re-download the same version (see the gate).
    autoUpdater.autoDownload = false
    hooks.onUpdateReady?.(info.version)
    stagedNotes = releaseNotesText(info.releaseNotes)
    send(IPC.appUpdateDownloaded, { version: info.version, notes: stagedNotes })
    // OS notification only when the window is in the background; the card covers the foreground.
    // Once per version (the gate) — a staged update used to re-notify every six hours.
    // Resolve the window HERE, not at init: a download can finish long after a close→dock-reopen.
    // No live window (closed on macOS) reads as "not focused", which is exactly when we notify.
    if (d.notify && !getMainWindow()?.isFocused() && Notification.isSupported()) {
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

  autoUpdater.on('update-not-available', () => {
    recordCheck(true)
    downloading = false
    userFlow = false
    send(IPC.appUpdateNotAvailable)
  })

  // Squirrel.Mac (Electron's own autoUpdater — the singleton MacUpdater drives) reports when the
  // staged update is actually installable, and when staging failed. Elsewhere electron-updater
  // installs from the downloaded file itself and the native updater is not involved.
  if (platform === 'darwin' && nativeUpdater) {
    nativeUpdater.on('update-downloaded', () => {
      nativeReady = true
      nativeFailed = null
      if (restart.requested && restart.waitingForNative) void proceed()
    })
    nativeUpdater.on('error', (err: Error) => {
      const message = err?.message ?? String(err)
      console.error('[updater] native updater:', message)
      // Staging (not the install) failed: remember it so a click reports it at once, and re-stage
      // on the next check. Never re-stage from here directly — a persistent failure (a bad
      // signature) would loop download → stage → error with no one asking.
      const stagingFailed = stagedVersion !== null && !nativeReady
      if (stagingFailed) {
        nativeFailed = message
        restageNeeded = true
      }
      if (restart.requested) {
        abortRestart(message)
        // The user is waiting on this one: try staging again now, once per click.
        if (stagingFailed) requestRestage?.()
      }
    })
  }

  // A check-only build (`nodeTermUpdates=manual`, the unsigned Windows beta) downloads nothing, so
  // every 'error' it sees outside a restart is a CHECK failure. Its silent launch/6h check failures
  // are not shown (classifyUpdaterError already keeps every auto-check off the card) — but they are
  // NOT silent either: recorded (`lastUpdateCheck`) and logged as one actionable warning, so a feed
  // that 404s (the mirror not serving latest.yml) reads as an ops fix in the debug log instead of
  // looking like "no update yet".
  const checkOnly = delivery === 'manual-install' && updateMode === MANUAL_UPDATE_MODE

  // One owner for error reporting: this listener. electron-updater emits 'error' for every failed
  // check (manual and automatic alike) and download, so the manual handler below only logs its
  // rejection — answering there too used to put the same error up twice.
  autoUpdater.on('error', (err) => {
    const raw = err?.message ?? String(err)
    // Once quitAndInstall ran, an error is the install failing. While still waiting on Squirrel
    // the native 'error' above is the authority — an unrelated background check failing in that
    // window must not cancel the user's restart.
    if (restart.requested && restart.beforeRestartRan) {
      console.error('[updater]', raw)
      abortRestart(raw)
      return
    }
    const origin: UpdateErrorOrigin = downloading
      ? userFlow
        ? 'manual-download'
        : 'auto-download'
      : userFlow
        ? 'manual-check'
        : 'auto-check'
    if (origin === 'auto-check' || origin === 'manual-check') recordCheck(false, raw)
    if (checkOnly && origin === 'auto-check') console.warn('[updater]', describeCheckFailure(raw))
    else console.error('[updater]', raw)
    const wasDownloading = downloading
    downloading = false
    userFlow = false
    if (classifyUpdaterError(origin) === 'surface') send(IPC.appUpdateError, friendlyUpdateErrorMessage(raw))
    // A failed background download is retried sooner than the next 6h tick (bounded backoff).
    // Check failures (offline at launch) keep the ordinary cadence, so we never hammer the feed.
    if (wasDownloading && origin === 'auto-download' && delivery === 'self-install') {
      const delay = nextDownloadRetryMs(++downloadFailures)
      if (retryTimer) clearTimeout(retryTimer)
      retryTimer = delay === null ? undefined : setTimeout(check, delay)
    }
  })

  // Manual check from Settings / the required card; its outcome reaches the card through the
  // events above.
  ipcMain.on(IPC.appCheckForUpdates, () => {
    userFlow = true
    // Already staged: say so at once (a dismissed ready card comes back), and still look for a
    // newer release.
    const { echoDownloaded } = gate.onManualCheck()
    if (echoDownloaded) send(IPC.appUpdateDownloaded, { version: echoDownloaded })
    autoUpdater.checkForUpdates().catch(() => undefined) // reported by the 'error' listener
  })

  // Automatic checks: on launch and every six hours.
  function check(): void {
    if (retryTimer) clearTimeout(retryTimer)
    retryTimer = undefined
    autoUpdater.checkForUpdates().catch(() => undefined) // logged by the 'error' listener
  }
  requestRestage = check
  check()
  setInterval(check, SIX_HOURS)
  return handle
}
