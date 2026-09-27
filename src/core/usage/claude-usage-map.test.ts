import { describe, it, expect } from 'vitest'
import { emptyUsage, keepLastGood, usageOrigin, mapUsageLimits, parseResetTimestamp, usageFromPayload } from './claude-usage-map'
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

describe('keepLastGood — organization identity', () => {
  const org = (uuid?: string) => ({ name: uuid ?? 'Unnamed', ...(uuid ? { uuid } : {}) })
  const prevIn = (uuid?: string) =>
    ({ ...usageFromPayload({ five_hour: { utilization: 12 } }, 'a@x.test', 1000), organization: org(uuid) })
  const failIn = (uuid?: string | null) => ({
    ...emptyUsage('a@x.test', 5000, 'error', { reason: 'rate-limited' as const, at: 5000, retryAt: 65000 }),
    ...(uuid === null ? {} : { organization: org(uuid) })
  })

  it('drops the numbers when the same email is now in a DIFFERENT organization', () => {
    const f = failIn('org-team')
    expect(keepLastGood(prevIn('org-personal'), f)).toBe(f)
  })

  it('keeps them when both organizations are known and equal', () => {
    expect(keepLastGood(prevIn('org-personal'), failIn('org-personal')).limits).toHaveLength(1)
  })

  it('a chain A → unknown → B is judged against the ORIGIN, not the merged middle step', () => {
    const a = prevIn('org-A')
    const mid = keepLastGood(a, failIn(null), usageOrigin(a))
    expect(mid.limits).toHaveLength(1)
    const f = failIn('org-B')
    expect(keepLastGood(mid, f, usageOrigin(a))).toBe(f)
    // Without an explicit origin the previous snapshot is its own origin (a fresh ok snapshot).
    expect(keepLastGood(a, failIn('org-B'))).toEqual(failIn('org-B'))
  })

  it('an unknown organization on either side cannot prove a switch: the email guard decides', () => {
    expect(keepLastGood(prevIn(undefined), failIn('org-team')).limits).toHaveLength(1)
    expect(keepLastGood(prevIn('org-personal'), failIn(undefined)).limits).toHaveLength(1)
    const noFreshOrg = keepLastGood(prevIn('org-personal'), failIn(null))
    expect(noFreshOrg.limits).toHaveLength(1)
    // …and the kept numbers are never labelled with an organization the fresh read did not confirm.
    expect(noFreshOrg.organization).toBeUndefined()
  })
})

describe('keepLastGood', () => {
  const good = { ...usageFromPayload({ five_hour: { utilization: 12 } }, 'a@x.test', 1000),
    organization: { name: 'Old org' } }
  const failed = (email: string | null, organization?: { name: string }) => ({
    ...emptyUsage(email, 5000, 'error', { reason: 'rate-limited' as const, at: 5000, retryAt: 65000 }),
    ...(organization ? { organization } : {})
  })

  it('keeps the numbers and their time, takes the failure and the CURRENT identity', () => {
    const u = keepLastGood(good, failed('a@x.test', { name: 'New org' }))
    expect(u).toMatchObject({ status: 'error', updatedAt: 1000, email: 'a@x.test',
      organization: { name: 'New org' }, failure: { reason: 'rate-limited', retryAt: 65000 } })
    expect(u.limits).toEqual(good.limits)
    // An organization the fresh read could not confirm is not carried over.
    expect(keepLastGood(good, failed('a@x.test')).organization).toBeUndefined()
  })

  it('passes the fresh result through when there is nothing to keep or no failure', () => {
    const ok = usageFromPayload({ five_hour: { utilization: 3 } }, 'a@x.test', 9000)
    expect(keepLastGood(good, ok)).toBe(ok)
    const f = failed('a@x.test')
    expect(keepLastGood(undefined, f)).toBe(f)
    expect(keepLastGood(emptyUsage('a@x.test', 1, 'ok'), f)).toBe(f)
    expect(keepLastGood(good, failed('b@x.test'))).toEqual(failed('b@x.test'))
  })
})
