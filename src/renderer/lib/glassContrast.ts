/**
 * The contrast guarantee behind glass terminal nodes.
 *
 * A glass node paints the terminal theme's background as a translucent tint over whatever is
 * behind it (a wallpaper, the canvas), so the effective background of every glyph is
 * `tint·a + backdrop·(1−a)`. The backdrop is unknowable — any pixel of any wallpaper.
 *
 * Why checking pure white and pure black is enough: contrast depends only on luminance, and the
 * composite's luminance rises monotonically with each backdrop channel, so EVERY backdrop's
 * composite lies in the luminance interval [composite over black, composite over white]. Against a
 * fixed text colour, contrast falls as the background's luminance approaches the text's and rises
 * away from it — so over that interval the worst case is an endpoint, UNLESS the text's own
 * luminance falls inside the interval, where some backdrop matches it exactly (ratio 1). That case
 * is checked explicitly (`worstContrast`) and fails. For the built-in themes' foregrounds it never
 * arises at a ≥ 0.55: the tint then dominates the composite, keeping the whole interval on the
 * tint's side of the text. `glassContrast.test.ts` samples grey backdrops to pin the claim.
 *
 * Compositing is in gamma-encoded sRGB, the way the browser blends an rgba() fill; the WCAG
 * relative luminance is computed on the result.
 *
 * Pure and platform-free (no DOM), so it runs under vitest's node environment.
 */

type Rgb = readonly [number, number, number]

/** `#rgb`, `#rrggbb` or `#rrggbbaa` (alpha ignored) → 0..255 channels; null when unparseable. */
export function parseHex(hex: string): Rgb | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(hex.trim())
  if (!m) return null
  let h = m[1]
  if (h.length === 3) h = h.replace(/./g, (c) => c + c)
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
}

function channelLuminance(c: number): number {
  const s = c / 255
  return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
}

export function relativeLuminance([r, g, b]: Rgb): number {
  return 0.2126 * channelLuminance(r) + 0.7152 * channelLuminance(g) + 0.0722 * channelLuminance(b)
}

export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

/** `tint` at `alpha` over `backdrop`, in sRGB (what `background: rgba(...)` renders). */
export function composite(tint: Rgb, backdrop: Rgb, alpha: number): Rgb {
  return [0, 1, 2].map((i) => tint[i] * alpha + backdrop[i] * (1 - alpha)) as unknown as Rgb
}

export const GLASS_ALPHA_MIN = 0.55
export const GLASS_ALPHA_MAX = 0.95
const WHITE: Rgb = [255, 255, 255]
const BLACK: Rgb = [0, 0, 0]
const STEP = 0.005

/** The lowest contrast `fg` can have against the tint over ANY backdrop (see the module header).
 *  `lo`/`hi` narrow the backdrop to sRGB greys lo..hi (0..1), the range `glassBackdropFilter` squeezes
 *  it into; the endpoint argument holds unchanged, since every channel then lies in that range. */
export function worstContrast(fg: Rgb, tint: Rgb, alpha: number, lo = 0, hi = 1): number {
  const overLo = composite(tint, lo === 0 ? BLACK : grey(lo), alpha)
  const overHi = composite(tint, hi === 1 ? WHITE : grey(hi), alpha)
  const l = relativeLuminance(fg)
  if (l > relativeLuminance(overLo) && l < relativeLuminance(overHi)) return 1
  return Math.min(contrastRatio(fg, overHi), contrastRatio(fg, overLo))
}

function grey(v: number): Rgb {
  return [v * 255, v * 255, v * 255]
}

function passes(fg: Rgb, tint: Rgb, alpha: number, minRatio: number): boolean {
  return worstContrast(fg, tint, alpha) >= minRatio
}

/**
 * The smallest tint alpha at which `fg` keeps `minRatio` contrast over BOTH a white and a black
 * backdrop, floored at 0.55 so the glass never gets clearer than that.
 *
 * Scanned DOWN from opaque, stopping at the first failure. Contrast is not monotonic in alpha when
 * the fg's luminance lies between the backdrop's and the tint's (light text on a dark tint over
 * white: the composite passes through the text's own grey), so a scan up from 0 could return an
 * alpha whose neighbours above it fail. Scanning down returns the bottom of the contiguous passing
 * range that reaches opaque, so every alpha at or above the answer passes.
 *
 * The design ceiling is 0.95, and for every built-in theme but the two Solarized ones the answer
 * sits under it (measured: 0.62–0.885). The guarantee outranks the ceiling, though — readable text
 * is the load-bearing requirement and "never fully opaque" is a look:
 *  - Solarized Dark (opaque contrast 4.75) needs 0.985, and gets it.
 *  - Solarized Light is 4.13:1 OPAQUE — under 4.5 before any glass — so no alpha passes. It gets 1:
 *    the glass can only match the theme's own contrast, and 1 is the one alpha that never makes it
 *    worse. `glassContrast.test.ts` pins both as named exceptions.
 * Unparseable colours get the ceiling.
 */
