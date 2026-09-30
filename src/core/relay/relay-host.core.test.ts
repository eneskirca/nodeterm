// src/core/relay/relay-host.core.test.ts
import { describe, it, expect, vi } from 'vitest'
import { connectRelayHost, killRelayHostsByPeerKey, HELD_FRAMES_MAX, type PeerAttach, type RelayHostSession } from './relay-host'
import { connectRelayClient } from './relay-client'
import { transportPair } from './transport-pair'
import { genKeyPair, publicKeyToB64 } from './e2ee'
import { connectRelay } from './relay-socket'
import { createTrustGate, deniedFrame, type TrustGate } from './relay-trust'
import type { RpcRequest } from '../../shared/rpc'
import type { UiSink } from '../ui-sink-registry'

function fakeAttach() {
  const dispatched: RpcRequest[] = []
  const casts: Array<{ method: string; args: unknown[] }> = []
  const sinks = new Map<number, { sendText(j: string): void }>()
  let next = 1
  const attach: PeerAttach = {
    attach: (sink) => { const id = next++; sinks.set(id, sink); return id },
    detach: (id) => { sinks.delete(id) },
    dispatch: async (_id, req) => { dispatched.push(req); return { t: 'res', id: req.id, ok: true, result: 'ok' } },
    cast: (_id, method, args) => { casts.push({ method, args }) }
  }
  return { attach, dispatched, casts, sinks }
}

function open(opts: Partial<Parameters<typeof connectRelayHost>[0]> = {}, clientAuto = false) {
  const hostKeys = genKeyPair()
  const peerKeys = genKeyPair()
  const { hostT, peerT } = transportPair()
  const fa = fakeAttach()
  const frames: string[] = []
  let hostSession!: RelayHostSession
  const opened: string[] = []
  hostSession = connectRelayHost({
    url: 'ws://127.0.0.1/x', token: 't', ourKeys: hostKeys, attach: fa.attach, transport: hostT,
    onPeerPending: () => {}, onOpen: () => opened.push('host'), onClose: () => {}, ...opts
  })
  const client = connectRelayClient({
    url: 'ws://127.0.0.1/x', token: 't', hostKeyB64: publicKeyToB64(hostKeys.publicKey), ourKeys: peerKeys,
    transport: peerT, autoApprove: clientAuto, onSas: () => {}, onApproved: () => opened.push('peer'),
    onFrame: (j) => frames.push(j), onPtyData: () => {}, onClose: () => {}
  })
  return { hostSession, client, fa, frames, opened, peerKeyB64: publicKeyToB64(peerKeys.publicKey) }
}

describe('core relay host', () => {
  it('pinned peer + auto-approving client open with no human', async () => {
    const t = open({ autoApprove: () => true }, true)
    await vi.waitFor(() => expect(t.opened.sort()).toEqual(['host', 'peer']))
    expect(t.fa.sinks.size).toBe(1)
  })

  it('autoApprove is asked with the handshake peer key', async () => {
    const seen: string[] = []
    const t = open({ autoApprove: (k) => { seen.push(k); return false } })
    await vi.waitFor(() => expect(seen).toEqual([t.peerKeyB64]))
    expect(t.opened).toEqual([])
  })

  it('interceptReq answers before dispatch and never reaches the platform', async () => {
    const t = open({
      autoApprove: () => true,
      hooks: { interceptReq: (_s, m) => (m === 'relay:hosted:self' ? Promise.resolve({ role: 'viewer' }) : null) }
    }, true)
    await vi.waitFor(() => expect(t.opened.length).toBe(2))
    t.client.send(JSON.stringify({ t: 'req', id: 7, method: 'relay:hosted:self', args: [] }))
    await vi.waitFor(() => expect(t.frames.some((f) => f.includes('"id":7') && f.includes('viewer'))).toBe(true))
    expect(t.fa.dispatched).toEqual([])
  })

  it('access refusal answers E_ROLE and does not dispatch; allow may rewrite args', async () => {
    const t = open({
      autoApprove: () => true,
      hooks: {
        access: (_s, _k, method, args) =>
          method === 'fs:write' ? { allow: false, message: 'Viewers cannot edit files.' }
            : method === 'pty:resize' ? { allow: true, args: [args[0], null, null] } : { allow: true }
      }
    }, true)
    await vi.waitFor(() => expect(t.opened.length).toBe(2))
    t.client.send(JSON.stringify({ t: 'req', id: 1, method: 'fs:write', args: ['/x', 'y'] }))
    t.client.send(JSON.stringify({ t: 'cast', method: 'pty:resize', args: ['s1', 200, 50] }))
    await vi.waitFor(() => expect(t.frames.some((f) => f.includes('E_ROLE'))).toBe(true))
    expect(t.fa.dispatched).toEqual([])
    expect(t.fa.casts).toEqual([{ method: 'pty:resize', args: ['s1', null, null] }])
  })

  it('deny() tells the client why before closing', async () => {
    const denied: string[] = []
    const hostKeys = genKeyPair()
    const { hostT, peerT } = transportPair()
    const s = connectRelayHost({
      url: 'ws://127.0.0.1/x', token: 't', ourKeys: hostKeys, attach: fakeAttach().attach, transport: hostT,
      onPeerPending: (sess) => sess.deny('denied'), onOpen: () => {}, onClose: () => {}
    })
    connectRelayClient({
      url: 'ws://127.0.0.1/x', token: 't', hostKeyB64: publicKeyToB64(hostKeys.publicKey), ourKeys: genKeyPair(),
      transport: peerT, onSas: () => {}, onApproved: () => {}, onFrame: () => {}, onPtyData: () => {},
      onClose: () => {}, onDenied: (r) => denied.push(r)
    })
    await vi.waitFor(() => expect(denied).toEqual(['denied']))
    expect(s.clientId()).toBeNull()
  })
})

