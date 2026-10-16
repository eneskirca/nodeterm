// The updater's event policy and restart flow, wired (the pure rules live in
// src/shared/update-gate.test.ts and update-platform.test.ts). Platform is injected through
// process.platform + the packaged marker, so every branch runs on Linux CI.
//
//  - macOS: "Restart to update" must not flag the app as quitting until Squirrel.Mac has staged the
//    update, must say it is preparing meanwhile, and must install exactly once.
//  - a staged update is announced (and notified) once per version, not every six hours.
//  - background failures log; a failed background download retries on a backoff.
import { EventEmitter } from 'events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import { IPC } from '../shared/ipc'

const { ipcOn, ipcHandle, sent, appMock, notifications, nativeUpdater } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { EventEmitter: EE } = require('events') as typeof import('events')
  return {
    ipcOn: {} as Record<string, (...a: unknown[]) => void>,
    ipcHandle: {} as Record<string, (...a: unknown[]) => unknown>,
    sent: [] as Array<{ channel: string; payload?: unknown }>,
    appMock: { isPackaged: true, appPath: '' },
    notifications: [] as string[],
    nativeUpdater: new EE()
  }
})

vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return appMock.isPackaged
    },
    getAppPath: () => appMock.appPath,
    getVersion: () => '0.3.7'
  },
  ipcMain: {
    on: (ch: string, fn: (...a: unknown[]) => void) => {
      ipcOn[ch] = fn
    },
    handle: (ch: string, fn: (...a: unknown[]) => unknown) => {
      ipcHandle[ch] = fn
    },
    removeListener: () => {}
  },
  Notification: Object.assign(
    function (this: { on: () => void; show: () => void }, opts: { body: string }) {
      notifications.push(opts.body)
      this.on = () => {}
      this.show = () => {}
    },
    { isSupported: () => true }
  ),
  autoUpdater: nativeUpdater
}))

const { autoUpdater } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { EventEmitter: EE } = require('events') as typeof import('events')
  const em = new EE()
  return {
    autoUpdater: Object.assign(em, {
      autoDownload: true,
      autoInstallOnAppQuit: true,
      checkForUpdates: vi.fn(() => Promise.resolve(null)),
      downloadUpdate: vi.fn(() => Promise.resolve([])),
      quitAndInstall: vi.fn()
    })
  }
})
vi.mock('electron-updater', () => ({ autoUpdater }))
vi.mock('./main-window', () => ({
  getMainWindow: () => null,
  sendToMain: (channel: string, payload?: unknown) => sent.push({ channel, payload })
}))
vi.mock('./notifications', () => ({ retainUntilDismissed: () => {} }))

import { initUpdater, PREPARE_TIMEOUT_MS } from './updater'

const realReadFileSync = fs.readFileSync
const realPlatform = process.platform
const realAppImage = process.env.APPIMAGE

function release(platform: string): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
  appMock.appPath = path.join(path.sep, 'fake-app-path')
  const target = path.join(appMock.appPath, 'package.json')
  vi.spyOn(fs, 'readFileSync').mockImplementation(((file: unknown, ...rest: unknown[]) =>
    file === target ? JSON.stringify({ name: 'x' }) : realReadFileSync(file as never, ...(rest as []))) as typeof fs.readFileSync)
}

const hooks = () => ({
  onBeforeRestart: vi.fn(),
  onRestartAborted: vi.fn(),
  onUpdateReady: vi.fn(),
  flushRenderer: vi.fn(() => Promise.resolve('flushed'))
})

const of = (ch: string) => sent.filter((s) => s.channel === ch)
const restart = (): void => ipcOn[IPC.appRestartToUpdate]?.()
const check = (): void => ipcOn[IPC.appCheckForUpdates]?.()
const flushMicrotasks = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

beforeEach(() => {
  vi.useFakeTimers()
  for (const k of Object.keys(ipcOn)) delete ipcOn[k]
  for (const k of Object.keys(ipcHandle)) delete ipcHandle[k]
  sent.length = 0
  notifications.length = 0
  ;(autoUpdater as EventEmitter).removeAllListeners()
  nativeUpdater.removeAllListeners()
  autoUpdater.checkForUpdates.mockClear()
  autoUpdater.downloadUpdate.mockClear()
  autoUpdater.quitAndInstall.mockClear()
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  appMock.isPackaged = true
  delete process.env.APPIMAGE
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true })
  if (realAppImage === undefined) delete process.env.APPIMAGE
  else process.env.APPIMAGE = realAppImage
})

