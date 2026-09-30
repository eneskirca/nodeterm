// src/main/remote/hosted-join.test.ts
// The desktop joiner's whole sequence (join code → device token → client token → connect) as a pure
// function: mint discipline, the joiner-side pin, auto-confirm, and the denial reason. The first
// block drives a fake connect so every option handed to the relay client is observable; the second
// runs the real core client against the real hosted service over an in-process transport.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { joinHostedTeam, connectHostedTeam, removeHostedBookmark, createHostedJoinState, HostedJoinError, type HostedJoinDeps, type HostedJoinEvents, type HostedConnectOptions, type HostedJoinFailure } from './hosted-join'
import { joinErrorCode, joinRetryAfterMs } from '../../shared/relay-join-errors'
import { BookmarkStore, type RelayBookmark } from './relay-bookmarks'
import { encodeJoinCode, type JoinCode } from '../../core/relay/join-code'
import { hostIdFromPublicKeyB64 } from '../../core/relay/relay-id'
import { genKeyPair, publicKeyToB64, type KeyPair } from '../../core/relay/e2ee'
import { connectRelayClient, type RelayClientSession } from '../../core/relay/relay-client'
import { createHostedService, type HostedService } from '../../core/relay/hosted-service'
import { transportPair } from '../../core/relay/transport-pair'
import type { PeerAttach } from '../../core/relay/relay-host'
import type { RelayTransport } from '../../core/relay/relay-socket'
import { IPC } from '../../shared/ipc'
import { relayPtyDataKey } from '../../shared/relay-pty-channel'
import { testTmpDir } from '../../core/test-tmp'

const tmpDir = () => testTmpDir('hosted-join-')
const pub = (k: KeyPair) => publicKeyToB64(k.publicKey)

function codeFor(hostKeys: KeyPair, over: Partial<JoinCode> = {}): JoinCode {
  const k = pub(hostKeys)
  return { v: 1, relayEndpoint: 'wss://relay.example', hostId: hostIdFromPublicKeyB64(k), hostPublicKeyB64: k, hostDeviceId: 'host-dev', label: 'box', ...over }
}

/** An API that answers each route from its own queue (last answer repeats) and records every call. */
function api(routes: { device?: Array<[number, unknown]>; join?: Array<[number, unknown]> }) {
  const calls: Array<{ route: 'device' | 'join'; body: Record<string, unknown> }> = []
  const queues = { device: [...(routes.device ?? [])], join: [...(routes.join ?? [])] }
  const f = (async (url: string, init: RequestInit) => {
    const route = url.endsWith('/v1/relay/device') ? 'device' : url.endsWith('/v1/relay/join') ? 'join' : null
    if (!route) throw new Error(`unexpected ${url}`)
    calls.push({ route, body: JSON.parse(String(init.body)) })
    const q = queues[route]
    const [status, body] = (q.length > 1 ? q.shift() : q[0]) ?? [500, {}]
    return new Response(JSON.stringify(body), { status })
  }) as unknown as typeof fetch
  return { f, calls, count: (r: 'device' | 'join') => calls.filter((c) => c.route === r).length }
}
const DEVICE_OK = (t = 'DT'): [number, unknown] => [200, { deviceToken: t, hostId: 'H', exp: 1 }]
const JOIN_OK: [number, unknown] = [200, { pairingToken: 'PT', hostId: 'H', relayEndpoint: 'wss://relay.from-api', exp: 1 }]

/** A connect that records what it was given and hands back a session the test can inspect. */
function fakeConnect() {
  const opened: HostedConnectOptions[] = []
  const sessions: Array<RelayClientSession & { closed: boolean }> = []
  const connect = (o: HostedConnectOptions): RelayClientSession => {
    opened.push(o)
    const s = { closed: false, sas: () => '123 456', peerKeyB64: () => o.hostKeyB64, confirm: () => {}, send: () => true, isOpen: () => false, close() { this.closed = true } }
    sessions.push(s)
    return s
  }
  return { connect, opened, sessions, last: () => opened[opened.length - 1] }
}

function events() {
  const log: string[] = []
  const closed: Array<string | undefined> = []
  const ev: HostedJoinEvents = {
    onSas: (s) => log.push(`sas:${s}`),
    onApproved: () => log.push('approved'),
    onFrame: (j) => log.push(`frame:${j}`),
    onPtyData: (id, d) => log.push(`pty:${id}:${d}`),
    onClosed: (r) => closed.push(r)
  }
  return { ev, log, closed }
}

