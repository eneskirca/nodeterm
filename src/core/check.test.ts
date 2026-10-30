import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sanitizeCheckForTest as sanitize, sanitizeLimitsForTest as sanitizeLimits } from './check'
import { fakePlatform } from './platform-fake'

// The server states the open-project limit by the PRESENCE of `limits` in a successful reply. The
// latch that consumes this reads `off` as "clear", so only a missing key is an off: anything present
// that we cannot read is `unknown`, which changes nothing.
describe('/v1/check sanitize — limits', () => {
  it('reads a reply without limits as off', () => {
    expect(sanitizeLimits({ messages: [], update: { minSupported: null, mandatory: false } })).toEqual({ kind: 'off' })
    expect(sanitizeLimits({})).toEqual({ kind: 'off' })
  })

  it('reads a well-formed project limit as on, and nothing else from it', () => {
    expect(sanitizeLimits({ limits: { projects: { free: 5, epoch: 1 } } })).toEqual({ kind: 'on', free: 5, epoch: 1 })
    expect(sanitizeLimits({ limits: { projects: { free: 1, epoch: 7, extra: 'x' }, other: 1 } })).toEqual({
      kind: 'on',
      free: 1,
      epoch: 7
    })
    expect(sanitizeLimits({ limits: { projects: { free: 1000, epoch: 2 } } })).toEqual({
      kind: 'on',
      free: 1000,
      epoch: 2
    })
  })

  it('reads a present but malformed limits value as unknown', () => {
    const malformed: unknown[] = [
      null,
      true,
      'on',
      5,
      [],
      {},
      { projects: null },
      { projects: [] },
      { projects: 'on' },
      { projects: { epoch: 1 } },
      { projects: { free: 5 } },
      { projects: { free: 0, epoch: 1 } },
      { projects: { free: 1001, epoch: 1 } },
      { projects: { free: 2.5, epoch: 1 } },
      { projects: { free: '5', epoch: 1 } },
      { projects: { free: 5, epoch: 0 } },
      { projects: { free: 5, epoch: -1 } },
      { projects: { free: 5, epoch: 1.5 } },
      { projects: { free: 5, epoch: '1' } },
      { projects: { free: 5, epoch: 2 ** 53 } }
    ]
    for (const limits of malformed) {
      expect(sanitizeLimits({ limits }), JSON.stringify(limits)).toEqual({ kind: 'unknown' })
    }
  })

  it('reads a body that is not a JSON object as unknown, never off', () => {
    for (const body of [null, undefined, 'ok', 3, true, [], [{ limits: null }]]) {
      expect(sanitizeLimits(body), JSON.stringify(body)).toEqual({ kind: 'unknown' })
    }
  })
})

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

  // The project-limit latch (core/project-limit.ts) clears on `off`, so an answer may come only from
  // a read the server actually made: a blocked network, a rate limit or a captive portal must never
  // be able to say "off". The failure bodies below are JSON WITHOUT `limits` on purpose — read past
  // their status, each would be exactly that misfired off.
  describe('onCheckAnswer', () => {
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
    const limitsFeed = (free: number, epoch: number) =>
      json({ messages: [], update: { minSupported: null, mandatory: false }, limits: { projects: { free, epoch } } })
    const T0 = Date.UTC(2026, 9, 30, 12)

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(T0)
    })
    afterEach(() => vi.useRealTimers())

    it('answers only on a 2xx JSON read', async () => {
      const failures: Array<[string, () => Promise<Response>]> = [
        ['500', async () => json({ error: 'internal' }, 500)],
        ['429', async () => json({ error: 'rate_limited' }, 429)],
        ['thrown fetch', async () => Promise.reject(new TypeError('fetch failed'))],
        [
          '200 text/html',
          async () =>
            new Response('<html><body>Sign in to the network</body></html>', {
              status: 200,
              headers: { 'content-type': 'text/html' }
            })
        ]
      ]
      for (const [label, respond] of failures) {
        fetchMock.mockReset().mockImplementation(respond)
        const m = await loadCheck()
        const listener = vi.fn()
        m.onCheckAnswer(listener)
        expect(await m.fetchCheck(), label).toEqual({ messages: [], update: { minSupported: null, mandatory: false } })
        expect(fetchMock, label).toHaveBeenCalledTimes(1)
        expect(listener, label).not.toHaveBeenCalled()
      }
    })

    it('does not answer from the failure fallback of an earlier good read', async () => {
      const m = await loadCheck()
      const listener = vi.fn()
      m.onCheckAnswer(listener)
      fetchMock.mockResolvedValueOnce(limitsFeed(5, 1)).mockResolvedValueOnce(json({ error: 'internal' }, 500))
      await m.fetchCheck()
      expect(listener).toHaveBeenCalledTimes(1)

      vi.setSystemTime(T0 + 6 * 60 * 1000)
      await m.fetchCheck()
      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(listener).toHaveBeenCalledTimes(1)
    })

    it('a 2xx without limits answers off once', async () => {
      fetchMock.mockResolvedValue(feed('x'))
      const m = await loadCheck()
      const listener = vi.fn()
      m.onCheckAnswer(listener)
      await m.fetchCheck()
      expect(listener.mock.calls).toEqual([[{ kind: 'off' }]])
    })

    it('a 2xx with limits answers on, and fetchCheck still returns only messages and update', async () => {
      fetchMock.mockResolvedValue(limitsFeed(5, 3))
      const m = await loadCheck()
      const listener = vi.fn()
      m.onCheckAnswer(listener)
      expect(await m.fetchCheck()).toEqual({ messages: [], update: { minSupported: null, mandatory: false } })
      expect(listener.mock.calls).toEqual([[{ kind: 'on', free: 5, epoch: 3 }]])
    })

    it('a 2xx with a malformed limits value answers unknown', async () => {
      fetchMock.mockResolvedValue(json({ messages: [], update: {}, limits: { projects: { free: 0, epoch: 1 } } }))
      const m = await loadCheck()
      const listener = vi.fn()
      m.onCheckAnswer(listener)
      await m.fetchCheck()
      expect(listener.mock.calls).toEqual([[{ kind: 'unknown' }]])
    })

    it('a cache hit within 5 min does not answer again; the next network read does', async () => {
      fetchMock.mockImplementation(async () => limitsFeed(5, 1))
      const m = await loadCheck()
      const listener = vi.fn()
      m.onCheckAnswer(listener)
      await m.fetchCheck()
      vi.setSystemTime(T0 + 4 * 60 * 1000)
      await m.fetchCheck()
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(listener).toHaveBeenCalledTimes(1)

      vi.setSystemTime(T0 + 6 * 60 * 1000)
      await m.fetchCheck()
      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(listener).toHaveBeenCalledTimes(2)
    })

    it('does not answer when the feed is not allowed to run', async () => {
      vi.stubEnv('DO_NOT_TRACK', '1')
      const m = await loadCheck()
      const listener = vi.fn()
      m.onCheckAnswer(listener)
      await m.fetchCheck()
      expect(fetchMock).not.toHaveBeenCalled()
      expect(listener).not.toHaveBeenCalled()
    })

    it('a listener that throws does not break fetchCheck or the other listeners', async () => {
      fetchMock.mockResolvedValue(feed('x'))
      const m = await loadCheck()
      const after = vi.fn()
      m.onCheckAnswer(() => {
        throw new Error('listener bug')
      })
      m.onCheckAnswer(after)
      expect((await m.fetchCheck()).messages.map((x) => x.title)).toEqual(['x'])
      expect(after.mock.calls).toEqual([[{ kind: 'off' }]])
      // The read was good: it is cached like any other, not retried as a failure.
      await m.fetchCheck()
      expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    it('stops answering a listener once unsubscribed', async () => {
      fetchMock.mockImplementation(async () => feed('x'))
      const m = await loadCheck()
      const listener = vi.fn()
      const off = m.onCheckAnswer(listener)
      await m.fetchCheck()
      off()
      vi.setSystemTime(T0 + 6 * 60 * 1000)
      await m.fetchCheck()
      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(listener).toHaveBeenCalledTimes(1)
    })
  })
})
