import { describe, it, expect } from 'vitest'
import {
  MONO_FONT_CATALOG,
  buildFontStack,
  buildProseFontStack,
  detectInstalled,
  isFontAvailable,
  isGenericFamily,
  primaryFamily,
  quoteFamily,
  type MeasureText
} from './fontDetect'

/**
 * A measurer standing in for the canvas: every generic base has its own width, and each font in
 * `installed` shifts it — which is exactly the signal `isFontAvailable` reads. A font NOT in the
 * set leaves the width at the base's, i.e. it fell through to the fallback.
 */
function fakeMeasure(installed: readonly string[]): MeasureText {
  const baseWidth: Record<string, number> = { monospace: 100, serif: 110, 'sans-serif': 120 }
  return (font: string) => {
    const m = /^\d+px (.*)$/.exec(font)
    if (!m) return 0
    const families = m[1].split(',').map((f) => f.trim().replace(/^["']|["']$/g, ''))
    const base = families[families.length - 1]
    const named = families.slice(0, -1)
    const hit = named.find((f) => installed.includes(f))
    return hit ? baseWidth[base] + hit.length : (baseWidth[base] ?? 0)
  }
}

describe('primaryFamily', () => {
  it('takes the first family of a stack', () => {
    expect(primaryFamily('Menlo, Monaco, "Courier New", monospace')).toBe('Menlo')
  })

  it('strips quotes', () => {
    expect(primaryFamily('"JetBrains Mono", monospace')).toBe('JetBrains Mono')
    expect(primaryFamily("'Fira Code', monospace")).toBe('Fira Code')
  })

  it('handles a single family and stray whitespace', () => {
    expect(primaryFamily('  Hack  ')).toBe('Hack')
    expect(primaryFamily('monospace')).toBe('monospace')
  })

  it('returns empty for empty input', () => {
    expect(primaryFamily('')).toBe('')
    expect(primaryFamily('   ')).toBe('')
  })
})

describe('isGenericFamily', () => {
  it('knows the CSS generics, case-insensitively', () => {
    expect(isGenericFamily('monospace')).toBe(true)
    expect(isGenericFamily('UI-Monospace')).toBe(true)
    expect(isGenericFamily('system-ui')).toBe(true)
  })

  it('is false for real family names', () => {
    expect(isGenericFamily('Menlo')).toBe(false)
    expect(isGenericFamily('JetBrains Mono')).toBe(false)
  })
})

describe('quoteFamily / buildFontStack', () => {
  it('quotes only what needs quoting', () => {
    expect(quoteFamily('Menlo')).toBe('Menlo')
    expect(quoteFamily('Fira-Code')).toBe('Fira-Code')
    expect(quoteFamily('JetBrains Mono')).toBe('"JetBrains Mono"')
    expect(quoteFamily('0xProto')).toBe('"0xProto"') // leading digit isn't a valid bare ident
  })

  // The setting travels between machines (and to the Server Edition's browser); a bare single
  // family would render as something arbitrary wherever it isn't installed.
  it('always keeps fallbacks after the chosen family', () => {
    expect(buildFontStack('JetBrains Mono')).toBe(
      '"JetBrains Mono", Menlo, Monaco, "Courier New", monospace'
    )
  })

  it('collapses an empty or generic choice to plain monospace', () => {
    expect(buildFontStack('')).toBe('monospace')
    expect(buildFontStack('  ')).toBe('monospace')
    expect(buildFontStack('monospace')).toBe('monospace')
  })
})

describe('isFontAvailable', () => {
  const measure = fakeMeasure(['Menlo', 'JetBrains Mono'])

  it('detects an installed font by its metrics differing from a generic base', () => {
    expect(isFontAvailable('Menlo', measure)).toBe(true)
    expect(isFontAvailable('JetBrains Mono', measure)).toBe(true)
  })

  it('reports a missing font — it measures exactly like the fallback', () => {
    expect(isFontAvailable('Fira Code', measure)).toBe(false)
    expect(isFontAvailable('Nonexistent Font', measure)).toBe(false)
  })

  it('accepts a quoted name', () => {
    expect(isFontAvailable('"JetBrains Mono"', measure)).toBe(true)
  })

  it('treats the generics as always available (they ARE the fallback)', () => {
    expect(isFontAvailable('monospace', measure)).toBe(true)
    expect(isFontAvailable('system-ui', measure)).toBe(true)
  })

  it('is false for an empty name', () => {
    expect(isFontAvailable('', measure)).toBe(false)
  })

  // A broken measurer must not turn into "your font is missing" on every row — an unknown answer
  // is not evidence of absence.
  it('reports not-available rather than guessing when the measurer returns nothing', () => {
    expect(isFontAvailable('Menlo', () => 0)).toBe(false)
  })
})

describe('detectInstalled', () => {
  it('filters the catalogue to what is installed, preserving order', () => {
    const measure = fakeMeasure(['Menlo', 'Hack', 'Consolas'])
    expect(detectInstalled(['Hack', 'Fira Code', 'Menlo', 'Consolas'], measure)).toEqual([
      'Hack',
      'Menlo',
      'Consolas'
    ])
  })

  it('returns nothing when none are installed', () => {
    expect(detectInstalled(['A', 'B'], fakeMeasure([]))).toEqual([])
  })
})

describe('MONO_FONT_CATALOG', () => {
  it('has no duplicates and is sorted, so the picker reads predictably', () => {
    expect(new Set(MONO_FONT_CATALOG).size).toBe(MONO_FONT_CATALOG.length)
    expect([...MONO_FONT_CATALOG]).toEqual([...MONO_FONT_CATALOG].sort())
  })
})

describe('buildProseFontStack', () => {
  it('keeps proportional fallbacks ending in sans-serif', () => {
    expect(buildProseFontStack('Iowan Old Style')).toBe('"Iowan Old Style", -apple-system, BlinkMacSystemFont, sans-serif')
  })

  it('keeps a generic family as a complete stack', () => {
    expect(buildProseFontStack('serif')).toBe('serif')
  })

  it('answers sans-serif for nothing', () => {
    expect(buildProseFontStack('  ')).toBe('sans-serif')
  })
})
