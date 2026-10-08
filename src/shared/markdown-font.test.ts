import { describe, expect, it } from 'vitest'
import {
  DEFAULT_CODE_FONT_FAMILY,
  DEFAULT_MARKDOWN_FONT_FAMILY,
  DEFAULT_MARKDOWN_FONT_SIZE,
  MARKDOWN_FONT_SIZE_MAX,
  MARKDOWN_FONT_SIZE_MIN,
  resolveMarkdownCodeFontFamily,
  resolveMarkdownFontFamily,
  resolveMarkdownFontSize
} from './markdown-font'
import { DEFAULT_SETTINGS } from './types'

describe('resolveMarkdownFontSize', () => {
  it('keeps a size inside the range, rounded', () => {
    expect(resolveMarkdownFontSize(16)).toBe(16)
    expect(resolveMarkdownFontSize(15.6)).toBe(16)
  })

  it('clamps to the terminal font range', () => {
    expect(resolveMarkdownFontSize(2)).toBe(MARKDOWN_FONT_SIZE_MIN)
    expect(resolveMarkdownFontSize(400)).toBe(MARKDOWN_FONT_SIZE_MAX)
  })

  it('answers the default for anything that is not a finite number (settings.json is hand-editable)', () => {
    for (const bad of [undefined, null, '16', Number.NaN, Number.POSITIVE_INFINITY, {}]) {
      expect(resolveMarkdownFontSize(bad)).toBe(DEFAULT_MARKDOWN_FONT_SIZE)
    }
  })
})

describe('resolveMarkdownFontFamily', () => {
  it('keeps a font stack, trimmed', () => {
    expect(resolveMarkdownFontFamily('  "Iowan Old Style", Georgia, serif ')).toBe('"Iowan Old Style", Georgia, serif')
  })

  it('answers the default for an empty or non-string value', () => {
    for (const bad of [undefined, null, 12, '', '   ']) {
      expect(resolveMarkdownFontFamily(bad)).toBe(DEFAULT_MARKDOWN_FONT_FAMILY)
    }
  })

  it('refuses a value that could end the CSS declaration it is set into', () => {
    for (const bad of ['Georgia; color: red', 'Georgia} body {', 'a<b', 'a\\62', 'Geor\ngia', 'x'.repeat(301)]) {
      expect(resolveMarkdownFontFamily(bad)).toBe(DEFAULT_MARKDOWN_FONT_FAMILY)
    }
  })
})

describe('resolveMarkdownCodeFontFamily', () => {
  it('follows the terminal font family', () => {
    expect(resolveMarkdownCodeFontFamily('"JetBrains Mono", monospace')).toBe('"JetBrains Mono", monospace')
  })

  it('falls back to the terminal default for an unusable value', () => {
    expect(resolveMarkdownCodeFontFamily('')).toBe(DEFAULT_CODE_FONT_FAMILY)
  })
})

describe('defaults', () => {
  it('ship in DEFAULT_SETTINGS', () => {
    expect(DEFAULT_SETTINGS.markdownFontFamily).toBe(DEFAULT_MARKDOWN_FONT_FAMILY)
    expect(DEFAULT_SETTINGS.markdownFontSize).toBe(DEFAULT_MARKDOWN_FONT_SIZE)
  })

  it('the code fallback is the terminal font default', () => {
    expect(DEFAULT_CODE_FONT_FAMILY).toBe(DEFAULT_SETTINGS.fontFamily)
  })
})
