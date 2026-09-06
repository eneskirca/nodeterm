import { describe, expect, it } from 'vitest'
import { viewportAtZoom, viewportAtZoom1 } from './zoomReset'

const CENTRE = { x: 600, y: 400 }

describe('viewportAtZoom1', () => {
  it('lands on zoom 1', () => {
    expect(viewportAtZoom1({ x: -4194.86, y: -1090.16, zoom: 0.976135 }, CENTRE).zoom).toBe(1)
  })

  it('keeps the world point under the screen CENTRE where it was', () => {
    // Anchoring on the origin instead would throw the user's work off screen — the difference
    // between a reset that reads as a correction and one that reads as a jump.
    const before = { x: -4194.86, y: -1090.16, zoom: 0.976135 }
    const worldAt = (v: typeof before, s: { x: number; y: number }) => ({
      x: (s.x - v.x) / v.zoom,
      y: (s.y - v.y) / v.zoom
    })
    const after = viewportAtZoom1(before, CENTRE)
    expect(worldAt(after, CENTRE).x).toBeCloseTo(worldAt(before, CENTRE).x, 6)
    expect(worldAt(after, CENTRE).y).toBeCloseTo(worldAt(before, CENTRE).y, 6)
  })

  it('is a no-op at 1, returning the SAME object so the caller can skip the animation', () => {
    const v = { x: 10, y: 20, zoom: 1 }
    expect(viewportAtZoom1(v, CENTRE)).toBe(v)
  })

  it('refuses a zoom that is not a usable number rather than producing NaN', () => {
    for (const zoom of [0, -1, NaN, Infinity]) {
      const v = { x: 10, y: 20, zoom }
      expect(viewportAtZoom1(v, CENTRE)).toBe(v)
    }
  })

  it('works when zoomed IN as well as out', () => {
    expect(viewportAtZoom1({ x: 100, y: 100, zoom: 2 }, CENTRE).zoom).toBe(1)
  })
})

describe('viewportAtZoom', () => {
  const worldAt = (v: { x: number; y: number; zoom: number }, s: { x: number; y: number }) => ({
    x: (s.x - v.x) / v.zoom,
    y: (s.y - v.y) / v.zoom
  })

  it('lands on the requested zoom, holding the screen CENTRE still', () => {
    const before = { x: -4194.86, y: -1090.16, zoom: 0.976135 }
    const after = viewportAtZoom(before, CENTRE, 0.5)
    expect(after.zoom).toBe(0.5)
    expect(worldAt(after, CENTRE).x).toBeCloseTo(worldAt(before, CENTRE).x, 6)
    expect(worldAt(after, CENTRE).y).toBeCloseTo(worldAt(before, CENTRE).y, 6)
  })

  it('holds the centre when zooming IN too — the direction the *1 wrapper never exercises', () => {
    const before = { x: -300, y: -120, zoom: 0.75 }
    const after = viewportAtZoom(before, CENTRE, 2)
    expect(after.zoom).toBe(2)
    expect(worldAt(after, CENTRE).x).toBeCloseTo(worldAt(before, CENTRE).x, 6)
    expect(worldAt(after, CENTRE).y).toBeCloseTo(worldAt(before, CENTRE).y, 6)
  })

  it('returns the SAME object when already at the target, so the caller skips the animation', () => {
    const v = { x: 10, y: 20, zoom: 0.5 }
    expect(viewportAtZoom(v, CENTRE, 0.5)).toBe(v)
  })

  it('refuses an unusable TARGET rather than producing NaN', () => {
    const v = { x: 10, y: 20, zoom: 0.5 }
    for (const target of [0, -1, NaN, Infinity]) {
      expect(viewportAtZoom(v, CENTRE, target)).toBe(v)
    }
  })
})
