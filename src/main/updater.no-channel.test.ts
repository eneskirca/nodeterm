// Issue #814: a Windows install's "check for updates" answered "you are up to date" on a build
// that has no update channel at all — no feed, no release job, `nodeTermUpdates=disabled`. The
// pure decision is pinned in `src/shared/update-platform.test.ts`; this pins the WIRING, because
// the defect lived there: the disabled branch of `initUpdater` wired exactly one behaviour, and
// that behaviour was the false sentence.
//
// It also pins the paths that must NOT move: dev stays quiet, macOS still self-installs, and a
// Linux .deb still degrades to the manual-download card.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import { IPC } from '../shared/ipc'

const { ipcOn, ipcHandle, sent, appMock } = vi.hoisted(() => ({
  ipcOn: {} as Record<string, (...a: unknown[]) => void>,
  ipcHandle: {} as Record<string, (...a: unknown[]) => unknown>,
  sent: [] as Array<{ channel: string; payload?: unknown }>,
  appMock: { isPackaged: true, appPath: '', getVersion: () => '0.3.7' }
}))

vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return appMock.isPackaged
    },
    getAppPath: () => appMock.appPath,
    getVersion: () => appMock.getVersion()
  },
  ipcMain: {
    on: (ch: string, fn: (...a: unknown[]) => void) => {
      ipcOn[ch] = fn
    },
    handle: (ch: string, fn: (...a: unknown[]) => unknown) => {
      ipcHandle[ch] = fn
    }
  },
  Notification: Object.assign(function () {}, { isSupported: () => false }),
  // Electron's own (Squirrel) autoUpdater — only wired on darwin; the restart flow is pinned in
  // updater.restart.test.ts.
  autoUpdater: { on: () => {} }
}))

// `vi.mock` factories are hoisted above every const, so the double the factory returns has to be
// hoisted with them.
const { updaterEvents, autoUpdater } = vi.hoisted(() => {
  const events: Record<string, (...a: unknown[]) => void> = {}
  return {
    updaterEvents: events,
    autoUpdater: {
      autoDownload: true,
      autoInstallOnAppQuit: true,
      checkForUpdates: vi.fn(() => Promise.resolve(null)),
      downloadUpdate: vi.fn(() => Promise.resolve([])),
      quitAndInstall: vi.fn(),
      on: (ev: string, fn: (...a: unknown[]) => void) => {
        events[ev] = fn
      }
    }
  }
})
vi.mock('electron-updater', () => ({ autoUpdater }))
vi.mock('./main-window', () => ({
  getMainWindow: () => null,
  sendToMain: (channel: string, payload?: unknown) => sent.push({ channel, payload })
}))
vi.mock('./notifications', () => ({ retainUntilDismissed: () => {} }))

import { describeCheckFailure, initUpdater, lastUpdateCheck } from './updater'

const realReadFileSync = fs.readFileSync

/**
 * Answer the packaged package.json `initUpdater` reads its marker out of — in memory, because
 * what is under test is which marker produces which wiring, not fs. `undefined` is a normal
 * release (no marker); `null` makes the read throw, i.e. an unreadable package.
 */
function packageWith(marker: string | null | undefined): void {
  appMock.appPath = path.join(path.sep, 'fake-app-path')
  const target = path.join(appMock.appPath, 'package.json')
  vi.spyOn(fs, 'readFileSync').mockImplementation(((file: unknown, ...rest: unknown[]) => {
    if (file !== target) return realReadFileSync(file as never, ...(rest as []))
    if (marker === null) throw new Error('ENOENT: no such file or directory')
    return JSON.stringify(marker === undefined ? { name: 'x' } : { name: 'x', nodeTermUpdates: marker })
  }) as typeof fs.readFileSync)
}

function setPlatform(platform: string): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
}

const realPlatform = process.platform
const realAppImage = process.env.APPIMAGE

beforeEach(() => {
  vi.useFakeTimers()
  for (const k of Object.keys(ipcOn)) delete ipcOn[k]
  for (const k of Object.keys(ipcHandle)) delete ipcHandle[k]
  for (const k of Object.keys(updaterEvents)) delete updaterEvents[k]
  sent.length = 0
  autoUpdater.checkForUpdates.mockClear()
  autoUpdater.quitAndInstall.mockClear()
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  appMock.isPackaged = true
  delete process.env.APPIMAGE
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  setPlatform(realPlatform)
  if (realAppImage === undefined) delete process.env.APPIMAGE
  else process.env.APPIMAGE = realAppImage
})

