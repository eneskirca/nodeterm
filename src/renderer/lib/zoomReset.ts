/** A canvas viewport: React Flow's `{ x, y, zoom }`, in screen px and a scale factor. */
export interface Viewport {
  x: number
  y: number
  zoom: number
}

/**
 * The viewport that holds the screen centre still while moving to `target` zoom.
 *
 * The anchor is the viewport CENTRE, not the origin: zooming about the corner throws the user's
 * work off screen, which makes a jump to a chosen zoom feel like a teleport rather than a change
 * of scale.
 *
 * Zoom 1 matters beyond ergonomics — it is the only ratio at which the shared renderer samples the
 * glyph atlas texel-for-texel, so "am I actually at 1?" is a question both users and bug reports
 * need to be able to settle. Until this existed the only way was to read the viewport transform in
 * DevTools, which is how the 2026-08-09 crispness report was finally pinned (at 0.976).
 *
 * A zoom that already equals the target, or either side not being a usable number, returns the
 * viewport UNCHANGED — the command is then a no-op rather than a nudge. Callers rely on the
 * IDENTITY of that return to skip the animated `setViewport` entirely.
 */
export function viewportAtZoom(
  current: Viewport,
  centre: { x: number; y: number },
  target: number
): Viewport {
  const { x, y, zoom } = current
  if (!Number.isFinite(target) || target <= 0) return current
  if (!Number.isFinite(zoom) || zoom <= 0 || zoom === target) return current
  // The world point under the screen centre, held fixed across the change.
  const worldX = (centre.x - x) / zoom
  const worldY = (centre.y - y) / zoom
  return { x: centre.x - worldX * target, y: centre.y - worldY * target, zoom: target }
}

/** `viewportAtZoom` at 100% — the "actual size" reset behind ⌘/Ctrl+0. */
export function viewportAtZoom1(current: Viewport, centre: { x: number; y: number }): Viewport {
  return viewportAtZoom(current, centre, 1)
}
