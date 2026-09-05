// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  BRAND_PULSE_CLASS,
  HUD_BRAND_PULSE_CLASS,
  brandLogoSrc,
  brandPulseBackground,
  brandPulsePlan,
  hasBrandLogo
} from './brandPulse'
import { BrandPulse } from './agentIcons'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/**
 * The working indicator for agents that have a brand mark but no mascot art.
 *
 * The DECISION ("does this agent get a pulsing mark, and which glyph?") is the pure
 * `brandPulsePlan`, because it has two consumers with nothing in common: the React canvas badge and
 * the notch HUD, which builds DOM imperatively and must stay React-free. Testing the plan tests
 * both surfaces at once; the two thin renderers on top of it are checked separately below.
 */
describe('brandPulsePlan', () => {
  it('gives mascot-less asset agents their own mark', () => {
    for (const agentId of ['devin', 'gemini', 'opencode'] as const) {
      const plan = brandPulsePlan(agentId, 16)
      expect(plan, agentId).toEqual({ kind: 'asset', src: expect.any(String), size: 16 })
      // A real, non-empty URL — an asset import that silently resolved to '' would render an
      // invisible box, which is worse than the dot it replaced.
      expect(plan?.kind === 'asset' && plan.src.length, agentId).toBeGreaterThan(0)
    }
  })

  it('keeps grok AND copilot on their INLINE marks, not assets', () => {
    // Both marks are monochrome paths drawn in `currentColor`; loading them through `<img>` would
    // fix the fill to one theme's colour (grok black on dark, copilot near-invisible on light).
    // The generalized inline plan carries WHICH mark so each surface draws the right geometry.
    expect(brandPulsePlan('grok', 16)).toEqual({ kind: 'inline', mark: 'grok', size: 16 })
    expect(brandPulsePlan('copilot', 16)).toEqual({ kind: 'inline', mark: 'copilot', size: 16 })
  })

  it('answers nothing for an agent with no mark, so the caller falls back to the dot', () => {
    expect(brandPulsePlan('custom:abc', 16)).toBeNull()
    expect(brandPulsePlan(undefined, 16)).toBeNull()
  })

  it('passes the caller\'s size through, because the two surfaces draw at different heights', () => {
    // Canvas badge 16px (level with claude's critter), notch strip 13px (level with the sprites).
    expect(brandPulsePlan('gemini', 13)?.size).toBe(13)
    expect(brandPulsePlan('grok', 13)?.size).toBe(13)
  })
})

describe('brandPulseBackground', () => {
  // Measured, not assumed: with `url(${src})` the CSS parser rejected the declaration for ALL FOUR
  // marks (backgroundImage came back ''), because Vite inlines them as data URIs carrying literal
  // `'` and, for three of them, literal `(`/`)`. The notch strip would have shown an empty box.
  it('survives a real CSS parser for every mark', () => {
    for (const agentId of ['claude', 'codex', 'devin', 'gemini', 'opencode'] as const) {
      const plan = brandPulsePlan(agentId, 13)
      const src = plan?.kind === 'asset' ? plan.src : ''
      const el = document.createElement('span')
      el.style.backgroundImage = brandPulseBackground(src)
      expect(el.style.backgroundImage.length, agentId).toBeGreaterThan(0)
    }
  })

  it('is what the raw form is not — proof the quoting is the load-bearing part', () => {
    const plan = brandPulsePlan('opencode', 13)
    const src = plan?.kind === 'asset' ? plan.src : ''
    expect(src).toMatch(/[()]/) // the inner parens that break an unquoted url()
    const bare = document.createElement('span')
    bare.style.backgroundImage = `url(${src})`
    expect(bare.style.backgroundImage).toBe('')
  })
})

describe('hasBrandLogo', () => {
  it('counts grok, which is inlined rather than shipped as an asset', () => {
    // The trap this predicate exists to close: `agentId in AGENT_LOGO` is false for grok.
    expect(hasBrandLogo('grok')).toBe(true)
  })

  it('counts every asset mark and nothing else', () => {
    for (const agentId of ['claude', 'codex', 'devin', 'gemini', 'opencode', 'copilot'] as const) {
      expect(hasBrandLogo(agentId), agentId).toBe(true)
    }
    expect(hasBrandLogo('custom:abc')).toBe(false)
  })

  it('does not answer for a prototype key, and never plans a Function as the image', () => {
    // `data.agentId` is persisted in `.nodeterm/project.json` and hand-editable, and `AgentId` is
    // open — so this is a reachable value, not a theoretical one. Under `agentId in AGENT_LOGO` the
    // predicate said true and `AGENT_LOGO[agentId]` handed back Object.prototype's member, which
    // then reached an `<img src>` / a CSS `url()` as a stringified function body.
    for (const forged of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf']) {
      expect(hasBrandLogo(forged), forged).toBe(false)
      expect(brandPulsePlan(forged, 16), forged).toBeNull()
      expect(brandLogoSrc(forged), forged).toBeUndefined()
    }
  })
})

