import { GUTTER_PX, partCells, slotPitch, type GlyphRasterizer } from './atlas'
import { boxGlyphOps } from './box-glyphs'
import { unpackColor } from './cells'

/**
 * THE SENTINEL TEXEL, and the blank-everything bug it exists to detect.
 *
 * The atlas page is an OffscreenCanvas 2D context created once, for the life of the shared context.
 * A GPU reset — macOS sleep/wake, a driver hiccup, a GPU-process restart — BLANKS its backing store,
 * and every layer above it keeps believing the page is full: `GlyphAtlas.slots` still holds every
 * key, so not one glyph is re-rasterized, and `engine.reviveGpu` (whose comment says outright that
 * the 2D source survived) re-uploads the empty page as the atlas texture. The result is every
 * terminal on the canvas showing empty cells at the same instant, permanently, with the app
 * otherwise alive — which is exactly the field report this answers.
 *
 * The WebGL half of that reset arrives as an event and has a policy. The 2D half may fire
 * `contextlost` too (handled — see `onSourceLoss`), but it is not guaranteed to: a page can come back
 * wiped with no event at all. So the revive path needs a way to ASK, and a 1-texel readback of a
 * colour we painted ourselves is the cheapest honest answer — cheaper than hashing the page,
 * and unlike "is any slot allocated" it distinguishes a page we filled from a page that was emptied.
 *
 * WHERE IT LIVES: page pixel (0,0), the top-left corner of SLOT 0's pitch cell, inside its gutter.
 * That is the one texel on the page that no sampling can reach. Slot 0 is never inked (`glyphFor`
 * returns it for blanks without drawing) and never sampled (the shader branches on the glyph lane
 * being 0 and paints the cell's own background), and slot 1's ink starts `ceil(cellW) + 3*GUTTER_PX`
 * texels away — several LOD-2 blocks clear, so it cannot bleed into a real glyph's mip either. Any
 * other placement costs a slot or contaminates one.
 *
 * WHY IT IS REPAINTED BY `clearPage`: an atlas reset is a NORMAL event (the page is a working set,
 * not a cache of everything), and a page that lost its sentinel to an ordinary reset would read as a
 * lost context and rebuild the whole canvas on the next revive.
 */
export const ATLAS_SENTINEL_RGBA = [255, 0, 255, 255] as const

/** The same colour as the canvas takes it. Exported so a test asserts the ONE op this adds. */
export const SENTINEL_CSS = 'rgb(255,0,255)'

/** How far a channel may drift and still count as the sentinel. The canvas is sRGB and the fill is
 *  exact, so this absorbs colour-management rounding rather than any real difference — a wiped page
 *  reads back 0,0,0,0 and misses by 255. */
const SENTINEL_TOLERANCE = 8

/** Does this 1px readback still hold the sentinel? Pure, so the rule is testable without a canvas.
 *  A short buffer answers NO: a readback that gave us less than a pixel is not evidence of health. */
export function sentinelIntact(px: ArrayLike<number>): boolean {
  if (px.length < 4) return false
  for (let i = 0; i < 4; i++) {
    if (Math.abs(px[i] - ATLAS_SENTINEL_RGBA[i]) > SENTINEL_TOLERANCE) return false
  }
  return true
}

/** What the shared layer needs to hear from the atlas page — see `ATLAS_SENTINEL_RGBA`. */
export interface AtlasPageLossHandlers {
  /** The 2D context was lost. The page's pixels are gone; the caller waits for `restored`. */
  lost(): void
  /** The browser handed a fresh, EMPTY 2D context back. The caller's answer is a full rebuild:
   *  there is no restoring the old pixels, only re-rasterizing them from a fresh page. */
  restored(): void
}

/** The page-health surface `createCanvasRasterizer` adds on top of `GlyphRasterizer`. Kept OFF the
 *  atlas's own interface deliberately: the atlas neither calls these nor should have to fake them,
 *  and the only consumer is the shared layer that owns the context's lifetime. */
export interface AtlasPageHealth {
  /** Is the page still the one we rasterized into? False = the backing store was blanked or the
   *  context was lost, and every cached slot now points at nothing. */
  sourceIntact(): boolean
  /** Subscribe to the page's own `contextlost`/`contextrestored`. Never cancels the loss event —
   *  cancelling is how a page REFUSES automatic restoration, and the restore is the signal we
   *  want. */
  onSourceLoss(handlers: AtlasPageLossHandlers): { dispose(): void }
}

export interface RasterFont {
  family: string
  sizePx: number
  /** The cell, in DEVICE pixels — xterm's own `dimensions.device.cell`, NOT a metric measured
   *  here. Fractional widths are expected and must not be rounded on the way in: the atlas's
   *  whole-texel slot pitch is derived separately (`GlyphAtlas.strideX`), and rounding the cell
   *  is what rescales every glyph against the quad it is drawn onto. */
  cellW: number
  cellH: number
  /**
   * The weights this terminal draws at — `settings.fontWeight` / `fontWeightBold`, the same two
   * numbers xterm's own renderers are given.
   *
   * They were missing until 2026-08-09, and the omission was invisible at the defaults: with no
   * weight token a canvas font string means `normal` (400) and the literal `bold` means 700, which
   * is exactly the default pair. Anyone who moved the weight picker got a shared canvas that
   * ignored them and drew LIGHTER than the GPU renderer beside it — the "text isn't so crisp"
   * report, whose real content is "thinner".
   */
  weight: number
  weightBold: number
}

/**
 * A packed colour lane (`packColor`) as a css colour.
 *
 * ALPHA IS DROPPED, deliberately. Every lane that reaches this file has been resolved by the feed
 * into a concrete on-screen colour (default/palette/RGB → inverse → dim → selection/cursor), and
 * those all carry alpha 255 — xterm's own colour manager packs opaque colours for exactly the same
 * reason: the terminal's cells are opaque. Emitting `rgba(...)` off a lane would only matter if a
 * translucent colour ever appeared, and a translucent slot would break the invariant this file
 * exists to hold (an OPAQUE per-slot backdrop for the platform rasterizer to draw over — see the
 * header). So an unexpected alpha is ignored rather than honoured.
 *
 * `>>> 0` first: `0xff << 24` is NEGATIVE in JS, so a lane can arrive as -16777216 from an
 * arithmetic path and as 4278190080 off a cell lane. `unpackColor`'s masks happen to give the same
 * answer for both spellings, so this is not a fix for a live bug — it is the same normalization
 * `GlyphAtlas.glyphFor` applies to its KEY, kept here so the two can never disagree about what
 * "the same colour" means.
 */
