// The viewer client runs against the REAL host-role relay socket and the REAL trust gate, not fakes.
// That is what pins the wire constants src/shared/watch-link/wire.ts restates (the seq header, TAG_*,
// ROLE_*, NONCE_BYTES) and the trust frames client.ts builds: they are module-private in
// relay-socket.ts / owned by relay-trust.ts, so a drift there shows up here as a handshake that never
// completes, a frame the host never sees, or a gate that never opens. It lives in core because it
// imports core modules the web tsconfig project that vendors src/shared/watch-link cannot see.
import { describe, it, expect, vi } from 'vitest'
import nacl from 'tweetnacl'
import { connectRelay } from '../relay/relay-socket'
import { transportPair } from '../relay/transport-pair'
import { publicKeyToB64 } from '../relay/e2ee'
import { createTrustGate, deniedFrame, type TrustGate } from '../relay/relay-trust'
import { encodePtyData } from '../../shared/rpc'
import { connectWatchClient, TRUST_CONFIRM_JSON, type WatchSocket } from '../../shared/watch-link/client'
import { deriveWatchLinkKeys, type WatchLinkKeys } from '../../shared/watch-link/keys'

function hostWith(opts: { keys?: WatchLinkKeys; autoApprove?: boolean } = {}) {
  const keys = opts.keys ?? deriveWatchLinkKeys(nacl.randomBytes(32))
  const { hostT, peerT } = transportPair()
  const tunnel: string[] = []
  let ready = false
  let closed = 0
  let gateOpened = false
  let gate: TrustGate | null = null
  const host = connectRelay({
    url: 'wss://x', token: 't', role: 'host',
    ourKeys: { publicKey: keys.host.publicKey, secretKey: keys.host.secretKey },
    transport: hostT,
    onReady: () => {
      ready = true
      // The host's own gate, wired the way the relay hosts wire it: confirms travel only over the
      // encrypted tunnel, in both directions.
      gate = createTrustGate({
        peerKeyB64: host.peerPublicKeyB64() ?? '',
        sessionId: 'watch-test',
        sas: () => host.sas(),
        sendConfirm: (json) => { host.sendTunnelText(json) },
        onOpen: () => { gateOpened = true },
        autoApprove: opts.autoApprove
      })
    },
    onRpc: () => {}, onFrame: () => {},
    onClose: () => { closed++ },
    onTunnel: (kind, payload) => {
      if (kind !== 'text') return
      const json = new TextDecoder().decode(payload)
      tunnel.push(json)
      gate?.onTunnelText(json)
    }
  })
  return {
    keys, host, hostT, peerT, tunnel,
    isReady: () => ready,
    hostClosed: () => closed,
    gateOpen: () => gateOpened,
    /** The host's human (or its pin) confirms, through the real gate. */
    confirm: () => {
      if (!gate) throw new Error('the host is not ready, so it has no gate yet')
      gate.confirmHere()
    }
  }
}

/** The client's socket with a count of the binary (sealed) frames it sent. */
function counting(socket: WatchSocket) {
  const sent = { text: 0, binary: 0 }
  const wrapped: WatchSocket = {
    ...socket,
    send: (d) => { if (typeof d === 'string') sent.text++; else sent.binary++; socket.send(d) }
  }
  return { socket: wrapped, sent }
}

function events() {
  const log = { open: 0, events: [] as [string, unknown[]][], pty: [] as [string, string][], denied: [] as string[], closed: 0 }
  return {
    log,
    ev: {
      onOpen: () => { log.open++ },
      onEvent: (c: string, a: unknown[]) => { log.events.push([c, a]) },
      onPtyData: (s: string, d: string) => { log.pty.push([s, d]) },
      onDenied: (r: string) => { log.denied.push(r) },
      onClose: () => { log.closed++ }
    }
  }
}

