import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import crypto from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { promises as fsp } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { IPC } from '../shared/ipc'
import type { LicenseDetail, LicenseStatus } from '../shared/types'

// One temp userData dir per run; hoisted so the entitlement-key mock factory can see it.
const h = vi.hoisted(() => ({
  userData: '',
  publicKeyPem: ''
}))

vi.mock('./entitlement-key', () => ({
  get ENTITLEMENT_PUBLIC_KEY() {
    return h.publicKeyPem
  }
}))

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')
h.publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString()

/** Mint a token the same way the server does: base64url(payload).base64url(sig).
 * `seats` is included only when provided, so an old token (no seats field) can be simulated. */
function mint(ttlSeconds: number, deviceId = 'test-device', seats?: number): string {
  const payload = Buffer.from(
    JSON.stringify({
      deviceId,
      tier: 'pro',
      licenseId: 'lic_test',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + ttlSeconds,
      ...(seats !== undefined ? { seats } : {})
    })
  ).toString('base64url')
  const sig = crypto.sign(null, Buffer.from(payload), privateKey).toString('base64url')
  return `${payload}.${sig}`
}

function jsonResponse(body: unknown): { ok: boolean; status: number; json: () => Promise<unknown> } {
  return { ok: true, status: 200, json: async () => body }
}

const HOUR = 60 * 60 * 1000

/**
 * Await the refresh initLicense() actually started (launch + anything the 6h interval fired),
 * via the handle license.ts parks it on. This used to be a bounded `flush()` of timed sleeps, and
 * a loaded CI runner beat it: the assertions saw zero broadcasts, and the continuation then landed
 * after afterEach's resetPlatformForTests() and threw with nobody awaiting. There is no timing
 * guess left here — the refresh is awaited, so it is also guaranteed done before teardown.
 * Resolves against the post-resetModules instance the test itself imported.
 */
async function refreshed(): Promise<void> {
  const { __licenseRefreshesForTests } = await import('./license')
  await __licenseRefreshesForTests()
}