// Ruling R9: an auto-approving gate must never send its confirm before the socket (and the gate) can
// carry it. Over an in-process transport the whole handshake runs synchronously inside the CLIENT's
// connectRelay call, so both of these fail when the confirm is sent at gate construction.
describe('core relay — auto-approve confirms are deferred until they can be delivered', () => {
  it('an auto-approving CLIENT still delivers its confirm to a host whose human confirms', async () => {
    const hostKeys = genKeyPair()
    const { hostT, peerT } = transportPair()
    const opened: string[] = []
    let sasShown = 0
    const host = connectRelayHost({
      url: 'ws://127.0.0.1/x', token: 't', ourKeys: hostKeys, attach: fakeAttach().attach, transport: hostT,
      onPeerPending: () => {}, onOpen: () => opened.push('host'), onClose: () => {}
    })
    connectRelayClient({
      url: 'ws://127.0.0.1/x', token: 't', hostKeyB64: publicKeyToB64(hostKeys.publicKey), ourKeys: genKeyPair(),
      transport: peerT, autoApprove: true, onSas: () => sasShown++, onApproved: () => opened.push('peer'),
      onFrame: () => {}, onPtyData: () => {}, onClose: () => {}
    })
    host.confirm() // the host's human
    await vi.waitFor(() => expect(opened.sort()).toEqual(['host', 'peer']))
    expect(sasShown).toBe(0) // a pinned host raises no SAS dialog
  })

  it('an auto-approving HOST confirms after the current turn, so a peer that builds its gate after its socket hears it', async () => {
    const hostKeys = genKeyPair()
    const { hostT, peerT } = transportPair()
    const opened: string[] = []
    let pending = 0
    connectRelayHost({
      url: 'ws://127.0.0.1/x', token: 't', ourKeys: hostKeys, attach: fakeAttach().attach, transport: hostT,
      autoApprove: () => true, onPeerPending: () => pending++, onOpen: () => opened.push('host'), onClose: () => {}
    })
    // The shape the desktop tests use: the peer's gate exists only once connectRelay has returned.
    let peerGate: TrustGate | null = null
    const peerSocket = connectRelay({
      url: 'ws://127.0.0.1/x', token: 't', role: 'client', ourKeys: genKeyPair(),
      theirPubB64: publicKeyToB64(hostKeys.publicKey), transport: peerT,
      onReady: () => {}, onRpc: () => {}, onFrame: () => {}, onClose: () => {},
      onTunnel: (kind, payload) => {
        if (kind === 'text') peerGate?.onTunnelText(new TextDecoder().decode(payload))
      }
    })
    peerGate = createTrustGate({
      peerKeyB64: peerSocket.peerPublicKeyB64()!, sessionId: 'peer', sas: () => peerSocket.sas(),
      sendConfirm: (j) => peerSocket.sendTunnelText(j), onOpen: () => opened.push('peer')
    })
    peerGate.confirmHere() // the peer's human
    await vi.waitFor(() => expect(opened.sort()).toEqual(['host', 'peer']))
    expect(pending).toBe(0) // an auto-approved peer never raises the approve dialog
  })
})

