// Task 2 (docs/remote-sessions.md 4c): `initRelayHost` drives the reviewed `connectRelayHost`
// machinery from IPC — a real peer connecting fires the approval prompt, and ONLY after the human
// confirms does the peer become a live CorePlatform client.
//
// The reviewed trust machinery (connectRelayHost / createTrustGate / relay-socket) is exercised for
// REAL here; only the electron shell boundary and the relay WIRE (an in-process RelayTransport pair,
// the same fake relay-host.test.ts drives) are faked. The token mint + keypair + Pro gate are
// injected via `deps` so the test never touches the network or the OS keyring.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

const h: {
  handlers: Record<string, (...a: any[]) => unknown>
  sent: Array<{ channel: string; args: any[] }>
} = { handlers: {}, sent: [] }

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/ud', getVersion: () => '9.9.9', isPackaged: false },
  ipcMain: {
    handle: (ch: string, fn: (...a: any[]) => unknown) => {
      h.handlers[ch] = fn
    },
    on: (ch: string, fn: (...a: any[]) => void) => {
      h.handlers[ch] = fn
    }
  },
  webContents: { fromId: () => undefined },
  shell: { openExternal: vi.fn(async () => {}) }
}))

vi.mock('../main-window', () => ({
  sendToMain: (ch: string, ...args: any[]) => h.sent.push({ channel: ch, args }),
  mainWindowClientIds: () => [] as number[]
}))

import { emptyApprovedDevices, type ApprovedDevices } from './approved-devices-core'
let disk: ApprovedDevices = emptyApprovedDevices()
vi.mock('./approved-devices', () => ({
  updateApprovedDevices: async (update: (s: ApprovedDevices) => ApprovedDevices) => { disk = update(disk) },
  loadApprovedDevices: async () => disk,
  saveApprovedDevices: async (s: ApprovedDevices) => {
    disk = s
  }
}))

// Keep `connectRelayHost` (the reviewed handshake) REAL — the crypto tests below exercise it for
// real — but spy `killRelayHostsByPeerKey` so the revoke test can assert the identity-based cut is
// fired with the right peer key (the module-level `live` set it reads is only populated by real
// sessions, so a pass-through spy is the clean way to observe it with a fake `connect`).
vi.mock('./relay-host', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./relay-host')>()
  return { ...mod, killRelayHostsByPeerKey: vi.fn(mod.killRelayHostsByPeerKey) }
})

import { initRelayHost, E_SEATS_FULL } from './relay-host-service'
import { killRelayHostsByPeerKey, type RelayHostSession } from './relay-host'
import { connectRelay, type RelayTransport } from './relay-socket'
import { createTrustGate, type TrustGate } from './relay-trust'
import { genKeyPair, publicKeyToB64 } from './e2ee'
import { decodeOffer } from './pairing'
import { electronPlatform, type ElectronPlatform } from '../platform-electron'
import { peerRegistry, unregisterPeerSink, wirePeerRegistry } from '../peer-registry'
import { presenceHub } from '../../core/presence/hub'
import { initCanvasSync } from '../../core/canvas-sync'
import { initPlatform, resetPlatformForTests } from '../../core/platform'
import { registerBoardLogHandlers, type BoardLogRoute } from '../../core/board-log-handlers'
import { IPC } from '../../shared/ipc'

const decoder = new TextDecoder()

let platform: ElectronPlatform

/** A fake window that records what the main process pushes to the renderer. */
function fakeWin(): { isDestroyed: () => boolean; webContents: { send: (ch: string, ...a: any[]) => void } } {
  return {
    isDestroyed: () => false,
    webContents: { send: (ch: string, ...args: any[]) => h.sent.push({ channel: ch, args }) }
  }
}

/**
 * Wire an `initRelayHost` whose relay socket is an in-process transport pair, and return a peer that
 * can drive the handshake + trust confirm. The host transport is injected via `deps.transport`; the
 * token mint / keypair / Pro gate are injected so nothing hits the network.
 */
