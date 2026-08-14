import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

/**
 * Guard for a runtime-only version coupling that bit for real: `@xterm/addon-webgl` reaches
 * into `@xterm/xterm`'s INTERNALS, so the pair compiles cleanly at any version skew and only
 * fails in the field. 0.19.0's dispose guard reads `_core._store._isDisposed` — a field the
 * 5.6+ core has and the 5.5 core does not — so on xterm 5.5.0 EVERY `WebglAddon.dispose()`
 * threw before its own put-xterm-back-on-a-DOM-renderer disposable ran. Every budget release
 * (zoom gate, LRU reclaim, hidden-release delay, memory pressure) then left that terminal with
 * no renderer at all: zero canvases, zero `.xterm-rows`, a permanently black node. Field
 * signature: zoom-out across the 40% gate blacked out every visible terminal at once.
 *
 * The dependabot config ignores `@xterm/*` for the same reason (a grouped minor bump is what
 * shipped 0.19.0). This test is the in-repo half of that guard: it pins the exact pair, so a
 * bump that slips past dependabot — or a hand edit that moves one half — fails the suite with
 * this story attached. Upgrading is fine, deliberately, and as a FAMILY: verify the release
 * path end-to-end (zoom a busy canvas across the 40%/45% band, terminals must fall back to
 * readable DOM rows, not black), then update both sides of this expectation together.
 */
describe('@xterm/addon-webgl ↔ @xterm/xterm version pair', () => {
  it('stays on the exact pair the release path was verified against', () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.resolve(__dirname, '../../../package.json'), 'utf8')
    ) as { devDependencies: Record<string, string> }
    expect(pkg.devDependencies['@xterm/addon-webgl']).toBe('0.18.0')
    expect(pkg.devDependencies['@xterm/xterm']).toBe('^5.5.0')
  })

  it('the installed addon has no dispose-time core-internals guard the 5.5 core cannot satisfy', () => {
    // The exact expression that crashed: a dispose-path read of `_core._store`. 0.18.0 does not
    // contain it; if a future addon build does, the core must be new enough to carry the field —
    // re-verify the release path before loosening this.
    const src = fs.readFileSync(
      path.resolve(__dirname, '../../../node_modules/@xterm/addon-webgl/lib/addon-webgl.js'),
      'utf8'
    )
    expect(src.includes('_store._isDisposed')).toBe(false)
  })
})