function cssColor(packed: number): string {
  const { r, g, b } = unpackColor(packed >>> 0)
  return `rgb(${r},${g},${b})`
}

/**
 * How much a glyph's ink may exceed what its character is entitled to before it is shrunk.
 *
 * Not zero, and the direction matters. `actualBoundingBox*` reports the ANTIALIASED extent, so a
 * perfectly cell-sized glyph routinely measures a fraction of a pixel over — and a zero tolerance
 * would put every full-bleed box-drawing character through a 0.99 scale for nothing, which is both
 * wasted work and a way to introduce a hairline gap in a run of `───` that is currently seamless.
 * (The box-drawing ranges take the geometric path and never reach this, but the aliases and the
 * faces that draw to the cell edge do.)
 *
 * 4% is comfortably above that fringe and far below a real overflow: the 2026-08-05 icon measured
 * roughly a quarter over its cell, and the class this exists for — symbols drawn to a square box in
 * a font whose advance is not square — is never marginal.
 */
const INK_FIT_TOLERANCE = 1.04

/**
 * The floor on shrinking. Below this a glyph has stopped being small and started being unreadable,
 * and a legible fragment beats an illegible whole — so past the floor the clip takes over again and
 * the old truncation is what happens, which is exactly what L16 already describes.
 *
 * Reached only by ink more than ~1.7 cells wide on a character entitled to one, which is not a
 * symbol-in-a-monospace-face any more; it is a face being used at the wrong size.
 */
const MIN_INK_FIT_SCALE = 0.6

/**
 * May this code point be SHRUNK to fit its cell at all?
 *
 * Only symbols. Never letters, digits or ASCII punctuation — and that exclusion is the whole point,
 * because ink overhanging its cell is NORMAL for text rather than a defect. Measured across the
 * monospace faces available here, at the worst glyph of each style:
 *
 *      regular 1.04   bold 1.04   ITALIC 1.19   BOLD ITALIC 1.25    (ink ÷ advance)
 *
 * So a rule that shrinks anything past a few percent shrinks italic text to ~84% and bold-italic to
 * ~80% of the roman text beside it — and PER GLYPH, so inside one italic word the narrow letters
 * stay full size while `K`, `X`, `w` do not. That was the 2026-08-07 report ("some characters are
 * not right") and it was this file's own doing, introduced two days earlier with shrink-to-fit.
 *
 * Every terminal lets a face's overhang spill into the neighbouring cell, whose background is
 * almost always empty. We cannot (the clip that protects the mip chain forbids it), so text keeps
 * the behaviour it has always had here: the tip of the slant is clipped, which is L16 and which
 * nobody has ever reported. Making text SMALLER is a worse answer than clipping it, because it
 * changes the shape of every glyph rather than the last fraction of one.
 *
 * The cut is at U+2000 — below it is Latin, Greek, Cyrillic, Hebrew, Arabic and their punctuation,
 * i.e. text; above it are the arrows, the technical and geometric shapes, the dingbats and the
 * emoji, i.e. things drawn to a BOX whose author expected a square. A ratio cannot make this
 * distinction: bold-italic `X` measures 1.25 and so does the icon the shrink was written for.
 */
export function shrinkEligible(code: number): boolean {
  return code >= 0x2000
}

/**
 * The factor a glyph must be drawn at to fit its entitlement, or exactly 1 for "draw it unchanged".
 *
 * Returning the literal 1 is part of the contract, not an optimisation: the caller branches on it
 * to take the untouched `fillText` path, so every glyph that was never oversized is rasterized by
 * the same call it was before shrink-to-fit existed.
 *
 * A metrics object without `actualBoundingBox*` (or with nonsense in it) yields 1 as well. The
 * fields are standard but this runs on whatever canvas the platform gives us, and the failure to
 * avoid is a NaN scale silently blanking every glyph — declining to shrink just restores the older
 * behaviour for that platform.
 */
export function shrinkToFit(metrics: TextMetrics, allowance: number): number {
  const inkW = metrics.actualBoundingBoxLeft + metrics.actualBoundingBoxRight
  if (!Number.isFinite(inkW) || inkW <= 0) return 1
  if (!Number.isFinite(allowance) || allowance <= 0) return 1
  if (inkW <= allowance * INK_FIT_TOLERANCE) return 1
  return Math.max(MIN_INK_FIT_SCALE, allowance / inkW)
}

/**
 * How thick an underline is, in device pixels, for a font of this size.
 *
 * xterm's own rule (`Math.max(1, floor(fontSize / 15))`), adopted rather than invented so an
 * underline in shared mode is the same weight as the one beside it in GPU mode. The floor of 1 is
 * the load-bearing half: the atlas is rasterized at the DEVICE cell, and a sub-pixel rule would
 * round away to nothing at small sizes — an underline that is simply absent, which is the defect
 * this whole path exists to fix.
 */
export function underlineThickness(fontSizePx: number): number {
  if (!Number.isFinite(fontSizePx) || fontSizePx <= 0) return 1
  return Math.max(1, Math.floor(fontSizePx / 15))
}

/**
 * How close a geometric op's far edge has to come to the cell's far edge to count as REACHING it —
 * see step 2 of `draw` for what reaching one earns.
 *
 * Deliberately tiny, and the tightness is the point. `box-glyphs.ts` emits the two classes of edge
 * with a real gap between them: `span`/`snap` return the extent VERBATIM for anything at or past
 * the boundary (that is the full-cell invariant), and a whole device pixel for everything else. So
 * the epsilon has nothing to bridge — it only absorbs the float noise of reconstructing
 * `op.x + op.w` from the `[start, extent]` pair `span` handed back.
 *
 * A LOOSE tolerance is not the conservative direction, which is easy to get backwards. The obvious
 * `cellW - 0.5` would also capture genuinely INTERIOR edges that happen to land half a pixel short:
 * on a 10.5-wide cell the last dash of ┈ (U+2508) rounds to a right edge of exactly 10, and
 * snapping THAT welds it to the next cell's first dash — turning a rule whose gaps are the whole
 * character into a solid ─. That is not one glyph's edge case: swept over U+2500–U+259F at 152
 * fractional cell sizes, 6681 ops sit inside the band a 0.5 tolerance would have swallowed —
 * U+2504/2505/2508/2509 and U+254c/254d as expected, but also the double rail ║ (U+2551) and
 * U+2553, i.e. solid stems, not just dashes. The edges nobody could confuse either way (a half
 * block's midline at ~cell/2, an arm's own thickness) are orders of magnitude further out than
 * either number; the cases that decide the constant are the near misses, and they want it small.
 *
 * The MISS direction — a reaching edge coming back a hair SHORT, which a tight epsilon would fail
 * to snap, leaving the very grout this exists to remove — cannot happen: `snap` returns the extent
 * VERBATIM at or past the boundary, and both `span` branches reconstruct `x + w` to exactly that
 * extent. The same sweep confirms it empirically (zero ops in `(cell - 1e-6, cell)`).
 *
 * The one case rounding can still weld is the opposite direction and is not the epsilon's doing:
 * `snap`'s `Math.round` can push an INTERIOR edge slightly PAST the fractional cell (U+2508/2509 at
 * cellW 4.95 land on exactly `ceil(cellW)`). The pre-snapping clip cut those at `cellW`; the
 * whole-texel clip does not, so they now fill the partial texel and get edge-extended. It needs a
 * cell under ~6 device px (a ~4px font) and can never exceed `ceil(cell)`, so it stays inside the
 * slot's own box — named here because it is the only remaining path by which a dashed rule can
 * appear continuous.
 */
