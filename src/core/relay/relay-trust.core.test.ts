// src/core/relay/relay-trust.core.test.ts
import { describe, it, expect, vi } from 'vitest'
import { createTrustGate, TRUST_CONFIRM, deniedFrame, parseDenied } from './relay-trust'

function pair(opts: { hostAuto?: boolean; peerAuto?: boolean } = {}) {
  const opened: string[] = []
  const recorded: string[] = []
  let host!: ReturnType<typeof createTrustGate>
  let peer!: ReturnType<typeof createTrustGate>
  const toPeer: string[] = []
  const toHost: string[] = []
  host = createTrustGate({
    peerKeyB64: 'PEER', sessionId: 's1', sas: () => '123 456',
    sendConfirm: (j) => toPeer.push(j), onOpen: () => opened.push('host'),
    pins: { record: async (s) => { recorded.push(s.peerKeyB64) } },
    autoApprove: opts.hostAuto
  })
  peer = createTrustGate({
    peerKeyB64: 'HOST', sessionId: 's1', sas: () => '123 456',
    sendConfirm: (j) => toHost.push(j), onOpen: () => opened.push('peer'),
    autoApprove: opts.peerAuto
  })
  const flush = () => {
    for (const j of toPeer.splice(0)) peer.onTunnelText(j)
    for (const j of toHost.splice(0)) host.onTunnelText(j)
  }
  return { host, peer, opened, recorded, flush }
}

describe('core trust gate', () => {
  it('autoApprove on BOTH ends opens with no human', async () => {
    const t = pair({ hostAuto: true, peerAuto: true })
    t.flush()
    await vi.waitFor(() => expect(t.opened.sort()).toEqual(['host', 'peer']))
    expect(t.recorded).toEqual(['PEER'])
  })

  it('autoApprove on one end only still waits for the other human', async () => {
    const t = pair({ hostAuto: true })
    t.flush()
    await new Promise((r) => setTimeout(r, 10))
    expect(t.opened).toEqual([])
    expect(t.recorded).toEqual([])
    t.peer.confirmHere()
    t.flush()
    await vi.waitFor(() => expect(t.opened.sort()).toEqual(['host', 'peer']))
  })

  it('without autoApprove nothing is sent at construction (byte-identical legacy)', () => {
    const sent: string[] = []
    createTrustGate({ peerKeyB64: 'P', sessionId: 's', sas: () => null, sendConfirm: (j) => sent.push(j), onOpen: () => {} })
    expect(sent).toEqual([])
  })

  it('a failing pin store never strands a mutually-approved session', async () => {
    const opened: string[] = []
    const g = createTrustGate({
      peerKeyB64: 'P', sessionId: 's', sas: () => null, sendConfirm: () => {},
      onOpen: () => opened.push('x'), pins: { record: async () => { throw new Error('disk') } }
    })
    g.confirmHere()
    g.onTunnelText(JSON.stringify({ t: 'cast', method: TRUST_CONFIRM, args: [] }))
    await vi.waitFor(() => expect(opened).toEqual(['x']))
  })

  it('isOpen() stays false while the pin write is in flight, and agrees with onOpen after', async () => {
    let finishPin!: () => void
    const opened: string[] = []
    const g = createTrustGate({
      peerKeyB64: 'P', sessionId: 's', sas: () => null, sendConfirm: () => {},
      onOpen: () => opened.push('x'),
      pins: { record: () => new Promise<void>((r) => { finishPin = r }) }
    })
    g.confirmHere()
    g.onTunnelText(JSON.stringify({ t: 'cast', method: TRUST_CONFIRM, args: [] }))
    await new Promise((r) => setTimeout(r, 10))
    expect(g.isOpen()).toBe(false)
    expect(opened).toEqual([])
    finishPin()
    await vi.waitFor(() => expect(g.isOpen()).toBe(true))
    expect(opened).toEqual(['x'])
  })

  it('opens exactly once, however many confirms arrive', async () => {
    let records = 0
    const opened: string[] = []
    const g = createTrustGate({
      peerKeyB64: 'P', sessionId: 's', sas: () => null, sendConfirm: () => {},
      onOpen: () => opened.push('x'), pins: { record: async () => { records++ } }
    })
    const confirm = JSON.stringify({ t: 'cast', method: TRUST_CONFIRM, args: [] })
    g.confirmHere()
    g.onTunnelText(confirm)
    g.onTunnelText(confirm)
    g.confirmHere()
    await vi.waitFor(() => expect(opened).toEqual(['x']))
    await new Promise((r) => setTimeout(r, 10))
    expect(opened).toEqual(['x'])
    expect(records).toBe(1)
  })

  it('a denial frame is not a trust frame: the gate does not consume it', () => {
    const g = createTrustGate({ peerKeyB64: 'P', sessionId: 's', sas: () => null, sendConfirm: () => {}, onOpen: () => {} })
    expect(g.onTunnelText(deniedFrame('denied'))).toBe(false)
  })

  it('denied frames round-trip and anything else is not a denial', () => {
    expect(parseDenied(deniedFrame('removed'))).toBe('removed')
    expect(parseDenied(JSON.stringify({ t: 'cast', method: 'trust:denied', args: ['bogus'] }))).toBeNull()
    expect(parseDenied(JSON.stringify({ t: 'cast', method: TRUST_CONFIRM, args: [] }))).toBeNull()
  })
})
