/**
 * The canvas zoom range, in ONE place.
 *
 * These are the `<ReactFlow minZoom/maxZoom>` props, the wheel-step clamp and the ceiling every
 * zoom preset is measured against. They used to be a private copy in `wheel-zoom.ts` carrying a
 * "keep in sync with Canvas.tsx" comment; a third reader (the dock's preset menu, which must not
 * offer a zoom React Flow would silently clamp) is exactly the drift that comment predicted.
 */
export const CANVAS_MIN_ZOOM = 0.01
export const CANVAS_MAX_ZOOM = 2