describe('macOS restart waits for Squirrel.Mac', () => {
  let h: ReturnType<typeof hooks>
  beforeEach(() => {
    release('darwin')
    h = hooks()
    initUpdater(h)
    autoUpdater.emit('update-downloaded', { version: '1.1.0' })
  })

  it('before native staging: says preparing, flags nothing, installs nothing', async () => {
    restart()
    await flushMicrotasks()
    expect(of(IPC.appUpdateInstalling)).toEqual([
      { channel: IPC.appUpdateInstalling, payload: { phase: 'preparing', version: '1.1.0' } }
    ])
    expect(h.onBeforeRestart).not.toHaveBeenCalled()
    expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled()
  })

  it('once staged: restarting → flush → flags → quitAndInstall, exactly once despite double clicks', async () => {
    restart()
    restart()
    nativeUpdater.emit('update-downloaded')
    await flushMicrotasks()
    restart()
    await flushMicrotasks()
    expect(of(IPC.appUpdateInstalling).map((s) => (s.payload as { phase: string }).phase)).toEqual([
      'preparing',
      'restarting'
    ])
    expect(h.flushRenderer).toHaveBeenCalledTimes(1)
    expect(h.onBeforeRestart).toHaveBeenCalledTimes(1)
    expect(autoUpdater.quitAndInstall).toHaveBeenCalledTimes(1)
    expect(h.flushRenderer.mock.invocationCallOrder[0]).toBeLessThan(h.onBeforeRestart.mock.invocationCallOrder[0])
  })

  it('already staged before the click: installs at once', async () => {
    nativeUpdater.emit('update-downloaded')
    restart()
    await flushMicrotasks()
    expect(of(IPC.appUpdateInstalling).map((s) => (s.payload as { phase: string }).phase)).toEqual(['restarting'])
    expect(autoUpdater.quitAndInstall).toHaveBeenCalledTimes(1)
  })

  it('a native error while preparing aborts with a card, and a later click may try again', async () => {
    restart()
    nativeUpdater.emit('error', new Error('Code signature did not pass validation'))
    await flushMicrotasks()
    expect(of(IPC.appUpdateError)).toEqual([
      { channel: IPC.appUpdateError, payload: 'Code signature did not pass validation' }
    ])
    expect(h.onBeforeRestart).not.toHaveBeenCalled()
    expect(h.onRestartAborted).not.toHaveBeenCalled() // nothing was flagged, nothing to undo
    nativeUpdater.emit('update-downloaded')
    restart()
    await flushMicrotasks()
    expect(autoUpdater.quitAndInstall).toHaveBeenCalledTimes(1)
  })

  it('a staging failure BEFORE the click is reported on the click instead of hanging in preparing', async () => {
    nativeUpdater.emit('error', new Error('staging failed'))
    restart()
    await flushMicrotasks()
    expect(of(IPC.appUpdateInstalling)).toEqual([])
    expect(of(IPC.appUpdateError).map((s) => s.payload)).toEqual(['staging failed'])
  })

  it('a failed staging run is re-staged on the next check (autoDownload is off once staged)', async () => {
    expect(autoUpdater.autoDownload).toBe(false)
    nativeUpdater.emit('error', new Error('staging failed'))
    // The 6h re-check of the SAME version: nothing forwarded, but the cached zip is handed to
    // Squirrel again — otherwise the update could never install in this process.
    autoUpdater.emit('update-available', { version: '1.1.0' })
    expect(autoUpdater.downloadUpdate).toHaveBeenCalledTimes(1)
    autoUpdater.emit('update-downloaded', { version: '1.1.0' })
    expect(of(IPC.appUpdateAvailable)).toEqual([])
    expect(of(IPC.appUpdateDownloaded)).toHaveLength(1) // only the original announcement
    // Only once per failure: a further repeat does not re-download.
    autoUpdater.emit('update-available', { version: '1.1.0' })
    expect(autoUpdater.downloadUpdate).toHaveBeenCalledTimes(1)
    // The new staging run succeeds; a click now installs instead of replaying the old failure.
    nativeUpdater.emit('update-downloaded')
    restart()
    await flushMicrotasks()
    expect(of(IPC.appUpdateError)).toEqual([])
    expect(autoUpdater.quitAndInstall).toHaveBeenCalledTimes(1)
  })

  it('a click that hits a staging failure starts one re-stage (no loop without a click)', async () => {
    nativeUpdater.emit('error', new Error('staging failed'))
    expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1) // launch check only
    restart()
    expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(2)
    // A re-stage that fails again, unasked, does not trigger another check by itself.
    autoUpdater.emit('update-available', { version: '1.1.0' })
    autoUpdater.emit('update-downloaded', { version: '1.1.0' })
    nativeUpdater.emit('error', new Error('staging failed'))
    expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(2)
  })

  it('an error after quitAndInstall undoes the quitting flags', async () => {
    nativeUpdater.emit('update-downloaded')
    restart()
    await flushMicrotasks()
    nativeUpdater.emit('error', new Error('install failed'))
    expect(h.onRestartAborted).toHaveBeenCalledTimes(1)
    expect(of(IPC.appUpdateError).map((s) => s.payload)).toEqual(['install failed'])
  })

  it('a background check failing while preparing does not cancel the restart', async () => {
    restart()
    autoUpdater.emit('error', new Error('net::ERR_INTERNET_DISCONNECTED'))
    nativeUpdater.emit('update-downloaded')
    await flushMicrotasks()
    expect(of(IPC.appUpdateError)).toEqual([])
    expect(autoUpdater.quitAndInstall).toHaveBeenCalledTimes(1)
  })

  it('gives up on a click that waits too long, without cancelling the update', async () => {
    restart()
    vi.advanceTimersByTime(PREPARE_TIMEOUT_MS)
    await flushMicrotasks()
    expect(of(IPC.appUpdateError)).toHaveLength(1)
    expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled()
  })

  it('a flush that times out still installs', async () => {
    h.flushRenderer.mockImplementation(() => Promise.resolve('timeout'))
    nativeUpdater.emit('update-downloaded')
    restart()
    await flushMicrotasks()
    expect(autoUpdater.quitAndInstall).toHaveBeenCalledTimes(1)
  })
})

