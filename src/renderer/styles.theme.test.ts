import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Guards on the stylesheet's theming, written after the light theme shipped with a black canvas
 * and a dark sessions sidebar.
 *
 * The bug was not any one rule — it was the AUDIT. The literals were found by listing the most
 * frequent colours, which silently skips the ones used once: `.react-flow { background: #000000 }`
 * is the entire canvas and appeared exactly once. A test doesn't get bored at entry 26.
 */

const CSS = readFileSync(join(__dirname, 'styles.css'), 'utf8')

/**
 * Where the light block actually starts. This MUST be anchored to the selector at the start of a
 * line: a plain `indexOf(":root[data-theme='light']")` matches the *doc comment* inside the `:root`
 * block that points at it (styles.css line ~6), which is 90 lines too early. That is not a
 * cosmetic slip — it silently hollowed out two suites below. `dark` collapsed to three lines, so
 * "the light theme overrides every themeable token" passed with an EMPTY token list for every
 * token added since; and `LIGHT` resolved to the tail of the DARK block, so the contrast floors
 * were measuring the dark palette against itself. Keep the `^` anchor.
 */
const LIGHT_BLOCK_START = CSS.search(/^:root\[data-theme='light'\]\s*\{/m)

/** Everything before the end of the `:root[data-theme='light']` block — where literals belong. */
const TOKEN_BLOCK_END = CSS.indexOf('\n}\n', LIGHT_BLOCK_START) + 3
const RULES = CSS.slice(TOKEN_BLOCK_END)

/** The two token blocks, sliced once. */
const DARK = CSS.slice(CSS.indexOf(':root {'), LIGHT_BLOCK_START)
const LIGHT = CSS.slice(LIGHT_BLOCK_START, TOKEN_BLOCK_END)

function luminance(r: number, g: number, b: number): number {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
}

function parseColor(lit: string): { lum: number; alpha: number } | null {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(lit.trim())
  if (hex) {
    const h = hex[1].length === 3 ? [...hex[1]].map((c) => c + c).join('') : hex[1]
    return {
      lum: luminance(parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)),
      alpha: 1
    }
  }
  const rgb = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(lit.trim())
  if (rgb) {
    return {
      lum: luminance(+rgb[1], +rgb[2], +rgb[3]),
      alpha: rgb[4] === undefined ? 1 : +rgb[4]
    }
  }
  return null
}

/**
 * Scrims: a translucent wash whose JOB is to darken whatever is under it. Black is correct in
 * both themes, so these are the one legitimate place for a literal dark background. Listed
 * explicitly, so adding one is a decision rather than an oversight.
 */
const SCRIM_ALPHA_MAX = 0.8

describe('every opaque surface is themed', () => {
  // `background: <literal>` outside the token block. An opaque near-black or near-white here is a
  // surface that will not follow the theme — exactly the canvas/dock/sidebar failure.
  const offenders: string[] = []
  let selector = ''
  const lines = RULES.split('\n')
  lines.forEach((line, i) => {
    if (line.includes('{')) selector = line.split('{')[0].trim() || selector
    const decl = /^\s*background(?:-color)?:\s*([^;]+);/.exec(line)
    if (!decl) return
    // Drop `var(--x, <fallback>)` wholesale before looking for literals: a fallback is only
    // reached when the variable is undefined, and the previous test already proves none are.
    // An explicit `theme-exempt:` comment on the line above opts a rule out — the QR quiet zone
    // is content, not chrome, and has to stay light in both themes. A marker makes that a stated
    // decision instead of an oversight, which is the whole point of this test.
    if (lines[i - 1]?.includes('theme-exempt:') || lines[i - 2]?.includes('theme-exempt:')) return
    const value = decl[1].replace(/var\([^)]*\)/g, '')
    for (const lit of value.match(/#[0-9a-fA-F]{3,8}|rgba?\([^)]*\)/g) ?? []) {
      const c = parseColor(lit)
      if (!c) continue
      const extreme = c.lum < 0.25 || c.lum > 0.85
      if (extreme && c.alpha > SCRIM_ALPHA_MAX) {
        offenders.push(`${selector || '?'} (line ~${i + 1}): ${lit}`)
      }
    }
  })

  it('has no un-themed near-black or near-white background', () => {
    expect(offenders).toEqual([])
  })
})