describe('core relay host — hooks and refusals', () => {
  it('the attached sink reports the relay socket’s REAL buffered bytes (obligation 2)', async () => {
    const hostKeys = genKeyPair()
    const buffered = { n: 0 }
    const { hostT, peerT } = transportPair({ hostBuffered: () => buffered.n })
    const sinks: Array<{ bufferedAmount?(): number }> = []
    const opened: string[] = []
    connectRelayHost({
      url: 'ws://127.0.0.1/x', token: 't', ourKeys: hostKeys, transport: hostT,
      attach: { ...fakeAttach().attach, attach: (sink) => { sinks.push(sink); return 1 } },
      autoApprove: () => true, onPeerPending: () => {}, onOpen: () => opened.push('host'), onClose: () => {}
    })
    connectRelayClient({
      url: 'ws://127.0.0.1/x', token: 't', hostKeyB64: publicKeyToB64(hostKeys.publicKey), ourKeys: genKeyPair(),
      transport: peerT, autoApprove: true, onSas: () => {}, onApproved: () => {}, onFrame: () => {},
      onPtyData: () => {}, onClose: () => {}
    })
    await vi.waitFor(() => expect(opened).toEqual(['host']))
    buffered.n = 9_000_000
    expect(sinks[0].bufferedAmount?.()).toBe(9_000_000)
  })

  it('wrapSink decides what is attached, and still sees the honest base sink', async () => {
    const hostKeys = genKeyPair()
    const buffered = { n: 42 }
    const { hostT, peerT } = transportPair({ hostBuffered: () => buffered.n })
    const fa = fakeAttach()
    const wrapped: string[] = []
    const frames: string[] = []
    const opened: string[] = []
    let baseBuffered = -1
    connectRelayHost({
      url: 'ws://127.0.0.1/x', token: 't', ourKeys: hostKeys, attach: fa.attach, transport: hostT,
      autoApprove: () => true,
      hooks: {
        wrapSink: (_s, base) => {
          baseBuffered = base.bufferedAmount?.() ?? -1
          return { ...base, sendText: (j) => { wrapped.push(j); base.sendText(j) } }
        }
      },
      onPeerPending: () => {}, onOpen: () => opened.push('host'), onClose: () => {}
    })
    connectRelayClient({
      url: 'ws://127.0.0.1/x', token: 't', hostKeyB64: publicKeyToB64(hostKeys.publicKey), ourKeys: genKeyPair(),
      transport: peerT, autoApprove: true, onSas: () => {}, onApproved: () => {}, onFrame: (j) => frames.push(j),
      onPtyData: () => {}, onClose: () => {}
    })
    await vi.waitFor(() => expect(opened).toEqual(['host']))
    expect(baseBuffered).toBe(42)
    const ev = JSON.stringify({ t: 'ev', channel: 'x', args: [] })
    fa.sinks.get(1)!.sendText(ev)
    expect(wrapped).toEqual([ev])
    await vi.waitFor(() => expect(frames).toContain(ev))
  })

  it('narrowResponse rewrites a successful result and never touches an error', async () => {
    const narrowed: string[] = []
    const fa = fakeAttach()
    const t = open({
      autoApprove: () => true,
      attach: {
        ...fa.attach,
        dispatch: async (_id, req) => req.method === 'bad'
          ? { t: 'res', id: req.id, ok: false, error: { code: 'E_HANDLER', message: 'no' } }
          : { t: 'res', id: req.id, ok: true, result: 'full' }
      },
      hooks: { narrowResponse: (_s, method, result) => { narrowed.push(method); return `${String(result)}-narrowed` } }
    }, true)
    await vi.waitFor(() => expect(t.opened.length).toBe(2))
    t.client.send(JSON.stringify({ t: 'req', id: 1, method: 'good', args: [] }))
    t.client.send(JSON.stringify({ t: 'req', id: 2, method: 'bad', args: [] }))
    await vi.waitFor(() => expect(t.frames.length).toBe(2))
    const res = t.frames.map((f) => JSON.parse(f))
    expect(res.find((r) => r.id === 1)).toMatchObject({ ok: true, result: 'full-narrowed' })
    expect(res.find((r) => r.id === 2)).toMatchObject({ ok: false, error: { code: 'E_HANDLER' } })
    expect(narrowed).toEqual(['good'])
  })

  it('a denial frame a PEER sends is consumed, never forwarded to the core', async () => {
    const t = open({ autoApprove: () => true }, true)
    await vi.waitFor(() => expect(t.opened.length).toBe(2))
    t.client.send(deniedFrame('removed'))
    // Positive control, sent AFTER: once it has arrived, the denial had its turn.
    t.client.send(JSON.stringify({ t: 'cast', method: 'pty:write', args: ['s1', 'x'] }))
    await vi.waitFor(() => expect(t.fa.casts.length).toBe(1))
    expect(t.fa.casts).toEqual([{ method: 'pty:write', args: ['s1', 'x'] }])
  })

  it('killRelayHostsByPeerKey with a reason tells the peer why; without one it only closes', async () => {
    const hostKeys = genKeyPair()
    const peerKeys = genKeyPair()
    const fa = fakeAttach()
    const events: string[] = []
    const run = (): RelayHostSession => {
      const { hostT, peerT } = transportPair()
      const host = connectRelayHost({
        url: 'ws://127.0.0.1/x', token: 't', ourKeys: hostKeys, attach: fa.attach, transport: hostT,
        autoApprove: () => true, onPeerPending: () => {}, onOpen: () => events.push('open'), onClose: () => {}
      })
      connectRelayClient({
        url: 'ws://127.0.0.1/x', token: 't', hostKeyB64: publicKeyToB64(hostKeys.publicKey), ourKeys: peerKeys,
        transport: peerT, autoApprove: true, onSas: () => {}, onApproved: () => {}, onFrame: () => {},
        onPtyData: () => {}, onClose: () => events.push('close'), onDenied: (r) => events.push(`denied:${r}`)
      })
      return host
    }
    const peerKeyB64 = publicKeyToB64(peerKeys.publicKey)

    const first = run()
    await vi.waitFor(() => expect(events).toEqual(['open']))
    killRelayHostsByPeerKey(peerKeyB64, 'removed')
    expect(events).toEqual(['open', 'denied:removed', 'close']) // the reason lands BEFORE the close
    expect(first.clientId()).toBeNull()
    expect(fa.sinks.size).toBe(0)

    events.length = 0
    const second = run()
    await vi.waitFor(() => expect(events).toEqual(['open']))
    killRelayHostsByPeerKey(peerKeyB64)
    expect(events).toEqual(['open', 'close'])
    expect(second.clientId()).toBeNull()
  })

  it('a denial sent during the in-process handshake still reaches the client before its close', async () => {
    const hostKeys = genKeyPair()
    const { hostT, peerT } = transportPair()
    const events: string[] = []
    connectRelayHost({
      url: 'ws://127.0.0.1/x', token: 't', ourKeys: hostKeys, attach: fakeAttach().attach, transport: hostT,
      onPeerPending: (sess) => sess.deny('expired'), onOpen: () => {}, onClose: () => {}
    })
    connectRelayClient({
      url: 'ws://127.0.0.1/x', token: 't', hostKeyB64: publicKeyToB64(hostKeys.publicKey), ourKeys: genKeyPair(),
      transport: peerT, onSas: () => {}, onApproved: () => {}, onFrame: () => {}, onPtyData: () => {},
      onClose: () => events.push('close'), onDenied: (r) => events.push(`denied:${r}`)
    })
    expect(events).toEqual(['denied:expired', 'close'])
  })
})