describe('license entitlement refresh', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  let fake: import('./platform-fake').FakePlatform

  // The licenseChanged statuses broadcast so far (fake.sent records {to, channel, args}).
  const sent = (): LicenseStatus[] =>
    fake.sent.filter((s) => s.channel === IPC.licenseChanged).map((s) => s.args[0] as LicenseStatus)

  beforeEach(async () => {
    // Only the refresh interval and the clock are faked: fetch/fs promises and the
    // 8s abort timers stay on the real event loop so awaits actually settle.
    vi.useFakeTimers({ toFake: ['setInterval', 'Date'] })
    h.userData = mkdtempSync(path.join(tmpdir(), 'nt-license-test-'))
    // Pin this "machine"'s device id so minted tokens match it (device-bound verification).
    writeFileSync(path.join(h.userData, 'device-id'), 'test-device')
    delete process.env.DO_NOT_TRACK
    delete process.env.NODETERM_TELEMETRY_DISABLED
    process.env.NODETERM_API_BASE = 'http://127.0.0.1:1'
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    vi.resetModules()
    // device-id (imported transitively by license) reads userData through the core platform,
    // so point the fake at this run's temp dir. Init on the post-reset module graph the
    // dynamic `import('./license')` below will resolve against.
    const { initPlatform } = await import('./platform')
    const { fakePlatform } = await import('./platform-fake')
    fake = fakePlatform({ userDataDir: h.userData, isPackaged: false })
    initPlatform(fake)
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
    const { resetPlatformForTests } = await import('./platform')
    resetPlatformForTests()
    rmSync(h.userData, { recursive: true, force: true })
  })

  it('launch refresh (device-bound) stores the minted token and broadcasts Pro', async () => {
    const token = mint(7 * 24 * 60 * 60)
    fetchMock.mockResolvedValue(jsonResponse({ active: true, token }))
    const { initLicense } = await import('./license')
    initLicense()
    await refreshed()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(sent().length).toBe(1)
    expect(sent()[0].active).toBe(true)
    expect(sent()[0].tier).toBe('pro')
  })

  it('keeps refreshing periodically so a mid-session token expiry re-mints instead of dropping Pro', async () => {
    // Server hands out short-lived tokens (7d in prod); simulate one that expires
    // within the session, then a re-mint on the next poll.
    fetchMock.mockImplementation(async () =>
      jsonResponse({ active: true, token: mint(7 * 24 * 60 * 60) })
    )
    const { initLicense } = await import('./license')
    initLicense()
    await refreshed()
    expect(fetchMock).toHaveBeenCalledTimes(1)

    // A day passes in-session: the app must have polled again on its own —
    // launch-only refresh means the token silently expires after 7 days.
    await vi.advanceTimersByTimeAsync(24 * HOUR)
    await refreshed()
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2)
    const last = sent().at(-1)!
    expect(last.active).toBe(true)
  })

  it('a periodic refresh that finds the device revoked drops Pro mid-session', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ active: true, token: mint(7 * 24 * 60 * 60) })
    )
    const { initLicense } = await import('./license')
    initLicense()
    await refreshed()
    expect(sent().at(-1)!.active).toBe(true)

    // From now on the server says: not entitled (canceled subscription).
    fetchMock.mockResolvedValue(jsonResponse({ active: false }))
    await vi.advanceTimersByTimeAsync(24 * HOUR)
    await refreshed()
    expect(sent().at(-1)!.active).toBe(false)
  })

  // A status read that did not run is not a cancellation. The server rate-limits 30/min per IP
  // (a few users behind one NAT, or the Upgrade screen's 4s poll, is enough to trip it) and relays a
  // keygen outage as an error; either used to delete a still-valid 7-day token on the spot.
  it.each([
    ['a 429 from the rate limiter', { ok: false, status: 429, json: async () => ({ error: 'rate_limited' }) }],
    ['a keygen outage relayed as 502', { ok: false, status: 502, json: async () => ({ error: 'unavailable' }) }],
    ['a 5xx with no body', { ok: false, status: 503, json: async () => { throw new Error('not json') } }],
    ['a 2xx that states nothing', { ok: true, status: 200, json: async () => ({}) }]
  ])('a periodic refresh that gets %s keeps Pro and the stored token', async (_label, reply) => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ active: true, token: mint(7 * 24 * 60 * 60) })
    )
    const { initLicense } = await import('./license')
    initLicense()
    await refreshed()
    expect(sent().at(-1)!.active).toBe(true)

    fetchMock.mockResolvedValue(reply)
    await vi.advanceTimersByTimeAsync(24 * HOUR)
    await refreshed()
    expect(sent().at(-1)!.active).toBe(true)
    const onDisk = JSON.parse(readFileSync(path.join(h.userData, 'license.json'), 'utf8')) as { token?: string }
    expect(onDisk.token).toBeTruthy()
  })

  it('rejects a token minted for a different device (copied license.json)', async () => {
    // Simulates copying license.json + a foreign token onto this machine.
    fetchMock.mockResolvedValue(
      jsonResponse({ active: true, token: mint(7 * 24 * 60 * 60, 'other-device') })
    )
    const { initLicense } = await import('./license')
    initLicense()
    await refreshed()

    expect(sent().length).toBeGreaterThan(0)
    expect(sent().at(-1)!.active).toBe(false)
  })

  it('broadcasts even when the refresh lands long after a bounded flush would have given up', async () => {
    // Regression for a CI flake that reddened unrelated PRs. initLicense() starts refresh()
    // UN-AWAITED; the assertions above used to race it with ~75 ms of timed sleeps, and a loaded
    // runner won: `sent()` was still empty (`expected 0 to be greater than 0`) and the
    // continuation then landed after afterEach had run resetPlatformForTests(), so broadcast() →
    // platform() threw with nobody awaiting — an unhandled rejection, which fails the whole file.
    // Here the response deliberately lands 300 ms in, i.e. past ANY flush budget, so the ordering
    // the flake needs is forced rather than hoped for. Passing means the assertion is awaiting the
    // real refresh, not a timeout.
    fetchMock.mockImplementation(
      async () =>
        await new Promise((r) =>
          setTimeout(() => r(jsonResponse({ active: true, token: mint(7 * 24 * 60 * 60) })), 300)
        )
    )
    const { initLicense } = await import('./license')
    initLicense()
    await refreshed()

    expect(sent().length).toBe(1)
    expect(sent()[0].active).toBe(true)
  })

  it('does not revive an expired token when the system clock is rolled back', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ active: true, token: mint(7 * 24 * 60 * 60) })
    )
    const { initLicense } = await import('./license')
    initLicense()
    await refreshed()
    expect(sent().at(-1)!.active).toBe(true)

    // Server unreachable from now on (offline grace path), and the token expires in-session.
    fetchMock.mockRejectedValue(new Error('offline'))
    await vi.advanceTimersByTimeAsync(7 * 24 * HOUR + 12 * HOUR)
    await refreshed()

    // Attacker rolls the clock back before the expiry: exp is "in the future" again,
    // but the app has already observed a later time — the token must stay dead.
    vi.setSystemTime(Date.now() - 9 * 24 * HOUR)
    const status = (await fake.handlers[IPC.licenseStatus]()) as LicenseStatus
    expect(status.active).toBe(false)
  })

  it('a slow early write cannot walk the clock anchor backwards past a later one', async () => {
    // Regression for the SECOND flake in this file (it made the rollback test above fail ~4 runs
    // in 15 on a loaded box). bumpLastSeen is a read-modify-write of license.json, and the refresh
    // runs used to be started independently, so a burst of them — which is what advancing days of
    // fake time produces — could have an OLDER lastSeen write complete LAST and walk the anchor
    // backwards. That is precisely what the anchor exists to prevent.
    //
    // Forced deterministically here: the first two writes of the periodic burst take 200 ms while
    // every later one is immediate. Runs that overlap therefore ALWAYS finish out of order (an
    // early, small lastSeen lands last); runs that are queued cannot overlap at all, so the delay
    // only slows the chain down and the newest value still lands last.
    let slowWrites = 0
    const realWrite = fsp.writeFile.bind(fsp)
    const writeSpy = vi
      .spyOn(fsp, 'writeFile')
      .mockImplementation(async (...args: Parameters<typeof fsp.writeFile>) => {
        if (slowWrites > 0) {
          slowWrites--
          await new Promise((r) => setTimeout(r, 200))
        }
        return realWrite(...args)
      })
    try {
      fetchMock.mockResolvedValueOnce(jsonResponse({ active: true, token: mint(7 * 24 * 60 * 60) }))
      const { initLicense } = await import('./license')
      initLicense()
      await refreshed()

      fetchMock.mockRejectedValue(new Error('offline'))
      slowWrites = 2 // …i.e. the first two of the burst below, nothing the launch refresh wrote
      await vi.advanceTimersByTimeAsync(7 * 24 * HOUR + 12 * HOUR)
      await refreshed()

      // The anchor must hold the LARGEST time observed, whatever order the writes completed in.
      const stored = JSON.parse(readFileSync(path.join(h.userData, 'license.json'), 'utf-8')) as {
        lastSeen?: number
      }
      expect(stored.lastSeen).toBe(Math.floor(Date.now() / 1000))

      vi.setSystemTime(Date.now() - 9 * 24 * HOUR)
      const status = (await fake.handlers[IPC.licenseStatus]()) as LicenseStatus
      expect(status.active).toBe(false)
    } finally {
      writeSpy.mockRestore()
    }
  })
})