describe('other self-install platforms install from the download', () => {
  it('Linux AppImage: restarting → quitAndInstall immediately, no native wait', async () => {
    release('linux')
    process.env.APPIMAGE = '/tmp/nodeterm.AppImage'
    const h = hooks()
    initUpdater(h)
    autoUpdater.emit('update-downloaded', { version: '1.1.0' })
    restart()
    await flushMicrotasks()
    expect(of(IPC.appUpdateInstalling).map((s) => (s.payload as { phase: string }).phase)).toEqual(['restarting'])
    expect(autoUpdater.quitAndInstall).toHaveBeenCalledTimes(1)
    expect(nativeUpdater.listenerCount('update-downloaded')).toBe(0)
  })

  it('nothing downloaded yet: the click is ignored and nothing is flagged', async () => {
    release('linux')
    process.env.APPIMAGE = '/tmp/nodeterm.AppImage'
    const h = hooks()
    initUpdater(h)
    restart()
    await flushMicrotasks()
    expect(h.onBeforeRestart).not.toHaveBeenCalled()
    expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled()
  })
})

describe('a staged update is announced once per version', () => {
  let h: ReturnType<typeof hooks>
  beforeEach(() => {
    release('darwin')
    h = hooks()
    initUpdater(h)
  })

  it('a repeat downloaded/available (the 6h re-check) sends nothing and notifies once', () => {
    autoUpdater.emit('update-available', { version: '1.1.0' })
    autoUpdater.emit('update-downloaded', { version: '1.1.0' })
    autoUpdater.emit('update-available', { version: '1.1.0' })
    autoUpdater.emit('update-downloaded', { version: '1.1.0' })
    expect(of(IPC.appUpdateAvailable)).toHaveLength(1)
    expect(of(IPC.appUpdateDownloaded)).toHaveLength(1)
    expect(notifications).toEqual(['nodeterm 1.1.0 is ready to install.'])
    expect(h.onUpdateReady).toHaveBeenCalledTimes(1)
    expect(h.onUpdateReady).toHaveBeenCalledWith('1.1.0')
  })

  it('once staged it stops auto-downloading, and fetches a NEWER release on purpose', () => {
    autoUpdater.emit('update-downloaded', { version: '1.1.0' })
    expect(autoUpdater.autoDownload).toBe(false)
    expect(autoUpdater.autoInstallOnAppQuit).toBe(true)
    autoUpdater.emit('update-available', { version: '1.1.0' })
    expect(autoUpdater.downloadUpdate).not.toHaveBeenCalled()
    autoUpdater.emit('update-available', { version: '1.2.0' })
    expect(autoUpdater.downloadUpdate).toHaveBeenCalledTimes(1)
    autoUpdater.emit('update-downloaded', { version: '1.2.0' })
    expect(notifications).toHaveLength(2)
  })

  it('a manual check while staged echoes the staged version (no notification) and still looks', () => {
    autoUpdater.emit('update-downloaded', { version: '1.1.0' })
    sent.length = 0
    autoUpdater.checkForUpdates.mockClear()
    check()
    expect(of(IPC.appUpdateDownloaded)).toEqual([{ channel: IPC.appUpdateDownloaded, payload: { version: '1.1.0' } }])
    expect(notifications).toHaveLength(1)
    expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1)
  })
})

