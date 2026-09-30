import { describe, it, expect, vi } from 'vitest'
import { encodePtyData, E_DISCONNECTED } from '../../shared/rpc'
import type { RelayClientApi } from '../../shared/types'
import { RelayFrameTransport, type FrameTransport } from './frame-transport'
import { emitLocalRelayClose } from './relay-local-close'
import { RpcClient } from './ws-bridge'

/**
 * An in-memory `FrameTransport` double. It records what the RpcClient sends, lets the test push
 * inbound frames (JSON strings OR binary `Uint8Array` pty-data), and can fire `close`. `ready`
 * resolves immediately — the carrier is "open" the moment it is constructed. This proves the
 * RpcClient depends only on the FrameTransport seam, never on a WebSocket.
 */
class FakeTransport implements FrameTransport {
  sent: string[] = []
  private msgCb: ((data: string | Uint8Array) => void) | null = null
  private closeCb: (() => void) | null = null

  send(json: string): void {
    this.sent.push(json)
  }
  onMessage(cb: (data: string | Uint8Array) => void): void {
    this.msgCb = cb
  }
  onClose(cb: () => void): void {
    this.closeCb = cb
  }
  ready(): Promise<void> {
    return Promise.resolve()
  }

  // Test drivers ─────────────────────────────────────────────────────────────
  emit(data: string | Uint8Array): void {
    this.msgCb?.(data)
  }
  drop(): void {
    this.closeCb?.()
  }
}

describe('RpcClient over a FrameTransport', () => {
  it('resolves a request on a matching res frame', async () => {
    const t = new FakeTransport()
    const client = new RpcClient(t)
    await client.ready()
    const p = client.request('any:method', 'ping')
    // The RpcClient assigned id 1 (first request).
    const frame = JSON.parse(t.sent[0])
    expect(frame).toMatchObject({ t: 'req', id: 1, method: 'any:method', args: ['ping'] })
    t.emit(JSON.stringify({ t: 'res', id: frame.id, ok: true, result: 'pong' }))
    expect(await p).toBe('pong')
  })

  it('fans out a JSON ev frame to subscribers', () => {
    const t = new FakeTransport()
    const client = new RpcClient(t)
    const seen: unknown[] = []
    client.subscribe('pty:exit:s1', (code) => seen.push(code))
    t.emit(JSON.stringify({ t: 'ev', channel: 'pty:exit:s1', args: [0] }))
    expect(seen).toEqual([0])
  })

  it('fans out a binary pty:data frame on ptyData(sessionId)', () => {
    const t = new FakeTransport()
    const client = new RpcClient(t)
    const datas: string[] = []
    client.subscribe('pty:data:s1', (d) => datas.push(d as string))
    t.emit(encodePtyData('s1', 'hello'))
    expect(datas).toEqual(['hello'])
  })

  it('rejects in-flight requests with E_DISCONNECTED when the transport closes', async () => {
    const t = new FakeTransport()
    const client = new RpcClient(t)
    await client.ready()
    const a = client.request('git:worktree-add', '/repo')
    t.drop()
    await expect(a).rejects.toMatchObject({ code: E_DISCONNECTED })
  })

  it('notifies onClose hooks when the transport closes', async () => {
    const t = new FakeTransport()
    const client = new RpcClient(t)
    let closed = 0
    client.onClose(() => closed++)
    t.drop()
    expect(closed).toBe(1)
  })
})

// ── R41: a relay connection this renderer closed itself ────────────────────────────────────────────

describe('RelayFrameTransport: a close is a close, whoever made it', () => {
  function relay() {
    const mainClose = new Map<string, () => void>()
    const api = {
      onApproved: vi.fn(() => () => {}),
      onClosed: vi.fn((id: string, cb: () => void) => {
        mainClose.set(id, cb)
        return () => {}
      }),
      send: vi.fn(),
      onFrame: vi.fn(() => () => {})
    } as unknown as RelayClientApi
    return { api, mainClose }
  }

  it('fires on main\'s close, and on a close this renderer announced locally (main never reports that one)', () => {
    const r = relay()
    const onMain = vi.fn()
    new RelayFrameTransport('conn-main', r.api).onClose(onMain)
    r.mainClose.get('conn-main')!()
    expect(onMain).toHaveBeenCalledTimes(1)
    const onLocal = vi.fn()
    new RelayFrameTransport('conn-local', r.api).onClose(onLocal)
    emitLocalRelayClose('conn-local')
    expect(onLocal).toHaveBeenCalledTimes(1)
  })

  it('fires once, however many closes arrive (a drop, then the offline teardown\'s own close)', () => {
    const r = relay()
    const cb = vi.fn()
    new RelayFrameTransport('conn-both', r.api).onClose(cb)
    r.mainClose.get('conn-both')!()
    emitLocalRelayClose('conn-both')
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('fires once in the other order too (our own close, then main noticing the socket is gone)', () => {
    const r = relay()
    const cb = vi.fn()
    new RelayFrameTransport('conn-rev', r.api).onClose(cb)
    emitLocalRelayClose('conn-rev')
    r.mainClose.get('conn-rev')!()
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('an RpcClient over it fails its in-flight requests on a local close', async () => {
    const r = relay()
    const client = new RpcClient(new RelayFrameTransport('conn-rpc', r.api))
    const pending = client.request('workspace:load')
    emitLocalRelayClose('conn-rpc')
    await expect(pending).rejects.toMatchObject({ code: E_DISCONNECTED })
  })
})