function setup(opts: { routes?: Parameters<typeof api>[0]; bookmarks?: RelayBookmark[]; loadKeys?: () => Promise<KeyPair>; failWrites?: boolean } = {}) {
  const dir = tmpDir()
  const store = new BookmarkStore(path.join(dir, 'relay-bookmarks.json'))
  if (opts.bookmarks) fs.writeFileSync(path.join(dir, 'relay-bookmarks.json'), JSON.stringify(opts.bookmarks))
  const a = api(opts.routes ?? { device: [DEVICE_OK()], join: [JOIN_OK] })
  const c = fakeConnect()
  const ourKeys = genKeyPair()
  // A disk that reads fine and then refuses every write: the probe passes, the persist does not.
  const bookmarks = opts.failWrites
    ? {
        file: store.file,
        list: () => store.list(),
        readForWrite: () => store.readForWrite(),
        upsert: async () => { throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' }) },
        update: async () => { throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' }) }
      }
    : store
  const state = createHostedJoinState()
  const deps: HostedJoinDeps = {
    apiBase: 'https://api', deviceId: () => 'my-device', label: 'laptop',
    bookmarks, loadKeys: opts.loadKeys ?? (async () => ourKeys), connect: c.connect, fetch: a.f,
    now: () => Date.parse('2026-09-29T10:00:00Z'), state
  }
  return { store, state, file: path.join(dir, 'relay-bookmarks.json'), api: a, c, deps, ourKeys }
}

const hostKeys = genKeyPair()
const code = codeFor(hostKeys)
const codeText = encodeJoinCode(code)
const bookmark = (over: Partial<RelayBookmark> = {}): RelayBookmark =>
  ({ hostId: code.hostId, code: codeText, label: 'box', deviceToken: 'OLD', approvedAt: null, source: 'code', ...over })

describe('joinHostedTeam', () => {
  it('refuses an invalid code before touching the network or the keys', async () => {
    const loadKeys = vi.fn(async () => genKeyPair())
    const s = setup({ loadKeys })
    const tampered = encodeJoinCode({ ...code, hostId: 'x'.repeat(22) })
    await expect(joinHostedTeam(tampered, s.deps, events().ev)).rejects.toMatchObject({ kind: 'invalid-code', message: '[E_JOIN_BAD_CODE] That team code is invalid.' })
    expect(s.api.calls).toEqual([])
    expect(loadKeys).not.toHaveBeenCalled()
    expect(s.c.opened).toEqual([])
  })

  it('first join: mints once with the free-tier body, connects with the host key pinned and NO pin store', async () => {
    const s = setup()
    const e = events()
    const session = await joinHostedTeam(codeText, s.deps, e.ev)
    expect(s.api.calls).toEqual([
      // R34: one device id PER TEAM, so joining a second team never re-registers the first's row.
      { route: 'device', body: { deviceId: `my-device:${code.hostId}`, hostDeviceId: 'host-dev', hostPublicKeyB64: code.hostPublicKeyB64, label: 'laptop' } },
      { route: 'join', body: { deviceToken: 'DT' } }
    ])
    const o = s.c.last()
    expect(o.url).toBe('wss://relay.from-api')
    expect(o.token).toBe('PT')
    expect(o.hostKeyB64).toBe(code.hostPublicKeyB64)
    expect(o.ourKeys).toBe(s.ourKeys)
    expect(o.autoApprove).toBe(false)
    // R33: a hosted host key never reaches the desktop's approved-devices store.
    expect('pins' in o).toBe(false)
    expect(session).toBe(s.c.sessions[0])
    // The bookmark keeps the token (so the next connect spends no mint) and is not yet approved.
    expect(await s.store.list()).toEqual([{ hostId: code.hostId, code: codeText, label: 'box', deviceToken: 'DT', approvedAt: null, source: 'code' }])
  })

  it('forwards the SAS, frames, pty data and a plain close (no reason)', async () => {
    const s = setup()
    const e = events()
    await joinHostedTeam(codeText, s.deps, e.ev)
    const o = s.c.last()
    o.onSas(s.c.sessions[0])
    o.onFrame('{"t":"ev"}')
    o.onPtyData('p1', 'hi')
    o.onClose()
    expect(e.log).toEqual(['sas:123 456', 'frame:{"t":"ev"}', 'pty:p1:hi'])
    expect(e.closed).toEqual([undefined])
  })

  it('records the approval as the joiner-side pin, once', async () => {
    const s = setup()
    const e = events()
    await joinHostedTeam(codeText, s.deps, e.ev)
    s.c.last().onApproved(s.c.sessions[0])
    await vi.waitFor(async () => expect((await s.store.list())[0]?.approvedAt).toBe('2026-09-29T10:00:00.000Z'))
    expect(e.log).toEqual(['approved'])
  })

  it('reuses a bookmarked device token: no device mint', async () => {
    const s = setup({ bookmarks: [bookmark()] })
    await joinHostedTeam(codeText, s.deps, events().ev)
    expect(s.api.calls).toEqual([{ route: 'join', body: { deviceToken: 'OLD' } }])
    expect(s.c.last().autoApprove).toBe(false)
  })

  it('auto-confirms only when the bookmark is approved AND carries the same host key', async () => {
    const s = setup({ bookmarks: [bookmark({ approvedAt: '2026-09-01T00:00:00Z' })] })
    await joinHostedTeam(codeText, s.deps, events().ev)
    expect(s.c.last().autoApprove).toBe(true)
    // The recorded approval is kept, not rewritten, on a pinned reconnect.
    s.c.last().onApproved(s.c.sessions[0])
    await new Promise((r) => setTimeout(r, 20))
    expect((await s.store.list())[0].approvedAt).toBe('2026-09-01T00:00:00Z')
  })

  it('a known hostId whose code now carries a different key string never auto-approves, and its token is not reused', async () => {
    // A non-canonical base64 spelling of the same 32 bytes: same hostId, different key string. The
    // rule compares the key the code carries with the key the bookmark was approved for, exactly.
    // 32 bytes encode as 43 characters + '=', and the last of those carries 2 unused low bits.
    const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
    const k = code.hostPublicKeyB64
    const alt = k.slice(0, -2) + B64[B64.indexOf(k[k.length - 2]) ^ 1] + k.slice(-1)
    expect(hostIdFromPublicKeyB64(alt)).toBe(code.hostId)
    expect(alt).not.toBe(k)
    const s = setup({ bookmarks: [bookmark({ approvedAt: '2026-09-01T00:00:00Z' })] })
    await joinHostedTeam(encodeJoinCode({ ...code, hostPublicKeyB64: alt }), s.deps, events().ev)
    expect(s.c.last().autoApprove).toBe(false)
    expect(s.api.count('device')).toBe(1)
    expect((await s.store.list())[0]).toMatchObject({ deviceToken: 'DT', approvedAt: null })
  })

  it('a bookmark whose stored code no longer decodes is not trusted either', async () => {
    const s = setup({ bookmarks: [bookmark({ code: 'nodeterm://join?code=junk', approvedAt: '2026-09-01T00:00:00Z' })] })
    await joinHostedTeam(codeText, s.deps, events().ev)
    expect(s.c.last().autoApprove).toBe(false)
  })

  it('bad-token on a bookmarked token: re-mints ONCE, persists it, and joins with it', async () => {
    const s = setup({ bookmarks: [bookmark()], routes: { device: [DEVICE_OK('NEW')], join: [[401, {}], JOIN_OK] } })
    await joinHostedTeam(codeText, s.deps, events().ev)
    expect(s.api.calls.map((c) => `${c.route}:${c.body.deviceToken ?? ''}`)).toEqual(['join:OLD', 'device:', 'join:NEW'])
    expect((await s.store.list())[0].deviceToken).toBe('NEW')
  })

  it('bad-token again after the re-mint: gives up with no second re-mint', async () => {
    const s = setup({ bookmarks: [bookmark()], routes: { device: [DEVICE_OK('NEW')], join: [[401, {}]] } })
    await expect(joinHostedTeam(codeText, s.deps, events().ev)).rejects.toMatchObject({ kind: 'bad-token' })
    expect(s.api.count('device')).toBe(1)
    expect(s.api.count('join')).toBe(2)
    expect(s.c.opened).toEqual([])
    // The fresh token is kept: a later attempt starts from it rather than minting again first.
    expect((await s.store.list())[0].deviceToken).toBe('NEW')
  })

  it('bad-token on a token minted in THIS attempt: no re-mint at all (at most one mint per attempt)', async () => {
    const s = setup({ routes: { device: [DEVICE_OK()], join: [[401, {}]] } })
    await expect(joinHostedTeam(codeText, s.deps, events().ev)).rejects.toMatchObject({ kind: 'bad-token' })
    expect(s.api.count('device')).toBe(1)
    expect(s.api.count('join')).toBe(1)
  })

  it('revoked: the honest message, and no re-mint', async () => {
    const s = setup({ bookmarks: [bookmark()], routes: { join: [[403, { error: 'revoked' }]] } })
    await expect(joinHostedTeam(codeText, s.deps, events().ev)).rejects.toMatchObject({ kind: 'revoked', message: "[E_JOIN_REVOKED] This device's relay access was revoked." })
    expect(s.api.count('device')).toBe(0)
  })

  it('device mint failures each say what happened and connect nothing', async () => {
    for (const [status, kind] of [[429, 'rate-limited'], [403, 'refused'], [502, 'network']] as const) {
      const s = setup({ routes: { device: [[status, {}]] } })
      const err = await joinHostedTeam(codeText, s.deps, events().ev).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(HostedJoinError)
      expect(err).toMatchObject({ kind })
      expect(s.api.count('join')).toBe(0)
      expect(s.c.opened).toEqual([])
      expect(await s.store.list()).toEqual([])
    }
  })

  it('a join that fails after a fresh mint keeps the minted token, so the retry spends no second mint', async () => {
    const s = setup({ routes: { device: [DEVICE_OK()], join: [[503, {}]] } })
    await expect(joinHostedTeam(codeText, s.deps, events().ev)).rejects.toMatchObject({ kind: 'network' })
    expect((await s.store.list())[0].deviceToken).toBe('DT')
    const retry = setup({ bookmarks: await s.store.list() })
    await joinHostedTeam(codeText, retry.deps, events().ev)
    expect(retry.api.count('device')).toBe(0)
  })

  it('a locked keyring rejects before any mint is spent', async () => {
    const s = setup({ loadKeys: async () => { throw Object.assign(new Error('keyring locked'), { code: 'E_PEER_KEY_LOCKED' }) } })
    const err = await joinHostedTeam(codeText, s.deps, events().ev).catch((e: Error) => e)
    // The loader's own sentence is kept (it tells the human to unlock and reconnect), behind the code.
    expect((err as Error).message).toBe('[E_JOIN_KEY_LOCKED] keyring locked')
    expect(s.api.calls).toEqual([])
  })

  it('R34: two teams get two device ids, both derived from this machine\'s', async () => {
    const other = codeFor(genKeyPair(), { hostDeviceId: 'other-host-dev' })
    const s = setup()
    await joinHostedTeam(codeText, s.deps, events().ev)
    await joinHostedTeam(encodeJoinCode(other), s.deps, events().ev)
    const ids = s.api.calls.filter((c) => c.route === 'device').map((c) => c.body.deviceId)
    expect(ids).toEqual([`my-device:${code.hostId}`, `my-device:${other.hostId}`])
    expect(ids[0]).not.toBe(ids[1])
    expect(String(ids[0]).length).toBeLessThanOrEqual(200) // the backend's deviceId limit
  })

  it('R35: every failure kind carries its stable code, readable through Electron\'s wrapper', () => {
    const expected: Record<HostedJoinFailure, string> = {
      'invalid-code': 'E_JOIN_BAD_CODE',
      'rate-limited': 'E_JOIN_RATE',
      refused: 'E_JOIN_REFUSED',
      // A token the service will not accept even fresh: retrying only spends mints, so it stops.
      'bad-token': 'E_JOIN_REFUSED',
      network: 'E_JOIN_NETWORK',
      revoked: 'E_JOIN_REVOKED',
      'key-locked': 'E_JOIN_KEY_LOCKED',
      // Another join of OURS for the same team is running: says nothing about the team (R39).
      busy: 'E_JOIN_BUSY',
      // The service's per-network limiter: clears within a minute, so it retries (R41).
      throttled: 'E_JOIN_THROTTLED'
    }
    for (const [kind, codeName] of Object.entries(expected) as Array<[HostedJoinFailure, string]>) {
      const e = new HostedJoinError(kind)
      expect(e.message.startsWith(`[${codeName}] `)).toBe(true)
      expect(e.code).toBe(codeName)
      expect(joinErrorCode(`Error invoking remote method 'relay:client:connect': Error: ${e.message}`)).toBe(codeName)
    }
  })

  it('R35: a connect that throws synchronously is a network failure', async () => {
    const s = setup()
    const connect = () => { throw new Error('Invalid URL') }
    await expect(joinHostedTeam(codeText, { ...s.deps, connect }, events().ev)).rejects.toMatchObject({ message: '[E_JOIN_NETWORK] Invalid URL' })
  })

  it('R36(4): a relay endpoint from the API that is not wss (or loopback ws) is never dialed', async () => {
    const s = setup({ routes: { device: [DEVICE_OK()], join: [[200, { pairingToken: 'PT', hostId: 'H', relayEndpoint: 'ws://evil.example', exp: 1 }]] } })
    await expect(joinHostedTeam(codeText, s.deps, events().ev)).rejects.toMatchObject({ kind: 'network', message: expect.stringMatching(/^\[E_JOIN_NETWORK\] /) })
    expect(s.c.opened).toEqual([])
  })

  it('R36(3): an approval never overwrites a token a concurrent attempt re-minted meanwhile', async () => {
    const s = setup({ bookmarks: [bookmark()] })
    await joinHostedTeam(codeText, s.deps, events().ev) // this session uses 'OLD'
    await s.store.upsert(bookmark({ deviceToken: 'REMINTED' })) // another attempt's fresh token
    s.c.last().onApproved(s.c.sessions[0])
    await vi.waitFor(async () => expect((await s.store.list())[0].approvedAt).toBe('2026-09-29T10:00:00.000Z'))
    expect((await s.store.list())[0].deviceToken).toBe('REMINTED')
  })

  it('R36(2): a bookmark write that fails is logged once, naming the host and never a token or the code', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const s = setup({ routes: { device: [DEVICE_OK('MINTED-TOKEN-XYZ')], join: [JOIN_OK] } })
      await joinHostedTeam(codeText, s.deps, events().ev) // the token is now held in memory too
      // A corrupt file holding a token, shaped so that V8's JSON.parse error would quote it were it
      // ever passed through. R38: no mint may happen now, but the in-memory token still joins.
      fs.writeFileSync(s.file, '[{"deviceToken": SECRET-TOKEN}]')
      warn.mockClear()
      await joinHostedTeam(codeText, s.deps, events().ev)
      s.c.last().onApproved(s.c.sessions[1])
      s.c.last().onDenied?.('removed')
      await vi.waitFor(() => expect(warn.mock.calls.length).toBeGreaterThanOrEqual(3))
      expect(s.api.count('device')).toBe(1)
      for (const call of warn.mock.calls) {
        const line = call.map(String).join(' ')
        expect(line).toContain(code.hostId)
        expect(line).not.toContain('SECRET')
        expect(line).not.toContain('MINTED-TOKEN') // the device token minted by this process
        expect(line).not.toContain('nodeterm://join')
        expect(line).not.toContain(codeText.slice('nodeterm://join?code='.length, 40))
      }
    } finally {
      warn.mockRestore()
    }
  })

  it('a denial is passed to onClosed and withdraws the joiner-side pin', async () => {
    for (const reason of ['denied', 'removed', 'expired'] as const) {
      const s = setup({ bookmarks: [bookmark({ approvedAt: '2026-09-01T00:00:00Z' })] })
      const e = events()
      await joinHostedTeam(codeText, s.deps, e.ev)
      const o = s.c.last()
      o.onDenied?.(reason)
      o.onClose()
      expect(e.closed).toEqual([reason])
      await vi.waitFor(async () => expect((await s.store.list())[0].approvedAt).toBeNull())
      // The device token survives: a denial is about this approval, not the relay credential.
      expect((await s.store.list())[0].deviceToken).toBe('OLD')
    }
  })

  it('an approval or denial never brings back a bookmark the user removed meanwhile', async () => {
    const s = setup()
    await joinHostedTeam(codeText, s.deps, events().ev)
    await s.store.remove(code.hostId)
    s.c.last().onApproved(s.c.sessions[0])
    s.c.last().onDenied?.('removed')
    await new Promise((r) => setTimeout(r, 20))
    expect(await s.store.list()).toEqual([])
  })
})

