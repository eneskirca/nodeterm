// Task 3 (docs/remote-sessions.md 4c): the CLIENT half of the mutual-approval handshake and the
// tunnel↔renderer frame pipe. This pairs the REAL `connectRelayHost` (Task 2) with the new
// `connectRelayClient` over an in-process RelayTransport pair — the same fake wire relay-host.test.ts
// and relay-trust.test.ts drive. Nothing crypto/tunnel/trust is faked: the E2EE handshake, the
// session key, both trust gates, electronPlatform, the peer registry and presence are the real,
// wired objects. Only the electron shell boundary and the relay WIRE are stand-ins.
//
// SECURITY the client MUST prove here (a mistake is a shell-access hole on the OTHER desktop, but
// the client's own obligations are symmetric):
//   - obligation (a): the "I confirmed" that opens the session rides the ENCRYPTED tunnel. A forged
//     PLAINTEXT confirm injected by the relay MUST NOT advance approval or open the client.
//   - the confirm binds to THIS session's host key (the pinned key that keyed the ECDH shared secret
//     the SAS is derived from): both ends compute the SAME SAS, and mutual confirm opens the client.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const h: {
  handlers: Record<string, (...a: any[]) => unknown>
  sent: Array<{ id?: number; channel: string; args: any[] }>
  clientIds: number[]
} = { handlers: {}, sent: [], clientIds: [] }

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
  webContents: {
    fromId: (id: number) =>
      id === 1
        ? {
            isDestroyed: () => false,
            send: (ch: string, ...args: any[]) => h.sent.push({ id, channel: ch, args })
          }
        : undefined
  },
  shell: { openExternal: vi.fn(async () => {}) }
}))

vi.mock('../main-window', () => ({
  sendToMain: (ch: string, ...args: any[]) => h.sent.push({ channel: ch, args }),
  mainWindowClientIds: () => h.clientIds
}))

// The on-disk pin store, in memory (the trust gate's default load/save path). Each side pins the
// OTHER end's key here.
import { emptyApprovedDevices, type ApprovedDevices } from './approved-devices-core'
let disk: ApprovedDevices = emptyApprovedDevices()
vi.mock('./approved-devices', () => ({
  updateApprovedDevices: async (update: (s: ApprovedDevices) => ApprovedDevices) => { disk = update(disk) },
  loadApprovedDevices: async () => disk,
  saveApprovedDevices: async (s: ApprovedDevices) => {
    disk = s
  }
}))

import { connectRelayHost, type RelayHostSession } from './relay-host'
import { connectRelayClient, type RelayClientSession } from './relay-client'
import { type RelayTransport } from './relay-socket'
import { genKeyPair, publicKeyToB64 } from './e2ee'
import { TRUST_CONFIRM } from './relay-trust'
import { electronPlatform, type ElectronPlatform } from '../platform-electron'
import { peerRegistry, unregisterPeerSink, wirePeerRegistry } from '../peer-registry'
import { presenceHub } from '../../core/presence/hub'
import { initCanvasSync } from '../../core/canvas-sync'
import { initPlatform, resetPlatformForTests } from '../../core/platform'

let platform: ElectronPlatform
let gone: number[] = []

/**
 * A REAL host session (connectRelayHost against the real platform) bridged to a REAL
 * connectRelayClient over an in-process transport pair. Exposes both trust surfaces plus a hook to
 * inject a forged PLAINTEXT frame straight at the client (what a relay MITM can do).
 */
