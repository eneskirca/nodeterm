import { describe, it, expect } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  dedupeBuckets,
  parseQuotaBuckets,
  modelLabel,
  readGeminiCreds,
  fetchGeminiUsage
} from './gemini-usage'
import { primaryLimit, limitLabel } from '../../shared/usage-limits'

/**
 * Cloud Code's `retrieveUserQuota` buckets: `remainingFraction` is what is LEFT (0–1),
 * `resetTime` an ISO string, `modelId` the raw model name.
 *
 * NOTE: not captured from a live account — no Gemini credentials were available on the machine
 * this was written on. Follows the documented field contract; numbers are illustrative.
 */
const BUCKETS = [
  { remainingFraction: 0.25, resetTime: '2026-07-19T17:00:00Z', modelId: 'gemini-2.5-pro' },
  { remainingFraction: 0.9, resetTime: '2026-07-19T17:00:00Z', modelId: 'gemini-2.5-flash' }
]

function mktemp(contents?: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-'))
  if (contents !== undefined) fs.writeFileSync(path.join(dir, 'oauth_creds.json'), contents)
  return dir
}

describe('bucket mapping', () => {
  it('inverts remainingFraction into percent USED', () => {
    // Google is the only provider that reports what is LEFT. Getting this backwards would show
    // a drained quota as untouched.
    const limits = dedupeBuckets(BUCKETS)
    expect(limits.find((l) => l.scopeLabel === 'Pro')?.usedPercent).toBe(75)
    expect(limits.find((l) => l.scopeLabel === 'Flash')?.usedPercent).toBe(10)
  })

  it('labels each bucket by model, so the UI needs no Gemini knowledge', () => {
    const limits = dedupeBuckets(BUCKETS)
    expect(limitLabel(limits[0].kind, limits[0].scopeLabel)).toBe('Pro')
  })

  it('reports the hourly window and no severity', () => {
    for (const l of dedupeBuckets(BUCKETS)) {
      expect(l.windowMinutes).toBe(60)
      expect(l.severity).toBeNull()
    }
  })

  it('parses the ISO reset stamp', () => {
    expect(dedupeBuckets(BUCKETS)[0].resetsAt).toBe(Date.parse('2026-07-19T17:00:00Z'))
  })

  it('survives an unparseable reset stamp', () => {
    const l = dedupeBuckets([{ remainingFraction: 0.5, resetTime: 'soon', modelId: 'x' }])
    expect(l[0].resetsAt).toBeNull()
  })

  it('clamps a fraction outside 0–1', () => {
    expect(dedupeBuckets([{ remainingFraction: 1.4, resetTime: '', modelId: 'a' }])[0].usedPercent).toBe(0)
    expect(dedupeBuckets([{ remainingFraction: -2, resetTime: '', modelId: 'b' }])[0].usedPercent).toBe(100)
  })
})

describe('modelLabel', () => {
  it('uses the friendly name for known ids', () => {
    expect(modelLabel('gemini-2.5-pro')).toBe('Pro')
    expect(modelLabel('gemini-3.1-flash-lite')).toBe('3.1 Flash Lite')
  })

  it('humanizes an unknown id rather than showing it raw', () => {
    expect(modelLabel('gemini-4.0-ultra')).toBe('4.0 Ultra')
  })
})

