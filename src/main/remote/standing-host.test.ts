// Standing-host presence wiring: a bridged relay client (a phone) is a `kind:'phone'` peer, and
// EVERY end path for that session — the relay socket dropping, the human rejecting the device, an
// idle-token teardown, the host being disabled / the app quitting — must reach presenceHub.leave()
// exactly once. A missed leave is a permanent ghost cursor in everyone's facepile.
//
// electron + the relay/license/disk modules are mocked; what's under test is the standing host's
// own bookkeeping.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import nacl from 'tweetnacl'
import { initPlatform, platform, resetPlatformForTests } from '../../core/platform'
import { fakePlatform } from '../../core/platform-fake'
import { presenceHub } from '../../core/presence/hub'
import type { ApprovedDevices } from './approved-devices-core'
import type { HostSession, HostSessionOptions } from './host-service'
import { createTestPopServer } from '../../core/relay/relay-pop.test-server'
import { POP_REFUSED_MESSAGE_DESKTOP } from '../../core/relay/relay-pop'

// The host's key pair: a REAL X25519 pair, so the standing host can compute a key proof that the
// test pop server (a mirror of the backend's verify) accepts or refuses on the real bytes.
const hostKeys = nacl.box.keyPair()
const hostPubB64 = Buffer.from(hostKeys.publicKey).toString('base64')
// Swappable: null = the free tier (mint by deviceId), a string = a stored Pro entitlement.
let storedEntitlement: string | null = 'entitlement'

const ipc: Record<string, (e: unknown, msg: unknown) => any> = {}
const errorBoxes: Array<{ title: string; body: string }> = []

vi.mock('electron', () => ({
  ipcMain: {
    handle: (ch: string, fn: (e: unknown, msg: unknown) => unknown) => { ipc[ch] = fn },
    on: (ch: string, fn: (e: unknown, msg: unknown) => void) => {
      ipc[ch] = fn
    }
  },
  dialog: {
    showErrorBox: (title: string, body: string) => errorBoxes.push({ title, body })
  }
}))
vi.mock('../../core/pty-manager', () => ({ PtyManager: class {} }))
vi.mock('../../core/license', () => ({
  isPremium: () => true,
  getStoredEntitlement: () => storedEntitlement
}))
vi.mock('./host-canvas-hub', () => ({
  initHostCanvasHub: () => {},
  currentCanvas: () => null,
  subscribeCanvas: () => () => {}
}))
let disk: ApprovedDevices = { pubkeys: [] }
const persist = vi.fn(async (update: (s: ApprovedDevices) => ApprovedDevices) => { disk = update(disk) })
// Counted: stop() withdraws the advertisement, which is how a refused host stops inviting phones.
let advertisementsRemoved = 0
vi.mock('./relay-advertise', () => ({
  writeRelayAdvertisement: async () => {},
  removeRelayAdvertisement: async () => {
    advertisementsRemoved += 1
  }
}))
// Per-role pin stores (approved-devices.ts), in memory. The 'phone' store — the one this module
// must write — is `disk`; every other role lives in `otherPins`, so a pin landing in the WRONG
// store is visible to the assertions instead of indistinguishable from the right one.
const otherPins: Record<string, ApprovedDevices> = {}
vi.mock('./approved-devices', () => {
  const mem = (role: string) => {
    const get = (): ApprovedDevices => (role === 'phone' ? disk : (otherPins[role] ??= { pubkeys: [] }))
    const set = (s: ApprovedDevices): void => {
      if (role === 'phone') disk = s
      else otherPins[role] = s
    }
    return {
      load: async () => get(),
      save: async (s: ApprovedDevices) => set(s),
      update: role === 'phone' ? (u: (s: ApprovedDevices) => ApprovedDevices) => persist(u) : async (u: (s: ApprovedDevices) => ApprovedDevices) => set(u(get()))
    }
  }
  const stores: Record<string, ReturnType<typeof mem>> = { phone: mem('phone'), guest: mem('guest'), joinedHost: mem('joinedHost') }
  return {
    PIN_ROLES: ['phone', 'guest', 'joinedHost'],
    phonePins: stores.phone,
    loadApprovedDevices: () => stores.phone.load(),
    saveApprovedDevices: (s: ApprovedDevices) => stores.phone.save(s),
    updateApprovedDevices: (u: (s: ApprovedDevices) => ApprovedDevices) => stores.phone.update(u),
    guestPins: stores.guest,
    joinedHostPins: stores.joinedHost,
    pinStore: (r: string) => stores[r],
    retireLegacyPinFile: async () => 0
  }
})
vi.mock('./e2ee', () => ({ publicKeyToB64: (k: Uint8Array) => Buffer.from(k).toString('base64') }))

const sessions: Array<{
  opts: HostSessionOptions
  session: HostSession
  closed: number
  /** The bridged phone's box key (null before its handshake, as on a real idle listener). */
  peer: string | null
  /** Make close() throw, as a teardown failure would. */
  closeThrows?: boolean
}> = []

// Swappable: a locked OS keyring makes the host key unreadable, and loading it REJECTS rather than
// rotating the pinned identity (host-identity.ts). The standing host must handle that, loudly.
let keyError: Error | null = null

vi.mock('./host-service', () => ({
  API_BASE: 'https://api.test',
  RELAY_URL: 'wss://relay.test',
  relayAllowed: () => true,
  loadOrCreateKeyPair: async () => {
    if (keyError) throw keyError
    return hostKeys
  },
  connectHostSession: (opts: HostSessionOptions): HostSession => {
    const entry: (typeof sessions)[number] = { opts, closed: 0, peer: 'phone-pub', session: null as unknown as HostSession }
    entry.session = {
      approve: vi.fn(),
      isApproved: () => false,
      sas: () => '12345',
      // A real relay socket close() is "intentional" and does NOT fire onClose — modelled here.
      peerPublicKeyB64: () => entry.peer,
      close: () => {
        entry.closed += 1
        if (entry.closeThrows) throw new Error('teardown failed')
      }
    }
    sessions.push(entry)
    return entry.session
  }
}))

// The peer revoker also cuts relay-host (peer desktop) sessions; that host is not under test here.
const relayHostKills = vi.fn((_pub: string) => {})
vi.mock('./relay-host', () => ({ killRelayHostsByPeerKey: (pub: string) => relayHostKills(pub) }))

import {
  initStandingHost,
  tokenTtlMs,
  killStandingHostSessionsByPeerKey,
  rememberRevokedStandingPhone,
  resetRevokedPhonesForTests,
  REVOKED_PHONE_DENY_MS,
  type StandingHostOptions
} from './standing-host'
import { createPeerRevoker } from './peer-revoker'
import { revokeAllPhones, revokePeerKey } from './peer-revoke'
import { IPC } from '../../shared/ipc'

/** Let the async connectOne() chain (keypair, key-proof challenge, token mint) settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 40; i++) await Promise.resolve()
}

// ── fetch, routed by URL ──────────────────────────────────────────────────────────────────────
// A mint is now TWO requests: `/v1/relay/challenge` (the key-proof challenge), then
// `/v1/relay/host-token`. Every "how many mints" assertion counts host-token calls only.
interface FakeRes {
  ok: boolean
  status: number
  headers?: Headers
  json: () => Promise<unknown>
}
type Route = (init: RequestInit) => FakeRes | Promise<FakeRes>
const res = (status: number, body: unknown = {}, headers?: Headers): FakeRes => ({
  ok: status >= 200 && status < 300,
  status,
  ...(headers ? { headers } : {}),
  json: async () => body
})
/** A backend that predates the key proof: no challenge route. */
const challengeUnsupported: Route = () => res(404)
const hostTokenOk: Route = () => res(200, { pairingToken: 'tok', hostId: 'host', exp: 0 })
/** A challenge route answered by the backend's own issue() (mirrored in relay-pop.test-server). */
const challengeFrom =
  (pop: ReturnType<typeof createTestPopServer>): Route =>
  (init) => {
    const b = JSON.parse(String(init.body)) as { hostPublicKeyB64: string; purpose: 'host-token' | 'push' }
    return res(200, pop.issue(b.hostPublicKeyB64, b.purpose))
  }