describe('every CSS variable resolves', () => {
  // `var(--label, #fff)` looked themed and was not: `--label` never existed, so every one of those
  // sites was a hardcoded white. A referenced-but-undefined variable is either that trap or a
  // typo — unless the renderer sets it at runtime.
  const SET_FROM_JS = new Set([
    '--term-bg', // App.tsx, from the terminal theme
    '--peer-color', // presence chips, per peer
    '--group-label-boost', // GroupNode, zoom-compensated label size
    '--xproj-stroke', // XProjectNode, the origin project's colour on a cross-project projection
    '--mascot-w',
    '--mascot-h',
    '--cmascot-w',
    '--cmascot-h',
    '--cmascot-sheet-w',
    '--cmascot-sheet-h' // notch HUD sprite sheets
  ])

  it('references no variable that is never defined', () => {
    const defined = new Set(Array.from(CSS.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gm), (x) => x[1]))
    const used = new Set(Array.from(CSS.matchAll(/var\(\s*(--[a-z0-9-]+)/g), (x) => x[1]))
    const dangling = [...used].filter((v) => !defined.has(v) && !SET_FROM_JS.has(v)).sort()
    expect(dangling).toEqual([])
  })
})

describe('the light theme overrides every themeable token', () => {
  // A token defined in `:root` but absent from the light block keeps its DARK value on a light
  // page. Colour-valued tokens must appear in both; geometry (radii, fonts) is theme-independent.
  it('covers every colour token', () => {
    const dark = DARK
    const light = LIGHT
    const colourish = (decl: string): boolean =>
      /#[0-9a-f]{3,8}|rgba?\(|^\s*\d+,\s*\d+,\s*\d+\s*$/i.test(decl)

    const darkTokens = Array.from(dark.matchAll(/^\s*(--[a-z0-9-]+)\s*:\s*([^;]+);/gm))
      .filter(([, , v]) => colourish(v))
      .map(([, k, v]) => [k, v] as const)
    const lightTokens = new Set(
      Array.from(light.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gm), (x) => x[1])
    )

    // The git-graph lane hues are branch IDENTITY, not chrome: they must stay the same colour in
    // both themes or a graph would change meaning when the theme flips.
    const themeIndependent = (k: string): boolean => k.startsWith('--git-graph-')
    // A token mixed ONLY from `--tint-rgb` already flips with the theme by construction — that
    // triple is itself overridden in the light block, which is the whole point of routing ~280
    // overlays through it. `--text: rgba(var(--tint-rgb), 0.85)` is the live example: it is
    // deliberately NOT restated in the light block (only `--muted`/`--border`, whose alphas had to
    // be raised to buy back the contrast warmth costs). Requiring a redundant restatement here
    // would teach the next person to copy tokens that are already correct.
    const followsTint = (v: string): boolean =>
      /^\s*rgba?\(\s*var\(--tint-rgb\)[^)]*\)\s*$/.test(v)
    const missing = darkTokens
      .filter(([k]) => !lightTokens.has(k) && !themeIndependent(k))
      .filter(([, v]) => !followsTint(v))
      .map(([k]) => k)
    expect(missing).toEqual([])
  })
})

/**
 * Contrast floors for the LIGHT palette.
 *
 * The light theme was re-tuned warm because pure white surfaces with pure black ink read as glare.
 * Warmth costs contrast — brown on cream is a shorter range than black on white — so the numbers
 * that made the re-tune safe are asserted here rather than claimed in a comment. Nudging a surface
 * a few points paler, or an ink alpha down, is exactly the kind of change that looks harmless and
 * quietly drops body text under the floor.
 */
