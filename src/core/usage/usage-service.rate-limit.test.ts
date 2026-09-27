// The usage endpoint answers a busy account with 429 + Retry-After. Measured 2026-09-27 on a real
// account with a valid token: `HTTP 429 rate_limit_error`, `retry-after: 128`. The service used to
// turn that into an EMPTY error snapshot ("Could not read usage.") — throwing away numbers it had
// fetched a minute earlier — and to ask again on the very next poll or ⟳. These tests pin the fix:
// keep the last good snapshot (marked stale, with the reason), and do not call the endpoint for
// that account again until Retry-After has passed. `fetch` is mocked; the real endpoint is never
// called from here.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'fs'
import { fetchUsage, parseRetryAfter, startUsageService, type UsageService } from './usage-service'
import { initPlatform, resetPlatformForTests } from '../platform'
import { fakePlatform, type FakePlatform } from '../platform-fake'
import { IPC } from '../../shared/ipc'
import type { ClaudeUsage } from '../../shared/types'

const { keychain } = vi.hoisted(() => ({ keychain: vi.fn() }))
vi.mock('child_process', () => ({ execFile: keychain }))
vi.mock('fs', async (original) => {
  const actual = await original<typeof import('fs')>()
  return { ...actual, promises: { ...actual.promises, readFile: vi.fn() } }
})
vi.mock('os', async (original) => {
  const actual = await original<typeof import('os')>()
  return { ...actual, default: { ...actual, homedir: () => '/fixture-home' } }
})

const T0 = Date.UTC(2026, 8, 27, 14, 2, 0)
const POLL_MS = 15 * 60 * 1000
const creds = (email: string): string =>
  JSON.stringify({ claudeAiOauth: { accessToken: 'fixture-token', email } })

let files: Record<string, string>
let platform: FakePlatform
let service: UsageService | undefined
let polling = false

type Reply = { status: number; headers?: Record<string, string>; body?: unknown } | 'network'
const replies: Reply[] = []
const fetchMock = vi.fn(async () => {
  const r = replies.shift()
  if (!r) throw new Error('unexpected fetch: no reply queued')
  if (r === 'network') throw new TypeError('fetch failed')
  return new Response(JSON.stringify(r.body ?? {}), { status: r.status, headers: r.headers })
})
const good = (pct: number): Reply => ({ status: 200, body: { five_hour: { utilization: pct } } })
const rateLimited = (retryAfter?: string): Reply => ({
  status: 429,
  headers: retryAfter === undefined ? {} : { 'retry-after': retryAfter },
  body: { error: { type: 'rate_limit_error', message: 'Rate limited. Please try again later.' } }
})

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(T0)
  platform = fakePlatform({ userDataDir: '/fixture-data' })
  initPlatform(platform)
  vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
  files = {
    '/fixture-home/.claude/.credentials.json': creds('me@example.test'),
    '/fixture-data/claude-accounts/team/.credentials.json': creds('team@example.test')
  }
  vi.mocked(fs.readFile).mockImplementation(async (file) => {
    const raw = files[String(file)]
    if (raw === undefined) throw new Error('fixture missing')
    return raw
  })
  keychain.mockReset()
  keychain.mockImplementation((_cmd, _args, cb) => cb(new Error('fixture missing')))
  replies.length = 0
  fetchMock.mockClear()
  vi.stubGlobal('fetch', fetchMock)
  polling = false
})

afterEach(() => {
  service?.dispose()
  service = undefined
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  resetPlatformForTests()
})

const start = (): UsageService => {
  service = startUsageService({ shouldPoll: () => polling })
  return service
}
const ipcRefresh = (accountId?: string): Promise<ClaudeUsage> =>
  platform.handlers[IPC.usageRefresh](accountId) as Promise<ClaudeUsage>
const ipcFetch = (accountId?: string): Promise<ClaudeUsage> =>
  platform.handlers[IPC.usageFetch](accountId) as Promise<ClaudeUsage>

