import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { TERMINAL_THEMES } from '../terminal/themes'
import { SYSTEM_NODE_COLOR_SWATCHES } from '@shared/node-colors'
import {
  GLASS_ALPHA_MAX,
  GLASS_ALPHA_MIN,
  composite,
  contrastRatio,
  glassTintAlpha,
  chromeContrast,
  glassChromeAlpha,
  glassChromeHighlights,
  glassControlClearAlpha,
  chromeHighlightContrast,
  GLASS_LIFT_ALPHA,
  GLASS_SELECT_MIX,
  parseCssColor,
  parseHex,
  worstContrast,
  GLASS_CLEAR_ALPHA,
  GLASS_CONTROL_CLEAR_ALPHA,
  glassChromeAlphas,
  GLASS_READABLE_TICK,
  GLASS_TINTED_ALPHA,
  glassRefraction,
  glassRefractionOn,
  glassSliderAlpha,
  glassTint,
  resolveGlassSlider,
  glassSurfaceAlpha,
  snapGlassSlider,
  stepGlassSlider,
  keepGlassBlurWhileMoving,
  glassChipWash,
  GLASS_CHIP_HUES,
  GLASS_CHIP_WASH_MAX,
  GLASS_LIGHT_FROST,
  GLASS_CLEAR_RATIO,
  glassMinRatio,
  glassFrostFloor,
  glassChromeBackdropRange,
  glassBackdropFilter
} from './glassContrast'

const WHITE = [255, 255, 255] as const
const BLACK = [0, 0, 0] as const

