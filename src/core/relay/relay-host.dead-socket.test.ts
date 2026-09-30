// src/core/relay/relay-host.dead-socket.test.ts
//
// The relay host's base sink THROWS when its socket cannot take a send while the session still
// counts as open, and that throw is what makes the sink registry evict a dead peer (two strikes, then
// the shell's full teardown). The `if (closed) return` in front of it (a session this host already
// closed is not a dead socket) must not swallow that case. A relay socket that stops accepting sends
// WITHOUT firing its onClose is the one way to reach it, so this file wraps the real socket factory
// and lets a test cut the host's sends off while leaving everything else real.
import { describe, it, expect, vi } from 'vitest'
import { connectRelayHost, type PeerAttach } from './relay-host'
import { connectRelayClient } from './relay-client'
import { transportPair } from './transport-pair'
import { genKeyPair, publicKeyToB64 } from './e2ee'
import { UiSinkRegistry } from '../ui-sink-registry'
import { IPC } from '../../shared/ipc'

const cut = vi.hoisted(() => ({ host: false }))
vi.mock('./relay-socket', async (importOriginal) => {
  const real = await importOriginal<typeof import('./relay-socket')>()
  return {
    ...real,
    connectRelay: (opts: Parameters<typeof real.connectRelay>[0]) => {
      const socket = real.connectRelay(opts)
      if (opts.role !== 'host') return socket
      // The host's socket, severed on demand: sends report "not delivered", and nothing tells the
      // session (no onClose), exactly the state a channel that died silently leaves it in.
      return {
        ...socket,
        sendTunnelText: (json: string) => (cut.host ? false : socket.sendTunnelText(json)),
        sendTunnelBinary: (bytes: Uint8Array) => (cut.host ? false : socket.sendTunnelBinary(bytes))
      }
    }
  }
})

function openPeer() {
  const registry = new UiSinkRegistry()
  const gone: number[] = []
  registry.setSinkGoneHandler((id) => {
    gone.push(id)
    registry.unregister(id)
  })
  let next = 1
  let opened: number | null = null
  const attach: PeerAttach = {
    attach: (sink) => {
      const id = next++
      registry.register(id, sink)
      opened = id
      return id
    },
    detach: (id) => registry.unregister(id),
    dispatch: async (_id, req) => ({ t: 'res', id: req.id, ok: true, result: null }),
    cast: () => {}
  }
  const hostKeys = genKeyPair()
  const { hostT, peerT } = transportPair()
  let hostClosed = 0
  connectRelayHost({
    url: 'ws://127.0.0.1/x', token: 't', ourKeys: hostKeys, attach, transport: hostT,
    autoApprove: () => true, onPeerPending: () => {}, onOpen: () => {}, onClose: () => { hostClosed++ }
  })
  connectRelayClient({
    url: 'ws://127.0.0.1/x', token: 't', hostKeyB64: publicKeyToB64(hostKeys.publicKey), ourKeys: genKeyPair(),
    transport: peerT, autoApprove: true, onSas: () => {}, onApproved: () => {},
    onFrame: () => {}, onPtyData: () => {}, onClose: () => {}
  })
  return { registry, gone, id: () => opened, hostClosed: () => hostClosed }
}

describe('core relay host — a socket that dies while the session is open is evicted (D5)', () => {
  it('two sends to a silently dead socket throw, and the registry evicts the sink', async () => {
    cut.host = false
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const p = openPeer()
      await vi.waitFor(() => expect(p.id()).not.toBeNull())
      const id = p.id()!
      p.registry.sendTo(id, IPC.presencePeer, { op: 'noop' }) // healthy: delivered, no strike
      expect(warn).not.toHaveBeenCalled()
      cut.host = true // the channel dies; the session is never told
      expect(p.hostClosed()).toBe(0)
      p.registry.sendTo(id, IPC.presencePeer, { op: 'one' })
      expect(p.gone).toEqual([]) // one strike is not enough
      p.registry.sendTo(id, IPC.presencePeer, { op: 'two' })
      expect(p.gone).toEqual([id])
      expect(warn.mock.calls.map((c) => String(c[1]))).toEqual(['relay socket is not connected', 'relay socket is not connected'])
    } finally {
      warn.mockRestore()
      cut.host = false
    }
  })

  it('terminal bytes take the same path: two failed binary sends evict the sink', async () => {
    cut.host = false
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const p = openPeer()
      await vi.waitFor(() => expect(p.id()).not.toBeNull())
      const id = p.id()!
      cut.host = true
      p.registry.sendTo(id, IPC.ptyData('s1'), 'a')
      p.registry.sendTo(id, IPC.ptyData('s1'), 'b')
      expect(p.gone).toEqual([id])
    } finally {
      warn.mockRestore()
      cut.host = false
    }
  })
})
