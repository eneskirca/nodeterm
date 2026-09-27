import { describe, expect, it } from 'vitest'
import {
  barFillPercent,
  claudeEmptyText,
  claudeStaleNotice,
  contextFillColor,
  formatModelLabel,
  percentNumber,
  severityColor
} from './usageFormat'
import type { ClaudeUsage } from '@shared/types'

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

// One definition for every context surface — ContextMeter, the session-row chip and the notch
// HUD each carried their own copy of these thresholds before issue #78.
describe('contextFillColor', () => {
  it('is keyed to USED context: green low, yellow from 60, red past 85', () => {
    expect(contextFillColor(0)).toBe('#30d158')
    expect(contextFillColor(59)).toBe('#30d158')
    expect(contextFillColor(60)).toBe('#ffd60a')
    expect(contextFillColor(85)).toBe('#ffd60a')
    expect(contextFillColor(86)).toBe('#ff453a')
  })

  it('is the inverse scale of the quota colors — the two must not be conflated', () => {
    // 90% USED context is red; 90% REMAINING quota is green. Same number, opposite meaning.
    expect(contextFillColor(90)).toBe('#ff453a')
    expect(severityColor(null, 90)).toBe('#30d158')
  })
})

describe('Claude stale / rate-limit wording', () => {
  const NOW = 1_000_000_000
  const limit = { kind: 'session', group: 'session', usedPercent: 10, severity: null, resetsAt: null,
    windowMinutes: null, scopeLabel: null, isActive: false }
  const usage = (over: Partial<ClaudeUsage>): ClaudeUsage => ({
    limits: [], session: null, weekly: null, email: null, updatedAt: NOW, status: 'ok', ...over
  })

  it('says nothing for a current snapshot', () => {
    expect(claudeStaleNotice(null, NOW)).toBeNull()
    expect(claudeStaleNotice(usage({ limits: [limit] }), NOW)).toBeNull()
    // An error with nothing kept is the empty-state line's job, not this one's.
    expect(claudeStaleNotice(usage({ status: 'error', failure: { reason: 'error', at: NOW } }), NOW)).toBeNull()
  })

  it('names a rate limit, the age of the kept numbers and when it will ask again', () => {
    const u = usage({ status: 'error', limits: [limit], updatedAt: NOW - 14 * 60_000,
      failure: { reason: 'rate-limited', at: NOW - 10_000, retryAt: NOW + 118_000 } })
    expect(claudeStaleNotice(u, NOW)).toBe('Rate limited — showing values from 14m ago, next try in 2m')
    expect(claudeStaleNotice({ ...u, failure: { reason: 'rate-limited', at: NOW - 10_000, retryAt: NOW - 1 } }, NOW))
      .toBe('Rate limited — showing values from 14m ago')
  })

  it('names a plain failure as a failed refresh', () => {
    const u = usage({ status: 'error', limits: [limit], updatedAt: NOW - 30_000,
      failure: { reason: 'error', at: NOW } })
    expect(claudeStaleNotice(u, NOW)).toBe('Could not refresh — showing values from just now')
  })

  it('empty-state text: rate limit named, everything else as before', () => {
    expect(claudeEmptyText(usage({ status: 'error', failure: { reason: 'rate-limited', at: NOW, retryAt: NOW + 128_000 } }), NOW))
      .toBe('Rate limited — try again in 3m.')
    expect(claudeEmptyText(usage({ status: 'error', failure: { reason: 'rate-limited', at: NOW } }), NOW))
      .toBe('Rate limited — try again shortly.')
    expect(claudeEmptyText(usage({ status: 'error', failure: { reason: 'error', at: NOW } }), NOW)).toBe('Could not read usage.')
    expect(claudeEmptyText(usage({ status: 'error' }), NOW)).toBe('Could not read usage.')
    expect(claudeEmptyText(usage({ status: 'ok' }), NOW)).toBe('No usage data.')
  })
})
