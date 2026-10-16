// How see-through group frames and sticky notes are (issue #1113, Settings → Appearance).
//
// Both kinds paint a faint tint of their colour (a note ~13%, a frame ~6%) straight over the
// canvas, so a note inside a frame — or over a terminal, an edge, another note — shows everything
// behind it through two thin washes and reads badly. The setting does NOT change the tint (the
// colour still means what it meant); it adds a BACKING of the canvas colour under the tint, from
// 0% (no backing: exactly the old look, the default) to 100% (solid: nothing behind shows).
//
// Machine-local and hand-editable, so every reader goes through `resolveCanvasBacking`.

export const CANVAS_BACKING_MIN = 0
export const CANVAS_BACKING_MAX = 100
/** 0 = no backing = the look every existing user already has. */
export const CANVAS_BACKING_DEFAULT = 0

/** A percentage, clamped to 0–100 and rounded; anything not a finite number is the default. */
export function resolveCanvasBacking(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return CANVAS_BACKING_DEFAULT
  return Math.round(Math.min(CANVAS_BACKING_MAX, Math.max(CANVAS_BACKING_MIN, value)))
}

export type BackedFillStyle =
  | { background: string }
  | { backgroundColor: string; backgroundImage: string }

/**
 * The inline background for a tinted node body. `color` is the node's hex colour and `alphaHex`
 * the tint's two-digit alpha suffix (today's `${color}22` / `${color}0f`). At backing 0 the result
 * is the old `background` value byte for byte; above it the tint is layered over the canvas colour.
 */
export function backedFillStyle(color: string, alphaHex: string, backing: unknown): BackedFillStyle {
  const tint = `${color}${alphaHex}`
  const b = resolveCanvasBacking(backing)
  if (b === 0) return { background: tint }
  return {
    backgroundColor: `color-mix(in srgb, var(--canvas-bg) ${b}%, transparent)`,
    backgroundImage: `linear-gradient(${tint}, ${tint})`
  }
}
