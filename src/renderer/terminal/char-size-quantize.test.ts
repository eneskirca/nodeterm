import { describe, expect, it } from 'vitest'
import type { Terminal } from '@xterm/xterm'
import { quantizeCharSize } from './char-size-quantize'

/**
 * The wrap targets xterm's CharSizeService internals, so the harness is a structural fake of
 * exactly the fields the helper reaches for — the same seam the guarded-internals style
 * (`restoreDomRenderer`) tests against. What matters behaviourally:
 *  - measurements land on the device-pixel grid (this is the whole renderer-parity fix);
 *  - the grid cell is never NARROWER than the measured glyph (issue: a DPR 1 display rounded
 *    Menlo 13's 7.81px down to 7.0, so every glyph overhung its cell and the last column was cut);
 *  - the service is re-measured once at install so the live renderer picks the quantized width;
 *  - a second install is a no-op (mount/adopt call it repeatedly);
 *  - any missing internal fails open with `false` and leaves the strategy untouched.
 */
function fakeTerm(rawWidth: number, dpr?: number) {
  const calls = { strategyMeasures: 0, serviceMeasures: 0 }
  const strategy = {
    measure() {
      calls.strategyMeasures++
      return { width: rawWidth, height: 17 }
    }
  }
  const svc = {
    width: 0,
    height: 0,
    _measureStrategy: strategy,
    measure() {
      calls.serviceMeasures++
      const r = this._measureStrategy.measure()
      this.width = r.width
      this.height = r.height
    }
  }
  const term = {
    _core: { _charSizeService: svc, _coreBrowserService: dpr === undefined ? undefined : { dpr } }
  } as unknown as Terminal
  return { term, svc, strategy, calls }
}

describe('quantizeCharSize', () => {
  it('quantizes the measured width to the device-pixel grid (the WebGL floor loses nothing)', () => {
    const { term, svc } = fakeTerm(8.43, 2)
    expect(quantizeCharSize(term)).toBe(true)
    // ceil(8.43 × 2) / 2 = 8.5 — already on the grid, so the WebGL renderer's floor keeps it.
    expect(svc.width).toBe(8.5)
    expect(Math.floor(svc.width * 2) / 2).toBe(svc.width)
    expect(svc.height).toBe(17) // height untouched
  })

  it('never makes a cell narrower than its glyph — Menlo 13 at DPR 1 gets 8px, not 7px', () => {
    // MEASURED on a 5120x1440 DPR 1 display: the char-measure element reports 7.8125px for
    // Menlo 13. Rounding down to 7.0 made the DOM renderer pin every glyph with
    // letter-spacing -0.8125px, and the last column's glyph ran past the screen and was cut.
    const { term, svc } = fakeTerm(7.8125, 1)
    quantizeCharSize(term)
    expect(svc.width).toBe(8)
  })

  it('keeps every width on the device grid, at least as wide as measured, and under one device pixel wider', () => {
    for (const dpr of [1, 1.25, 1.5, 2, 3]) {
      for (let raw = 5; raw < 12; raw += 0.0625) {
        const { term, svc } = fakeTerm(raw, dpr)
        quantizeCharSize(term)
        const device = svc.width * dpr
        expect(Math.abs(device - Math.round(device))).toBeLessThan(1e-9)
        expect(svc.width).toBeGreaterThanOrEqual(raw - 1e-3 / dpr)
        expect(svc.width - raw).toBeLessThan(1 / dpr)
      }
    }
  })

  it('does not round a width that is on the grid up by a whole pixel because of float noise', () => {
    const { term, svc } = fakeTerm(7.000000000001, 1)
    quantizeCharSize(term)
    expect(svc.width).toBe(7)
  })

  it('re-measures the service once at install, so a live renderer sees the quantized width', () => {
    const { term, calls } = fakeTerm(8.43, 2)
    quantizeCharSize(term)
    expect(calls.serviceMeasures).toBe(1)
  })

  it('is idempotent — a second install neither re-wraps nor re-measures', () => {
    const { term, svc, calls } = fakeTerm(8.43, 2)
    quantizeCharSize(term)
    expect(quantizeCharSize(term)).toBe(true)
    expect(calls.serviceMeasures).toBe(1)
    svc.measure()
    // Still quantized exactly once (a double wrap would round an already-rounded value — same
    // number, but the measure-call count would betray the second wrapper).
    expect(svc.width).toBe(8.5)
    expect(calls.strategyMeasures).toBe(2)
  })

  it('falls back to the window dpr when the core browser service is absent', () => {
    const { term, svc } = fakeTerm(8.43, undefined)
    quantizeCharSize(term, { devicePixelRatio: 2 })
    expect(svc.width).toBe(8.5)
  })

  it('reads the dpr live at each measure, not once at install', () => {
    const dprBox = { dpr: 2 }
    const { term, svc } = fakeTerm(8.43)
    ;(term as unknown as { _core: { _coreBrowserService: { dpr: number } } })._core._coreBrowserService = dprBox
    quantizeCharSize(term)
    expect(svc.width).toBe(8.5) // ceil(16.86)/2
    dprBox.dpr = 1
    svc.measure()
    expect(svc.width).toBe(9) // ceil(8.43)/1 — re-quantized on the new grid
  })

  it('passes a zero measurement through (an element that is not rendered yet)', () => {
    const { term, svc } = fakeTerm(0, 1)
    quantizeCharSize(term)
    expect(svc.width).toBe(0)
  })

  it('fails open (returns false, touches nothing) when the internals are missing', () => {
    expect(quantizeCharSize({} as Terminal)).toBe(false)
    expect(
      quantizeCharSize({ _core: { _charSizeService: {} } } as unknown as Terminal)
    ).toBe(false)
  })
})