export function glassTintAlpha(fg: string, tint: string, minRatio = 4.5): number {
  const f = parseHex(fg)
  const t = parseHex(tint)
  if (!f || !t) return GLASS_ALPHA_MAX
  let lowest = Infinity
  for (let i = Math.round(1 / STEP); i >= 0; i--) {
    const a = i * STEP
    if (!passes(f, t, a, minRatio)) break
    lowest = a
  }
  if (lowest === Infinity) return 1
  return Math.max(GLASS_ALPHA_MIN, lowest)
}

/* ------------------------------------------------------------------------------------------- *
 * Backdrop squeeze: readable at EVERY slider position.
 *
 * Left of the Readable tick the tint alone cannot hold its ratio over any backdrop (at Clear, 0.05,
 * every built-in theme measures about 1:1: dark text over a black wallpaper, light text over a
 * white one). So the backdrop filter squeezes the wallpaper into a range the tint CAN cover before
 * the tint lands on it: light glass lifts it to a floor (`contrast(c) brightness(b)` maps 0..1 to
 * lo..1), dark glass caps it (`brightness(hi)` maps 0..1 to 0..hi). Shapes and colour still show,
 * at lower contrast, which is what Clear should mean: more wallpaper, never less text. Both are
 * colour-matrix filters: per-pixel arithmetic, far cheaper than the blur they follow. Glass that
 * needs no squeeze gets no filter at all (`glassBackdropFilter` returns null). CSS filter
 * functions work per channel on gamma-encoded sRGB, the same space `composite` blends in
 * (measured: predicted 153, rendered 154).
 *
 * The promise slides with the slider (`glassMinRatio`): 3:1 at Clear, 4.5:1 from the Readable
 * tick. Picked by eye over light and dark wallpapers in both themes: 4.5:1 at Clear dimmed a
 * bright wallpaper to brown and washed a dark one to grey, and Clear stopped looking clear.
 * ------------------------------------------------------------------------------------------- */

/** From the Readable tick on, light glass lifts a black backdrop at least this far (sRGB grey,
 *  0..1): without it light glass over a dark wallpaper reads as muddy grey, not frost. Left of the
 *  tick it fades out (`glassFrostFloor`) so Clear keeps the wallpaper's colour. The chrome's
 *  `--glass-frost` in styles.css is this floor (pinned by glassContrast.test.ts). */
export const GLASS_LIGHT_FROST = 0.5

/** The contrast a glass surface's text keeps at Clear: WCAG's large-text minimum. */
export const GLASS_CLEAR_RATIO = 3

/** The contrast promised at slider position `t`: GLASS_CLEAR_RATIO at Clear, rising to 4.5:1 at
 *  the Readable tick and holding it to Tinted. */
export function glassMinRatio(t: number): number {
  return GLASS_CLEAR_RATIO + (4.5 - GLASS_CLEAR_RATIO) * Math.min(1, t / GLASS_READABLE_TICK)
}

/** The light-glass frost floor at slider position `t`: 0 at Clear, GLASS_LIGHT_FROST from the tick. */
export function glassFrostFloor(t: number): number {
  return GLASS_LIGHT_FROST * Math.min(1, t / GLASS_READABLE_TICK)
}

/** The sRGB grey range (0..1) the backdrop is squeezed into. */
export interface BackdropRange {
  lo: number
  hi: number
}

/**
 * The gentlest squeeze that keeps `fg` at `minRatio` (or the theme's own opaque contrast, if lower)
 * on `tint`@`alpha`: light glass gets the LOWEST floor (never below `floor`), dark glass the
 * HIGHEST ceiling. Both are monotone in the bound, so a bisection finds them; at or right of the
 * Readable tick dark glass needs none (hi = 1).
 */
