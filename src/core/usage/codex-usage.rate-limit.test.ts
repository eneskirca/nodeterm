// Issue #1168: a Codex usage read the backend refuses with HTTP 429 is named, starts a cooldown
// (Retry-After when sent, else a doubling default), and is NOT followed by the app-server
// fallback — which reads the same account's limits and so spends the same budget.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import { testTmpDir } from '../test-tmp'

const { findInLoginPath } = vi.hoisted(() => ({ findInLoginPath: vi.fn(async () => null) }))
vi.mock('../exec-path', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../exec-path')>()),
  findInLoginPath
}))

import {
  CODEX_RATE_LIMIT_DEFAULT_MS,
  CODEX_RATE_LIMIT_MAX_MS,
  CODEX_RATE_LIMIT_MIN_MS,
  codexRateLimitCooldownMs,
  fetchCodexUsage,
  parseRetryAfter,
  resetCodexUsageCooldownsForTests
} from './codex-usage'

const OK_BODY = {
  plan_type: 'pro',
  rate_limit: { primary_window: { used_percent: 10, limit_window_seconds: 18_000, reset_at: 4_102_444_800 } }
}

function home(): string {
  const dir = testTmpDir('codex-429-')
  fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify({ tokens: { access_token: 't' } }))
  return dir
}

function respond(status: number, headers: Record<string, string> = {}, body: unknown = OK_BODY) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    json: async () => body
  }
}

beforeEach(() => {
  resetCodexUsageCooldownsForTests()
  findInLoginPath.mockClear()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-16T12:00:00Z'))
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('parseRetryAfter / codexRateLimitCooldownMs', () => {
  it('reads delta-seconds and HTTP-dates, null otherwise', () => {
    const now = Date.parse('2026-10-16T12:00:00Z')
    expect(parseRetryAfter('120', now)).toBe(120_000)
    expect(parseRetryAfter('Fri, 16 Oct 2026 12:05:00 GMT', now)).toBe(300_000)
    expect(parseRetryAfter(null, now)).toBeNull()
    expect(parseRetryAfter('soon', now)).toBeNull()
  })

  it('clamps the header and doubles the default per consecutive 429', () => {
    expect(codexRateLimitCooldownMs(1000, 0)).toBe(CODEX_RATE_LIMIT_MIN_MS)
    expect(codexRateLimitCooldownMs(10 * 60 * 60_000, 0)).toBe(CODEX_RATE_LIMIT_MAX_MS)
    expect(codexRateLimitCooldownMs(null, 0)).toBe(CODEX_RATE_LIMIT_DEFAULT_MS)
    expect(codexRateLimitCooldownMs(null, 1)).toBe(2 * CODEX_RATE_LIMIT_DEFAULT_MS)
    expect(codexRateLimitCooldownMs(null, 40)).toBe(CODEX_RATE_LIMIT_MAX_MS)
  })
})

describe('fetchCodexUsage after HTTP 429', () => {
  it('names the 429 and does not fall through to the app-server tier', async () => {
    const fetch = vi.fn(async () => respond(429, { 'retry-after': '120' }))
    vi.stubGlobal('fetch', fetch)
    const row = await fetchCodexUsage(home(), { id: 'acc-1', email: 'a@example.com' })
    expect(row).toMatchObject({ provider: 'codex', status: 'error', rateLimited: true, limits: [] })
    expect(row.accountId).toBe('acc-1')
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(findInLoginPath).not.toHaveBeenCalled()
  })

  it('sends nothing while the Retry-After cooldown runs, then reads again', async () => {
    const fetch = vi.fn(async () => respond(429, { 'retry-after': '120' }))
    vi.stubGlobal('fetch', fetch)
    const dir = home()
    await fetchCodexUsage(dir)
    vi.setSystemTime(Date.now() + 119_000)
    const cooling = await fetchCodexUsage(dir)
    expect(cooling).toMatchObject({ status: 'error', rateLimited: true })
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(findInLoginPath).not.toHaveBeenCalled()

    fetch.mockImplementation(async () => respond(200))
    vi.setSystemTime(Date.now() + 2_000)
    const after = await fetchCodexUsage(dir)
    expect(after.status).toBe('ok')
    expect(after.rateLimited).toBeUndefined()
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('without Retry-After the wait doubles on a second 429 and a success clears it', async () => {
    const fetch = vi.fn(async () => respond(429))
    vi.stubGlobal('fetch', fetch)
    const dir = home()
    await fetchCodexUsage(dir)
    vi.setSystemTime(Date.now() + CODEX_RATE_LIMIT_DEFAULT_MS + 1)
    await fetchCodexUsage(dir)
    expect(fetch).toHaveBeenCalledTimes(2)
    // Second strike: twice the default, so one default later it is still cooling.
    vi.setSystemTime(Date.now() + CODEX_RATE_LIMIT_DEFAULT_MS + 1)
    await fetchCodexUsage(dir)
    expect(fetch).toHaveBeenCalledTimes(2)
    vi.setSystemTime(Date.now() + CODEX_RATE_LIMIT_DEFAULT_MS)
    fetch.mockImplementation(async () => respond(200))
    expect((await fetchCodexUsage(dir)).status).toBe('ok')
    // Cleared: the next 429 waits the default again, not four times it.
    fetch.mockImplementation(async () => respond(429))
    await fetchCodexUsage(dir)
    vi.setSystemTime(Date.now() + CODEX_RATE_LIMIT_DEFAULT_MS + 1)
    await fetchCodexUsage(dir)
    expect(fetch).toHaveBeenCalledTimes(5)
  })

  it('a cooldown belongs to one home: another account is still read', async () => {
    const fetch = vi.fn(async () => respond(429))
    vi.stubGlobal('fetch', fetch)
    await fetchCodexUsage(home())
    fetch.mockImplementation(async () => respond(200))
    expect((await fetchCodexUsage(home())).status).toBe('ok')
  })

  it('a non-429 failure still falls back to the app-server tier', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => respond(500)))
    const row = await fetchCodexUsage(home())
    expect(findInLoginPath).toHaveBeenCalled()
    expect(row.rateLimited).toBeUndefined()
  })
})
