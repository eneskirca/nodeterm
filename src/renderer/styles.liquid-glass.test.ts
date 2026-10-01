import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SYSTEM_COLORS } from './lib/palette'

/**
 * Liquid Glass is a THEME, so its CSS must (a) be unreachable unless `data-nt-glass` is on, and
 * (b) neutralise the per-node accent colour, which arrives as INLINE styles and so needs
 * `!important`. Parsed from the real stylesheet rather than asserted as substrings, so a rule that
 * moves out of the gate or loses its override goes red.
 */
const CSS = readFileSync(join(__dirname, 'styles.css'), 'utf8').replace(/\r\n/g, '\n')
const GATE = ":root[data-nt-glass='on']"

interface Rule {
  selector: string
  body: string
}
const rules: Rule[] = []
{
  const noComments = CSS.replace(/\/\*[\s\S]*?\*\//g, '')
  const re = /([^{}]+)\{([^{}]*)\}/g
  let m: RegExpExecArray | null
  while ((m = re.exec(noComments))) rules.push({ selector: m[1].replace(/\s+/g, ' ').trim(), body: m[2] })
}
const gated = (needle: string): Rule[] =>
  rules.filter((r) => r.selector.startsWith(GATE) && r.selector.includes(needle))

describe('Liquid Glass stylesheet', () => {
  it('uses the chrome fill only behind the data-nt-glass gate', () => {
    const users = rules.filter((r) => r.body.includes('--glass-chrome-bg') && !r.selector.startsWith(GATE))
    expect(users.map((r) => r.selector)).toEqual([])
  })

  it('neutralises the inline per-node top border and colour dot', () => {
    const node = gated('.term-node').find((r) => r.selector === `${GATE} .term-node`)
    expect(node?.body).toMatch(/border-top-color:\s*var\(--glass-edge\)\s*!important/)
    const dot = gated('.term-node__color')[0]
    expect(dot?.body).toMatch(/background:\s*transparent\s*!important/)
  })

  it('keeps selection visible with neutral ink, not the accent', () => {
    const sel = gated('.term-node.selected')[0]
    expect(sel?.body).toMatch(/border-color:\s*var\(--text\)\s*!important/)
    expect(sel?.body).not.toMatch(/--accent/)
  })

  it('keeps the unread state perceivable (its own border survives the neutral top edge)', () => {
    const unread = gated('.term-node.unread')[0]
    expect(unread?.body).toMatch(/border-top-color:\s*var\(--state-unread\)\s*!important/)
  })

  it('never blurs a container nested in a blurred one', () => {
    const blurred = gated('').filter((r) => /backdrop-filter:\s*var\(--glass-blur\)/.test(r.body))
    for (const nested of ['.dock-menu', '.dock-menu__sub', '.kanban-card', '.kanban-modal__termwrap']) {
      expect(blurred.some((r) => r.selector.includes(nested))).toBe(false)
    }
  })

  it('slider scope: text surfaces take the readable-floored fill, small controls the slider fill', () => {
    const outer = (needle: string): Rule | undefined =>
      gated(needle).find((r) => /backdrop-filter:/.test(r.body) && r.selector.includes(':is('))
    for (const text of ['.nt-settings', '.palette', '.ctx-menu', '.tab-menu', '.sessions-sidebar', '.drawer', '.tooltip', '.confirm', '.usage-popover', '.kanban-col', '.kanban-add-col', '.kanban-modal']) {
      expect(outer(text)?.body, text).toMatch(/var\(--glass-chrome-bg\)[\s\S]*var\(--glass-text-blur\)/)
    }
    for (const control of ['.tabbar', '.react-flow__controls', '.react-flow__minimap', '.usage-pill', '.sysres-pill', '.usage-refresh', '.controls-cluster > button', '.sessions-icon-cluster button']) {
      expect(outer(control)?.body, control).toMatch(/var\(--glass-control-bg\)[\s\S]*var\(--glass-control-blur\)/)
    }
  })

  it('row highlights on glass never re-stack a panel token (visual QA H1/H2)', () => {
    for (const row of ['.palette__item.active', '.settings-nav-row', '.ctx-item', '.tab-menu button', '.tab.active', '.dock-btn', '.dock-zoom', '.ss-row:hover', 'button.bg-panel-header', '.seg-pill-opt.active', '.speech-lang__row.is-active']) {
      const hits = gated(row).filter((r) => /background(-color)?:/.test(r.body))
      expect(hits.length, row).toBeGreaterThan(0)
      for (const r of hits) expect(r.body, row).not.toMatch(/--panel|--glass-chrome-bg/)
    }
  })

  it('highlighted rows carry --text-strong, the ink their readable alpha is solved for (N2)', () => {
    // …the hover lift too: it is not in the solver's list, and --text on it is 4.11:1 (code review 5 #1).
    for (const row of ['.palette__item.active', '.ctx-item', '.tab.active', '.dock-zoom.active', '.seg-pill-opt.active', '.dock-btn', '.ss-row:hover', '.dock-menu__row:hover']) {
      const hits = gated(row).filter((r) => /background(-color)?:/.test(r.body))
      expect(hits.length, row).toBeGreaterThan(0)
      for (const r of hits) expect(r.body, row).toMatch(/color:\s*var\(--text-strong\)/)
    }
    // The default Button's ink holds on its OWN hover lift too — no :not(:hover) on the colour rule
    // (code review 6 #2: --text on `hover:bg-fill-weak` measured 4.11 dark / 4.04 light).
    expect(rules.some((r) => r.selector === `${GATE} button.bg-panel-header` && /color:\s*var\(--text-strong\)/.test(r.body))).toBe(true)
    // A Layouts row is one highlight: its main button never stacks a second lift on the row's.
    expect(gated('.dock-menu button').some((r) => /dock-menu button(?!:not\(\.dock-menu__row-main\))/.test(r.selector) && /:hover/.test(r.selector))).toBe(false)
    expect(gated('button.dock-menu__row-main').some((r) => /color:\s*var\(--text-strong\)/.test(r.body))).toBe(true)
  })

  it('never translucent without a working blur (N1)', () => {
    // A container that hosts pop-out menus is no backdrop root: its glass lives on ::before.
    const host = rules.find((r) => r.selector === `${GATE} :is(.dock, .dock-menu, .dock-menu__sub)`)
    expect(host?.body).toMatch(/background:\s*transparent\s*!important/)
    expect(host?.body).toMatch(/(^|[^-])backdrop-filter:\s*none/)
    const layer = rules.find((r) => r.selector === `${GATE} :is(.dock, .dock-menu, .dock-menu__sub)::before`)
    expect(layer?.body).toMatch(/background:\s*var\(--glass-chrome-bg\)[\s\S]*backdrop-filter:\s*var\(--glass-text-blur\)/)
    const dock = rules.find((r) => r.selector === `${GATE} .dock::before`)
    expect(dock?.body).toMatch(/var\(--glass-control-bg\)[\s\S]*var\(--glass-control-blur\)/)
    // Context menus host flyouts (Snap to zone) the same way, except menus that scroll (visual QA
    // round 3, NC2).
    const ctxHost = `${GATE} .ctx-menu:not(.ctx-menu--scroll, .ctx-submenu:not(.ctx-submenu--host))`
    expect(rules.find((r) => r.selector === ctxHost)?.body).toMatch(/background:\s*transparent\s*!important[\s\S]*(^|[^-])backdrop-filter:\s*none/)
    expect(rules.find((r) => r.selector === `${ctxHost}::before`)?.body).toMatch(/var\(--glass-chrome-bg\)[\s\S]*var\(--glass-text-blur\)/)
    // Popovers inside a glass node or the card modal (their backdrop root) cannot blur: glass is
    // opt-in, so nothing hands them a translucent glass fill and they keep their opaque colour.
    for (const nested of ['.dock-menu', '.dock-menu__sub', '.ctx-popover', '.color-popover', '.label-picker', '.kanban-meta__picker', '.live-pop']) {
      const fills = gated(nested).filter(
        (r) => !r.selector.includes('::before') && /background:[^;]*var\(--glass-(chrome|control)-bg\)/.test(r.body)
      )
      expect(fills.map((r) => r.selector), nested).toEqual([])
    }
  })

  it('the opaque floating surfaces share one look and keep their own placeholder (N4-M1/M2)', () => {
    // The live-link popover is one of them: opaque over a glass node header or the card modal.
    const OPAQUE = ['.ctx-popover', '.color-popover', '.label-picker', '.kanban-meta__picker', '.live-pop']
    const look = rules.find((r) => r.selector === `${GATE} :is(${OPAQUE.join(', ')})`)
    expect(look?.body).toMatch(/background:\s*var\(--panel\)[\s\S]*border:\s*1px solid var\(--glass-edge\)/)
    const placeholder = rules.find((r) => r.selector.startsWith(`${GATE} :not(`) && r.selector.endsWith('::placeholder'))
    expect(placeholder?.selector).toContain(`:is(${OPAQUE.join(', ')}) *`)
  })

  it('OK-range meters match the literal green the fills are drawn in (M1)', () => {
    expect(SYSTEM_COLORS.dark.green.toLowerCase()).toBe('#30d158') // = rgb(48, 209, 88)
    expect(gated('[style*=').some((r) => r.selector.includes("[style*='rgb(48, 209, 88)']"))).toBe(true)
  })

  it('kanban cards are a lift without their own blur (no glass on glass)', () => {
    const card = gated('.kanban-card').find((r) => r.selector === `${GATE} .kanban-card`)
    expect(card?.body).toMatch(/background:\s*var\(--glass-lift-hover\)/)
    expect(gated('.kanban-card').some((r) => /backdrop-filter/.test(r.body))).toBe(false)
  })

  it('draws minimap nodes in neutral ink, not node colour, and keeps status strokes', () => {
    const fill = gated('.react-flow__minimap-node').find((r) => r.selector.endsWith('.react-flow__minimap-node'))
    expect(fill?.body).toMatch(/fill:\s*rgba\(var\(--tint-rgb\),[^)]*\)\s*!important/)
    const stroke = gated('.react-flow__minimap-node:not(.mm-working)')[0]
    expect(stroke?.selector).toContain(':not(.mm-attention):not(.mm-unread)')
  })
})