export function glassBackdropRange(
  fg: Rgb,
  tint: Rgb,
  alpha: number,
  minRatio = 4.5,
  floor = GLASS_LIGHT_FROST
): BackdropRange {
  const target = Math.min(minRatio, contrastRatio(fg, tint))
  const light = relativeLuminance(fg) < relativeLuminance(tint)
  const ok = (v: number): boolean =>
    (light ? worstContrast(fg, tint, alpha, v, 1) : worstContrast(fg, tint, alpha, 0, v)) >= target
  return bisectRange(light, ok, floor)
}

/**
 * `glassBackdropRange` for a chrome-coloured surface whose text is the app's translucent `--text`
 * (canvas cards: subagent, files, loop, trigger, dino). The ink moves with the backdrop, so this
 * samples like `glassChromeAlpha`, with every backdrop first squeezed into the candidate range.
 * Null when a colour cannot be parsed.
 */
export function glassChromeBackdropRange(
  text: string,
  panel: string,
  alpha: number,
  minRatio = 4.5,
  floor = GLASS_LIGHT_FROST
): BackdropRange | null {
  const t = parseCssColor(text)
  const p = parseCssColor(panel)
  if (!t || !p) return null
  const light = relativeLuminance(p.rgb) > relativeLuminance(t.rgb)
  const squeeze = (b: Rgb, v: number): Rgb =>
    (light ? b.map((c) => v * 255 + c * (1 - v)) : b.map((c) => c * v)) as unknown as Rgb
  const ok = (v: number): boolean => CHROME_BACKDROPS.every((b) => chromeContrast(t, p.rgb, alpha, squeeze(b, v)) >= minRatio)
  return bisectRange(light, ok, floor)
}

/** The shared search of both squeezes: the lowest passing floor (light, from `floor` up) or the
 *  highest passing ceiling (dark, from 1 down). `ok` is monotone in the bound. */
function bisectRange(light: boolean, ok: (v: number) => boolean, floor: number): BackdropRange {
  let pass = light ? 1 : 0
  let fail = light ? floor : 1
  if (ok(fail)) return light ? { lo: fail, hi: 1 } : { lo: 0, hi: 1 }
  if (!ok(pass)) return light ? { lo: 1, hi: 1 } : { lo: 0, hi: 0 }
  for (let i = 0; i < 12; i++) {
    const mid = (pass + fail) / 2
    if (ok(mid)) pass = mid
    else fail = mid
  }
  return light ? { lo: pass, hi: 1 } : { lo: 0, hi: pass }
}

/** The CSS for a squeeze, appended to a surface's backdrop-filter; null when none is needed. Each
 *  bound moves 1/255 the safe way so the 3-decimal rounding can never cost contrast. */
export function glassBackdropFilter({ lo, hi }: BackdropRange): string | null {
  if (lo > 0) {
    const l = Math.min(1, lo + 1 / 255)
    const c = (1 - l) / (1 + l)
    return `contrast(${c.toFixed(3)}) brightness(${(2 / (1 + c)).toFixed(3)})`
  }
  if (hi < 1) return `brightness(${Math.max(0, hi - 1 / 255).toFixed(3)})`
  return null
}

/* Status chips on a glass header (styles.css `.term-node__status` under Liquid Glass): the label
   is the terminal foreground, and the chip behind it is a wash of the status hue. The wash moves
   the surface under the text, so it gets the same treatment as the tint: the LARGEST wash (up to
   GLASS_CHIP_WASH_MAX) at which the foreground keeps 4.5:1 for every hue a badge can take, over
   any backdrop. A fixed wash cannot do it — measured, One Dark's yellow chip falls to 3.93:1 at
   12% — and a theme with no margin (Solarized Dark) gets 0, where the chip is its ring alone. */
export const GLASS_CHIP_WASH_MAX = 0.24
/** Every hue a glass status badge can be: the text-safe and fill tokens those badges read under
 *  Liquid Glass, dark then light values (styles.palette.test.ts pins them to the stylesheet). */
export const GLASS_CHIP_HUES = [
  '#30d158', '#6cb0ff', '#ff9f0a', '#ff453a', '#ffd60a', '#98989d', '#bf5af2',
  '#1f7a38', '#0060df', '#a85c00', '#c62a1f', '#34c759', '#806100', '#8e8e93', '#af52de'
]
/** The glass header's own layer over the node tint (see `glassTint().header`). */
const HEADER_LAYER_ALPHA = 0.35
const CHIP_BACKDROPS: Rgb[] = (() => {
  const out: Rgb[] = []
  for (const r of [0, 255]) for (const g of [0, 255]) for (const b of [0, 255]) out.push([r, g, b])
  for (let v = 0; v <= 255; v += 5) out.push([v, v, v])
  return out
})()
const chipWashCache = new Map<string, number>()