describe('BrandPulse', () => {
  const renderPulse = (agentId: string): HTMLElement => {
    const host = document.createElement('div')
    const root = createRoot(host)
    act(() => root.render(<BrandPulse agentId={agentId} size={16} />))
    return host
  }

  it('marks an asset agent with the pulse class and draws its logo', () => {
    const host = renderPulse('gemini')
    const el = host.querySelector(`.${BRAND_PULSE_CLASS}`)
    expect(el).not.toBeNull()
    expect(el?.querySelector('img')?.getAttribute('src')).toBeTruthy()
  })

  it('draws grok as the inline SVG carrying the pulse class itself', () => {
    // Byte-for-byte the pre-rename DOM shape: the class sits ON the <svg>, with no wrapper, so the
    // `currentColor` fill and the drop-shadow bloom resolve exactly as they did.
    const host = renderPulse('grok')
    const svg = host.querySelector('svg')
    expect(svg?.getAttribute('class')).toBe(BRAND_PULSE_CLASS)
    expect(svg?.getAttribute('fill')).toBe('currentColor')
    expect(host.querySelector('img')).toBeNull()
  })

  it('renders nothing for an agent with no mark', () => {
    expect(renderPulse('custom:abc').firstChild).toBeNull()
  })
})

describe('the pulse classes exist in both stylesheets', () => {
  // The class names are strings on one side and selectors on the other, so a rename can only be
  // half-done. Nothing else would notice: a missing selector loses the animation silently.
  // `.replace(/\r\n/g, '\n')` on every read below: a test that reads a checked-in file must not
  // care how git checked it out. Git for Windows defaults to `core.autocrlf=true`, so a Windows
  // clone has CRLF working files, and a slice on a literal containing `\n` (`indexOf('}\n}')`,
  // `indexOf('\n}\n')`) then matches nothing and the assertion fails on a checkout with zero local
  // changes (issue #578). `.gitattributes` is the durable half of the fix; this is the half that
  // survives a working tree that was checked out before it landed.
  const CANVAS_CSS = readFileSync(join(__dirname, '..', 'styles.css'), 'utf8').replace(/\r\n/g, '\n')
  const HUD_CSS = readFileSync(join(__dirname, '..', 'hud', 'hud.css'), 'utf8').replace(/\r\n/g, '\n')

  it('the canvas badge class is styled and animated', () => {
    expect(CANVAS_CSS).toContain(`.${BRAND_PULSE_CLASS} {`)
    expect(CANVAS_CSS).toContain('@keyframes mascot-pulse-brand')
  })

  it('the notch strip class is styled and animated', () => {
    const hudClass = HUD_BRAND_PULSE_CLASS.split(' ').at(-1)
    expect(HUD_CSS).toContain(`.${hudClass} {`)
    expect(HUD_CSS).toContain('@keyframes mascot-pulse-brand')
  })

  it('leaves no agent-specific name behind, since the animation is now shared', () => {
    for (const css of [CANVAS_CSS, HUD_CSS]) {
      expect(css).not.toContain('mascot--grok')
      expect(css).not.toContain('mascot-pulse-grok')
    }
  })

  it('still freezes at the LIT end of the cycle for reduced motion', () => {
    // A working node must read as awake, not dimmed — the frozen frame is opacity 1, not 0.55.
    // styles.css has several reduced-motion blocks, so pick the one that names the pulse class
    // rather than the first one in the file.
    for (const [css, cls] of [
      [CANVAS_CSS, BRAND_PULSE_CLASS],
      [HUD_CSS, HUD_BRAND_PULSE_CLASS.split(' ').at(-1) as string]
    ] as const) {
      const blocks = css
        .split('@media (prefers-reduced-motion: reduce)')
        .slice(1)
        .map((rest) => rest.slice(0, rest.indexOf('}\n}') + 3))
      const block = blocks.find((b) => b.includes(`.${cls}`))
      expect(block, cls).toBeTruthy()
      expect(block).toContain('opacity: 1')
      expect(block).toContain('drop-shadow(0 0 1px currentColor)')
    }
  })
})
