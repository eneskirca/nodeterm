// The merge gate for obligation (a) of mutual-approval-core.ts: a peer's confirmation may ONLY
// arrive over the ENCRYPTED, session-keyed tunnel. These tests drive REAL relay sockets over
// in-process transports, so the forged-confirm test attacks the same code path a relay MITM has:
// it can inject anything it likes onto the wire, but it holds no session key.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { connectRelay, type RelaySocket, type RelayTransport } from './relay-socket'
import {
  deriveSessionKey,
  deriveSharedKey,
  encrypt,
  genKeyPair,
  publicKeyToB64,
  randomSessionNonce
} from './e2ee'
import { emptyApprovedDevices, type ApprovedDevices } from './approved-devices-core'
import { TRUST_CONFIRM, createTrustGate, type TrustGate } from './relay-trust'

// The on-disk pin store, in memory. relay-trust's DEFAULT load/save are the electron-backed ones in
// ./approved-devices — mocking the module (rather than injecting fakes) means these tests exercise
// the production default path, not a test-only branch.
let disk: ApprovedDevices = emptyApprovedDevices()
vi.mock('./approved-devices', () => ({
  updateApprovedDevices: async (update: (s: ApprovedDevices) => ApprovedDevices) => { disk = update(disk) },
  loadApprovedDevices: async () => disk,
  saveApprovedDevices: async (s: ApprovedDevices) => {
    disk = s
  }
}))
import { loadApprovedDevices } from './approved-devices'

beforeEach(() => {
  disk = emptyApprovedDevices()
})

// A pair of in-process transports wired host<->client, PLUS the relay's own injection ports: the
// relay is untrusted and forwards opaque bytes, so it can also *originate* traffic in either
// direction. `injectToHost` / `injectToClient` are that attacker capability.
function makeTransportPair(): {
  host: RelayTransport
  client: RelayTransport
  injectToHost: (data: string | Uint8Array) => void
  injectToClient: (data: string | Uint8Array) => void
} {
  let hostOnMsg: ((d: unknown) => void) | null = null
  let clientOnMsg: ((d: unknown) => void) | null = null
  const host: RelayTransport = {
    bufferedAmount: 0,
    send: (d) => clientOnMsg?.(d),
    close: () => {},
    onMessage: (cb) => (hostOnMsg = cb),
    onClose: () => {}
  }
  const client: RelayTransport = {
    bufferedAmount: 0,
    send: (d) => hostOnMsg?.(d),
    close: () => {},
    onMessage: (cb) => (clientOnMsg = cb),
    onClose: () => {}
  }
  return {
    host,
    client,
    injectToHost: (d) => hostOnMsg?.(d),
    injectToClient: (d) => clientOnMsg?.(d)
  }
}

const textDecoder = new TextDecoder()