let fetchMock: ReturnType<typeof vi.fn<(url: string, init: RequestInit) => Promise<FakeRes>>>
function routeFetch(r: { challenge?: Route; hostToken?: Route } = {}): void {
  const challenge = r.challenge ?? challengeUnsupported
  const hostToken = r.hostToken ?? hostTokenOk
  fetchMock = vi.fn(async (url: string, init: RequestInit) => {
    if (url.endsWith('/v1/relay/challenge')) return challenge(init)
    if (url.endsWith('/v1/relay/host-token')) return hostToken(init)
    throw new Error(`unexpected fetch ${url}`)
  })
  vi.stubGlobal('fetch', fetchMock)
}
const callsTo = (suffix: string): Array<[string, RequestInit]> =>
  fetchMock.mock.calls.filter(([url]) => url.endsWith(suffix))
/** Host-token mints only — the challenge request is not a mint. */
const mintCalls = (): Array<[string, RequestInit]> => callsTo('/v1/relay/host-token')
const challengeCalls = (): Array<[string, RequestInit]> => callsTo('/v1/relay/challenge')
const mintBody = (i = -1): Record<string, unknown> =>
  JSON.parse(String(mintCalls().at(i)![1].body)) as Record<string, unknown>

function phones(): number {
  return presenceHub.peers().filter((p) => p.kind === 'phone').length
}

const sentToWin: Array<{ channel: string; args: unknown[] }> = []

let sender: unknown
// Every host a test made, stopped after it even when an assertion threw first: a running host stays
// registered for revocation, so one left running would answer a later test's revoke.
const hosts: Array<{ stop(): void }> = []
function makeHost(options: StandingHostOptions = {}) {
  const win = {
    isDestroyed: () => false,
    webContents: {
      send: (channel: string, ...args: unknown[]) => sentToWin.push({ channel, args })
    }
  }
  sender = win.webContents
  const host = initStandingHost(win as never, {} as never, () => ({ phoneAccessEnabled: true }) as never, undefined, undefined, options)
  hosts.push(host)
  return host
}

/** The pending-approval id the host just surfaced to the human (SAS dialog). */
function pendingApprovalId(): string {
  const msg = sentToWin.filter((s) => s.channel === IPC.remoteHostPeerPending).at(-1)
  return (msg?.args[0] as { id: string }).id
}

beforeEach(() => {
  initPlatform(fakePlatform())
  sessions.length = 0
  sentToWin.length = 0
  errorBoxes.length = 0
  persist.mockReset()
  disk = { pubkeys: [] }
  for (const k of Object.keys(otherPins)) delete otherPins[k]
  persist.mockImplementation(async (update) => { disk = update(disk) })
  relayHostKills.mockReset()
  resetRevokedPhonesForTests()
  keyError = null
  storedEntitlement = 'entitlement'
  advertisementsRemoved = 0
  for (const key of Object.keys(ipc)) delete ipc[key]
  routeFetch()
})

afterEach(() => {
  for (const host of hosts.splice(0)) host.stop()
  vi.useRealTimers()
  for (const p of presenceHub.peers()) presenceHub.leave(p.clientId)
  vi.unstubAllGlobals()
  resetPlatformForTests()
})

describe('standing host presence peers', () => {
  it('forwards the exact optional legacy pairing store into the real session factory', async () => {
    const pairings: NonNullable<StandingHostOptions['legacyRelayPairings']> = {
      inspect: vi.fn(async () => ({ status: 'unprovable' as const })),
      associate: vi.fn(async () => ({ status: 'associated' as const }))
    }
    const host = makeHost({ legacyRelayPairings: pairings })
    host.setEnabled(true); await settle()
    expect(sessions).toHaveLength(1)
    expect(sessions[0].opts.legacyRelayPairings).toBe(pairings)
    expect(await sessions[0].opts.legacyRelayPairings!.inspect('fixture-id', 'fixture-peer')).toEqual({ status: 'unprovable' })
    expect(pairings.inspect).toHaveBeenCalledWith('fixture-id', 'fixture-peer')
  })
  it('a bridged relay client joins as a cursorless phone peer and leaves when the socket drops', async () => {
    const host = makeHost()
    host.setEnabled(true)
    await settle()
    expect(sessions).toHaveLength(1)
    expect(phones()).toBe(0) // an idle (un-bridged) listener is nobody

    sessions[0].opts.onPeerReady(sessions[0].session)
    await settle()
    const peer = presenceHub.peers().find((p) => p.kind === 'phone')
    expect(peer).toBeDefined()
    expect(peer?.cursor).toBeNull() // a phone has no mouse — never fabricate one
    expect(peer?.name).toBe('Phone')
    expect(peer!.clientId).toBeGreaterThanOrEqual(1_000_000) // relay id range

    // Clean disconnect (relay socket dropped) → the peer leaves.
    sessions[0].opts.onClose()
    expect(phones()).toBe(0)

    host.stop()
  })

  it('leaves the hub when the human rejects the device (close() never fires onClose)', async () => {
    const host = makeHost()
    host.setEnabled(true)
    await settle()
    sessions[0].opts.onPeerReady(sessions[0].session)
    await settle()
    expect(phones()).toBe(1)

    // Reject → removeFromPool → session.close(). A real relay socket treats an intentional close
    // as final and does NOT call onClose, so the leave has to happen on this path too.
    ipc[IPC.remoteHostReject]({ sender }, { id: pendingApprovalId(), pub: 'phone-pub' })
    expect(sessions[0].closed).toBe(1)
    expect(phones()).toBe(0)

    host.stop()
  })

  it('leaves the hub when the host is disabled / the app quits (stop() tears the pool down)', async () => {
    const host = makeHost()
    host.setEnabled(true)
    await settle()
    sessions[0].opts.onPeerReady(sessions[0].session)
    await settle()
    expect(phones()).toBe(1)

    host.stop()
    expect(phones()).toBe(0)
  })

  it('a bridged peer leaves exactly once even if close() and onClose() both fire', async () => {
    const host = makeHost()
    host.setEnabled(true)
    await settle()
    sessions[0].opts.onPeerReady(sessions[0].session)
    await settle()
    const id = presenceHub.peers().find((p) => p.kind === 'phone')!.clientId

    host.stop() // → removeFromPool → close() → leave
    sessions[0].opts.onClose() // a late transport close still arrives → must be a no-op
    expect(phones()).toBe(0)

    // The id must not be recycled onto some other peer by a double-leave.
    presenceHub.join(id, 'phone')
    expect(phones()).toBe(1)
    presenceHub.leave(id)
  })
})

describe('standing host: the host key cannot be read (locked keyring)', () => {
  it('stops loudly instead of retrying into a dead listener', async () => {
    keyError = Object.assign(new Error('the OS keyring is locked'), {
      code: 'E_HOST_KEY_LOCKED'
    })
    const host = makeHost()
    host.setEnabled(true)
    await settle()

    // Nothing was registered at the relay (no key ⇒ no identity to advertise) and, crucially,
    // the failure is not swallowed: the user is told, once, what happened and how to recover.
    expect(sessions).toHaveLength(0)
    expect(errorBoxes).toHaveLength(1)
    expect(errorBoxes[0].body).toMatch(/keyring/i)

    // Bounded: no reconnect storm re-raising the dialog every second.
    await settle()
    expect(errorBoxes).toHaveLength(1)
    expect(sessions).toHaveLength(0)

    host.stop()
  })
})