/** Largest status-chip wash keeping `fg` at 4.5:1 on a glass header tinted `bg` at `alpha`. */
export function glassChipWash(fg: string, bg: string, alpha: number): number {
  const key = `${fg}|${bg}|${alpha.toFixed(3)}`
  const hit = chipWashCache.get(key)
  if (hit !== undefined) return hit
  const f = parseHex(fg)
  const b = parseHex(bg)
  const hues = GLASS_CHIP_HUES.map((h) => parseHex(h)!)
  let best = 0
  if (f && b) {
    const heads = CHIP_BACKDROPS.map((d) => composite(b, composite(b, d, alpha), HEADER_LAYER_ALPHA))
    for (let i = 1; i <= Math.round(GLASS_CHIP_WASH_MAX * 100); i++) {
      const w = i / 100
      if (!heads.every((h) => hues.every((hue) => contrastRatio(f, composite(hue, h, w)) >= 4.5))) break
      best = w
    }
  }
  chipWashCache.set(key, best)
  return best
}

export interface GlassTint {
  /** The node's glass fill, `rgba(r, g, b, a)`. */
  background: string
  /** The header's extra layer on top of it — slightly more opaque in total. */
  header: string
  /** The status-chip wash for this theme, as a CSS percentage (`glassChipWash`). */
  chipWash: string
  /** The theme foreground: header text sits on the TERMINAL's tint, so it takes the terminal's
   *  text colour, not the app's (a light app theme over a dark terminal theme measured 1.31:1). */
  foreground: string
  /** The fill's alpha as a number — app-painted cell backgrounds follow it
   *  (`terminal/glass-cell-backgrounds.ts`). */
  alpha: number
  /** The backdrop squeeze for this alpha (`glassBackdropFilter`), appended to the node's blur;
   *  null when the tint alone holds the contrast. */
  backdrop: string | null
}

/** CSS for a theme's glass at a Glass-slider position (default: the Readable tick), or null when
 *  its background is not a colour we can parse. */
export function glassTint(
  theme: { background?: string; foreground?: string },
  slider: number = GLASS_READABLE_TICK,
  a11y: GlassA11y = NO_GLASS_A11Y
): GlassTint | null {
  const bg = theme.background ? parseHex(theme.background) : null
  if (!bg) return null
  const foreground = theme.foreground ?? '#ffffff'
  const readable = glassTintAlpha(foreground, theme.background!)
  const alpha = glassSurfaceAlpha(slider, readable, a11y)
  const rgb = bg.join(', ')
  // Sized at the Readable tick, whatever the slider: left of it the promise is off anyway, and
  // right of it a denser tint only leaves MORE room for the wash, so the tick's wash still passes —
  // one computation per theme instead of a ~21k-check cache miss per slider step.
  const chipWash = glassChipWash(foreground, theme.background!, readable)
  const fg = parseHex(foreground)
  const t = a11y.moreContrast ? 1 : slider
  const backdrop = fg ? glassBackdropFilter(glassBackdropRange(fg, bg, alpha, glassMinRatio(t), glassFrostFloor(t))) : null
  return {
    background: `rgba(${rgb}, ${alpha.toFixed(3)})`,
    header: `rgba(${rgb}, ${HEADER_LAYER_ALPHA})`,
    chipWash: `${Math.round(chipWash * 100)}%`,
    foreground,
    alpha,
    backdrop
  }
}

/* ------------------------------------------------------------------------------------------- *
 * Liquid Glass CHROME (tab bar, dock, menus, sidebar, dialogs, Settings, non-terminal nodes).
 *
 * Same guarantee, one difference that matters: the app's `--text` is itself TRANSLUCENT
 * (`rgba(var(--tint-rgb), 0.85)`), so the ink a user sees is the text colour blended over the
 * surface it sits on — and that surface is now a blend over an unknown backdrop. The foreground
 * therefore moves WITH the backdrop, which breaks the white/black endpoint argument above (it
 * assumes a fixed fg). So this one samples: a 6×6×6 grid of backdrop colours (every channel at
 * 0, 51, …, 255) plus a grey ramp at step 5. `glassContrast.test.ts` re-checks the answer on a
 * finer grey sweep for both app themes.
 * ------------------------------------------------------------------------------------------- */