function wireHost(): {
  win: ReturnType<typeof fakeWin>
  hostKeys: ReturnType<typeof genKeyPair>
  peerKeyB64: string
  /** Complete the E2EE handshake from the peer side (creates the peer relay socket). */
  connectPeer: () => void
  /** The peer human presses Confirm over the ENCRYPTED tunnel. */
  peerConfirms: () => void
  /** The relay drops the socket under the host. */
  dropSocket: () => void
  /** The peer sends a raw tunnel frame (an RPC req/cast) to the host. */
  peerSendsTunnelText: (json: string) => void
  /** Non-trust tunnel frames the host pushed back to the peer (RPC res + ev). */
  peerFrames: Array<Record<string, unknown>>
} {
  const hostKeys = genKeyPair()
  const peerKeys = genKeyPair()

  let hostOnMsg: ((d: unknown) => void) | null = null
  let peerOnMsg: ((d: unknown) => void) | null = null
  let hostOnClose: (() => void) | null = null
  let peerOnClose: (() => void) | null = null

  const hostT: RelayTransport = {
    bufferedAmount: 0,
    send: (d) => peerOnMsg?.(d),
    close: () => peerOnClose?.(),
    onMessage: (cb) => {
      hostOnMsg = cb
    },
    onClose: (cb) => {
      hostOnClose = cb
    }
  }
  const peerT: RelayTransport = {
    bufferedAmount: 0,
    send: (d) => hostOnMsg?.(d),
    close: () => hostOnClose?.(),
    onMessage: (cb) => {
      peerOnMsg = cb
    },
    onClose: (cb) => {
      peerOnClose = cb
    }
  }

  const win = fakeWin()
  initRelayHost(win as never, platform, {
    transport: hostT,
    loadKeys: async () => hostKeys,
    mintToken: async () => ({ pairingToken: 'tok-123' }),
    isPremium: () => true,
    relayAllowed: () => true,
    getEntitlement: () => 'ent-abc',
    licensedSeats: () => 3
  })

  let peerGate: TrustGate | null = null
  let peerStore: ApprovedDevices = emptyApprovedDevices()
  let peerSocket: ReturnType<typeof connectRelay> | null = null
  const peerFrames: Array<Record<string, unknown>> = []

  const connectPeer = (): void => {
    const sock = connectRelay({
      url: 'wss://relay.example',
      token: 'tok-123',
      role: 'client',
      ourKeys: peerKeys,
      theirPubB64: publicKeyToB64(hostKeys.publicKey),
      transport: peerT,
      onReady: () => {},
      onRpc: () => {},
      onFrame: () => {},
      onClose: () => {},
      onTunnel: (kind, payload) => {
        if (kind !== 'text') return
        const json = decoder.decode(payload)
        if (peerGate?.onTunnelText(json)) return // the host's own trust confirm
        try {
          peerFrames.push(JSON.parse(json))
        } catch {
          /* not JSON — ignore */
        }
      }
    })
    peerSocket = sock
    peerGate = createTrustGate({
      peerKeyB64: sock.peerPublicKeyB64()!,
      sessionId: 'peer-side',
      sas: () => sock.sas(),
      sendConfirm: (json) => sock.sendTunnelText(json),
      onOpen: () => {},
      load: async () => peerStore,
      save: async (s) => {
        peerStore = s
      }
    })
  }

  return {
    win,
    hostKeys,
    peerKeyB64: publicKeyToB64(peerKeys.publicKey),
    connectPeer,
    peerConfirms: () => peerGate?.confirmHere(),
    dropSocket: () => hostOnClose?.(),
    peerSendsTunnelText: (json) => peerSocket?.sendTunnelText(json),
    peerFrames
  }
}

/** Run `relay:host:start` (optionally scoped to a project) and return its offer. */
async function start(projectId?: string): Promise<{ offer: string }> {
  return (await h.handlers[IPC.relayHostStart]({}, projectId)) as { offer: string }
}

/** Drive a peer to a fully-open (mutually approved) platform client. */
async function openPeer(host: ReturnType<typeof wireHost>): Promise<void> {
  host.connectPeer()
  const id = pendingSent()!.id
  h.handlers[IPC.relayHostConfirm]({}, { id })
  host.peerConfirms()
  await vi.waitFor(() => expect(peerRegistry().ids().length).toBe(1))
}

function pendingSent(): { id: string; sas: string | null; peerKeyB64: string } | undefined {
  return h.sent.filter((x) => x.channel === IPC.relayHostPeerPending).at(-1)?.args[0]
}