describe('license seats entitlement', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  let fake: import('./platform-fake').FakePlatform

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'Date'] })
    h.userData = mkdtempSync(path.join(tmpdir(), 'nt-license-seats-'))
    writeFileSync(path.join(h.userData, 'device-id'), 'test-device')
    delete process.env.DO_NOT_TRACK
    delete process.env.NODETERM_TELEMETRY_DISABLED
    process.env.NODETERM_API_BASE = 'http://127.0.0.1:1'
    // Reject any refresh call → offline grace keeps the stored token intact for the assertions.
    fetchMock = vi.fn().mockRejectedValue(new Error('offline'))
    vi.stubGlobal('fetch', fetchMock)
    vi.resetModules()
    const { initPlatform } = await import('./platform')
    const { fakePlatform } = await import('./platform-fake')
    fake = fakePlatform({ userDataDir: h.userData, isPackaged: false })
    initPlatform(fake)
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
    const { resetPlatformForTests } = await import('./platform')
    resetPlatformForTests()
    rmSync(h.userData, { recursive: true, force: true })
  })

  function storeToken(token?: string): void {
    writeFileSync(path.join(h.userData, 'license.json'), JSON.stringify({ token }))
  }

  it('a premium token carrying seats:5 surfaces seats 5', async () => {
    storeToken(mint(7 * 24 * 60 * 60, 'test-device', 5))
    const { initLicense, licensedSeats } = await import('./license')
    initLicense()
    await refreshed()
    const status = (await fake.handlers[IPC.licenseStatus]()) as LicenseStatus
    expect(status.active).toBe(true)
    expect(status.seats).toBe(5)
    expect(licensedSeats()).toBe(5)
  })

  it('a premium token with no seats field defaults to the 3 free Pro seats', async () => {
    storeToken(mint(7 * 24 * 60 * 60))
    const { initLicense, licensedSeats } = await import('./license')
    initLicense()
    await refreshed()
    const status = (await fake.handlers[IPC.licenseStatus]()) as LicenseStatus
    expect(status.active).toBe(true)
    expect(status.seats).toBe(3) // Pro includes 3 seats; existing tokens get them with no re-mint
    expect(licensedSeats()).toBe(3)
  })

  it('a premium token below the free baseline is floored to the 3 free Pro seats', async () => {
    storeToken(mint(7 * 24 * 60 * 60, 'test-device', 2))
    const { initLicense, licensedSeats } = await import('./license')
    initLicense()
    await refreshed()
    const status = (await fake.handlers[IPC.licenseStatus]()) as LicenseStatus
    expect(status.seats).toBe(3) // never fewer than the 3 included with Pro
    expect(licensedSeats()).toBe(3)
  })

  it('an absent / non-premium token has 0 seats', async () => {
    storeToken(undefined)
    const { initLicense, licensedSeats } = await import('./license')
    initLicense()
    await refreshed()
    const status = (await fake.handlers[IPC.licenseStatus]()) as LicenseStatus
    expect(status.active).toBe(false)
    expect(status.seats).toBe(0)
    expect(licensedSeats()).toBe(0)
  })

  it('an expired token is not premium and has 0 seats', async () => {
    storeToken(mint(-60, 'test-device', 5))
    const { initLicense, licensedSeats } = await import('./license')
    initLicense()
    await refreshed()
    const status = (await fake.handlers[IPC.licenseStatus]()) as LicenseStatus
    expect(status.active).toBe(false)
    expect(status.seats).toBe(0)
    expect(licensedSeats()).toBe(0)
  })

  it('upgrade opens the base Pro link by default and the add-seats link for target "seats"', async () => {
    process.env.NODETERM_CHECKOUT_URL = 'https://pay.test/pro'
    process.env.NODETERM_SEATS_CHECKOUT_URL = 'https://pay.test/seats'
    try {
      const { initLicense } = await import('./license')
      initLicense()
      await refreshed() // the launch refresh (rejecting → offline grace) is awaited, never raced
      await fake.handlers[IPC.licenseUpgrade]() // default → base Pro
      await fake.handlers[IPC.licenseUpgrade]('seats') // add-seats link
      // Each carries this device's id for the device-bound webhook binding.
      expect(fake.opened).toEqual([
        'https://pay.test/pro?client_reference_id=test-device',
        'https://pay.test/seats?client_reference_id=test-device'
      ])
    } finally {
      delete process.env.NODETERM_CHECKOUT_URL
      delete process.env.NODETERM_SEATS_CHECKOUT_URL
    }
  })

  it('the add-seats link uses its own built-in URL when the env override is unset', async () => {
    process.env.NODETERM_CHECKOUT_URL = 'https://pay.test/pro'
    delete process.env.NODETERM_SEATS_CHECKOUT_URL
    try {
      const { initLicense } = await import('./license')
      initLicense()
      await refreshed() // the launch refresh (rejecting → offline grace) is awaited, never raced
      await fake.handlers[IPC.licenseUpgrade]('seats')
      // 'seats' opens the dedicated seats Payment Link — NOT the base Pro link — with the deviceId.
      const opened = fake.opened[0]
      expect(opened).not.toContain('pay.test/pro')
      expect(opened).toContain('buy.stripe.com/')
      expect(opened).toContain('client_reference_id=test-device')
    } finally {
      delete process.env.NODETERM_CHECKOUT_URL
    }
  })
})