const FAR_EDGE_EPS = 1e-6

/**
 * Where the alphabetic baseline sits inside the cell, in device px.
 *
 * The rule a CSS line box uses — HALF-LEADING: the font's natural line box (ascent + descent) is
 * centered in the cell and the baseline falls `ascent` below that box's top. xterm's DOM renderer
 * is a stack of divs with `line-height` set to the cell height, so this is literally where its
 * glyphs land; deriving the same number is what keeps the shared renderer from drawing every row
 * a couple of pixels off from the renderer it replaces.
 *
 * `fontBoundingBox*` is optional in the spec, so the old fixed `0.8 * cellH` stays as the
 * fallback — it is within a pixel for the usual monospace faces, and a missing metric must not
 * mean "no text".
 *
 * Clamped into the cell: a font whose line box is much taller than the cell would otherwise put
 * the baseline outside the slot, and every draw is clipped to it (see below) — the glyph would
 * simply vanish.
 *
 * WHY NOT xterm's CONVENTION (checked in round 6, deliberately left alone). The WebglAddon's
 * `_drawToCache` sets `textBaseline = TEXT_BASELINE` (`'ideographic'`, `'bottom'` on Firefox) and
 * draws at `y = padding + deviceCharHeight` — i.e. the bottom of the char box is pinned to the
 * char height and any extra `lineHeight` leading falls entirely BELOW the glyph. Two reasons ours
 * stays as it is:
 *   - At the default `lineHeight: 1` the two agree to within rounding. `deviceCharHeight` is the
 *     measured line box (`ceil(charSize.height * dpr)`, DomRenderer `_updateDimensions`), so
 *     `cellH ≈ asc + desc`, the half-leading term collapses to ~0 and our baseline lands on `asc`
 *     — the same row xterm's ideographic-at-cell-bottom resolves to.
 *   - Both land on a WHOLE device pixel: xterm's `deviceCharHeight` is `ceil`'d, ours is
 *     `Math.round`'d. Sharpness is what a fractional baseline would cost (the atlas is sampled 1:1
 *     with NEAREST, so a half-texel of vertical ink offset is a different cut per glyph); an
 *     integer baseline has no such cost, and any residual disagreement is ≤0.5px of PLACEMENT, not
 *     of crispness.
 * Where they genuinely differ (`lineHeight != 1`) the half-leading answer is the one that matches
 * the DOM renderer these terminals fall back to, so it is the one worth keeping.
 */
function baselineIn(ctx: OffscreenCanvasRenderingContext2D, font: RasterFont): number {
  ctx.font = `${font.sizePx}px ${font.family}`
  const m = ctx.measureText('W')
  const asc = m.fontBoundingBoxAscent
  const desc = m.fontBoundingBoxDescent
  const fallback = Math.round(font.cellH * 0.8)
  if (!Number.isFinite(asc) || !Number.isFinite(desc) || asc + desc <= 0) return fallback
  const baseline = Math.round((font.cellH - (asc + desc)) / 2 + asc)
  return Math.max(1, Math.min(Math.ceil(font.cellH), baseline))
}