describe('standing phone approval lifecycle (#819)', () => {
  async function pending() {
    const host = makeHost()
    host.setEnabled(true)
    await settle()
    sessions[0].opts.onPeerReady(sessions[0].session)
    await settle()
    return { host, msg: { id: pendingApprovalId(), pub: 'phone-pub' } }
  }
  it('pins the displayed handshake after its browse socket closes, without approving a dead session', async () => {
    const { host, msg } = await pending()
    sessions[0].opts.onClose()
    expect(await ipc[IPC.remotePhoneApprove]({ sender }, msg)).toEqual({ status: 'saved-disconnected' })
    expect(persist).toHaveBeenCalledOnce()
    expect(sessions[0].session.approve).not.toHaveBeenCalled()
    expect(disk.pubkeys).toEqual(['phone-pub'])
    const count = sentToWin.filter((s) => s.channel === IPC.remoteHostPeerPending).length
    sessions[1].opts.onPeerReady(sessions[1].session)
    await settle()
    expect(sessions[1].session.approve).toHaveBeenCalledOnce()
    expect(sentToWin.filter((s) => s.channel === IPC.remoteHostPeerPending)).toHaveLength(count)
    host.stop()
  })
  it('waits for persistence before granting access', async () => {
    const { host, msg } = await pending()
    let release!: () => void
    persist.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve }))
    const approval = ipc[IPC.remotePhoneApprove]({ sender }, msg)
    expect(sessions[0].session.approve).not.toHaveBeenCalled()
    release()
    expect(await approval).toEqual({ status: 'approved' })
    expect(sessions[0].session.approve).toHaveBeenCalledOnce()
    host.stop()
  })
  it('reports a failed write and grants no access', async () => {
    const { host, msg } = await pending()
    persist.mockRejectedValueOnce(Object.assign(new Error('fixture'), { code: 'EACCES' }))
    expect(await ipc[IPC.remotePhoneApprove]({ sender }, msg)).toEqual({ status: 'persistence-failed' })
    expect(sessions[0].session.approve).not.toHaveBeenCalled()
    host.stop()
  })
  it('rejects stale, mismatched and non-owner requests without writing', async () => {
    const { host, msg } = await pending()
    for (const [owner, request] of [[{}, msg], [sender, { ...msg, pub: 'other' }], [sender, { ...msg, id: 'stale' }]]) {
      expect(await ipc[IPC.remotePhoneApprove]({ sender: owner }, request)).toEqual({ status: 'stale' })
    }
    expect(persist).not.toHaveBeenCalled()
    host.stop()
    expect(await ipc[IPC.remotePhoneApprove]({ sender }, msg)).toEqual({ status: 'stale' })
  })
  it('host stop during a save never grants a closed session access', async () => {
    const { host, msg } = await pending()
    let release!: () => void
    persist.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve }))
    const approval = ipc[IPC.remotePhoneApprove]({ sender }, msg)
    host.stop()
    release()
    expect(await approval).toEqual({ status: 'saved-disconnected' })
    expect(sessions[0].session.approve).not.toHaveBeenCalled()
  })
})

describe('revoking a phone cuts its live relay session (audit A07-revoke)', () => {
  // Unpinning a key only refuses its NEXT handshake: a phone that is connected while it is forgotten
  // would keep serving terminals, files and the canvas until its socket dropped on its own. The
  // revoke (Settings → Phone → Revoke, through pairing-service's revokeRelayKey, or
  // `remote:revoke-peer`) goes through the peer revoker, which unpins and then closes it.

  /** Bridge the newest idle listener to `peer`, as a phone completing its handshake does. */
  async function bridge(peer: string) {
    const entry = sessions.at(-1)!
    entry.peer = peer
    entry.opts.onPeerReady(entry.session)
    await settle()
    const replacement = sessions.at(-1)!
    expect(replacement).not.toBe(entry) // the pool opened a fresh listener for the next phone…
    replacement.peer = null // …which has no phone yet
    return entry
  }
  function pendingFor(pub: string) {
    return sentToWin.filter((s) => s.channel === IPC.remoteHostPeerPending).map((s) => s.args[0] as { id: string; pub: string })
      .filter((m) => m.pub === pub)
  }

  it('closes every session of the revoked phone, unpins it, and leaves other phones alone', async () => {
    disk = { pubkeys: ['phone-A', 'phone-B'] }
    const host = makeHost()
    host.setEnabled(true)
    await settle()
    const a1 = await bridge('phone-A')
    const b = await bridge('phone-B')
    const a2 = await bridge('phone-A') // the same phone, a second concurrent session
    const idle = sessions.at(-1)!
    expect([a1, b, a2].map((e) => (e.session.approve as ReturnType<typeof vi.fn>).mock.calls.length)).toEqual([1, 1, 1])
    expect(phones()).toBe(3)

    expect(await createPeerRevoker().revoke('phone-A')).toEqual({ persisted: true, killed: true })

    expect(disk.pubkeys).toEqual(['phone-B'])
    expect([a1.closed, a2.closed]).toEqual([1, 1])
    expect([b.closed, idle.closed]).toEqual([0, 0])
    expect(phones()).toBe(1) // the revoked phone left the facepile; the other is still there
    expect(relayHostKills).toHaveBeenCalledWith('phone-A') // and any peer-desktop session of that key

    // A reconnect from the revoked phone is no longer auto-approved (the review of A07-revoke covers
    // what it gets instead, below).
    const again = await bridge('phone-A')
    expect(again.session.approve).not.toHaveBeenCalled()
    host.stop()
  })

  it('withdraws a pending approval, including one that outlived its socket (#819)', async () => {
    const host = makeHost()
    host.setEnabled(true)
    await settle()
    const live = await bridge('phone-A')
    const liveMsg = pendingFor('phone-A')[0]
    expect(killStandingHostSessionsByPeerKey('phone-A')).toBe(1)
    expect(live.closed).toBe(1)
    expect(await ipc[IPC.remotePhoneApprove]({ sender }, liveMsg)).toEqual({ status: 'stale' })

    const gone = await bridge('phone-C')
    const goneMsg = pendingFor('phone-C')[0]
    gone.opts.onClose() // the browse socket closed; its consent record is kept for the human
    expect(killStandingHostSessionsByPeerKey('phone-C')).toBe(0) // no session left to close…
    expect(await ipc[IPC.remotePhoneApprove]({ sender }, goneMsg)).toEqual({ status: 'stale' }) // …but no re-pin either
    const cleared = sentToWin.filter((s) => s.channel === IPC.remoteHostPeerPendingCleared).map((s) => (s.args[0] as { id: string }).id)
    expect(cleared).toEqual(expect.arrayContaining([liveMsg.id, goneMsg.id]))
    expect(persist).not.toHaveBeenCalled()
    host.stop()
  })

  it('keeps cutting when one teardown throws, and the revoke reports the cut as unconfirmed', async () => {
    disk = { pubkeys: ['phone-A'] }
    const host = makeHost()
    host.setEnabled(true)
    await settle()
    const first = await bridge('phone-A')
    const second = await bridge('phone-A')
    first.closeThrows = true
    expect(await createPeerRevoker().revoke('phone-A')).toEqual({ persisted: true, killed: false })
    expect([first.closed, second.closed]).toEqual([1, 1])
    expect(phones()).toBe(0)
    host.stop()
  })

  it('a stopped host has nothing to cut', async () => {
    disk = { pubkeys: ['phone-A'] }
    const host = makeHost()
    host.setEnabled(true)
    await settle()
    const a = await bridge('phone-A')
    host.stop()
    expect(a.closed).toBe(1)
    expect(killStandingHostSessionsByPeerKey('phone-A')).toBe(0)
    expect(a.closed).toBe(1)
  })
})

