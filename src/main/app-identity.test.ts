import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { APP_USER_MODEL_ID, appUserModelIdFor, notificationSettingsTarget } from './app-identity'

const repo = join(__dirname, '../..')

describe('APP_USER_MODEL_ID', () => {
  it('equals package.json build.appId — the id the NSIS installer stamps on the shortcut', () => {
    const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf-8'))
    expect(APP_USER_MODEL_ID).toBe(pkg.build.appId)
  })
})

describe('appUserModelIdFor', () => {
  it('uses the build appId for a packaged Windows app', () => {
    expect(appUserModelIdFor({ platform: 'win32', isPackaged: true, execPath: 'C:\\x\\nodeterm.exe' })).toBe(
      APP_USER_MODEL_ID
    )
  })
  it('uses execPath in a Windows dev run (no shortcut carries the build id there)', () => {
    expect(appUserModelIdFor({ platform: 'win32', isPackaged: false, execPath: 'C:\\dev\\electron.exe' })).toBe(
      'C:\\dev\\electron.exe'
    )
  })
  it('sets nothing on macOS or Linux', () => {
    for (const platform of ['darwin', 'linux']) {
      expect(appUserModelIdFor({ platform, isPackaged: true, execPath: '/x' })).toBeNull()
    }
  })
})

describe('notificationSettingsTarget', () => {
  it('keeps the macOS deep link byte-identical', () => {
    expect(notificationSettingsTarget('darwin')).toBe(
      'x-apple.systempreferences:com.apple.Notifications-Settings.extension'
    )
  })
  it('opens Windows Settings → Notifications', () => {
    expect(notificationSettingsTarget('win32')).toBe('ms-settings:notifications')
  })
  it('has nothing to open on Linux', () => {
    expect(notificationSettingsTarget('linux')).toBeNull()
  })
})

describe('main/index.ts wiring (source guard)', () => {
  const src = readFileSync(join(__dirname, 'index.ts'), 'utf-8')
  it('sets the AppUserModelID before the single-instance lock / ready', () => {
    const set = src.indexOf('app.setAppUserModelId(')
    expect(set).toBeGreaterThan(-1)
    expect(set).toBeLessThan(src.indexOf('app.requestSingleInstanceLock()'))
    expect(set).toBeLessThan(src.indexOf('app.whenReady()'))
  })
  it('routes the notification-settings deep link through notificationSettingsTarget', () => {
    expect(src).toMatch(/IPC\.appOpenNotificationSettings[\s\S]{0,120}notificationSettingsTarget\(process\.platform\)/)
  })
})