describe('glassTintAlpha', () => {
  it('hand-checked: #d4d4d4 text on a black tint needs about 0.64', () => {
    // Over white, the composite grey is (1-a)·255; contrast with #d4d4d4 (L≈0.658) reaches 4.5 when
    // the grey's luminance drops to ≈0.107, i.e. an sRGB value of ≈0.361 → a ≈ 0.639.
    const a = glassTintAlpha('#d4d4d4', '#000000')
    expect(a).toBeGreaterThan(0.63)
    expect(a).toBeLessThan(0.65)
  })

  it.each(TERMINAL_THEMES.map((t) => [t.id, t] as const))(
    '%s keeps 4.5:1 (or its own opaque contrast, if lower) over a white AND a black backdrop',
    (_id, t) => {
      const fg = parseHex(t.theme.foreground!)!
      const tint = parseHex(t.theme.background!)!
      const a = glassTintAlpha(t.theme.foreground!, t.theme.background!)
      const floor = Math.min(4.5, contrastRatio(fg, tint))
      expect(a).toBeGreaterThanOrEqual(GLASS_ALPHA_MIN)
      expect(a).toBeLessThanOrEqual(1)
      expect(contrastRatio(fg, composite(tint, WHITE, a))).toBeGreaterThanOrEqual(floor)
      expect(contrastRatio(fg, composite(tint, BLACK, a))).toBeGreaterThanOrEqual(floor)
    }
  )

  it('only the Solarized themes exceed the 0.95 design ceiling, and only Solarized Light is opaque', () => {
    const over = TERMINAL_THEMES.filter(
      (t) => glassTintAlpha(t.theme.foreground!, t.theme.background!) > GLASS_ALPHA_MAX
    ).map((t) => t.id)
    expect(over.sort()).toEqual(['solarized-dark', 'solarized-light'])
    const light = TERMINAL_THEMES.find((t) => t.id === 'solarized-light')!
    // 4.13:1 opaque — no translucent tint can reach 4.5, so glass must not make it any worse.
    expect(contrastRatio(parseHex(light.theme.foreground!)!, parseHex(light.theme.background!)!)).toBeLessThan(4.5)
    expect(glassTintAlpha(light.theme.foreground!, light.theme.background!)).toBe(1)
  })

  it.each(TERMINAL_THEMES.map((t) => [t.id, t] as const))(
    '%s: no grey backdrop (0..255 step 15) is worse than the white/black worst case',
    (_id, t) => {
      const fg = parseHex(t.theme.foreground!)!
      const tint = parseHex(t.theme.background!)!
      const a = glassTintAlpha(t.theme.foreground!, t.theme.background!)
      const worst = worstContrast(fg, tint, a)
      for (let g = 0; g <= 255; g += 15) {
        expect(contrastRatio(fg, composite(tint, [g, g, g], a))).toBeGreaterThanOrEqual(worst - 1e-9)
      }
    }
  )

  it('a text colour inside the composite range is caught (some backdrop matches it)', () => {
    // Mid-grey text on a black tint at 0.55: over black the composite is black, over white it is
    // ~#737373, and #404040 sits between them — a grey backdrop exists that erases it.
    const fg = parseHex('#404040')!
    expect(worstContrast(fg, [0, 0, 0], 0.55)).toBe(1)
    let min = Infinity
    for (let g = 0; g <= 255; g++) min = Math.min(min, contrastRatio(fg, composite([0, 0, 0], [g, g, g], 0.55)))
    expect(min).toBeLessThan(1.05)
  })

  it('every alpha above the answer passes too (non-monotonic contrast is handled)', () => {
    const fg = parseHex('#d4d4d4')!
    const tint = parseHex('#000000')!
    const a = glassTintAlpha('#d4d4d4', '#000000')
    for (let x = a; x <= 1; x += 0.01) {
      expect(contrastRatio(fg, composite(tint, WHITE, x))).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('clamps: an easy pair still gets the floor, an impossible pair goes opaque', () => {
    expect(glassTintAlpha('#ffffff', '#000000', 1.5)).toBe(GLASS_ALPHA_MIN)
    expect(glassTintAlpha('#777777', '#808080')).toBe(1)
    expect(glassTintAlpha('nope', '#000000')).toBe(GLASS_ALPHA_MAX)
  })
})

describe('glassChromeAlpha (Liquid Glass chrome, both app themes)', () => {
  // Read the real tokens, so a palette change re-proves the guarantee instead of drifting past it.
  const CSS = readFileSync(join(__dirname, '../styles.css'), 'utf8').replace(/\r\n/g, '\n')
  function block(selector: string): string {
    const start = CSS.indexOf(`${selector} {`)
    return CSS.slice(start, CSS.indexOf('\n}', start))
  }
  function token(body: string, name: string): string | undefined {
    return new RegExp(`\\n\\s*${name}:\\s*([^;]+);`).exec(body)?.[1].trim()
  }
  const dark = block(':root')
  const light = block(":root[data-theme='light']")
  const resolve = (theme: string, name: string): string => {
    const raw = token(theme, name) ?? token(dark, name)!
    const tint = token(theme, '--tint-rgb') ?? token(dark, '--tint-rgb')!
    return raw.replace('var(--tint-rgb)', tint)
  }

  it.each([
    ['dark', dark],
    ['light', light]
  ])('%s: --text on the glass --panel keeps 4.5:1 over a fine grey sweep, below opaque', (_n, theme) => {
    const text = parseCssColor(resolve(theme, '--text'))!
    const panel = parseCssColor(resolve(theme, '--panel'))!.rgb
    const a = glassChromeAlpha(resolve(theme, '--text'), resolve(theme, '--panel'))!
    expect(a).toBeGreaterThanOrEqual(GLASS_ALPHA_MIN)
    expect(a).toBeLessThan(1)
    for (let v = 0; v <= 255; v++) {
      expect(chromeContrast(text, panel, a, [v, v, v])).toBeGreaterThanOrEqual(4.5)
    }
    for (const b of [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0], [0, 255, 255], [255, 0, 255]] as const) {
      expect(chromeContrast(text, panel, a, b)).toBeGreaterThanOrEqual(4.5)
    }
  })

  it.each([
    ['dark', dark],
    ['light', light]
  ])('%s: canvas cards (subagent, files, ...) follow the slider and keep 4.5:1 at every position', (_n, theme) => {
    const textCss = resolve(theme, '--text')
    const panelCss = resolve(theme, '--panel')
    const text = parseCssColor(textCss)!
    const panel = parseCssColor(panelCss)!.rgb
    const readable = glassChromeAlpha(textCss, panelCss)!
    for (let i = 0; i <= 20; i++) {
      const a = glassSurfaceAlpha(i / 20, readable)
      const css = glassBackdropFilter(glassChromeBackdropRange(textCss, panelCss, a, glassMinRatio(i / 20), glassFrostFloor(i / 20))!)
      for (const b of RANGE_BACKDROPS) {
        expect(chromeContrast(text, panel, a, applyBackdropFilter(css, b)), `slider ${i / 20}, ${b}`).toBeGreaterThanOrEqual(glassMinRatio(i / 20) - 0.01)
      }
    }
    expect(glassChromeBackdropRange('nope', panelCss, 0.5)).toBeNull()
  })

  it('parses the colour forms the tokens use', () => {
    expect(parseCssColor('rgba(58, 48, 38, 0.85)')).toEqual({ rgb: [58, 48, 38], alpha: 0.85 })
    expect(parseCssColor('#282828')).toEqual({ rgb: [40, 40, 40], alpha: 1 })
    expect(parseCssColor('rgb(1,2,3)')).toEqual({ rgb: [1, 2, 3], alpha: 1 })
    expect(glassChromeAlpha('nope', '#000')).toBeNull()
  })
})

describe('highlights, placeholders and small controls on the chrome fill (visual QA round 2)', () => {
  const CSS = readFileSync(join(__dirname, '../styles.css'), 'utf8').replace(/\r\n/g, '\n')
  const block = (selector: string): string => {
    const start = CSS.indexOf(`\n${selector} {\n`)
    return CSS.slice(start, CSS.indexOf('\n}', start + 1))
  }
  const token = (body: string, name: string): string | undefined =>
    new RegExp(`\\n\\s*${name}:\\s*([^;]+);`).exec(body)?.[1].trim()
  const dark = block(':root')
  const light = block(":root[data-theme='light']")
  const glass = block(":root[data-nt-glass='on']")
  const glassLight = block(":root[data-nt-glass='on'][data-theme='light']")
  const tint = (t: string): string => token(t, '--tint-rgb') ?? token(dark, '--tint-rgb')!
  const resolve = (t: string, name: string): string =>
    (token(t, name) ?? token(dark, name)!).replace('var(--tint-rgb)', tint(t))
  const ACCENT = '#0a84ff' // settings default (shared/types.ts)
  const themes = [
    ['dark', dark, glass],
    ['light', light, glassLight]
  ] as const

  it('the wash constants are the stylesheet\'s', () => {
    expect(token(glass, '--glass-lift')).toBe(`rgba(var(--tint-rgb), ${GLASS_LIFT_ALPHA})`)
    expect(token(glass, '--glass-select')).toBe(`color-mix(in srgb, var(--accent) ${GLASS_SELECT_MIX * 100}%, transparent)`)
  })

  // Every accent the user can pick, not only the default blue: a bright accent's selection wash
  // needs a denser fill (dark: Yellow 0.825, Teal 0.76). Accepted up to 0.85 — still glass, not a
  // slab (code review 5 #8).
  it.each(themes)('%s: the active tab / hovered / selected rows keep 4.5:1 at the readable alpha, every accent', (_n, t) => {
    const panel = parseCssColor(resolve(t, '--panel'))!.rgb
    const plain = glassChromeAlpha(resolve(t, '--text'), resolve(t, '--panel'))!
    for (const { value: accent, label } of SYSTEM_NODE_COLOR_SWATCHES) {
      const hs = glassChromeHighlights(resolve(t, '--text-strong'), tint(t), accent)
      expect(hs).toHaveLength(2)
      const a = glassChromeAlpha(resolve(t, '--text'), resolve(t, '--panel'), 4.5, hs)!
      expect(a, label).toBeGreaterThanOrEqual(plain)
      expect(a, label).toBeLessThanOrEqual(0.85)
      for (const h of hs) {
        const ink = parseCssColor(h.ink)!
        const wash = parseCssColor(h.wash)!
        for (let v = 0; v <= 255; v += 3) {
          expect(chromeHighlightContrast(ink, wash, panel, a, [v, v, v]), label).toBeGreaterThanOrEqual(4.5)
        }
      }
    }
  })

  it.each(themes)('%s: placeholders keep 4.5:1 on the plain fill', (_n, t, g) => {
    const a = glassChromeAlpha(resolve(t, '--text'), resolve(t, '--panel'), 4.5, glassChromeHighlights(resolve(t, '--text-strong'), tint(t), ACCENT))!
    const ph = parseCssColor((token(g, '--glass-placeholder') ?? token(glass, '--glass-placeholder')!).replace('var(--tint-rgb)', tint(t)))!
    const panel = parseCssColor(resolve(t, '--panel'))!.rgb
    for (let v = 0; v <= 255; v += 3) expect(chromeContrast(ph, panel, a, [v, v, v])).toBeGreaterThanOrEqual(4.5)
    // …and never reads stronger than body text (visual QA round 3, NM1): at most --text's alpha.
    // Light has no room below it at 4.5:1, so typed text takes --text-strong there (styles.css).
    expect(ph.alpha).toBeLessThanOrEqual(parseCssColor(resolve(t, '--text'))!.alpha)
  })

  it.each(themes)('%s: small controls keep 3:1 icons at Clear, never below the 0.35 floor', (_n, t, g) => {
    const dim = Number(token(g, '--glass-control-dim') ?? token(glass, '--glass-control-dim'))
    const a = glassControlClearAlpha(resolve(t, '--text'), resolve(t, '--panel'), dim)
    expect(a).toBeGreaterThanOrEqual(GLASS_CONTROL_CLEAR_ALPHA)
    const text = parseCssColor(resolve(t, '--text'))!
    const panel = parseCssColor(resolve(t, '--panel'))!.rgb
    for (let v = 0; v <= 255; v += 3) {
      const b = Math.min(255, v * dim)
      expect(chromeContrast(text, panel, a, [b, b, b])).toBeGreaterThanOrEqual(3)
    }
    expect(glassChromeAlphas(0, 0.74, undefined, a).control).toBeCloseTo(Math.min(a, 0.74), 10)
  })
})

describe('Glass slider (Clear ↔ Tinted)', () => {
  const css = readFileSync(join(__dirname, '..', 'styles.css'), 'utf8').replace(/\r\n/g, '\n')
  const body = (sel: string): string => {
    const i = css.indexOf(`\n${sel} {\n`)
    return css.slice(i, css.indexOf('\n}\n', i))
  }
  const tok = (b: string, n: string) => new RegExp(`\\n\\s*${n}:\\s*([^;]+);`).exec(b)?.[1].trim()
  const dark = body(':root')
  const light = body(":root[data-theme='light']")
  const chrome = (b: string): number => {
    const tint = tok(b, '--tint-rgb') ?? tok(dark, '--tint-rgb')!
    const text = (tok(b, '--text') ?? tok(dark, '--text')!).replace('var(--tint-rgb)', tint)
    return glassChromeAlpha(text, tok(b, '--panel')!)!
  }
  const surfaces: Array<[string, number]> = [
    ['chrome dark', chrome(dark)],
    ['chrome light', chrome(light)],
    ...TERMINAL_THEMES.map((t) => [t.id, glassTintAlpha(t.theme.foreground!, t.theme.background!)] as [string, number])
  ]

  it.each(surfaces)('%s: the Readable tick is exactly the computed 4.5:1 alpha', (_id, readable) => {
    expect(glassSliderAlpha(GLASS_READABLE_TICK, readable)).toBeCloseTo(readable, 10)
  })

  it.each(surfaces)('%s: alpha rises monotonically from Clear to Tinted', (_id, readable) => {
    let prev = -1
    for (let i = 0; i <= 100; i++) {
      const a = glassSliderAlpha(i / 100, readable)
      expect(a).toBeGreaterThanOrEqual(prev - 1e-9)
      prev = a
    }
    expect(glassSliderAlpha(0, readable)).toBe(GLASS_CLEAR_ALPHA)
    expect(glassSliderAlpha(1, readable)).toBe(Math.max(readable, GLASS_TINTED_ALPHA))
  })

  it('an untouched or hand-mangled setting is the Readable tick; numbers clamp', () => {
    for (const v of [null, undefined, 'x', Number.NaN, Infinity]) expect(resolveGlassSlider(v)).toBe(GLASS_READABLE_TICK)
    expect(resolveGlassSlider(-3)).toBe(0)
    expect(resolveGlassSlider(7)).toBe(1)
  })

  it('refraction is strongest at Clear and fades to nothing at Tinted', () => {
    expect(glassRefraction(0)).toBe(0.025)
    expect(glassRefraction(0)).toBeGreaterThan(glassRefraction(GLASS_READABLE_TICK))
    expect(glassRefraction(1)).toBe(0)
  })

  // The filter was invisible from the Readable tick to Tinted (a 3px bend under a ~20px blur, 0 at
  // Tinted) and cost as much GPU as every terminal blur together, so it runs only left of the tick.
  it('refraction runs only left of the Readable tick', () => {
    expect(glassRefractionOn(0)).toBe(true)
    expect(glassRefractionOn(GLASS_READABLE_TICK - 0.01)).toBe(true)
    expect(glassRefractionOn(GLASS_READABLE_TICK)).toBe(false)
    expect(glassRefractionOn(1)).toBe(false)
  })

  it('a terminal tint follows the slider', () => {
    const t = TERMINAL_THEMES.find((x) => x.id === 'nodeterm-dark') ?? TERMINAL_THEMES[0]
    const at = (s: number) => Number(/, ([\d.]+)\)$/.exec(glassTint(t.theme, s)!.background)![1])
    expect(at(0)).toBeLessThan(at(GLASS_READABLE_TICK))
    expect(at(GLASS_READABLE_TICK)).toBeCloseTo(glassTintAlpha(t.theme.foreground!, t.theme.background!), 3)
    expect(at(1)).toBeGreaterThanOrEqual(at(GLASS_READABLE_TICK))
  })
})

describe('slider scope: text surfaces floor at Readable, controls at 0.35 (Phase 4)', () => {
  it.each([0.7, 0.745])('readable %s', (readable) => {
    for (let i = 0; i <= 100; i++) {
      const t = i / 100
      const { text, control } = glassChromeAlphas(t, readable)
      expect(text).toBeGreaterThanOrEqual(readable - 1e-9)
      expect(control).toBeGreaterThanOrEqual(GLASS_CONTROL_CLEAR_ALPHA - 1e-9)
      // Right of the tick both follow the slider exactly.
      if (t >= GLASS_READABLE_TICK) expect(text).toBeCloseTo(control, 10)
    }
    expect(glassChromeAlphas(0, readable).text).toBeCloseTo(readable, 10)
    expect(glassChromeAlphas(0, readable).control).toBe(GLASS_CONTROL_CLEAR_ALPHA)
    expect(glassChromeAlphas(0, readable, { reduceTransparency: true, moreContrast: false })).toEqual({ text: 1, control: 1 })
  })
})

describe('accessibility outranks the Glass slider', () => {
  it('Reduce Transparency is opaque; Increase Contrast pins to Tinted', () => {
    expect(glassSurfaceAlpha(0, 0.7, { reduceTransparency: true, moreContrast: false })).toBe(1)
    expect(glassSurfaceAlpha(0, 0.7, { reduceTransparency: false, moreContrast: true })).toBe(glassSliderAlpha(1, 0.7))
    expect(glassSurfaceAlpha(0.3, 0.7)).toBe(glassSliderAlpha(0.3, 0.7))
  })
})

describe('Glass slider detent (macOS tick-mark feel)', () => {
  it('a drag within ±0.03 of the tick lands on it', () => {
    expect(snapGlassSlider(GLASS_READABLE_TICK + 0.03)).toBe(GLASS_READABLE_TICK)
    expect(snapGlassSlider(GLASS_READABLE_TICK - 0.02)).toBe(GLASS_READABLE_TICK)
    expect(snapGlassSlider(0.5)).toBe(0.5)
  })

  it('arrow keys step 0.05 and stop on the tick when they cross it', () => {
    expect(stepGlassSlider(0.5, 1)).toBeCloseTo(0.55, 10)
    expect(stepGlassSlider(0.68, 1)).toBe(GLASS_READABLE_TICK)
    expect(stepGlassSlider(0.72, -1)).toBe(GLASS_READABLE_TICK)
    expect(stepGlassSlider(GLASS_READABLE_TICK, 1)).toBeCloseTo(0.75, 10)
    expect(stepGlassSlider(1, 1)).toBe(1)
    expect(stepGlassSlider(0, -1)).toBe(0)
  })
})

describe('Keep blur while moving', () => {
  it('defaults on; only a literal false pauses the blur', () => {
    for (const v of [true, undefined, null, 'x']) expect(keepGlassBlurWhileMoving(v)).toBe(true)
    expect(keepGlassBlurWhileMoving(false)).toBe(false)
  })

  it('the camera-move handler skips the pause class when it is on', () => {
    const src = readFileSync(join(__dirname, '..', 'canvas', 'Canvas.tsx'), 'utf8').replace(/\r\n/g, '\n')
    const start = src.slice(src.indexOf('const onCanvasMoveStart'))
    const body = start.slice(0, start.indexOf("classList.add('canvas-moving')"))
    expect(body).toContain('if (keepBlurWhileMovingRef.current) return')
  })
})

it('App applies data-theme and the glass attribute + fill before paint (no transparent first frame)', () => {
  const src = readFileSync(join(__dirname, '..', 'App.tsx'), 'utf8').replace(/\r\n/g, '\n')
  for (const marker of ['document.documentElement.dataset.theme = appTheme', "root.dataset.ntGlass = 'on'", "root.style.setProperty('--glass-chrome-bg'", "root.style.setProperty('--glass-control-bg'"]) {
    const at = src.indexOf(marker)
    expect(at, marker).toBeGreaterThan(0)
    const before = src.slice(0, at)
    expect(before.lastIndexOf('useLayoutEffect('), marker).toBeGreaterThan(before.lastIndexOf('useEffect('))
  }
})

describe('glass status chip keeps its label readable', () => {
  const rows = TERMINAL_THEMES.map((t) => {
    const readable = glassTintAlpha(t.theme.foreground!, t.theme.background!)
    return [t.id, t, readable, glassChipWash(t.theme.foreground!, t.theme.background!, readable)] as const
  })

  it.each(rows)('%s: the chip wash keeps the foreground at 4.5:1 for every badge hue', (_id, t, readable, wash) => {
    const fg = parseHex(t.theme.foreground!)!
    const bg = parseHex(t.theme.background!)!
    expect(wash).toBeLessThanOrEqual(GLASS_CHIP_WASH_MAX)
    if (readable >= 1) return // Solarized Light: under 4.5 even opaque; the tint is its whole answer
    for (let v = 0; v <= 255; v += 3) {
      const head = composite(bg, composite(bg, [v, v, v], readable), 0.35)
      for (const h of GLASS_CHIP_HUES) {
        expect(contrastRatio(fg, composite(parseHex(h)!, head, wash))).toBeGreaterThanOrEqual(4.5)
      }
    }
  })

  // glassTint sizes the wash at the tick for every slider position; that is only safe because the
  // wash can only grow with the alpha (the scan is contiguous, so the tick's wash passes above it).
  it.each(rows)('%s: the wash never shrinks right of the Readable tick', (_id, t, readable, wash) => {
    for (const a of [readable, (readable + 1) / 2, 0.95, 1].filter((x) => x >= readable)) {
      expect(glassChipWash(t.theme.foreground!, t.theme.background!, a)).toBeGreaterThanOrEqual(wash)
    }
    expect(glassTint(t.theme, 1)!.chipWash).toBe(glassTint(t.theme)!.chipWash)
  })

  it('the stylesheet uses the computed wash, never a fixed one', () => {
    const css = readFileSync(join(__dirname, '..', 'styles.css'), 'utf8')
    const rule = css.slice(css.indexOf(":root[data-nt-glass='on'] .term-node__status {"))
    const body = rule.slice(0, rule.indexOf('}'))
    expect(body).toContain('color-mix(in srgb, currentColor var(--term-glass-chip-wash, 0%), transparent)')
  })
})

/** What Chromium does to one backdrop pixel for `glassBackdropFilter`'s CSS (contrast then
 *  brightness, per channel in gamma sRGB, clamped). Measured live: a black backdrop under
 *  `contrast(0.328) brightness(1.506)` at a 0.2 nodeterm-light tint rendered 154, predicted 153. */
function applyBackdropFilter(css: string | null, [r, g, b]: readonly number[]): [number, number, number] {
  if (!css) return [r, g, b]
  const c = Number(/contrast\(([\d.]+)\)/.exec(css)?.[1] ?? 1)
  const k = Number(/brightness\(([\d.]+)\)/.exec(css)?.[1] ?? 1)
  const f = (v: number): number => Math.min(255, Math.max(0, ((v / 255 - 0.5) * c + 0.5) * k * 255))
  return [f(r), f(g), f(b)]
}

const RANGE_BACKDROPS: number[][] = []
for (let r = 0; r <= 255; r += 51)
  for (let g = 0; g <= 255; g += 51) for (let b = 0; b <= 255; b += 51) RANGE_BACKDROPS.push([r, g, b])
for (let v = 0; v <= 255; v++) RANGE_BACKDROPS.push([v, v, v])

describe('glassBackdropFilter: readable at EVERY slider position, Clear included', () => {
  const positions = Array.from({ length: 21 }, (_, i) => i / 20)
  it('the promise slides from 3:1 at Clear to 4.5:1 at the Readable tick', () => {
    expect(glassMinRatio(0)).toBe(GLASS_CLEAR_RATIO)
    expect(glassMinRatio(GLASS_READABLE_TICK)).toBe(4.5)
    expect(glassMinRatio(1)).toBe(4.5)
    expect(glassFrostFloor(0)).toBe(0)
    expect(glassFrostFloor(GLASS_READABLE_TICK)).toBe(GLASS_LIGHT_FROST)
  })

  it.each(TERMINAL_THEMES.map((t) => [t.id, t] as const))('%s', (_id, t) => {
    const fg = parseHex(t.theme.foreground!)!
    const tint = parseHex(t.theme.background!)!
    for (const pos of positions) {
      const floor = Math.min(glassMinRatio(pos), contrastRatio(fg, tint))
      const g = glassTint(t.theme, pos)!
      for (const b of RANGE_BACKDROPS) {
        const ratio = contrastRatio(fg, composite(tint, applyBackdropFilter(g.backdrop, b), g.alpha))
        expect(ratio, `slider ${pos}, backdrop ${b}`).toBeGreaterThanOrEqual(floor - 0.01)
      }
    }
  })

  it('dark themes leave the backdrop alone from the Readable tick to Tinted', () => {
    for (const t of TERMINAL_THEMES.filter((x) => x.dark)) {
      for (const pos of [GLASS_READABLE_TICK, 0.85, 1]) expect(glassTint(t.theme, pos)!.backdrop).toBeNull()
    }
  })

  it('light themes frost from the Readable tick: a black backdrop lifts to at least GLASS_LIGHT_FROST', () => {
    for (const t of TERMINAL_THEMES.filter((x) => !x.dark)) {
      for (const pos of [GLASS_READABLE_TICK, 0.85, 1]) {
        const [v] = applyBackdropFilter(glassTint(t.theme, pos)!.backdrop, [0, 0, 0])
        expect(v / 255).toBeGreaterThanOrEqual(GLASS_LIGHT_FROST)
      }
    }
  })

  it('a dark theme at Clear dims, never lifts, the backdrop', () => {
    const t = TERMINAL_THEMES.find((x) => x.id === 'nodeterm-dark')!
    const css = glassTint(t.theme, 0)!.backdrop
    expect(css).toMatch(/^brightness\(0\.\d+\)$/)
    expect(applyBackdropFilter(css, [0, 0, 0])).toEqual([0, 0, 0])
  })

  it('the chrome frost in styles.css is GLASS_LIGHT_FROST', () => {
    const css = readFileSync(join(__dirname, '../styles.css'), 'utf8')
    const m = /--glass-frost:\s*(contrast\([\d.]+\) brightness\([\d.]+\))/.exec(css)
    expect(m?.[1]).toBe(glassBackdropFilter({ lo: GLASS_LIGHT_FROST, hi: 1 }))
  })
})
