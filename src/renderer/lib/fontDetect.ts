/**
 * Is this font actually installed?
 *
 * `settings.fontFamily` is a free-text CSS stack, so a user who types "Fira Code" without having
 * installed it gets silently rendered in the next fallback — the setting appears to do nothing and
 * there is no error anywhere. Detecting availability is what lets the UI say so.
 *
 * **`document.fonts.check()` cannot answer this.** It reports on the FontFaceSet — web fonts the
 * document loaded — and returns `true` for any syntactically valid family name that resolves
 * through fallback, which is every name. The only technique that works for OS-installed fonts is
 * the width comparison below: render a sample string in `"<family>", <generic>` and in `<generic>`
 * alone, and see whether the metrics move. If the family doesn't exist, both render as the generic
 * and measure identically.
 *
 * All of this is pure over an injected `measure`, so the real canvas is only needed at the edge.
 */

/** CSS generic families — always "available" (they ARE the fallback), never worth measuring. */
const GENERIC_FAMILIES = new Set([
  'monospace',
  'serif',
  'sans-serif',
  'cursive',
  'fantasy',
  'system-ui',
  'ui-monospace',
  'ui-serif',
  'ui-sans-serif',
  'ui-rounded',
  'math',
  'emoji',
  'fangsong',
  'inherit',
  'initial',
  'unset'
])

/**
 * Bases to compare against. Three, not one: a font whose metrics happen to match the monospace
 * default would read as missing if monospace were the only probe. A real font is very unlikely to
 * match all three.
 */
const PROBE_BASES = ['monospace', 'serif', 'sans-serif'] as const

/** Mixed widths — proportional and monospace fonts diverge hard on these. */
const PROBE_TEXT = 'mmmmmmmmmmlliWWWiiil0O'

/** Big enough that a sub-pixel per-glyph difference accumulates past any rounding. */
const PROBE_SIZE = 72

/** Measures a CSS `font` shorthand and returns the sample string's width. */
export type MeasureText = (font: string) => number

export function isGenericFamily(family: string): boolean {
  return GENERIC_FAMILIES.has(family.trim().toLowerCase())
}

/**
 * The first family in a CSS font stack, unquoted. This is the one the terminal actually renders
 * with when it exists, so it is the one worth warning about.
 */
export function primaryFamily(stack: string): string {
  const first = stack.split(',')[0]?.trim() ?? ''
  return unquote(first)
}

function unquote(name: string): string {
  const t = name.trim()
  if (t.length >= 2 && (t[0] === '"' || t[0] === "'") && t[t.length - 1] === t[0]) {
    return t.slice(1, -1).trim()
  }
  return t
}

/** Quote a family name for use in a CSS stack, if it needs it. */
export function quoteFamily(family: string): string {
  return /^[a-zA-Z][a-zA-Z0-9-]*$/.test(family) ? family : `"${family}"`
}

/**
 * A stack that starts with `family` and keeps sensible fallbacks, so picking a font from the list
 * can never leave the user with a single name that might not exist on their OTHER machine (the
 * setting travels; the font may not).
 */
export function buildFontStack(family: string): string {
  const trimmed = family.trim()
  if (!trimmed || isGenericFamily(trimmed)) return 'monospace'
  return `${quoteFamily(trimmed)}, Menlo, Monaco, "Courier New", monospace`
}

/**
 * `buildFontStack` for reading text (the Markdown font): proportional fallbacks, ending in
 * `sans-serif`. A generic family (`serif`, `system-ui`) is a complete stack on its own.
 */
export function buildProseFontStack(family: string): string {
  const trimmed = family.trim()
  if (!trimmed) return 'sans-serif'
  if (isGenericFamily(trimmed)) return trimmed
  return `${quoteFamily(trimmed)}, -apple-system, BlinkMacSystemFont, sans-serif`
}

/**
 * Whether `family` resolves to a real installed font.
 *
 * Generic families are true by definition. Everything else is available only if it measures
 * DIFFERENTLY from at least one generic base — identical metrics against all three mean the name
 * resolved to nothing and fell through.
 */
export function isFontAvailable(family: string, measure: MeasureText): boolean {
  const name = unquote(family)
  if (!name) return false
  if (isGenericFamily(name)) return true
  const quoted = quoteFamily(name)
  return PROBE_BASES.some((base) => {
    const baseline = measure(`${PROBE_SIZE}px ${base}`)
    const candidate = measure(`${PROBE_SIZE}px ${quoted}, ${base}`)
    // A zero-width measurement means the canvas gave us nothing (no 2D context, a detached
    // document): report "not different" rather than inventing an answer, so a broken measurer
    // degrades to "unknown", never to a false accusation that a font is missing.
    if (!baseline || !candidate) return false
    return baseline !== candidate
  })
}

/** The installed subset of `families`, in the order given. */
export function detectInstalled(families: readonly string[], measure: MeasureText): string[] {
  return families.filter((f) => isFontAvailable(f, measure))
}

/**
 * Well-known coding fonts, offered as a starting point. This is a CATALOGUE, not a whitelist — it
 * is filtered by what is actually installed, and the free-text field still accepts anything, so a
 * font nobody thought to list here is never out of reach.
 */
export const MONO_FONT_CATALOG: readonly string[] = [
  '0xProto',
  'Anonymous Pro',
  'Berkeley Mono',
  'Cascadia Code',
  'Cascadia Mono',
  'Comic Mono',
  'Consolas',
  'Courier New',
  'DejaVu Sans Mono',
  'Departure Mono',
  'Fira Code',
  'Fira Mono',
  'Geist Mono',
  'Hack',
  'IBM Plex Mono',
  'Inconsolata',
  'Iosevka',
  'JetBrains Mono',
  'Liberation Mono',
  'Maple Mono',
  'Menlo',
  'Monaco',
  'MonoLisa',
  'Noto Sans Mono',
  'PT Mono',
  'Roboto Mono',
  'SF Mono',
  'Source Code Pro',
  'Space Mono',
  'Ubuntu Mono',
  'Victor Mono'
]

/**
 * Well-known reading fonts (sans and serif, across macOS, Windows and Linux) for the Markdown font
 * picker. A catalogue like `MONO_FONT_CATALOG`: filtered by what is installed, never a whitelist.
 */
export const PROSE_FONT_CATALOG: readonly string[] = [
  'Arial',
  'Atkinson Hyperlegible',
  'Avenir Next',
  'Baskerville',
  'Cantarell',
  'Charter',
  'DejaVu Sans',
  'DejaVu Serif',
  'Georgia',
  'Gill Sans',
  'Helvetica Neue',
  'IBM Plex Sans',
  'IBM Plex Serif',
  'Inter',
  'Iowan Old Style',
  'Lato',
  'Liberation Sans',
  'Liberation Serif',
  'New York',
  'Noto Sans',
  'Noto Serif',
  'Open Sans',
  'Optima',
  'Palatino',
  'Roboto',
  'Segoe UI',
  'Source Sans 3',
  'Source Serif 4',
  'Times New Roman',
  'Ubuntu',
  'Verdana'
]

/**
 * A canvas-backed measurer, or null where there is no 2D context to measure with.
 *
 * One canvas is reused for every probe: creating one per measurement is what turns a 30-font scan
 * into a visible hitch.
 */
export function createCanvasMeasurer(): MeasureText | null {
  if (typeof document === 'undefined') return null
  const ctx = document.createElement('canvas').getContext('2d')
  if (!ctx) return null
  return (font: string) => {
    ctx.font = font
    return ctx.measureText(PROBE_TEXT).width
  }
}
