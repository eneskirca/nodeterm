import { describe, expect, it } from 'vitest'
import {
  MIN_CAMERA_ZOOM,
  rectsIntersect,
  sanitizeCamera,
  screenToWorld,
  snapPanToDevicePx,
  visibleWorldRect,
  worldToScreen,
  type Camera
} from './camera'

describe('glyphgrid camera', () => {
  const cam: Camera = { x: 100, y: -50, zoom: 0.5 }

  it('worldToScreen matches the React Flow viewport convention (screen = world*zoom + pan)', () => {
    expect(worldToScreen(0, 0, cam)).toEqual({ x: 100, y: -50 })
    expect(worldToScreen(200, 300, cam)).toEqual({ x: 200, y: 100 })
  })

  it('screenToWorld inverts worldToScreen exactly', () => {
    const s = worldToScreen(123.5, -77.25, cam)
    const w = screenToWorld(s.x, s.y, cam)
    expect(w.x).toBeCloseTo(123.5, 10)
    expect(w.y).toBeCloseTo(-77.25, 10)
  })

  it('visibleWorldRect maps the screen viewport into world space', () => {
    const r = visibleWorldRect(cam, 800, 600)
    expect(r).toEqual({ x: -200, y: 100, w: 1600, h: 1200 })
  })

  it('rectsIntersect: overlapping, touching and disjoint', () => {
    const a = { x: 0, y: 0, w: 10, h: 10 }
    expect(rectsIntersect(a, { x: 5, y: 5, w: 10, h: 10 })).toBe(true)
    expect(rectsIntersect(a, { x: 10, y: 0, w: 5, h: 5 })).toBe(false) // edge-touch = not visible
    expect(rectsIntersect(a, { x: 20, y: 20, w: 1, h: 1 })).toBe(false)
  })
})

describe('snapPanToDevicePx', () => {
  it('rounds the pan to whole device pixels, in CSS units', () => {
    // dpr 2: the CSS-px pan lands on halves, which is where a device pixel actually is.
    expect(snapPanToDevicePx({ x: 10.3, y: -4.4, zoom: 1 }, 2)).toEqual({
      x: 10.5,
      y: -4.5,
      zoom: 1
    })
    expect(snapPanToDevicePx({ x: 10.3, y: -4.4, zoom: 1 }, 1)).toEqual({ x: 10, y: -4, zoom: 1 })
  })

  it('never moves the world by as much as a device pixel', () => {
    for (const dpr of [1, 1.5, 2, 3]) {
      for (const x of [0, 0.1, 12.49, -12.49, 1234.567, -0.5]) {
        const snapped = snapPanToDevicePx({ x, y: x, zoom: 1 }, dpr)
        expect(Math.abs(snapped.x - x) * dpr).toBeLessThanOrEqual(0.5 + 1e-9)
      }
    }
  })

  it('leaves the ZOOM alone — quantizing a scale would step visibly and fix nothing', () => {
    expect(snapPanToDevicePx({ x: 0, y: 0, zoom: 1.234567 }, 2).zoom).toBe(1.234567)
  })

  it('is idempotent, so a still camera cannot drift frame to frame', () => {
    const once = snapPanToDevicePx({ x: 10.3, y: -4.4, zoom: 1 }, 2)
    expect(snapPanToDevicePx(once, 2)).toEqual(once)
  })

  it('passes through when the dpr is unknown rather than rounding to NaN', () => {
    for (const dpr of [0, -1, NaN, Infinity]) {
      expect(snapPanToDevicePx({ x: 10.3, y: -4.4, zoom: 1 }, dpr)).toEqual({
        x: 10.3,
        y: -4.4,
        zoom: 1
      })
    }
  })

  it('returns a COPY — the GL layer holds it for the whole frame', () => {
    const cam: Camera = { x: 1, y: 2, zoom: 1 }
    const snapped = snapPanToDevicePx(cam, 2)
    expect(snapped).not.toBe(cam)
    cam.x = 999
    expect(snapped.x).toBe(1)
  })
})

/**
 * The WHOLE-CANVAS blank, from a persisted viewport. A project saved with `zoom: 0` (or a viewport
 * that reached the file as NaN) makes `visibleWorldRect` infinite or NaN, `rectsIntersect` false for
 * every grid, and every terminal on the board empty — while the DOM node chrome looks perfect,
 * because React Flow clamps its own transform and the glyph camera used not to.
 */
describe('sanitizeCamera', () => {
  it('passes an ordinary camera through unchanged', () => {
    expect(sanitizeCamera({ x: -120.5, y: 40, zoom: 0.75 })).toEqual({
      x: -120.5,
      y: 40,
      zoom: 0.75
    })
  })

  it('clamps a zoom of 0 to the floor, which is what stops visibleWorldRect going infinite', () => {
    const cam = sanitizeCamera({ x: 0, y: 0, zoom: 0 })
    expect(cam.zoom).toBe(MIN_CAMERA_ZOOM)
    const rect = visibleWorldRect(cam, 1600, 900)
    expect(Number.isFinite(rect.w)).toBe(true)
    expect(Number.isFinite(rect.h)).toBe(true)
  })

  it('clamps a NaN / non-finite / negative zoom, so culling never compares against NaN', () => {
    for (const zoom of [NaN, Infinity, -Infinity, -1]) {
      const cam = sanitizeCamera({ x: 0, y: 0, zoom })
      expect(cam.zoom).toBe(MIN_CAMERA_ZOOM)
      // The blank canvas IS this comparison: with a NaN rect every grid answers false and nothing
      // is ever drawn.
      const r = visibleWorldRect(cam, 1600, 900)
      expect(rectsIntersect(r, { x: 0, y: 0, w: 800, h: 600 })).toBe(true)
    }
  })

  it('replaces a non-finite PAN with 0 rather than letting it poison the rect origin', () => {
    expect(sanitizeCamera({ x: NaN, y: Infinity, zoom: 1 })).toEqual({ x: 0, y: 0, zoom: 1 })
  })

  it('accepts the floor itself, and anything above it', () => {
    expect(sanitizeCamera({ x: 0, y: 0, zoom: MIN_CAMERA_ZOOM }).zoom).toBe(MIN_CAMERA_ZOOM)
    expect(sanitizeCamera({ x: 0, y: 0, zoom: 4 }).zoom).toBe(4)
  })

  it('is idempotent and returns a COPY', () => {
    const cam: Camera = { x: 1, y: 2, zoom: 0 }
    const once = sanitizeCamera(cam)
    expect(sanitizeCamera(once)).toEqual(once)
    expect(sanitizeCamera(cam)).not.toBe(cam)
  })
})