beforeEach(() => {
  h.handlers = {}
  h.sent = []
  disk = emptyApprovedDevices()
  platform = electronPlatform()
  initPlatform(platform)
  wirePeerRegistry({
    setFlow: () => {},
    captureForResync: async () => '',
    onPeerGone: () => {}
  })
  presenceHub.registerIpc()
  initCanvasSync()
})

afterEach(() => {
  for (const id of peerRegistry().ids()) unregisterPeerSink(id)
  for (const pe of presenceHub.peers()) presenceHub.leave(pe.clientId)
  resetPlatformForTests()
})

describe('initRelayHost — start()', () => {
  it('returns a decodable offer carrying the host key + minted token', async () => {
    wireHost()
    const { offer } = await start()
    const decoded = decodeOffer(offer)
    expect(decoded).toBeTruthy()
    expect(decoded!.pairingToken).toBe('tok-123')
    expect(decoded!.hostPublicKeyB64).toBeTruthy()
  })

  it('rejects when not entitled', async () => {
    const win = fakeWin()
    initRelayHost(win as never, platform, {
      isPremium: () => false,
      relayAllowed: () => true,
      getEntitlement: () => 'ent',
      loadKeys: async () => genKeyPair(),
      mintToken: async () => ({ pairingToken: 't' })
    })
    await expect(h.handlers[IPC.relayHostStart]({})).rejects.toThrow(/Pro/)
  })

  it('surfaces a locked peer key as a rejected start', async () => {
    const win = fakeWin()
    initRelayHost(win as never, platform, {
      isPremium: () => true,
      relayAllowed: () => true,
      getEntitlement: () => 'ent',
      licensedSeats: () => 3,
      loadKeys: async () => {
        throw Object.assign(new Error('locked'), { code: 'E_PEER_KEY_LOCKED' })
      },
      mintToken: async () => ({ pairingToken: 't' })
    })
    await expect(h.handlers[IPC.relayHostStart]({})).rejects.toThrow(/locked/)
  })
})

describe('initRelayHost — nothing is served before mutual approval', () => {
  it('a peer completing the handshake fires relayHostPeerPending with a non-null SAS but no client yet', async () => {
    const host = wireHost()
    await start()
    host.connectPeer()

    const pending = pendingSent()
    expect(pending).toBeTruthy()
    expect(pending!.sas).toMatch(/^\d{3} \d{3}$/)
    expect(pending!.peerKeyB64).toBe(host.peerKeyB64)
    // No client, no presence, no open before the human confirms.
    expect(peerRegistry().ids()).toEqual([])
    expect(presenceHub.peers()).toEqual([])
    expect(h.sent.some((x) => x.channel === IPC.relayHostOpen)).toBe(false)
  })

  it('ONE human confirming (the peer alone) is not enough', async () => {
    const host = wireHost()
    await start()
    host.connectPeer()
    host.peerConfirms() // only the remote human
    await new Promise((r) => setTimeout(r, 20))
    expect(peerRegistry().ids()).toEqual([])
    expect(h.sent.some((x) => x.channel === IPC.relayHostOpen)).toBe(false)
  })
})

describe('initRelayHost — confirm() opens the session', () => {
  it('both humans confirming admits the peer as a CorePlatform client + presence peer', async () => {
    const host = wireHost()
    await start()
    host.connectPeer()
    const id = pendingSent()!.id

    // This human confirms via IPC, the remote human over the tunnel.
    h.handlers[IPC.relayHostConfirm]({}, { id })
    host.peerConfirms()

    await vi.waitFor(() => expect(peerRegistry().ids().length).toBe(1))
    expect(presenceHub.peers().length).toBe(1)
    expect(presenceHub.peers()[0].kind).toBe('desktop')
    const open = h.sent.filter((x) => x.channel === IPC.relayHostOpen).at(-1)
    expect(open?.args[0]).toEqual({ id })
  })

  it('confirm() with an unknown id is a no-op (no throw)', async () => {
    wireHost()
    await start()
    expect(() => h.handlers[IPC.relayHostConfirm]({}, { id: 'nope' })).not.toThrow()
    expect(peerRegistry().ids()).toEqual([])
  })
})

