import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'fs'
import path from 'path'
import {
  mapCursorLimits,
  holdCursorLastGood,
  fetchCursorUsage,
  tokenSubject,
  cursorAuthFile,
  resetCursorUsageHold
} from './cursor-usage'
import type { ProviderUsage } from '../../shared/types'

// Synthetic, shaped like a measured GetCurrentPeriodUsage reply (cursor-agent 2026.10.01). No real ids.
const START = 1_790_000_000_000
const END = START + 30 * 24 * 60 * 60 * 1000
const BODY = {
  billingCycleStart: String(START),
  billingCycleEnd: String(END),
  planUsage: {
    totalSpend: 12000,
    includedSpend: 8000,
    bonusSpend: 4000,
    limit: 20000,
    remainingBonus: true,
    bonusTooltip: 'synthetic',
    autoPercentUsed: 12.5,
    apiPercentUsed: 100,
    totalPercentUsed: 40
  },
  spendLimitUsage: { limitType: 'user' },
  enabled: true
}

const jwt = (sub: string): string =>
  ['e30', Buffer.from(JSON.stringify({ sub })).toString('base64url'), 'sig'].join('.')

const reply = (status: number, body: unknown = BODY): typeof fetch =>
  (async () => new Response(JSON.stringify(body), { status })) as typeof fetch

describe('mapCursorLimits', () => {
  it('maps total, Auto and API percentages with the billing reset', () => {
    const limits = mapCursorLimits(BODY)
    expect(limits.map((l) => [l.kind, l.scopeLabel, l.usedPercent])).toEqual([
      ['monthly', null, 40],
      ['monthly_scoped', 'Auto', 12.5],
      ['monthly_scoped', 'API', 100]
    ])
    expect(limits[0].resetsAt).toBe(END)
    expect(limits[0].windowMinutes).toBe(30 * 24 * 60)
  })

  it('falls back to included spend over the limit, as the CLI does', () => {
    const { totalPercentUsed: _t, autoPercentUsed: _a, apiPercentUsed: _p, ...plan } = BODY.planUsage
    expect(mapCursorLimits({ ...BODY, planUsage: plan })[0].usedPercent).toBe(40)
  })

  it('draws nothing (never 0%) without planUsage or a total', () => {
    expect(mapCursorLimits({ billingCycleEnd: String(END) })).toEqual([])
    expect(mapCursorLimits({ planUsage: { limit: 0 } })).toEqual([])
    expect(mapCursorLimits(null)).toEqual([])
  })
})

describe('fetchCursorUsage', () => {
  beforeEach(() => resetCursorUsageHold())

  it('is unavailable when not signed in, and asks nothing', async () => {
    let called = false
    const u = await fetchCursorUsage({
      readToken: async () => null,
      fetchImpl: (async () => { called = true; return new Response('{}') }) as typeof fetch
    })
    expect(u.status).toBe('unavailable')
    expect(called).toBe(false)
  })

  it('sends the token only in the Authorization header', async () => {
    const token = jwt('user|synthetic')
    let seen: { url: string; init?: RequestInit } | null = null
    const u = await fetchCursorUsage({
      readToken: async () => token,
      fetchImpl: (async (url: string, init?: RequestInit) => {
        seen = { url, init }
        return new Response(JSON.stringify(BODY), { status: 200 })
      }) as typeof fetch
    })
    expect(u.status).toBe('ok')
    expect(u.limits).toHaveLength(3)
    expect(seen!.url).not.toContain(token)
    expect(seen!.init?.body).toBe('{}')
    expect((seen!.init?.headers as Record<string, string>).authorization).toBe(`Bearer ${token}`)
  })

  it('never parses a reply past 256 KB, and still maps a normal one', async () => {
    const huge = { ...BODY, pad: 'x'.repeat(300 * 1024) }
    const big = await fetchCursorUsage({ readToken: async () => jwt('a'), fetchImpl: reply(200, huge) })
    expect(big).toMatchObject({ status: 'unavailable', limits: [] })
    const ok = await fetchCursorUsage({ readToken: async () => jwt('a'), fetchImpl: reply(200) })
    expect(ok.status).toBe('ok')
  })

  it('reads an expired token (401) as unavailable', async () => {
    const u = await fetchCursorUsage({ readToken: async () => jwt('a'), fetchImpl: reply(401) })
    expect(u.status).toBe('unavailable')
  })

  it('keeps the last good numbers through a 5xx or a network failure', async () => {
    const token = jwt('a')
    const good = await fetchCursorUsage({ readToken: async () => token, fetchImpl: reply(200) })
    const failed = await fetchCursorUsage({ readToken: async () => token, fetchImpl: reply(503) })
    expect(failed.status).toBe('error')
    expect(failed.limits).toEqual(good.limits)
    const thrown = await fetchCursorUsage({
      readToken: async () => token,
      fetchImpl: (async () => { throw new Error('offline') }) as typeof fetch
    })
    expect(thrown.status).toBe('error')
    expect(thrown.limits).toEqual(good.limits)
  })

  it('does not hold one login numbers for another login', async () => {
    await fetchCursorUsage({ readToken: async () => jwt('a'), fetchImpl: reply(200) })
    const other = await fetchCursorUsage({ readToken: async () => jwt('b'), fetchImpl: reply(500) })
    expect(other.status).toBe('error')
    expect(other.limits).toEqual([])
  })
})

describe('holdCursorLastGood', () => {
  const now = START + 1000
  const usage = (over: Partial<ProviderUsage>): ProviderUsage => ({
    provider: 'cursor', account: null, updatedAt: now, status: 'ok', limits: mapCursorLimits(BODY), ...over
  })

  it('refuses past an hour or after the reset', () => {
    const fail = usage({ status: 'error', limits: [] })
    expect(holdCursorLastGood({ sub: 'a', usage: usage({ updatedAt: now - 2 * 3600_000 }) }, fail, 'a', now).limits).toEqual([])
    expect(holdCursorLastGood({ sub: 'a', usage: usage({}) }, fail, 'a', END + 1).limits).toEqual([])
    expect(holdCursorLastGood({ sub: 'a', usage: usage({}) }, fail, 'a', now).limits).toHaveLength(3)
  })
})

describe('credential handling', () => {
  it('reads the sub claim and nothing else', () => {
    expect(tokenSubject(jwt('user|x'))).toBe('user|x')
    expect(tokenSubject('not-a-jwt')).toBeNull()
  })

  it('knows the CLI file-store path per platform', () => {
    expect(cursorAuthFile('linux', {}, '/h')).toBe(path.join('/h', '.config', 'cursor', 'auth.json'))
    expect(cursorAuthFile('linux', { XDG_CONFIG_HOME: '/x' }, '/h')).toBe(path.join('/x', 'cursor', 'auth.json'))
    expect(cursorAuthFile('darwin', {}, '/h')).toBe(path.join('/h', '.cursor', 'auth.json'))
  })

  it('never puts the token on an argv (source pin)', () => {
    const src = readFileSync(path.join(__dirname, 'cursor-usage.ts'), 'utf8').replace(/\r\n/g, '\n')
    const call = src.slice(src.indexOf("'/usr/bin/security'"), src.indexOf('{ timeout: 5000 }'))
    expect(call).toContain("['find-generic-password', '-a', 'cursor-user', '-s', 'cursor-access-token', '-w']")
    expect(call).not.toContain('${')
    expect(call).not.toContain('Bearer')
    expect(src.match(/execFileP\(/g)).toHaveLength(1)
  })
})