describe('connectHostedTeam (the relay:client:connect leg for a join code)', () => {
  function io() {
    const sent: Array<[string, ...unknown[]]> = []
    const sessions = new Map<string, RelayClientSession>()
    return { sent, sessions, io: { newId: () => 'c1', send: (ch: string, ...args: unknown[]) => { sent.push([ch, ...args]) }, sessions } }
  }

  it('routes every event to the connection\'s channels and registers the session', async () => {
    const s = setup()
    const x = io()
    expect(await connectHostedTeam(codeText, s.deps, x.io)).toBe('c1')
    expect(x.sessions.get('c1')).toBe(s.c.sessions[0])
    const o = s.c.last()
    o.onSas(s.c.sessions[0])
    o.onApproved(s.c.sessions[0])
    o.onFrame('{"t":"res"}')
    o.onPtyData('p1', 'out')
    expect(x.sent).toEqual([
      [IPC.relayClientSas('c1'), '123 456'],
      [IPC.relayClientApproved('c1')],
      [IPC.relayClientFrame('c1'), '{"t":"res"}'],
      // NAMESPACED: the host's `p1` must never land on a local pty's `pty:data:p1` channel.
      [IPC.ptyData(relayPtyDataKey('c1', 'p1')), 'out']
    ])
    expect(x.sent.some(([ch]) => ch === IPC.ptyData('p1'))).toBe(false)
  })

  it('a close carries the host\'s refusal reason and unregisters the session', async () => {
    const s = setup()
    const x = io()
    await connectHostedTeam(codeText, s.deps, x.io)
    s.c.last().onDenied?.('expired')
    s.c.last().onClose()
    expect(x.sent).toEqual([[IPC.relayClientClosed('c1'), 'expired']])
    expect(x.sessions.has('c1')).toBe(false)
  })

  it('a plain close sends no reason', async () => {
    const s = setup()
    const x = io()
    await connectHostedTeam(codeText, s.deps, x.io)
    s.c.last().onClose()
    expect(x.sent).toEqual([[IPC.relayClientClosed('c1'), undefined]])
  })

  it('a session that closed before the join returned is never registered', async () => {
    const s = setup()
    const x = io()
    const connect = (o: HostedConnectOptions): RelayClientSession => {
      const session = s.c.connect(o)
      o.onClose()
      return session
    }
    await connectHostedTeam(codeText, { ...s.deps, connect }, x.io)
    expect(x.sessions.size).toBe(0)
    expect(x.sent).toEqual([[IPC.relayClientClosed('c1'), undefined]])
  })

  it('R35: a failure that is not ours still leaves with a stable code', async () => {
    const s = setup()
    const x = io()
    const deviceId = () => { throw new Error('platform not initialised') }
    await expect(connectHostedTeam(codeText, { ...s.deps, deviceId }, x.io)).rejects.toThrow(/^\[E_JOIN_NETWORK\] platform not initialised$/)
    expect(x.sessions.size).toBe(0)
  })

  // nodeterm-server's per-IP limiter (src/routes/relay.ts:104, body from src/lib/rate-limit.ts:77):
  // shared by /device and /join, 30 a minute, no Retry-After. Its 429 clears within a minute.
  const IP_429: [number, unknown] = [429, { error: 'rate_limited', scope: 'ip' }]

  it('R41: a throttled /v1/relay/join is E_JOIN_THROTTLED (retryable), and the device token is kept', async () => {
    const s = setup({ routes: { device: [DEVICE_OK('KEEP')], join: [IP_429, JOIN_OK] } })
    const err = await connectHostedTeam(codeText, s.deps, io().io).catch((e: Error) => e)
    expect(joinErrorCode((err as Error).message)).toBe('E_JOIN_THROTTLED')
    // The retry a minute later presents the SAME token: a throttle costs no mint.
    await connectHostedTeam(codeText, s.deps, io().io)
    expect(s.api.count('device')).toBe(1)
    expect(s.api.calls.filter((c) => c.route === 'join').map((c) => c.body.deviceToken)).toEqual(['KEEP', 'KEEP'])
  })

  it('R41: retrying a throttle is budget-safe — the mints never grow past what the service granted', async () => {
    // The device leg throttled once (no token granted, nothing to keep), then granted ONE token; the
    // join leg throttled once more. Three attempts, one granted mint, and every join presents it.
    const s = setup({ routes: { device: [IP_429, DEVICE_OK('GRANTED')], join: [IP_429, JOIN_OK] } })
    for (let i = 0; i < 2; i++) {
      const err = await connectHostedTeam(codeText, s.deps, io().io).catch((e: Error) => e)
      expect(joinErrorCode((err as Error).message)).toBe('E_JOIN_THROTTLED')
    }
    await connectHostedTeam(codeText, s.deps, io().io)
    expect(s.api.count('device')).toBe(2) // one throttled (no mint), one granted
    expect(s.api.calls.filter((c) => c.route === 'join').map((c) => c.body.deviceToken)).toEqual(['GRANTED', 'GRANTED'])
    expect((await s.store.list())[0]?.deviceToken).toBe('GRANTED')
  })

  it('R41: the device damper (a 429 with no scope) stays E_JOIN_RATE — the daily limit, never retried', async () => {
    const s = setup({ routes: { device: [[429, { error: 'rate_limited' }]] } })
    const err = await connectHostedTeam(codeText, s.deps, io().io).catch((e: Error) => e)
    expect(joinErrorCode((err as Error).message)).toBe('E_JOIN_RATE')
  })

  it('R41: a Retry-After the service sends crosses IPC with the throttle', async () => {
    const s = setup()
    const f = (async (url: string) =>
      url.endsWith('/v1/relay/device')
        ? new Response(JSON.stringify({ error: 'rate_limited', scope: 'ip' }), { status: 429, headers: { 'retry-after': '120' } })
        : new Response('{}', { status: 500 })) as unknown as typeof fetch
    const err = await connectHostedTeam(codeText, { ...s.deps, fetch: f }, io().io).catch((e: Error) => e)
    expect(joinErrorCode((err as Error).message)).toBe('E_JOIN_THROTTLED')
    expect(joinRetryAfterMs((err as Error).message)).toBe(120_000)
  })

  it('a failed join registers nothing and rejects with the human message', async () => {
    const s = setup({ routes: { device: [[429, {}]] } })
    const x = io()
    await expect(connectHostedTeam(codeText, s.deps, x.io)).rejects.toThrow('[E_JOIN_RATE] Too many join attempts for this team today. Try again tomorrow.')
    expect(x.sessions.size).toBe(0)
    expect(x.sent).toEqual([])
  })
})