describe('initRelayHost — sharedProjectId threads start → connect', () => {
  /** Inject a fake `connect` that records the options it was called with. */
  function wireWithCapture(): { opts: () => any } {
    let captured: any = null
    const win = fakeWin()
    initRelayHost(win as never, platform, {
      loadKeys: async () => genKeyPair(),
      mintToken: async () => ({ pairingToken: 'tok-123' }),
      isPremium: () => true,
      relayAllowed: () => true,
      getEntitlement: () => 'ent-abc',
      licensedSeats: () => 3,
      connect: (o) => {
        captured = o
        // A no-op session; start() only needs the offer, which it builds itself.
        return {
          clientId: () => null,
          sas: () => null,
          peerKeyB64: () => null,
          sharedProjectId: () => o.sharedProjectId,
          confirm: () => {},
          close: () => {}
        } as unknown as RelayHostSession
      }
    })
    return { opts: () => captured }
  }

  it('start(projectId) passes sharedProjectId to connect', async () => {
    const cap = wireWithCapture()
    await h.handlers[IPC.relayHostStart]({}, 'proj-1')
    expect(cap.opts()?.sharedProjectId).toBe('proj-1')
  })

  it('start() with no arg leaves sharedProjectId undefined', async () => {
    const cap = wireWithCapture()
    await h.handlers[IPC.relayHostStart]({})
    expect(cap.opts()?.sharedProjectId).toBeUndefined()
  })
})

describe('initRelayHost — teardown', () => {
  it('stop() tears the live peer down and notifies the renderer', async () => {
    const host = wireHost()
    await start()
    host.connectPeer()
    const id = pendingSent()!.id
    h.handlers[IPC.relayHostConfirm]({}, { id })
    host.peerConfirms()
    await vi.waitFor(() => expect(peerRegistry().ids().length).toBe(1))

    await h.handlers[IPC.relayHostStop]()

    expect(peerRegistry().ids()).toEqual([])
    expect(presenceHub.peers()).toEqual([])
  })

  it('a socket drop tears the peer down and fires relayHostClosed', async () => {
    const host = wireHost()
    await start()
    host.connectPeer()
    const id = pendingSent()!.id
    h.handlers[IPC.relayHostConfirm]({}, { id })
    host.peerConfirms()
    await vi.waitFor(() => expect(peerRegistry().ids().length).toBe(1))

    host.dropSocket()

    expect(peerRegistry().ids()).toEqual([])
    expect(presenceHub.peers()).toEqual([])
    const closed = h.sent.filter((x) => x.channel === IPC.relayHostClosed).at(-1)
    expect(closed?.args[0]).toEqual({ id })
  })
})

// Team Access — the POOL. A fake `connect` gives full, synchronous control over each seat's
// pending/open/close callbacks (the reviewed handshake is exercised for real in the crypto tests
// above and in relay-host.test.ts — it is UNCHANGED). Each fake session has a distinct peer key so
// the identity-based revoke can be asserted per seat.
interface FakeSession extends RelayHostSession {
  close: () => void
  confirm: () => void
}

function makeFakeSession(n: number): FakeSession {
  return {
    clientId: () => null,
    sas: () => '123 456',
    peerKeyB64: () => `peer-${n}`,
    sharedProjectId: () => undefined,
    confirm: vi.fn(),
    close: vi.fn()
  }
}

/** Wire an `initRelayHost` whose `connect` returns controllable fake sessions, capped at `seats`. */
function wirePool(seats: number): {
  invite: (opts?: { projectId?: string; email?: string }) => Promise<{ offer: string; id: string }>
  captured: Array<{ opts: any; session: FakeSession }>
} {
  const win = fakeWin()
  const captured: Array<{ opts: any; session: FakeSession }> = []
  initRelayHost(win as never, platform, {
    loadKeys: async () => genKeyPair(),
    mintToken: async () => ({ pairingToken: 'tok' }),
    isPremium: () => true,
    relayAllowed: () => true,
    getEntitlement: () => 'ent',
    licensedSeats: () => seats,
    connect: (o) => {
      const session = makeFakeSession(captured.length)
      captured.push({ opts: o, session })
      return session as unknown as RelayHostSession
    }
  })
  return {
    invite: (opts = {}) =>
      h.handlers[IPC.relayHostInvite]({}, opts) as Promise<{ offer: string; id: string }>,
    captured
  }
}