const check = (): void => ipcOn[IPC.appCheckForUpdates]?.()
const channels = (): string[] => sent.map((s) => s.channel)

describe('a packaged build with no update channel', () => {
  beforeEach(() => {
    setPlatform('win32')
    packageWith('disabled')
    initUpdater()
  })

  it('does NOT answer a manual check with "up to date"', () => {
    check()
    expect(channels()).not.toContain(IPC.appUpdateNotAvailable)
  })

  it('says it has no channel instead', () => {
    check()
    expect(channels()).toEqual([IPC.appUpdateNoChannel])
  })

  it('still touches no network — the card is the whole behaviour change', () => {
    check()
    expect(autoUpdater.checkForUpdates).not.toHaveBeenCalled()
    vi.advanceTimersByTime(7 * 60 * 60 * 1000)
    expect(autoUpdater.checkForUpdates).not.toHaveBeenCalled()
  })

  it('reports the same on every platform — the marker decides, not the OS', () => {
    for (const platform of ['darwin', 'linux', 'win32']) {
      sent.length = 0
      setPlatform(platform)
      packageWith('disabled')
      initUpdater()
      check()
      expect(channels()).toEqual([IPC.appUpdateNoChannel])
    }
  })
})

describe('the paths that must not move', () => {
  it('dev (unpackaged) stays quiet: a manual check still answers "up to date"', () => {
    appMock.isPackaged = false
    packageWith(undefined)
    initUpdater()
    check()
    expect(channels()).toEqual([IPC.appUpdateNotAvailable])
    expect(autoUpdater.checkForUpdates).not.toHaveBeenCalled()
  })

  it('macOS release: self-installs and checks the feed, as before', () => {
    setPlatform('darwin')
    packageWith(undefined)
    initUpdater()
    expect(autoUpdater.autoDownload).toBe(true)
    expect(autoUpdater.autoInstallOnAppQuit).toBe(true)
    expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1)
    check()
    expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(2)
    expect(channels()).not.toContain(IPC.appUpdateNoChannel)
    updaterEvents['update-available']?.({ version: '9.9.9', releaseNotes: 'n' })
    expect(sent.at(-1)).toEqual({
      channel: IPC.appUpdateAvailable,
      payload: { version: '9.9.9', notes: 'n', manual: false }
    })
  })

  it('Linux .deb: still the manual-download card, never the no-channel one', () => {
    setPlatform('linux')
    packageWith(undefined)
    initUpdater()
    expect(autoUpdater.autoDownload).toBe(false)
    expect(autoUpdater.autoInstallOnAppQuit).toBe(false)
    updaterEvents['update-available']?.({ version: '9.9.9' })
    expect(sent.at(-1)).toEqual({
      channel: IPC.appUpdateAvailable,
      payload: { version: '9.9.9', notes: '', manual: true }
    })
    expect(channels()).not.toContain(IPC.appUpdateNoChannel)
  })

  it('Linux AppImage: still self-installs', () => {
    setPlatform('linux')
    process.env.APPIMAGE = '/tmp/nodeterm.AppImage'
    packageWith(undefined)
    initUpdater()
    expect(autoUpdater.autoDownload).toBe(true)
    updaterEvents['update-available']?.({ version: '9.9.9' })
    expect(sent.at(-1)).toEqual({
      channel: IPC.appUpdateAvailable,
      payload: { version: '9.9.9', notes: '', manual: false }
    })
  })

  it('an unreadable packaged package.json still behaves like a release', () => {
    setPlatform('darwin')
    packageWith(null)
    initUpdater()
    expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1)
  })
})

const restart = (): void => ipcOn[IPC.appRestartToUpdate]?.()

/**
 * The unsigned Windows beta (`dist:win:release` → `nodeTermUpdates=manual`): it must LEARN that a
 * new version is out — a passive "available, download it" card — and must never download or
 * install it, because an unsigned auto-update is a downgrade in trust.
 */
