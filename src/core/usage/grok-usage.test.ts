import { describe, it, expect } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  mapGrokLimits,
  mapGrokWeekly,
  mapGrokMonthly,
  grokConfigOf,
  parseMoney,
  pickGrokAuth,
  readGrokAuth,
  fetchGrokUsage,
  grokHome
} from './grok-usage'
import { limitLabel } from '../../shared/usage-limits'

/**
 * NOTE: not captured from a live account — no Grok credentials were available on the machine
 * this was written on. Follows the field contract orca's fetcher documents; numbers illustrative.
 */
const PERIOD = {
  billingPeriodStart: '2026-07-13T00:00:00Z',
  billingPeriodEnd: '2026-07-20T00:00:00Z',
  currentPeriod: {
    type: 'USAGE_PERIOD_TYPE_WEEKLY',
    start: '2026-07-13T00:00:00Z',
    end: '2026-07-20T00:00:00Z'
  }
}

describe('mapGrokWeekly', () => {
  it('maps the credit allowance', () => {
    const l = mapGrokWeekly({ ...PERIOD, creditUsagePercent: 40 })
    expect(l).toMatchObject({ kind: 'weekly_all', usedPercent: 40, windowMinutes: 10_080 })
    expect(l?.resetsAt).toBe(Date.parse('2026-07-20T00:00:00Z'))
  })

  it('reads an omitted percentage as 0% when the period proves it is weekly', () => {
    // Grok drops protobuf default values, so an untouched allowance arrives as an ABSENT field.
    // Matching billing bounds are what make "0% used" distinguishable from "no such limit".
    expect(mapGrokWeekly(PERIOD)?.usedPercent).toBe(0)
  })

  it('does NOT invent 0% when the period is not a confirmed weekly one', () => {
    // A monthly unified-billing response can carry a weekly currentPeriod whose bounds differ;
    // treating that omission as 0% would show a full allowance the account may not have.
    expect(
      mapGrokWeekly({
        billingPeriodStart: '2026-07-01T00:00:00Z',
        billingPeriodEnd: '2026-08-01T00:00:00Z',
        currentPeriod: {
          type: 'USAGE_PERIOD_TYPE_WEEKLY',
          start: '2026-07-13T00:00:00Z',
          end: '2026-07-20T00:00:00Z'
        }
      })
    ).toBeNull()
  })

  it('clamps an out-of-range percentage', () => {
    expect(mapGrokWeekly({ creditUsagePercent: 250 })?.usedPercent).toBe(100)
  })
})

describe('mapGrokMonthly', () => {
  it('derives a percentage from spend against the budget', () => {
    const l = mapGrokMonthly({ ...PERIOD, monthlyLimit: { val: '200' }, used: { val: '50' } })
    expect(l).toMatchObject({ kind: 'monthly_spend', usedPercent: 25, windowMinutes: 43_200 })
  })

  it('accepts money values as numbers or strings', () => {
    expect(parseMoney({ val: '12.5' })).toBe(12.5)
    expect(parseMoney({ val: 12.5 })).toBe(12.5)
    expect(parseMoney({ val: 'free' })).toBeNull()
    expect(parseMoney(undefined)).toBeNull()
  })

  it('refuses to divide by a zero or missing budget', () => {
    expect(mapGrokMonthly({ monthlyLimit: { val: 0 }, used: { val: 10 } })).toBeNull()
    expect(mapGrokMonthly({ used: { val: 10 } })).toBeNull()
  })
})

describe('grokConfigOf', () => {
  it('reads figures from the top level or from a nested config block', () => {
    expect(grokConfigOf({ creditUsagePercent: 10 }).creditUsagePercent).toBe(10)
    expect(grokConfigOf({ config: { creditUsagePercent: 10 } }).creditUsagePercent).toBe(10)
  })

  it('survives a junk body', () => {
    expect(grokConfigOf(null)).toEqual({})
    expect(grokConfigOf('nope')).toEqual({})
  })
})

describe('mapGrokLimits', () => {
  it('emits both windows when the plan has both', () => {
    const limits = mapGrokLimits({
      ...PERIOD,
      creditUsagePercent: 30,
      monthlyLimit: { val: 100 },
      used: { val: 10 }
    })
    expect(limits.map((l) => l.kind)).toEqual(['weekly_all', 'monthly_spend'])
  })

  it('labels the spend window readably', () => {
    expect(limitLabel('monthly_spend', null)).toBe('Monthly Spend')
  })

  it('reports no severity, leaving colour to the percentage thresholds', () => {
    for (const l of mapGrokLimits({ ...PERIOD, creditUsagePercent: 95 })) {
      expect(l.severity).toBeNull()
    }
  })
})

describe('pickGrokAuth', () => {
  it('prefers the xAI issuer when several are present', () => {
    expect(
      pickGrokAuth({
        'https://other.example': { key: 'wrong' },
        'https://auth.x.ai': { key: 'right', user_id: 'u1' }
      })
    ).toEqual({ key: 'right', userId: 'u1' })
  })

  it('falls back to an entry with a key rather than assuming a single issuer', () => {
    expect(pickGrokAuth({ 'https://other.example': { key: 'only' } }).key).toBe('only')
  })

  it('ignores entries without a key', () => {
    expect(pickGrokAuth({ a: { user_id: 'x' }, b: { key: 'k' } }).key).toBe('k')
  })

  it('returns nulls for junk', () => {
    expect(pickGrokAuth(null)).toEqual({ key: null, userId: null })
    expect(pickGrokAuth({})).toEqual({ key: null, userId: null })
  })
})

describe('fetchGrokUsage', () => {
  it('reports unavailable when not signed in, without touching the network', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-'))
    await expect(fetchGrokUsage(dir)).resolves.toMatchObject({
      provider: 'grok',
      status: 'unavailable',
      limits: []
    })
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('tolerates a malformed auth.json', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-'))
    fs.writeFileSync(path.join(dir, 'auth.json'), '{{{')
    await expect(readGrokAuth(dir)).resolves.toEqual({ key: null, userId: null })
    fs.rmSync(dir, { recursive: true, force: true })
  })
})

describe('grokHome', () => {
  it('honours GROK_HOME', () => {
    const prev = process.env.GROK_HOME
    process.env.GROK_HOME = '/tmp/custom-grok'
    expect(grokHome()).toBe('/tmp/custom-grok')
    if (prev === undefined) delete process.env.GROK_HOME
    else process.env.GROK_HOME = prev
  })
})