describe('connectWatchClient against the real relay socket', () => {
  it('completes the handshake, confirms trust, and opens once the host confirms', async () => {
    const h = hostWith()
    const { log, ev } = events()
    const c = connectWatchClient({ socket: h.peerT, keys: h.keys, events: ev })
    await vi.waitFor(() => expect(h.isReady()).toBe(true))
    await vi.waitFor(() => expect(h.tunnel).toContain(TRUST_CONFIRM_JSON))
    expect(h.host.peerPublicKeyB64()).toBe(publicKeyToB64(h.keys.viewer.publicKey))
    expect(c.isOpen()).toBe(false)
    h.confirm()
    expect(log.open).toBe(1)
    expect(c.isOpen()).toBe(true)
    // The client's confirm is one the host's real gate accepts: both halves in, the gate opens.
    await vi.waitFor(() => expect(h.gateOpen()).toBe(true))
  })

  it('delivers ev frames and pty data only after it is open', async () => {
    const h = hostWith()
    const { log, ev } = events()
    connectWatchClient({ socket: h.peerT, keys: h.keys, events: ev })
    await vi.waitFor(() => expect(h.tunnel).toContain(TRUST_CONFIRM_JSON))
    h.host.sendTunnelText(JSON.stringify({ t: 'ev', channel: 'watch:meta', args: [{ v: 1 }] }))
    h.host.sendTunnelBinary(encodePtyData('s1', 'early'))
    expect(log.events).toEqual([])
    expect(log.pty).toEqual([])
    h.confirm()
    h.host.sendTunnelText(JSON.stringify({ t: 'ev', channel: 'watch:meta', args: [{ v: 1 }] }))
    h.host.sendTunnelBinary(encodePtyData('s1', 'late'))
    expect(log.events).toEqual([['watch:meta', [{ v: 1 }]]])
    expect(log.pty).toEqual([['s1', 'late']])
  })

  it('reports a denial and never opens', async () => {
    const h = hostWith()
    const { log, ev } = events()
    connectWatchClient({ socket: h.peerT, keys: h.keys, events: ev })
    await vi.waitFor(() => expect(h.tunnel).toContain(TRUST_CONFIRM_JSON))
    h.host.sendTunnelText(deniedFrame('removed'))
    expect(log.denied).toEqual(['removed'])
    expect(log.open).toBe(0)
  })

  it('cannot talk to a host whose key is not the link one', async () => {
    const real = deriveWatchLinkKeys(nacl.randomBytes(32))
    const impostor = hostWith({ keys: deriveWatchLinkKeys(nacl.randomBytes(32)) })
    const { socket, sent } = counting(impostor.peerT)
    const c = connectWatchClient({ socket, keys: real, events: events().ev })
    // The first sealed frame is the e2ee_auth box; the host has already judged it when send returns.
    await vi.waitFor(() => expect(sent.binary).toBe(1))
    expect(impostor.isReady()).toBe(false)
    expect(c.isOpen()).toBe(false)
  })

  it('sends a chat cast only while open', async () => {
    const h = hostWith()
    const c = connectWatchClient({ socket: h.peerT, keys: h.keys, events: events().ev })
    expect(c.sendChat('Ada', 'hi')).toBe(false)
    await vi.waitFor(() => expect(h.tunnel).toContain(TRUST_CONFIRM_JSON))
    h.confirm()
    expect(c.sendChat('Ada', 'hi')).toBe(true)
    expect(h.tunnel.at(-1)).toBe(JSON.stringify({ t: 'cast', method: 'watch:chat', args: [{ name: 'Ada', text: 'hi' }] }))
  })

  it('keeps both directions flowing past seq 255', async () => {
    // A strictly increasing counter stays increasing under most encodings, so a short exchange
    // cannot tell the relay's little-endian seq from a byte-swapped copy. Past one byte it can:
    // a swapped 256 decodes below a swapped 255 and the receiver drops it as a replay.
    const h = hostWith()
    const { log, ev } = events()
    const c = connectWatchClient({ socket: h.peerT, keys: h.keys, events: ev })
    await vi.waitFor(() => expect(h.tunnel).toContain(TRUST_CONFIRM_JSON))
    h.confirm()
    for (let i = 0; i < 300; i++) h.host.sendTunnelBinary(encodePtyData('s1', String(i)))
    expect(log.pty).toHaveLength(300)
    expect(log.pty.at(-1)).toEqual(['s1', '299'])
    for (let i = 0; i < 300; i++) expect(c.sendChat('Ada', String(i))).toBe(true)
    expect(h.tunnel.at(-1)).toBe(JSON.stringify({ t: 'cast', method: 'watch:chat', args: [{ name: 'Ada', text: '299' }] }))
    expect(h.tunnel.filter((m) => m.includes('watch:chat'))).toHaveLength(300)
  })

  it('keeps the sealed stream in order across keepalives, and stops them when the socket closes', async () => {
    const h = hostWith()
    const { log, ev } = events()
    const timer: { tick?: () => void; ms?: number } = {}
    const stopped: unknown[] = []
    const { socket, sent } = counting(h.peerT)
    const c = connectWatchClient({
      socket, keys: h.keys, events: ev,
      setInterval: (fn, ms) => { timer.tick = fn; timer.ms = ms; return 'handle' },
      clearInterval: (handle) => { stopped.push(handle) }
    })
    await vi.waitFor(() => expect(h.tunnel).toContain(TRUST_CONFIRM_JSON))
    h.confirm()
    expect(timer.ms).toBe(25_000)
    // A keepalive is a real sealed frame and spends a seq number; the host must still accept what
    // follows it.
    const before = sent.binary
    timer.tick?.()
    timer.tick?.()
    expect(sent.binary - before).toBe(2)
    expect(c.sendChat('Ada', 'after keepalives')).toBe(true)
    expect(h.tunnel.at(-1)).toBe(JSON.stringify({ t: 'cast', method: 'watch:chat', args: [{ name: 'Ada', text: 'after keepalives' }] }))
    // The far side hangs up: the client reports it once, stops its keepalive, and stops sending.
    h.hostT.close()
    expect(log.closed).toBe(1)
    expect(stopped).toEqual(['handle'])
    expect(c.isOpen()).toBe(false)
    expect(c.sendChat('Ada', 'too late')).toBe(false)
  })

  it('does not report a close the caller asked for, and still stops its keepalive', async () => {
    const h = hostWith()
    const { log, ev } = events()
    const stopped: unknown[] = []
    const c = connectWatchClient({
      socket: h.peerT, keys: h.keys, events: ev,
      setInterval: () => 'handle',
      clearInterval: (handle) => { stopped.push(handle) }
    })
    await vi.waitFor(() => expect(h.tunnel).toContain(TRUST_CONFIRM_JSON))
    h.confirm()
    c.close()
    expect(h.hostClosed()).toBe(1)
    expect(log.closed).toBe(0)
    expect(stopped).toEqual(['handle'])
    expect(c.isOpen()).toBe(false)
  })

  it('closes, and says so once, when the session key cannot be derived', async () => {
    // WebCrypto refusing (a page served without a secure context has no crypto.subtle at all) used
    // to be an unhandled rejection that left the client in 'deriving' forever, with no event.
    const spy = vi.spyOn(globalThis.crypto.subtle, 'importKey').mockRejectedValueOnce(new Error('no HKDF here'))
    try {
      const h = hostWith()
      const { log, ev } = events()
      const c = connectWatchClient({ socket: h.peerT, keys: h.keys, events: ev })
      await vi.waitFor(() => expect(log.closed).toBe(1))
      expect(h.hostClosed()).toBe(1)
      expect(h.isReady()).toBe(false)
      expect(c.isOpen()).toBe(false)
      await new Promise((r) => setTimeout(r, 0))
      expect(log.closed).toBe(1)
    } finally {
      spy.mockRestore()
    }
  })

  it('opens only after its own confirm went out, even when the host confirms inside onReady', async () => {
    // A pinned host confirms synchronously the moment it is ready, before the client's own confirm
    // (deferred past the host's send) has left. Opening then would open a session whose host gate
    // has not seen the viewer's half.
    const h = hostWith({ autoApprove: true })
    let confirmOutAtOpen: boolean | null = null
    const { ev } = events()
    connectWatchClient({
      socket: h.peerT, keys: h.keys,
      events: { ...ev, onOpen: () => { confirmOutAtOpen = h.tunnel.includes(TRUST_CONFIRM_JSON) } }
    })
    await vi.waitFor(() => expect(confirmOutAtOpen).not.toBeNull())
    expect(confirmOutAtOpen).toBe(true)
    await vi.waitFor(() => expect(h.gateOpen()).toBe(true))
  })

  it('warns once, and drops, a socket message that is neither text nor bytes', async () => {
    // A browser WebSocket left at its default binaryType delivers Blobs; the adapter owes bytes.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const h = hostWith()
      const { log, ev } = events()
      const c = connectWatchClient({ socket: h.peerT, keys: h.keys, events: ev })
      await vi.waitFor(() => expect(h.tunnel).toContain(TRUST_CONFIRM_JSON))
      h.confirm()
      const deliver = h.hostT.send as (d: unknown) => void
      deliver(new Blob(['x']))
      deliver({ not: 'bytes' })
      expect(warn).toHaveBeenCalledTimes(1)
      expect(String(warn.mock.calls[0][0])).toContain('arraybuffer')
      expect(c.isOpen()).toBe(true)
      expect(log.closed).toBe(0)
    } finally {
      warn.mockRestore()
    }
  })
})
