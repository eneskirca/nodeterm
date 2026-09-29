// Pure, Electron-free geometry for the macOS Notch HUD (docs/notch-hud.md).
//
// Split out of notch-hud.ts so vitest can cover notch DETECTION without an Electron runtime: the
// controller reads the display from `screen` and hands the plain numbers here. Everything the
// HUD window and its renderer position themselves by is decided in this module: `hudGeometry`
// places the WINDOW (and detects the notch), `hudPlacement` places the CAPSULE and its expanded
// panel inside that window from the user's side / vertical-offset settings.

import type { NotchAlign, NotchDisplay } from '../shared/notch-hud'

/** A rectangle in Electron's logical (point) coordinate space. */
export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface HudGeometryInput {
  /** display.bounds — the full display, menu bar included. */
  bounds: Rect
  /** display.workArea — excludes the menu bar / notch strip. */
  workArea: Rect
  /** display.internal — a notch only ever exists on a built-in panel. */
  internal: boolean
  /** Already-sanitized settings.notchWidth. */
  notchWidth: number
  /** Already-sanitized settings.notchOffsetY (px, positive = down). Only the window HEIGHT depends
   *  on it here — a capsule pushed down needs the window to grow with it (see `hudPlacement`). */
  offsetY: number
}

export interface HudGeometry {
  x: number
  y: number
  width: number
  height: number
  /** Height of the fused top strip (menu bar / notch), floored so the mascots always fit. */
  bar: number
  notchWidth: number
  notchCenterX: number
  hasNotch: boolean
}

/** Minimum strip height when there is no physical notch (menu-bar height floor). */
export const NOTCH_BAR_FLOOR = 24

/**
 * Notch detection threshold, as a FRACTION of the display's logical height — deliberately not an
 * absolute px count.
 *
 * macOS reserves a menu bar exactly as tall as the notch on a notched panel, so that strip is a
 * fixed share of the panel and survives every scaling mode: a 15" Air reports 37/1112 at its
 * default and 31/932 at 1440x932 — both 0.0333. A notchless panel's menu bar is a fixed 24 pt, so
 * its share instead FALLS as the resolution rises: 24/1080 = 0.0222, 24/900 = 0.0267.
 *
 * The predecessor of this constant was an absolute 32 px, which the 0.0333 share only clears while
 * the display is tall enough — i.e. at the default scaling and nowhere else (issue #508).
 *
 * Residual, and why it is survivable: a notchless BUILT-IN panel driven at an unusually low scaled
 * resolution (24/640 = 0.0375) still reads as notched. That misdetection now costs a capsule fused
 * to a notch that is not there, never a pill hidden behind one — the notchless layout no longer
 * occupies the top strip at all (see `.notchless .hud-capsule` in hud.css).
 */
export const NOTCH_BAR_RATIO = 0.03

/** Total window height ABOVE the top strip — sized to the EXPANDED box (we never resize the frame;
 *  the renderer scales a CSS transform). The strip itself is added on top, because both layouts
 *  start below it: the fused capsule reserves it as padding, the floating pill clears it. */
export const HUD_WINDOW_HEIGHT = 460

/**
 * Decide where the HUD window sits and which of the two layouts its renderer should draw.
 *
 * The window always spans the display's full width at its very top edge (`bounds`, not `workArea`
 * — painting OVER the menu bar is the point, see `enableLargerThanScreen` in notch-hud.ts).
 */
export function hudGeometry(input: HudGeometryInput): HudGeometry {
  const b = input.bounds
  const inset = input.workArea.y - b.y
  const bar = Math.max(NOTCH_BAR_FLOOR, inset)
  // A physical notch requires a built-in panel whose reserved strip is a notch-sized SHARE of it.
  const hasNotch = input.internal && inset > 0 && b.height > 0 && inset / b.height >= NOTCH_BAR_RATIO
  // A capsule lowered by `offsetY` drags its expanded panel down with it, so the window grows by the
  // same amount — otherwise the panel's bottom rows would be clipped by the window edge. A RAISED
  // capsule (negative) needs nothing extra, and offset 0 keeps the historical height bit-for-bit.
  const extra = Math.max(0, input.offsetY)
  return {
    x: b.x,
    y: b.y,
    width: b.width,
    height: Math.min(bar + HUD_WINDOW_HEIGHT + extra, b.height),
    bar,
    notchWidth: input.notchWidth,
    notchCenterX: Math.round(b.width / 2),
    hasNotch
  }
}

// ---- Capsule + panel placement inside the window ------------------------------------------

/** Width of the EXPANDED session panel (px). Lives here, not only in hud.css, because the panel's
 *  left edge is decided by `hudPlacement` (it has to stay on screen at every alignment) and the
 *  renderer paints exactly the width main reasoned with (`--panel-width` is pushed). */
export const HUD_PANEL_WIDTH = 400
/** Gap between the menu-bar / notch strip and a floating pill's top edge (px). The pill's resting
 *  place is BELOW the strip — load-bearing, see the `.pill .hud-capsule` note in hud.css. */