/** `#hex`, `rgb(r, g, b)` or `rgba(r, g, b, a)` → channels + alpha; null when unparseable. */
export function parseCssColor(css: string): { rgb: Rgb; alpha: number } | null {
  const hex = parseHex(css)
  if (hex) return { rgb: hex, alpha: 1 }
  const m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(css.trim())
  if (!m) return null
  return { rgb: [Number(m[1]), Number(m[2]), Number(m[3])], alpha: m[4] === undefined ? 1 : Number(m[4]) }
}

const CHROME_BACKDROPS: Rgb[] = (() => {
  const out: Rgb[] = []
  for (let r = 0; r <= 255; r += 51)
    for (let g = 0; g <= 255; g += 51) for (let b = 0; b <= 255; b += 51) out.push([r, g, b])
  for (let v = 0; v <= 255; v += 5) out.push([v, v, v])
  return out
})()

/** Contrast of (possibly translucent) text on `panel`@`alpha` over one backdrop pixel. */
export function chromeContrast(
  text: { rgb: Rgb; alpha: number },
  panel: Rgb,
  alpha: number,
  backdrop: Rgb
): number {
  const surface = composite(panel, backdrop, alpha)
  return contrastRatio(composite(text.rgb, surface, text.alpha), surface)
}

/** The highlight washes on glass rows (styles.css `--glass-lift` = theme ink at this alpha,
 *  `--glass-select` = the accent mixed at this share). Pinned to the stylesheet by
 *  glassContrast.test.ts, so the two cannot drift apart. */
export const GLASS_LIFT_ALPHA = 0.14
export const GLASS_SELECT_MIX = 0.3

/** A highlighted state on a chrome surface: `wash` composited over the fill, `ink` on top. */
export interface ChromeHighlight {
  ink: string
  wash: string
}

/** Contrast of `text` on a highlight `wash` over `panel`@`alpha` over one backdrop pixel. */
export function chromeHighlightContrast(
  text: { rgb: Rgb; alpha: number },
  wash: { rgb: Rgb; alpha: number },
  panel: Rgb,
  alpha: number,
  backdrop: Rgb
): number {
  return chromeContrast(text, wash.rgb, wash.alpha, composite(panel, backdrop, alpha))
}

/** The highlighted states every glass chrome surface carries, from the resolved tokens: the ink
 *  lift (hover, active tab) and the accent selection, both with `--text-strong` labels (styles.css
 *  sets that ink on them under glass). An unparseable accent drops only the selection check. */
export function glassChromeHighlights(textStrong: string, tintRgb: string, accent: string): ChromeHighlight[] {
  const out: ChromeHighlight[] = [{ ink: textStrong, wash: `rgba(${tintRgb}, ${GLASS_LIFT_ALPHA})` }]
  const a = parseCssColor(accent)
  if (a) out.push({ ink: textStrong, wash: `rgba(${a.rgb.join(', ')}, ${GLASS_SELECT_MIX})` })
  return out
}

/**
 * The smallest alpha (floored at 0.55) for a chrome surface of colour `panel` that keeps `text`
 * at `minRatio` over every sampled backdrop; 1 when even opaque does not reach it; null when a
 * colour cannot be parsed (the caller then leaves the chrome opaque).
 *
 * `highlights` are the washes a row or tab lays over the same fill (hover lift, active tab,
 * selected row) with the ink they carry: the fill must hold `minRatio` for EVERY one of them too.
 * A lift of the theme's own ink moves the surface toward the text, so without this the plain fill
 * passed and the active tab measured 3.9:1 (visual QA round 2, N2).
 */
export function glassChromeAlpha(
  text: string,
  panel: string,
  minRatio = 4.5,
  highlights: readonly ChromeHighlight[] = []
): number | null {
  const t = parseCssColor(text)
  const p = parseCssColor(panel)
  if (!t || !p) return null
  const hs = highlights.map((h) => ({ ink: parseCssColor(h.ink), wash: parseCssColor(h.wash) }))
  if (hs.some((h) => !h.ink || !h.wash)) return null
  const holds = (a: number, b: Rgb): boolean =>
    chromeContrast(t, p.rgb, a, b) >= minRatio &&
    hs.every((h) => chromeHighlightContrast(h.ink!, h.wash!, p.rgb, a, b) >= minRatio)
  let lowest = Infinity
  for (let i = Math.round(1 / STEP); i >= 0; i--) {
    const a = i * STEP
    if (!CHROME_BACKDROPS.every((b) => holds(a, b))) break
    lowest = a
  }
  if (lowest === Infinity) return 1
  return Math.max(GLASS_ALPHA_MIN, lowest)
}