// Two real relay sockets, each with a trust gate hung off its `onTunnel` — exactly the wiring the
// handshake must use: `onTunnelText` is reachable from nowhere else.
// `isolate` models the two ends as what they really are — two MACHINES with two pin stores. Left
// off (the default), both gates fall through to relay-trust's DEFAULT load/save (the production
// `./approved-devices` path, mocked to `disk`), which is what the forged-confirm merge gate must
// exercise: it has to prove that the real code path pins NOTHING.
function bridgedPair(isolate = false): {
  hostGate: TrustGate
  peerGate: TrustGate
  opened: string[]
  pair: ReturnType<typeof makeTransportPair>
  store: (end: 'host' | 'peer') => ApprovedDevices
} {
  const hostKeys = genKeyPair()
  const clientKeys = genKeyPair()
  const pair = makeTransportPair()
  const opened: string[] = []

  let hostGate: TrustGate | null = null
  let peerGate: TrustGate | null = null
  let hostReady = false
  let clientReady = false

  const hostSocket: RelaySocket = connectRelay({
    url: 'x',
    token: 't',
    role: 'host',
    ourKeys: hostKeys,
    transport: pair.host,
    onReady: () => (hostReady = true),
    onRpc: () => {},
    onFrame: () => {},
    onClose: () => {},
    onTunnel: (kind, payload) => {
      if (kind === 'text') hostGate?.onTunnelText(textDecoder.decode(payload))
    }
  })
  const clientSocket: RelaySocket = connectRelay({
    url: 'x',
    token: 't',
    role: 'client',
    ourKeys: clientKeys,
    theirPubB64: publicKeyToB64(hostKeys.publicKey),
    transport: pair.client,
    onReady: () => (clientReady = true),
    onRpc: () => {},
    onFrame: () => {},
    onClose: () => {},
    onTunnel: (kind, payload) => {
      if (kind === 'text') peerGate?.onTunnelText(textDecoder.decode(payload))
    }
  })
  // The in-process handshake completes synchronously inside the second connectRelay.
  expect(hostReady && clientReady).toBe(true)

  const stores: Record<'host' | 'peer', ApprovedDevices> = {
    host: emptyApprovedDevices(),
    peer: emptyApprovedDevices()
  }
  const gateFor = (socket: RelaySocket, tag: 'host' | 'peer'): TrustGate =>
    createTrustGate({
      peerKeyB64: socket.peerPublicKeyB64()!,
      sessionId: `session-${tag}`,
      sas: () => socket.sas(),
      sendConfirm: (json) => socket.sendTunnelText(json),
      onOpen: () => opened.push(tag),
      ...(isolate
        ? {
            load: async () => stores[tag],
            save: async (s: ApprovedDevices) => {
              stores[tag] = s
            }
          }
        : {})
    })
  hostGate = gateFor(hostSocket, 'host')
  peerGate = gateFor(clientSocket, 'peer')

  return { hostGate, peerGate, opened, pair, store: (end) => stores[end] }
}

const confirmJson = JSON.stringify({ t: 'cast', method: TRUST_CONFIRM, args: [] })

