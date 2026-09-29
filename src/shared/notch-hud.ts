// macOS Notch HUD — the user-tunable PLACEMENT values and their sanitizers (docs/notch-hud.md).
//
// Shared because two sides consume the same numbers: main clamps them at the point of use
// (`notch-hud.ts` → `hudGeometry` / `hudPlacement`), and Settings → Notch draws its controls from
// the same bounds, so the slider range and the clamp can never drift apart (they used to be two
// hand-copied constants with a "keep in sync" comment).
//
// Every value here comes from settings.json, which is hand-editable — a hostile input. Nothing
// trusts the TypeScript type: `sanitize*` re-validates at runtime and an unrecognised value falls
// back to the default, never to a guess.

/** Which side of the primary display the capsule sits on. `center` is the historical layout. */
export type NotchAlign = 'left' | 'center' | 'right'
export const NOTCH_ALIGNS: readonly NotchAlign[] = ['left', 'center', 'right']
export const NOTCH_ALIGN_DEFAULT: NotchAlign = 'center'

/** Which display the HUD lives on: the MacBook's built-in screen (falls back to the main display
 *  when there is none, e.g. lid closed) or whichever display macOS calls the main one. */
export type NotchDisplay = 'builtin' | 'primary'
export const NOTCH_DISPLAYS: readonly NotchDisplay[] = ['builtin', 'primary']
export const NOTCH_DISPLAY_DEFAULT: NotchDisplay = 'builtin'

/**
 * Assumed physical notch WIDTH (px). Electron exposes no `auxiliaryTopLeftArea`, so we assume a
 * centered notch of this width, and the capsule butts against its LEFT edge. Field-tuned to 168 px
 * (200 left a visible gap — the capsule sat too far left). TUNE ON A MAC: raise it to push the
 * capsule LEFT, lower it to slide the capsule RIGHT toward the notch.
 */
export const NOTCH_WIDTH_DEFAULT = 168
/** Bounds for the user-tunable notch width (settings.notchWidth). */
export const NOTCH_WIDTH_MIN = 100
export const NOTCH_WIDTH_MAX = 320

/**
 * Bounds for the vertical offset (settings.notchOffsetY, px, positive = DOWN). The offset is
 * relative to where the capsule rests by default, and the effective value is additionally clamped
 * at the display's top edge by `hudPlacement` — there is nothing above it. The minimum only needs
 * to reach that edge from the floating pill's resting place (menu bar ≈ 24–37 px + its gap), so
 * -48 covers every real menu bar; a bigger number would just be dead slider travel.
 */
export const NOTCH_OFFSET_MIN = -48
export const NOTCH_OFFSET_MAX = 240
export const NOTCH_OFFSET_DEFAULT = 0

/** Clamp a hand-editable width to something that can't push the capsule off the display. */
export function sanitizeNotchWidth(px: unknown): number {
  return typeof px === 'number' && Number.isFinite(px)
    ? Math.max(NOTCH_WIDTH_MIN, Math.min(NOTCH_WIDTH_MAX, Math.round(px)))
    : NOTCH_WIDTH_DEFAULT
}

/** An unknown alignment string (typo, a future value on an older build) draws the historical
 *  centered layout — never a pill on a side nobody asked for. */
export function sanitizeNotchAlign(v: unknown): NotchAlign {
  return typeof v === 'string' && (NOTCH_ALIGNS as readonly string[]).includes(v) ? (v as NotchAlign) : NOTCH_ALIGN_DEFAULT
}

/** An unknown display string draws on the built-in screen — never a pill on a monitor nobody asked for. */
export function sanitizeNotchDisplay(v: unknown): NotchDisplay {
  return typeof v === 'string' && (NOTCH_DISPLAYS as readonly string[]).includes(v) ? (v as NotchDisplay) : NOTCH_DISPLAY_DEFAULT
}

/** Non-finite / non-numeric → the default resting place (0); out of range → the nearest bound
 *  (the same rule as the width: keep the direction the user asked for, drop the excess). */
export function sanitizeNotchOffsetY(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v)
    ? Math.max(NOTCH_OFFSET_MIN, Math.min(NOTCH_OFFSET_MAX, Math.round(v)))
    : NOTCH_OFFSET_DEFAULT
}