// Ruling R11: a hook (or the shell's dispatch) that throws must never escape into the socket's
// message handler — over a real ws that emit is synchronous, so the throw kills the stream: no later
// frame, no `close`, no teardown, the request never answered. Every guard below answers or drops
// instead, and the session keeps serving.
describe('core relay host — a throwing hook or dispatch never wedges the session', () => {
  const errorOf = (frames: string[], id: number) =>
    frames.map((f) => JSON.parse(f)).find((m) => m.t === 'res' && m.id === id)

  it('a throwing access hook answers E_HANDLER, and a later frame on the same session still dispatches', async () => {
    const t = open({
      autoApprove: () => true,
      hooks: {
        access: (_s, _k, method) => {
          if (method === 'boom') throw new Error('access exploded')
          return { allow: true }
        }
      }
    }, true)
    await vi.waitFor(() => expect(t.opened.length).toBe(2))
    t.client.send(JSON.stringify({ t: 'req', id: 1, method: 'boom', args: [] }))
    await vi.waitFor(() => expect(errorOf(t.frames, 1)).toMatchObject({
      ok: false, error: { code: 'E_HANDLER', message: 'access exploded' }
    }))
    t.client.send(JSON.stringify({ t: 'req', id: 2, method: 'fine', args: [] }))
    await vi.waitFor(() => expect(errorOf(t.frames, 2)).toMatchObject({ ok: true, result: 'ok' }))
    expect(t.fa.dispatched.map((r) => r.method)).toEqual(['fine'])
  })

  it('a throwing access hook on a cast drops that cast, and a later cast still arrives', async () => {
    const t = open({
      autoApprove: () => true,
      hooks: {
        access: (_s, kind, method) => {
          if (kind === 'cast' && method === 'boom') throw new Error('nope')
          return { allow: true }
        }
      }
    }, true)
    await vi.waitFor(() => expect(t.opened.length).toBe(2))
    t.client.send(JSON.stringify({ t: 'cast', method: 'boom', args: [] }))
    t.client.send(JSON.stringify({ t: 'cast', method: 'pty:write', args: ['s1', 'x'] }))
    await vi.waitFor(() => expect(t.fa.casts.length).toBe(1))
    expect(t.fa.casts).toEqual([{ method: 'pty:write', args: ['s1', 'x'] }])
  })

  it('a throwing interceptReq answers E_HANDLER and never dispatches', async () => {
    const t = open({
      autoApprove: () => true,
      hooks: {
        interceptReq: (_s, m) => {
          if (m === 'relay:hosted:self') throw new Error('intercept exploded')
          return null
        }
      }
    }, true)
    await vi.waitFor(() => expect(t.opened.length).toBe(2))
    t.client.send(JSON.stringify({ t: 'req', id: 3, method: 'relay:hosted:self', args: [] }))
    await vi.waitFor(() => expect(errorOf(t.frames, 3)).toMatchObject({
      ok: false, error: { code: 'E_HANDLER', message: 'intercept exploded' }
    }))
    expect(t.fa.dispatched).toEqual([])
  })

  it('a rejecting attach.dispatch answers E_HANDLER', async () => {
    const fa = fakeAttach()
    const t = open({
      autoApprove: () => true,
      attach: { ...fa.attach, dispatch: async () => { throw new Error('dispatch exploded') } }
    }, true)
    await vi.waitFor(() => expect(t.opened.length).toBe(2))
    t.client.send(JSON.stringify({ t: 'req', id: 4, method: 'fs:list', args: [] }))
    await vi.waitFor(() => expect(errorOf(t.frames, 4)).toMatchObject({
      ok: false, error: { code: 'E_HANDLER', message: 'dispatch exploded' }
    }))
  })

  it('a dispatch that throws synchronously answers E_HANDLER', async () => {
    const fa = fakeAttach()
    const t = open({
      autoApprove: () => true,
      attach: { ...fa.attach, dispatch: () => { throw new Error('sync dispatch') } }
    }, true)
    await vi.waitFor(() => expect(t.opened.length).toBe(2))
    t.client.send(JSON.stringify({ t: 'req', id: 5, method: 'fs:list', args: [] }))
    await vi.waitFor(() => expect(errorOf(t.frames, 5)).toMatchObject({
      ok: false, error: { code: 'E_HANDLER', message: 'sync dispatch' }
    }))
  })

  it('a throwing narrowResponse answers E_HANDLER, never the unnarrowed result', async () => {
    const t = open({
      autoApprove: () => true,
      hooks: { narrowResponse: () => { throw new Error('narrow exploded') } }
    }, true)
    await vi.waitFor(() => expect(t.opened.length).toBe(2))
    t.client.send(JSON.stringify({ t: 'req', id: 6, method: 'fs:list', args: [] }))
    await vi.waitFor(() => expect(errorOf(t.frames, 6)).toMatchObject({
      ok: false, error: { code: 'E_HANDLER', message: 'narrow exploded' }
    }))
    expect(t.frames.some((f) => f.includes('"result":"ok"'))).toBe(false)
  })

  it('a throwing autoApprove reads as false: the human is asked instead', async () => {
    let pending = 0
    const t = open({
      autoApprove: () => { throw new Error('pin store exploded') },
      onPeerPending: () => pending++
    }, true)
    expect(pending).toBe(1)
    t.hostSession.confirm() // the human
    await vi.waitFor(() => expect(t.opened.sort()).toEqual(['host', 'peer']))
  })

  it('a throwing wrapSink FAILS CLOSED: nothing is attached, the session closes, the shell hears it', async () => {
    let hostClosed = 0
    let clientClosed = 0
    const hostKeys = genKeyPair()
    const { hostT, peerT } = transportPair()
    const fa = fakeAttach()
    const s = connectRelayHost({
      url: 'ws://127.0.0.1/x', token: 't', ourKeys: hostKeys, attach: fa.attach, transport: hostT,
      autoApprove: () => true,
      hooks: { wrapSink: () => { throw new Error('filter exploded') } },
      onPeerPending: () => {}, onOpen: () => { throw new Error('must not open') }, onClose: () => hostClosed++
    })
    connectRelayClient({
      url: 'ws://127.0.0.1/x', token: 't', hostKeyB64: publicKeyToB64(hostKeys.publicKey), ourKeys: genKeyPair(),
      transport: peerT, autoApprove: true, onSas: () => {}, onApproved: () => {}, onFrame: () => {},
      onPtyData: () => {}, onClose: () => clientClosed++
    })
    await vi.waitFor(() => expect(hostClosed).toBe(1))
    expect(clientClosed).toBe(1)
    expect(fa.sinks.size).toBe(0) // an unfiltered sink was never handed to the core
    expect(s.clientId()).toBeNull()
  })
})