/* ------------------------------------------------------------------------------------------- *
 * The Glass slider (Settings → Appearance, Liquid Glass only): Clear ↔ Tinted, like iOS 26.
 *
 * One setting drives every glass surface, and every surface has its OWN readable alpha (the chrome
 * fill, each terminal theme). So the slider is not an alpha: it is a position `t` in 0..1, and each
 * surface maps it through three points — Clear at 0, its own readable alpha at the Readable tick,
 * Tinted at 1. At the tick every surface sits exactly at the alpha the functions above computed,
 * which is why the tick can promise 4.5:1; right of it every alpha is higher, and the scans above
 * return the bottom of a range that reaches opaque, so the promise holds all the way to Tinted.
 * Left of the tick is clearer than the guarantee, and the Settings row says so.
 * ------------------------------------------------------------------------------------------- */

/** Tint alpha at the Clear end: never fully clear, the tint still says where a surface is. The
 *  backdrop squeeze, not the tint, keeps the text readable there (picked by eye: 0.2 hid the
 *  wallpaper's colour without buying contrast the squeeze could not give). */
export const GLASS_CLEAR_ALPHA = 0.05
/** Chrome floor at Clear for the small floating CONTROLS (dock, zoom, toolbar buttons, minimap,
 *  pills, tab bar): Apple's one published dimming figure ("consider adding a dark dimming layer of
 *  35% opacity", materials.md). At 0.2 their icons vanished over a bright wallpaper (visual QA H4). */
export const GLASS_CONTROL_CLEAR_ALPHA = 0.35
/** Tint alpha at the Tinted end (a surface whose readable alpha is higher keeps its own). */
export const GLASS_TINTED_ALPHA = 0.95
/** Where the Readable tick sits on the track — also the default, so an untouched slider is the
 *  look Liquid Glass shipped with. 0.7 is close to where the chrome's readable alpha falls on a
 *  straight Clear→Tinted scale (dark 0.70 → 0.67, light 0.745 → 0.73), so the track reads as
 *  roughly linear. */
export const GLASS_READABLE_TICK = 0.7

/** `settings.glassTint` → a slider position. Absent / not a finite number = the Readable tick. */
export function resolveGlassSlider(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(1, Math.max(0, value))
    : GLASS_READABLE_TICK
}

/** The tint alpha of a surface whose readable alpha is `readable`, at slider position `t`.
 *  `clear` is the surface's alpha at the Clear end (terminal nodes 0.2, controls 0.35). */
export function glassSliderAlpha(t: number, readable: number, clear = GLASS_CLEAR_ALPHA): number {
  const tinted = Math.max(readable, GLASS_TINTED_ALPHA)
  if (t <= GLASS_READABLE_TICK) {
    return clear + ((readable - clear) * t) / GLASS_READABLE_TICK
  }
  return readable + ((tinted - readable) * (t - GLASS_READABLE_TICK)) / (1 - GLASS_READABLE_TICK)
}

/** Edge-lens displacement (feDisplacementMap `scale`, objectBoundingBox units): strongest at
 *  Clear, flat at Tinted. It moves backdrop pixels, never the tint, so it cannot touch contrast. */
export const GLASS_REFRACT_MAX = 0.025
export function glassRefraction(t: number): number {
  return GLASS_REFRACT_MAX * (1 - t)
}

/** Whether the refraction filter runs at all at slider position `t`: only LEFT of the Readable
 *  tick, where the blur is light enough for the bend to show. From the tick to Tinted it moved an
 *  already ~20px-blurred backdrop by 3px or less (0 at Tinted), and it was the costliest part of
 *  the glass: MEASURED on an M2 with one streaming terminal and six glass terminals, 74% → 42% GPU
 *  without it. Its feImage source makes Chromium treat every refracting surface as damaged across
 *  its whole rect, so one changing pixel re-ran the blur of the surfaces around it too. */
export function glassRefractionOn(t: number): boolean {
  return t < GLASS_READABLE_TICK
}

