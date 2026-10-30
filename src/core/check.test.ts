import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sanitizeCheckForTest as sanitize } from './check'
import { fakePlatform } from './platform-fake'

describe('/v1/check sanitize — update notes', () => {
  it('carries notes only together with the version they describe', () => {
    expect(sanitize({ update: { mandatory: false, notes: '- a', latestVersion: '1.2.0' } }).update).toEqual({
      minSupported: null,
      mandatory: false,
      notes: '- a',
      latestVersion: '1.2.0'
    })
    expect(sanitize({ update: { notes: '- a' } }).update).toEqual({ minSupported: null, mandatory: false })
    expect(sanitize({ update: { notes: 3, latestVersion: '1.2.0' } }).update).toEqual({
      minSupported: null,
      mandatory: false
    })
  })

  it('keeps the policy shape when the feed sends nothing', () => {
    expect(sanitize(null).update).toEqual({ minSupported: null, mandatory: false })
    expect(sanitize({ update: { minSupported: '0.5.0', mandatory: true } }).update).toEqual({
      minSupported: '0.5.0',
      mandatory: true
    })
  })

  it('caps the notes', () => {
    expect(sanitize({ update: { notes: 'x'.repeat(50_000), latestVersion: '1' } }).update.notes!.length).toBe(16 * 1024)
  })
})

// The feed is anonymous, so the backend can aim a message at paid or free users only by the plan
// the client states. Read per request and part of the cache key: an "upgrade to Pro" message
// cached as a free user must not be served for five more minutes to the same user once they pay.
describe('fetchCheck — reports the plan', () => {
  const premium = { value: false }
  let fetchMock: ReturnType<typeof vi.fn>

  const feed = (title: string, minSupported: string | null = null) =>
    new Response(JSON.stringify({ messages: [{ id: title, title }], update: { minSupported, mandatory: false } }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    })
  const paramsOf = (call: number) => new URL(String(fetchMock.mock.calls[call][0])).searchParams
  const param = (call: number, key: string) => paramsOf(call).get(key)
  const planOf = (call: number) => param(call, 'plan')
  // A fresh module graph per load (the cache is module state), so the platform must be set on the
  // SAME instance check.ts will import.
  const loadCheck = async () => {
    vi.resetModules()
    ;(await import('./platform')).initPlatform(fakePlatform())
    return import('./check')
  }

  beforeEach(() => {
    vi.doMock('./license', () => ({ isPremium: () => premium.value }))
    vi.doMock('./device-id', () => ({ getDeviceId: () => '33333333-3333-3333-3333-333333333333' }))
    vi.stubEnv('NODETERM_API_BASE', 'http://api.test')
    vi.stubEnv('DO_NOT_TRACK', '')
    vi.stubEnv('NODETERM_TELEMETRY_DISABLED', '')
    premium.value = false
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    vi.doUnmock('./license')
    vi.doUnmock('./device-id')
  })

  it('sends plan=pro for a Pro install and plan=free otherwise', async () => {
    fetchMock.mockResolvedValue(feed('x'))
    premium.value = true
    await (await loadCheck()).fetchCheck()
    expect(planOf(0)).toBe('pro')

    premium.value = false
    await (await loadCheck()).fetchCheck()
    expect(planOf(1)).toBe('free')
  })

  it('does not answer a plan change from the other plan’s cache', async () => {
    const { fetchCheck } = await loadCheck()
    fetchMock.mockResolvedValueOnce(feed('Try Pro')).mockResolvedValueOnce(feed('Thanks'))
    expect((await fetchCheck()).messages.map((m) => m.title)).toEqual(['Try Pro'])
    expect((await fetchCheck()).messages.map((m) => m.title)).toEqual(['Try Pro'])
    expect(fetchMock).toHaveBeenCalledTimes(1)

    premium.value = true
    expect((await fetchCheck()).messages.map((m) => m.title)).toEqual(['Thanks'])
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(planOf(1)).toBe('pro')
  })

  it('a failed read after a plan change keeps the update policy but not the old plan’s messages', async () => {
    const { fetchCheck } = await loadCheck()
    fetchMock.mockResolvedValueOnce(feed('Try Pro', '0.5.0')).mockRejectedValueOnce(new Error('offline'))
    await fetchCheck()
    premium.value = true
    expect(await fetchCheck()).toEqual({ messages: [], update: { minSupported: '0.5.0', mandatory: false } })
  })

  // The open-project count rides the same call, but — unlike the install count above — only while
  // the Settings → Privacy telemetry toggle is on, and only as a bare number. Its server side keeps
  // the per-install maximum (the data the project-limit allowance is computed from).
  describe('openProjects', () => {
    beforeEach(() => fetchMock.mockResolvedValue(feed('x')))

    it('sends openProjects when telemetry is on and the count is known', async () => {
      const m = await loadCheck()
      m.configureCheck({ openProjects: () => 7, telemetryEnabled: () => true })
      await m.fetchCheck()
      expect(param(0, 'openProjects')).toBe('7')
    })

    it('omits it when telemetry is off', async () => {
      const m = await loadCheck()
      m.configureCheck({ openProjects: () => 7, telemetryEnabled: () => false })
      await m.fetchCheck()
      expect(param(0, 'openProjects')).toBeNull()
    })

    it('omits it before the index is loaded', async () => {
      const m = await loadCheck()
      m.configureCheck({ openProjects: () => undefined, telemetryEnabled: () => true })
      await m.fetchCheck()
      expect(param(0, 'openProjects')).toBeNull()
    })

    it('omits it when never configured', async () => {
      const m = await loadCheck()
      await m.fetchCheck()
      expect(param(0, 'openProjects')).toBeNull()
    })

    it('omits a count that is not a non-negative integer', async () => {
      for (const n of [-1, 2.5, Number.NaN, Number.POSITIVE_INFINITY]) {
        fetchMock.mockClear()
        const m = await loadCheck()
        m.configureCheck({ openProjects: () => n, telemetryEnabled: () => true })
        await m.fetchCheck()
        expect(param(0, 'openProjects')).toBeNull()
      }
    })

    it('sends a count of zero', async () => {
      const m = await loadCheck()
      m.configureCheck({ openProjects: () => 0, telemetryEnabled: () => true })
      await m.fetchCheck()
      expect(param(0, 'openProjects')).toBe('0')
    })

    it('sends nothing else new', async () => {
      const m = await loadCheck()
      m.configureCheck({ openProjects: () => 7, telemetryEnabled: () => true })
      await m.fetchCheck()
      expect([...paramsOf(0).keys()].sort()).toEqual([
        'arch',
        'channel',
        'deviceId',
        'openProjects',
        'os',
        'plan',
        'version'
      ])
    })
  })
})
