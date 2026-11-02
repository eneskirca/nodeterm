import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FROST_PAD } from './lib/glassFrost'

const CSS = readFileSync(join(__dirname, 'styles.css'), 'utf8').replace(/\r\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '')

/** The declarations of the first rule whose selector list is exactly `selector`. */
function rule(selector: string): string {
  const at = CSS.indexOf(`${selector} {`)
  expect(at, selector).toBeGreaterThanOrEqual(0)
  const open = CSS.indexOf('{', at)
  return CSS.slice(open + 1, CSS.indexOf('}', open)).replace(/\s+/g, ' ')
}

// Static frost (lib/glassFrost.ts): a terminal's live backdrop-filter re-ran on every redraw of
// its text. The frost replaces it only where it can stand in for it.
describe('Liquid Glass static frost', () => {
  it('is hidden unless the frost is on', () => {
    expect(rule('.term-node__frost')).toContain('display: none')
  })

  it('switches the live backdrop off only under the frost gate, and never for a focused node', () => {
    const r = rule(":root[data-nt-glass='on'][data-nt-frost='on'] .term-node.term-node--glass:not(.term-node--focused)")
    expect(r).toMatch(/(^|; )backdrop-filter: none/)
    expect(r).toContain('background: transparent')
    // A stacking context here would paint the frost (z-index -1) over the node's own border.
    expect(r).not.toContain('isolation')
  })

  it('frosts with the very chain the live backdrop used', () => {
    const live = rule(":root[data-nt-glass='on'] .term-node")
    expect(live).toContain('backdrop-filter: var(--glass-term-blur) var(--term-glass-backdrop,)')
    expect(rule('.term-node__frost::before')).toContain('filter: var(--glass-term-blur) var(--term-glass-backdrop,)')
  })

  it('reaches FROST_PAD past the node, and aligns by the same margin', () => {
    const r = rule('.term-node__frost::before')
    expect(r).toContain(`inset: -${FROST_PAD}px`)
    expect(r.match(new RegExp(`\\* 1px \\+ ${FROST_PAD}px`, 'g'))).toHaveLength(2)
  })

  it('paints the tint over the frost, from the same token the node used', () => {
    expect(rule('.term-node__frost::after')).toContain('background: var(--term-glass-bg)')
  })

  it('drops only the blur during a camera move with Keep blur while moving off', () => {
    expect(rule(":root[data-nt-glass='on'] .canvas-moving .term-node__frost::before")).toContain(
      'filter: var(--term-glass-backdrop, none)'
    )
  })
})