/** The system accessibility settings that outrank the Glass slider, like iOS. */
export interface GlassA11y {
  /** Reduce Transparency: glass becomes opaque (and loses blur, refraction and sheen in CSS). */
  reduceTransparency: boolean
  /** Increase Contrast: the slider pins to the Tinted end. */
  moreContrast: boolean
}
export const NO_GLASS_A11Y: GlassA11y = { reduceTransparency: false, moreContrast: false }

/** The tint alpha a surface actually gets: the slider's, unless an accessibility setting wins. */
export function glassSurfaceAlpha(
  t: number,
  readable: number,
  a11y: GlassA11y = NO_GLASS_A11Y,
  clear = GLASS_CLEAR_ALPHA
): number {
  if (a11y.reduceTransparency) return 1
  return glassSliderAlpha(a11y.moreContrast ? 1 : t, readable, clear)
}

/**
 * The two chrome fills (Phase 4 slider scope; HIG: the regular variant for anything with a lot of
 * text). Left of the Readable tick only the small floating CONTROLS follow the slider, down to
 * `GLASS_CONTROL_CLEAR_ALPHA`; TEXT surfaces (Settings, menus, popovers, the palette, dialogs, the
 * sessions sidebar, kanban columns) never go below their readable alpha. Right of the tick both
 * follow the slider. Terminal nodes are neither: they keep their own tint (`glassTint`).
 */
export function glassChromeAlphas(
  t: number,
  readable: number,
  a11y: GlassA11y = NO_GLASS_A11Y,
  controlClear = GLASS_CONTROL_CLEAR_ALPHA
): { text: number; control: number } {
  return {
    text: glassSurfaceAlpha(Math.max(t, GLASS_READABLE_TICK), readable, a11y),
    control: glassSurfaceAlpha(t, readable, a11y, Math.min(controlClear, readable))
  }
}

/**
 * The CONTROLS' alpha at Clear: at least `GLASS_CONTROL_CLEAR_ALPHA`, and enough that `text` (their
 * icons) keeps 3:1 — WCAG's non-text minimum — over every sampled backdrop once the control blur's
 * `brightness(dim)` has scaled it (styles.css `--glass-control-dim`: 0.7 dark, 1.3 light). The
 * dark theme's dimming carries it at 0.35; brightening cannot lift near-black water, so light glass
 * needs a denser floor (visual QA round 2, H4: zoom − measured 2.1:1 in light at Clear).
 */
export function glassControlClearAlpha(text: string, panel: string, dim: number): number {
  const t = parseCssColor(text)
  const p = parseCssColor(panel)
  if (!t || !p || !Number.isFinite(dim)) return GLASS_CONTROL_CLEAR_ALPHA
  const dimmed = CHROME_BACKDROPS.map((b) => b.map((c) => Math.min(255, c * dim)) as unknown as Rgb)
  for (let i = Math.round(GLASS_CONTROL_CLEAR_ALPHA / STEP); i <= Math.round(1 / STEP); i++) {
    const a = i * STEP
    if (dimmed.every((b) => chromeContrast(t, p.rgb, a, b) >= 3)) return a
  }
  return 1
}

/** Magnetic detent, like a macOS slider's tick marks: a drag within this of the tick lands on it. */
export const GLASS_TICK_DETENT = 0.03
/** Keyboard arrow step. */
export const GLASS_SLIDER_STEP = 0.05

export function snapGlassSlider(v: number): number {
  return Math.abs(v - GLASS_READABLE_TICK) <= GLASS_TICK_DETENT + 1e-9 ? GLASS_READABLE_TICK : v
}

/** One arrow press from `v` (dir -1 / +1): a step of 0.05 that stops on the tick if it crosses it. */
export function stepGlassSlider(v: number, dir: -1 | 1): number {
  const next = Math.min(1, Math.max(0, Math.round((v + dir * GLASS_SLIDER_STEP) * 1000) / 1000))
  const crosses = dir > 0 ? v < GLASS_READABLE_TICK && next > GLASS_READABLE_TICK : v > GLASS_READABLE_TICK && next < GLASS_READABLE_TICK
  return crosses ? GLASS_READABLE_TICK : snapGlassSlider(next)
}

/** `settings.glassBlurWhileMoving`: only a literal false pauses the blur during camera moves. */
export function keepGlassBlurWhileMoving(value: unknown): boolean {
  return value !== false
}
