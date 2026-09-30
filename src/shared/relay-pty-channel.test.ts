import { describe, it, expect } from 'vitest'
import { IPC } from './ipc'
import { createRelayPtyGate, relayPtyDataKey, RELAY_PTY_ALLOW_MAX } from './relay-pty-channel'

const req = (id: number, method = 'pty:create') => JSON.stringify({ t: 'req', id, method, args: [{}] })
const ok = (id: number, result: unknown) => JSON.stringify({ t: 'res', id, ok: true, result })

describe('relayPtyDataKey', () => {
  it('never equals a local-shaped id, whatever the host names', () => {
    for (const hostId of ['pty-1', 'pty-42', '', 'relay:x']) {
      const key = relayPtyDataKey('conn-1', hostId)
      expect(key).not.toBe(hostId)
      expect(key.startsWith('relay:conn-1:')).toBe(true)
      expect(IPC.ptyData(key)).not.toBe(IPC.ptyData('pty-1'))
    }
  })
  it('separates two connections naming the same host id', () => {
    expect(relayPtyDataKey('a', 'pty-1')).not.toBe(relayPtyDataKey('b', 'pty-1'))
  })
})

describe('createRelayPtyGate', () => {
  it('allows nothing until a pty:create this connection sent is answered', () => {
    const g = createRelayPtyGate()
    expect(g.allows('pty-1')).toBe(false)
    // An answer to a request we never sent is ignored (a host inventing a create reply).
    g.noteInbound(ok(9, { sessionId: 'pty-1' }))
    expect(g.allows('pty-1')).toBe(false)
    g.noteOutbound(req(9))
    g.noteInbound(ok(9, { sessionId: 'pty-3' }))
    expect(g.allows('pty-3')).toBe(true)
    expect(g.allows('pty-1')).toBe(false)
  })
  it('ignores answers to other methods, failures, and malformed ids', () => {
    const g = createRelayPtyGate()
    g.noteOutbound(req(1, 'fs:list'))
    g.noteInbound(ok(1, { sessionId: 'pty-1' }))
    g.noteOutbound(req(2))
    g.noteInbound(JSON.stringify({ t: 'res', id: 2, ok: false, error: { code: 'x', message: 'y' } }))
    g.noteOutbound(req(3))
    g.noteInbound(ok(3, { sessionId: 5 }))
    g.noteOutbound(req(4))
    g.noteInbound('not json')
    g.noteInbound(ok(4, null))
    expect(g.allows('pty-1')).toBe(false)
    expect(g.allows('5')).toBe(false)
  })
  it('an answered request id is spent: a second answer adds nothing', () => {
    const g = createRelayPtyGate()
    g.noteOutbound(req(1))
    g.noteInbound(ok(1, { sessionId: 'pty-1' }))
    g.noteInbound(ok(1, { sessionId: 'pty-2' }))
    expect(g.allows('pty-2')).toBe(false)
  })
  it('is bounded: the oldest id is forgotten past the cap', () => {
    const g = createRelayPtyGate()
    for (let i = 0; i <= RELAY_PTY_ALLOW_MAX; i++) {
      g.noteOutbound(req(i))
      g.noteInbound(ok(i, { sessionId: `s${i}` }))
    }
    expect(g.allows('s0')).toBe(false)
    expect(g.allows(`s${RELAY_PTY_ALLOW_MAX}`)).toBe(true)
  })
})