describe('a phone revoked during this run is refused without a dialog (review of A07-revoke)', () => {
  // Cutting the session makes the phone redial (the Android client does so 1.5 s after a drop). With
  // its key unpinned and its pairing gone, that handshake used to raise the SAS dialog for the phone
  // the user had just removed, and approving it pinned the key again. It is now left unapproved, so
  // every request it makes hears "Awaiting host approval.", and closed after REVOKED_PHONE_DENY_MS:
  // what a human's Deny looks like to the phone, which then stops dialing on its own.

  async function bridge(peer: string) {
    const entry = sessions.at(-1)!
    entry.peer = peer
    entry.opts.onPeerReady(entry.session)
    await settle()
    sessions.at(-1)!.peer = null // the replacement listener has no phone yet
    return entry
  }
  const dialogsFor = (pub: string) =>
    sentToWin.filter((s) => s.channel === IPC.remoteHostPeerPending && (s.args[0] as { pub: string }).pub === pub)

  it('a redial after the revoke raises no dialog, stays unapproved, and is closed like a Deny', async () => {
    vi.useFakeTimers()
    disk = { pubkeys: ['phone-A'] }
    const host = makeHost()
    host.setEnabled(true)
    await settle()
    const live = await bridge('phone-A')
    expect(await createPeerRevoker().revoke('phone-A')).toEqual({ persisted: true, killed: true })
    expect(live.closed).toBe(1)

    const again = await bridge('phone-A')
    expect(dialogsFor('phone-A')).toEqual([]) // nothing on the desk to approve by mistake
    expect(again.session.approve).not.toHaveBeenCalled()
    expect(phones()).toBe(1)
    // Not at once: the phone must first hear that it awaits approval, or it reads a plain failure.
    vi.advanceTimersByTime(REVOKED_PHONE_DENY_MS - 1)
    expect(again.closed).toBe(0)
    vi.advanceTimersByTime(1)
    expect(again.closed).toBe(1)
    expect(phones()).toBe(0)
    expect(disk.pubkeys).toEqual([]) // and nothing pinned it again
    await settle()
    expect(sessions.filter((e) => e.closed === 0)).toHaveLength(1) // the pool is topped back up
    host.stop()
  })

  it('a revoke while remote access is off counts too', async () => {
    vi.useFakeTimers()
    expect(killStandingHostSessionsByPeerKey('phone-Z')).toBe(0) // no host runs
    const host = makeHost()
    host.setEnabled(true)
    await settle()
    const later = await bridge('phone-Z')
    expect(dialogsFor('phone-Z')).toEqual([])
    vi.advanceTimersByTime(REVOKED_PHONE_DENY_MS)
    expect(later.closed).toBe(1)
    host.stop()
  })

  it('a pure revoke mark while hosting is off suppresses later SAS and permits explicit re-pair', async () => {
    vi.useFakeTimers()
    let paired = false
    const host = makeHost({ pinPairedPhone: async (pub) => paired && pub === 'phone-A' })
    rememberRevokedStandingPhone('phone-A')
    expect(sessions).toHaveLength(0) // the mark neither starts hosting nor tears a session down
    host.setEnabled(true)
    await settle()
    const refused = await bridge('phone-A')
    expect(dialogsFor('phone-A')).toEqual([])
    expect(refused.session.approve).not.toHaveBeenCalled()
    vi.advanceTimersByTime(REVOKED_PHONE_DENY_MS)
    expect(refused.closed).toBe(1)

    paired = true // a new explicit pairing recorded this key while relay access was off
    const repaired = await bridge('phone-A')
    expect(repaired.session.approve).toHaveBeenCalledOnce()
    expect(repaired.closed).toBe(0)
    expect(dialogsFor('phone-A')).toEqual([])
    const stranger = await bridge('phone-B')
    expect(dialogsFor('phone-B')).toHaveLength(1)
    expect(stranger.session.approve).not.toHaveBeenCalled()
    vi.advanceTimersByTime(REVOKED_PHONE_DENY_MS)
    expect([repaired.closed, stranger.closed]).toEqual([0, 0])
    host.stop()
  })

  it('pairing the phone again lets it in, and another phone still gets the dialog', async () => {
    vi.useFakeTimers()
    let paired = false
    const host = makeHost({ pinPairedPhone: async () => paired })
    host.setEnabled(true)
    await settle()
    killStandingHostSessionsByPeerKey('phone-A')

    const stranger = await bridge('phone-B')
    expect(dialogsFor('phone-B')).toHaveLength(1)
    vi.advanceTimersByTime(REVOKED_PHONE_DENY_MS)
    expect(stranger.closed).toBe(0) // only the revoked key is refused

    paired = true // re-paired with remote access off: the pairing recorded its key (A07-late)
    const repaired = await bridge('phone-A')
    expect(repaired.session.approve).toHaveBeenCalledOnce()
    disk = { pubkeys: ['phone-A'] } // or re-paired with it on: the scan pinned it (A07)
    paired = false
    const pinned = await bridge('phone-A')
    expect(pinned.session.approve).toHaveBeenCalledOnce()
    vi.advanceTimersByTime(REVOKED_PHONE_DENY_MS)
    expect([repaired.closed, pinned.closed]).toEqual([0, 0])
    expect(dialogsFor('phone-A')).toEqual([])
    host.stop()
  })

  it('a refused session that drops or is stopped first is not closed twice', async () => {
    vi.useFakeTimers()
    killStandingHostSessionsByPeerKey('phone-A')
    const host = makeHost()
    host.setEnabled(true)
    await settle()
    const dropped = await bridge('phone-A')
    dropped.opts.onClose() // the phone hung up on its own
    const stopped = await bridge('phone-A')
    host.stop()
    expect(stopped.closed).toBe(1)
    vi.advanceTimersByTime(REVOKED_PHONE_DENY_MS)
    expect([dropped.closed, stopped.closed]).toEqual([0, 1])
    expect(phones()).toBe(0)
  })
})