/** Draws each glyph in its REAL foreground colour over its REAL background — the colour-keyed
 *  atlas xterm's own TextureAtlas builds — baseline-centered in the cell like xterm's renderers.
 *  Returns null when OffscreenCanvas 2D is unavailable — caller keeps the DOM renderer.
 *
 *  THE BACKDROP, AND WHY THIS IS STILL THE ROUND-6 PROPERTY. macOS rasterizes text drawn onto a
 *  TRANSPARENT backdrop thinner and softer than the same text drawn over an opaque one, which is
 *  what made plain text look softer than the per-terminal WebglAddon. xterm never rasterizes onto
 *  transparency either — read `_drawToCache` in @xterm/addon-webgl: before every `fillText` it does
 *  `globalCompositeOperation='copy'; fillStyle=backgroundColor.css; fillRect(...)`, i.e. it hands
 *  the platform a fully painted backdrop. Round 6 approximated that with a page-wide opaque BLACK
 *  fill plus a white-ink/coverage-in-the-red-channel encoding that the shader re-mixed; that
 *  encoding is GONE (the re-mix had no correct gamma — see atlas.ts's header). The property it was
 *  protecting is not: every slot's PITCH RECT is filled with that slot's own opaque background
 *  before any ink lands, so CoreText still draws over an opaque backdrop. The page-wide black fill
 *  must NOT come back — it would put opaque black in slot 0, which every space samples.
 *
 *  The context is deliberately still `alpha: true` — exactly like xterm's tmp canvas, which is a
 *  plain `document.createElement('canvas')`. The opacity that matters is the PAINTED backdrop, not
 *  the backing store's format, and an alpha-less canvas would additionally let Chromium turn on
 *  LCD/subpixel antialiasing, whose per-channel coverage the RGBA blit would bake in per channel.
 *
 *  THE PAGE INVARIANT, in one line: every texel of a slot's PITCH rect carries content OWNED BY
 *  THAT SLOT, and no slot's content can reach another slot's texels at any level up to
 *  MAX_SAFE_LOD.
 *
 *  Stated that way on purpose — an earlier wording claimed the inter-slot page ground is "never
 *  sampled at LOD <= MAX_SAFE_LOD", which overstates it. Unallocated pitch cells DO enter a level-2
 *  texel wherever the page is not yet full: at the allocation frontier, in the page's right/bottom
 *  remainder strip, and throughout a repack that has just called `clearPage`.
 *
 *  What that looks like is NOT the background-vs-background blend GUTTER_PX's comment names, and the
 *  two must not be conflated — same accepted-residual STATUS, different visual signature. The atlas
 *  texture is NON-premultiplied (the default `UNPACK_PREMULTIPLY_ALPHA_WEBGL` is false), so a mip
 *  level averages rgb and alpha INDEPENDENTLY: an edge texel that is half opaque background and half
 *  transparent ground comes out as a HALF-BRIGHTNESS colour at HALF alpha, and the `SRC_ALPHA`
 *  blend then attenuates that already-darkened colour by that same alpha again. The result is a
 *  darker, slightly translucent rim on the outermost row/column of the affected cells at heavy
 *  zoom-out, with the node's plate showing through it — bounded, cosmetic, and self-healing as the
 *  page fills. Should the device round judge it objectionable, the escalation is to upload
 *  premultiplied (`UNPACK_PREMULTIPLY_ALPHA_WEBGL` true) and blend `ONE, ONE_MINUS_SRC_ALPHA`, which
 *  makes the average correct instead of double-counted. Device evidence first — it is not built now.
 *
 *  HALF OF THAT ESCALATION HAS SINCE LANDED, so do not re-do it and do not read the residual above
 *  as still whole. The BLEND half arrived with the rounded occlusion plate — `gl-webgl2.ts` now sets
 *  `blendFuncSeparate(SRC_ALPHA, ONE_MINUS_SRC_ALPHA, ONE, ONE_MINUS_SRC_ALPHA)`, i.e. `ONE` on the
 *  source ALPHA — which is what the plate's antialiased corner needed and which closes the
 *  PAGE-BLEED half of this rim on the way: a half-alpha rim texel used to leave the surface only
 *  three-quarters opaque, so the plate under a cell that had already been painted showed through it.
 *  It no longer does. What is left is the COLOUR half alone — the non-premultiplied UPLOAD still
 *  hands the blend an already-darkened average, so the rim reads slightly dark at heavy zoom-out.
 *  That, and only that, is what the device round now judges, and
 *  `UNPACK_PREMULTIPLY_ALPHA_WEBGL` is the whole of what would close it.
 *
 *  The promise that actually matters, and the one the LOD derivation rests on, is about INK.
 *
 *  Unpacked, the four things this file must not break:
 *  1. The page ground starts (and `clearPage` returns to) TRANSPARENT-black. The atlas's slot 0 —
 *     the pitch cell at 0,0 — is permanently blank and is what every space/unknown code point
 *     names; `GlyphAtlas` never asks for slot 0, so nothing is ever drawn there and it stays
 *     transparent. Note what that no longer buys: the shader does NOT sample slot 0 for a blank
 *     cell — it branches on the glyph LANE being 0 and paints the cell's own bg lane, which is
 *     what keeps a selection or a block cursor visible on an empty cell. Slot 0 staying blank is
 *     therefore belt-and-braces (a lane that somehow reached it draws nothing rather than a
 *     stranger's glyph) plus one real duty: it is a mip neighbour like any other slot, and ink
 *     there would bleed into slot 1's minified texels.
 *  2. A slot's whole pitch rect is REPAINTED with its background before it is inked, so reusing a
 *     cell after a reset can never leave a previous glyph's ink or a previous background behind.
 *  3. NO GLYPH DRAWS NEW GEOMETRY INTO THE GUTTER. Every glyph is clipped to this slot's own CELL
 *     BOX — one gutter inside the pitch rect on each axis — so two slots' inks stay 2*GUTTER_PX
 *     texels apart, which is exactly the separation `MAX_SAFE_LOD = 2` is derived from (see
 *     GUTTER_PX in atlas.ts). A glyph wider than the cell (a CJK cell, an overhanging italic) is
 *     CUT, not allowed to overhang: a soft edge is a cosmetic loss on one glyph, a ghost glyph in
 *     a neighbour's mip is a rendering bug.
 *
 *     "Cell box" rather than "cell rect" since the 2026-08-04 device round: the FONT path is
 *     clipped to the fractional cell exactly as before, while the GEOMETRY path is clipped to the
 *     WHOLE-TEXEL box (`ceil(cell)`) because its far edges snap out to it — see step 2 in `draw`.
 *     The separation is unchanged either way: the pitch IS the whole-texel box plus two gutters, so
 *     the widened clip stops exactly where the gutter starts.
 *
 *     THE GENERAL CLASS THIS CUT BELONGS TO — name it, because it keeps arriving one glyph at a
 *     time. A font-drawn glyph whose INK EXCEEDS ITS CELL is clipped here and the overflow is simply
 *     lost. xterm's own `TextureAtlas` has no such limit: it MEASURES each glyph's real bounding
 *     box, sizes the atlas slot to the ink, and renders a quad of that size — so ink may overhang
 *     into the neighbouring cells, which is why GPU mode shows shapes this path truncates. The
 *     2026-08-04 device round measured one: U+23BF ⎿, Claude Code's tool-result connector, kept
 *     about a third of its horizontal foot (8 px against GPU mode's 28).
 *
 *     ONE MEMBER OF THE CLASS IS NOW OUT OF IT: a DOUBLE-WIDTH character (emoji, CJK). Its overflow
 *     was never really overflow — the terminal has already reserved a second cell for it — so it
 *     needs no ink-sized slot, only a second cell-sized one holding the character's right half
 *     (`half` above, and `GlyphAtlas.glyphFor`). Before that, ⭐ rendered as a fragment: the
 *     2026-08-05 device round. Everything this clip defends is untouched by it, because each half
 *     is still clipped to its own cell box.
 *
 *     THE ESCAPE HATCH USED SO FAR is `box-glyphs.ts`: a glyph we DRAW is full-cell by construction,
 *     so the clip has nothing to cut. That covers line art — the box-drawing and block ranges, plus
 *     the handful of Misc-Technical aliases the ⎿ finding added — and it is the right answer for
 *     that class, since those characters are DEFINED as fractions of the cell.
 *
 *     THE REAL ESCALATION, if a NON-line-art, SINGLE-WIDTH glyph ever needs the overflow (an ornate
 *     script face, a symbol font with genuine side bearings), is to do what xterm does: measure a
 *     per-glyph
 *     bounding box, allocate slots sized to the INK rather than to the cell, and emit quads sized to
 *     the glyph rather than to the cell. That reaches into the atlas allocator, the slot-rect
 *     derivation and the shader's uv maths all at once, and it changes what the LOD/gutter argument
 *     is defending. Phase 2 — do NOT build it now.
 *
 *     What the gutter then HOLDS is a separate question, and the answer changed in the 2026-08-04
 *     device round: it carries this slot's OWN EDGE-EXTENDED CONTENT — background wherever the ink
 *     does not reach the cell edge (all ordinary text, i.e. bit-identical to the old flat bg fill),
 *     the edge ink where it does (blocks, box-drawing lines, progress bars). What must never enter
 *     the gutter is a NEIGHBOUR's content, and pitch tiling still guarantees exactly that. See
 *     step 3 in `draw` for why a bg-only gutter grew a dark seam between full-bleed cells.
 *  4. The background fill covers the pitch EXACTLY — not more (it would erase a neighbour's
 *     gutter, and with it that neighbour's mip skirt) and not less (a strip of page ground inside
 *     the mip neighbourhood would blend transparency into the slot at LOD 1/2).
 *
 *  And one thing it must not START doing: draw the box-drawing / block-element ranges with the
 *  FONT. `boxGlyphOps` gets first refusal on every code point (see box-glyphs.ts for why — fonts
 *  do not fill the cell, so a run of ─ came out as a dashed line and block art as a dark lattice),
 *  and `fillText` is the fallback for everything it declines. */
