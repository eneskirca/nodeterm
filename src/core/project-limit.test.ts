import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import crypto from 'node:crypto'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'fs'
import path from 'path'
import { IPC } from '../shared/ipc'
import { PROJECT_LIMIT_DEADLINE_MS, type ClaimResult, type ProjectLimitState } from '../shared/project-limit'
import { machineHashOf, type MachineHashResult } from './machine-id'
import { makeFakeUserDataDir, type FakePlatform } from './platform-fake'

// The Pro test needs a real entitlement token: license.ts verifies against this key.
const h = vi.hoisted(() => ({ entitlementPem: '' }))
vi.mock('./entitlement-key', () => ({
  get ENTITLEMENT_PUBLIC_KEY() {
    return h.entitlementPem
  }
}))
// Every write of project-limit.json must go through writeFileAtomic; the spy also counts them.
vi.mock('./fs-atomic', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./fs-atomic')>()
  return { ...actual, writeFileAtomic: vi.fn(actual.writeFileAtomic) }
})

const entitlement = crypto.generateKeyPairSync('ed25519')
h.entitlementPem = entitlement.publicKey.export({ type: 'spki', format: 'pem' }).toString()
// The allowance key is passed to initProjectLimit (the shipped key is '' until owner step O1).
const allowanceKeys = crypto.generateKeyPairSync('ed25519')
const ALLOWANCE_PUB = allowanceKeys.publicKey.export({ type: 'spki', format: 'pem' }).toString()

const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const DEADLINE = PROJECT_LIMIT_DEADLINE_MS
const BEFORE = DEADLINE - 30 * DAY
const AFTER = DEADLINE + 2 * DAY
const API = 'http://127.0.0.1:1'
const DEVICE = '3f0c6a52-9d7e-4b8a-a1c4-5e2f7d9b0c18'
const MACHINE = machineHashOf('0123456789abcdef0123456789abcdef')
const OTHER_MACHINE = machineHashOf('fedcba9876543210fedcba9876543210')
const FALLBACK = machineHashOf('host:test-host')

