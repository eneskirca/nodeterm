// Walking agent mascots — desktop canvas RUNNING badge (docs/mascot-sprites.md).
//
// The Claude critter is drawn at runtime from a terminal quadrant-block pixel map (no image
// asset): two frames of 9×3 half-block characters → an 18×6 sub-pixel grid, feet alternating
// between frames. We decode the map (pure, unit-tested) and paint BOTH frames once at module
// load onto an offscreen canvas → a data-URI spritesheet the RUNNING badge steps through with a
// pure CSS `steps()` animation (a canvas can hold dozens of terminals — zero per-node JS timers).
//
// The Grok critter is the same machinery with a different silhouette and color: its art goes
// through the shared `buildQuadrantSprite` and it reuses Claude's display geometry, so the two
// can never drift apart on aspect ratio or walk timing.
//
// Codex uses a real spritesheet asset (pet-codex.webp) imported by the component; here we only
// export its frame geometry so the CSS animation and the component agree on the numbers.

/** Anthropic coral / clay — rgb(217, 120, 87) (= 0.85, 0.47, 0.34). */
export const CORAL = 'rgb(217, 120, 87)'

/** Sub-pixel grid of one Claude frame: 9 quadrant cols × 2 = 18, 3 rows × 2 = 6. */
export const SUB_COLS = 18
export const SUB_ROWS = 6

/**
 * Quadrant char → (upper-left, upper-right, lower-left, lower-right) sub-pixel bits.
 * Bit order per docs/mascot-sprites.md: UL, UR, LL, LR.
 */
export const QUADRANT_BITS: Record<string, readonly [number, number, number, number]> = {
  '█': [1, 1, 1, 1],
  '▐': [0, 1, 0, 1],
  '▌': [1, 0, 1, 0],
  '▛': [1, 1, 1, 0],
  '▜': [1, 1, 0, 1],
  '▙': [1, 0, 1, 1],
  '▟': [0, 1, 1, 1],
  '▘': [1, 0, 0, 0],
  '▝': [0, 1, 0, 0],
  '▖': [0, 0, 1, 0],
  '▗': [0, 0, 0, 1],
  ' ': [0, 0, 0, 0]
}

/** The two walk frames as quadrant-block art (9 chars × 3 rows). Feet alternate. */
export const CLAUDE_FRAME_ART: readonly string[][] = [
  [' ▐▛███▜▌ ', '▝▜█████▛▘', '  ▘▘ ▝▝  '],
  [' ▐▛███▜▌ ', '▝▜█████▛▘', '  ▝▝ ▘▘  ']
]

/** A decoded frame: row-major `pixels[y*width + x]` booleans on an `width×height` grid. */
export interface MascotBitmap {
  width: number
  height: number
  pixels: boolean[]
}

/** Decode a single quadrant character to its four sub-pixel bits (unknown → all off). */
export function decodeQuadrant(ch: string): readonly [number, number, number, number] {
  return QUADRANT_BITS[ch] ?? [0, 0, 0, 0]
}

/** Decode one frame's 9×3 quadrant art into an 18×6 sub-pixel bitmap. */
export function decodeFrame(rows: readonly string[]): MascotBitmap {
  const width = SUB_COLS
  const height = SUB_ROWS
  const pixels = new Array<boolean>(width * height).fill(false)
  rows.forEach((row, charRow) => {
    for (let charCol = 0; charCol < row.length; charCol++) {
      const [ul, ur, ll, lr] = decodeQuadrant(row[charCol])
      const x = charCol * 2
      const y = charRow * 2
      if (ul) pixels[y * width + x] = true
      if (ur) pixels[y * width + x + 1] = true
      if (ll) pixels[(y + 1) * width + x] = true
      if (lr) pixels[(y + 1) * width + x + 1] = true
    }
  })
  return { width, height, pixels }
}

/** The two decoded walk frames. */
export const CLAUDE_FRAMES: MascotBitmap[] = CLAUDE_FRAME_ART.map(decodeFrame)