describe('R38: never mint a device token the joiner cannot keep', () => {
  const joinTokens = (s: ReturnType<typeof setup>) => s.api.calls.filter((c) => c.route === 'join').map((c) => c.body.deviceToken)
  let warn: ReturnType<typeof vi.spyOn>
  beforeEach(() => { warn = vi.spyOn(console, 'warn').mockImplementation(() => {}) })
  afterEach(() => { warn.mockRestore() })

  it('a bookmarks file that cannot be rewritten refuses BEFORE any mint, on every attempt', async () => {
    const s = setup({ routes: { device: [DEVICE_OK('MINTED-1')], join: [[503, {}]] } })
    fs.writeFileSync(s.file, 'nope')
    for (let attempt = 0; attempt < 2; attempt++) {
      const err = (await joinHostedTeam(codeText, s.deps, events().ev).catch((e: Error) => e)) as HostedJoinError
      expect(err).toBeInstanceOf(HostedJoinError)
      expect(joinErrorCode(err.message)).toBe('E_JOIN_REFUSED')
      // Names the file and what to do; says nothing of a token or the code.
      expect(err.message).toContain(s.file)
      expect(err.message).toMatch(/fix or remove it/)
      expect(err.message).not.toContain('nodeterm://join')
    }
    expect(s.api.count('device')).toBe(0)
    expect(s.api.count('join')).toBe(0)
    expect(s.c.opened).toEqual([])
    expect(fs.readFileSync(s.file, 'utf8')).toBe('nope')
  })

  it('a persist that fails AFTER the probe keeps the token in memory: the retry presents it, no second mint', async () => {
    const s = setup({ failWrites: true, routes: { device: [DEVICE_OK('MINTED-1'), DEVICE_OK('MINTED-2')], join: [[503, {}], JOIN_OK] } })
    await expect(joinHostedTeam(codeText, s.deps, events().ev)).rejects.toMatchObject({ kind: 'network' })
    await joinHostedTeam(codeText, s.deps, events().ev)
    expect(s.api.count('device')).toBe(1)
    expect(joinTokens(s)).toEqual(['MINTED-1', 'MINTED-1'])
    // The failed writes were said, and never with the token.
    expect(warn).toHaveBeenCalled()
    for (const call of warn.mock.calls) expect(call.map(String).join(' ')).not.toContain('MINTED')
  })

  it('two connects for the same team at once mint exactly once; the duplicate is refused, not retried', async () => {
    const s = setup()
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const calls: string[] = []
    const gated = (async (url: string, init: RequestInit) => {
      if (url.endsWith('/v1/relay/device')) {
        calls.push('device')
        await gate
        return new Response(JSON.stringify({ deviceToken: 'DT', hostId: 'H', exp: 1 }), { status: 200 })
      }
      calls.push(`join:${JSON.parse(String(init.body)).deviceToken}`)
      return new Response(JSON.stringify({ pairingToken: 'PT', hostId: 'H', relayEndpoint: 'wss://r', exp: 1 }), { status: 200 })
    }) as unknown as typeof fetch
    const deps = { ...s.deps, fetch: gated }
    const io = (id: string) => ({ newId: () => id, send: () => {}, sessions: new Map<string, RelayClientSession>() })
    const first = connectHostedTeam(codeText, deps, io('a'))
    await vi.waitFor(() => expect(calls).toEqual(['device']))
    // A boot reconnect racing a manual connect (or a double click): refused, with a code that stops a retry loop.
    const dup = await connectHostedTeam(codeText, deps, io('b')).catch((e: Error) => e)
    // Its own code (R39): the renderer must never read "another attempt of yours is running" as a
    // verdict about the team, and it never retries it.
    expect(joinErrorCode((dup as Error).message)).toBe('E_JOIN_BUSY')
    expect((dup as Error).message).toMatch(/already joining this team/i)
    release()
    expect(await first).toBe('a')
    expect(calls).toEqual(['device', 'join:DT'])
    // Released once the first finished: a later connect goes ahead (and reuses the kept token).
    expect(await connectHostedTeam(codeText, deps, io('c'))).toBe('c')
    expect(calls.filter((c) => c === 'device')).toHaveLength(1)
  })

  it('R39: forgetting a team is refused while a join for it is still running (its persist would undo it)', async () => {
    const s = setup()
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const minted: string[] = []
    const gated = (async (url: string) => {
      if (url.endsWith('/v1/relay/device')) {
        minted.push('device')
        await gate
        return new Response(JSON.stringify({ deviceToken: 'DT', hostId: 'H', exp: 1 }), { status: 200 })
      }
      return new Response(JSON.stringify({ pairingToken: 'PT', hostId: 'H', relayEndpoint: 'wss://r', exp: 1 }), { status: 200 })
    }) as unknown as typeof fetch
    const running = joinHostedTeam(codeText, { ...s.deps, fetch: gated }, events().ev)
    await vi.waitFor(() => expect(minted).toEqual(['device']))
    const refused = await removeHostedBookmark(code.hostId, s.store, s.state).catch((e: Error) => e)
    expect(refused).toBeInstanceOf(Error)
    expect((refused as Error).message).toMatch(/still joining/i)
    release()
    await running
    // The join's own persist landed, and nothing was removed out from under it.
    expect((await s.store.list()).map((b) => b.hostId)).toEqual([code.hostId])
    // Once it finished, forgetting works — token and bookmark both.
    await removeHostedBookmark(code.hostId, s.store, s.state)
    expect(await s.store.list()).toEqual([])
  })

  it('R39: a bookmarks directory no write could land in refuses the join before any mint', async () => {
    const s = setup()
    const locked = new BookmarkStore(s.store.file, {
      access: async () => { throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }) }
    })
    const err = await joinHostedTeam(codeText, { ...s.deps, bookmarks: locked }, events().ev).catch((e: Error) => e)
    expect(joinErrorCode((err as Error).message)).toBe('E_JOIN_REFUSED')
    expect((err as Error).message).toContain(s.store.file)
    expect(s.api.count('device')).toBe(0)
    expect(s.api.count('join')).toBe(0)
  })

  it('revoked forgets the in-memory token: the next attempt mints fresh', async () => {
    const s = setup({ failWrites: true, routes: { device: [DEVICE_OK('MINTED-1'), DEVICE_OK('MINTED-2')], join: [[403, {}], JOIN_OK] } })
    await expect(joinHostedTeam(codeText, s.deps, events().ev)).rejects.toMatchObject({ kind: 'revoked' })
    await joinHostedTeam(codeText, s.deps, events().ev)
    expect(s.api.count('device')).toBe(2)
    expect(joinTokens(s)).toEqual(['MINTED-1', 'MINTED-2'])
  })

  it('bad-token forgets the in-memory token: the next attempt mints fresh', async () => {
    const s = setup({ failWrites: true, routes: { device: [DEVICE_OK('MINTED-1'), DEVICE_OK('MINTED-2')], join: [[401, {}], JOIN_OK] } })
    await expect(joinHostedTeam(codeText, s.deps, events().ev)).rejects.toMatchObject({ kind: 'bad-token' })
    await joinHostedTeam(codeText, s.deps, events().ev)
    expect(s.api.count('device')).toBe(2)
    expect(joinTokens(s)).toEqual(['MINTED-1', 'MINTED-2'])
  })

  it('the re-mint path still works from an in-memory token: 401 on it earns exactly one fresh mint', async () => {
    const s = setup({ failWrites: true, routes: { device: [DEVICE_OK('MINTED-1'), DEVICE_OK('MINTED-2')], join: [[503, {}], [401, {}], JOIN_OK] } })
    await expect(joinHostedTeam(codeText, s.deps, events().ev)).rejects.toMatchObject({ kind: 'network' })
    await joinHostedTeam(codeText, s.deps, events().ev)
    expect(s.api.count('device')).toBe(2)
    expect(joinTokens(s)).toEqual(['MINTED-1', 'MINTED-1', 'MINTED-2'])
  })

  it('a kept in-memory token wins over the older one still in the bookmark', async () => {
    // Bookmark holds OLD; OLD earns a 401 and one re-mint (NEW), whose persist fails; the join then
    // drops (503). The retry must present NEW, not the rejected OLD.
    const s = setup({ failWrites: true, bookmarks: [bookmark()], routes: { device: [DEVICE_OK('NEW')], join: [[401, {}], [503, {}], JOIN_OK] } })
    await expect(joinHostedTeam(codeText, s.deps, events().ev)).rejects.toMatchObject({ kind: 'network' })
    await joinHostedTeam(codeText, s.deps, events().ev)
    expect(s.api.count('device')).toBe(1)
    expect(joinTokens(s)).toEqual(['OLD', 'NEW', 'NEW'])
  })

  it('forgetting a team through the bookmark-remove path forgets its in-memory token too', async () => {
    const s = setup({ routes: { device: [DEVICE_OK('MINTED-1'), DEVICE_OK('MINTED-2')], join: [JOIN_OK] } })
    await joinHostedTeam(codeText, s.deps, events().ev)
    await removeHostedBookmark(code.hostId, s.store, s.state)
    expect(await s.store.list()).toEqual([])
    await joinHostedTeam(codeText, s.deps, events().ev)
    expect(s.api.count('device')).toBe(2)
    expect(joinTokens(s)).toEqual(['MINTED-1', 'MINTED-2'])
  })

  it('the in-memory token is forgotten even when the bookmarks file refuses the removal', async () => {
    const s = setup({ failWrites: true, routes: { device: [DEVICE_OK('MINTED-1'), DEVICE_OK('MINTED-2')], join: [JOIN_OK] } })
    await joinHostedTeam(codeText, s.deps, events().ev) // token held in memory only
    fs.writeFileSync(s.file, 'nope')
    await expect(removeHostedBookmark(code.hostId, s.store, s.state)).rejects.toThrow()
    fs.rmSync(s.file)
    await joinHostedTeam(codeText, s.deps, events().ev)
    expect(joinTokens(s)).toEqual(['MINTED-1', 'MINTED-2'])
  })

  it('an id that cannot be minted still leaves with a stable code', async () => {
    const s = setup()
    const io = { newId: () => { throw new Error('no entropy') }, send: () => {}, sessions: new Map<string, RelayClientSession>() }
    await expect(connectHostedTeam(codeText, s.deps, io)).rejects.toThrow(/^\[E_JOIN_NETWORK\] no entropy$/)
  })
})