function openedIds(channel: string): Array<{ id: string; email?: string }> {
  return h.sent.filter((x) => x.channel === channel).map((x) => x.args[0])
}

describe('initRelayHost — Team Access pool (invite/cap)', () => {
  it('invite adds a session (no supersede) and returns a decodable offer', async () => {
    const host = wirePool(3)
    const { offer } = await host.invite({ email: 'a@x.com' })
    expect(decodeOffer(offer)?.pairingToken).toBe('tok')
    expect(host.captured.length).toBe(1)
  })

  it('three invites succeed at cap 3; a 4th is refused with E_SEATS_FULL (no close of others)', async () => {
    const host = wirePool(3)
    await host.invite()
    await host.invite()
    await host.invite()
    expect(host.captured.length).toBe(3)
    await expect(host.invite()).rejects.toThrow(E_SEATS_FULL)
    // The cap does NOT supersede — every existing seat stays live.
    for (const c of host.captured) expect(c.session.close).not.toHaveBeenCalled()
    expect(host.captured.length).toBe(3)
  })

  it('cap 1 refuses a 2nd invite (backward-compat single-peer)', async () => {
    const host = wirePool(1)
    await host.invite()
    await expect(host.invite()).rejects.toThrow(E_SEATS_FULL)
  })

  it('the seat cap counts from mint (pending), before the peer opens', async () => {
    const host = wirePool(1)
    await host.invite()
    // Not even pending yet — no onPeerPending fired — and the seat is already taken.
    await expect(host.invite()).rejects.toThrow(E_SEATS_FULL)
  })
})

describe('initRelayHost — Task-2 review: reserve-at-mint with a revocable id', () => {
  // Finding 1 — the seat is RESERVED synchronously (before the token-mint await), so two concurrent
  // invites can't both pass the cap. Fire both without awaiting the first, then settle.
  it('closes the seat-cap race: two concurrent invites at cap 1 → exactly one succeeds, one E_SEATS_FULL', async () => {
    const host = wirePool(1)
    const results = await Promise.allSettled([host.invite(), host.invite()])
    const statuses = results.map((r) => r.status)
    expect(statuses.filter((s) => s === 'fulfilled').length).toBe(1)
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult | undefined
    expect(String(rejected?.reason)).toContain(E_SEATS_FULL)
  })

  it('invite resolves with a seat id (the same id its peer-pending event later carries)', async () => {
    const host = wirePool(3)
    const { id } = await host.invite({ email: 'a@x.com' })
    expect(id).toBeTruthy()
    host.captured[0].opts.onPeerPending(host.captured[0].session)
    expect(openedIds(IPC.relayHostPeerPending).at(-1)?.id).toBe(id)
  })

  // Finding 2 — a minted invite whose peer never connects is revocable by its returned id (no ghost
  // seat). Before this fix `revoke` couldn't reach it (no id until onPeerPending) and only stop() freed
  // it. A reserved-but-never-handshaked session reports no peer key yet, so revoke has nothing live to
  // cut — it just frees the reservation and tells the renderer. Wire a null-peer-key session to model it.
  it('a pending-never-connected seat is revocable by its returned id and frees the seat', async () => {
    vi.mocked(killRelayHostsByPeerKey).mockClear()
    const win = fakeWin()
    const invite = (): Promise<{ offer: string; id: string }> =>
      h.handlers[IPC.relayHostInvite]({}, {}) as Promise<{ offer: string; id: string }>
    initRelayHost(win as never, platform, {
      loadKeys: async () => genKeyPair(),
      mintToken: async () => ({ pairingToken: 'tok' }),
      isPremium: () => true,
      relayAllowed: () => true,
      getEntitlement: () => 'ent',
      licensedSeats: () => 1,
      // A reserved seat whose peer never completes the handshake: no SAS, no peer key.
      connect: () =>
        ({
          clientId: () => null,
          sas: () => null,
          peerKeyB64: () => null,
          sharedProjectId: () => undefined,
          confirm: vi.fn(),
          close: vi.fn()
        }) as unknown as RelayHostSession
    })
    const { id } = await invite()
    // The peer never connects — no onPeerPending fired — yet the cap is already taken.
    await expect(invite()).rejects.toThrow(E_SEATS_FULL)

    h.handlers[IPC.relayHostRevoke]({}, { id })
    // No live socket to cut (the session never opened), but the seat frees and the renderer is told.
    expect(killRelayHostsByPeerKey).not.toHaveBeenCalled()
    expect(openedIds(IPC.relayHostClosed).at(-1)).toEqual({ id })

    // The freed seat is reusable: a fresh invite succeeds.
    await expect(invite()).resolves.toHaveProperty('offer')
  })

  // Rollback — a mint failure AFTER the synchronous reservation must not leak a seat.
  it('rolls the reservation back on a mint failure (no seat leak)', async () => {
    const win = fakeWin()
    let fail = true
    const captured: FakeSession[] = []
    initRelayHost(win as never, platform, {
      loadKeys: async () => genKeyPair(),
      mintToken: async () => {
        if (fail) throw new Error('mint boom')
        return { pairingToken: 'tok' }
      },
      isPremium: () => true,
      relayAllowed: () => true,
      getEntitlement: () => 'ent',
      licensedSeats: () => 1,
      connect: () => {
        const s = makeFakeSession(captured.length)
        captured.push(s)
        return s as unknown as RelayHostSession
      }
    })
    await expect(h.handlers[IPC.relayHostInvite]({}, {})).rejects.toThrow('mint boom')
    // The reservation was rolled back — at cap 1 a fresh (now-succeeding) invite still fits.
    fail = false
    await expect(h.handlers[IPC.relayHostInvite]({}, {})).resolves.toHaveProperty('offer')
  })
})