describe('license subscription term (issue #800)', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  let fake: import('./platform-fake').FakePlatform
  const sent = (): LicenseStatus[] =>
    fake.sent.filter((s) => s.channel === IPC.licenseChanged).map((s) => s.args[0] as LicenseStatus)
  const status = (): Promise<LicenseStatus> =>
    fake.handlers[IPC.licenseStatus]() as Promise<LicenseStatus>
  const stored = (): { token?: string; termEndsAt?: number } =>
    JSON.parse(readFileSync(path.join(h.userData, 'license.json'), 'utf-8'))

  const WEEK_S = 7 * 24 * 60 * 60
  /** A yearly App Store term: what the reporter bought, ~51 weeks past the token's own expiry. */
  const yearly = (): number => Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'Date'] })
    h.userData = mkdtempSync(path.join(tmpdir(), 'nt-license-term-'))
    writeFileSync(path.join(h.userData, 'device-id'), 'test-device')
    delete process.env.DO_NOT_TRACK
    delete process.env.NODETERM_TELEMETRY_DISABLED
    process.env.NODETERM_API_BASE = 'http://127.0.0.1:1'
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    vi.resetModules()
    const { initPlatform } = await import('./platform')
    const { fakePlatform } = await import('./platform-fake')
    fake = fakePlatform({ userDataDir: h.userData, isPackaged: false })
    initPlatform(fake)
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
    const { resetPlatformForTests } = await import('./platform')
    resetPlatformForTests()
    rmSync(h.userData, { recursive: true, force: true })
  })

  it('a reply with no term states NONE — the token expiry is never promoted to one', async () => {
    // Exactly what every server in the field answers today: token + its own 7-day expiresAt.
    const token = mint(WEEK_S)
    fetchMock.mockResolvedValue(
      jsonResponse({ active: true, token, tier: 'pro', expiresAt: Math.floor(Date.now() / 1000) + WEEK_S })
    )
    const { initLicense } = await import('./license')
    initLicense()
    await refreshed()

    expect(sent().at(-1)!.active).toBe(true)
    expect(sent().at(-1)!.termEndsAt).toBeNull()
    expect((await status()).termEndsAt).toBeNull()
  })

  it('carries the stated term beside the token, persists it, and keeps it through offline grace', async () => {
    const term = yearly()
    fetchMock.mockResolvedValue(jsonResponse({ active: true, token: mint(WEEK_S), termEndsAt: term }))
    const { initLicense } = await import('./license')
    initLicense()
    await refreshed()

    expect(sent().at(-1)!.termEndsAt).toBe(term)
    expect(stored().termEndsAt).toBe(term)
    // …and the token's expiry stays what it is: the grace window, not the term.
    expect(sent().at(-1)!.expiresAt).toBeLessThan(term)

    fetchMock.mockRejectedValue(new Error('offline'))
    await vi.advanceTimersByTimeAsync(6 * HOUR)
    await refreshed()
    expect(sent().at(-1)!.active).toBe(true)
    expect(sent().at(-1)!.termEndsAt).toBe(term)
  })

  it('a later reply without a term clears the old one — a term belongs to its token', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ active: true, token: mint(WEEK_S), termEndsAt: yearly() }))
    const { initLicense } = await import('./license')
    initLicense()
    await refreshed()
    expect(stored().termEndsAt).toBeTypeOf('number')

    fetchMock.mockResolvedValue(jsonResponse({ active: true, token: mint(WEEK_S) }))
    await vi.advanceTimersByTimeAsync(6 * HOUR)
    await refreshed()
    expect(sent().at(-1)!.termEndsAt).toBeNull()
    expect(stored().termEndsAt).toBeUndefined()
  })

  it.each([
    ['null (a lifetime entitlement)', null],
    ['zero', 0],
    ['negative', -5],
    ['a string', '2027-09-13'],
    ['NaN-ish', 'NaN']
  ])('a term that is %s reads as no term, never as a date', async (_label, termEndsAt) => {
    fetchMock.mockResolvedValue(jsonResponse({ active: true, token: mint(WEEK_S), termEndsAt }))
    const { initLicense } = await import('./license')
    initLicense()
    await refreshed()
    expect(sent().at(-1)!.active).toBe(true)
    expect(sent().at(-1)!.termEndsAt).toBeNull()
    expect((await status()).termEndsAt).toBeNull()
  })

  it('a device the server no longer entitles loses its term with its token', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ active: true, token: mint(WEEK_S), termEndsAt: yearly() }))
    const { initLicense } = await import('./license')
    initLicense()
    await refreshed()

    fetchMock.mockResolvedValue(jsonResponse({ active: false }))
    await vi.advanceTimersByTimeAsync(6 * HOUR)
    await refreshed()
    expect(sent().at(-1)!.termEndsAt).toBeNull()
    expect(stored().termEndsAt).toBeUndefined()
  })
})