describe('a paired phone adopting the relay late is approved by its pairing, not a dialog (audit A07-late)', () => {
  // Pairing recorded the phone's relay key but did not pin it (no relay leg at the scan). The phone
  // adopts the relay over SSH later, and its first handshake here is usually made away from the desk.
  function pending(): Array<{ pub: string }> {
    return sentToWin.filter((s) => s.channel === IPC.remoteHostPeerPending).map((s) => s.args[0] as { pub: string })
  }

  it('approves the handshake silently when the pairing record pins the key', async () => {
    const asked: string[] = []
    const host = makeHost({ pinPairedPhone: async (pub) => (asked.push(pub), true) })
    host.setEnabled(true)
    await settle()
    sessions[0].opts.onPeerReady(sessions[0].session)
    await settle()
    expect(asked).toEqual(['phone-pub'])
    expect(sessions[0].session.approve).toHaveBeenCalledOnce()
    expect(pending()).toEqual([])
    host.stop()
  })

  it('a key no pairing recorded, or a check that fails, gets the dialog as before', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    for (const pinPairedPhone of [
      async () => false,
      async (): Promise<boolean> => {
        throw new Error('fixture')
      }
    ]) {
      sentToWin.length = 0
      sessions.length = 0
      const host = makeHost({ pinPairedPhone })
      host.setEnabled(true)
      await settle()
      sessions[0].opts.onPeerReady(sessions[0].session)
      await settle()
      expect(sessions[0].session.approve).not.toHaveBeenCalled()
      expect(pending().map((m) => m.pub)).toEqual(['phone-pub'])
      host.stop()
    }
    warn.mockRestore()
  })

  it('an already pinned phone never reaches the check, and an unverified handshake never does', async () => {
    const asked = vi.fn(async () => true)
    disk = { pubkeys: ['phone-pub'] }
    const host = makeHost({ pinPairedPhone: asked })
    host.setEnabled(true)
    await settle()
    sessions[0].opts.onPeerReady(sessions[0].session)
    await settle()
    expect(sessions[0].session.approve).toHaveBeenCalledOnce()
    disk = { pubkeys: [] }
    const unverified = sessions.at(-1)!
    unverified.session.sas = () => null as unknown as string
    unverified.opts.onPeerReady(unverified.session)
    await settle()
    expect(unverified.session.approve).not.toHaveBeenCalled()
    expect(asked).not.toHaveBeenCalled()
    host.stop()
  })

  it('hands connectHostSession a decision that settles only once it has approved or asked the human', async () => {
    // connectHostSession holds the phone's requests until this settles (review of A07-late): a
    // phone told "Awaiting host approval." while the late pin is still on disk gives up when it is
    // a background check, and forgets that this computer approves it.
    for (const paired of [true, false]) {
      sentToWin.length = 0
      sessions.length = 0
      let answer!: (v: boolean) => void
      const host = makeHost({ pinPairedPhone: () => new Promise<boolean>((r) => (answer = r)) })
      host.setEnabled(true)
      await settle()
      const decision = sessions[0].opts.onPeerReady(sessions[0].session)
      expect(decision).toBeInstanceOf(Promise)
      let settled = false
      void (decision as Promise<void>).then(() => (settled = true))
      await settle()
      expect(settled).toBe(false) // the late pin has not answered yet: still deciding
      answer(paired)
      await decision
      if (paired) {
        expect(sessions[0].session.approve).toHaveBeenCalledOnce()
        expect(pending()).toEqual([])
      } else {
        expect(sessions[0].session.approve).not.toHaveBeenCalled()
        expect(pending().map((m) => m.pub)).toEqual(['phone-pub']) // the dialog is up before it settles
      }
      host.stop()
    }
  })

  it('a phone revoked while the check is in flight is not approved', async () => {
    let answer!: (v: boolean) => void
    const host = makeHost({ pinPairedPhone: () => new Promise<boolean>((r) => (answer = r)) })
    host.setEnabled(true)
    await settle()
    sessions[0].opts.onPeerReady(sessions[0].session)
    await settle()
    sessions.at(-1)!.peer = null // the replacement listener has no phone yet
    expect(killStandingHostSessionsByPeerKey('phone-pub')).toBe(1)
    answer(true)
    await settle()
    expect(sessions[0].session.approve).not.toHaveBeenCalled()
    expect(sessions[0].closed).toBe(1)
    host.stop()
  })
})

describe('standing host: revocation and pin-store roles', () => {
  const pendingCount = (): number => sentToWin.filter((x) => x.channel === IPC.remoteHostPeerPending).length

  it('a removed phone\'s live session is closed, and its reconnect is NOT auto-approved', async () => {
    disk = { pubkeys: ['phone-pub'] }
    const host = makeHost()
    host.setEnabled(true)
    await settle()
    sessions[0].opts.onPeerReady(sessions[0].session)
    await settle()
    expect(sessions[0].session.approve).toHaveBeenCalledOnce() // pinned → silent auto-approve
    expect(phones()).toBe(1)

    // Phone "Remove" (pairing-service → revokeAllPhones): unpin AND cut.
    expect(await revokeAllPhones()).toEqual({ persisted: true, killed: true })
    expect(disk.pubkeys).toEqual([])
    expect(sessions[0].closed).toBe(1)
    expect(phones()).toBe(0)

    // Android immediate-redial safety remains: an explicitly forgotten phone gets no new SAS prompt.
    const before = pendingCount()
    await settle()
    const next = sessions.at(-1)!
    expect(next).not.toBe(sessions[0])
    next.opts.onPeerReady(next.session)
    await settle()
    expect(next.session.approve).not.toHaveBeenCalled()
    expect(pendingCount()).toBe(before)
    host.stop()
  })

  it('canonical revoke cuts every matching session even when one close throws, leaving another phone untouched', async () => {
    disk = { pubkeys: ['phone-A', 'phone-B'] }
    const host = makeHost()
    host.setEnabled(true)
    await settle()
    const bridge = async (pub: string) => {
      const entry = sessions.at(-1)!
      entry.peer = pub
      entry.opts.onPeerReady(entry.session)
      await settle()
      sessions.at(-1)!.peer = null
      return entry
    }
    const first = await bridge('phone-A')
    const second = await bridge('phone-A')
    const other = await bridge('phone-B')
    first.closeThrows = true
    expect(await revokePeerKey('phone-A', ['phone'])).toEqual({ persisted: true, killed: false })
    expect([first.closed, second.closed, other.closed]).toEqual([1, 1, 0])
    expect(disk.pubkeys).toEqual(['phone-B'])
    host.stop()
  })

  it('a key pinned as a joined host or a hosted guest is never auto-admitted as a phone', async () => {
    otherPins.joinedHost = { pubkeys: ['phone-pub'] }
    otherPins.guest = { pubkeys: ['phone-pub'] }
    try {
      const host = makeHost()
      host.setEnabled(true)
      await settle()
      sessions[0].opts.onPeerReady(sessions[0].session)
      await settle()
      expect(sessions[0].session.approve).not.toHaveBeenCalled()
      expect(pendingCount()).toBe(1) // the human is asked, exactly like any unknown phone
      host.stop()
    } finally {
      delete otherPins.joinedHost
      delete otherPins.guest
    }
  })

  it('a revoke drops a pending consent even after its socket closed, so the dialog cannot re-pin it', async () => {
    const host = makeHost()
    host.setEnabled(true)
    await settle()
    sessions[0].opts.onPeerReady(sessions[0].session)
    await settle()
    const msg = { id: pendingApprovalId(), pub: 'phone-pub' }
    sessions[0].opts.onClose() // #819: consent outlives the socket…
    await revokePeerKey('phone-pub', ['phone'])
    // …but not a revoke.
    expect(await ipc[IPC.remotePhoneApprove]({ sender }, msg)).toEqual({ status: 'stale' })
    expect(persist).not.toHaveBeenCalledWith(expect.anything(), expect.anything())
    expect(disk.pubkeys).toEqual([])
    host.stop()
  })
})

describe('standing host: a refused token mint backs off', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('does NOT re-mint in a tight loop when the API refuses (429)', async () => {
    // Field evidence (relay API log, 2026-09-25): one free host hit /v1/relay/host-token every
    // ~175 ms — its own round-trip time — 35k 429s in a day. connectOne()'s `finally` topped the
    // pool back up on a microtask even after a FAILED mint, so the backoff scheduleReconnect()
    // had just armed never got a chance to run.
    vi.useFakeTimers()
    routeFetch({ hostToken: () => res(429) })
    const host = makeHost()
    host.syncFromSettings()
    for (let i = 0; i < 20; i++) await settle()
    expect(mintCalls()).toHaveLength(1)
    // The backoff then retries — refusal is not a permanent stop.
    await vi.advanceTimersByTimeAsync(1000)
    for (let i = 0; i < 5; i++) await settle()
    expect(mintCalls()).toHaveLength(2)
    host.stop()
  })
})