describe('core relay host — review round 2 (cast logging, R12 malformed decisions, R13 late open)', () => {
  it('a throwing access hook on a cast is LOGGED, never swallowed silently', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const t = open({
        autoApprove: () => true,
        hooks: { access: (_s, kind) => { if (kind === 'cast') throw new Error('nope'); return { allow: true } } }
      }, true)
      await vi.waitFor(() => expect(t.opened.length).toBe(2))
      t.client.send(JSON.stringify({ t: 'cast', method: 'pty:write', args: ['s1', 'x'] }))
      await vi.waitFor(() => expect(warn).toHaveBeenCalledWith('[relay-host] access threw on cast pty:write:', 'nope'))
      expect(t.fa.casts).toEqual([])
    } finally {
      warn.mockRestore()
    }
  })

  it('R12: a malformed access decision DENIES — E_ROLE for a req, dropped for a cast; only an absent hook allows all', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const returns: Record<string, unknown> = {
        undef: undefined, nul: null, empty: {}, badArgs: { allow: true, args: 'x' }, noMsg: { allow: false }
      }
      const t = open({
        autoApprove: () => true,
        hooks: {
          access: (_s, _k, method) =>
            (method in returns ? returns[method] : { allow: true }) as ReturnType<NonNullable<import('./relay-host').RelayHostHooks['access']>>
        }
      }, true)
      await vi.waitFor(() => expect(t.opened.length).toBe(2))
      const names = Object.keys(returns)
      names.forEach((m, i) => t.client.send(JSON.stringify({ t: 'req', id: 100 + i, method: m, args: [] })))
      for (const m of names) t.client.send(JSON.stringify({ t: 'cast', method: m, args: [] }))
      // Positive controls, sent AFTER: once they arrive, every malformed frame had its turn.
      t.client.send(JSON.stringify({ t: 'cast', method: 'fine', args: [] }))
      t.client.send(JSON.stringify({ t: 'req', id: 200, method: 'fine', args: [] }))
      await vi.waitFor(() => expect(t.frames.some((f) => JSON.parse(f).id === 200)).toBe(true))
      const res = t.frames.map((f) => JSON.parse(f))
      for (let i = 0; i < names.length; i++) {
        expect(res.find((r) => r.id === 100 + i)).toMatchObject({
          ok: false, error: { code: 'E_ROLE', message: 'Access check failed.' }
        })
      }
      expect(t.fa.dispatched.map((r) => r.method)).toEqual(['fine'])
      expect(t.fa.casts).toEqual([{ method: 'fine', args: [] }])
    } finally {
      warn.mockRestore()
    }
  })

  /** A host whose pin write the test finishes by hand, so the peer can drop while it is in flight. */
  function openWithDeferredPin(hooks?: Parameters<typeof connectRelayHost>[0]['hooks']) {
    const hostKeys = genKeyPair()
    const { hostT, peerT } = transportPair()
    const fa = fakeAttach()
    const counts = { hostOpened: 0, hostClosed: 0, records: 0 }
    let finishPin!: () => void
    const host = connectRelayHost({
      url: 'ws://127.0.0.1/x', token: 't', ourKeys: hostKeys, attach: fa.attach, transport: hostT,
      autoApprove: () => true, hooks,
      pins: { record: () => { counts.records++; return new Promise<void>((r) => { finishPin = r }) } },
      onPeerPending: () => {}, onOpen: () => counts.hostOpened++, onClose: () => counts.hostClosed++
    })
    const client = connectRelayClient({
      url: 'ws://127.0.0.1/x', token: 't', hostKeyB64: publicKeyToB64(hostKeys.publicKey), ourKeys: genKeyPair(),
      transport: peerT, autoApprove: true, onSas: () => {}, onApproved: () => {}, onFrame: () => {},
      onPtyData: () => {}, onClose: () => {}
    })
    return { host, client, fa, counts, finishPin: () => finishPin() }
  }
  const settle = () => new Promise((r) => setTimeout(r, 20))

  it('R13(a): a peer that drops during the pin write fires onClose ONCE, even when wrapSink then throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const t = openWithDeferredPin({ wrapSink: () => { throw new Error('filter exploded') } })
      await vi.waitFor(() => expect(t.counts.records).toBe(1)) // both confirmed; the pin write is in flight
      t.client.close() // the peer drops
      expect(t.counts.hostClosed).toBe(1)
      t.finishPin() // the pin write lands AFTER the drop
      await settle()
      expect(t.counts.hostClosed).toBe(1) // no late second fire from the wrapSink fail-closed path
      expect(t.counts.hostOpened).toBe(0)
    } finally {
      warn.mockRestore()
    }
  })

  it('R13(b): a peer that drops during the pin write is never attached to the dead socket', async () => {
    const t = openWithDeferredPin()
    await vi.waitFor(() => expect(t.counts.records).toBe(1))
    t.client.close()
    t.finishPin()
    await settle()
    expect(t.fa.sinks.size).toBe(0) // nothing attached (and so nothing leaks: detach already ran)
    expect(t.counts.hostOpened).toBe(0)
    expect(t.host.clientId()).toBeNull()
    expect(t.counts.hostClosed).toBe(1)
  })
})