describe('obligation (a): only the encrypted tunnel can confirm the peer', () => {
  it('a forged PLAINTEXT confirm does not advance approval, does not open, pins nothing', async () => {
    const { hostGate, opened, pair } = bridgedPair()

    hostGate.confirmHere() // the local human confirms — one-way approval must NOT be enough

    // The MITM injects plaintext control frames that *look* like the peer's confirm, in every
    // dialect the code knows: the tunnel envelope, the legacy handshake shape, the hand-rolled
    // RPC envelope. None of them is sealed under the session key.
    pair.injectToHost(confirmJson)
    pair.injectToHost(JSON.stringify({ type: TRUST_CONFIRM }))
    pair.injectToHost(JSON.stringify({ kind: 'notify', method: TRUST_CONFIRM, params: {} }))
    pair.injectToHost(JSON.stringify({ kind: 'req', id: '1', method: TRUST_CONFIRM, params: {} }))
    // ...and raw bytes, which cannot decrypt.
    pair.injectToHost(new TextEncoder().encode(confirmJson))
    await new Promise((r) => setTimeout(r, 20))

    expect(hostGate.isOpen()).toBe(false) // approval did NOT advance
    expect(opened).toEqual([]) // no session opened
    expect((await loadApprovedDevices()).pubkeys).toEqual([]) // nothing pinned
  })

  it('a confirm that arrives over the ENCRYPTED tunnel does advance it (and pins, once)', async () => {
    const { hostGate, peerGate, opened, store } = bridgedPair(true)

    hostGate.confirmHere()
    expect(hostGate.isOpen()).toBe(false) // still waiting on the other human
    peerGate.confirmHere()

    await vi.waitFor(() => expect(hostGate.isOpen()).toBe(true))
    await vi.waitFor(() => expect(peerGate.isOpen()).toBe(true))
    expect(opened.sort()).toEqual(['host', 'peer'])
    // Each end pinned the OTHER end's key, in its own store, exactly once.
    await vi.waitFor(() => {
      expect(store('host').pubkeys).toEqual([hostGate.peerKeyB64()!])
      expect(store('peer').pubkeys).toEqual([peerGate.peerKeyB64()!])
    })
    expect(hostGate.peerKeyB64()).not.toBe(peerGate.peerKeyB64())
  })

  it('both ends see the same SAS (the digits the humans compare)', () => {
    const { hostGate, peerGate } = bridgedPair()
    expect(hostGate.sas()).toMatch(/^\d{3} \d{3}$/)
    expect(hostGate.sas()).toBe(peerGate.sas())
  })

  // The full attack obligation (a) exists to defeat: after the genuine handshake AND the host human's
  // confirm, a relay MITM injects a plaintext e2ee_hello to re-key the LIVE session under its own
  // keypair, then seals a trust:confirm under the swapped key. If the re-key were honoured, the box
  // would decrypt, reach confirmRemote, mutually approve, and pin — forging the second human's
  // consent. The MITM knows the host's session nonce (it saw e2ee_ready on the wire) and chooses its
  // own, so it can compute the exact key the host WOULD adopt.
  it('an attacker re-key + sealed trust:confirm does NOT confirm the peer or pin any key', async () => {
    const hostKeys = genKeyPair()
    const clientKeys = genKeyPair()
    const attackerKeys = genKeyPair()

    // Wire host<->client, capturing every frame the host emits (a real relay sees every byte).
    let hostOnMsg: ((d: unknown) => void) | null = null
    let clientOnMsg: ((d: unknown) => void) | null = null
    const hostEmitted: unknown[] = []
    const hostT: RelayTransport = {
      bufferedAmount: 0,
      send: (d) => {
        hostEmitted.push(d)
        clientOnMsg?.(d)
      },
      close: () => {},
      onMessage: (cb) => (hostOnMsg = cb),
      onClose: () => {}
    }
    const clientT: RelayTransport = {
      bufferedAmount: 0,
      send: (d) => hostOnMsg?.(d),
      close: () => {},
      onMessage: (cb) => (clientOnMsg = cb),
      onClose: () => {}
    }

    const opened: string[] = []
    let hostGate: TrustGate | null = null
    const hostSocket = connectRelay({
      url: 'x',
      token: 't',
      role: 'host',
      ourKeys: hostKeys,
      transport: hostT,
      onReady: () => {},
      onRpc: () => {},
      onFrame: () => {},
      onClose: () => {},
      onTunnel: (kind, payload) => {
        if (kind === 'text') hostGate?.onTunnelText(textDecoder.decode(payload))
      }
    })
    connectRelay({
      url: 'x',
      token: 't',
      role: 'client',
      ourKeys: clientKeys,
      theirPubB64: publicKeyToB64(hostKeys.publicKey),
      transport: clientT,
      onReady: () => {},
      onRpc: () => {},
      onFrame: () => {},
      onClose: () => {},
      onTunnel: () => {}
    })

    hostGate = createTrustGate({
      peerKeyB64: hostSocket.peerPublicKeyB64()!,
      sessionId: 'session-host',
      sas: () => hostSocket.sas(),
      sendConfirm: (json) => hostSocket.sendTunnelText(json),
      onOpen: () => opened.push('host')
    })

    hostGate.confirmHere() // the HOST human confirmed — only the second human's consent is missing

    // The MITM reads the host's own session nonce off the wire (from e2ee_ready).
    const readyFrame = hostEmitted
      .filter((f): f is string => typeof f === 'string')
      .map((s) => JSON.parse(s) as { type?: string; nonceB64?: string })
      .find((m) => m.type === 'e2ee_ready')
    expect(readyFrame?.nonceB64).toBeTruthy()
    const hostNonce = Uint8Array.from(Buffer.from(readyFrame!.nonceB64!, 'base64'))

    // 1. Re-key attempt: a plaintext e2ee_hello with the attacker's keypair.
    const attackerNonce = randomSessionNonce()
    hostOnMsg!(
      JSON.stringify({
        type: 'e2ee_hello',
        publicKeyB64: publicKeyToB64(attackerKeys.publicKey),
        nonceB64: Buffer.from(attackerNonce).toString('base64')
      })
    )

    // 2. Seal trust:confirm under the key the host WOULD derive from the attacker's hello. Plaintext
    //    layout mirrors relay-socket withHeader+tagged: [role=2 (client)][seq:8 LE][TAG_TUNNEL_TEXT=3][json].
    const attackerBase = deriveSharedKey(publicKeyToB64(hostKeys.publicKey), attackerKeys.secretKey)
    const attackerSession = deriveSessionKey(attackerBase, hostNonce, attackerNonce)
    const jsonBytes = new TextEncoder().encode(confirmJson)
    const plain = new Uint8Array(1 + 8 + 1 + jsonBytes.length)
    plain[0] = 2 // PEER_ROLE from the host's perspective (client)
    const seq = 1000 // any value beyond the host's small handshake recvSeq
    const view = new DataView(plain.buffer)
    view.setUint32(1, Math.floor(seq / 0x100000000), true)
    view.setUint32(5, seq >>> 0, true)
    plain[9] = 0x03 // TAG_TUNNEL_TEXT
    plain.set(jsonBytes, 10)
    hostOnMsg!(encrypt(plain, attackerSession))

    await new Promise((r) => setTimeout(r, 20))

    // The forged confirm never landed: no mutual approval, no pin, and the session identity the two
    // humans compared is unchanged (still the real peer, never the attacker).
    expect(hostGate.isOpen()).toBe(false)
    expect(opened).toEqual([])
    expect((await loadApprovedDevices()).pubkeys).toEqual([])
    expect(hostSocket.peerPublicKeyB64()).toBe(publicKeyToB64(clientKeys.publicKey))
    expect(hostSocket.peerPublicKeyB64()).not.toBe(publicKeyToB64(attackerKeys.publicKey))
  })
})

