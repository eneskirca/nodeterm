import { describe, expect, it } from 'vitest'
import { CANVAS_MAX_ZOOM, CANVAS_MIN_ZOOM } from '../canvas/zoom-limits'
import { ZOOM_PRESETS, activeZoomPreset, isOfferableZoomPct, zoomFromPct } from './zoomPresets'

describe('zoom presets', () => {
  it('offers 100% — the whole point of the menu', () => {
    expect(ZOOM_PRESETS).toContain(100)
  })

  it('never offers a zoom React Flow would silently clamp', () => {
    // A row that lands somewhere other than its own label is worse than no row at all.
    for (const pct of ZOOM_PRESETS) {
      expect(isOfferableZoomPct(pct)).toBe(true)
      expect(zoomFromPct(pct)).toBeGreaterThanOrEqual(CANVAS_MIN_ZOOM)
      expect(zoomFromPct(pct)).toBeLessThanOrEqual(CANVAS_MAX_ZOOM)
    }
  })

  it('is ordered, so the menu reads as a scale', () => {
    expect([...ZOOM_PRESETS]).toEqual([...ZOOM_PRESETS].sort((a, b) => a - b))
  })
})

describe('activeZoomPreset', () => {
  it('ticks the preset the readout is showing', () => {
    expect(activeZoomPreset(100)).toBe(100)
    expect(activeZoomPreset(50)).toBe(50)
  })

  it('ticks on the ROUNDED percentage the dock displays, not the raw zoom', () => {
    // At 99.6% the dock already says "100%"; ticking nothing there reads as a broken menu.
    expect(activeZoomPreset(99.6)).toBe(100)
    expect(activeZoomPreset(100.4)).toBe(100)
  })

  it('ticks nothing between two presets', () => {
    expect(activeZoomPreset(112)).toBeNull()
    expect(activeZoomPreset(3)).toBeNull()
  })
})