describe('initRelayHost — Team Access email label rides the events', () => {
  it('email is carried on peer-pending and open', async () => {
    const host = wirePool(3)
    await host.invite({ email: 'ayse@x.com' })
    host.captured[0].opts.onPeerPending(host.captured[0].session)
    host.captured[0].opts.onOpen()

    const pending = openedIds(IPC.relayHostPeerPending).at(-1)
    expect(pending?.email).toBe('ayse@x.com')
    const open = openedIds(IPC.relayHostOpen).at(-1)
    expect(open?.email).toBe('ayse@x.com')
    expect(open?.id).toBe(pending?.id)
  })
})

describe('initRelayHost — Team Access revoke + seat freeing', () => {
  it('revoke(id) cuts only that peer by identity and frees exactly one seat', async () => {
    vi.mocked(killRelayHostsByPeerKey).mockClear()
    const host = wirePool(3)
    await host.invite()
    await host.invite()
    await host.invite()
    // Make seat 0 pending so it has a renderer id to address.
    host.captured[0].opts.onPeerPending(host.captured[0].session)
    const id0 = openedIds(IPC.relayHostPeerPending).at(-1)!.id

    // At cap: a fresh invite is refused...
    await expect(host.invite()).rejects.toThrow(E_SEATS_FULL)

    h.handlers[IPC.relayHostRevoke]({}, { id: id0 })

    // Cut by the revoked peer's identity only.
    expect(killRelayHostsByPeerKey).toHaveBeenCalledTimes(1)
    expect(killRelayHostsByPeerKey).toHaveBeenCalledWith('peer-0')
    // The renderer is told this seat closed.
    expect(openedIds(IPC.relayHostClosed).at(-1)).toEqual({ id: id0 })

    // Exactly one seat freed: one fresh invite succeeds, the next is refused again.
    await expect(host.invite()).resolves.toHaveProperty('offer')
    await expect(host.invite()).rejects.toThrow(E_SEATS_FULL)
  })

  it('revoke with an unknown id is a no-op (no throw, no cut)', async () => {
    vi.mocked(killRelayHostsByPeerKey).mockClear()
    const host = wirePool(3)
    await host.invite()
    expect(() => h.handlers[IPC.relayHostRevoke]({}, { id: 'nope' })).not.toThrow()
    expect(killRelayHostsByPeerKey).not.toHaveBeenCalled()
  })

  it('a peer dropping (onClose) frees its seat', async () => {
    const host = wirePool(1)
    await host.invite()
    await expect(host.invite()).rejects.toThrow(E_SEATS_FULL)
    // The relay socket drops under seat 0.
    host.captured[0].opts.onClose()
    await expect(host.invite()).resolves.toHaveProperty('offer')
  })
})

