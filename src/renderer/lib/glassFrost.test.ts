import { describe, expect, it } from 'vitest'
import { FROST_IMAGE_EDGE, frostBox, frostImageSize, frostVars, wallpaperImageUrl } from './glassFrost'

describe('frostBox', () => {
  const base = { rootW: 1300, rootH: 850, offX: 0, offY: 40, tx: 0, ty: 0, zoom: 1 }

  it('a gradient fills the root box, shifted by the pane offset and the camera', () => {
    expect(frostBox(base)).toEqual({ x: 0, y: -40, w: 1300, h: 850 })
    expect(frostBox({ ...base, tx: 100, ty: -50 })).toEqual({ x: -100, y: 10, w: 1300, h: 850 })
  })

  it('an image is placed like background-size: cover, centred', () => {
    // A 2:1 image in a 1300×850 box: height-limited, scale 850/1000 → 1700×850, overflowing 200px
    // on each side.
    const b = frostBox({ ...base, offY: 0, imgW: 2000, imgH: 1000 })!
    expect(b.w).toBeCloseTo(1700)
    expect(b.h).toBeCloseTo(850)
    expect(b.x).toBeCloseTo(-200)
    expect(b.y).toBeCloseTo(0)
  })

  it('maps into flow units: zoom divides sizes and offsets', () => {
    const b = frostBox({ ...base, tx: 200, ty: 100, zoom: 0.5 })!
    expect(b).toEqual({ x: -400, y: -280, w: 2600, h: 1700 })
  })

  // The node's on-screen pixel at flow point P is offX + tx + P·zoom; the wallpaper pixel under it
  // must be the one the frost paints at P. Checked through the published box.
  it('a flow point lands on the wallpaper pixel under it on screen', () => {
    const g = { rootW: 1470, rootH: 923, offX: 12, offY: 40, tx: -321.5, ty: 77, zoom: 0.73, imgW: 6016, imgH: 6016 }
    const b = frostBox(g)!
    const P = { x: 480, y: 220 }
    const screen = { x: g.offX + g.tx + P.x * g.zoom, y: g.offY + g.ty + P.y * g.zoom }
    const s = Math.max(g.rootW / g.imgW, g.rootH / g.imgH)
    const imgOrigin = { x: (g.rootW - g.imgW * s) / 2, y: (g.rootH - g.imgH * s) / 2 }
    const expectedUV = { u: (screen.x - imgOrigin.x) / (g.imgW * s), v: (screen.y - imgOrigin.y) / (g.imgH * s) }
    expect((P.x - b.x) / b.w).toBeCloseTo(expectedUV.u, 9)
    expect((P.y - b.y) / b.h).toBeCloseTo(expectedUV.v, 9)
  })

  it('refuses geometry it cannot place', () => {
    for (const bad of [{ zoom: 0 }, { zoom: -1 }, { zoom: Number.NaN }, { rootW: 0 }, { rootH: -5 }, { tx: Infinity }])
      expect(frostBox({ ...base, ...bad })).toBeNull()
  })

  it('a missing or broken image size falls back to the root box', () => {
    for (const img of [{ imgW: 0, imgH: 100 }, { imgW: Number.NaN, imgH: 5 }, { imgW: null, imgH: null }])
      expect(frostBox({ ...base, ...img })).toEqual({ x: 0, y: -40, w: 1300, h: 850 })
  })
})

describe('frost helpers', () => {
  it('publishes rounded unitless numbers', () => {
    expect(frostVars({ x: -12.3456, y: 0.004, w: 1300, h: 850.555 })).toEqual({
      '--frost-x': '-12.35',
      '--frost-y': '0',
      '--frost-w': '1300',
      '--frost-h': '850.56'
    })
  })

  it('downsizes the wallpaper copy to the frost edge, never up', () => {
    expect(frostImageSize(6016, 6016)).toEqual({ w: FROST_IMAGE_EDGE, h: FROST_IMAGE_EDGE })
    expect(frostImageSize(6000, 3000)).toEqual({ w: FROST_IMAGE_EDGE, h: FROST_IMAGE_EDGE / 2 })
    expect(frostImageSize(800, 600)).toEqual({ w: 800, h: 600 })
    expect(frostImageSize(0, 10)).toBeNull()
  })

  it('reads the url out of a wallpaper background, and nothing out of a gradient', () => {
    expect(wallpaperImageUrl('url("data:image/jpeg;base64,AAAA")')).toBe('data:image/jpeg;base64,AAAA')
    expect(wallpaperImageUrl('linear-gradient(165deg, #1d2b64 0%, #f4a6b8 100%)')).toBeNull()
  })
})