describe('standing host: a listener the relay drops backs off (relay unreachable, API fine)', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('re-mints on the backoff, and a successful mint does NOT reset it', async () => {
    // Relay log, 2026-09-27, a host already on the fixed build: API reachable, relay WS failing for
    // 2½ minutes. Every mint succeeded (resetting the backoff), every socket died at once, and
    // onClose re-minted immediately — ~30 mints in 3 s until the API's per-IP limit answered 429.
    vi.useFakeTimers()
    routeFetch()
    const host = makeHost()
    host.syncFromSettings()
    for (let i = 0; i < 10; i++) await settle()
    expect(mintCalls()).toHaveLength(1)

    const dropNewest = async (): Promise<void> => {
      sessions.at(-1)!.opts.onClose() // the relay drops the idle listener on its own
      for (let i = 0; i < 10; i++) await settle()
    }
    // Drop #1: nothing immediate, one re-mint after 1 s.
    await dropNewest()
    expect(mintCalls()).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1000)
    expect(mintCalls()).toHaveLength(2)
    // Drop #2 right after that SUCCESSFUL mint: the delay grew to 2 s — the mint did not reset it.
    await dropNewest()
    await vi.advanceTimersByTimeAsync(1999)
    expect(mintCalls()).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(mintCalls()).toHaveLength(3)
    host.stop()
  })

  it('a listener that lives to its refresh resets the backoff', async () => {
    vi.useFakeTimers()
    routeFetch()
    const host = makeHost()
    host.syncFromSettings()
    for (let i = 0; i < 10; i++) await settle()
    // Two early deaths push the backoff to its third step (4 s)…
    sessions.at(-1)!.opts.onClose()
    await vi.advanceTimersByTimeAsync(1000)
    sessions.at(-1)!.opts.onClose()
    await vi.advanceTimersByTimeAsync(2000)
    const before = mintCalls().length
    // …then the listener holds for a full token lifetime (refresh at 120 − 30 = 90 s).
    await vi.advanceTimersByTimeAsync(90_000)
    expect(mintCalls().length).toBe(before + 1) // the refresh re-mint
    // A drop now waits 1 s again, not 4 s.
    sessions.at(-1)!.opts.onClose()
    await vi.advanceTimersByTimeAsync(1000)
    expect(mintCalls().length).toBe(before + 2)
    host.stop()
  })
})

describe('standing host: token refresh is immune to this machine\'s clock error', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('tokenTtlMs measures exp against the SERVER clock (Date header), local clock only as fallback', () => {
    const serverNow = Date.parse('Sun, 27 Sep 2026 08:00:00 GMT')
    const exp = serverNow / 1000 + 120
    const fastLocal = serverNow + 75_000 // this machine's clock 75 s ahead
    expect(tokenTtlMs(exp, 'Sun, 27 Sep 2026 08:00:00 GMT', fastLocal)).toBe(120_000)
    expect(tokenTtlMs(exp, null, fastLocal)).toBe(45_000) // no header: the old (skewed) answer
    expect(tokenTtlMs(exp, 'not a date', fastLocal)).toBe(45_000)
    expect(tokenTtlMs(0, 'Sun, 27 Sep 2026 08:00:00 GMT', fastLocal)).toBe(120_000) // no exp → default TTL
  })

  it('a host whose clock is 75 s fast refreshes every ~90 s, not at the 15 s floor', async () => {
    // Relay log, 2026-09-27: a host re-minting every 15 s (238/hour vs a free limit of 240).
    vi.useFakeTimers()
    const serverNow = Date.parse('Sun, 27 Sep 2026 08:00:00 GMT')
    vi.setSystemTime(serverNow + 75_000)
    routeFetch({
      hostToken: () =>
        res(
          200,
          { pairingToken: 'tok', hostId: 'host', exp: serverNow / 1000 + 120 },
          new Headers({ date: new Date(serverNow).toUTCString() })
        )
    })
    const host = makeHost()
    host.syncFromSettings()
    for (let i = 0; i < 10; i++) await settle()
    expect(mintCalls()).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(mintCalls()).toHaveLength(1) // the old code had re-minted 4 times by now
    await vi.advanceTimersByTimeAsync(30_000)
    expect(mintCalls()).toHaveLength(2)
    host.stop()
  })
})