export const PILL_TOP_GAP = 6
/** Margin between a left/right-aligned capsule (and its panel) and the display's edge (px). */
export const HUD_EDGE_MARGIN = 12

export interface HudPlacementInput {
  /** Window / display width (px). */
  width: number
  /** Fused top-strip height (`HudGeometry.bar`). */
  bar: number
  notchWidth: number
  notchCenterX: number
  /** Notch present AND the window actually paints over it (main folds its own clamp check in). */
  hasNotch: boolean
  /** Already-sanitized settings.notchAlign / settings.notchOffsetY. */
  align: NotchAlign
  offsetY: number
}

export interface HudPlacement {
  /**
   * The SHAPE. `true` = the capsule is fused to the physical notch (square top corners at y=0,
   * grows left of the notch, expands under it). `false` = a standalone floating pill (all corners
   * rounded) — the only shape that makes sense once the capsule is not touching the notch.
   *
   * What each combination draws:
   *   notch + center + offset ≤ 0  → fused to the notch (the historical layout; a negative offset
   *                                   cannot go above the top edge, so it stays fused)
   *   notch + center + offset > 0  → a pill hanging centered BELOW the notch
   *   notch + left / right         → a pill at that edge, below the menu-bar strip (± offset)
   *   no notch, any side           → a pill on that side, below the strip (± offset)
   */
  fused: boolean
  /** Which edge of the COLLAPSED capsule sits at `capsuleX` (the capsule is shrink-to-fit wide,
   *  so it is positioned by an anchor + a CSS translate, not by a left/width pair). Fused = `right`
   *  (its right edge butts against the notch's right edge); a pill = the chosen side. */
  anchor: NotchAlign
  /** X of that anchor edge (px, window coords). */
  capsuleX: number
  /** Top of the capsule (px, window coords) — 0 when fused; never negative (nothing is above the
   *  display's top edge, so an offset that would raise the capsule past it is clamped there). */
  capsuleTop: number
  /** Left edge of the EXPANDED panel (px, window coords), clamped so the panel is on screen. */
  panelLeft: number
  panelWidth: number
}

/**
 * Where the capsule and its expanded panel sit, from the user's placement settings. Pure: the
 * renderer draws EXACTLY these numbers (pushed as CSS variables), and the click-through hotspot is
 * the capsule element itself, so the interactive region follows whatever this returns.
 */
export function hudPlacement(input: HudPlacementInput): HudPlacement {
  const { width, bar, notchWidth, notchCenterX, align, offsetY } = input
  const panelWidth = HUD_PANEL_WIDTH
  // Fused only when the capsule actually touches the notch. A positive offset detaches it, and a
  // detached capsule with square top corners is the "black box below the menu bar" field bug, so
  // it becomes a pill; a negative offset has nowhere to go (top edge) and stays fused at 0.
  const fused = input.hasNotch && align === 'center' && offsetY <= 0
  // Pill top: below the strip by default, pushed by the offset, and never above the display edge.
  const capsuleTop = fused ? 0 : Math.max(0, bar + PILL_TOP_GAP + offsetY)
  let anchor: NotchAlign
  let capsuleX: number
  if (fused) {
    anchor = 'right'
    capsuleX = notchCenterX + Math.round(notchWidth / 2)
  } else if (align === 'left') {
    anchor = 'left'
    capsuleX = HUD_EDGE_MARGIN
  } else if (align === 'right') {
    anchor = 'right'
    capsuleX = width - HUD_EDGE_MARGIN
  } else {
    anchor = 'center'
    capsuleX = notchCenterX
  }
  // The expanded panel keeps the capsule's side but is clamped INTO the display: anchored hard
  // left/right it must not run off the edge (the #791 class of bug — a surface that opens where it
  // cannot be seen). Center keeps the historical `center - width/2`. On a display too narrow for
  // the panel plus its margin, the margin is dropped on the CHOSEN side (a left panel hugs the
  // left edge, a right panel the right edge) — a bare clamp would have dropped it on the far side.
  const maxLeft = Math.max(0, width - panelWidth)
  const desired =
    align === 'left' && !fused
      ? HUD_EDGE_MARGIN + panelWidth <= width
        ? HUD_EDGE_MARGIN
        : 0
      : align === 'right' && !fused
        ? width - HUD_EDGE_MARGIN - panelWidth >= 0
          ? width - HUD_EDGE_MARGIN - panelWidth
          : maxLeft
        : notchCenterX - panelWidth / 2
  const panelLeft = Math.round(Math.max(0, Math.min(maxLeft, desired)))
  return { fused, anchor, capsuleX, capsuleTop, panelLeft, panelWidth }
}

/** The display the HUD lives on. `builtin` → the built-in panel, else (clamshell) the primary;
 *  `primary` → the macOS main display, whichever it is. */
export function pickHudDisplay<D extends { id: number; internal?: boolean }>(displays: D[], primary: D, pref: NotchDisplay): D {
  if (pref === 'primary') return primary
  return displays.find((d) => d.internal === true) ?? primary
}
