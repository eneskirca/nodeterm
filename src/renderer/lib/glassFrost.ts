/**
 * Static frost for Liquid Glass terminal nodes (performance).
 *
 * A glass terminal used to frost with a live `backdrop-filter`. Chromium re-runs a backdrop filter
 * every time the surface it belongs to is drawn, and a terminal is redrawn whenever its text
 * changes, so every streaming agent re-blurred its node (and, through damage expansion, the glass
 * around it) at frame rate. MEASURED on an M2 (six glass terminals, all streaming, Sonoma still):
 * 75% → 43% GPU with the frost below, the same as no terminal blur at all; idle costs nothing
 * either way.
 *
 * The frost is a COPY of the wallpaper behind the node, painted under the node's tint with an
 * ordinary `filter` (the same blur/saturate/contrast chain). Its content never changes while the
 * camera is still, so Chromium draws it once and reuses it; the terminal's own updates no longer
 * touch it. What it cannot show is anything else behind the node (the dot grid, an edge, another
 * node): it frosts the wallpaper only. A live aerial video cannot be copied, so an aerial keeps the
 * live backdrop.
 *
 * Alignment: the wallpaper is painted on `.canvas-root` (background-size cover, centred), which is
 * never transformed. A node lives inside React Flow's viewport (translate + scale) at its absolute
 * flow position. `frostBox` maps the wallpaper's drawn rectangle into flow coordinates once per
 * camera change (`--frost-x/y/w/h` on the flow element); each node subtracts its own position
 * (`--node-x/y`, inline). Everything is in flow units, so the node's own scale does the rest.
 */

/** How far the filtered copy extends past the node on every side, in flow px: the blur samples up
 *  to ~3σ outside a pixel, and the widest terminal blur (Tinted) is σ ≈ 24px. Without the margin the
 *  rim would blur into transparency instead of into the wallpaper beside the node. */
export const FROST_PAD = 80

export interface FrostGeometry {
  /** `.canvas-root`'s size (the box the wallpaper is drawn into), CSS px. */
  rootW: number
  rootH: number
  /** The React Flow element's top-left inside `.canvas-root`, CSS px. */
  offX: number
  offY: number
  /** React Flow's viewport transform. */
  tx: number
  ty: number
  zoom: number
  /** The wallpaper image's natural size; absent for a gradient, which fills the root box. */
  imgW?: number | null
  imgH?: number | null
}

/** The wallpaper's drawn rectangle, in flow coordinates. */
export interface FrostBox {
  x: number
  y: number
  w: number
  h: number
}

/**
 * Where `.canvas-root`'s wallpaper sits in flow coordinates: `background-size: cover` and
 * `background-position: center` for an image, the root box itself for a gradient. Null when the
 * geometry cannot place it (no size yet, a zero or non-finite zoom).
 */
export function frostBox(g: FrostGeometry): FrostBox | null {
  const finite = [g.rootW, g.rootH, g.offX, g.offY, g.tx, g.ty, g.zoom].every(Number.isFinite)
  if (!finite || g.rootW <= 0 || g.rootH <= 0 || g.zoom <= 0) return null
  let dw = g.rootW
  let dh = g.rootH
  let dx = 0
  let dy = 0
  const iw = g.imgW ?? 0
  const ih = g.imgH ?? 0
  if (iw > 0 && ih > 0 && Number.isFinite(iw) && Number.isFinite(ih)) {
    const s = Math.max(g.rootW / iw, g.rootH / ih)
    dw = iw * s
    dh = ih * s
    dx = (g.rootW - dw) / 2
    dy = (g.rootH - dh) / 2
  }
  return {
    x: (dx - g.offX - g.tx) / g.zoom,
    y: (dy - g.offY - g.ty) / g.zoom,
    w: dw / g.zoom,
    h: dh / g.zoom
  }
}

/** The custom properties `frostBox` publishes on the flow element (unitless; CSS multiplies). */
export function frostVars(box: FrostBox): Record<'--frost-x' | '--frost-y' | '--frost-w' | '--frost-h', string> {
  const n = (v: number): string => (Math.round(v * 100) / 100).toString()
  return { '--frost-x': n(box.x), '--frost-y': n(box.y), '--frost-w': n(box.w), '--frost-h': n(box.h) }
}

/** The longest edge of the wallpaper copy the frost paints, in image px. The frost is blurred
 *  (σ ≥ 3.4 CSS px even at Clear, about 7 device px), so a copy this size draws the same picture
 *  as the multi-MB original at a fraction of the texture. */
export const FROST_IMAGE_EDGE = 1280

/** The size to draw a `w`×`h` image at so its longest edge is at most `FROST_IMAGE_EDGE`. */
export function frostImageSize(w: number, h: number): { w: number; h: number } | null {
  if (!(w > 0) || !(h > 0) || !Number.isFinite(w) || !Number.isFinite(h)) return null
  const s = Math.min(1, FROST_IMAGE_EDGE / Math.max(w, h))
  return { w: Math.max(1, Math.round(w * s)), h: Math.max(1, Math.round(h * s)) }
}

/** The `url("…")` inside a `background-image` value from `useWallpaperBackground`, or null for
 *  anything else (a gradient). */
export function wallpaperImageUrl(bg: string): string | null {
  const m = /^url\("([^"]*)"\)$/.exec(bg)
  return m ? m[1] : null
}
