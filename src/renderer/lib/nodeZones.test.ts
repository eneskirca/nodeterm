import { describe, it, expect } from 'vitest'
import { ZONES, ZONE_GUTTER_PX, zoneTargetRect } from './nodeZones'
import { NODE_MAXIMIZE_MARGIN_PX, maximizeTargetRect } from './nodeMaximize'
import type { ScreenInsets } from './pinnedInsets'

// Zone snapping (issue #394 v1): the viewport→flow subdivision the keyboard chords and the
// "Snap to zone" menu both use. All screen-px assertions run at zoom 1 / camera origin so flow
// equals screen; one case pins the zoom conversion.

const VP = { x: 0, y: 0, zoom: 1 }
const W = 1200
const H = 800
const M = NODE_MAXIMIZE_MARGIN_PX
const G = ZONE_GUTTER_PX

describe('zoneTargetRect', () => {
  it('left/right halves split the margin-inset area and share one gutter', () => {
    const left = zoneTargetRect(VP, W, H, 'left-half')!
    const right = zoneTargetRect(VP, W, H, 'right-half')!
    // Outer edges keep the maximize margin; full height.
    expect(left.x).toBe(M)
    expect(left.y).toBe(M)
    expect(left.height).toBe(H - 2 * M)
    expect(right.x + right.width).toBe(W - M)
    // The two rects tile the area with exactly one gutter between them.
    expect(right.x - (left.x + left.width)).toBeCloseTo(G)
    expect(left.width).toBeCloseTo(right.width)
  })

  it('quarters meet at gutters on both axes', () => {
    const tl = zoneTargetRect(VP, W, H, 'top-left')!
    const br = zoneTargetRect(VP, W, H, 'bottom-right')!
    expect(tl).toMatchObject({ x: M, y: M })
    expect(br.x + br.width).toBe(W - M)
    expect(br.y + br.height).toBe(H - M)
    expect(br.x - (tl.x + tl.width)).toBeCloseTo(G)
    expect(br.y - (tl.y + tl.height)).toBeCloseTo(G)
  })

  it('thirds tile the width with two gutters, center inset on both sides', () => {
    const l = zoneTargetRect(VP, W, H, 'left-third')!
    const c = zoneTargetRect(VP, W, H, 'center-third')!
    const r = zoneTargetRect(VP, W, H, 'right-third')!
    expect(c.x - (l.x + l.width)).toBeCloseTo(G)
    expect(r.x - (c.x + c.width)).toBeCloseTo(G)
    expect(l.width).toBeCloseTo(r.width)
    // The center third pays a half-gutter on BOTH sides, so it is narrower than the outer two.
    expect(c.width).toBeCloseTo(l.width - G / 2)
  })

  it('converts to flow coordinates like maximize (zoom + camera offset)', () => {
    const vp = { x: -100, y: 50, zoom: 0.5 }
    const left = zoneTargetRect(vp, W, H, 'left-half')!
    expect(left.x).toBeCloseTo((M + 100) / 0.5)
    expect(left.y).toBeCloseTo((M - 50) / 0.5)
    expect(left.width).toBeCloseTo((W - 2 * M - G) / 2 / 0.5)
  })

  it('a full-viewport zone would be maximize — the two modules agree on the frame', () => {
    // Not a real zone, but the outer edges must match: left-half + right-half spans exactly the
    // rect maximizeTargetRect answers, so the two features can never disagree about the margin.
    const max = maximizeTargetRect(VP, W, H)!
    const left = zoneTargetRect(VP, W, H, 'left-half')!
    const right = zoneTargetRect(VP, W, H, 'right-half')!
    expect(left.x).toBe(max.x)
    expect(right.x + right.width).toBeCloseTo(max.x + max.width)
    expect(left.y).toBe(max.y)
    expect(left.height).toBe(max.height)
  })

  it('refuses a zone smaller than a node header, per zone rather than per container', () => {
    expect(zoneTargetRect(VP, 0, 0, 'left-half')).toBeNull()
    // 280px wide: a HALF of the width comes out 110px < 120…
    expect(zoneTargetRect(VP, 280, 800, 'left-half')).toBeNull()
    // …but a full-width zone in the same container still fits (232 × 370).
    expect(zoneTargetRect(VP, 280, 800, 'top-half')).not.toBeNull()
    expect(zoneTargetRect(VP, 1200, 800, 'nope' as never)).toBeNull()
  })

  it('every declared zone answers on a normal container', () => {
    for (const z of ZONES) {
      const rect = zoneTargetRect(VP, W, H, z.id)
      expect(rect, z.id).not.toBeNull()
      expect(rect!.width).toBeGreaterThan(0)
      expect(rect!.height).toBeGreaterThan(0)
    }
  })

  it('subdivides the area left over by pinned side panels, not the whole wrapper', () => {
    // A pinned sessions sidebar on the left (314px) and a pinned explorer drawer on the right
    // (374px): zones must tile what remains, or left-half lands under the sidebar (the bug).
    const insets: ScreenInsets = { left: 314, right: 374 }
    const left = zoneTargetRect(VP, W, H, 'left-half', M, G, insets)!
    const right = zoneTargetRect(VP, W, H, 'right-half', M, G, insets)!
    expect(left.x).toBe(M + insets.left)
    expect(right.x + right.width).toBeCloseTo(W - M - insets.right)
    // Still one gutter between them, and still equal halves — of the smaller area.
    expect(right.x - (left.x + left.width)).toBeCloseTo(G)
    expect(left.width).toBeCloseTo(right.width)
    expect(left.width).toBeCloseTo((W - 2 * M - insets.left - insets.right - G) / 2)
    // Vertical geometry is untouched: both panels are side cards.
    expect(left.y).toBe(M)
    expect(left.height).toBe(H - 2 * M)
  })

  it('still agrees with maximize once panels are pinned', () => {
    const insets: ScreenInsets = { left: 314, right: 0 }
    const max = maximizeTargetRect(VP, W, H, M, insets)!
    const left = zoneTargetRect(VP, W, H, 'left-half', M, G, insets)!
    const right = zoneTargetRect(VP, W, H, 'right-half', M, G, insets)!
    expect(left.x).toBe(max.x)
    expect(right.x + right.width).toBeCloseTo(max.x + max.width)
  })
})