describe('core relay host — frames between approval and open are held, not refused (R24)', () => {
  /** Both ends auto-approve; the host's pin write is finished by hand. `onApproved` runs on the
   *  CLIENT, which opens before the host while the host's pin write is in flight. */
  function openWithSlowPin(onApproved: (c: ReturnType<typeof connectRelayClient>) => void = () => {}) {
    const hostKeys = genKeyPair()
    const { hostT, peerT } = transportPair()
    const fa = fakeAttach()
    const frames: string[] = []
    const counts = { hostOpened: 0, hostClosed: 0, clientClosed: 0, records: 0, clientApproved: 0 }
    let finishPin!: () => void
    const host = connectRelayHost({
      url: 'ws://127.0.0.1/x', token: 't', ourKeys: hostKeys, attach: fa.attach, transport: hostT,
      autoApprove: () => true,
      pins: { record: () => { counts.records++; return new Promise<void>((r) => { finishPin = r }) } },
      onPeerPending: () => {}, onOpen: () => counts.hostOpened++, onClose: () => counts.hostClosed++
    })
    const client: ReturnType<typeof connectRelayClient> = connectRelayClient({
      url: 'ws://127.0.0.1/x', token: 't', hostKeyB64: publicKeyToB64(hostKeys.publicKey), ourKeys: genKeyPair(),
      transport: peerT, autoApprove: true, onSas: () => {},
      onApproved: (s) => { counts.clientApproved++; onApproved(s as ReturnType<typeof connectRelayClient>) },
      onFrame: (j) => frames.push(j), onPtyData: () => {}, onClose: () => counts.clientClosed++
    })
    const res = (id: number) => frames.map((f) => JSON.parse(f)).find((m) => m.t === 'res' && m.id === id)
    return { host, client, fa, frames, res, counts, finishPin: () => finishPin() }
  }
  const settle = () => new Promise((r) => setTimeout(r, 20))

  it('a request sent at the client’s onApproved, during a slow pin, is answered after open — not refused', async () => {
    const t = openWithSlowPin((c) => {
      c.send(JSON.stringify({ t: 'req', id: 1, method: 'first', args: [] }))
    })
    await vi.waitFor(() => expect(t.counts.clientApproved).toBe(1))
    expect(t.counts.records).toBe(1) // the host's pin write is in flight
    await settle()
    expect(t.res(1)).toBeUndefined() // held: neither refused nor served before open
    expect(t.fa.dispatched).toEqual([])
    t.finishPin()
    await vi.waitFor(() => expect(t.res(1)).toMatchObject({ ok: true, result: 'ok' }))
    expect(t.counts.hostOpened).toBe(1)
  })

  it('held frames run in arrival order, through the same access path as live ones', async () => {
    const seen: string[] = []
    const hostKeys = genKeyPair()
    const { hostT, peerT } = transportPair()
    const fa = fakeAttach()
    const frames: string[] = []
    let finishPin!: () => void
    let approved = false
    let opened = false
    connectRelayHost({
      url: 'ws://127.0.0.1/x', token: 't', ourKeys: hostKeys, attach: fa.attach, transport: hostT,
      autoApprove: () => true,
      pins: { record: () => new Promise<void>((r) => { finishPin = r }) },
      hooks: {
        access: (_s, kind, method) => {
          seen.push(`${kind}:${method}`)
          return method === 'refused' ? { allow: false, message: 'no' } : { allow: true }
        }
      },
      onPeerPending: () => {}, onOpen: () => { opened = true }, onClose: () => {}
    })
    const client = connectRelayClient({
      url: 'ws://127.0.0.1/x', token: 't', hostKeyB64: publicKeyToB64(hostKeys.publicKey), ourKeys: genKeyPair(),
      transport: peerT, autoApprove: true, onSas: () => {}, onApproved: () => { approved = true },
      onFrame: (j) => frames.push(j), onPtyData: () => {}, onClose: () => {}
    })
    await vi.waitFor(() => expect(approved).toBe(true))
    client.send(JSON.stringify({ t: 'req', id: 1, method: 'a', args: [] }))
    client.send(JSON.stringify({ t: 'cast', method: 'b', args: [] }))
    client.send(JSON.stringify({ t: 'req', id: 2, method: 'refused', args: [] }))
    client.send(JSON.stringify({ t: 'req', id: 3, method: 'c', args: [] }))
    await settle()
    expect(seen).toEqual([]) // nothing is judged, let alone served, before open
    finishPin()
    await vi.waitFor(() => expect(frames.some((f) => JSON.parse(f).id === 3)).toBe(true))
    expect(opened).toBe(true)
    expect(seen).toEqual(['req:a', 'cast:b', 'req:refused', 'req:c'])
    expect(fa.dispatched.map((r) => r.method)).toEqual(['a', 'c'])
    expect(fa.casts).toEqual([{ method: 'b', args: [] }])
    expect(frames.map((f) => JSON.parse(f)).find((m) => m.id === 2)).toMatchObject({ ok: false, error: { code: 'E_ROLE' } })
  })

  it('the held queue is dropped when the peer drops before open', async () => {
    const t = openWithSlowPin((c) => {
      c.send(JSON.stringify({ t: 'req', id: 1, method: 'x', args: [] }))
      c.send(JSON.stringify({ t: 'cast', method: 'y', args: [] }))
    })
    await vi.waitFor(() => expect(t.counts.clientApproved).toBe(1))
    t.client.close()
    t.finishPin()
    await settle()
    expect(t.fa.dispatched).toEqual([])
    expect(t.fa.casts).toEqual([])
    expect(t.fa.sinks.size).toBe(0)
    expect(t.counts.hostOpened).toBe(0)
  })

  it('the held queue is dropped when the shell closes the session before open', async () => {
    const t = openWithSlowPin((c) => {
      c.send(JSON.stringify({ t: 'req', id: 1, method: 'x', args: [] }))
    })
    await vi.waitFor(() => expect(t.counts.clientApproved).toBe(1))
    t.host.close()
    t.finishPin()
    await settle()
    expect(t.fa.dispatched).toEqual([])
    expect(t.counts.hostOpened).toBe(0)
    expect(t.counts.hostClosed).toBe(0) // the shell asked for this close
  })

  it('an overflowing queue closes the session (and tells the shell once); nothing is served', async () => {
    const t = openWithSlowPin((c) => {
      for (let i = 0; i <= HELD_FRAMES_MAX; i++) c.send(JSON.stringify({ t: 'cast', method: 'flood', args: [i] }))
    })
    await vi.waitFor(() => expect(t.counts.clientApproved).toBe(1))
    await vi.waitFor(() => expect(t.counts.hostClosed).toBe(1))
    expect(t.counts.clientClosed).toBe(1)
    t.finishPin()
    await settle()
    expect(t.fa.casts).toEqual([])
    expect(t.fa.sinks.size).toBe(0)
    expect(t.counts.hostOpened).toBe(0)
    expect(t.counts.hostClosed).toBe(1)
  })

  it('exactly HELD_FRAMES_MAX held frames is not an overflow', async () => {
    const t = openWithSlowPin((c) => {
      for (let i = 0; i < HELD_FRAMES_MAX; i++) c.send(JSON.stringify({ t: 'cast', method: 'burst', args: [i] }))
    })
    await vi.waitFor(() => expect(t.counts.clientApproved).toBe(1))
    t.finishPin()
    await vi.waitFor(() => expect(t.fa.casts).toHaveLength(HELD_FRAMES_MAX))
    expect(t.fa.casts.map((c) => c.args[0])).toEqual([...Array(HELD_FRAMES_MAX).keys()])
    expect(t.counts.hostClosed).toBe(0)
  })

  it('a request before approval is still refused E_UNAUTHORIZED, never held', async () => {
    const hostKeys = genKeyPair()
    const { hostT, peerT } = transportPair()
    const fa = fakeAttach()
    let opened = false
    connectRelayHost({
      url: 'ws://127.0.0.1/x', token: 't', ourKeys: hostKeys, attach: fa.attach, transport: hostT,
      onPeerPending: () => {}, onOpen: () => { opened = true }, onClose: () => {}
    })
    const frames: string[] = []
    const peer = connectRelay({
      url: 'ws://127.0.0.1/x', token: 't', role: 'client', ourKeys: genKeyPair(),
      theirPubB64: publicKeyToB64(hostKeys.publicKey), transport: peerT,
      onReady: () => {}, onRpc: () => {}, onFrame: () => {}, onClose: () => {},
      onTunnel: (kind, payload) => { if (kind === 'text') frames.push(new TextDecoder().decode(payload)) }
    })
    peer.sendTunnelText(JSON.stringify({ t: 'req', id: 1, method: 'x', args: [] }))
    await vi.waitFor(() => expect(frames.length).toBe(1))
    expect(JSON.parse(frames[0])).toMatchObject({ id: 1, ok: false, error: { code: 'E_UNAUTHORIZED' } })
    expect(fa.dispatched).toEqual([])
    expect(opened).toBe(false)
  })
})

