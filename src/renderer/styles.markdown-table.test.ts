import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Rendered-Markdown tables get gridlines in every reading view. The chat view had no table rules
 * at all (cells ran together with no lines), and the output view's lines used the 10% separator
 * token. One rule group now covers both containers; this pins that neither drops out of it.
 */
const CSS = readFileSync(join(__dirname, 'styles.css'), 'utf8').replace(/\r\n/g, '\n')

/** The body of the rule whose selector list is exactly `selectors` (joined by `,\n`). */
function group(selectors: string[]): string {
  const head = `${selectors.join(',\n')} {`
  const at = CSS.indexOf(`\n${head}`)
  if (at < 0) throw new Error(`no rule for ${selectors.join(', ')}`)
  return CSS.slice(at, CSS.indexOf('}', at))
}

describe('Markdown table gridlines', () => {
  it('every cell of both views has a visible border', () => {
    const cells = group(['.term-md__content th', '.term-md__content td', '.term-chat__text th', '.term-chat__text td'])

    expect(cells).toMatch(/border:\s*1px solid rgba\(var\(--tint-rgb\), 0\.22\)/)
  })

  it('header cells are tinted in both views', () => {
    expect(group(['.term-md__content th', '.term-chat__text th'])).toMatch(/background:/)
  })

  it('a wide table scrolls inside itself in both views', () => {
    const table = group(['.term-md__content table', '.term-chat__text table'])

    expect(table).toMatch(/border-collapse:\s*collapse/)
    expect(table).toMatch(/overflow-x:\s*auto/)
    expect(table).toMatch(/max-width:\s*100%/)
  })

  it('leaves text-align to the Markdown column alignment, start-aligning only unaligned headers', () => {
    const cells = group(['.term-md__content th', '.term-md__content td', '.term-chat__text th', '.term-chat__text td'])
    const unaligned = group(['.term-md__content th:not([align])', '.term-chat__text th:not([align])'])

    expect(cells).not.toMatch(/text-align/)
    expect(unaligned).toMatch(/text-align:\s*start/)
  })
})
