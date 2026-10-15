import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import os from 'os'
import { join } from 'path'
import { claimOnceMarker, resolveBackgroundOnClose, shouldShowBackgroundHint } from './background-mode'

describe('resolveBackgroundOnClose', () => {
  it("'auto' is on for Windows and off for Linux", () => {
    expect(resolveBackgroundOnClose('auto', 'win32')).toBe(true)
    expect(resolveBackgroundOnClose('auto', 'linux')).toBe(false)
  })
  it('honors an explicit on/off on Windows and Linux', () => {
    for (const p of ['win32', 'linux']) {
      expect(resolveBackgroundOnClose('on', p)).toBe(true)
      expect(resolveBackgroundOnClose('off', p)).toBe(false)
    }
  })
  it('is always false on macOS (it hides on close anyway; no tray)', () => {
    for (const v of ['auto', 'on', 'off']) expect(resolveBackgroundOnClose(v, 'darwin')).toBe(false)
  })
  it("reads an unknown value as 'auto'", () => {
    expect(resolveBackgroundOnClose('tray', 'win32')).toBe(true)
    expect(resolveBackgroundOnClose(undefined, 'linux')).toBe(false)
    expect(resolveBackgroundOnClose(true, 'linux')).toBe(false)
  })
})

describe('shouldShowBackgroundHint', () => {
  it('shows once, only for a background-mode hide off macOS', () => {
    expect(shouldShowBackgroundHint({ platform: 'win32', backgroundOnClose: true, alreadyShown: false })).toBe(true)
    expect(shouldShowBackgroundHint({ platform: 'win32', backgroundOnClose: true, alreadyShown: true })).toBe(false)
    expect(shouldShowBackgroundHint({ platform: 'win32', backgroundOnClose: false, alreadyShown: false })).toBe(false)
    expect(shouldShowBackgroundHint({ platform: 'darwin', backgroundOnClose: true, alreadyShown: false })).toBe(false)
  })
})

describe('main/index.ts background-mode wiring (source guard)', () => {
  const src = readFileSync(join(__dirname, 'index.ts'), 'utf-8')
  it('passes the live background flag into closeAction', () => {
    expect(src).toContain('closeAction(process.platform, quitting, win.isFullScreen(), backgroundOnCloseActive())')
  })
  it('tears the tray down in before-quit, right after the quitting flag flips', () => {
    expect(src).toMatch(/quitting = true \/\/ from here on[^\n]*\n\s*destroyNotchHud\(\)\n\s*backgroundTray\?\.destroy\(\)/)
  })
  it('keeps the updater restart flipping `quitting` so a hidden window really closes', () => {
    expect(src).toMatch(/initUpdater\(\{\s*onBeforeRestart: \(\) => \{\s*quitting = true/)
  })
  it('tray Quit goes through app.quit() (before-quit + confirm), not app.exit()', () => {
    // ('restart-update' is the updater's own guarded restart; every other action is Quit.)
    expect(src).toMatch(
      /onAction: \(action\) =>\s*action === 'open'\s*\? showMainWindowFromBackground\(\)\s*: action === 'restart-update'\s*\? updater\?\.restartToUpdate\(\)\s*: app\.quit\(\)/
    )
  })
})

describe('claimOnceMarker (exclusive create — no exists-then-write race)', () => {
  it('claims once, then reports already; the first content is kept', () => {
    const dir = mkdtempSync(join(os.tmpdir(), 'nt-bg-marker-'))
    try {
      const f = join(dir, 'marker')
      expect(claimOnceMarker(f, 'first')).toBe('claimed')
      expect(claimOnceMarker(f, 'second')).toBe('already')
      expect(readFileSync(f, 'utf8')).toBe('first')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
  it('reports failed (not already) when the marker cannot be written', () => {
    const dir = mkdtempSync(join(os.tmpdir(), 'nt-bg-marker-'))
    try {
      expect(claimOnceMarker(join(dir, 'missing-dir', 'marker'), 'x')).toBe('failed')
      // A directory squatting on the name is an existing entry: the notice is not repeated.
      mkdirSync(join(dir, 'squat'))
      expect(claimOnceMarker(join(dir, 'squat'), 'x')).toBe('already')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