function pairHostAndClient(): {
  host: RelayHostSession
  client: RelayClientSession
  clientSas: () => string | null
  approved: RelayClientSession[]
  frames: string[]
  ptyData: Array<{ sessionId: string; data: string }>
  clientClosed: () => number
  /** Inject an arbitrary PLAINTEXT string (or bytes) at the client, as the relay could. */
  injectToClient: (raw: string | Uint8Array) => void
  /** BOTH humans press Confirm (each confirm rides its own encrypted tunnel). */
  openMutually: () => Promise<void>
} {
  const hostKeys = genKeyPair()
  const clientKeys = genKeyPair()

  let hostOnMsg: ((d: unknown) => void) | null = null
  let clientOnMsg: ((d: unknown) => void) | null = null
  let hostOnClose: (() => void) | null = null
  let clientOnClose: (() => void) | null = null

  const hostT: RelayTransport = {
    bufferedAmount: 0,
    send: (d) => clientOnMsg?.(d),
    close: () => clientOnClose?.(),
    onMessage: (cb) => {
      hostOnMsg = cb
    },
    onClose: (cb) => {
      hostOnClose = cb
    }
  }
  const clientT: RelayTransport = {
    bufferedAmount: 0,
    send: (d) => hostOnMsg?.(d),
    close: () => hostOnClose?.(),
    onMessage: (cb) => {
      clientOnMsg = cb
    },
    onClose: (cb) => {
      clientOnClose = cb
    }
  }

  // The host FIRST: it waits passively for the client's e2ee_hello.
  const host = connectRelayHost({
    url: 'wss://relay.example',
    token: 'tok',
    ourKeys: hostKeys,
    platform,
    transport: hostT,
    onPeerPending: () => {},
    onOpen: () => {},
    onClose: () => {}
  })

  const approved: RelayClientSession[] = []
  const frames: string[] = []
  const ptyData: Array<{ sessionId: string; data: string }> = []
  let clientClosed = 0

  // The client: constructing it drives the whole handshake synchronously over the in-process pair.
  const client = connectRelayClient({
    url: 'wss://relay.example',
    token: 'tok',
    hostKeyB64: publicKeyToB64(hostKeys.publicKey),
    ourKeys: clientKeys,
    transport: clientT,
    onSas: () => {},
    onApproved: (s) => approved.push(s),
    onFrame: (json) => frames.push(json),
    onPtyData: (sessionId, data) => ptyData.push({ sessionId, data }),
    onClose: () => {
      clientClosed++
    }
  })

  return {
    host,
    client,
    clientSas: () => client.sas(),
    approved,
    frames,
    ptyData,
    clientClosed: () => clientClosed,
    injectToClient: (raw) => clientOnMsg?.(raw),
    openMutually: async () => {
      client.confirm() // this human, over the ENCRYPTED tunnel → the host's confirmRemote
      host.confirm() // the other human, over its ENCRYPTED tunnel → the client's confirmRemote
      await vi.waitFor(() => expect(client.isOpen()).toBe(true))
      await vi.waitFor(() => expect(host.clientId()).not.toBeNull())
    }
  }
}

beforeEach(() => {
  h.handlers = {}
  h.sent = []
  h.clientIds = [1]
  disk = emptyApprovedDevices()
  gone = []
  platform = electronPlatform()
  initPlatform(platform)
  wirePeerRegistry({
    setFlow: () => {},
    captureForResync: async () => 'SCREEN',
    onPeerGone: (id) => gone.push(id)
  })
  presenceHub.registerIpc()
  initCanvasSync()
})

afterEach(() => {
  for (const id of peerRegistry().ids()) unregisterPeerSink(id)
  for (const pe of presenceHub.peers()) presenceHub.leave(pe.clientId)
  resetPlatformForTests()
})

describe('relay client — SAS + mutual approval', () => {
  it('both ends derive the SAME 6-digit SAS from this session', () => {
    const p = pairHostAndClient()
    expect(p.clientSas()).toMatch(/^\d{3} \d{3}$/)
    expect(p.clientSas()).toBe(p.host.sas())
  })

  it('mutual confirm opens the client (onApproved fires) and the host (a live CorePlatform client)', async () => {
    const p = pairHostAndClient()
    expect(p.client.isOpen()).toBe(false)
    expect(p.approved).toEqual([])

    await p.openMutually()

    expect(p.client.isOpen()).toBe(true)
    expect(p.approved).toEqual([p.client]) // onApproved fired exactly once, with the session
    expect(p.host.clientId()).not.toBeNull()
  })

  it('ONE side confirming is not enough — the client stays closed', async () => {
    const p = pairHostAndClient()
    p.client.confirm() // only this human
    await new Promise((r) => setTimeout(r, 20))
    expect(p.client.isOpen()).toBe(false)
    expect(p.approved).toEqual([])
  })
})