describe('the unsigned Windows beta (manual marker)', () => {
  const onBeforeRestart = vi.fn()

  beforeEach(() => {
    onBeforeRestart.mockClear()
    setPlatform('win32')
    packageWith('manual')
    initUpdater({ onBeforeRestart })
  })

  it('checks the feed on launch and every six hours', () => {
    expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(6 * 60 * 60 * 1000)
    expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(2)
  })

  it('never downloads and never installs on quit', () => {
    expect(autoUpdater.autoDownload).toBe(false)
    expect(autoUpdater.autoInstallOnAppQuit).toBe(false)
  })

  it('surfaces a found version as the manual Download card, not "no channel"', () => {
    updaterEvents['update-available']?.({ version: '9.9.9' })
    expect(sent.at(-1)).toEqual({
      channel: IPC.appUpdateAvailable,
      payload: { version: '9.9.9', notes: '', manual: true }
    })
    check()
    expect(channels()).not.toContain(IPC.appUpdateNoChannel)
  })

  it('an automatic check failure stays silent; a user-initiated one still reports', async () => {
    // electron-updater emits 'error' for the silent launch check too (offline, or a feed mirror
    // that does not serve latest.yml yet) — that must not put an error card up on every launch.
    updaterEvents['error']?.(new Error('HttpError: 404 latest.yml'))
    expect(channels()).not.toContain(IPC.appUpdateError)
    // electron-updater emits 'error' for the rejected manual check too; that listener is the one
    // owner of the report (the catch only logs), so exactly one card comes up.
    autoUpdater.checkForUpdates.mockImplementationOnce(() => {
      updaterEvents['error']?.(new Error('offline'))
      return Promise.reject(new Error('offline'))
    })
    check()
    await Promise.resolve()
    await Promise.resolve()
    expect(channels().filter((c) => c === IPC.appUpdateError)).toHaveLength(1)
  })

  it('a silent check failure is recorded and logged as an actionable warning, not dropped', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    updaterEvents['error']?.(new Error('HttpError: 404 "method: GET url: https://nodeterm.dev/updates/latest.yml"'))
    expect(channels()).not.toContain(IPC.appUpdateError)
    expect(lastUpdateCheck()).toMatchObject({ ok: false, message: expect.stringContaining('404') })
    expect(warn).toHaveBeenCalledWith('[updater]', expect.stringMatching(/update feed is missing/))
    updaterEvents['update-not-available']?.()
    expect(lastUpdateCheck()).toMatchObject({ ok: true })
  })

  it('refuses restart-to-update in main: quitAndInstall never runs', () => {
    restart()
    expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled()
    // Nor is the app flagged as quitting for a quit that will never come.
    expect(onBeforeRestart).not.toHaveBeenCalled()
  })
})

describe('restart-to-update elsewhere', () => {
  it('a self-installing release still restarts into a downloaded update', async () => {
    // (macOS's wait for Squirrel.Mac is pinned in updater.restart.test.ts; AppImage installs from
    // the downloaded file, so it is the immediate case.)
    const onBeforeRestart = vi.fn()
    setPlatform('linux')
    process.env.APPIMAGE = '/tmp/nodeterm.AppImage'
    packageWith(undefined)
    initUpdater({ onBeforeRestart, flushRenderer: () => Promise.resolve() })
    updaterEvents['update-downloaded']?.({ version: '9.9.9' })
    restart()
    await vi.waitFor(() => expect(autoUpdater.quitAndInstall).toHaveBeenCalledTimes(1))
    expect(onBeforeRestart).toHaveBeenCalledTimes(1)
  })

  it('a Linux .deb: a BACKGROUND check failure is logged, not carded; a user check still reports', () => {
    setPlatform('linux')
    packageWith(undefined)
    initUpdater()
    updaterEvents['error']?.(new Error('boom'))
    expect(channels()).not.toContain(IPC.appUpdateError)
    check()
    updaterEvents['error']?.(new Error('boom'))
    expect(sent.filter((s) => s.channel === IPC.appUpdateError)).toEqual([
      { channel: IPC.appUpdateError, payload: 'boom' }
    ])
  })

  it('a Linux .deb (manual-install) refuses it too', () => {
    setPlatform('linux')
    packageWith(undefined)
    initUpdater()
    restart()
    expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled()
  })

  it('a no-channel build refuses it — it has nothing to install', () => {
    setPlatform('win32')
    packageWith('disabled')
    initUpdater()
    restart()
    expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled()
  })
})

describe('describeCheckFailure', () => {
  it('names a 404 on a latest*.yml as a missing feed file', () => {
    expect(describeCheckFailure('HttpError: 404 Not Found ... latest.yml')).toMatch(/feed is missing/)
    expect(describeCheckFailure('Cannot find latest-linux.yml (404)')).toMatch(/feed is missing/)
  })
  it('anything else is a plain check failure', () => {
    expect(describeCheckFailure('net::ERR_INTERNET_DISCONNECTED')).toBe(
      'update check failed: net::ERR_INTERNET_DISCONNECTED'
    )
    expect(describeCheckFailure('HttpError: 500 latest.yml')).toMatch(/^update check failed/)
  })
})