describe('obligation (b): exactly one MutualApproval per pairing attempt', () => {
  it('a repeated remote confirm is idempotent and never stands in for the local one', () => {
    const sent: string[] = []
    const opened: string[] = []
    const gate = createTrustGate({
      peerKeyB64: 'PEER',
      sessionId: 's1',
      sas: () => '111 222',
      sendConfirm: (j) => sent.push(j),
      onOpen: () => opened.push('open'),
      load: async () => disk,
      save: async (s) => {
        disk = s
      }
    })

    expect(gate.onTunnelText(confirmJson)).toBe(true)
    expect(gate.onTunnelText(confirmJson)).toBe(true)
    expect(gate.isOpen()).toBe(false)
    expect(opened).toEqual([])
    expect(sent).toEqual([]) // we never echoed a confirm we did not make
  })

  it('ignores tunnel frames that are not a trust confirm (they stay available to the RPC dispatcher)', () => {
    const gate = createTrustGate({
      peerKeyB64: 'PEER',
      sessionId: 's1',
      sas: () => null,
      sendConfirm: () => {},
      onOpen: () => {},
      load: async () => disk,
      save: async (s) => {
        disk = s
      }
    })
    expect(gate.onTunnelText(JSON.stringify({ t: 'cast', method: 'pty.write', args: [] }))).toBe(false)
    expect(gate.onTunnelText(JSON.stringify({ t: 'req', id: 1, method: TRUST_CONFIRM, args: [] }))).toBe(
      false
    )
    expect(gate.onTunnelText('not json')).toBe(false)
    expect(gate.isOpen()).toBe(false)
  })

  it("a confirm delivered on session A's tunnel cannot advance session B's state", async () => {
    const a = bridgedPair()
    const b = bridgedPair()

    // Both humans on BOTH pairings pressed Confirm locally — only the remote half is missing.
    a.hostGate.confirmHere()
    b.hostGate.confirmHere()

    // Session A completes: its peer confirms over A's encrypted tunnel.
    a.peerGate.confirmHere()
    await vi.waitFor(() => expect(a.hostGate.isOpen()).toBe(true))

    // B's state is a DIFFERENT MutualApproval, bound to a different peer key + session. A's confirm
    // reached A's gate only; nothing routed it to B.
    expect(b.hostGate.isOpen()).toBe(false)
    expect(b.opened).toEqual([])
    expect((await loadApprovedDevices()).pubkeys).not.toContain(b.hostGate.peerKeyB64())

    // Even replayed verbatim onto B's WIRE, A's ciphertext does not decrypt under B's session key.
    b.pair.injectToHost(confirmJson)
    await new Promise((r) => setTimeout(r, 20))
    expect(b.hostGate.isOpen()).toBe(false)
  })
})