describe('relay client — obligation (a): the confirm MUST ride the encrypted tunnel', () => {
  it('a forged PLAINTEXT confirm never advances approval nor opens the client', async () => {
    const p = pairHostAndClient()
    p.client.confirm() // the local human confirms — one-way approval must NOT be enough

    // A relay MITM injects plaintext frames that *look* like the host's confirm, in every dialect
    // the code knows. None is sealed under the session key, so none can reach the trust gate.
    p.injectToClient(JSON.stringify({ t: 'cast', method: TRUST_CONFIRM, args: [] }))
    p.injectToClient(JSON.stringify({ type: TRUST_CONFIRM }))
    p.injectToClient(JSON.stringify({ kind: 'notify', method: TRUST_CONFIRM, params: {} }))
    p.injectToClient(JSON.stringify({ kind: 'req', id: '1', method: TRUST_CONFIRM, params: {} }))
    // ...and raw bytes, which cannot decrypt.
    p.injectToClient(new TextEncoder().encode(JSON.stringify({ t: 'cast', method: TRUST_CONFIRM })))
    await new Promise((r) => setTimeout(r, 20))

    expect(p.client.isOpen()).toBe(false) // approval did NOT advance
    expect(p.approved).toEqual([]) // the session never opened
    expect(disk.pubkeys).toEqual([]) // nothing pinned
  })
})

describe('relay client — the frame pipe (tunnel ↔ renderer)', () => {
  it('refuses to send a req BEFORE mutual approval, so the host dispatches nothing', async () => {
    let created = 0
    platform.handle('pty:create', async () => {
      created++
      return { id: 'x' }
    })
    const p = pairHostAndClient()

    const sent = p.client.send(
      JSON.stringify({ t: 'req', id: 1, method: 'pty:create', args: [{ cols: 80, rows: 24 }] })
    )
    await new Promise((r) => setTimeout(r, 20))

    expect(sent).toBe(false) // refused locally — nothing left this machine
    expect(created).toBe(0) // and the host handler never ran
    expect(p.frames).toEqual([]) // no response frame either
  })

  it('after open, a req round-trips through platform.dispatch and its res reaches the client', async () => {
    platform.handle('fs:list', async (dir: string) => [`${dir}/a.ts`])
    const p = pairHostAndClient()
    await p.openMutually()

    const sent = p.client.send(JSON.stringify({ t: 'req', id: 7, method: 'fs:list', args: ['/w'] }))
    expect(sent).toBe(true)

    await vi.waitFor(() =>
      expect(p.frames.map((j) => JSON.parse(j))).toContainEqual(
        expect.objectContaining({ t: 'res', id: 7, ok: true, result: ['/w/a.ts'] })
      )
    )
  })

  it('forwards a host pty:data BINARY frame to onPtyData (decoded), not to onFrame', async () => {
    const p = pairHostAndClient()
    await p.openMutually()
    const id = p.host.clientId()!

    // The host streams pty output to this client; the peer sink turns it into a BINARY tunnel frame.
    platform.sendTo(id, 'pty:data:s1', 'hello world')

    await vi.waitFor(() => expect(p.ptyData).toEqual([{ sessionId: 's1', data: 'hello world' }]))
    // pty:data must not leak onto the JSON frame pipe.
    expect(p.frames.some((j) => j.includes('hello world'))).toBe(false)
  })
})

describe('relay client — teardown', () => {
  it('disconnect() closes the socket and is idempotent; the host peer is torn down', async () => {
    const p = pairHostAndClient()
    await p.openMutually()
    const id = p.host.clientId()!
    expect(peerRegistry().ids()).toContain(id)

    p.client.close()
    p.client.close()

    // The socket close propagates to the host, which runs its ONE teardown (dropClient + prune).
    await vi.waitFor(() => expect(gone).toEqual([id]))
    expect(peerRegistry().ids()).not.toContain(id)
  })

  it('a relay-side socket drop fires the client onClose once', async () => {
    const p = pairHostAndClient()
    await p.openMutually()
    // Close from the host end: the pair forwards the close to the client transport.
    p.host.close()
    await vi.waitFor(() => expect(p.clientClosed()).toBe(1))
  })
})
