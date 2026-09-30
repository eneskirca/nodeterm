// src/core/relay/relay-host.key-swap.test.ts
// The key-swap self-close must tell the shell, like every other close the shell did not ask for.
// relay-socket's layer-1 guard makes a mid-session re-key unreachable over a real handshake, so the
// host's socket is wrapped here to report a different peer key on demand: that is the only way to
// reach relay-host's second, independent check (peerKeyIntact). Kept in its own file so the module
// mock cannot touch any other suite.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { connectRelayHost, type PeerAttach } from './relay-host'
import { connectRelayClient } from './relay-client'
import { transportPair } from './transport-pair'
import { genKeyPair, publicKeyToB64 } from './e2ee'

const swap = vi.hoisted(() => ({ hostSeesPeerKey: null as string | null }))

vi.mock('./relay-socket', async (importOriginal) => {
  const real = await importOriginal<typeof import('./relay-socket')>()
  return {
    ...real,
    connectRelay: (o: Parameters<typeof real.connectRelay>[0]) => {
      const s = real.connectRelay(o)
      if (o.role !== 'host') return s
      // The socket's methods are closures (no `this`), so a spread copy behaves exactly like it.
      return { ...s, peerPublicKeyB64: () => swap.hostSeesPeerKey ?? s.peerPublicKeyB64() }
    }
  }
})

afterEach(() => {
  swap.hostSeesPeerKey = null
})

function fakeAttach() {
  const sinks = new Map<number, unknown>()
  let next = 1
  const attach: PeerAttach = {
    attach: (sink) => { const id = next++; sinks.set(id, sink); return id },
    detach: (id) => { sinks.delete(id) },
    dispatch: async (_id, req) => ({ t: 'res', id: req.id, ok: true, result: 'ok' }),
    cast: () => {}
  }
  return { attach, sinks }
}

const settle = () => new Promise((r) => setTimeout(r, 20))

describe('core relay host — the key-swap self-close', () => {
  it('fires onClose exactly once when an OPEN session’s key is found swapped, and detaches the peer', async () => {
    const hostKeys = genKeyPair()
    const { hostT, peerT } = transportPair()
    const fa = fakeAttach()
    const counts = { opened: 0, hostClosed: 0, clientClosed: 0 }
    const host = connectRelayHost({
      url: 'ws://127.0.0.1/x', token: 't', ourKeys: hostKeys, attach: fa.attach, transport: hostT,
      autoApprove: () => true,
      onPeerPending: () => {}, onOpen: () => counts.opened++, onClose: () => counts.hostClosed++
    })
    const client = connectRelayClient({
      url: 'ws://127.0.0.1/x', token: 't', hostKeyB64: publicKeyToB64(hostKeys.publicKey), ourKeys: genKeyPair(),
      transport: peerT, autoApprove: true, onSas: () => {}, onApproved: () => {}, onFrame: () => {},
      onPtyData: () => {}, onClose: () => counts.clientClosed++
    })
    await vi.waitFor(() => expect(counts.opened).toBe(1))
    expect(fa.sinks.size).toBe(1)

    swap.hostSeesPeerKey = publicKeyToB64(genKeyPair().publicKey)
    client.send(JSON.stringify({ t: 'req', id: 1, method: 'anything', args: [] }))
    await settle()

    expect(counts.hostClosed).toBe(1)
    expect(counts.clientClosed).toBe(1)
    expect(fa.sinks.size).toBe(0)
    expect(host.clientId()).toBeNull()
    // Nothing the shell does afterwards fires it again.
    host.close()
    host.deny('denied')
    await settle()
    expect(counts.hostClosed).toBe(1)
  })

  it('fires onClose exactly once when the swap is found at open (the pin write was in flight), and never opens', async () => {
    const hostKeys = genKeyPair()
    const { hostT, peerT } = transportPair()
    const fa = fakeAttach()
    const counts = { opened: 0, hostClosed: 0, records: 0 }
    let finishPin!: () => void
    connectRelayHost({
      url: 'ws://127.0.0.1/x', token: 't', ourKeys: hostKeys, attach: fa.attach, transport: hostT,
      autoApprove: () => true,
      pins: { record: () => { counts.records++; return new Promise<void>((r) => { finishPin = r }) } },
      onPeerPending: () => {}, onOpen: () => counts.opened++, onClose: () => counts.hostClosed++
    })
    connectRelayClient({
      url: 'ws://127.0.0.1/x', token: 't', hostKeyB64: publicKeyToB64(hostKeys.publicKey), ourKeys: genKeyPair(),
      transport: peerT, autoApprove: true, onSas: () => {}, onApproved: () => {}, onFrame: () => {},
      onPtyData: () => {}, onClose: () => {}
    })
    await vi.waitFor(() => expect(counts.records).toBe(1))
    swap.hostSeesPeerKey = publicKeyToB64(genKeyPair().publicKey)
    finishPin()
    await settle()

    expect(counts.opened).toBe(0)
    expect(fa.sinks.size).toBe(0)
    expect(counts.hostClosed).toBe(1)
  })
})