describe('core relay client — a confirm made before the client holds its socket (R29)', () => {
  it('a human confirm inside onSas (in-process: before the socket exists) still reaches the host', async () => {
    const hostKeys = genKeyPair()
    const { hostT, peerT } = transportPair()
    const opened: string[] = []
    let hostSession!: RelayHostSession
    connectRelayHost({
      url: 'ws://127.0.0.1/x', token: 't', ourKeys: hostKeys, attach: fakeAttach().attach, transport: hostT,
      onPeerPending: (s) => { hostSession = s }, onOpen: () => opened.push('host'), onClose: () => {}
    })
    connectRelayClient({
      url: 'ws://127.0.0.1/x', token: 't', hostKeyB64: publicKeyToB64(hostKeys.publicKey), ourKeys: genKeyPair(),
      transport: peerT, autoApprove: false,
      onSas: (s) => s.confirm(), // synchronous: over this transport, connectRelay has not returned yet
      onApproved: () => opened.push('peer'), onFrame: () => {}, onPtyData: () => {}, onClose: () => {}
    })
    await new Promise((r) => setTimeout(r, 20))
    expect(opened).toEqual([]) // the host's human has not answered
    hostSession.confirm()
    await vi.waitFor(() => expect(opened.sort()).toEqual(['host', 'peer']))
  })
})

