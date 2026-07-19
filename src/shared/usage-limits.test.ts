import { describe, it, expect } from 'vitest'
import { limitLabel, limitShortLabel, primaryLimit, findLimit, limitKey } from './usage-limits'
import type { UsageLimit } from './types'

function limit(over: Partial<UsageLimit>): UsageLimit {
  return {
    kind: 'session',
    group: 'session',
    usedPercent: 0,
    severity: 'normal',
    resetsAt: null,
    windowMinutes: null,
    scopeLabel: null,
    isActive: false,
    ...over
  }
}

describe('limitLabel', () => {
  it('names the known kinds', () => {
    expect(limitLabel('session', null)).toBe('Session')
    expect(limitLabel('weekly_all', null)).toBe('Weekly')
  })

  it('prefers the model name for a scoped limit', () => {
    expect(limitLabel('weekly_scoped', 'Fable')).toBe('Fable')
  })

  it('prettifies an unknown kind instead of dropping it', () => {
    expect(limitLabel('monthly_surface', null)).toBe('Monthly Surface')
  })
})

describe('limitShortLabel', () => {
  it('abbreviates the known kinds for the pill', () => {
    expect(limitShortLabel('session', null)).toBe('5h')
    expect(limitShortLabel('weekly_all', null)).toBe('wk')
  })

  it('uses the bare model name for a scoped limit', () => {
    expect(limitShortLabel('weekly_scoped', 'Fable')).toBe('Fable')
  })
})

describe('primaryLimit', () => {
  it('leads with the server-flagged active limit, not the highest percentage', () => {
    // The 95% weekly looks worse, but the server says Fable is what is actually gating.
    const picked = primaryLimit([
      limit({ kind: 'weekly_all', usedPercent: 95, isActive: false }),
      limit({ kind: 'weekly_scoped', usedPercent: 87, scopeLabel: 'Fable', isActive: true })
    ])
    expect(picked?.scopeLabel).toBe('Fable')
  })

  it('falls back to the highest percentage when nothing is flagged active', () => {
    const picked = primaryLimit([
      limit({ kind: 'session', usedPercent: 7 }),
      limit({ kind: 'weekly_all', usedPercent: 61 }),
      limit({ kind: 'weekly_scoped', usedPercent: 87, scopeLabel: 'Fable' })
    ])
    expect(picked?.usedPercent).toBe(87)
  })

  it('picks the worst among several active limits', () => {
    const picked = primaryLimit([
      limit({ kind: 'session', usedPercent: 30, isActive: true }),
      limit({ kind: 'weekly_all', usedPercent: 70, isActive: true })
    ])
    expect(picked?.kind).toBe('weekly_all')
  })

  it('returns null for an empty list', () => {
    expect(primaryLimit([])).toBeNull()
  })
})

describe('findLimit', () => {
  it('finds by kind and returns null when absent', () => {
    const limits = [limit({ kind: 'session' }), limit({ kind: 'weekly_all' })]
    expect(findLimit(limits, 'weekly_all')?.kind).toBe('weekly_all')
    expect(findLimit(limits, 'monthly')).toBeNull()
  })
})

describe('limitKey', () => {
  it('separates scoped limits that share a kind', () => {
    // Two per-model weekly caps are both `weekly_scoped`; keying on kind alone would collide.
    const a = limit({ kind: 'weekly_scoped', scopeLabel: 'Fable' })
    const b = limit({ kind: 'weekly_scoped', scopeLabel: 'Opus' })
    expect(limitKey(a)).not.toBe(limitKey(b))
  })
})
