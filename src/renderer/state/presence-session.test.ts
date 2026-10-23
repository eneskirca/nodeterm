import { describe, it, expect, vi } from 'vitest'
import type { PeerState } from '@shared/presence'
import { createPresenceSession } from './presence'

/** A recording fake NodeTerminalApi.presence; onSync/onPeer are spies so we can assert exactly-once. */
function fakeApi(clientId: number) {
  const calls: Array<[string, unknown]> = []
  let syncSubs = 0
  const presence = {
    hello: vi.fn(async () => ({ clientId, peers: [] as PeerState[] })),
    cursor: (c: unknown) => calls.push(['cursor', c]),
    focus: (n: unknown) => calls.push(['focus', n]),
    chat: (t: unknown) => calls.push(['chat', t]),
    project: (p: unknown) => calls.push(['project', p]),
    onSync: (_cb: (p: PeerState[]) => void) => {
      syncSubs++
      return () => {}
    },
    onPeer: (_cb: (d: unknown) => void) => () => {}
  }
  return { api: { presence } as any, calls, subs: () => syncSubs }
}

describe('createPresenceSession — one store per api (memoized by identity)', () => {
  it('returns the SAME instance for a repeat api object', () => {
    // Stage 1 invariant: the ws-bridge replays its pre-subscribe buffer to the FIRST subscriber
    // only, so a second store against the same api would silently miss the join-time sync.
    const a = fakeApi(1)
    const first = createPresenceSession(a.api)
    const second = createPresenceSession(a.api)
    expect(second).toBe(first)
  })

  it('returns DIFFERENT instances for different apis', () => {
    const a = fakeApi(1)
    const b = fakeApi(2)
    expect(createPresenceSession(a.api)).not.toBe(createPresenceSession(b.api))
  })
})

describe('createPresenceSession — per-instance isolation', () => {
  it('two instances do not share the lastFocus dedup', () => {
    const a = fakeApi(1)
    const b = fakeApi(2)
    const sa = createPresenceSession(a.api)
    const sb = createPresenceSession(b.api)
    // Force "peers exist" so reportFocus casts (it gates on hasPeers).
    sa.store.setState({ myId: 1, peers: { 1: {} as PeerState, 9: {} as PeerState } })
    sb.store.setState({ myId: 2, peers: { 2: {} as PeerState, 9: {} as PeerState } })
    sa.reportFocus('n1')
    sa.reportFocus('n1') // deduped within A → one cast
    sb.reportFocus('n1') // B has its OWN lastFocus → still casts
    expect(a.calls.filter((c) => c[0] === 'focus')).toEqual([['focus', 'n1']])
    expect(b.calls.filter((c) => c[0] === 'focus')).toEqual([['focus', 'n1']])
  })

  it('connect() is idempotent per instance (subscribes at most once), independently per session', () => {
    const a = fakeApi(1)
    const s = createPresenceSession(a.api)
    const stop1 = s.connect()
    const stop2 = s.connect() // second is inert
    expect(a.subs()).toBe(1)
    stop2()
    stop1()
  })

  it('each instance has its own faceCache (a peer in A never appears in B.selectFaces)', () => {
    const a = fakeApi(1)
    const b = fakeApi(2)
    const sa = createPresenceSession(a.api)
    const sb = createPresenceSession(b.api)
    const peer = (id: number): PeerState => ({
      clientId: id,
      name: `P${id}`,
      color: '#fff',
      cursor: null,
      focus: null,
      chat: null,
      typing: null,
      projectId: 'web',
      dino: null,
      kind: 'browser'
    })
    sa.store.setState({ myId: 1, peers: { 1: peer(1), 5: peer(5) } })
    sb.store.setState({ myId: 2, peers: { 2: peer(2) } })
    expect(sa.selectFaces(sa.store.getState()).map((f) => f.clientId)).toEqual([5])
    expect(sb.selectFaces(sb.store.getState()).map((f) => f.clientId)).toEqual([])
  })
})

describe('a pop-out window listens to presence without joining it', () => {
  it('never says hello, seeds the table from windows.presencePeers, applies diffs, keeps myId null', async () => {
    const { setPopoutProjectIdForTests } = await import('./windows')
    setPopoutProjectIdForTests('b')
    try {
      let peerCb: ((d: unknown) => void) | null = null
      const a = fakeApi(7)
      a.api.presence.onPeer = (cb: (d: unknown) => void) => {
        peerCb = cb
        return () => {}
      }
      const main = { clientId: 1 } as PeerState
      const mate = { clientId: 2 } as PeerState
      a.api.windows = { presencePeers: vi.fn(async () => [main]) }
      const s = createPresenceSession(a.api)
      const stop = s.connect()
      await Promise.resolve()
      await Promise.resolve()
      expect(a.api.presence.hello).not.toHaveBeenCalled()
      expect(Object.keys(s.store.getState().peers)).toEqual(['1'])
      peerCb!({ op: 'join', peer: mate })
      // Two entries = the main window + a teammate: the canvas-sync gate's "has peers".
      expect(Object.keys(s.store.getState().peers).sort()).toEqual(['1', '2'])
      expect(s.store.getState().myId).toBeNull()
      expect(s.store.getState().needsName).toBe(false)
      stop()
      expect(s.store.getState().peers).toEqual({})
    } finally {
      setPopoutProjectIdForTests(null)
    }
  })
})
