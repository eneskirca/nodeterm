import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import crypto from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { promises as fsp } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { IPC } from '../shared/ipc'
import type { LicenseStatus } from '../shared/types'

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
