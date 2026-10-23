import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * xterm's DOM renderer gives every row an INLINE `width` equal to the grid and `overflow: hidden`.
 * A glyph's ink runs a fraction past its advance (Menlo's `m` and `w`), so the last column of every
 * full row lost its right edge — MEASURED on a DPR 1 display at canvas zoom 1.38: a 616px row held a
 * 617px span and the `m` of "t/m" was cut. Letting rows overflow shows the whole glyph; the node
 * root still clips, so nothing can spill past the node.
 */
const CSS = readFileSync(join(__dirname, 'styles.css'), 'utf8').replace(/\r\n/g, '\n')
const XTERM = readFileSync(join(__dirname, '../../node_modules/@xterm/xterm/lib/xterm.js'), 'utf8')

function ruleBody(selector: string): string | null {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const m = new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(CSS)
  return m ? m[1] : null
}

describe('terminal rows do not clip the last column', () => {
  it('lets a DOM-renderer row overflow, overriding the inline style xterm sets', () => {
    const body = ruleBody('.xterm-rows > div')
    expect(body).not.toBeNull()
    // The inline `overflow: hidden` beats any selector, so the override needs !important.
    expect(body).toMatch(/overflow-x:\s*visible\s*!important/)
    // Vertically it must still clip, or underlines and descenders paint into the next row.
    // `clip`, not `hidden`: `hidden` would turn the other axis's `visible` into `auto`.
    expect(body).toMatch(/overflow-y:\s*clip\s*!important/)
    expect(body).not.toMatch(/(^|[^-])overflow:\s*visible/)
  })

  it('still sees xterm setting the inline clip — drop the override if xterm stops doing it', () => {
    expect(XTERM).toContain('style.overflow="hidden"')
  })

  it('keeps the terminal node root clipping, so a row cannot paint outside its node', () => {
    const body = ruleBody('.term-node')
    expect(body).not.toBeNull()
    expect(body).toMatch(/overflow:\s*hidden/)
  })
})