describe('license detail + release', () => {
  let fake: import('./platform-fake').FakePlatform

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'Date'] })
    h.userData = mkdtempSync(path.join(tmpdir(), 'nt-license-detail-'))
    writeFileSync(path.join(h.userData, 'device-id'), 'test-device')
    delete process.env.DO_NOT_TRACK
    delete process.env.NODETERM_TELEMETRY_DISABLED
    process.env.NODETERM_API_BASE = 'http://127.0.0.1:1'
    // The launch refresh must not succeed here: rejecting it keeps the stored token intact
    // (offline grace) so every assertion below runs against the token the test wrote.
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
    vi.resetModules()
    const { initPlatform } = await import('./platform')
    const { fakePlatform } = await import('./platform-fake')
    fake = fakePlatform({ userDataDir: h.userData, isPackaged: false })
    initPlatform(fake)
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
    const { resetPlatformForTests } = await import('./platform')
    resetPlatformForTests()
    delete process.env.DO_NOT_TRACK
    rmSync(h.userData, { recursive: true, force: true })
  })

  const TOKEN = mint(HOUR / 1000)

  function storeToken(token = TOKEN): void {
    writeFileSync(path.join(h.userData, 'license.json'), JSON.stringify({ token }))
  }

  /** Non-2xx reply shaped like our API's error bodies. */
  function errorResponse(status: number, body: unknown): {
    ok: boolean
    status: number
    json: () => Promise<unknown>
  } {
    return { ok: false, status, json: async () => body }
  }

  /**
   * Boot the service, let its launch refresh SETTLE, and only then install the fetch mock the
   * assertions are about. initLicense() fires an un-awaited refresh; installing the mock first
   * would make `mock.calls[0]` that refresh — so a handler that never called fetch at all could
   * still satisfy a "the request carried X" assertion.
   */
  async function boot(fetchMock: ReturnType<typeof vi.fn>): Promise<void> {
    const { initLicense } = await import('./license')
    initLicense()
    await refreshed()
    vi.stubGlobal('fetch', fetchMock)
  }

  const detail = (): Promise<LicenseDetail> =>
    fake.handlers[IPC.licenseDetail]() as Promise<LicenseDetail>
  const release = (): Promise<LicenseDetail> =>
    fake.handlers[IPC.licenseRelease]() as Promise<LicenseDetail>

  it('sends the stored entitlement token, never a deviceId', async () => {
    storeToken()
    const fetchMock = vi.fn(async (_url: string, _init: { method: string; body: string }) =>
      jsonResponse({ key: 'KEY-ABC', used: 2, seats: 3, source: 'keygen' })
    )
    await boot(fetchMock)

    expect(await detail()).toEqual({
      key: 'KEY-ABC',
      used: 2,
      seats: 3,
      source: 'keygen',
      error: null
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toContain('/v1/license/detail')
    // A key works on ANY machine, so the request that reveals one is authorized by the signed
    // entitlement and by nothing else. deviceId rides query strings, telemetry and relay pairing.
    expect(String(url)).not.toContain(TOKEN)
    expect(init.method).toBe('POST')
    const body = JSON.parse(init.body) as Record<string, unknown>
    expect(body.entitlement).toBe(TOKEN) // the stored token itself, not merely "something truthy"
    expect(Object.keys(body)).toEqual(['entitlement']) // …and nothing else travels with it
  })

  it('release posts to its own route, not to detail', async () => {
    storeToken()
    const fetchMock = vi.fn(async (_url: string, _init: { body: string }) =>
      jsonResponse({ used: 1, seats: 3 })
    )
    await boot(fetchMock)

    const r = await release()
    expect(r.error).toBeNull()
    expect(r.used).toBe(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toContain('/v1/license/release')
    expect(String(url)).not.toContain('/v1/license/detail')
    expect((JSON.parse(init.body) as { entitlement: string }).entitlement).toBe(TOKEN)
  })

  it('carries the source, so a non-keygen entitlement is not read as a failed count', async () => {
    // An App Store purchase on a paired phone bridges Pro to the desktop as `apple:<txn>`. The
    // server makes zero keygen calls for it and answers 200 with no key and no machines — those
    // zeros mean "device counting does not apply here", NOT "the read failed". `source` is the
    // only thing that tells the two apart, and the UI hides the release action on it.
    //
    // This is also the fixture that stops the malformed-2xx guard below from OVER-firing: these
    // zeros are stated numbers, so they must still read as a success.
    storeToken()
    await boot(vi.fn(async () => jsonResponse({ key: null, used: 0, seats: 0, source: 'apple' })))

    expect(await detail()).toEqual({
      key: null,
      used: 0,
      seats: 0,
      source: 'apple',
      error: null
    })
  })

  it('carries a google source the same way (a Play purchase bridged from a paired Android phone)', async () => {
    storeToken()
    await boot(vi.fn(async () => jsonResponse({ key: null, used: 0, seats: 0, source: 'google' })))

    expect(await detail()).toEqual({ key: null, used: 0, seats: 0, source: 'google', error: null })
  })

  it('still degrades an unknown source word to null', async () => {
    storeToken()
    await boot(vi.fn(async () => jsonResponse({ key: null, used: 0, seats: 0, source: 'huawei' })))

    expect((await detail()).source).toBeNull()
  })

  it('a 200 with key null is a success, not the 402 inactive story', async () => {
    // A keygen policy may hide keys, and licenses predating the `key` column have none stored.
    // Reporting that as a failure would tell a paying subscriber their license is inactive.
    storeToken()
    await boot(vi.fn(async () => jsonResponse({ key: null, used: 2, seats: 3, source: 'keygen' })))

    expect(await detail()).toEqual({ key: null, used: 2, seats: 3, source: 'keygen', error: null })
  })

  it('402 inactive is an error with no source claimed', async () => {
    storeToken()
    await boot(vi.fn(async () => errorResponse(402, { error: 'inactive' })))

    expect(await detail()).toEqual({
      key: null,
      used: 0,
      seats: 0,
      source: null,
      error: 'inactive'
    })
  })

  it('401 unauthorized keeps the server-stated reason instead of a generic network error', async () => {
    storeToken()
    await boot(vi.fn(async () => errorResponse(401, { error: 'unauthorized' })))
    expect((await detail()).error).toBe('unauthorized')
  })

  it('times out a response whose BODY never arrives, instead of hanging the handler forever', async () => {
    // The 8s abort has to cover the body, not just the headers. A captive portal or a proxy that
    // holds the connection open answers 200 and then stalls; with the timer cleared as soon as the
    // headers land, this handler never settles — and the renderer's Release button sits on
    // "Releasing…" for the rest of the session, with no failure to report and no way back.
    storeToken()
    // Captured while setTimeout is still real (this describe fakes only setInterval + Date), so
    // the guard below can fail FAST if the handler hangs rather than idling until vitest's own
    // test timeout.
    const realSetTimeout = globalThis.setTimeout
    let aborted = false
    await boot(
      vi.fn(async (_url: string, init: { signal: AbortSignal }) => ({
        ok: true,
        status: 200,
        // A real fetch body rejects when the request is aborted; before that it just never settles.
        json: () =>
          new Promise((_resolve, reject) => {
            init.signal.addEventListener('abort', () => {
              aborted = true
              reject(new Error('The operation was aborted'))
            })
          })
      }))
    )

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'Date'] })
    const pending = release()
    await vi.advanceTimersByTimeAsync(8000)
    const guard = new Promise<'hung'>((resolve) => realSetTimeout(() => resolve('hung'), 500))
    const outcome = await Promise.race([pending, guard])

    expect(outcome, 'the release handler never settled').not.toBe('hung')
    expect(aborted).toBe(true)
    // A read that could not run is an error — never a license with no devices.
    expect(outcome).toEqual({ key: null, used: 0, seats: 0, source: null, error: 'network' })
  })

  it('reports an error instead of zero devices when the read fails', async () => {
    storeToken()
    await boot(
      vi.fn(async () => {
        throw new Error('down')
      })
    )

    expect(await detail()).toEqual({
      key: null,
      used: 0,
      seats: 0,
      source: null,
      error: 'offline'
    })
  })

  it('surfaces the 30-day throttle with its retry window', async () => {
    storeToken()
    await boot(vi.fn(async () => errorResponse(429, { error: 'too_soon', retryAfterDays: 12 })))

    // toEqual, not toMatchObject: the retry window is the whole point of this reply, and the
    // server side asserts only the error code — so if `retryAfterDays` is dropped anywhere
    // between the wire and the renderer, this is what fails.
    expect(await release()).toEqual({
      key: null,
      used: 0,
      seats: 0,
      source: null,
      error: 'too_soon',
      retryAfterDays: 12
    })
  })

  it('keeps not_applicable distinguishable from a plain bad request', async () => {
    // 'not_applicable' = this entitlement is not keygen-backed, so releasing means nothing. The
    // UI hides the action on `source`; this is the server-side floor under that, not a failure.
    storeToken()
    await boot(vi.fn(async () => errorResponse(400, { error: 'not_applicable' })))
    expect((await release()).error).toBe('not_applicable')

    vi.stubGlobal('fetch', vi.fn(async () => errorResponse(400, { error: 'bad_request' })))
    expect((await release()).error).toBe('bad_request')
  })

  it('an error body with no reason code falls back to network, and never to success', async () => {
    storeToken()
    await boot(vi.fn(async () => errorResponse(500, {})))
    expect((await detail()).error).toBe('network')
  })

  it('reports used above seats verbatim — a cap can be lowered after activation', async () => {
    storeToken()
    await boot(vi.fn(async () => jsonResponse({ key: 'K', used: 5, seats: 3, source: 'keygen' })))

    const d = await detail()
    expect(d.used).toBe(5) // never clamped to the cap: over-cap is a real, reportable state
    expect(d.seats).toBe(3)
  })

  it('a 2xx whose counts are not numbers is a FAILED READ, not a license with no devices', async () => {
    // The scenario: a captive portal or corporate proxy answers the POST with a 200 HTML page, or
    // a bad deploy answers `200 {}` / `200 {"used":"3"}`. Coercing those to zeros with error null
    // renders "0 of 0 devices" and an empty key as fact — a subscriber told they have no license.
    storeToken()
    await boot(vi.fn(async () => jsonResponse({ key: 'K', used: '3', seats: null, source: 'keygen' })))

    expect(await detail()).toEqual({
      key: null,
      used: 0,
      seats: 0,
      source: null,
      error: 'network'
    })

    // The 200 HTML page: the body does not parse at all.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError('Unexpected token <')
        }
      }))
    )
    expect((await detail()).error).toBe('network')
  })

  it('refuses to call the server with no stored entitlement', async () => {
    // No license.json at all.
    const fetchMock = vi.fn()
    await boot(fetchMock)

    expect(await detail()).toEqual({
      key: null,
      used: 0,
      seats: 0,
      source: null,
      error: 'unauthorized'
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('honors the telemetry kill switch without inventing a device count', async () => {
    storeToken()
    const fetchMock = vi.fn(async () => jsonResponse({ key: 'K', used: 2, seats: 3, source: 'keygen' }))
    await boot(fetchMock)
    process.env.DO_NOT_TRACK = '1'

    expect(await detail()).toEqual({
      key: null,
      used: 0,
      seats: 0,
      source: null,
      error: 'disabled'
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('ignores a source it does not recognize rather than passing it through', async () => {
    // The value decides whether a destructive-ish action is offered, so an unknown word degrades
    // to "no source stated" (the action stays hidden) instead of reaching the UI as data.
    storeToken()
    await boot(
      vi.fn(async () => jsonResponse({ key: 'K', used: 1, seats: 3, source: 'paddle' }))
    )
    const d = await detail()
    expect(d.source).toBeNull()
    // …and it stays a SUCCESS. Stamping an error here would hide the whole panel over a reply that
    // carried a perfectly good key and device count.
    expect(d.error).toBeNull()
    expect(d.key).toBe('K')
  })
})

describe('license clock anchor + project-limit Pro grace + DO_NOT_TRACK consent', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  let fake: import('./platform-fake').FakePlatform

  const DAY = 24 * HOUR
  const DAY_S = 24 * 60 * 60
  const file = (): string => path.join(h.userData, 'license.json')
  function store(s: { token?: string; key?: string; lastSeen?: number }): void {
    writeFileSync(file(), JSON.stringify(s))
  }
  /** A token signed by a key this install does NOT trust — the signature half of verify(). */
  function forge(ttlSeconds: number): string {
    const other = crypto.generateKeyPairSync('ed25519').privateKey
    const payload = Buffer.from(
      JSON.stringify({
        deviceId: 'test-device',
        tier: 'pro',
        licenseId: 'lic_forged',
        exp: Math.floor(Date.now() / 1000) + ttlSeconds
      })
    ).toString('base64url')
    return `${payload}.${crypto.sign(null, Buffer.from(payload), other).toString('base64url')}`
  }
  const urls = (): string[] => fetchMock.mock.calls.map((c) => String(c[0]))

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'Date'] })
    h.userData = mkdtempSync(path.join(tmpdir(), 'nt-license-grace-'))
    writeFileSync(path.join(h.userData, 'device-id'), 'test-device')
    delete process.env.DO_NOT_TRACK
    delete process.env.NODETERM_TELEMETRY_DISABLED
    process.env.NODETERM_API_BASE = 'http://127.0.0.1:1'
    // Offline by default: the launch refresh keeps the stored token (offline grace).
    fetchMock = vi.fn().mockRejectedValue(new Error('offline'))
    vi.stubGlobal('fetch', fetchMock)
    vi.resetModules()
    const { initPlatform } = await import('./platform')
    const { fakePlatform } = await import('./platform-fake')
    fake = fakePlatform({ userDataDir: h.userData, isPackaged: false })
    initPlatform(fake)
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
    const { resetPlatformForTests } = await import('./platform')
    resetPlatformForTests()
    delete process.env.DO_NOT_TRACK
    delete process.env.NODETERM_TELEMETRY_DISABLED
    process.env.NODETERM_API_BASE = 'http://127.0.0.1:1'
    rmSync(h.userData, { recursive: true, force: true })
  })

  describe('clockAnchorMs', () => {
    it('is the wall clock when nothing later has been observed', async () => {
      const { clockAnchorMs } = await import('./license')
      expect(clockAnchorMs()).toBe(Date.now())
      store({ lastSeen: Math.floor(Date.now() / 1000) - 5 * DAY_S })
      expect(clockAnchorMs()).toBe(Date.now())
    })

    it('is the stored lastSeen when the wall clock is behind it (a rolled-back clock)', async () => {
      const ahead = Math.floor(Date.now() / 1000) + 40 * DAY_S
      store({ lastSeen: ahead })
      const { clockAnchorMs } = await import('./license')
      expect(clockAnchorMs()).toBe(ahead * 1000)
    })
  })

  describe('proForProjectLimit', () => {
    it('is the 30-day window', async () => {
      const { PRO_LIMIT_GRACE_MS } = await import('./license')
      expect(PRO_LIMIT_GRACE_MS).toBe(30 * 24 * 60 * 60 * 1000)
    })

    it('a live token is Pro for the limit and for everything else', async () => {
      store({ token: mint(7 * DAY_S) })
      const { isPremium, proForProjectLimit } = await import('./license')
      expect(isPremium()).toBe(true)
      expect(proForProjectLimit()).toBe(true)
    })

    it('a token that expired 10 days ago is Pro for the limit ONLY', async () => {
      store({ token: mint(-10 * DAY_S, 'test-device', 5) })
      const { initLicense, isPremium, licensedSeats, proForProjectLimit } = await import('./license')
      expect(isPremium()).toBe(false)
      expect(proForProjectLimit()).toBe(true)
      // Every other Pro feature still reads the token as expired.
      expect(licensedSeats()).toBe(0)
      initLicense()
      await refreshed()
      const status = (await fake.handlers[IPC.licenseStatus]()) as LicenseStatus
      expect(status.active).toBe(false)
      expect(status.seats).toBe(0)
    })

    it('a token that expired 31 days ago is not Pro for anything', async () => {
      store({ token: mint(-31 * DAY_S) })
      const { isPremium, proForProjectLimit } = await import('./license')
      expect(isPremium()).toBe(false)
      expect(proForProjectLimit()).toBe(false)
    })

    it('measures the 30 days from the clock anchor, not the wall clock', async () => {
      // 20 days past expiry by the wall clock (inside the window), but this install has already
      // observed a time 40 days ahead — 60 days past expiry by the anchor. Rolling the clock back
      // must not buy the window again.
      store({ token: mint(-20 * DAY_S), lastSeen: Math.floor(Date.now() / 1000) + 40 * DAY_S })
      const { proForProjectLimit } = await import('./license')
      expect(proForProjectLimit()).toBe(false)
    })

    it('a token minted for another device is not Pro for the limit, expired or not', async () => {
      store({ token: mint(-10 * DAY_S, 'other-device') })
      const first = await import('./license')
      expect(first.proForProjectLimit()).toBe(false)
      store({ token: mint(7 * DAY_S, 'other-device') })
      expect(first.proForProjectLimit()).toBe(false)
    })

    it('a token signed by any other key is not Pro for the limit', async () => {
      store({ token: forge(-10 * DAY_S) })
      const { proForProjectLimit } = await import('./license')
      expect(proForProjectLimit()).toBe(false)
    })

    it('no stored token is not Pro for the limit', async () => {
      const { proForProjectLimit } = await import('./license')
      expect(proForProjectLimit()).toBe(false)
    })

    it('ends with the token a 2xx active:false deletes', async () => {
      // The device-bound refresh drops the token on the server's "no longer entitled" answer, so a
      // stored token is itself the proof that no such answer has arrived since.
      store({ token: mint(-10 * DAY_S) })
      fetchMock.mockResolvedValue(jsonResponse({ active: false }))
      const { initLicense, proForProjectLimit } = await import('./license')
      expect(proForProjectLimit()).toBe(true)
      initLicense()
      await refreshed()
      expect(proForProjectLimit()).toBe(false)
    })
  })

  describe('isDntEnv', () => {
    it('reads DO_NOT_TRACK and the telemetry kill switch, live', async () => {
      const { isDntEnv } = await import('./license')
      expect(isDntEnv()).toBe(false)
      process.env.DO_NOT_TRACK = '1'
      expect(isDntEnv()).toBe(true)
      delete process.env.DO_NOT_TRACK
      process.env.NODETERM_TELEMETRY_DISABLED = '1'
      expect(isDntEnv()).toBe(true)
    })
  })

  describe('licenseNetworkGate', () => {
    it('is ok with no DO_NOT_TRACK, whatever consent says', async () => {
      const { licenseNetworkGate } = await import('./license')
      expect(licenseNetworkGate()).toBe('ok')
    })

    it('is disabled in an unpackaged build without NODETERM_API_BASE, even with DNT consent', async () => {
      delete process.env.NODETERM_API_BASE
      const { licenseNetworkGate, setLicenseNetworkConsent } = await import('./license')
      expect(licenseNetworkGate()).toBe('disabled')
      process.env.DO_NOT_TRACK = '1'
      setLicenseNetworkConsent(() => true)
      expect(licenseNetworkGate()).toBe('disabled')
      // A packaged build talks to the default API.
      const { initPlatform } = await import('./platform')
      const { fakePlatform } = await import('./platform-fake')
      initPlatform(fakePlatform({ userDataDir: h.userData, isPackaged: true }))
      expect(licenseNetworkGate()).toBe('ok')
    })

    it('asks for consent under DO_NOT_TRACK or the kill switch, and reads it on every call', async () => {
      process.env.DO_NOT_TRACK = '1'
      const { licenseNetworkGate, setLicenseNetworkConsent } = await import('./license')
      expect(licenseNetworkGate()).toBe('consent_required') // default: no consent
      let consented = true
      setLicenseNetworkConsent(() => consented)
      expect(licenseNetworkGate()).toBe('ok')
      consented = false // revoked in Settings → Privacy: takes effect at once
      expect(licenseNetworkGate()).toBe('consent_required')
      delete process.env.DO_NOT_TRACK
      process.env.NODETERM_TELEMETRY_DISABLED = '1'
      expect(licenseNetworkGate()).toBe('consent_required')
    })

    it('a consent callback that throws reads as no consent', async () => {
      process.env.DO_NOT_TRACK = '1'
      const { licenseNetworkGate, setLicenseNetworkConsent } = await import('./license')
      setLicenseNetworkConsent(() => {
        throw new Error('settings not loaded')
      })
      expect(licenseNetworkGate()).toBe('consent_required')
    })
  })

  describe('license calls under DO_NOT_TRACK', () => {
    it('without consent, the launch refresh makes no request and keeps the stored token', async () => {
      process.env.DO_NOT_TRACK = '1'
      store({ token: mint(7 * DAY_S) })
      const { initLicense, isPremium } = await import('./license')
      initLicense()
      await refreshed()
      expect(fetchMock).not.toHaveBeenCalled()
      expect(isPremium()).toBe(true)
    })

    it('without consent, a key-paste refresh makes no request either', async () => {
      process.env.NODETERM_TELEMETRY_DISABLED = '1'
      store({ key: 'KEY-1', token: mint(7 * DAY_S) })
      const { initLicense } = await import('./license')
      initLicense()
      await refreshed()
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('with consent, the device-bound refresh asks /v1/license/status and stores the token', async () => {
      process.env.DO_NOT_TRACK = '1'
      const token = mint(7 * DAY_S)
      fetchMock.mockResolvedValue(jsonResponse({ active: true, token }))
      const { initLicense, isPremium, setLicenseNetworkConsent } = await import('./license')
      setLicenseNetworkConsent(() => true)
      initLicense()
      await refreshed()
      expect(urls()).toEqual([
        'http://127.0.0.1:1/v1/license/status?deviceId=test-device'
      ])
      expect(isPremium()).toBe(true)
    })

    it('with consent, the detail route runs too', async () => {
      process.env.DO_NOT_TRACK = '1'
      store({ token: mint(7 * DAY_S) })
      const { initLicense, setLicenseNetworkConsent } = await import('./license')
      initLicense()
      await refreshed() // no consent yet → no request
      expect(fetchMock).not.toHaveBeenCalled()
      setLicenseNetworkConsent(() => true)
      fetchMock.mockResolvedValue(jsonResponse({ key: 'K', used: 1, seats: 3, source: 'keygen' }))
      const d = (await fake.handlers[IPC.licenseDetail]()) as LicenseDetail
      expect(d.error).toBeNull()
      expect(urls()).toEqual(['http://127.0.0.1:1/v1/license/detail'])
    })
  })
})
