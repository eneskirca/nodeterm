import { describe, expect, it } from 'vitest'
import type { Terminal } from '@xterm/xterm'
import { quantizeCharSize } from './char-size-quantize'

/**
 * The wrap targets xterm's CharSizeService internals, so the harness is a structural fake of
 * exactly the fields the helper reaches for — the same seam the guarded-internals style
 * (`restoreDomRenderer`) tests against. What matters behaviourally:
 *  - measurements land on the device-pixel grid (this is the whole renderer-parity fix);
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
    // floor(8.43 × 2) / 2 = 8.0 — exactly what the WebGL renderer's floor lands on.
    expect(svc.width).toBe(8)
    expect(svc.height).toBe(17) // height untouched
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
    // Still quantized exactly once (a double wrap would floor an already-floored value — same
    // number, but the measure-call count would betray the second wrapper).
    expect(svc.width).toBe(8)
    expect(calls.strategyMeasures).toBe(2)
  })

  it('falls back to the window dpr when the core browser service is absent', () => {
    const { term, svc } = fakeTerm(8.43, undefined)
    quantizeCharSize(term, { devicePixelRatio: 2 })
    expect(svc.width).toBe(8)
  })

  it('reads the dpr live at each measure, not once at install', () => {
    const dprBox = { dpr: 2 }
    const { term, svc } = fakeTerm(8.43)
    ;(term as unknown as { _core: { _coreBrowserService: { dpr: number } } })._core._coreBrowserService = dprBox
    quantizeCharSize(term)
    expect(svc.width).toBe(8) // floor(16.86)/2
    dprBox.dpr = 1
    svc.measure()
    expect(svc.width).toBe(8) // floor(8.43)/1 — re-quantized on the new grid
  })

  it('keeps the raw measurement when quantizing would zero the width', () => {
    const { term, svc } = fakeTerm(0.4, 1)
    quantizeCharSize(term)
    expect(svc.width).toBe(0.4)
  })

  it('fails open (returns false, touches nothing) when the internals are missing', () => {
    expect(quantizeCharSize({} as Terminal)).toBe(false)
    expect(
      quantizeCharSize({ _core: { _charSizeService: {} } } as unknown as Terminal)
    ).toBe(false)
  })
})
