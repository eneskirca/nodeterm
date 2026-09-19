import { describe, expect, it } from 'vitest'
import fs from 'fs'
import path from 'path'
import {
  isManualUpdatePlatform,
  noSelfInstallCopy,
  shouldEnableUpdater,
  toUpdateAvailablePayload,
  updateDelivery
} from './update-platform'

describe('isManualUpdatePlatform', () => {
  it('linux with APPIMAGE set → auto (self-installs)', () => {
    expect(isManualUpdatePlatform('linux', true)).toBe(false)
  })

  it('linux without APPIMAGE → manual (.deb/.rpm)', () => {
    expect(isManualUpdatePlatform('linux', false)).toBe(true)
  })

  it('darwin → auto regardless of APPIMAGE', () => {
    expect(isManualUpdatePlatform('darwin', false)).toBe(false)
    expect(isManualUpdatePlatform('darwin', true)).toBe(false)
  })

  it('win32 → auto', () => {
    expect(isManualUpdatePlatform('win32', false)).toBe(false)
  })
})

describe('shouldEnableUpdater', () => {
  it('disables checks in development and in explicitly local packaged builds', () => {
    expect(shouldEnableUpdater(false, undefined)).toBe(false)
    expect(shouldEnableUpdater(true, 'disabled')).toBe(false)
  })

  it('keeps updater behavior unchanged for normal packaged releases', () => {
    expect(shouldEnableUpdater(true, undefined)).toBe(true)
    expect(shouldEnableUpdater(true, 'enabled')).toBe(true)
  })
})

/**
 * `shouldEnableUpdater` is only half the fix — it reads a marker the BUILD has to set. A `dist*`
 * script that forgets it produces a package indistinguishable from a release (`app.isPackaged` is
 * true for both), which then polls the production feed for a version nobody published and logs a
 * 404 on `latest*.yml` every six hours. That is a build-config mistake no unit test of the pure
 * function can catch, so assert it against the real package.json — the same guard-test shape as
 * `src/core/no-electron.test.ts`.
 */
describe('local dist scripts opt out of the production update feed', () => {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')
  ) as { scripts: Record<string, string> }
  const MARKER = '-c.extraMetadata.nodeTermUpdates=disabled'

  it('every dist script carries the marker — not just the one whose 404 was noticed', () => {
    const dist = Object.keys(pkg.scripts).filter((s) => s === 'dist' || s.startsWith('dist:'))
    expect(dist.length).toBeGreaterThanOrEqual(2) // dist, dist:linux
    expect(dist.filter((s) => !pkg.scripts[s].includes(MARKER))).toEqual([])
  })

  it('release does NOT carry it — a promoted build must keep updating itself', () => {
    expect(pkg.scripts.release).not.toContain(MARKER)
  })
})

describe('toUpdateAvailablePayload', () => {
  it('carries version + string release notes + manual flag', () => {
    expect(toUpdateAvailablePayload({ version: '1.2.0', releaseNotes: 'fixes' }, true)).toEqual({
      version: '1.2.0',
      notes: 'fixes',
      manual: true
    })
  })

  it('coerces non-string / missing release notes to empty string', () => {
    expect(toUpdateAvailablePayload({ version: '1.2.0' }, false)).toEqual({
      version: '1.2.0',
      notes: '',
      manual: false
    })
    expect(
      toUpdateAvailablePayload({ version: '1.2.0', releaseNotes: [{ note: 'x' }] }, false).notes
    ).toBe('')
  })
})


/**
 * Issue #814: a Windows build carries `nodeTermUpdates=disabled` (no signed release job, no
 * `latest.yml`), so the updater never wires a feed — and the one thing that branch DID wire was a
 * manual check answering "up to date". These pin the three delivery paths apart, and pin that the
 * macOS and Linux release paths are untouched by the new one.
 */