function signPayload(payload: object, key: crypto.KeyObject): string {
  const p = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${p}.${crypto.sign(null, Buffer.from(p), key).toString('base64url')}`
}

/** An allowance token the way nodeterm-server's signer writes it. */
function allowanceToken(
  over: { allowance?: number; epoch?: number; machine?: string; deviceId?: string } = {},
  key: crypto.KeyObject = allowanceKeys.privateKey
): string {
  return signPayload(
    {
      typ: 'project-allowance',
      deviceId: over.deviceId ?? DEVICE,
      machine: over.machine ?? MACHINE,
      allowance: over.allowance ?? 9,
      epoch: over.epoch ?? 1,
      iat: Math.floor(Date.now() / 1000)
    },
    key
  )
}

function entitlementToken(ttlSeconds: number): string {
  const now = Math.floor(Date.now() / 1000)
  return signPayload(
    { deviceId: DEVICE, tier: 'pro', licenseId: 'lic_test', iat: now, exp: now + ttlSeconds },
    entitlement.privateKey
  )
}

interface FakeResponse {
  ok: boolean
  status: number
  json: () => Promise<unknown>
}
type Reply = (url: string, init?: RequestInit) => Promise<FakeResponse>

const reply = (status: number, body: unknown): Reply => () =>
  Promise.resolve({ ok: status >= 200 && status < 300, status, json: async () => body })
/** A body that is not JSON: a 500 page, a captive portal's HTML. */
const notJson = (status: number): Reply => () =>
  Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      throw new SyntaxError('Unexpected token < in JSON')
    }
  })
const offline: Reply = () => Promise.reject(new TypeError('fetch failed'))
const checkOn = (free: number, epoch: number): Reply =>
  reply(200, { messages: [], update: {}, limits: { projects: { free, epoch } } })
const checkOff: Reply = reply(200, { messages: [], update: {} })

let userData = ''
let fake: FakePlatform
let fetchMock: ReturnType<typeof vi.fn>
let notified: ProjectLimitState[] = []
const net: { check: Reply; claim: Reply } = { check: offline, claim: offline }
let machineSpy: ReturnType<typeof vi.fn<() => Promise<MachineHashResult>>>

const limitFile = (): string => path.join(userData, 'project-limit.json')
const readLimitFile = (): Record<string, unknown> => JSON.parse(readFileSync(limitFile(), 'utf-8'))
const writeLimitFile = (v: unknown): void =>
  writeFileSync(limitFile(), typeof v === 'string' ? v : JSON.stringify(v))
const writeLicense = (v: object): void => writeFileSync(path.join(userData, 'license.json'), JSON.stringify(v))
const urls = (): string[] => fetchMock.mock.calls.map((c) => String(c[0]))
const claimCalls = () => fetchMock.mock.calls.filter((c) => String(c[0]).endsWith('/v1/limits/claim'))
const checkCalls = (): number => urls().filter((u) => u.includes('/v1/check?')).length
const channelSends = () => fake.sent.filter((s) => s.channel === IPC.projectLimitChanged)

/** Let pending fs / promise work settle without touching the (partly faked) timers. */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r))
}

interface Booted {
  handle: import('./project-limit').ProjectLimitHandle
  mod: typeof import('./project-limit')
  check: typeof import('./check')
  /** Calls of writeFileAtomic aimed at project-limit.json. */
  writes: () => number
  idle: () => Promise<void>
}
let booted: Booted

async function boot(
  opts: {
    packaged?: boolean
    file?: unknown
    openProjects?: () => number | undefined
    machineHash?: () => Promise<MachineHashResult>
    wait?: boolean
  } = {}
): Promise<Booted> {
  vi.resetModules()
  if (opts.file !== undefined) writeLimitFile(opts.file)
  const { initPlatform } = await import('./platform')
  const { fakePlatform } = await import('./platform-fake')
  fake = fakePlatform({ userDataDir: userData, isPackaged: opts.packaged ?? true })
  initPlatform(fake)
  const mod = await import('./project-limit')
  const check = await import('./check')
  const atomic = await import('./fs-atomic')
  const writeSpy = atomic.writeFileAtomic as unknown as ReturnType<typeof vi.fn>
  const handle = mod.initProjectLimit({
    openProjects: opts.openProjects ?? (() => 3),
    machineHash: opts.machineHash ?? machineSpy,
    publicKeyPem: ALLOWANCE_PUB,
    notify: (s) => notified.push(s)
  })
  booted = {
    handle,
    mod,
    check,
    writes: () => writeSpy.mock.calls.filter((c) => c[0] === limitFile()).length,
    idle: () => mod.__projectLimitIdleForTests()
  }
  if (opts.wait !== false) await booted.idle()
  return booted
}

/** Serve one /v1/check read (past check.ts's 5-minute cache) and let core digest the answer. */
async function answer(r: Reply): Promise<void> {
  net.check = r
  vi.setSystemTime(Date.now() + 6 * MINUTE)
  await booted.check.fetchCheck()
  await booted.idle()
}

beforeEach(() => {
  // Only the intervals and the clock are faked: fetch, fs and the claim's abort timer stay real.
  vi.useFakeTimers({ toFake: ['setInterval', 'Date'] })
  vi.setSystemTime(BEFORE)
  userData = makeFakeUserDataDir()
  writeFileSync(path.join(userData, 'device-id'), DEVICE)
  delete process.env.DO_NOT_TRACK
  delete process.env.NODETERM_TELEMETRY_DISABLED
  process.env.NODETERM_API_BASE = API
  net.check = offline
  net.claim = offline
  notified = []
  machineSpy = vi.fn(async () => ({ hash: MACHINE, fromOs: true }))
  fetchMock = vi.fn((url: string, init?: RequestInit) => {
    if (url.includes('/v1/check?')) return net.check(url, init)
    if (url.endsWith('/v1/limits/claim')) return net.claim(url, init)
    return Promise.reject(new Error(`unexpected fetch ${url}`))
  })
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(async () => {
  await booted?.idle()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  const { resetPlatformForTests } = await import('./platform')
  resetPlatformForTests()
  rmSync(userData, { recursive: true, force: true })
  delete process.env.NODETERM_API_BASE
  delete process.env.DO_NOT_TRACK
})

describe('project limit: on or off', () => {
  it('is inactive in an unpackaged build even when latched', async () => {
    vi.setSystemTime(AFTER)
    const { handle } = await boot({ packaged: false, file: { latched: true, free: 5, epoch: 1 } })
    expect(handle.state().active).toBe(false)
    await answer(checkOn(5, 1))
    expect(handle.state().active).toBe(false)
  })

  it('is inactive before the deadline with no server word', async () => {
    const { handle } = await boot()
    expect(handle.state()).toEqual({ active: false, pro: false, free: 5, allowance: null, dnt: false })
    vi.setSystemTime(DEADLINE - 1)
    expect(handle.state().active).toBe(false)
    // Review Focus 1: no claim and no machine read — the one request is the existing check.
    expect(urls()).toEqual([expect.stringContaining(`${API}/v1/check?`)])
    expect(machineSpy).not.toHaveBeenCalled()
    expect(notified.every((s) => !s.active)).toBe(true)

    // DO_NOT_TRACK users too, until the deadline — and they send nothing at all.
    process.env.DO_NOT_TRACK = '1'
    fetchMock.mockClear()
    const dnt = await boot()
    expect(dnt.handle.state()).toMatchObject({ active: false, allowance: null, dnt: true })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(machineSpy).not.toHaveBeenCalled()
  })

  it('activates at the deadline using the clock anchor', async () => {
    // The wall clock is a month before the deadline, but this install has already observed an
    // instant past it (license.ts's `lastSeen`): a rolled-back clock does not move it back.
    writeLicense({ lastSeen: Math.floor((DEADLINE + DAY) / 1000) })
    const { handle } = await boot()
    expect(handle.state().active).toBe(true)

    // The reverse never activates early: a `lastSeen` before the deadline, wall clock before it.
    writeLicense({ lastSeen: Math.floor((DEADLINE - DAY) / 1000) })
    expect(handle.state().active).toBe(false)
    vi.setSystemTime(DEADLINE - 1)
    expect(handle.state().active).toBe(false)
    vi.setSystemTime(DEADLINE)
    expect(handle.state().active).toBe(true)
  })

  it('latches on a check answer with limits', async () => {
    const { handle } = await boot()
    expect(handle.state().active).toBe(false)
    await answer(checkOn(7, 3))
    expect(handle.state()).toMatchObject({ active: true, free: 7 })
    expect(readLimitFile()).toMatchObject({ latched: true, free: 7, epoch: 3 })
    expect(notified.at(-1)).toMatchObject({ active: true, free: 7 })
  })

  it('keeps the latch when later checks fail', async () => {
    const { handle } = await boot()
    await answer(checkOn(5, 1))
    // Review Focus 3: none of these is a successful check without `limits`.
    for (const failed of [
      reply(500, {}),
      reply(429, { error: 'rate_limited', scope: 'ip' }),
      notJson(502),
      offline,
      notJson(200), // a captive portal's HTML page
      reply(200, { status: 'ok' }), // JSON that is not a check reply
      reply(200, { messages: [], update: {}, limits: { projects: { free: 'x', epoch: 1 } } })
    ]) {
      await answer(failed)
      expect(handle.state().active).toBe(true)
    }
    expect(readLimitFile().latched).toBe(true)

    // A restart with the network down keeps it: the latch is on disk.
    const again = await boot()
    expect(again.handle.state().active).toBe(true)
  })

  it('clears the latch on a successful check without limits', async () => {
    const { handle } = await boot()
    await answer(checkOn(5, 1))
    expect(handle.state().active).toBe(true)
    await answer(checkOff)
    expect(handle.state().active).toBe(false)
    expect(readLimitFile().latched).toBe(false)
    expect(notified.at(-1)?.active).toBe(false)
  })

  it('a not_active claim clears and suppresses the deadline for 24 h', async () => {
    vi.setSystemTime(AFTER)
    const { handle, mod } = await boot({ file: { latched: true, epoch: 1, token: allowanceToken() } })
    expect(handle.state()).toMatchObject({ active: true, allowance: 9 })
    net.claim = reply(409, { error: 'not_active' })
    const r = await handle.claim()
    expect(r).toEqual({ ok: true, state: expect.objectContaining({ active: false, allowance: null }) })
    const file = readLimitFile()
    expect(file).toMatchObject({ latched: false, offAt: AFTER })
    expect(file.token).toBeUndefined()

    vi.setSystemTime(AFTER + mod.OFF_TRUST_MS - 1)
    expect(handle.state().active).toBe(false)
    // …across a restart too: the off answer is on disk.
    expect((await boot()).handle.state().active).toBe(false)
    // Then the deadline re-arms.
    vi.setSystemTime(AFTER + mod.OFF_TRUST_MS)
    expect(booted.handle.state().active).toBe(true)
  })

  it('records firstLaunchOpenCount once', async () => {
    let count: number | undefined
    const { handle, idle } = await boot({ openProjects: () => count })
    handle.state()
    await idle()
    // Unknown is never recorded — and never as 0.
    expect(existsSync(limitFile())).toBe(false)
    count = 4
    handle.state()
    await idle()
    expect(readLimitFile().firstLaunchOpenCount).toBe(4)
    count = 9
    handle.state()
    await idle()
    expect(readLimitFile().firstLaunchOpenCount).toBe(4)

    const again = await boot({ openProjects: () => 12 })
    again.handle.state()
    await again.idle()
    expect(readLimitFile().firstLaunchOpenCount).toBe(4)
  })

  it('drops a token whose epoch differs from the latest check', async () => {
    const token = allowanceToken({ allowance: 9, epoch: 1 })
    const { handle } = await boot({ file: { latched: true, free: 5, epoch: 1, token } })
    expect(handle.state().allowance).toBe(9)
    await answer(checkOn(5, 1))
    expect(handle.state().allowance).toBe(9)
    expect(readLimitFile().token).toBe(token)

    await answer(checkOn(5, 2))
    expect(handle.state().allowance).toBeNull()
    expect(readLimitFile()).toMatchObject({ latched: true, epoch: 2 })
    expect(readLimitFile().token).toBeUndefined()
    expect(notified.at(-1)?.allowance).toBeNull()
  })

  it('reports allowance from a stored token with the network down', async () => {
    vi.setSystemTime(AFTER)
    const { handle } = await boot({ file: { latched: true, free: 5, epoch: 1, token: allowanceToken({ allowance: 12 }) } })
    fetchMock.mockClear()
    // Review Focus 2: nothing on the way to the answer touches the network.
    expect(handle.state()).toEqual({ active: true, pro: false, free: 5, allowance: 12, dnt: false })
    expect(fake.handlers[IPC.projectLimitState]()).toEqual(handle.state())
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('free defaults to 5 and follows the server', async () => {
    const { handle } = await boot()
    expect(handle.state().free).toBe(5)
    await answer(checkOn(8, 1))
    expect(handle.state().free).toBe(8)
    net.claim = reply(200, { token: allowanceToken({ epoch: 1 }), free: 6, epoch: 1 })
    expect((await handle.claim()).state.free).toBe(6)
    net.check = offline // the restart hears nothing newer: the last server word is kept
    expect((await boot()).handle.state().free).toBe(6)
  })

  it('pro follows proForProjectLimit', async () => {
    const { handle } = await boot()
    expect(handle.state().pro).toBe(false)
    writeLicense({ token: entitlementToken(7 * 24 * 3600) })
    expect(handle.state().pro).toBe(true) // re-read on every state(): no restart, no event
    handle.refresh()
    expect(notified.at(-1)?.pro).toBe(true)
    // A token that lapsed 20 days ago still counts for the limit (license.ts's 30-day grace)…
    writeLicense({ token: entitlementToken(-20 * 24 * 3600) })
    expect(handle.state().pro).toBe(true)
    // …and no token is no Pro.
    writeLicense({})
    expect(handle.state().pro).toBe(false)
  })
})

describe('project limit: claim', () => {
  it('claim stores token, free and epoch and broadcasts', async () => {
    const { handle } = await boot({ file: { latched: true, epoch: 2 } })
    const token = allowanceToken({ allowance: 9, epoch: 2 })
    net.claim = reply(200, { token, free: 6, epoch: 2 })
    const r = await handle.claim()
    expect(r).toEqual({ ok: true, state: { active: true, pro: false, free: 6, allowance: 9, dnt: false } })
    expect(readLimitFile()).toMatchObject({ latched: true, free: 6, epoch: 2, token })
    expect(notified.at(-1)).toEqual(r.state)
    // This machine's windows only (the shell's `notify`), never platform().broadcast/sendTo.
    expect(channelSends()).toEqual([])
  })

  it('claim sends deviceId, machine and firstLaunchOpenCount', async () => {
    const { handle } = await boot({ file: { latched: true }, openProjects: () => 4 })
    net.claim = reply(409, { error: 'not_active' })
    await handle.claim()
    const [url, init] = claimCalls()[0]
    expect(url).toBe(`${API}/v1/limits/claim`)
    expect(init).toMatchObject({ method: 'POST', headers: { 'content-type': 'application/json' } })
    expect(JSON.parse(String(init.body))).toEqual({ deviceId: DEVICE, machine: MACHINE, firstLaunchOpenCount: 4 })

    // An unknown count is sent as null, never as 0.
    rmSync(limitFile())
    fetchMock.mockClear()
    const again = await boot({ file: { latched: true }, openProjects: () => undefined })
    await again.handle.claim()
    expect(JSON.parse(String(claimCalls()[0][1].body))).toEqual({
      deviceId: DEVICE,
      machine: MACHINE,
      firstLaunchOpenCount: null
    })
  })

  it('claim maps machine_mismatch with retryAfter', async () => {
    const { handle } = await boot({ file: { latched: true, epoch: 1 }, openProjects: () => undefined })
    const before = readFileSync(limitFile(), 'utf-8')
    net.claim = reply(409, { error: 'machine_mismatch', retryAfter: 1802174400 })
    expect(await handle.claim()).toEqual({
      ok: false,
      error: 'machine_mismatch',
      retryAfter: 1802174400,
      state: handle.state()
    })
    expect(readFileSync(limitFile(), 'utf-8')).toBe(before)
    // A retryAfter that is not a unix-seconds integer is left out rather than invented.
    net.claim = reply(409, { error: 'machine_mismatch', retryAfter: 'soon' })
    expect(await handle.claim()).toEqual({ ok: false, error: 'machine_mismatch', state: handle.state() })
  })

  it('claim maps 500/429 to server and a throw to offline', async () => {
    const { handle } = await boot({ file: { latched: true, epoch: 1 }, openProjects: () => undefined })
    const before = readFileSync(limitFile(), 'utf-8')
    for (const r of [
      notJson(500),
      reply(429, { error: 'rate_limited', scope: 'ip' }),
      reply(503, {}),
      reply(400, { error: 'bad_request' }),
      reply(404, {}),
      reply(409, { error: 'something_new' }),
      notJson(200),
      reply(200, {})
    ]) {
      net.claim = r
      expect(await handle.claim()).toEqual({ ok: false, error: 'server', state: handle.state() })
    }
    net.claim = offline
    expect(await handle.claim()).toEqual({ ok: false, error: 'offline', state: handle.state() })
    expect(readFileSync(limitFile(), 'utf-8')).toBe(before)
  })

  it('a 200 whose token does not verify is a server error', async () => {
    const { handle } = await boot({ file: { latched: true, epoch: 2 } })
    const other = crypto.generateKeyPairSync('ed25519').privateKey
    for (const body of [
      { token: allowanceToken({ epoch: 2 }, other), free: 5, epoch: 2 },
      { token: allowanceToken({ epoch: 2, machine: OTHER_MACHINE }), free: 5, epoch: 2 },
      { token: allowanceToken({ epoch: 2, deviceId: '00000000-0000-4000-8000-000000000000' }), free: 5, epoch: 2 },
      { token: allowanceToken({ epoch: 1 }), free: 5, epoch: 2 },
      { token: allowanceToken({ epoch: 2 }), free: 5 },
      { token: allowanceToken({ epoch: 2 }), free: 0, epoch: 2 },
      { token: 42, free: 5, epoch: 2 }
    ]) {
      net.claim = reply(200, body)
      expect(await handle.claim()).toEqual({ ok: false, error: 'server', state: handle.state() })
    }
    expect(handle.state().allowance).toBeNull()
    expect(readLimitFile().token).toBeUndefined()
  })

  it('claim under DNT without consent answers consent_required without a fetch', async () => {
    process.env.DO_NOT_TRACK = '1'
    const { handle } = await boot({ file: { latched: true } })
    fetchMock.mockClear()
    expect(await handle.claim()).toEqual({
      ok: false,
      error: 'consent_required',
      state: expect.objectContaining({ dnt: true })
    })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(machineSpy).not.toHaveBeenCalled()
  })

  it('claim in an unpackaged build without an API override answers disabled, with no fetch or machine read', async () => {
    delete process.env.NODETERM_API_BASE
    const { handle } = await boot({ packaged: false })
    expect(await handle.claim()).toEqual({ ok: false, error: 'disabled', state: handle.state() })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(machineSpy).not.toHaveBeenCalled()
  })

  it('concurrent claims share one request', async () => {
    const { handle } = await boot({ file: { latched: true, epoch: 1 } })
    let release: (() => void) | undefined
    net.claim = () =>
      new Promise<FakeResponse>((resolve) => {
        release = () => resolve({ ok: true, status: 200, json: async () => ({ token: allowanceToken(), free: 5, epoch: 1 }) })
      })
    const a = handle.claim()
    const b = handle.claim()
    expect(b).toBe(a)
    await flush()
    expect(claimCalls()).toHaveLength(1)
    release?.()
    expect((await a).ok).toBe(true)
    // Once it has settled, the next claim is a new request.
    net.claim = reply(409, { error: 'not_active' })
    await handle.claim()
    expect(claimCalls()).toHaveLength(2)
  })

  it('the claim timeout covers the response body', async () => {
    const { handle } = await boot({ file: { latched: true, epoch: 1 } })
    vi.useFakeTimers({ toFake: ['setInterval', 'Date', 'setTimeout', 'clearTimeout'] })
    // Headers arrive at once; the body never does (a proxy holding the connection open).
    net.claim = (_url, init) =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
          })
      })
    let settled: ClaimResult | undefined
    void handle.claim().then((r) => (settled = r))
    await vi.advanceTimersByTimeAsync(7999)
    expect(settled).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1)
    await flush()
    expect(settled).toEqual({ ok: false, error: 'offline', state: handle.state() })
  })

  it('never rejects, even when reading the machine fails', async () => {
    const { handle } = await boot({
      file: { latched: true },
      machineHash: () => Promise.reject(new Error('boom'))
    })
    await expect(handle.claim()).resolves.toEqual({ ok: false, error: 'server', state: handle.state() })
    expect(claimCalls()).toHaveLength(0)
  })

  it('is served over IPC', async () => {
    const { handle } = await boot({ file: { latched: true } })
    net.claim = reply(409, { error: 'not_active' })
    const r = (await fake.handlers[IPC.projectLimitClaim]()) as ClaimResult
    expect(r).toEqual({ ok: true, state: handle.state() })
    expect(r.state.active).toBe(false)
  })
})

describe('project limit: machine hash', () => {
  it('a dormant install never reads the machine id', async () => {
    const { handle } = await boot()
    handle.state()
    await answer(checkOn(5, 1))
    await answer(checkOff)
    handle.refresh()
    expect(machineSpy).not.toHaveBeenCalled()
  })

  it('trusts a stored token provisionally until an OS-read hash is known, then checks the machine', async () => {
    let resolve!: (r: MachineHashResult) => void
    const read = new Promise<MachineHashResult>((r) => (resolve = r))
    const { handle, idle } = await boot({
      file: { latched: true, epoch: 1, token: allowanceToken({ allowance: 12 }) },
      machineHash: () => read,
      wait: false
    })
    // Read pending: the allowance stands (a slow boot read must not push a legacy user to a claim).
    expect(handle.state().allowance).toBe(12)
    resolve({ hash: OTHER_MACHINE, fromOs: true })
    await idle()
    // The OS says this is another machine: the token was copied here.
    expect(handle.state().allowance).toBeNull()
    expect(notified.at(-1)?.allowance).toBeNull()
  })

  it('keeps trusting a stored token when the OS read falls back', async () => {
    const { handle } = await boot({
      file: { latched: true, epoch: 1, token: allowanceToken({ allowance: 12 }) },
      machineHash: async () => ({ hash: OTHER_MACHINE, fromOs: false })
    })
    expect(handle.state().allowance).toBe(12)
  })

  it('keeps a stored token whose machine the OS confirms', async () => {
    const { handle } = await boot({ file: { latched: true, epoch: 1, token: allowanceToken({ allowance: 12 }) } })
    expect(machineSpy).toHaveBeenCalledTimes(1)
    expect(handle.state().allowance).toBe(12)
    expect(notified.at(-1)?.allowance).toBe(12)
  })

  it('a successful claim caches the machine hash it sent only when it came from the OS', async () => {
    const { handle, mod } = await boot({
      file: { latched: true, epoch: 1 },
      machineHash: async () => ({ hash: FALLBACK, fromOs: false })
    })
    net.claim = reply(200, { token: allowanceToken({ machine: FALLBACK }), free: 5, epoch: 1 })
    expect((await handle.claim()).state.allowance).toBe(9)
    expect(mod.__projectLimitMachineForTests()).toBeNull()

    const again = await boot({ file: { latched: true, epoch: 1 } })
    net.claim = reply(200, { token: allowanceToken(), free: 5, epoch: 1 })
    expect((await again.handle.claim()).state.allowance).toBe(9)
    expect(again.mod.__projectLimitMachineForTests()).toBe(MACHINE)
  })
})

describe('project limit: persistence', () => {
  it.each([
    ['missing', undefined],
    ['unparsable', '{"latched": tr'],
    ['an array', '[true]'],
    ['null', 'null'],
    ['a string', '"latched"']
  ])('reads a %s file as no state, without throwing', async (_label, file) => {
    const { handle } = await boot({ file })
    expect(handle.state()).toEqual({ active: false, pro: false, free: 5, allowance: null, dnt: false })
  })

  it('drops wrong-typed fields one by one', async () => {
    const { handle } = await boot({
      file: { latched: true, offAt: 'yesterday', free: 2.5, epoch: 1, token: 42, firstLaunchOpenCount: '4' },
      openProjects: () => 7
    })
    expect(handle.state()).toMatchObject({ active: true, free: 5, allowance: null })
    await booted.idle()
    expect(readLimitFile()).toEqual({ latched: true, epoch: 1, firstLaunchOpenCount: 7 })

    const other = await boot({
      file: { latched: 'yes', free: 1001, epoch: 0, token: allowanceToken(), firstLaunchOpenCount: -1 },
      openProjects: () => undefined
    })
    expect(other.handle.state()).toMatchObject({ active: false, free: 5, allowance: 9 })
  })

  it('writes only when something changed', async () => {
    const { handle, writes, idle } = await boot({ openProjects: () => 3 })
    handle.state()
    await idle()
    expect(writes()).toBe(1) // the first-launch count
    handle.state()
    handle.state()
    await idle()
    expect(writes()).toBe(1)

    await answer(checkOn(5, 1))
    expect(writes()).toBe(2)
    const sent = notified.length
    // The same answer twice (two callers racing check.ts's cache miss) is one change.
    await answer(checkOn(5, 1))
    // An answer the client cannot read changes nothing.
    await answer(reply(200, { messages: [], update: {}, limits: { projects: {} } }))
    expect(writes()).toBe(2)
    expect(notified.length).toBe(sent)
    expect(readLimitFile()).toEqual({ firstLaunchOpenCount: 3, latched: true, free: 5, epoch: 1 })
  })

  it('an off answer writes nothing until it could matter at the deadline', async () => {
    const { writes } = await boot({ openProjects: () => undefined })
    await answer(checkOff)
    expect(writes()).toBe(0)
    // Within a day of the deadline the off answer is what keeps it from switching on: keep it.
    vi.setSystemTime(DEADLINE - 12 * HOUR)
    await answer(checkOff)
    expect(writes()).toBe(1)
    expect(readLimitFile()).toEqual({ latched: false, offAt: Date.now() })
    vi.setSystemTime(DEADLINE + HOUR)
    expect((await boot({ openProjects: () => undefined })).handle.state().active).toBe(false)
  })
})

describe('project limit: wiring', () => {
  it('sends projectLimit:changed through notify only, never platform().broadcast', async () => {
    const { handle } = await boot({ file: { latched: true, epoch: 1 } })
    await answer(checkOn(6, 1))
    net.claim = reply(200, { token: allowanceToken(), free: 6, epoch: 1 })
    await handle.claim()
    handle.refresh()
    expect(notified.length).toBeGreaterThanOrEqual(3)
    expect(channelSends()).toEqual([])
  })

  it('refresh() re-sends the current state', async () => {
    const { handle } = await boot()
    const n = notified.length
    handle.refresh()
    expect(notified.length).toBe(n + 1)
    expect(notified.at(-1)).toEqual(handle.state())
  })

  it('reads the check feed at init and every 6 hours', async () => {
    await boot()
    expect(checkCalls()).toBe(1)
    await vi.advanceTimersByTimeAsync(6 * HOUR)
    expect(checkCalls()).toBe(2)
  })
})
