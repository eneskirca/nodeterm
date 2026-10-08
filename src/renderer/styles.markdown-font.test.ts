import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  DEFAULT_CODE_FONT_FAMILY,
  DEFAULT_MARKDOWN_FONT_FAMILY,
  DEFAULT_MARKDOWN_FONT_SIZE
} from '@shared/markdown-font'

/**
 * The Markdown font setting (Settings → Appearance) reaches the views as three tokens App.tsx sets
 * on <html>. Every rule that sizes or picks the font of rendered Markdown must read the tokens, or
 * the setting silently stops applying to that view. The :root defaults are what an un-hydrated
 * store draws, so they must equal the setting's defaults.
 */
const CSS = readFileSync(join(__dirname, 'styles.css'), 'utf8').replace(/\r\n/g, '\n')

function token(name: string): string {
  const root = CSS.slice(CSS.indexOf(':root {'), CSS.search(/^:root\[data-theme='light'\]\s*\{/m))
  const m = new RegExp(`^\\s*${name}:\\s*([^;]+);`, 'm').exec(root)
  if (!m) throw new Error(`${name} is not declared in :root`)
  return m[1].trim()
}

/** The body of the rule whose selector is exactly `selector` (not part of a selector group). */
function rule(selector: string): string {
  const re = new RegExp(`^${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{`, 'gm')
  for (const m of CSS.matchAll(re)) {
    const prev = CSS.lastIndexOf('\n', m.index - 1)
    const prevLine = CSS.slice(CSS.lastIndexOf('\n', prev - 1) + 1, prev).trim()
    if (prevLine.endsWith(',')) continue
    return CSS.slice(m.index, CSS.indexOf('}', m.index))
  }
  throw new Error(`no rule for ${selector}`)
}

describe('Markdown font tokens', () => {
  it(':root defaults equal the setting defaults', () => {
    expect(token('--md-font-family')).toBe(DEFAULT_MARKDOWN_FONT_FAMILY)
    expect(token('--md-font-size')).toBe(`${DEFAULT_MARKDOWN_FONT_SIZE}px`)
    expect(token('--md-code-font-family')).toBe(DEFAULT_CODE_FONT_FAMILY)
  })

  it('the output view and editor preview read them', () => {
    const body = rule('.term-md__content')

    expect(body).toMatch(/font-family:\s*var\(--md-font-family\)/)
    expect(body).toMatch(/font-size:\s*var\(--md-font-size\)/)
  })

  it('headings scale with the body size instead of fixed pixels', () => {
    for (const h of ['h1', 'h2', 'h3']) {
      expect(rule(`.term-md__content ${h}`)).toMatch(/font-size:\s*[\d.]+em/)
    }
  })

  it('the chat thread and its composer read them', () => {
    for (const sel of ['.term-chat__msg', '.term-chat__composer-input']) {
      const body = rule(sel)

      expect(body, sel).toMatch(/font-family:\s*var\(--md-font-family\)/)
      expect(body, sel).toMatch(/font-size:\s*var\(--md-font-size\)/)
    }
  })

  it('code uses the terminal font at 0.92 of the Markdown size, in both views', () => {
    for (const sel of ['.term-md__content code', '.term-chat__text code']) {
      const body = rule(sel)

      expect(body, sel).toMatch(/font-family:\s*var\(--md-code-font-family\)/)
      expect(body, sel).toMatch(/font-size:\s*0\.92em/)
    }
  })

  it('App.tsx publishes all three tokens from the resolvers', () => {
    const app = readFileSync(join(__dirname, 'App.tsx'), 'utf8')

    expect(app).toMatch(/setProperty\('--md-font-family', resolveMarkdownFontFamily\(/)
    expect(app).toMatch(/setProperty\('--md-font-size', `\$\{resolveMarkdownFontSize\(/)
    expect(app).toMatch(/setProperty\('--md-code-font-family', resolveMarkdownCodeFontFamily\(/)
  })
})
