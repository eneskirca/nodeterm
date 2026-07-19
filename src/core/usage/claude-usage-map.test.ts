import { describe, it, expect } from 'vitest'
import { mapUsageLimits, parseResetTimestamp } from './claude-usage-map'
import { findLimit, limitLabel, limitShortLabel } from '../../shared/usage-limits'

/**
 * Captured verbatim from a live GET /api/oauth/usage on a Max (default_claude_max_5x) account,
 * trimmed to the fields we read. Two things it pins down: the per-model top-level windows
 * (`seven_day_opus` & co.) are dead — always null — and the real per-model quota now arrives as
 * a `weekly_scoped` entry in `limits[]` whose model rides in `scope.model.display_name`.
 */
const LIVE_PAYLOAD = {
  five_hour: { utilization: 7.0, resets_at: '2026-07-19T04:09:59.841272+00:00' },
  seven_day: { utilization: 61.0, resets_at: '2026-07-20T21:59:59.841297+00:00' },
  seven_day_opus: null,
  seven_day_sonnet: null,
  limits: [
    {
      kind: 'session',
      group: 'session',
      percent: 7,
      severity: 'normal',
      resets_at: '2026-07-19T04:09:59.841272+00:00',
      scope: null,
      is_active: false
    },
    {
      kind: 'weekly_all',
      group: 'weekly',
      percent: 61,
      severity: 'normal',
      resets_at: '2026-07-20T21:59:59.841297+00:00',
      scope: null,
      is_active: false
    },
    {
      kind: 'weekly_scoped',
      group: 'weekly',
      percent: 87,
      severity: 'warning',
      resets_at: '2026-07-20T21:59:59.841724+00:00',
      scope: { model: { id: null, display_name: 'Fable' }, surface: null },
      is_active: true
    }
  ]
}

describe('mapUsageLimits', () => {
  it('maps every limit from the live payload, including the scoped model quota', () => {
    const limits = mapUsageLimits(LIVE_PAYLOAD)
    expect(limits).toHaveLength(3)

    const fable = limits.find((l) => l.scopeLabel === 'Fable')
    expect(fable).toMatchObject({
      kind: 'weekly_scoped',
      group: 'weekly',
      usedPercent: 87,
      severity: 'warning',
      scopeLabel: 'Fable',
      isActive: true
    })
  })

  it('keeps percentages as USED, not remaining', () => {
    const limits = mapUsageLimits(LIVE_PAYLOAD)
    expect(findLimit(limits, 'session')?.usedPercent).toBe(7)
    expect(findLimit(limits, 'weekly_all')?.usedPercent).toBe(61)
  })

  it('carries an unrecognized future kind through instead of dropping it', () => {
    // The whole point of limits[]: a kind we have never seen must still reach the UI.
    const limits = mapUsageLimits({
      limits: [{ kind: 'monthly_surface', percent: 42, resets_at: null }]
    })
    expect(limits).toHaveLength(1)
    expect(limits[0].kind).toBe('monthly_surface')
    expect(limits[0].usedPercent).toBe(42)
    expect(limitLabel(limits[0].kind, null)).toBe('Monthly Surface')
  })

  it('surfaces a scoped limit for a model that does not exist yet', () => {
    // Regression guard against re-introducing a hardcoded `fable` slot: any model name works.
    const limits = mapUsageLimits({
      limits: [
        {
          kind: 'weekly_scoped',
          percent: 12,
          scope: { model: { display_name: 'Mythos' } },
          is_active: true
        }
      ]
    })
    expect(limits[0].scopeLabel).toBe('Mythos')
    expect(limitShortLabel(limits[0].kind, limits[0].scopeLabel)).toBe('Mythos')
  })

  it('falls back to legacy fixed windows when limits[] is absent', () => {
    const limits = mapUsageLimits({
      five_hour: { utilization: 20, resets_at: '2026-07-19T04:09:59Z' },
      seven_day: { utilization: 55, resets_at: '2026-07-20T21:59:59Z' }
    })
    expect(limits.map((l) => l.kind)).toEqual(['session', 'weekly_all'])
    expect(limits[0].usedPercent).toBe(20)
  })

  it('falls back to legacy windows when limits[] is present but empty', () => {
    const limits = mapUsageLimits({ limits: [], five_hour: { utilization: 20 } })
    expect(limits).toHaveLength(1)
    expect(limits[0].kind).toBe('session')
  })

  it('skips malformed entries rather than emitting NaN percentages', () => {
    const limits = mapUsageLimits({
      limits: [
        { kind: 'session', percent: 'lots' },
        { kind: null, percent: 10 },
        { kind: 'weekly_all', percent: 30 }
      ]
    })
    expect(limits).toHaveLength(1)
    expect(limits[0].kind).toBe('weekly_all')
  })

  it('clamps out-of-range percentages', () => {
    const limits = mapUsageLimits({ limits: [{ kind: 'session', percent: 140 }] })
    expect(limits[0].usedPercent).toBe(100)
  })

  it('treats a missing is_active as unknown, not active', () => {
    const limits = mapUsageLimits({ limits: [{ kind: 'session', percent: 10 }] })
    expect(limits[0].isActive).toBe(false)
  })

  it('returns nothing for a junk body', () => {
    expect(mapUsageLimits(null)).toEqual([])
    expect(mapUsageLimits('nope')).toEqual([])
    expect(mapUsageLimits({})).toEqual([])
  })
})

describe('parseResetTimestamp', () => {
  it('parses ISO strings', () => {
    expect(parseResetTimestamp('2026-07-19T04:09:59.841272+00:00')).toBe(
      Date.parse('2026-07-19T04:09:59.841272+00:00')
    )
  })

  it('promotes Unix seconds to ms and leaves ms alone', () => {
    expect(parseResetTimestamp(1_784_436_069)).toBe(1_784_436_069_000)
    expect(parseResetTimestamp(1_784_436_069_255)).toBe(1_784_436_069_255)
  })

  it('returns null for junk', () => {
    expect(parseResetTimestamp(null)).toBeNull()
    expect(parseResetTimestamp('')).toBeNull()
    expect(parseResetTimestamp('not a date')).toBeNull()
  })
})
