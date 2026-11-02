import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SYSTEM_COLORS } from './lib/palette'
import { gitStatusColor } from './lib/gitStatusColors'
import { GLASS_CHIP_HUES } from './lib/glassContrast'

// The semantic colour system (styles.css `--sys-*` palette + `--state-*` / `--git-*` roles): every
// role resolves to a colour in every theme, the JS table and the CSS agree, and each meaning has
// ONE source that every surface drawing it reads.

const read = (rel: string): string => readFileSync(join(__dirname, rel), 'utf8').replace(/\r\n/g, '\n')
const CSS = read('styles.css')

/** The declarations of the first rule whose selector line matches exactly. */
function block(selector: string): Map<string, string> {
  const start = CSS.indexOf(`\n${selector} {\n`)
  expect(start, selector).toBeGreaterThanOrEqual(0)
  const end = CSS.indexOf('\n}\n', start)
  const body = CSS.slice(start, end).replace(/\/\*[\s\S]*?\*\//g, '')
  return new Map(Array.from(body.matchAll(/^\s*(--[a-z0-9-]+)\s*:\s*([^;]+);/gm), (m) => [m[1], m[2].trim()]))
}

/** Every rule with exactly this selector, merged in source order (later declarations win). */
function blocks(selector: string): Map<string, string> {
  const out = new Map<string, string>()
  let from = 0
  for (;;) {
    const start = CSS.indexOf(`\n${selector} {\n`, from)
    if (start < 0) return out
    const end = CSS.indexOf('\n}\n', start)
    const body = CSS.slice(start, end).replace(/\/\*[\s\S]*?\*\//g, '')
    for (const m of body.matchAll(/^\s*(--[a-z0-9-]+)\s*:\s*([^;]+);/gm)) out.set(m[1], m[2].trim())
    from = end
  }
}

/** The literal a token finally paints (var() chains substituted), for comparing meanings. */
function literal(name: string, tokens: Map<string, string>, depth = 0): string {
  const v = tokens.get(name) ?? ''
  if (depth > 10) return v
  return v.replace(/var\(\s*(--[a-z0-9-]+)\s*\)/g, (_, r: string) => literal(r, tokens, depth + 1)).toLowerCase()
}

const DARK = block(':root')
const LIGHT = new Map([...DARK, ...block(":root[data-theme='light']")])
const GLASS = blocks(":root[data-nt-glass='on']")
const THEMES = { dark: DARK, light: LIGHT }
const GLASS_THEMES = { dark: new Map([...DARK, ...GLASS]), light: new Map([...LIGHT, ...GLASS]) }

/** Follow var() chains; true when every reference bottoms out in a literal colour. */
function resolves(value: string, tokens: Map<string, string>, depth = 0): boolean {
  if (depth > 10) return false
  const refs = Array.from(value.matchAll(/var\(\s*(--[a-z0-9-]+)\s*\)/g), (m) => m[1])
  if (refs.length === 0) return /#[0-9a-f]{3,8}\b|rgba?\(|transparent/i.test(value)
  return refs.every((r) => tokens.has(r) && resolves(tokens.get(r)!, tokens, depth + 1))
}

const ROLES = [
  '--state-working',
  '--state-attention',
  '--state-unread',
  '--state-error',
  '--state-success',
  '--state-warning',
  '--state-queued',
  '--state-automation',
  '--git-modified',
  '--git-added',
  '--git-deleted',
  '--git-renamed',
  '--git-conflict'
]

describe('palette tokens', () => {
  for (const [theme, tokens] of Object.entries(THEMES)) {
    it(`every semantic role resolves to a colour (${theme})`, () => {
      for (const role of ROLES) expect(resolves(tokens.get(role) ?? '', tokens), `${role} in ${theme}`).toBe(true)
    })

    it(`--sys-* matches lib/palette.ts (${theme})`, () => {
      for (const [name, hex] of Object.entries(SYSTEM_COLORS[theme as 'dark' | 'light'])) {
        expect(tokens.get(`--sys-${name}`), `--sys-${name}`).toBe(hex)
      }
    })
  }

  it('no rule outside the token blocks spells a status hue as a literal', () => {
    // The hues the audit found hand-typed at ~200 sites. Brand clay stays legal on the two
    // Claude-identity surfaces (subagent node, usage pill) and the onboarding decoration.
    const rules = CSS.slice(CSS.indexOf('\n}\n', CSS.search(/^:root\[data-theme='light'\]/m)))
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*--sys-[a-z]+:.*$/gm, '') // palette declarations (the Increase Contrast block)
      // Declarations only: a SELECTOR may name a hue to match an inline literal it repaints (the
      // Liquid Glass OK-meter remap, `[style*='rgb(48, 209, 88)']`) — that paints nothing.
      .replace(/[^{}]+\{/g, '{')
    const hits = rules.match(
      /rgba?\(\s*(255,\s*69,\s*58|10,\s*132,\s*255|48,\s*209,\s*88|255,\s*159,\s*10|191,\s*122,\s*240|217,\s*119,\s*87)|#(ff453a|30d158|32d74b|ff9f0a|bf7af0|ffb340|f85149|8e8e93)\b/gi
    )
    expect(hits ?? []).toEqual([])
  })
})

describe('Liquid Glass palette', () => {
  for (const [theme, tokens] of Object.entries(GLASS_THEMES)) {
    it(`every role still resolves under glass (${theme})`, () => {
      for (const role of ROLES) expect(resolves(tokens.get(role) ?? '', tokens), `${role} in ${theme}`).toBe(true)
    })

    it(`maps each meaning to its HIG colour (${theme})`, () => {
      expect(literal('--state-working', tokens)).toBe(literal('--accent', tokens))
      expect(literal('--state-attention', tokens)).toBe(literal('--sys-orange', tokens))
      expect(literal('--state-unread', tokens)).toBe(literal('--sys-green', tokens))
      expect(literal('--state-warning', tokens)).toBe(literal('--sys-yellow', tokens))
      expect(literal('--state-error', tokens)).toBe(literal('--sys-red', tokens))
    })

    it(`never uses one colour for two meanings (${theme})`, () => {
      const meanings = ['--state-working', '--state-attention', '--state-unread', '--state-warning', '--state-error']
      const hues = meanings.map((m) => literal(m, tokens))
      expect(new Set(hues).size).toBe(meanings.length)
    })
  }

  it('status labels on glass are ink over a tinted chip', () => {
    const rule = CSS.slice(CSS.indexOf(":root[data-nt-glass='on'] .term-node__status {"))
    const body = rule.slice(0, rule.indexOf('}'))
    expect(body).toContain('-webkit-text-fill-color: var(--text)')
    expect(body).toContain('color-mix(in srgb, currentColor')
  })
})

describe('git status colours have one source', () => {
  it('both git panels draw from lib/gitStatusColors', () => {
    for (const f of ['components/SourceControlPanel.tsx', 'components/git-history/GitHistoryCommitFiles.tsx']) {
      const src = read(f)
      expect(src, f).toContain('gitStatusColor(')
      expect(src, f).not.toMatch(/STATUS_COLOR|'#[0-9a-f]{6}'/i)
    }
  })

  it('every status resolves to a defined role token, unknown to the label colour', () => {
    for (const s of ['M', 'A', 'D', 'R', 'U']) {
      const v = gitStatusColor(s)
      expect(v).toMatch(/^var\(--git-/)
      expect(resolves(v, DARK)).toBe(true)
    }
    expect(gitStatusColor('??')).toBe('var(--text)')
  })
})

describe('minimap status strokes', () => {
  const canvas = read('canvas/Canvas.tsx')
  const pairs = [
    ['working', "st?.state === 'working') return 'var(--mm-working)'", '#ffd60a'],
    ['attention', "st?.state === 'blocked') return 'var(--mm-attention)'", '#ff453a'],
    ['unread', "st?.unread) return 'var(--mm-unread)'", '#d97757']
  ] as const

  for (const [state, stroke, legacy] of pairs) {
    it(`${state}: stroke and halo read --mm-${state}`, () => {
      expect(canvas).toContain(stroke)
      const mm = CSS.slice(CSS.indexOf(`\n.minimap .mm-${state} {\n  filter`))
      expect(mm.slice(0, mm.indexOf('}'))).toContain(`var(--mm-${state})`)
    })

    it(`${state}: the default look keeps its pre-glass map colour, glass maps it to the node glow's role`, () => {
      expect(literal(`--mm-${state}`, DARK)).toBe(legacy)
      expect(literal(`--mm-${state}`, LIGHT)).toBe(legacy)
      for (const tokens of [GLASS_THEMES.dark, GLASS_THEMES.light]) {
        expect(literal(`--mm-${state}`, tokens)).toBe(literal(`--state-${state}`, tokens))
      }
      const glow = CSS.slice(CSS.indexOf(`.react-flow__node:has(.term-node.${state})::after {`))
      expect(glow.slice(0, glow.indexOf('}'))).toContain(`var(--state-${state})`)
    })
  }
})

describe('Liquid Glass accessibility fallbacks', () => {
  /** Body of the first `@media <query> {` block (balanced braces). */
  const media = (query: string): string => {
    const start = CSS.indexOf(`@media ${query} {`)
    expect(start, query).toBeGreaterThanOrEqual(0)
    let depth = 0
    for (let i = CSS.indexOf('{', start); i < CSS.length; i++) {
      if (CSS[i] === '{') depth++
      else if (CSS[i] === '}' && --depth === 0) return CSS.slice(start, i + 1)
    }
    return ''
  }

  it('Reduce Transparency drops blur, refraction and the rim light on glass', () => {
    const m = media('(prefers-reduced-transparency: reduce)')
    expect(m).toContain(":root[data-nt-glass='on']")
    expect(m).toMatch(/--glass-blur:\s*none/)
    expect(m).toMatch(/:is\(\.term-node[^)]*\)::before \{\s*display: none/)
  })

  it('Increase Contrast strengthens edges and takes the HIG increased-contrast palette', () => {
    const m = media('(prefers-contrast: more)')
    expect(m).toMatch(/--glass-edge:\s*rgba\(var\(--tint-rgb\), 0\.5\)/)
    const light = m.slice(m.indexOf("[data-theme='light']"))
    const dark = m.slice(0, m.indexOf("[data-theme='light']"))
    for (const [name, hex] of Object.entries(SYSTEM_COLORS.darkContrast)) expect(dark).toContain(`--sys-${name}: ${hex};`)
    for (const [name, hex] of Object.entries(SYSTEM_COLORS.lightContrast)) expect(light).toContain(`--sys-${name}: ${hex};`)
  })

  it('Reduce Motion holds every state glow still', () => {
    const all = CSS.split('@media (prefers-reduced-motion: reduce) {').slice(1).join('')
    for (const state of ['unread', 'working', 'attention']) {
      const rule = all.slice(all.indexOf(`.react-flow__node:has(.term-node.${state})::after {`))
      expect(rule.slice(0, rule.indexOf('}')), state).toContain('animation: none')
    }
    expect(all).toMatch(/\.minimap \.mm-unread \{\s*animation: none/)
    // Specificity: the pulsing dots are (0,2,0), so the stop must be at least that.
    expect(all).toContain('.term-node__status .term-node__status-dot')
    for (const m of CSS.matchAll(/^(\.term-node__status--[a-z-]+ \.term-node__status-dot) \{[^}]*animation:[^}]*infinite/gm)) {
      expect(CSS.indexOf(m[1])).toBeLessThan(CSS.lastIndexOf('.term-node__status .term-node__status-dot'))
    }
  })
})

describe('needs-you under Liquid Glass is an inner light', () => {
  const rule = (sel: string): string => {
    const i = CSS.indexOf(`${sel} {`)
    expect(i, sel).toBeGreaterThanOrEqual(0)
    return CSS.slice(i, CSS.indexOf('}', i))
  }
  const before = ":root[data-nt-glass='on'] .react-flow__node:has(.term-node.attention)::before"

  it('an inset rim light in --state-attention that never takes the pointer', () => {
    const r = rule(before)
    expect(r).toContain('pointer-events: none')
    expect(r).toMatch(/inset 0 0 0 1px color-mix\(in srgb, var\(--state-attention\)/)
    expect(r).toContain('animation-play-state: var(--nt-anim-state)')
    expect(rule(":root[data-nt-glass='on'] .react-flow__node:has(.term-node.attention)::after")).toContain('display: none')
  })

  it('holds still when the window is idle and under Reduce Motion', () => {
    expect(rule(`:root[data-nt-glass='on'][data-nt-window='idle'] .react-flow__node:has(.term-node.attention)::before`)).toContain('animation: none')
    const reduced = CSS.slice(CSS.lastIndexOf('@media (prefers-reduced-motion: reduce) {'))
    expect(reduced).toContain(before)
    expect(reduced).toContain('animation: none')
  })
})

describe('terminal glass blur', () => {
  it('terminal nodes frost 15% less than the chrome, and drop it under Reduce Transparency', () => {
    const glass = blocks(":root[data-nt-glass='on']")
    // Both curves drop to 4px (x0.85) at Clear and meet the old 16 + 12t from the Readable tick on.
    const curve = '16px + 12px * var(--glass-t) - 12px * max(0, 1 - var(--glass-t) / 0.7)'
    expect(glass.get('--glass-blur')).toContain(`blur(calc(${curve}))`)
    expect(glass.get('--glass-term-blur')).toContain(`blur(calc((${curve}) * 0.85))`)
    const rule = CSS.slice(CSS.indexOf(":root[data-nt-glass='on'] .term-node {\n"))
    expect(rule.slice(0, rule.indexOf('}'))).toContain('backdrop-filter: var(--glass-term-blur)')
    const reduce = CSS.slice(CSS.indexOf('@media (prefers-reduced-transparency: reduce) {'))
    expect(reduce.slice(0, reduce.indexOf('}'))).toMatch(/--glass-term-blur:\s*none/)
  })

  // Refraction first in the chain leaked a band of SHARP backdrop inside every rim (visual QA C1:
  // terminal text readable through a menu's edge at every slider position). It must bend pixels
  // that are already blurred.
  it.each(['--glass-blur', '--glass-term-blur'])('%s refracts last, after the blur', (name) => {
    const chain = blocks(":root[data-nt-glass='on']").get(name)!.replace(/\s+/g, ' ')
    expect(chain.indexOf('blur(')).toBe(0)
    // Only the colour-matrix squeeze may follow it: it moves no pixels, so it cannot bring back the
    // sharp rim band a reference filter ahead of blur() caused (visual QA C1).
    expect(chain.trim().replace(/ var\(--glass-frost,\)$/, '').endsWith('var(--glass-refract,)')).toBe(true)
  })

  // Refraction is opt-in: App.tsx sets `--glass-refract` inline only left of the Readable tick
  // (glassRefractionOn). A stylesheet default would switch the costliest filter back on at every
  // slider position, Tinted included, where it bends nothing.
  it('the stylesheet never turns refraction on by itself', () => {
    expect(CSS).not.toMatch(/--glass-refract\s*:/)
    expect(CSS).not.toMatch(/var\(--glass-refract\)/)
  })

  it('terminal glass flattens the backdrop luminance toward Tinted, and not at Clear', () => {
    expect(blocks(":root[data-nt-glass='on']").get('--glass-term-blur')).toContain('contrast(calc(1 - var(--glass-t)))')
  })
})

describe('glass rim light', () => {
  it('a masked 1px ring on the glass nodes, never a surface-wide sheen', () => {
    const i = CSS.indexOf(":root[data-nt-glass='on'] :is(.term-node, .files-node, .loop-node, .subagent-node, .trigger-node, .dino-node)::before {\n  --glass-rim")
    const r = CSS.slice(i, CSS.indexOf('\n}', i))
    expect(r).toContain('padding: 1px')
    expect(r).toContain('pointer-events: none')
    expect(r).toContain('-webkit-mask-composite: xor')
    expect(CSS).not.toContain('--glass-sheen')
  })
})

describe('needs-you and priorities under glass', () => {
  it('every needs-you surface reads the attention role, never the warning one', () => {
    for (const sel of ['.kanban-badge--needs {', '.term-node__status--attention {', '.sessmem-row__dot--attention {']) {
      const r = CSS.slice(CSS.indexOf(sel))
      const body = r.slice(0, r.indexOf('}'))
      expect(body, sel).toMatch(/--(state-attention|attention-text)/)
      expect(body, sel).not.toMatch(/--warn|--state-warning/)
    }
  })

  it('kanban priorities: no two levels share a colour, with or without glass', () => {
    const levels = ['--caution', '--priority-high', '--danger', '--state-queued']
    for (const tokens of [DARK, LIGHT, GLASS_THEMES.dark, GLASS_THEMES.light]) {
      expect(new Set(levels.map((l) => literal(l, tokens))).size).toBe(levels.length)
    }
    expect(literal('--priority-high', GLASS_THEMES.dark)).not.toBe(literal('--state-attention', GLASS_THEMES.dark))
  })

  it('the glass chip hues cover every badge token (lib/glassContrast GLASS_CHIP_HUES)', () => {
    const badge = ['--success', '--agent-working', '--attention-text', '--danger', '--caution', '--state-queued', '--state-automation', '--state-unread']
    for (const tokens of [GLASS_THEMES.dark, GLASS_THEMES.light]) {
      for (const t of badge) expect(GLASS_CHIP_HUES, t).toContain(literal(t, tokens))
    }
  })
})

describe('no nested blur for the context popover', () => {
  it('.ctx-popover (inside a blurred node) is never blurred or given the glass fill (visual QA N1)', () => {
    // Glass is opt-in (styles.glass-traps.test.ts): an unlisted popover keeps its opaque colour.
    const glassRules = CSS.split('}').filter((r) => r.includes(":root[data-nt-glass='on']") && /(ctx|color)-popover/.test(r.slice(0, r.indexOf('{'))))
    expect(glassRules.filter((r) => /backdrop-filter|--glass-(chrome|control)-bg/.test(r))).toEqual([])
    expect(CSS).toMatch(/\.ctx-popover \{[^}]*background: rgba\(var\(--popover-rgb\), 0\.98\)/)
  })
})