// ── End to end: the real core relay client against the real hosted service. ──────────────────────

const live: Array<{ svc: HostedService; dir: string }> = []
afterEach(() => {
  for (const w of live.splice(0)) {
    w.svc.stop()
    fs.rmSync(w.dir, { recursive: true, force: true })
  }
})

function hostedWorld() {
  const dir = tmpDir()
  const peersT: RelayTransport[] = []
  let next = 1
  const attach: PeerAttach = {
    attach: () => next++,
    detach: () => {},
    dispatch: async (_id, req) => ({ t: 'res', id: req.id, ok: true, result: null }),
    cast: () => {}
  }
  const svc = createHostedService({
    dataDir: dir, apiBase: 'https://api', relayUrl: 'ws://127.0.0.1/r', deviceId: 'host-dev', hostLabel: 'box',
    attach, projectsOfNode: () => ['P'], nodeOfSession: () => undefined, projectCwd: () => '/srv/app',
    // Routed by URL: the hosted mint asks for a key-proof challenge first (relay-pop.ts). A 404 is a
    // pre-proof backend, so the legacy mint follows; answering it with a token body would read as a
    // malformed challenge and no listener would ever open.
    fetch: (async (u: string | URL | Request) =>
      String(u).endsWith('/v1/relay/challenge')
        ? new Response('{}', { status: 404 })
        : new Response(JSON.stringify({ pairingToken: 'T', hostId: 'H', exp: 0 }), { status: 200 })) as typeof fetch,
    transport: () => { const { hostT, peerT } = transportPair(); peersT.push(peerT); return hostT }
  })
  live.push({ svc, dir })
  // The real core client, over the next listener's in-process transport.
  const connect = (o: HostedConnectOptions) => connectRelayClient({ ...o, transport: peersT.shift()! })
  return { svc, dir, connect }
}