describe('standing host: host key proof-of-possession on the host-token mint', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  /** A pre-seeded device id, so the free tier's subject is a known value. */
  function seedDeviceId(id: string): void {
    writeFileSync(join(platform().userDataDir, 'device-id'), id, 'utf-8')
  }

  it('Pro: the mint carries popChallenge + popProof beside the entitlement, proved with subject ""', async () => {
    const pop = createTestPopServer()
    routeFetch({ challenge: challengeFrom(pop) })
    const host = makeHost()
    host.setEnabled(true)
    await settle()

    expect(challengeCalls()).toHaveLength(1)
    const chBody = JSON.parse(String(challengeCalls()[0][1].body)) as Record<string, unknown>
    expect(chBody).toEqual({ hostPublicKeyB64: hostPubB64, purpose: 'host-token' })

    expect(mintCalls()).toHaveLength(1)
    const body = mintBody()
    expect(body.entitlement).toBe('entitlement')
    expect(body.hostPublicKeyB64).toBe(hostPubB64)
    expect(body).not.toHaveProperty('deviceId')
    expect(typeof body.popChallenge).toBe('string')
    expect(typeof body.popProof).toBe('string')
    // The backend's own verify (mirrored in the test server) accepts it for the Pro subject ''.
    expect(
      pop.verify({
        hostPublicKeyB64: hostPubB64,
        purpose: 'host-token',
        subject: '',
        popChallenge: body.popChallenge,
        popProof: body.popProof
      })
    ).toBe(true)
    // ONE abort signal covers the challenge and the mint.
    expect(challengeCalls()[0][1].signal).toBeInstanceOf(AbortSignal)
    expect(mintCalls()[0][1].signal).toBe(challengeCalls()[0][1].signal)
    expect(sessions).toHaveLength(1)
    host.stop()
  })

  it('free tier: the proof subject is getDeviceId(), the same id the body sends', async () => {
    storedEntitlement = null
    seedDeviceId('device-fixed')
    const pop = createTestPopServer()
    routeFetch({ challenge: challengeFrom(pop) })
    const host = makeHost()
    host.setEnabled(true)
    await settle()

    expect(mintCalls()).toHaveLength(1)
    const body = mintBody()
    expect(body.deviceId).toBe('device-fixed')
    expect(body).not.toHaveProperty('entitlement')
    const proof = {
      hostPublicKeyB64: hostPubB64,
      purpose: 'host-token' as const,
      popChallenge: body.popChallenge,
      popProof: body.popProof
    }
    // A proof for the Pro subject would not pass for a free mint (checked first: a mismatch does
    // not consume the single-use nonce).
    expect(pop.verify({ ...proof, subject: '' })).toBe(false)
    expect(pop.verify({ ...proof, subject: 'device-fixed' })).toBe(true)
    host.stop()
  })

  it('free tier on first launch: the proof subject and the body deviceId are ONE read', async () => {
    // No device-id file yet: getDeviceId() mints a fresh uuid and writes it ASYNC, so a second
    // call before that write lands mints ANOTHER uuid. Reading it twice sends a body deviceId the
    // proof was not computed over, which the backend refuses as pop_invalid — a terminal stop.
    storedEntitlement = null
    const pop = createTestPopServer()
    routeFetch({ challenge: challengeFrom(pop) })
    const host = makeHost()
    host.setEnabled(true)
    await settle()

    expect(mintCalls()).toHaveLength(1)
    const body = mintBody()
    expect(typeof body.deviceId).toBe('string')
    expect(
      pop.verify({
        hostPublicKeyB64: hostPubB64,
        purpose: 'host-token',
        subject: body.deviceId as string,
        popChallenge: body.popChallenge,
        popProof: body.popProof
      })
    ).toBe(true)
    host.stop()
  })

  it('an old backend (challenge 404/405) gets the legacy mint: no popChallenge, no popProof', async () => {
    for (const status of [404, 405]) {
      routeFetch({ challenge: () => res(status) })
      const host = makeHost()
      host.setEnabled(true)
      await settle()
      expect(mintCalls()).toHaveLength(1)
      expect(mintBody()).toEqual({ entitlement: 'entitlement', hostPublicKeyB64: hostPubB64 })
      expect(sessions.length).toBeGreaterThan(0)
      host.stop()
      sessions.length = 0
    }
  })

  /** A host-token route answering the listed replies in order, then the last one forever. */
  const hostTokenSeq =
    (...replies: Array<number | string>): Route =>
    (init) => {
      const next = replies.length > 1 ? replies.shift()! : replies[0]
      return next === 200 ? hostTokenOk(init) : res(403, { error: next })
    }

  it.each(['pop_required', 'pop_invalid'])(
    'two %s refusals of PROVEN mints in a row stop hosting, say so once, and never re-mint',
    async (error) => {
      vi.useFakeTimers()
      const pop = createTestPopServer()
      routeFetch({ challenge: challengeFrom(pop), hostToken: () => res(403, { error }) })
      const host = makeHost()
      host.setEnabled(true)
      for (let i = 0; i < 5; i++) await settle()

      // The first refusal is transient (a POP_SECRET rotation mid challenge→mint looks exactly like
      // this): no dialog, and the backoff asks for a FRESH challenge.
      expect(mintCalls()).toHaveLength(1)
      expect(mintBody()).toHaveProperty('popProof')
      expect(errorBoxes).toHaveLength(0)
      await vi.advanceTimersByTimeAsync(1000)
      expect(challengeCalls()).toHaveLength(2)
      expect(mintCalls()).toHaveLength(2)

      // The second in a row is terminal.
      expect(sessions).toHaveLength(0)
      expect(errorBoxes).toHaveLength(1)
      expect(errorBoxes[0].body).toContain(POP_REFUSED_MESSAGE_DESKTOP)
      // The follow-up line has its own antecedent now that the message ends with "contact support".
      expect(errorBoxes[0].body).toContain('Phone access is off. Turn it back on in Settings → Phone after updating.')
      expect(errorBoxes[0].body).not.toContain('until then')
      // `team rotate-key` exists only in the Server Edition: the desktop must not advise it.
      expect(errorBoxes[0].body).not.toContain('rotate-key')
      // Terminal: no reconnect timer is left armed.
      await vi.advanceTimersByTimeAsync(60_000)
      expect(mintCalls()).toHaveLength(2)
      expect(challengeCalls()).toHaveLength(2)
      expect(errorBoxes).toHaveLength(1)
      host.stop()
    }
  )

  it('one refusal then a successful mint: no dialog, the host keeps running', async () => {
    vi.useFakeTimers()
    const pop = createTestPopServer()
    routeFetch({ challenge: challengeFrom(pop), hostToken: hostTokenSeq('pop_invalid', 200) })
    const host = makeHost()
    host.setEnabled(true)
    for (let i = 0; i < 5; i++) await settle()
    expect(sessions).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1000)
    expect(mintCalls()).toHaveLength(2)
    expect(sessions).toHaveLength(1) // a listener is registered: hosting runs
    expect(errorBoxes).toHaveLength(0)
    expect(advertisementsRemoved).toBe(0)
    host.stop()
  })

  it('a successful mint resets the count: refusal, success, refusal is still transient', async () => {
    vi.useFakeTimers()
    const pop = createTestPopServer()
    routeFetch({
      challenge: challengeFrom(pop),
      hostToken: hostTokenSeq('pop_invalid', 200, 'pop_invalid', 'pop_invalid')
    })
    const host = makeHost()
    host.setEnabled(true)
    for (let i = 0; i < 5; i++) await settle()
    await vi.advanceTimersByTimeAsync(1000) // retry → success
    expect(sessions).toHaveLength(1)

    sessions[0].opts.onPeerReady(sessions[0].session) // bridged → the pool mints a replacement
    for (let i = 0; i < 5; i++) await settle()
    expect(mintCalls()).toHaveLength(3) // refused: the FIRST since the success, so transient
    expect(errorBoxes).toHaveLength(0)
    expect(sessions[0].closed).toBe(0) // the phone keeps its session

    await vi.advanceTimersByTimeAsync(2000) // the backoff's next step
    expect(mintCalls()).toHaveLength(4) // the second in a row: terminal
    expect(errorBoxes).toHaveLength(1)
    expect(sessions[0].closed).toBe(1)
    host.stop()
  })

  it('start() resets the count: a refusal before a restart does not make the next one terminal', async () => {
    vi.useFakeTimers()
    const pop = createTestPopServer()
    routeFetch({ challenge: challengeFrom(pop), hostToken: () => res(403, { error: 'pop_invalid' }) })
    const host = makeHost()
    host.setEnabled(true)
    for (let i = 0; i < 5; i++) await settle()
    expect(mintCalls()).toHaveLength(1)
    host.setEnabled(false)
    host.setEnabled(true)
    for (let i = 0; i < 5; i++) await settle()
    expect(mintCalls()).toHaveLength(2)
    expect(errorBoxes).toHaveLength(0) // the first refusal of THIS run
    host.stop()
  })

  it.each<[string, 'challenge' | 'host-token', Route]>([
    ['the challenge answering 503', 'challenge', () => res(503)],
    ['a challenge network error', 'challenge', () => Promise.reject(new TypeError('fetch failed'))],
    ['the mint answering 503', 'host-token', () => res(503)]
  ])(
    'a transient failure between two refusals does not reset the count: refusal, %s, refusal stops',
    async (_label, where, transient) => {
      // Only a successful mint (or start()) proves the key is accepted. Resetting on a transient
      // failure would let a backend that refuses every proof, behind a flaky challenge, loop forever.
      vi.useFakeTimers()
      const pop = createTestPopServer()
      let challenges = 0
      let mints = 0
      routeFetch({
        challenge: (init) =>
          where === 'challenge' && ++challenges === 2 ? transient(init) : challengeFrom(pop)(init),
        hostToken: (init) =>
          where === 'host-token' && ++mints === 2 ? transient(init) : res(403, { error: 'pop_invalid' })
      })
      const host = makeHost()
      host.setEnabled(true)
      for (let i = 0; i < 5; i++) await settle()
      expect(errorBoxes).toHaveLength(0) // refusal 1: transient
      await vi.advanceTimersByTimeAsync(1000) // the backoff → the transient failure
      expect(challengeCalls()).toHaveLength(2)
      expect(errorBoxes).toHaveLength(0)
      await vi.advanceTimersByTimeAsync(2000) // the next backoff step → refusal 2, the second in a row
      expect(challengeCalls()).toHaveLength(3)
      expect(errorBoxes).toHaveLength(1)
      expect(errorBoxes[0].body).toContain(POP_REFUSED_MESSAGE_DESKTOP)
      await vi.advanceTimersByTimeAsync(60_000) // stopped: nothing re-mints, no second dialog
      expect(challengeCalls()).toHaveLength(3)
      expect(errorBoxes).toHaveLength(1)
      host.stop()
    }
  )

  it('turning access off while a mint is in flight: a refusal that lands afterwards raises nothing', async () => {
    vi.useFakeTimers()
    const pop = createTestPopServer()
    let answer: ((r: FakeRes) => void) | null = null
    let n = 0
    routeFetch({
      challenge: challengeFrom(pop),
      hostToken: () =>
        ++n === 1
          ? res(403, { error: 'pop_invalid' })
          : new Promise<FakeRes>((resolve) => {
              answer = resolve
            })
    })
    const host = makeHost()
    host.setEnabled(true)
    for (let i = 0; i < 5; i++) await settle()
    await vi.advanceTimersByTimeAsync(1000) // the retry: the SECOND mint is now in flight
    expect(mintCalls()).toHaveLength(2)
    expect(answer).not.toBeNull()

    host.setEnabled(false) // the human turns phone access off
    answer!(res(403, { error: 'pop_invalid' })) // …and the refusal lands afterwards
    for (let i = 0; i < 5; i++) await settle()
    expect(errorBoxes).toEqual([])
    await vi.advanceTimersByTimeAsync(60_000)
    expect(mintCalls()).toHaveLength(2)
  })

  it('the refusal kind is logged; the dialog text stays fixed', async () => {
    vi.useFakeTimers()
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const pop = createTestPopServer()
      routeFetch({ challenge: challengeFrom(pop), hostToken: () => res(403, { error: 'pop_invalid' }) })
      const host = makeHost()
      host.setEnabled(true)
      for (let i = 0; i < 5; i++) await settle()
      await vi.advanceTimersByTimeAsync(1000)
      expect(errorBoxes).toHaveLength(1)
      expect(errorBoxes[0].body).not.toContain('pop_invalid')
      expect(logged.mock.calls.flat().join(' ')).toContain('pop_invalid')
      host.stop()
    } finally {
      logged.mockRestore()
    }
  })

  it('refusals on the replacement mint while a phone is bridged: the first is transient, the second tears hosting down (stop)', async () => {
    // The realistic moment for a refusal: a phone bridges, the pool mints a replacement listener,
    // and THAT mint is refused. The first refusal leaves the phone's session alone; the second in a
    // row must cut it, withdraw the advertisement and leave nothing that re-mints — a late socket
    // close must not raise a second dialog.
    vi.useFakeTimers()
    const pop = createTestPopServer()
    routeFetch({ challenge: challengeFrom(pop), hostToken: hostTokenSeq(200, 'pop_invalid') })
    const host = makeHost()
    host.setEnabled(true)
    for (let i = 0; i < 5; i++) await settle()
    expect(sessions).toHaveLength(1)

    sessions[0].opts.onPeerReady(sessions[0].session) // bridged → the pool mints a replacement
    for (let i = 0; i < 5; i++) await settle()
    expect(mintCalls()).toHaveLength(2)
    expect(errorBoxes).toHaveLength(0)
    expect(sessions[0].closed).toBe(0)
    expect(phones()).toBe(1)

    await vi.advanceTimersByTimeAsync(1000) // the backoff re-challenges and is refused again
    expect(mintCalls()).toHaveLength(3)
    expect(errorBoxes).toHaveLength(1)
    expect(errorBoxes[0].body).toContain(POP_REFUSED_MESSAGE_DESKTOP)
    expect(sessions[0].closed).toBe(1) // the bridged phone session is cut
    expect(phones()).toBe(0)
    expect(advertisementsRemoved).toBe(1) // phones stop minting against a host that is gone

    sessions[0].opts.onClose() // a late transport close of the cut session
    for (let i = 0; i < 5; i++) await settle()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(mintCalls()).toHaveLength(3)
    expect(errorBoxes).toHaveLength(1)
    host.stop()
  })

  it('pop_invalid is terminal even for unproven (legacy) mints — on the second in a row', async () => {
    vi.useFakeTimers()
    routeFetch({ hostToken: () => res(403, { error: 'pop_invalid' }) })
    const host = makeHost()
    host.setEnabled(true)
    for (let i = 0; i < 5; i++) await settle()
    expect(mintBody()).not.toHaveProperty('popProof')
    expect(errorBoxes).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1000)
    expect(mintCalls()).toHaveLength(2)
    expect(errorBoxes).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(mintCalls()).toHaveLength(2)
    host.stop()
  })

  it('pop_required on an UNPROVEN mint (challenge 404, backend mid-redeploy) is transient: backoff, fresh challenge', async () => {
    // A reverse proxy answers 404 for /challenge while the backend redeploys; the unproven mint
    // that follows can land on the fresh backend, which requires a proof from a host it has seen
    // prove before. Stopping would end hosting for good over a redeploy.
    vi.useFakeTimers()
    const pop = createTestPopServer()
    let redeploying = true
    routeFetch({
      challenge: (init) => (redeploying ? res(404) : challengeFrom(pop)(init)),
      hostToken: (init) => {
        const b = JSON.parse(String(init.body)) as Record<string, unknown>
        return b.popProof ? hostTokenOk(init) : res(403, { error: 'pop_required' })
      }
    })
    const host = makeHost()
    host.setEnabled(true)
    for (let i = 0; i < 5; i++) await settle()

    expect(mintCalls()).toHaveLength(1)
    expect(mintBody()).not.toHaveProperty('popProof')
    expect(errorBoxes).toHaveLength(0) // not a refusal
    expect(sessions).toHaveLength(0)

    redeploying = false
    await vi.advanceTimersByTimeAsync(1000) // the first backoff step
    expect(challengeCalls()).toHaveLength(2) // the retry asks for a FRESH challenge
    expect(mintCalls()).toHaveLength(2)
    expect(mintBody()).toHaveProperty('popProof')
    expect(sessions).toHaveLength(1)
    expect(errorBoxes).toHaveLength(0)
    host.stop()
  })

  it('a 403 that is not a key-proof refusal stays an ordinary failure (backoff, no dialog)', async () => {
    vi.useFakeTimers()
    const pop = createTestPopServer()
    routeFetch({ challenge: challengeFrom(pop), hostToken: () => res(403, { error: 'forbidden' }) })
    const host = makeHost()
    host.setEnabled(true)
    for (let i = 0; i < 5; i++) await settle()
    expect(mintCalls()).toHaveLength(1)
    expect(errorBoxes).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1000)
    expect(mintCalls()).toHaveLength(2)
    host.stop()
  })

  it.each<[string, Route]>([
    ['503', () => res(503)],
    ['500', () => res(500)],
    ['429', () => res(429)],
    ['a network error', () => Promise.reject(new TypeError('fetch failed'))],
    ['a malformed 200', () => res(200, { nope: true })],
    // A server key the proof cannot use: the all-zero key gives a degenerate shared secret.
    ['a 200 with an unusable server key', () => res(200, { challenge: 'c.x', serverPublicKeyB64: 'A'.repeat(43) + '=' })]
  ])('the challenge answering %s makes NO mint and backs off', async (_label, challenge) => {
    // Never an unproven mint after a transient challenge failure: to a host the backend has seen
    // prove before, that mint is a 403 — a terminal stop — over a blip.
    vi.useFakeTimers()
    routeFetch({ challenge })
    const host = makeHost()
    host.setEnabled(true)
    for (let i = 0; i < 5; i++) await settle()
    expect(challengeCalls()).toHaveLength(1)
    expect(mintCalls()).toHaveLength(0)
    expect(errorBoxes).toHaveLength(0)
    // The existing backoff: one retry after 1 s.
    await vi.advanceTimersByTimeAsync(999)
    expect(challengeCalls()).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(challengeCalls()).toHaveLength(2)
    expect(mintCalls()).toHaveLength(0)
    host.stop()
  })

  it('a challenge that never answers is aborted by the 8 s mint timeout (no mint, backoff)', async () => {
    vi.useFakeTimers()
    routeFetch({
      challenge: (init) =>
        new Promise<FakeRes>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')))
        })
    })
    const host = makeHost()
    host.setEnabled(true)
    await vi.advanceTimersByTimeAsync(7999)
    expect(challengeCalls()).toHaveLength(1)
    expect(challengeCalls()[0][1].signal?.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(challengeCalls()[0][1].signal?.aborted).toBe(true)
    expect(mintCalls()).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1000) // then the backoff retries
    expect(challengeCalls()).toHaveLength(2)
    host.stop()
  })

  it('ONE 8 s timer covers the challenge AND the mint (a slow challenge leaves the mint the rest)', async () => {
    vi.useFakeTimers()
    const pop = createTestPopServer()
    routeFetch({
      challenge: (init) =>
        new Promise<FakeRes>((resolve) => {
          setTimeout(() => resolve(challengeFrom(pop)(init) as FakeRes), 5000)
        }),
      hostToken: (init) =>
        new Promise<FakeRes>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')))
        })
    })
    const host = makeHost()
    host.setEnabled(true)
    await vi.advanceTimersByTimeAsync(5000)
    expect(challengeCalls()).toHaveLength(1)
    expect(mintCalls()).toHaveLength(1) // the challenge answered at 5 s, the mint is in flight
    const signal = mintCalls()[0][1].signal!
    await vi.advanceTimersByTimeAsync(2999)
    expect(signal.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1) // 8 s after the challenge STARTED, not 8 s after the mint
    expect(signal.aborted).toBe(true)
    expect(sessions).toHaveLength(0)
    host.stop()
  })
})
