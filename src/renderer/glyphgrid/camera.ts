/** Pan/zoom camera, IDENTICAL in convention to React Flow's Viewport: x/y are the pan offsets
 *  in screen pixels, zoom is the scale. screen = world * zoom + pan. Pure module. */
export interface Camera {
  x: number
  y: number
  zoom: number
}

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export function worldToScreen(wx: number, wy: number, cam: Camera): { x: number; y: number } {
  return { x: wx * cam.zoom + cam.x, y: wy * cam.zoom + cam.y }
}

export function screenToWorld(sx: number, sy: number, cam: Camera): { x: number; y: number } {
  return { x: (sx - cam.x) / cam.zoom, y: (sy - cam.y) / cam.zoom }
}

/** The world-space rectangle the screen viewport currently shows — the culling input. */
export function visibleWorldRect(cam: Camera, viewW: number, viewH: number): Rect {
  const tl = screenToWorld(0, 0, cam)
  return { x: tl.x, y: tl.y, w: viewW / cam.zoom, h: viewH / cam.zoom }
}

/**
 * Snap a camera's PAN to whole DEVICE pixels. The zoom is returned untouched.
 *
 * The glyph atlas is sampled with NEAREST magnification, so where a cell's quad lands within the
 * device-pixel grid decides which texel each screen pixel takes. A pan carrying a sub-device-pixel
 * fraction re-rolls that choice EVERY frame: during a drag the same glyph is resampled slightly
 * differently sixty times a second, and the text ripples behind node chrome that is moving
 * rigidly — the "our text waves while the node doesn't" report. Rounding shifts the whole world by
 * at most half a device pixel (invisible, and constant while the camera is still) and locks the
 * texel alignment for the duration of the pan.
 *
 * The ZOOM is deliberately NOT snapped: it is a scale, not an offset. Quantizing it would step
 * visibly while zooming and would still leave the cell PITCH fractional, so it buys nothing.
 *
 * A non-finite or non-positive dpr (a mocked GL surface, a browser mid-monitor-switch) means
 * "device pixels are unknown here" — pass the camera through rather than round to NaN.
 */
export function snapPanToDevicePx(cam: Camera, dpr: number): Camera {
  if (!Number.isFinite(dpr) || dpr <= 0) return { x: cam.x, y: cam.y, zoom: cam.zoom }
  return {
    x: Math.round(cam.x * dpr) / dpr,
    y: Math.round(cam.y * dpr) / dpr,
    zoom: cam.zoom
  }
}

/**
 * The smallest zoom the glyph camera will hold — React Flow's own `minZoom` default, deliberately
 * the same number, because the two cameras are supposed to describe the same view.
 */
export const MIN_CAMERA_ZOOM = 0.01

/**
 * Make a camera SAFE to compute with, whatever it came from.
 *
 * THE BLANK CANVAS THIS ANSWERS. A camera reaches this module from a persisted project viewport as
 * well as from a live gesture, and a stored `zoom: 0` (or a viewport that reached the file as NaN
 * through some earlier edit) is not caught anywhere on the way in: `visibleWorldRect` divides the
 * viewport by the zoom, so the visible rect goes Infinity or NaN, `rectsIntersect` answers false for
 * EVERY grid, and every terminal on the board is empty at once — permanently, since nothing
 * recomputes the camera until the user pans. The DOM chrome looks perfect throughout, because React
 * Flow clamps its own transform to `minZoom` and this camera did not, which is exactly the shape the
 * "all my terminals went blank but the app is fine" reports have.
 *
 * Clamping rather than rejecting: a camera we refuse to adopt leaves the canvas drawing against the
 * PREVIOUS project's view, which is the same blank screen by another road. A zoom of `MIN_CAMERA_ZOOM`
 * draws the world microscopically small, which is at least honest about what was asked for, and one
 * real gesture replaces it.
 */
export function sanitizeCamera(cam: Camera): Camera {
  return {
    x: Number.isFinite(cam.x) ? cam.x : 0,
    y: Number.isFinite(cam.y) ? cam.y : 0,
    // `!(zoom >= MIN)` rather than `<`, so NaN (which compares false against everything) lands on
    // the floor instead of falling through as "big enough".
    zoom: Number.isFinite(cam.zoom) && cam.zoom >= MIN_CAMERA_ZOOM ? cam.zoom : MIN_CAMERA_ZOOM
  }
}

/** Strict overlap (shared edge does not count — an edge-touching grid draws zero pixels). */
export function rectsIntersect(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
}
