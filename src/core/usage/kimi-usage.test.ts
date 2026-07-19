import { describe, it, expect } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  mapKimiLimits,
  mapKimiDetail,
  windowToMinutes,
  readKimiToken,
  fetchKimiUsage,
  kimiHome
} from './kimi-usage'

/**
 * NOTE: not captured from a live account — no Kimi credentials were available on the machine
 * this was written on. Follows the field contract orca's fetcher documents.
 */
const RESPONSE = {
  usage: { limit: '1000', used: '250', resetTime: '2026-07-26T00:00:00Z' },
  limits: [
    {
      window: { duration: 5, timeUnit: 'HOURS' },
      detail: { limit: 100, used: 30, resetTime: '2026-07-19T20:00:00Z' }
    }
  ]
}

describe('windowToMinutes', () => {
  it('converts each unit', () => {
    expect(windowToMinutes({ duration: 5, timeUnit: 'HOURS' })).toBe(300)
    expect(windowToMinutes({ duration: 90, timeUnit: 'MINUTES' })).toBe(90)
    expect(windowToMinutes({ duration: 7, timeUnit: 'DAYS' })).toBe(10_080)
    expect(windowToMinutes({ duration: 120, timeUnit: 'SECONDS' })).toBe(2)
  })

  it('treats an unrecognized unit as minutes rather than dropping the window', () => {
    expect(windowToMinutes({ duration: 42, timeUnit: 'FORTNIGHTS' })).toBe(42)
  })

  it('returns null without a duration', () => {
    expect(windowToMinutes({ timeUnit: 'HOURS' })).toBeNull()
    expect(windowToMinutes(undefined)).toBeNull()
  })
})

describe('mapKimiDetail', () => {
  it('turns counts into a percentage', () => {
    expect(mapKimiDetail({ limit: 200, used: 50 }, 'session', 'session', 300)?.usedPercent).toBe(25)
  })

  it('accepts counts as strings', () => {
    expect(mapKimiDetail({ limit: '200', used: '50' }, 'session', 'session', 300)?.usedPercent).toBe(25)
  })

  it('derives used from remaining when the plan reports only remaining', () => {
    // Dropping the window instead would hide a quota the account actually has.
    expect(mapKimiDetail({ limit: 200, remaining: 150 }, 'session', 'session', 300)?.usedPercent).toBe(25)
  })

  it('refuses to divide by a zero or missing limit', () => {
    expect(mapKimiDetail({ limit: 0, used: 5 }, 'session', 'session', 300)).toBeNull()
    expect(mapKimiDetail({ used: 5 }, 'session', 'session', 300)).toBeNull()
  })

  it('returns null when neither used nor remaining is present', () => {
    expect(mapKimiDetail({ limit: 100 }, 'session', 'session', 300)).toBeNull()
  })

  it('parses resetTime or resetAt, and survives neither', () => {
    expect(mapKimiDetail({ limit: 1, used: 0, resetAt: '2026-07-19T20:00:00Z' }, 'k', 'g', 60)?.resetsAt)
      .toBe(Date.parse('2026-07-19T20:00:00Z'))
    expect(mapKimiDetail({ limit: 1, used: 0 }, 'k', 'g', 60)?.resetsAt).toBeNull()
  })

  it('clamps a count that exceeds its limit', () => {
    expect(mapKimiDetail({ limit: 10, used: 50 }, 'k', 'g', 60)?.usedPercent).toBe(100)
  })
})

describe('mapKimiLimits', () => {
  it('emits the weekly quota and every rolling window', () => {
    const limits = mapKimiLimits(RESPONSE)
    expect(limits.map((l) => l.kind)).toEqual(['weekly_all', 'session'])
    expect(limits[0].usedPercent).toBe(25)
    expect(limits[1].usedPercent).toBe(30)
    expect(limits[1].windowMinutes).toBe(300)
  })

  it('keeps EVERY rolling window rather than picking the one nearest 5h', () => {
    // Orca picks one because its shape has a single session slot; ours carries a list, so a plan
    // with both an hourly and a 5-hourly cap must show both.
    const limits = mapKimiLimits({
      limits: [
        { window: { duration: 1, timeUnit: 'HOURS' }, detail: { limit: 10, used: 1 } },
        { window: { duration: 5, timeUnit: 'HOURS' }, detail: { limit: 100, used: 40 } }
      ]
    })
    expect(limits).toHaveLength(2)
    expect(limits.map((l) => l.windowMinutes)).toEqual([60, 300])
  })

  it('skips malformed entries', () => {
    const limits = mapKimiLimits({
      limits: [null, { detail: { limit: 0, used: 1 } }, { window: {}, detail: { limit: 4, used: 1 } }]
    })
    expect(limits).toHaveLength(1)
    expect(limits[0].windowMinutes).toBeNull()
  })

  it('reports no severity', () => {
    for (const l of mapKimiLimits(RESPONSE)) expect(l.severity).toBeNull()
  })

  it('returns nothing for a junk body', () => {
    expect(mapKimiLimits(null)).toEqual([])
    expect(mapKimiLimits({})).toEqual([])
  })
})

describe('readKimiToken', () => {
  it('reads the access token from the credentials file', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-'))
    fs.mkdirSync(path.join(dir, 'credentials'))
    fs.writeFileSync(
      path.join(dir, 'credentials', 'kimi-code.json'),
      JSON.stringify({ access_token: 'tok' })
    )
    await expect(readKimiToken(dir)).resolves.toBe('tok')
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('returns null for a missing file rather than throwing', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-'))
    await expect(readKimiToken(dir)).resolves.toBeNull()
    fs.rmSync(dir, { recursive: true, force: true })
  })
})

describe('fetchKimiUsage', () => {
  it('reports unavailable when not signed in, without touching the network', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-'))
    await expect(fetchKimiUsage(dir)).resolves.toMatchObject({
      provider: 'kimi',
      status: 'unavailable',
      limits: []
    })
    fs.rmSync(dir, { recursive: true, force: true })
  })
})

describe('kimiHome', () => {
  it('honours KIMI_CODE_HOME', () => {
    const prev = process.env.KIMI_CODE_HOME
    process.env.KIMI_CODE_HOME = '/tmp/custom-kimi'
    expect(kimiHome()).toBe('/tmp/custom-kimi')
    if (prev === undefined) delete process.env.KIMI_CODE_HOME
    else process.env.KIMI_CODE_HOME = prev
  })
})