describe('initRelayHost — Team Access stop() closes the whole pool', () => {
  it('stop() closes every session and clears the pool', async () => {
    const host = wirePool(3)
    await host.invite()
    await host.invite()
    await host.invite()

    await h.handlers[IPC.relayHostStop]()

    for (const c of host.captured) expect(c.session.close).toHaveBeenCalledTimes(1)
    // The pool is empty again — fresh invites succeed up to the cap.
    await expect(host.invite()).resolves.toHaveProperty('offer')
  })
})

describe('initRelayHost — Team Access start() aliases invite (additive)', () => {
  it('start() adds a seat (no supersede) and is cap-checked', async () => {
    const win = fakeWin()
    const captured: Array<{ session: FakeSession }> = []
    initRelayHost(win as never, platform, {
      loadKeys: async () => genKeyPair(),
      mintToken: async () => ({ pairingToken: 'tok' }),
      isPremium: () => true,
      relayAllowed: () => true,
      getEntitlement: () => 'ent',
      licensedSeats: () => 1,
      connect: () => {
        const session = makeFakeSession(captured.length)
        captured.push({ session })
        return session as unknown as RelayHostSession
      }
    })
    await h.handlers[IPC.relayHostStart]({})
    // A second start does NOT supersede the first (which would close it); it is refused at cap 1.
    await expect(h.handlers[IPC.relayHostStart]({})).rejects.toThrow(E_SEATS_FULL)
    expect(captured[0].session.close).not.toHaveBeenCalled()
  })
})

