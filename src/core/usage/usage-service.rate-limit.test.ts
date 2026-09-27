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
    // usageCredsPaths joins with the NATIVE path module, so on Windows the requested path is
    // backslash-separated; fixture keys are written POSIX-style and the lookup normalizes.
    const raw = files[String(file).replace(/\\/g, '/')]
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

  it('compares every later failure with the identity the NUMBERS came from (A → unknown → B)', async () => {
    const orgFile = (uuid: string) => JSON.stringify({ oauthAccount: {
      emailAddress: 'me@example.test', organizationName: uuid, organizationUuid: uuid } })
    const s = start()
    files['/fixture-home/.claude.json'] = orgFile('org-A')
    replies.push(good(12))
    await s.refresh()
    // Second read: org metadata unreadable — nothing proves a switch, so A's numbers stay.
    delete files['/fixture-home/.claude.json']
    replies.push({ status: 500 })
    const mid = await s.refresh()
    expect(mid.limits).toHaveLength(1)
    expect(mid.organization).toBeUndefined()
    // Third read identifies org B: A's numbers must not be shown under B.
    files['/fixture-home/.claude.json'] = orgFile('org-B')
    replies.push({ status: 500 })
    const u = await s.refresh()
    expect(u.limits).toEqual([])
    expect(u.organization?.uuid).toBe('org-B')
    // …and once dropped, a later failure in B has nothing of A's to resurrect.
    replies.push({ status: 500 })
    expect((await s.refresh()).limits).toEqual([])
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

describe('the window starts when the response ARRIVES', () => {
  it('a slow 429 does not lose its elapsed time; updatedAt keeps its meaning', async () => {
    const s = start()
    replies.push(good(12))
    await s.refresh()
    // The next request takes 7 s to answer: credentials read at T0+60s, response at T0+67s.
    vi.setSystemTime(T0 + 60_000)
    fetchMock.mockImplementationOnce(async () => {
      vi.setSystemTime(T0 + 67_000)
      return new Response('{}', { status: 429, headers: { 'retry-after': '60' } })
    })
    const u = await s.refresh()
    expect(u.failure).toEqual({ reason: 'rate-limited', at: T0 + 67_000, retryAt: T0 + 127_000 })
    expect(u.updatedAt).toBe(T0)
    // 53 s after the response (the old, too-early deadline) is still inside the window.
    vi.setSystemTime(T0 + 120_000)
    await s.refresh()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    vi.setSystemTime(T0 + 127_000)
    replies.push(good(20))
    await s.refresh()
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('a slow 503 with Retry-After is measured from its arrival too', async () => {
    const s = start()
    fetchMock.mockImplementationOnce(async () => {
      vi.setSystemTime(T0 + 7_000)
      return new Response('{}', { status: 503, headers: { 'retry-after': '120' } })
    })
    const u = await s.refresh()
    expect(u.failure).toEqual({ reason: 'error', at: T0 + 7_000, retryAt: T0 + 127_000 })
    expect(u.updatedAt).toBe(T0)
  })

  it('a network failure is stamped when it happened', async () => {
    const s = start()
    fetchMock.mockImplementationOnce(async () => {
      vi.setSystemTime(T0 + 8_000)
      throw new TypeError('fetch failed')
    })
    const u = await s.refresh()
    expect(u.failure).toEqual({ reason: 'error', at: T0 + 8_000 })
  })

  it('an HTTP-date is measured against the arrival clock', async () => {
    const s = start()
    fetchMock.mockImplementationOnce(async () => {
      vi.setSystemTime(T0 + 7_000)
      return new Response('{}', { status: 429, headers: { 'retry-after': new Date(T0 + 5 * 60_000).toUTCString() } })
    })
    const u = await s.refresh()
    expect(u.failure?.retryAt).toBe(T0 + 5 * 60_000)
  })
})

describe('identity changes inside the window', () => {
  const orgFile = (uuid: string) => JSON.stringify({ oauthAccount: {
    emailAddress: 'me@example.test', organizationName: uuid, organizationUuid: uuid } })

  it('a logout during the window answers unavailable at once, without the endpoint', async () => {
    const s = start()
    replies.push(good(12), rateLimited('3600'))
    await s.refresh()
    await s.refresh()
    delete files['/fixture-home/.claude/.credentials.json']
    const u = await s.refresh()
    expect(u).toMatchObject({ status: 'unavailable', limits: [] })
    expect(u.failure).toBeUndefined()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    // The window went with the login: signing back in reads straight away.
    files['/fixture-home/.claude/.credentials.json'] = creds('me@example.test')
    replies.push(good(20))
    expect(await s.refresh()).toMatchObject({ status: 'ok', session: { leftPercent: 80 } })
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('another email during the window reads for the new login, never showing the old bars', async () => {
    const s = start()
    replies.push(good(12), rateLimited('3600'))
    await s.refresh()
    await s.refresh()
    files['/fixture-home/.claude/.credentials.json'] = creds('other@example.test')
    replies.push(rateLimited('3600'))
    const u = await s.refresh()
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(u).toMatchObject({ status: 'error', limits: [], email: 'other@example.test' })
  })

  it('another organization during the window reads again, never showing the old org’s bars', async () => {
    files['/fixture-home/.claude.json'] = orgFile('org-A')
    const s = start()
    replies.push(good(12), rateLimited('3600'))
    await s.refresh()
    await s.refresh()
    files['/fixture-home/.claude.json'] = orgFile('org-B')
    replies.push({ status: 500 })
    const u = await s.refresh()
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(u.limits).toEqual([])
    expect(u.organization?.uuid).toBe('org-B')
  })

  it('ordinary reads (IPC fetch) see a logout inside the window, without the network', async () => {
    const s = start()
    replies.push(good(12), rateLimited('3600'))
    await s.refresh()
    await s.refresh()
    delete files['/fixture-home/.claude/.credentials.json']
    vi.setSystemTime(T0 + 6 * 60_000)
    const u = await ipcFetch()
    expect(u).toMatchObject({ status: 'unavailable', limits: [], email: null })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('the focus refresh sees a logout inside the window, without the network', async () => {
    const s = start()
    replies.push(good(12), rateLimited('3600'))
    await s.refresh()
    await s.refresh()
    delete files['/fixture-home/.claude/.credentials.json']
    vi.setSystemTime(T0 + 6 * 60_000)
    s.refreshIfStale()
    await vi.advanceTimersByTimeAsync(0)
    expect(s.snapshot()[0].usage).toMatchObject({ status: 'unavailable', limits: [] })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('an IPC fetch inside the window reads for a switched email instead of serving the old bars', async () => {
    const s = start()
    replies.push(good(12), rateLimited('3600'))
    await s.refresh()
    await s.refresh()
    files['/fixture-home/.claude/.credentials.json'] = creds('other@example.test')
    vi.setSystemTime(T0 + 6 * 60_000)
    replies.push(good(50))
    expect(await ipcFetch()).toMatchObject({ status: 'ok', email: 'other@example.test', session: { leftPercent: 50 } })
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('an unchanged login inside the window is still answered from the cache', async () => {
    const s = start()
    replies.push(good(12), rateLimited('3600'))
    await s.refresh()
    await s.refresh()
    vi.setSystemTime(T0 + 6 * 60_000)
    expect((await ipcFetch()).limits).toHaveLength(1)
    s.refreshIfStale()
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('the same identity with its org metadata gone stays gated (unknown proves nothing)', async () => {
    files['/fixture-home/.claude.json'] = orgFile('org-A')
    const s = start()
    replies.push(good(12), rateLimited('3600'))
    await s.refresh()
    await s.refresh()
    delete files['/fixture-home/.claude.json']
    expect((await s.refresh()).limits).toHaveLength(1)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})

describe('the read the window promised', () => {
  it('fires once at retryAt when the app is being looked at', async () => {
    const s = start()
    replies.push(good(12), rateLimited('128'))
    await s.refresh()
    await s.refresh()
    polling = true
    // Calls inside the window neither fetch nor add wakes.
    await s.refresh()
    await s.refresh()
    await vi.advanceTimersByTimeAsync(127_999)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    replies.push(good(30))
    await vi.advanceTimersByTimeAsync(1)
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(s.snapshot()[0].usage).toMatchObject({ status: 'ok', session: { leftPercent: 70 } })
    const pushed = platform.sent.filter((m) => m.channel === IPC.usageUpdate).at(-1)?.args[0] as ClaudeUsage
    expect(pushed.status).toBe('ok')
    // Nothing further is armed after the success.
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('a shut poll gate skips the wake; the 5-minute debounce does not outlive the window', async () => {
    const s = start()
    replies.push(good(12), rateLimited('128'))
    await s.refresh()
    await s.refresh()
    await vi.advanceTimersByTimeAsync(130_000)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    // 130 s after the failure is well inside REFETCH_DEBOUNCE_MS, but the window has ended.
    replies.push(good(30))
    expect(await ipcFetch()).toMatchObject({ status: 'ok' })
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('the focus refresh reads once the window has ended', async () => {
    const s = start()
    replies.push(good(12), rateLimited('128'))
    await s.refresh()
    await s.refresh()
    s.refreshIfStale()
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    vi.setSystemTime(T0 + 128_000)
    replies.push(good(30))
    s.refreshIfStale()
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('dispose cancels a pending wake', async () => {
    const s = start()
    replies.push(good(12), rateLimited('128'))
    await s.refresh()
    await s.refresh()
    polling = true
    s.dispose()
    service = undefined
    await vi.advanceTimersByTimeAsync(200_000)
    expect(fetchMock).toHaveBeenCalledTimes(2)
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