// --- Rendering -----------------------------------------------------------------------------
//
// Aspect: terminal cells are ~2× taller than wide, so a sub-pixel is 1 wide : 2 tall — do NOT
// square it or "he squishes". We render at an integer 3× of the 24×16 display size (so the
// browser downscales by a clean /3 with imageSmoothing off = crisp), each sub-pixel a 4×8 block.

/** Display size of one Claude frame (px) — 18×6 sub-pixels at 1.333×2.667, i.e. 1:2 aspect. */
export const CLAUDE_FRAME_WIDTH = 24
export const CLAUDE_FRAME_HEIGHT = 16
const RENDER_SUB_W = 4 // 4:8 = 1:2, and 3× the 1.333×2.667 display sub-pixel
const RENDER_SUB_H = 8

/**
 * Paint a spritesheet from decoded quadrant frames (frames side by side, left to right).
 * Extracted from the former `buildClaudeSprite` so a second mascot cannot drift on aspect ratio
 * or smoothing — the two things that make a pixel critter look wrong.
 */
export function buildQuadrantSprite(frames: MascotBitmap[], color: string): string {
  // Guarded: the pure decode above is unit-tested under vitest's `node` environment, where
  // there is no DOM. The badge never renders there, so an empty src is harmless.
  if (typeof document === 'undefined') return ''
  const frameW = SUB_COLS * RENDER_SUB_W
  const frameH = SUB_ROWS * RENDER_SUB_H
  const canvas = document.createElement('canvas')
  canvas.width = frameW * frames.length
  canvas.height = frameH
  const ctx = canvas.getContext('2d')
  if (!ctx) return ''
  ctx.imageSmoothingEnabled = false
  ctx.fillStyle = color
  frames.forEach((frame, f) => {
    const ox = f * frameW
    for (let y = 0; y < frame.height; y++) {
      for (let x = 0; x < frame.width; x++) {
        if (frame.pixels[y * frame.width + x]) {
          ctx.fillRect(ox + x * RENDER_SUB_W, y * RENDER_SUB_H, RENDER_SUB_W, RENDER_SUB_H)
        }
      }
    }
  })
  return canvas.toDataURL('image/png')
}

/** Claude walk spritesheet (2 frames side by side) + one-frame display dimensions. */
export const CLAUDE_MASCOT = {
  /** data: URI PNG, or '' outside a DOM (tests). */
  src: buildQuadrantSprite(CLAUDE_FRAMES, CORAL),
  frameWidth: CLAUDE_FRAME_WIDTH,
  frameHeight: CLAUDE_FRAME_HEIGHT,
  frameCount: CLAUDE_FRAMES.length
}

// --- Grok critter ---------------------------------------------------------------------------

/**
 * The sprite color — a MID-tone, deliberately not the node color and not a light slate.
 *
 * The badge is NOT on the canvas: `AgentMascot` renders inside `.term-node__status` in the node
 * HEADER, whose background is `--panel-header` — `#323232` in the dark theme but `#eae5db` in the
 * LIGHT one. So the sprite has to survive both, plus the notch capsule (`--capsule-bg: #000`).
 * One color, chosen to match Claude coral's balance across the two themes rather than to win on
 * either (measured contrast vs `--panel-header` dark / light / vs the notch black):
 *   coral #d97757 → 4.11 / 2.49 / 6.73      this #8494a8 → 4.14 / 2.47 / 6.78
 * A light slate-300 measures 8.64 dark but 1.18 LIGHT — a ghost in a shipped theme, which is why
 * it is not used here. Single color on purpose: the component sets `background-image` inline, so a
 * CSS `[data-theme]` override could not win, and two sprites is more machinery than this needs.
 */
export const GROK_COLOR = '#8494a8'

/**
 * Grok's two walk frames. A different silhouette from Claude's rounded blob — narrower body with
 * two raised antennae that swap sides between frames, so it bobs as it walks. Composed only from
 * the quadrant characters in QUADRANT_BITS (there is no half-block ▀/▄ in that table).
 */