describe('429 after a good snapshot', () => {
  it('keeps the last good numbers, marked stale with the reason and the retry time', async () => {
    const s = start()
    replies.push(good(12))
    const first = await s.refresh()
    expect(first).toMatchObject({ status: 'ok', session: { leftPercent: 88 }, updatedAt: T0 })
    expect(first.failure).toBeUndefined()

    vi.setSystemTime(T0 + 60_000)
    replies.push(rateLimited('128'))
    const u = await s.refresh()
    expect(u.status).toBe('error')
    expect(u.limits).toEqual(first.limits)
    expect(u.session).toEqual({ leftPercent: 88, resetsAt: null })
    // The age the popover prints must stay the age of the NUMBERS, not of the failed request.
    expect(u.updatedAt).toBe(T0)
    expect(u.email).toBe('me@example.test')
    expect(u.failure).toEqual({ reason: 'rate-limited', at: T0 + 60_000, retryAt: T0 + 60_000 + 128_000 })
    // The pushed channel and the mirror's snapshot both see the kept numbers.
    const pushed = platform.sent.filter((m) => m.channel === IPC.usageUpdate).at(-1)?.args[0] as ClaudeUsage
    expect(pushed.limits).toHaveLength(1)
    expect(s.snapshot()[0].usage.limits).toHaveLength(1)
  })

  it('does not call the endpoint again before Retry-After — forced ⟳, IPC fetch or background poll', async () => {
    const s = start()
    replies.push(good(12), rateLimited('128'))
    await s.refresh()
    await s.refresh()
    expect(fetchMock).toHaveBeenCalledTimes(2)

    vi.setSystemTime(T0 + 100_000)
    const viaRefresh = await ipcRefresh()
    const viaFetch = await ipcFetch()
    const viaService = await s.refresh()
    for (const u of [viaRefresh, viaFetch, viaService]) {
      expect(u.limits).toHaveLength(1)
      expect(u.failure?.reason).toBe('rate-limited')
    }
    s.refreshIfStale()
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('the background poll honours a long Retry-After as well', async () => {
    const s = start()
    replies.push(good(12), rateLimited('3600'))
    await s.refresh()
    await s.refresh()
    polling = true
    await vi.advanceTimersByTimeAsync(POLL_MS)
    await vi.advanceTimersByTimeAsync(POLL_MS)
    await vi.advanceTimersByTimeAsync(POLL_MS)
    // Three polls inside the hour: none of them reached the endpoint.
    expect(fetchMock).toHaveBeenCalledTimes(2)
    // The fourth lands past the window and asks again.
    replies.push(good(40))
    await vi.advanceTimersByTimeAsync(POLL_MS)
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(s.snapshot()[0].usage).toMatchObject({ status: 'ok', session: { leftPercent: 60 } })
  })

  it('asks again once the window has passed, and a success clears the stale marker', async () => {
    const s = start()
    replies.push(good(12), rateLimited('128'))
    await s.refresh()
    await s.refresh()

    vi.setSystemTime(T0 + 128_001)
    replies.push(good(30))
    const u = await s.refresh()
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(u.status).toBe('ok')
    expect(u.failure).toBeUndefined()
    expect(u.session?.leftPercent).toBe(70)
    expect(u.updatedAt).toBe(T0 + 128_001)
  })

  it('a second 429 keeps the ORIGINAL snapshot time, not the first failure', async () => {
    const s = start()
    replies.push(good(12), rateLimited('60'))
    await s.refresh()
    await s.refresh()
    vi.setSystemTime(T0 + 61_000)
    replies.push(rateLimited('60'))
    const u = await s.refresh()
    expect(u.updatedAt).toBe(T0)
    expect(u.limits).toHaveLength(1)
    expect(u.failure).toMatchObject({ reason: 'rate-limited', at: T0 + 61_000, retryAt: T0 + 121_000 })
  })

  it('never carries one identity’s numbers onto another', async () => {
    const s = start()
    replies.push(good(12))
    await s.refresh()
    files['/fixture-home/.claude/.credentials.json'] = creds('other@example.test')
    replies.push(rateLimited('60'))
    const u = await s.refresh()
    expect(u.limits).toEqual([])
    expect(u.email).toBe('other@example.test')
    expect(u.failure?.reason).toBe('rate-limited')
  })

  it('gates each account on its own — a rate-limited system account does not silence a managed one', async () => {
    const s = start()
    replies.push(good(12), rateLimited('600'))
    await s.refresh()
    await s.refresh()
    replies.push(good(50))
    const team = await s.refresh('team')
    expect(team).toMatchObject({ status: 'ok', email: 'team@example.test' })
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })
})

describe('Retry-After forms', () => {
  it.each([
    ['absent', undefined, 60_000],
    ['seconds', '128', 128_000],
    ['garbage', 'soon-ish', 60_000],
    ['negative', '-5', 60_000],
    ['fractional', '1.5', 60_000],
    ['zero (clamped up)', '0', 30_000],
    ['huge (clamped down)', '999999', 60 * 60 * 1000]
  ])('%s', async (_name, header, expectedMs) => {
    const s = start()
    replies.push(good(12), rateLimited(header))
    await s.refresh()
    const u = await s.refresh()
    expect(u.failure?.retryAt).toBe(T0 + expectedMs)

    vi.setSystemTime(T0 + expectedMs - 1)
    await s.refresh()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    vi.setSystemTime(T0 + expectedMs)
    replies.push(good(20))
    await s.refresh()
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('an HTTP-date is honoured relative to now', async () => {
    const s = start()
    replies.push(good(12), rateLimited(new Date(T0 + 5 * 60_000).toUTCString()))
    await s.refresh()
    const u = await s.refresh()
    expect(u.failure?.retryAt).toBe(T0 + 5 * 60_000)
  })

  it('parseRetryAfter covers the grammar directly', () => {
    expect(parseRetryAfter(null, T0)).toBeNull()
    expect(parseRetryAfter('', T0)).toBeNull()
    expect(parseRetryAfter('  42 ', T0)).toBe(42_000)
    expect(parseRetryAfter('abc', T0)).toBeNull()
    expect(parseRetryAfter(new Date(T0 + 90_000).toUTCString(), T0)).toBe(90_000)
    // A date in the past means "now": zero, which the caller clamps up.
    expect(parseRetryAfter(new Date(T0 - 90_000).toUTCString(), T0)).toBe(0)
  })
})

describe('without a previous snapshot', () => {
  it('429 is still an error state, but it says it was rate limited', async () => {
    const s = start()
    replies.push(rateLimited('128'))
    const u = await s.refresh()
    expect(u).toMatchObject({ status: 'error', limits: [], email: 'me@example.test' })
    expect(u.failure).toEqual({ reason: 'rate-limited', at: T0, retryAt: T0 + 128_000 })
    await s.refresh()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('fetchUsage itself reports the rate limit', async () => {
    replies.push(rateLimited('128'))
    const u = await fetchUsage()
    expect(u).toMatchObject({ status: 'error', limits: [] })
    expect(u.failure).toMatchObject({ reason: 'rate-limited', retryAt: T0 + 128_000 })
  })
})

describe('401/403 are unchanged', () => {
  it.each([401, 403])('%i drops to unavailable, keeps nothing and gates nothing', async (status) => {
    const s = start()
    replies.push(good(12), { status })
    await s.refresh()
    const u = await s.refresh()
    expect(u).toMatchObject({ status: 'unavailable', limits: [] })
    expect(u.failure).toBeUndefined()
    replies.push(good(20))
    await s.refresh()
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })
})

describe('transient failures (5xx, network)', () => {
  it.each([
    ['500', { status: 500 } as Reply],
    ['529 overloaded', { status: 529 } as Reply],
    ['network', 'network' as Reply]
  ])('%s keeps the snapshot as stale but does not gate a forced refresh', async (_name, reply) => {
    const s = start()
    replies.push(good(12), reply)
    await s.refresh()
    vi.setSystemTime(T0 + 30_000)
    const u = await s.refresh()
    expect(u).toMatchObject({ status: 'error', updatedAt: T0 })
    expect(u.limits).toHaveLength(1)
    expect(u.failure).toEqual({ reason: 'error', at: T0 + 30_000 })
    replies.push(good(20))
    await s.refresh()
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('a 503 that names a Retry-After is honoured like a rate limit window', async () => {
    const s = start()
    replies.push(good(12), { status: 503, headers: { 'retry-after': '120' } })
    await s.refresh()
    const u = await s.refresh()
    expect(u.failure).toEqual({ reason: 'error', at: T0, retryAt: T0 + 120_000 })
    await s.refresh()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('without a previous snapshot a 500 is today’s plain error', async () => {
    const s = start()
    replies.push({ status: 500 })
    const u = await s.refresh()
    expect(u).toMatchObject({ status: 'error', limits: [] })
    expect(u.failure).toEqual({ reason: 'error', at: T0 })
  })
})
