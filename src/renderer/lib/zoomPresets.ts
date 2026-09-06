import { CANVAS_MAX_ZOOM, CANVAS_MIN_ZOOM } from '../canvas/zoom-limits'

/**
 * The zoom presets behind the dock's percentage readout.
 *
 * Before this the readout was inert text between two step buttons: getting back to 100% meant
 * clicking `+`/`−` until the number happened to land on it, and it rarely did — the wheel and the
 * step buttons both move zoom multiplicatively, so the reachable set from an arbitrary zoom
 * contains no round number at all. `Fit view` was the only one-click camera command, and it lands
 * on whatever the content bounds imply, never on 1.
 *
 * The list is deliberately bounded by the canvas's own range: `CANVAS_MAX_ZOOM` is 2, so 200% is
 * the last entry — a preset React Flow would silently clamp is a menu row that lies about what it
 * does.
 */
export const ZOOM_PRESETS = [25, 50, 75, 100, 150, 200] as const

/** A preset percentage as React Flow's scale factor. */
export const zoomFromPct = (pct: number): number => pct / 100

/** Whether `pct` is offerable at all — the guard the list itself is built to satisfy. */
export const isOfferableZoomPct = (pct: number): boolean =>
  zoomFromPct(pct) >= CANVAS_MIN_ZOOM && zoomFromPct(pct) <= CANVAS_MAX_ZOOM

/**
 * Which preset the dock should tick, or `null` when the camera sits between two.
 *
 * The comparison is on the ROUNDED percentage the dock already displays, not on the raw zoom: at
 * 0.999 the readout says 100% and a menu that ticked nothing there would read as broken. Rounding
 * is the display's contract, so the tick has to share it rather than re-derive a tolerance.
 */
export function activeZoomPreset(zoomPct: number): number | null {
  return ZOOM_PRESETS.find((p) => p === Math.round(zoomPct)) ?? null
}