export function createCanvasRasterizer(
  font: RasterFont,
  atlasSizePx: number
): (GlyphRasterizer & AtlasPageHealth) | null {
  if (typeof OffscreenCanvas === 'undefined') return null
  const canvas = new OffscreenCanvas(atlasSizePx, atlasSizePx)
  const ctx = canvas.getContext('2d', { alpha: true })
  if (!ctx) return null
  ctx.textBaseline = 'alphabetic'
  /** One texel, in the one place nothing samples — see `ATLAS_SENTINEL_RGBA`. Unclipped and
   *  unsaved, because it runs only where no clip is installed (construction and `clearPage`). */
  const paintSentinel = (): void => {
    ctx.fillStyle = SENTINEL_CSS
    ctx.fillRect(0, 0, 1, 1)
  }
  // NOTHING ELSE is painted here. A fresh OffscreenCanvas is already transparent-black, which is the
  // page ground this atlas wants; the backdrop the platform rasterizer needs is per-slot and is
  // painted in `draw`. (Round 6's page-wide opaque black fill lived here — see the header for why
  // it must not come back.) The sentinel is one texel of slot 0's GUTTER, so every SAMPLED rect on
  // the page — slot 0's cell box included — is still transparent-black.
  paintSentinel()
  const baseline = baselineIn(ctx, font)
  // The slot pitch, from the SAME helper the atlas lays the page out with — the background fill
  // below has to cover exactly one pitch cell.
  const pitchW = slotPitch(font.cellW)
  const pitchH = slotPitch(font.cellH)
  // The WHOLE texel columns/rows the cell occupies — the pitch minus its two gutters, by
  // construction (`slotPitch` is `max(1, ceil(cell)) + 2*GUTTER_PX`). The edge extension works in
  // these rather than in the fractional cell because a texel is the smallest thing it can copy,
  // and deriving them from `slotPitch`'s own expression is what keeps "cell box + two gutters ==
  // pitch" true for a sub-texel cell too.
  const colsW = Math.max(1, Math.ceil(font.cellW))
  const colsH = Math.max(1, Math.ceil(font.cellH))
  // The last FULLY COVERED texel column/row of the cell, as an offset from the ink origin — the
  // SOURCE of the far-edge replication strips (step 3 in `draw` carries the coverage table that
  // picks it). `floor(cell) - 1` is one formula for both cases: an INTEGRAL 10 gives 9, the cell's
  // last texel, identical to the `colsW - 1` it replaces; a FRACTIONAL 10.5 also gives 9, stepping
  // over texel 10 — the half-covered edge texel, whose antialiased ink/background blend is exactly
  // what must not be smeared across the whole gutter. `max(0, …)` is the sub-texel case
  // (`cell < 1` → -1): there is no fully covered texel at all, and the slot's single partial one is
  // the only thing there is to replicate.
  const lastFullCol = Math.max(0, Math.floor(font.cellW) - 1)
  const lastFullRow = Math.max(0, Math.floor(font.cellH) - 1)
  return {
    cellW: font.cellW,
    cellH: font.cellH,
    get source() {
      return canvas
    },
    /** Blank the page back to the state `createCanvasRasterizer` leaves it in: TRANSPARENT-black,
     *  everywhere. `clearRect`, not a fill — a fill of any colour would give slot 0 (and every
     *  never-allocated pitch cell) an opaque colour, and slot 0 is what every space samples. */
    clearPage() {
      ctx.clearRect(0, 0, atlasSizePx, atlasSizePx)
      // ...and back to that state EXACTLY, sentinel included. A reset is a normal event, so a page
      // left without one would read as a lost 2D context on the next revive and rebuild the whole
      // canvas for nothing.
      paintSentinel()
    },
    /** The health check the revive path runs. Two questions, cheapest first: has the context
     *  declared itself lost, and — the case that fires no event at all — is the page still the one
     *  we painted?
     *
     *  A readback that THROWS answers "intact". It tells us nothing about the page, and treating an
     *  unavailable `getImageData` as a loss would rebuild the whole canvas on every restore, which
     *  is worse than the bug. */
    sourceIntact() {
      const lost = (ctx as { isContextLost?: () => boolean }).isContextLost
      if (typeof lost === 'function' && lost.call(ctx)) return false
      try {
        return sentinelIntact(ctx.getImageData(0, 0, 1, 1).data)
      } catch {
        return true
      }
    },
    onSourceLoss(handlers) {
      const target = canvas as unknown as {
        addEventListener?: (type: string, fn: (e: Event) => void) => void
        removeEventListener?: (type: string, fn: (e: Event) => void) => void
      }
      // An OffscreenCanvas that is not an EventTarget (an old runtime, a test double) degrades to
      // "not watched" — `sourceIntact` is still the backstop, and it needs no events.
      if (typeof target.addEventListener !== 'function') return { dispose: () => undefined }
      // DELIBERATELY NOT `preventDefault()`. On a 2D canvas, cancelling `contextlost` tells the
      // browser NOT to restore automatically — the opposite of the WebGL convention, where
      // cancelling is how you ASK for the restore. The restore is what we are waiting for: it is
      // the moment a fresh page can be rasterized into.
      const onLost = (): void => handlers.lost()
      const onRestored = (): void => handlers.restored()
      target.addEventListener('contextlost', onLost)
      target.addEventListener('contextrestored', onRestored)
      return {
        dispose: () => {
          target.removeEventListener?.('contextlost', onLost)
          target.removeEventListener?.('contextrestored', onRestored)
        }
      }
    },
    /** `x, y` is the INK origin the atlas hands us — already one gutter inside the pitch cell on
     *  each axis (`GlyphAtlas.cellXY`) — and `fg`/`bg` are the FINAL packed colour lanes for this
     *  slot. Two DIFFERENT rects are involved; see the header's invariants 3 and 4. */
    draw(code, bold, italic, x, y, fg, bg, part = 'whole', underline = false) {
      // The glyph's own origin inside this slot. 'wide-right' is the RIGHT half of a double-width
      // character (see `GlyphAtlas.glyphFor`): the character is drawn one cell FURTHER LEFT, so the
      // window this slot's clip keeps is its second cell instead of its first. Everything else
      // below is untouched — same clip, same pitch fill, same edge extension — because that fix is
      // about WHICH part of the glyph a cell-sized slot holds, not about the slot's size.
      //
      // The shift is the FRACTIONAL cell, not a whole texel, so the two halves meet exactly where
      // the two on-screen cells meet (cells are laid out on the fractional cell pitch too). The
      // cost is that the right half is rasterized at a different sub-texel PHASE than the left —
      // its antialiasing can differ by a fraction of a pixel along the seam. That is the honest
      // trade: a phase difference is a hairline, a whole-texel shift would be a visible break in
      // the character.
      const inkX = part === 'wide-right' ? x - font.cellW : x
      // What this character is ENTITLED to, in px — one cell, or two for a double-width one. The
      // shrink below measures against this, never against the slot: both halves of a wide glyph are
      // the same drawing spread over two cells, so measuring either against ONE cell would squash
      // it back into the fragment the two-slot mechanism exists to prevent.
      const allowance = partCells(part) * font.cellW
      // 1. THE BACKGROUND, over the whole PITCH rect — gutters included. The atlas passes the INK
      //    origin, so the pitch cell's corner is one gutter back on each axis; its extent is the
      //    pitch, which is `ceil(cell) + 2*GUTTER_PX`. Both are whole texels and consecutive pitch
      //    cells are exactly `pitch` apart, so this fill tiles its own slot and touches no other.
      //    It also repaints everything a previous tenant of this slot left behind.
      //    UNCLIPPED, and the two candidate clips fail differently: a CELL clip — the one installed
      //    below for the ink — would be actively WRONG here, since it is exactly the gutter (the
      //    part of the pitch outside the cell) that has to carry this slot's own content for the
      //    mip chain to blend this slot with itself instead of with page ground. A PITCH clip
      //    would merely be REDUNDANT: the rect is already exact and `cellXY` is the only source of
      //    the origin, so there is nothing for it to catch.
      //    This is the BASE layer of the gutter, not the last word on it: step 3 replaces the parts
      //    of it that sit against ink with that ink, and leaves the rest exactly as filled here.
      ctx.fillStyle = cssColor(bg)
      ctx.fillRect(x - GUTTER_PX, y - GUTTER_PX, pitchW, pitchH)
      // 2. THE INK, clipped to THIS SLOT'S OWN CELL BOX — never the pitch rect. The box always fits
      //    inside the pitch (the pitch is the box plus a gutter on each side), so no glyph can
      //    generate geometry closer than GUTTER_PX to the next slot, which is the separation
      //    MAX_SAFE_LOD = 2 is derived from. A glyph that overflows it is CUT here. (Step 3 may
      //    then COPY this ink outward into our own gutter — a copy of our own content, never a
      //    reason to relax this clip.)
      //
      //    WHICH box, though, is decided PER BRANCH, and the two must not be merged into one
      //    widened clip:
      //      - GEOMETRY gets the WHOLE-TEXEL box (`colsW`/`colsH`), because its far edges snap out
      //        to it (see below) and a fractional clip would simply cut the snap back off.
      //      - the FONT keeps the FRACTIONAL cell. A glyph's partial far column is genuine
      //        antialiased glyph edge drawn by the platform rasterizer — real content — and letting
      //        it spill into the extra texel would be overwriting pixels rather than completing a
      //        shape we generated ourselves.
      //    Both are inside the pitch, so the LOD derivation is untouched either way.
      //
      // Geometry first: these ranges are DEFINED as fractions of the cell, so drawing them is
      // both more correct and cheaper than trusting the face. The ops are already snapped to
      // device px (interior edges) and to the exact cell bounds (outer edges), so no seam can
      // appear between two adjacent cells and no rect lands on a half pixel.
      // `PaintOp` is alpha-free by construction (x/y/w/h only) — including the shade blocks, which
      // are DITHER patterns rather than tints. So `globalAlpha` is never touched here and a stipple
      // reads as foreground PIXELS over the background fill, which is exactly what xterm's own
      // patterns are.
      const geometry = boxGlyphOps(code, font.cellW, font.cellH)
      ctx.save()
      ctx.beginPath()
      ctx.rect(x, y, geometry ? colsW : font.cellW, geometry ? colsH : font.cellH)
      ctx.clip()
      ctx.fillStyle = cssColor(fg)
      if (geometry) {
        for (const op of geometry) {
          // FAR-EDGE SNAPPING (device round, 2026-08-04, second mascot screenshot). An op whose
          // span REACHES the cell's far edge has that edge grown to the whole texel; every other
          // edge is left exactly where box-glyphs.ts put it.
          //
          // WHY. A device cell is `charWidth * dpr` and fractional in general, so the cell's
          // outermost texel is only PARTLY covered and a full-bleed geometric glyph leaves it as an
          // ink/background blend (0.5 ink on a .5 axis). Step 3 can continue whatever is beside it
          // but can never fix the texel itself — it belongs to the cell — which is the residual the
          // edge-extension comments predicted and the device round then measured: dips of 4–38
          // points surviving on the fractional axis after the gutters were extended.
          //
          // It is not merely paperable, it is WRONG where it matters most. At an INK|INK boundary
          // (a block interior, a run of tmux rules — the reported defect) the other half of that
          // pixel in the COMPOSED frame is the NEIGHBOUR CELL'S ink, so the correct colour is FULL
          // ink and the snap makes the zoom-1 sample EXACTLY right, not merely closer. At an
          // ink|background SILHOUETTE edge both spellings are approximations of a partly-covered
          // pixel: the snap wins on the cell phases the sampler actually lands on at the sizes in
          // use, and where it loses it is by less than the fractional part of one pixel's coverage
          // — the same order as the NEAREST-at-1:1 error that has always been there. So expect a
          // marginally HARDER silhouette on block art at zoom 1; that is this change, not a defect.
          // xterm never meets any of this because its atlas cells are integral device
          // px — the whole-texel box is the closest thing this atlas has to that, so a glyph that
          // is DEFINED as filling its cell is drawn as filling the box. Step 3's replication then
          // continues real ink into the gutter and the geometry path's residual goes to zero.
          //
          // FONT-rendered glyphs are excluded on purpose (see the clip above), so the residual
          // survives for full-bleed glyphs drawn by the face — rare, since the block and
          // box-drawing ranges come through here whenever box-glyphs.ts has an entry for them.
          //
          // The STIPPLES (░▒▓) need no special case: a dither run that happens to end on the cell
          // edge grows by the same partial texel, which reads as ~50% tone either way at the sizes
          // a shade block is ever looked at.
          //
          // NEAR edges need nothing at all. `span`'s `snap` returns a literal 0 for anything at or
          // before the near edge, and the ink origin is a whole texel (`GlyphAtlas.cellXY` derives
          // it from the whole-texel pitch) — so a near edge is already flush with a texel boundary
          // and there is no partial texel to complete.
          const w = op.x + op.w >= font.cellW - FAR_EDGE_EPS ? colsW - op.x : op.w
          const h = op.y + op.h >= font.cellH - FAR_EDGE_EPS ? colsH - op.y : op.h
          // `inkX`, not `x`: a geometric glyph is defined as a fraction of ONE cell, so on `half: 1`
          // every op lands entirely left of the clip and the slot comes out blank — which is the
          // right answer, since a cell-defined glyph has no second cell. (No wide character is
          // claimed by box-glyphs.ts today, so this is a floor rather than a live path.)
          ctx.fillRect(inkX + op.x, y + op.y, w, h)
        }
      } else {
        // NUMERIC weights, not the `bold` keyword: the keyword is 700 and nothing else, so it
        // silently discarded a user's 600 or 800. `italic` stays a keyword because it is one.
        ctx.font = `${italic ? 'italic ' : ''}${bold ? font.weightBold : font.weight} ${font.sizePx}px ${font.family}`
        const glyph = String.fromCodePoint(code)
        // SHRINK-TO-FIT, the 2026-08-05 device finding (an agent CLI's task-list icon rendering
        // with its right edge sliced off; GPU mode showed it whole).
        //
        // A symbol whose ink is wider than its cell used to be CUT by the clip above, and the clip
        // cannot simply be relaxed — ink in the gutter is what the MAX_SAFE_LOD derivation forbids,
        // and the result is a ghost of this glyph in a neighbour's minified texels. So the glyph is
        // made to fit instead of being trimmed to fit.
        //
        // WHY THIS RATHER THAN WHAT XTERM DOES. xterm measures every glyph, sizes its atlas slot to
        // the INK and emits a quad of that size, so ink legitimately overhangs into neighbouring
        // cells. That is the honest answer and it is also the expensive one: it reaches the atlas
        // allocator, the slot-rect derivation and the shader's uv maths at once, and it rewrites
        // what the gutter argument defends. This is the cheap approximation of the same intent, and
        // its cost is stated plainly: an oversized glyph renders slightly SMALLER here than in GPU
        // mode. Smaller and whole beats full-size and severed — but it is not parity, and the
        // ink-sized-slot escalation is still the thing that would deliver parity.
        //
        // Ordinary text is untouched, and that is load-bearing: a Latin glyph's ink never
        // approaches its advance, the tolerance absorbs an antialiasing fringe, and a scale of
        // exactly 1 takes the SAME `fillText` call the code took before this existed. So no
        // rendering anyone has already looked at moves.
        const metrics = ctx.measureText(glyph)
        const scale = shrinkEligible(code) ? shrinkToFit(metrics, allowance) : 1
        if (scale === 1) {
          ctx.fillText(glyph, inkX, y + baseline)
        } else {
          // Scaled about the BASELINE, so the glyph keeps sitting on the same line as its
          // neighbours — a symbol that shrank AND rose would read as misaligned rather than small.
          // Horizontally it is re-centred inside the allowance, because an oversized glyph is
          // typically a symbol drawn to fill its box: left-anchoring the shrunk version would park
          // it against the previous character with a gap on the right.
          const inkW = metrics.actualBoundingBoxLeft + metrics.actualBoundingBoxRight
          ctx.save()
          ctx.translate(
            inkX + (allowance - scale * inkW) / 2 + scale * metrics.actualBoundingBoxLeft,
            y + baseline
          )
          ctx.scale(scale, scale)
          ctx.fillText(glyph, 0, 0)
          ctx.restore()
        }
      }
      ctx.restore()
      // 2b. THE UNDERLINE, if this cell carries one.
      //
      //    Drawn HERE, after the ink clip is dropped, and with its own WHOLE-TEXEL clip — the same
      //    box the geometry branch uses. It is geometry WE generate, not something the face drew,
      //    so it wants the box for the same reason box-drawing does: a fractional cell's outermost
      //    texel is only partly covered, and a rule that stops inside it leaves a gap at every cell
      //    boundary. Spanning the box makes consecutive underlined cells join into one continuous
      //    line, which is the whole point of an underline under a run of text.
      //
      //    It is BAKED INTO THE SLOT rather than drawn as an overlay pass, because an underline is
      //    part of how a cell looks: the atlas is already keyed by colour and style, `underline` is
      //    one more key lane, and the shader needs no new concept at all. The cost is a second slot
      //    for text that appears both underlined and not — which is what a hovered link is, and it
      //    is bounded by the same reset the colour keys already live with.
      //
      //    Position and thickness follow xterm's own: a line at the BOTTOM of the cell (descenders
      //    cross it, exactly as in every terminal), one device pixel scaled with the font so it
      //    stays visible at large sizes and never disappears at small ones.
      if (underline) {
        ctx.save()
        ctx.beginPath()
        ctx.rect(x, y, colsW, colsH)
        ctx.clip()
        ctx.fillStyle = cssColor(fg)
        const thickness = underlineThickness(font.sizePx)
        ctx.fillRect(x, y + colsH - thickness, colsW, thickness)
        ctx.restore()
      }
      // 3. THE EDGE EXTENSION — clamp-to-edge padding, the standard atlas technique. Replicate the
      //    cell's outermost texel row/column outward into the gutter, so the gutter continues the
      //    cell instead of falling back to flat background.
      //
      //    WHY (device round, 2026-08-04). The Claude mascot — solid block glyphs — grew dark
      //    "grout" lines along every cell boundary at zoom < 1, and tmux's │ ─ pane separators went
      //    dashed. The signature was exact: dips at the cell PITCH, deepest ≈ (ink+bg)/2 — a mip
      //    texel averaging cell-edge INK with the slot's bg-filled gutter. Ordinary text never
      //    showed it because its outer texels are background anyway; every glyph whose ink TOUCHES
      //    the cell edge did. GPU mode is immune because CSS downscales the COMPOSED frame, where
      //    a cell edge blends with the NEIGHBOUR'S ink rather than with per-slot background.
      //
      //    The MAX_SAFE_LOD derivation never asked the gutter to be BACKGROUND — it asks that
      //    levels 0..2 be free of the NEIGHBOUR's texels, which pitch tiling gives regardless of
      //    what this slot writes into its own gutter. So the gutter may carry this slot's edge
      //    colour, and then a minified sample at the cell edge keeps averaging ink with ink.
      //
      //    THE SAMPLED EXTENT DOES NOT CHANGE. `GlyphAtlas.slotRect` (and the shader's derivation
      //    of it) still spans exactly the cell — the extension is a mip/filter SKIRT, not extra
      //    glyph. Growing the uv rect to include the gutter would pull the padding into the glyph
      //    at zoom 1 and stretch every cell by two texels; that is a different (and wrong) change.
      //
      //    UNIFORM, never conditional: this runs for every glyph, including the ones whose ink
      //    stops short of the SOURCE texels (`lastFullCol`/`lastFullRow` on the far edges, col/row
      //    0 on the near ones) — there it copies background over background and is a visual no-op,
      //    bit-identical to what the fill in step 1 already left. A glyph whose ink reaches the
      //    last FULL texel but not the partial one beyond it (a wide bold stem on a fractional
      //    axis, say) does smear that texel's blend into a gutter that used to stay pure
      //    background — the same bounded, same-direction correction as the full-bleed case below,
      //    just smaller. Detecting "does this glyph bleed?" would cost a readback per slot and buy
      //    nothing.
      //
      //    OUTSIDE THE CLIP, deliberately: `ctx.restore()` above has dropped the CELL clip, and it
      //    would eat these strips whole — they land entirely in the gutter, which is the part of
      //    the pitch that clip exists to exclude.
      //
      //    The source is the page CANVAS ITSELF. A self-referencing `drawImage` is well-defined in
      //    2D canvas (the source region is read as a snapshot before anything is written), which is
      //    what lets the top/bottom strips below read a row the side strips have just extended.
      //
      //    FRACTIONAL CELLS — why the far-edge strips source `lastFullCol`/`lastFullRow` rather
      //    than the cell's outermost texel. A device cell is `charWidth * dpr` and is fractional in
      //    general, so its outer edge falls INSIDE a texel: that texel is only partially covered by
      //    the cell, and the rasterizer leaves it as an antialiased blend of ink and background
      //    (0.5 ink on a .5 cell). It is genuine cell content and STAYS exactly where it is — the
      //    question is only what the GUTTER beside it should continue.
      //
      //    Take a full-bleed cell (ink = 1, background = 0) with a .5-fractional width, and read
      //    off the level-2 block that straddles the boundary — four columns: the last full column,
      //    the half-covered edge texel, and the two gutter texels:
      //
      //      gutter holds            block                average   dip vs solid ink
      //      ─────────────────────── ──────────────────── ───────── ────────────────
      //      background (before)     1, 0.5, 0,   0         37.5%      62.5 pts
      //      the PARTIAL texel       1, 0.5, 0.5, 0.5      62.5%      37.5 pts
      //      the last FULL texel     1, 0.5, 1,   1        87.5%      12.5 pts
      //
      //    Replicating the partial texel is not wrong — it is still this slot's own edge colour —
      //    but it carries the half-coverage outward and leaves a visibly reduced grout dip on that
      //    axis. Sourcing one texel further in is what a COMPOSED-frame downscale would see: the
      //    neighbouring cell's ink begins mid-texel, so beyond the boundary the colour is solidly
      //    the neighbour's, not a fade to background.
      //
      //    RESIDUAL, stated so nobody hunts for it — AND SO NOBODY CLOSES THE WRONG REPORT: 12.5
      //    points, from the partial texel itself, which no gutter content can cancel because it
      //    belongs to the cell. Only an axis whose device cell extent is fractional has it at all,
      //    and since FAR-EDGE SNAPPING (step 2) it applies to FONT-rendered glyphs ONLY: a
      //    geometric glyph's partial texel is fully inked before it gets here, so block art and
      //    box-drawing rules have no residual left. Grout on the mascot or on tmux separators is
      //    therefore a REAL defect to escalate, not this documented limitation — the device
      //    checklist (§2.7c residual 0b) classes it as blocking for exactly that reason.
      const prevSmoothing = ctx.imageSmoothingEnabled
      // A 1-texel source stretched over GUTTER_PX texels must REPLICATE, not resample: with
      // smoothing on the copy would fade back towards whatever the gutter held, which is the
      // background this whole step exists to get out of the way.
      ctx.imageSmoothingEnabled = false
      try {
        // ORDER: the two SIDE strips first, over the cell's rows only; then the two full-PITCH-wide
        // ROW strips. By the time the top strip copies row `y`, that row already carries the side
        // strips' texels in the left and right gutters — so each corner of the gutter ends up
        // holding the cell's CORNER texel, which is what a clamp-to-edge pad means. Doing the rows
        // first (and the sides over the full pitch height) would work equally well; what must not
        // happen is both passes covering only the cell's own extent, which leaves the four corner
        // squares as stale background.
        //
        // The DESTINATIONS tile the gutter frame exactly — the pitch rect minus the cell's
        // whole-texel box, no overlap and no gap — on a fractional cell too, because `colsW`/`colsH`
        // come from `slotPitch`'s own expression. Only the far-edge SOURCES step inward.
        ctx.drawImage(canvas, x, y, 1, colsH, x - GUTTER_PX, y, GUTTER_PX, colsH)
        ctx.drawImage(canvas, x + lastFullCol, y, 1, colsH, x + colsW, y, GUTTER_PX, colsH)
        ctx.drawImage(
          canvas,
          x - GUTTER_PX,
          y,
          pitchW,
          1,
          x - GUTTER_PX,
          y - GUTTER_PX,
          pitchW,
          GUTTER_PX
        )
        ctx.drawImage(
          canvas,
          x - GUTTER_PX,
          y + lastFullRow,
          pitchW,
          1,
          x - GUTTER_PX,
          y + colsH,
          pitchW,
          GUTTER_PX
        )
      } finally {
        // `finally`, not a trailing assignment: `imageSmoothingEnabled` is PAGE-WIDE state, and a
        // draw that threw part-way (a context lost mid-repack, say) would otherwise leave every
        // later slot's fills unsmoothed for the rest of the session — a permanent, invisible change
        // to a global from a transient failure.
        ctx.imageSmoothingEnabled = prevSmoothing
      }
    }
  }
}