describe('updateDelivery', () => {
  const pkgd = { isPackaged: true, updateMode: undefined as unknown, hasAppImage: false }

  it('a packaged build with updates switched off has NO CHANNEL — it is not up to date', () => {
    expect(updateDelivery({ ...pkgd, updateMode: 'disabled', platform: 'win32' })).toBe('no-channel')
  })

  it('decides no-channel from the build marker, never from the platform name', () => {
    // The same marker on every platform: `dist`, `dist:linux` and `dist:win` all set it, and the
    // day a Windows RELEASE ships with a feed it carries no marker and takes the ordinary path
    // below with nothing to edit here.
    for (const platform of ['win32', 'darwin', 'linux']) {
      expect(updateDelivery({ ...pkgd, updateMode: 'disabled', platform })).toBe('no-channel')
    }
  })

  it('a future signed Windows release self-installs, by carrying no marker', () => {
    expect(updateDelivery({ ...pkgd, platform: 'win32' })).toBe('self-install')
  })

  it('macOS is unchanged: a release self-installs', () => {
    expect(updateDelivery({ ...pkgd, platform: 'darwin' })).toBe('self-install')
    expect(updateDelivery({ ...pkgd, platform: 'darwin', hasAppImage: true })).toBe('self-install')
  })

  it('Linux is unchanged: .deb/.rpm stays manual, AppImage stays self-installing', () => {
    expect(updateDelivery({ ...pkgd, platform: 'linux' })).toBe('manual-install')
    expect(updateDelivery({ ...pkgd, platform: 'linux', hasAppImage: true })).toBe('self-install')
  })

  it('dev stays its own state — quiet, not a no-channel card in every `npm run dev`', () => {
    for (const platform of ['win32', 'darwin', 'linux']) {
      expect(updateDelivery({ isPackaged: false, updateMode: undefined, platform, hasAppImage: false })).toBe('dev')
      // Even with the marker a dist build would carry, an unpackaged run is dev first.
      expect(updateDelivery({ isPackaged: false, updateMode: 'disabled', platform, hasAppImage: false })).toBe('dev')
    }
  })

  it('stays composed from the two primitives — no second definition to drift', () => {
    for (const platform of ['win32', 'darwin', 'linux']) {
      for (const hasAppImage of [false, true]) {
        for (const updateMode of [undefined, 'enabled', 'disabled']) {
          const d = updateDelivery({ isPackaged: true, updateMode, platform, hasAppImage })
          expect(d === 'no-channel').toBe(!shouldEnableUpdater(true, updateMode))
          if (d !== 'no-channel') {
            expect(d === 'manual-install').toBe(isManualUpdatePlatform(platform, hasAppImage))
          }
        }
      }
    }
  })
})

describe('noSelfInstallCopy', () => {
  const manual = noSelfInstallCopy('manual-install', '0.3.8')
  const none = noSelfInstallCopy('no-channel')

  it('the Linux .deb sentence is byte-identical to the one that shipped', () => {
    expect(manual).toEqual({
      title: 'Update available',
      body: 'nodeterm v0.3.8 is available. Download it to update.',
      action: 'Download'
    })
  })

  it('the no-channel card names the reason and the remedy, and claims no version', () => {
    expect(none.title).toBe('No update channel')
    expect(none.body).toBe(
      'This build has no update channel, so it cannot tell you when a new version is out. ' +
        'Download the latest installer to update.'
    )
    expect(none.action).toBe('Open download page')
  })

  it('never says "up to date", and never promises a self-install', () => {
    const words = `${none.title} ${none.body} ${none.action}`.toLowerCase()
    expect(words).not.toContain('up to date')
    expect(words).not.toContain('latest version')
    expect(words).not.toContain('restart')
    expect(words).not.toContain('install itself')
  })

  it('the two reasons never collapse into one sentence — the remedies differ', () => {
    expect(none.title).not.toBe(manual.title)
    expect(none.body).not.toBe(manual.body)
    // `manual` knows which version is out; `no-channel` structurally cannot.
    expect(manual.body).toContain('0.3.8')
    expect(none.body).not.toMatch(/\bv?\d+\.\d+/)
  })

  it('names no platform — the state decides the copy, not an OS typed into a string', () => {
    for (const copy of [manual, none]) {
      const words = `${copy.title} ${copy.body} ${copy.action}`.toLowerCase()
      for (const os of ['windows', 'win32', 'macos', 'linux', 'deb', 'rpm']) {
        expect(words).not.toContain(os)
      }
    }
  })
})