describe('light palette contrast', () => {
  /**
   * A light-palette token — falling back to the dark block when light does not restate it.
   * That fall-back is not laxity: the only tokens light omits are the ones mixed purely from
   * `--tint-rgb` (`--text` is the live example), which read as the LIGHT ink here because
   * `--tint-rgb` itself is overridden. And a hue that genuinely went missing would resolve to its
   * dark-field value and fail the contrast floor below — loudly, which is the point.
   */
  function token(name: string): string {
    const re = new RegExp(`^\\s*${name}\\s*:\\s*([^;]+);`, 'm')
    const m = re.exec(LIGHT) ?? re.exec(DARK)
    if (!m) throw new Error(`neither token block defines ${name}`)
    return m[1].trim()
  }

  const INK = token('--tint-rgb').split(',').map((n) => +n.trim()) as [number, number, number]

  function hex(h: string): [number, number, number] {
    const s = h.replace('#', '')
    return [0, 2, 4].map((i) => parseInt(s.slice(i, i + 2), 16)) as [number, number, number]
  }
  /** The ink at alpha `a`, composited over an opaque surface. */
  function inkOver(a: number, bg: [number, number, number]): [number, number, number] {
    return bg.map((c, i) => INK[i] * a + c * (1 - a)) as [number, number, number]
  }
  function luminance([r, g, b]: [number, number, number]): number {
    const f = (c: number): number => {
      const v = c / 255
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
    }
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
  }
  function contrast(a: [number, number, number], b: [number, number, number]): number {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
    return (hi + 0.05) / (lo + 0.05)
  }
  /** The alpha out of `rgba(var(--tint-rgb), α)`. */
  function inkAlpha(name: string): number {
    const m = /rgba\(var\(--tint-rgb\),\s*([\d.]+)\)/.exec(token(name))
    if (!m) throw new Error(`${name} is not mixed from --tint-rgb`)
    return +m[1]
  }

  // The two surfaces body text actually sits on. `--surface-deep` is the deepest chrome (dock,
  // modal shells) and carries labels rather than prose, so it is held to the 3:1 large-text floor.
  const SURFACES: [string, [number, number, number]][] = [
    ['--bg', hex(token('--bg'))],
    ['--panel', hex(token('--panel'))],
    ['--canvas-bg', hex(token('--canvas-bg'))]
  ]

  it.each(SURFACES)('body text clears WCAG AA on %s', (_name, bg) => {
    expect(contrast(inkOver(inkAlpha('--text'), bg), bg)).toBeGreaterThanOrEqual(4.5)
  })

  it.each(SURFACES)('secondary text clears WCAG AA on %s', (_name, bg) => {
    // This is the one the warm re-tune nearly broke: the dark theme's 0.55 measured 3.2:1 here.
    expect(contrast(inkOver(inkAlpha('--muted'), bg), bg)).toBeGreaterThanOrEqual(4.5)
  })

  it.each(SURFACES)('the status hues and link accent stay legible on %s', (_name, bg) => {
    // `--agent-working` is on this list because the sidebar's project badge paints its COUNT with
    // it (`.ss-group__sig--working`) — it is text, so it owes the text floor, not the 3:1 one.
    const HUES = ['--accent-text', '--danger', '--warn', '--caution', '--success', '--agent-working']
    for (const t of HUES) {
      expect(contrast(hex(token(t)), bg), `${t}`).toBeGreaterThanOrEqual(4.3)
    }
  })

  it('no light surface is pure white — that brightness is the glare being avoided', () => {
    for (const t of ['--bg', '--panel', '--surface-raised', '--surface-overlay', '--canvas-bg']) {
      expect(luminance(hex(token(t))), t).toBeLessThan(0.97)
    }
  })

  it('the canvas sits below the panels, so nodes keep their edges', () => {
    expect(luminance(hex(token('--canvas-bg')))).toBeLessThan(luminance(hex(token('--bg'))))
  })
})