export const GROK_FRAME_ART: readonly string[][] = [
  ['▘ ▐███▌ ▝', ' ▙█████▟ ', '  ▘▘ ▝▝  '],
  ['▝ ▐███▌ ▘', ' ▙█████▟ ', '  ▝▝ ▘▘  ']
]

/** The two decoded grok walk frames. */
export const GROK_FRAMES: MascotBitmap[] = GROK_FRAME_ART.map(decodeFrame)

/** Grok walk spritesheet — same grid and display geometry as Claude's, so the CSS walk animation
 *  (`steps(1)` over three keyframes) and the HUD sizing math are shared verbatim. */
export const GROK_MASCOT = {
  /** data: URI PNG, or '' outside a DOM (tests). */
  src: buildQuadrantSprite(GROK_FRAMES, GROK_COLOR),
  frameWidth: CLAUDE_FRAME_WIDTH,
  frameHeight: CLAUDE_FRAME_HEIGHT,
  frameCount: GROK_FRAMES.length
}

// --- "Done, unseen" pixel blob (Notch HUD) -------------------------------------------------
//
// agent-notch draws a shimmering green blob on a 7×7 grid of crisp pixels for a finished-but-
// unseen agent slot. We reproduce the SHAPE as a static 7×7 green circle sprite (crisp pixels via
// image-rendering:pixelated) and let CSS drive the shimmer (opacity pulse) — same reuse pattern as
// the Claude sprite above, so the HUD stays plain-DOM with no per-pixel JS.

/** systemGreen — matches agent-notch's NSColor.systemGreen done blob. */
export const DONE_GREEN = 'rgb(48, 209, 88)'

/** 7×7 filled-circle mask (1 = green pixel). */
export const DONE_BLOB_ART: readonly (readonly number[])[] = [
  [0, 0, 1, 1, 1, 0, 0],
  [0, 1, 1, 1, 1, 1, 0],
  [1, 1, 1, 1, 1, 1, 1],
  [1, 1, 1, 1, 1, 1, 1],
  [1, 1, 1, 1, 1, 1, 1],
  [0, 1, 1, 1, 1, 1, 0],
  [0, 0, 1, 1, 1, 0, 0]
]
export const DONE_BLOB_GRID = 7
const DONE_BLOB_SCALE = 3 // render at 3× (21×21) so the browser downscales by a clean /3

function buildDoneBlobSprite(): string {
  if (typeof document === 'undefined') return '' // no DOM in tests
  const size = DONE_BLOB_GRID * DONE_BLOB_SCALE
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  if (!ctx) return ''
  ctx.imageSmoothingEnabled = false
  ctx.fillStyle = DONE_GREEN
  for (let y = 0; y < DONE_BLOB_GRID; y++) {
    for (let x = 0; x < DONE_BLOB_GRID; x++) {
      if (DONE_BLOB_ART[y][x]) {
        ctx.fillRect(x * DONE_BLOB_SCALE, y * DONE_BLOB_SCALE, DONE_BLOB_SCALE, DONE_BLOB_SCALE)
      }
    }
  }
  return canvas.toDataURL('image/png')
}

/** Green "done, unseen" pixel blob (7×7). `src` is a data: URI PNG, or '' outside a DOM. */
export const DONE_BLOB = {
  src: buildDoneBlobSprite(),
  grid: DONE_BLOB_GRID
}

// --- Codex pet spritesheet geometry (asset imported by the component) ----------------------

/** pet-codex.webp layout: 8 cols × 9 rows of 192×208 frames; walk = the first row. */
export const CODEX_MASCOT = {
  cols: 8,
  rows: 9,
  nativeFrameWidth: 192,
  nativeFrameHeight: 208,
  /** Display size — ~16px tall, keeping the native aspect. */
  frameHeight: 16,
  frameWidth: Math.round((16 * 192) / 208)
}