describe('core relay host — a session it already closed is not a dead socket', () => {
  // The real teardown (`attach.detach`) broadcasts on its way out: the presence hub sends its `leave`
  // diff to EVERY registered sink, the leaver's own included, before that sink is unregistered
  // (src/server/index.ts teardownClient → presenceHub.leave → platform.broadcast). Found on a real
  // headless boot (src/server/hosted-e2e.test.ts): the leaver's sink threw 'relay socket is not
  // connected', and every ordinary disconnect logged a false "[ui-sink] send … threw" strike.
  it('the leaver’s own teardown broadcast is dropped, not thrown; a peer still connected receives it', async () => {
    const hostKeys = genKeyPair()
    const sinks = new Map<number, UiSink>()
    const threw: string[] = []
    let next = 1
    const attach: PeerAttach = {
      attach: (sink) => { const id = next++; sinks.set(id, sink); return id },
      detach: (id) => {
        for (const [to, sink] of [...sinks]) {
          try {
            sink.sendText(JSON.stringify({ t: 'ev', channel: 'presence:peer', args: [{ op: 'leave', clientId: id }] }))
            sink.sendBinary(new Uint8Array([0]))
          } catch (err) {
            threw.push(`${to}: ${err instanceof Error ? err.message : String(err)}`)
          }
        }
        sinks.delete(id)
      },
      dispatch: async (_id, req) => ({ t: 'res', id: req.id, ok: true, result: null }),
      cast: () => {}
    }
    const peers = [0, 1].map(() => {
      const { hostT, peerT } = transportPair()
      const frames: string[] = []
      connectRelayHost({
        url: 'ws://127.0.0.1/x', token: 't', ourKeys: hostKeys, attach, transport: hostT,
        autoApprove: () => true, onPeerPending: () => {}, onOpen: () => {}, onClose: () => {}
      })
      const client = connectRelayClient({
        url: 'ws://127.0.0.1/x', token: 't', hostKeyB64: publicKeyToB64(hostKeys.publicKey), ourKeys: genKeyPair(),
        transport: peerT, autoApprove: true, onSas: () => {}, onApproved: () => {},
        onFrame: (j) => frames.push(j), onPtyData: () => {}, onClose: () => {}
      })
      return { client, frames }
    })
    await vi.waitFor(() => expect(sinks.size).toBe(2))
    peers[0].client.close()
    expect(threw).toEqual([])
    expect(sinks.size).toBe(1)
    await vi.waitFor(() => expect(peers[1].frames.some((f) => f.includes('"op":"leave"'))).toBe(true))
    peers[1].client.close()
    expect(threw).toEqual([])
  })
})
