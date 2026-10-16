/**
 * The font of the rendered-Markdown reading views: the ⌘M output view, the ⌘M chat view (thread
 * and composer) and the editor's Markdown preview (Settings → Appearance).
 *
 * Applied as CSS custom properties on <html> (`--md-font-family`, `--md-font-size`,
 * `--md-code-font-family`, set by App.tsx); styles.css reads them. Code inside Markdown follows
 * the TERMINAL font family (one setting fewer, and code looks like the terminal it came from) at
 * 0.92 of the Markdown size — a relative size, so code stays in proportion when the Markdown size
 * changes (a terminal-size-based code font would sit far below a 16px body).
 *
 * settings.json is hand-editable, so every reader goes through the resolvers below: a size that is
 * not a finite number answers the default and is clamped to the terminal font's range; a family
 * that is not a usable string answers its default.
 */

/** What the Markdown views used before the setting existed — the default keeps the same look. */
export const DEFAULT_MARKDOWN_FONT_FAMILY = '-apple-system, BlinkMacSystemFont, sans-serif'
export const DEFAULT_MARKDOWN_FONT_SIZE = 13
export const MARKDOWN_FONT_SIZE_MIN = 8
export const MARKDOWN_FONT_SIZE_MAX = 28

/** The code family when the terminal's own `fontFamily` is unusable (the terminal's default). */
export const DEFAULT_CODE_FONT_FAMILY = 'Menlo, Monaco, "Courier New", monospace'

/** Longest font stack accepted; a longer value is not a font list anyone typed. */
const FONT_STACK_MAX = 300

/**
 * A font stack from settings, or `fallback`. Refuses characters that cannot appear in a
 * `font-family` value but could end the declaration it is set into (`;`, braces, angle brackets,
 * a backslash, control characters).
 */
export function resolveFontStack(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim()
  if (trimmed === '' || trimmed.length > FONT_STACK_MAX) return fallback
  if (/[;{}<>\\]/.test(trimmed)) return fallback
  for (const ch of trimmed) {
    const code = ch.charCodeAt(0)
    if (code < 0x20 || code === 0x7f) return fallback
  }
  return trimmed
}

export function resolveMarkdownFontFamily(value: unknown): string {
  return resolveFontStack(value, DEFAULT_MARKDOWN_FONT_FAMILY)
}

export function resolveMarkdownFontSize(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_MARKDOWN_FONT_SIZE
  return Math.min(MARKDOWN_FONT_SIZE_MAX, Math.max(MARKDOWN_FONT_SIZE_MIN, Math.round(value)))
}

/** The family code inside Markdown uses: the terminal's font. */
export function resolveMarkdownCodeFontFamily(terminalFontFamily: unknown): string {
  return resolveFontStack(terminalFontFamily, DEFAULT_CODE_FONT_FAMILY)
}
