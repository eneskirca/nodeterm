// Zone snapping (issue #394, v1): place ONE node into a chosen region of the visible canvas —
// halves, quarters, thirds — at that region's position and size. The MacsyZones/FancyZones idea,
// scoped to the deliberate keyboard/menu gesture (the drag-time overlay is the follow-up).
//
// Same coordinate answer as the maximize toggle (issue #399), because it resolves the issue's own
// "viewport-relative or canvas-relative?" question the same way: the GESTURE is viewport-relative
// ("left half of what I am looking at right now"), the RESULT is plain absolute node geometry
// that persists. A zone is a placement verb, not a live constraint — pan away and the node stays
// where it was put.

import type { Viewport } from '@xyflow/system'
import { NODE_MAXIMIZE_MARGIN_PX, type FlowRect } from './nodeMaximize'
import { NO_INSETS, type ScreenInsets } from './pinnedInsets'

/** Screen-pixel gap between two adjacent zones, so side-by-side nodes don't touch. */
export const ZONE_GUTTER_PX = 12

export type ZoneId =
  | 'left-half'
  | 'right-half'
  | 'top-half'
  | 'bottom-half'
  | 'top-left'
  | 'top-right'
  | 'bottom-left'
  | 'bottom-right'
  | 'left-third'
  | 'center-third'
  | 'right-third'

interface ZoneFraction {
  x0: number
  y0: number
  x1: number
  y1: number
}

/** Each zone as fractions of the usable (margin-inset) viewport. The menu renders in this order. */
export const ZONES: readonly { id: ZoneId; label: string; frac: ZoneFraction }[] = [
  { id: 'left-half', label: 'Left half', frac: { x0: 0, y0: 0, x1: 0.5, y1: 1 } },
  { id: 'right-half', label: 'Right half', frac: { x0: 0.5, y0: 0, x1: 1, y1: 1 } },
  { id: 'top-half', label: 'Top half', frac: { x0: 0, y0: 0, x1: 1, y1: 0.5 } },
  { id: 'bottom-half', label: 'Bottom half', frac: { x0: 0, y0: 0.5, x1: 1, y1: 1 } },
  { id: 'top-left', label: 'Top left quarter', frac: { x0: 0, y0: 0, x1: 0.5, y1: 0.5 } },
  { id: 'top-right', label: 'Top right quarter', frac: { x0: 0.5, y0: 0, x1: 1, y1: 0.5 } },
  { id: 'bottom-left', label: 'Bottom left quarter', frac: { x0: 0, y0: 0.5, x1: 0.5, y1: 1 } },
  { id: 'bottom-right', label: 'Bottom right quarter', frac: { x0: 0.5, y0: 0.5, x1: 1, y1: 1 } },
  { id: 'left-third', label: 'Left third', frac: { x0: 0, y0: 0, x1: 1 / 3, y1: 1 } },
  { id: 'center-third', label: 'Center third', frac: { x0: 1 / 3, y0: 0, x1: 2 / 3, y1: 1 } },
  { id: 'right-third', label: 'Right third', frac: { x0: 2 / 3, y0: 0, x1: 1, y1: 1 } }
]

const ZONES_BY_ID: ReadonlyMap<ZoneId, ZoneFraction> = new Map(ZONES.map((z) => [z.id, z.frac]))

/**
 * The zone's rect in FLOW coordinates, or null when the container has no usable size — the same
 * contract as `maximizeTargetRect` (which this generalizes: the full-viewport zone IS maximize).
 * Internal zone edges are inset by half the gutter each, so two adjacent zones share one
 * `ZONE_GUTTER_PX` gap; outer edges keep the maximize margin.
 */
export function zoneTargetRect(
  viewport: Viewport,
  containerWidth: number,
  containerHeight: number,
  zone: ZoneId,
  marginPx: number = NODE_MAXIMIZE_MARGIN_PX,
  gutterPx: number = ZONE_GUTTER_PX,
  insets: ScreenInsets = NO_INSETS
): FlowRect | null {
  const frac = ZONES_BY_ID.get(zone)
  if (!frac || !(viewport.zoom > 0)) return null
  // Same usable area as maximize: the margin on every edge, plus whatever pinned side panels
  // cover. Zones subdivide THAT, so left-half lands beside a pinned sidebar instead of under it.
  const originX = marginPx + insets.left
  const innerW = containerWidth - marginPx * 2 - insets.left - insets.right
  const innerH = containerHeight - marginPx * 2
  // Screen-px edges inside the usable area, with internal edges pulled in by gutter/2.
  const left = originX + frac.x0 * innerW + (frac.x0 > 0 ? gutterPx / 2 : 0)
  const right = originX + frac.x1 * innerW - (frac.x1 < 1 ? gutterPx / 2 : 0)
  const top = marginPx + frac.y0 * innerH + (frac.y0 > 0 ? gutterPx / 2 : 0)
  const bottom = marginPx + frac.y1 * innerH - (frac.y1 < 1 ? gutterPx / 2 : 0)
  // Same refusal floor as maximize: below this the "zone" is smaller than a node header, and a
  // node parked there is a comic strip the user then has to fish back out.
  if (!(right - left >= 120) || !(bottom - top >= 120)) return null
  return {
    x: (left - viewport.x) / viewport.zoom,
    y: (top - viewport.y) / viewport.zoom,
    width: (right - left) / viewport.zoom,
    height: (bottom - top) / viewport.zoom
  }
}