describe('dedupeBuckets', () => {
  it('collapses aliases that share one underlying quota', () => {
    // Google returns the same bucket under several ids; rendering all of them repeats one bar.
    const limits = dedupeBuckets([
      { remainingFraction: 0.25, resetTime: '2026-07-19T17:00:00Z', modelId: 'gemini-2.5-pro' },
      { remainingFraction: 0.25, resetTime: '2026-07-19T17:00:00Z', modelId: 'gemini-pro-latest' },
      { remainingFraction: 0.25, resetTime: '2026-07-19T17:00:00Z', modelId: 'gemini-2.5-pro-exp-0827' }
    ])
    expect(limits).toHaveLength(1)
    // The known label wins over the humanized ones.
    expect(limits[0].scopeLabel).toBe('Pro')
  })

  it('keeps buckets that differ in usage or reset time', () => {
    expect(dedupeBuckets(BUCKETS)).toHaveLength(2)
  })

  it('prefers the shorter name among equally-unknown aliases', () => {
    const limits = dedupeBuckets([
      { remainingFraction: 0.5, resetTime: 'x', modelId: 'gemini-zeta-experimental-preview' },
      { remainingFraction: 0.5, resetTime: 'x', modelId: 'gemini-zeta' }
    ])
    expect(limits).toHaveLength(1)
    expect(limits[0].scopeLabel).toBe('Zeta')
  })
})

describe('parseQuotaBuckets', () => {
  it('accepts both the bare array and the { buckets } wrapper', () => {
    expect(parseQuotaBuckets(BUCKETS)).toHaveLength(2)
    expect(parseQuotaBuckets({ buckets: BUCKETS })).toHaveLength(2)
  })

  it('drops malformed entries instead of emitting NaN bars', () => {
    const parsed = parseQuotaBuckets([
      { remainingFraction: 'lots', resetTime: 'x', modelId: 'a' },
      { remainingFraction: 0.5, modelId: 'b' },
      BUCKETS[0]
    ])
    expect(parsed).toHaveLength(1)
  })

  it('returns nothing for a junk body', () => {
    expect(parseQuotaBuckets(null)).toEqual([])
    expect(parseQuotaBuckets({})).toEqual([])
    expect(parseQuotaBuckets('nope')).toEqual([])
  })
})

describe('readGeminiCreds', () => {
  it('reads the access token', async () => {
    const dir = mktemp(JSON.stringify({ access_token: 'tok', expiry_date: Date.now() + 60_000 }))
    await expect(readGeminiCreds(dir)).resolves.toEqual({ accessToken: 'tok', expired: false })
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('flags an expired token', async () => {
    const dir = mktemp(JSON.stringify({ access_token: 'tok', expiry_date: Date.now() - 1000 }))
    await expect(readGeminiCreds(dir)).resolves.toMatchObject({ expired: true })
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('treats a missing expiry_date as not-expired and lets the API decide', async () => {
    // Refusing to try on incomplete local metadata would be a self-inflicted outage.
    const dir = mktemp(JSON.stringify({ access_token: 'tok' }))
    await expect(readGeminiCreds(dir)).resolves.toEqual({ accessToken: 'tok', expired: false })
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('returns nulls for a missing or malformed file rather than throwing', async () => {
    const dir = mktemp()
    await expect(readGeminiCreds(dir)).resolves.toEqual({ accessToken: null, expired: false })
    fs.writeFileSync(path.join(dir, 'oauth_creds.json'), 'not json')
    await expect(readGeminiCreds(dir)).resolves.toEqual({ accessToken: null, expired: false })
    fs.rmSync(dir, { recursive: true, force: true })
  })
})

describe('fetchGeminiUsage', () => {
  it('reports unavailable when not signed in, without touching the network', async () => {
    const dir = mktemp()
    await expect(fetchGeminiUsage(dir)).resolves.toMatchObject({
      provider: 'gemini',
      status: 'unavailable',
      limits: []
    })
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('reports unavailable on an expired token instead of calling the API', async () => {
    // We deliberately do not refresh (see the module header), so a lapsed token is "nothing to
    // show" rather than an error the user is asked to act on.
    const dir = mktemp(JSON.stringify({ access_token: 'tok', expiry_date: 1 }))
    await expect(fetchGeminiUsage(dir)).resolves.toMatchObject({ status: 'unavailable' })
    fs.rmSync(dir, { recursive: true, force: true })
  })
})

describe('shared helpers over Gemini limits', () => {
  it('leads with the most constrained model, no synthesized session window needed', () => {
    expect(primaryLimit(dedupeBuckets(BUCKETS))?.scopeLabel).toBe('Pro')
  })
})