// ── Board-log bridged to the host over the relay tunnel ──────────────────────────────────────────
// A relay guest reads and writes the HOST project's board-log through the SAME registry-jailed core
// handlers the host's own renderer uses (registerBoardLogHandlers). The board-log-specific relay
// guards (scope jail + leak-free onChanged refcount) live in connectRelayHost, exercised for REAL
// here — only the electron shell + the relay wire are faked, as everywhere in this file.
describe('initRelayHost — board-log bridged to the host', () => {
  let tmp: string
  let routed: string[]

  const req = (
    host: ReturnType<typeof wireHost>,
    id: number,
    method: string,
    ...args: unknown[]
  ): void => host.peerSendsTunnelText(JSON.stringify({ t: 'req', id, method, args }))
  const cast = (host: ReturnType<typeof wireHost>, method: string, ...args: unknown[]): void =>
    host.peerSendsTunnelText(JSON.stringify({ t: 'cast', method, args }))
  const resFor = (host: ReturnType<typeof wireHost>, id: number): Record<string, unknown> | undefined =>
    host.peerFrames.find((f) => f.t === 'res' && f.id === id)

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-boardlog-'))
    // A real project's .nodeterm dir exists on disk (project.json lives there); the store watches it.
    fs.mkdirSync(path.join(tmp, '.nodeterm'), { recursive: true })
    routed = []
    // The host's registry-jailed router: only 'shared' resolves to a real cwd, anything else is
    // unsupported. Records every projectId it is asked to route, to prove an out-of-scope id NEVER
    // reaches dispatch (the relay scope guard short-circuits before the router — and any path — runs).
    registerBoardLogHandlers(platform, {
      route: (projectId: string): BoardLogRoute => {
        routed.push(projectId)
        return projectId === 'shared' ? { kind: 'local', cwd: tmp } : { kind: 'unsupported' }
      }
    })
  })

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('routes append to the shared project’s log, preserving the guest’s own author', async () => {
    const host = wireHost()
    await start('shared')
    await openPeer(host)

    const entry = {
      id: 'e1',
      ts: 1,
      author: { name: 'Ayşe', color: '#ff00ff' }, // the GUEST's presence identity — the feature
      kind: 'comment',
      text: 'hi from the guest'
    }
    req(host, 1, IPC.boardLogAppend, 'shared', entry)
    await vi.waitFor(() => expect(resFor(host, 1)).toMatchObject({ ok: true, result: true }))

    const written = JSON.parse(
      fs.readFileSync(path.join(tmp, '.nodeterm', 'board-log.jsonl'), 'utf-8').trim()
    )
    expect(written.author).toEqual({ name: 'Ayşe', color: '#ff00ff' })
    expect(written.text).toBe('hi from the guest')
  })

  it('read returns the shared project’s entries newest-first', async () => {
    const host = wireHost()
    await start('shared')
    await openPeer(host)

    const mk = (id: string, ts: number): unknown => ({
      id,
      ts,
      author: { name: 'guest', color: '#111111' },
      kind: 'comment',
      text: id
    })
    req(host, 1, IPC.boardLogAppend, 'shared', mk('a', 1))
    await vi.waitFor(() => expect(resFor(host, 1)).toBeTruthy())
    req(host, 2, IPC.boardLogAppend, 'shared', mk('b', 2))
    await vi.waitFor(() => expect(resFor(host, 2)).toBeTruthy())

    req(host, 3, IPC.boardLogRead, 'shared')
    await vi.waitFor(() => expect(resFor(host, 3)).toBeTruthy())
    const result = resFor(host, 3)!.result as { entries: Array<{ id: string }> }
    expect(result.entries.map((e) => e.id)).toEqual(['b', 'a']) // newest-first (disk is oldest-first)
  })

  it('refuses an out-of-scope projectId (read unsupported, append false) without resolving a path', async () => {
    const host = wireHost()
    await start('shared')
    await openPeer(host)
    routed.length = 0 // ignore the open-time routing; focus on the out-of-scope calls below

    req(host, 1, IPC.boardLogRead, 'other-project')
    await vi.waitFor(() => expect(resFor(host, 1)).toBeTruthy())
    expect(resFor(host, 1)!.result).toEqual({ entries: [], unsupported: true })

    req(host, 2, IPC.boardLogAppend, 'other-project', {
      id: 'x',
      ts: 1,
      author: { name: 'guest', color: '#111111' },
      kind: 'comment',
      text: 'nope'
    })
    await vi.waitFor(() => expect(resFor(host, 2)).toBeTruthy())
    expect(resFor(host, 2)!.result).toBe(false)

    // The scope guard short-circuits BEFORE dispatch, so the host router is never even asked about an
    // out-of-scope project — no filesystem path is ever resolved from a client-supplied id.
    expect(routed).not.toContain('other-project')
  })

  it('a host-side change pushes boardLogChanged to the subscribed peer, and a socket drop releases the watch', async () => {
    // A spy alongside the real board-log handler on the unsubscribe channel: proves the balancing
    // unsubscribe is replayed on drop (the shared per-project watch refcount is released — no leak).
    const unsubSpy = vi.fn()
    platform.on(IPC.boardLogUnsubscribe, unsubSpy)

    const host = wireHost()
    await start('shared')
    await openPeer(host)

    cast(host, IPC.boardLogSubscribe, 'shared')
    await new Promise((r) => setTimeout(r, 50)) // let the subscribe cast arm the fs.watch

    // A real append changes the file; the store's watch (debounced 250ms) broadcasts the change,
    // which fans out to the peer sink over the tunnel as a boardLogChanged event.
    fs.appendFileSync(
      path.join(tmp, '.nodeterm', 'board-log.jsonl'),
      JSON.stringify({ id: 'z', ts: 9, author: { name: 'guest', color: '#111111' }, kind: 'comment', text: 'ping' }) +
        '\n'
    )
    await vi.waitFor(
      () =>
        expect(
          host.peerFrames.some((f) => f.t === 'ev' && f.channel === IPC.boardLogChanged('shared'))
        ).toBe(true),
      { timeout: 3000 }
    )

    // The socket drops with no client-sent unsubscribe (a closed guest tab). The host must replay the
    // balancing unsubscribe so the per-project watch is not leaked.
    host.dropSocket()
    expect(unsubSpy).toHaveBeenCalledWith('shared')
  })

  it('an out-of-scope subscribe never reaches the core watch', async () => {
    const subSpy = vi.fn()
    platform.on(IPC.boardLogSubscribe, subSpy)
    const host = wireHost()
    await start('shared')
    await openPeer(host)

    cast(host, IPC.boardLogSubscribe, 'other-project')
    await new Promise((r) => setTimeout(r, 20))
    expect(subSpy).not.toHaveBeenCalled() // scope-jailed before it could arm a watch
  })
})