describe('joinHostedTeam against the hosted service', () => {
  it('first join asks both humans; the reconnect confirms itself; a removal reaches onClosed and drops the pin', async () => {
    const w = hostedWorld()
    const ownerKeys = genKeyPair()
    await w.svc.init()
    await w.svc.addOwner(pub(ownerKeys), 'Enes')
    await w.svc.share('P', true)
    expect(await w.svc.start()).toBe('started')
    await vi.waitFor(() => expect(w.svc.status().scheduler?.idle).toBe(1))

    const ownerFrames: string[] = []
    let ownerOpen = false
    const owner = w.connect({
      url: 'ws://127.0.0.1/r', token: 'T', hostKeyB64: w.svc.info()!.hostPublicKeyB64, ourKeys: ownerKeys, autoApprove: true,
      onSas: () => {}, onApproved: () => { ownerOpen = true }, onFrame: (j) => ownerFrames.push(j), onPtyData: () => {}, onClose: () => {}
    })
    await vi.waitFor(() => expect(ownerOpen).toBe(true))

    const joinerKeys = genKeyPair()
    const store = new BookmarkStore(path.join(w.dir, 'relay-bookmarks.json'))
    const a = api({ device: [DEVICE_OK()], join: [[200, { pairingToken: 'T', hostId: 'H', relayEndpoint: 'ws://127.0.0.1/r', exp: 1 }]] })
    const deps: HostedJoinDeps = { apiBase: 'https://api', deviceId: () => 'joiner-dev', label: 'laptop', bookmarks: store, loadKeys: async () => joinerKeys, connect: w.connect, fetch: a.f }
    const joinCode = w.svc.joinCode()!

    // 1. First join: the SAS is shown, the human confirms, an owner approves.
    await vi.waitFor(() => expect(w.svc.status().scheduler?.idle).toBe(1))
    const e1 = events()
    const s1 = await joinHostedTeam(joinCode, deps, e1.ev)
    expect(e1.log.some((l) => l.startsWith('sas:'))).toBe(true)
    s1.confirm()
    await vi.waitFor(() => expect(w.svc.status().pending.some((p) => p.peerKeyB64 === pub(joinerKeys))).toBe(true))
    const pendingId = w.svc.status().pending.find((p) => p.peerKeyB64 === pub(joinerKeys))!.pendingId
    owner.send(JSON.stringify({ t: 'req', id: 1, method: IPC.relayHostedApprove, args: [pendingId, 'viewer'] }))
    await vi.waitFor(() => expect(e1.log).toContain('approved'))
    await vi.waitFor(async () => expect((await store.list())[0]?.approvedAt).not.toBeNull())
    s1.close()

    // 2. Reconnect: no SAS for this human, no device mint, and it opens on the host's pin alone.
    await vi.waitFor(() => expect(w.svc.status().scheduler?.idle).toBe(1))
    const e2 = events()
    await joinHostedTeam(joinCode, deps, e2.ev)
    await vi.waitFor(() => expect(e2.log).toContain('approved'))
    expect(e2.log.some((l) => l.startsWith('sas:'))).toBe(false)
    expect(a.count('device')).toBe(1)

    // 3. An owner removes this device: the reason reaches onClosed, and the pin is withdrawn.
    expect(await w.svc.remove(pub(joinerKeys), false)).toBe('removed')
    await vi.waitFor(() => expect(e2.closed).toEqual(['removed']))
    await vi.waitFor(async () => expect((await store.list())[0].approvedAt).toBeNull())
  })
})
