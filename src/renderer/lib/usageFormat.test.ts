import { describe, expect, it } from 'vitest'
import { barFillPercent, formatModelLabel, percentNumber, severityColor } from './usageFormat'

describe('formatModelLabel', () => {
  it('formats family + version ids', () => {
    expect(formatModelLabel('claude-opus-4-8')).toBe('Opus 4.8')
    expect(formatModelLabel('claude-sonnet-5')).toBe('Sonnet 5')
    expect(formatModelLabel('claude-fable-5')).toBe('Fable 5')
  })

  it('drops date suffixes', () => {
    expect(formatModelLabel('claude-haiku-4-5-20251001')).toBe('Haiku 4.5')
    expect(formatModelLabel('claude-opus-4-1-20250805')).toBe('Opus 4.1')
  })

  it('handles legacy version-first ids', () => {
    expect(formatModelLabel('claude-3-5-sonnet-20241022')).toBe('Sonnet 3.5')
  })

  it('ignores non-numeric segments like a [1m] marker', () => {
    expect(formatModelLabel('claude-sonnet-4-5[1m]')).toBe('Sonnet 4.5')
  })

  it('returns a family with no version bare', () => {
    expect(formatModelLabel('sonnet')).toBe('Sonnet')
  })

  it('passes through unknown ids and keeps null', () => {
    expect(formatModelLabel('some-custom-model')).toBe('some-custom-model')
    expect(formatModelLabel(null)).toBeNull()
  })
})

describe('barFillPercent', () => {
  it('fills with what is used in "used" mode', () => {
    expect(barFillPercent(92, 'used')).toBe(92)
    expect(barFillPercent(8, 'used')).toBe(8)
  })

  it('fills with what is left in "remaining" mode', () => {
    expect(barFillPercent(92, 'remaining')).toBe(8)
    expect(barFillPercent(8, 'remaining')).toBe(92)
  })

  // The bar and the number beside it must describe the SAME quantity — a fill that disagreed
  // with its own label ("92% used" over a near-empty bar) is the bug this helper exists to fix.
  it('always agrees with the number rendered next to it', () => {
    for (const used of [0, 8, 50, 92, 100]) {
      for (const mode of ['used', 'remaining'] as const) {
        expect(Math.round(barFillPercent(used, mode))).toBe(percentNumber(used, mode))
      }
    }
  })

  // Color is keyed to the TRUE remaining percentage, never to the fill, so severity keeps its
  // meaning when the mode flips: 92% used is red in both modes even though the fill inverts.
  it('does not carry the color — severity stays keyed to remaining quota', () => {
    const left = 100 - 92
    expect(severityColor(null, left)).toBe('#ff453a')
    expect(barFillPercent(92, 'used')).not.toBe(barFillPercent(92, 'remaining'))
  })
})