describe('errors and retries', () => {
  beforeEach(() => {
    release('darwin')
    initUpdater(hooks())
  })

  it('a background check failure is logged, never carded', () => {
    autoUpdater.emit('error', new Error('net::ERR_INTERNET_DISCONNECTED'))
    expect(of(IPC.appUpdateError)).toEqual([])
  })

  it('a manual check failure is carded once, in plain words', () => {
    check()
    autoUpdater.emit('error', new Error('net::ERR_INTERNET_DISCONNECTED'))
    expect(of(IPC.appUpdateError)).toEqual([
      { channel: IPC.appUpdateError, payload: "Couldn't reach the update server. Check your connection and try again." }
    ])
  })

  it('a manual check that started a download still reports that download failing', () => {
    check()
    autoUpdater.emit('update-available', { version: '1.1.0' })
    autoUpdater.emit('error', new Error('ECONNRESET'))
    expect(of(IPC.appUpdateError)).toHaveLength(1)
  })

  it('a failed BACKGROUND download is silent and retried at 15, then 30 minutes', () => {
    const MIN = 60 * 1000
    autoUpdater.checkForUpdates.mockClear()
    autoUpdater.emit('update-available', { version: '1.1.0' })
    autoUpdater.emit('error', new Error('ECONNRESET'))
    expect(of(IPC.appUpdateError)).toEqual([])
    vi.advanceTimersByTime(15 * MIN - 1)
    expect(autoUpdater.checkForUpdates).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1)
    autoUpdater.emit('update-available', { version: '1.1.0' })
    autoUpdater.emit('error', new Error('ECONNRESET'))
    vi.advanceTimersByTime(30 * MIN)
    expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(2)
  })

  it('a background CHECK failure schedules no early retry', () => {
    autoUpdater.checkForUpdates.mockClear()
    autoUpdater.emit('error', new Error('offline'))
    vi.advanceTimersByTime(5 * 60 * 60 * 1000)
    expect(autoUpdater.checkForUpdates).not.toHaveBeenCalled()
  })
})

describe('manual-install builds keep their cadence', () => {
  it('a Linux .deb schedules no download retry (it downloads nothing)', () => {
    release('linux')
    initUpdater(hooks())
    autoUpdater.checkForUpdates.mockClear()
    autoUpdater.emit('update-available', { version: '1.1.0' })
    autoUpdater.emit('error', new Error('ECONNRESET'))
    vi.advanceTimersByTime(5 * 60 * 60 * 1000)
    expect(autoUpdater.checkForUpdates).not.toHaveBeenCalled()
    expect(autoUpdater.autoInstallOnAppQuit).toBe(false)
  })
})

describe('a renderer that loads after the announcement can ask for it', () => {
  it('getStaged answers null before, and the staged version + notes after, staging', () => {
    release('linux')
    process.env.APPIMAGE = '/tmp/x.AppImage'
    initUpdater(hooks())
    expect(ipcHandle[IPC.appGetStagedUpdate]?.()).toBeNull()
    autoUpdater.emit('update-downloaded', { version: '1.1.0', releaseNotes: '- one' })
    // A repeat is suppressed for the push channel, but the pull still answers.
    autoUpdater.emit('update-downloaded', { version: '1.1.0' })
    expect(of(IPC.appUpdateDownloaded)).toHaveLength(1)
    expect(ipcHandle[IPC.appGetStagedUpdate]?.()).toEqual({ version: '1.1.0', notes: '- one' })
  })
})
