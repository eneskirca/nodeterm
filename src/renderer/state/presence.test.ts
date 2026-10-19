import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { PRESENCE_COLORS, type DinoSnapshot, type PeerState } from '@shared/presence'

/** A minimal live dino snapshot — the fields are irrelevant to these selector/cast tests. */
function snap(over: Partial<DinoSnapshot> = {}): DinoSnapshot {
  return {
    y: 0,
    ducking: false,
    crashed: false,
    started: true,
    score: 0,
    speed: 6,
    groundScroll: 0,
    obstacles: [],
    ...over
  }
}

// The store reads localStorage at call time; each test stubs a fresh in-memory storage and
// re-imports the module (vi.resetModules) so nothing leaks between cases.
function memStorage(seed: Record<string, string> = {}): Storage {
  const m = new Map(Object.entries(seed))
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
    key: () => null,
    get length() {
      return m.size
    }
  } as Storage
}

function peer(clientId: number, over: Partial<PeerState> = {}): PeerState {
  return {
    clientId,
    name: `P${clientId}`,
    color: PRESENCE_COLORS[0],
    cursor: null,
    focus: null,
    chat: null,
    typing: null,
    projectId: 'web',
    dino: null,
    kind: 'browser',
    ...over
  }
}

type HelloRes = { clientId: number; peers: PeerState[] }

/** A recording window.nodeTerminal.presence. `hello` may be a canned response or a function (so a
 *  test can defer or reject it). The unsubscribes are spies: a store that forgot to call them must
 *  FAIL, so we never rely on the fake nulling its own callbacks. */
function fakePresenceApi(
  hello: HelloRes | (() => Promise<HelloRes>) = { clientId: 7, peers: [peer(7)] }
) {
  const calls: Array<[string, unknown]> = []
  const unSync = vi.fn()
  const unPeer = vi.fn()
  const subs = { sync: 0, peer: 0 }
  let syncCb: ((peers: PeerState[]) => void) | null = null
  let peerCb: ((diff: unknown) => void) | null = null
  const presence = {
    hello: vi.fn(async (id: unknown) => {
      calls.push(['hello', id])
      return typeof hello === 'function' ? await hello() : hello
    }),
    cursor: (c: unknown) => calls.push(['cursor', c]),
    focus: (n: unknown) => calls.push(['focus', n]),
    chat: (t: unknown) => calls.push(['chat', t]),
    dino: (payload: unknown) => calls.push(['dino', payload]),
    project: (p: unknown) => calls.push(['project', p]),
    onSync: (cb: (peers: PeerState[]) => void) => {
      subs.sync++
      syncCb = cb
      return () => {
        unSync()
        syncCb = null
      }
    },
    onPeer: (cb: (diff: unknown) => void) => {
      subs.peer++
      peerCb = cb
      return () => {
        unPeer()
        peerCb = null
      }
    }
  }
  vi.stubGlobal('window', { nodeTerminal: { presence } })
  return {
    calls,
    presence,
    subs,
    unSync,
    unPeer,
    emitSync: (p: PeerState[]) => syncCb?.(p),
    emitPeer: (d: unknown) => peerCb?.(d)
  }
}

function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const STORED_ME = {
  'nodeterm.presence.me': JSON.stringify({ name: 'Enes', color: PRESENCE_COLORS[1] })
}

beforeEach(() => vi.resetModules())
afterEach(() => vi.unstubAllGlobals())

describe('identity (the only persisted part of presence)', () => {
  it('round-trips {name,color} through localStorage under nodeterm.presence.me', async () => {
    const store = memStorage()
    vi.stubGlobal('localStorage', store)
    const { loadIdentity, saveIdentity, ME_KEY } = await import('./presence')
    expect(loadIdentity()).toBeNull()
    saveIdentity({ name: 'Enes', color: PRESENCE_COLORS[1] })
    expect(JSON.parse(store.getItem(ME_KEY)!)).toEqual({ name: 'Enes', color: PRESENCE_COLORS[1] })
    expect(loadIdentity()).toEqual({ name: 'Enes', color: PRESENCE_COLORS[1] })
  })

  it('survives corrupt storage (returns null instead of throwing)', async () => {
    vi.stubGlobal('localStorage', memStorage({ 'nodeterm.presence.me': '{not json' }))
    const { loadIdentity } = await import('./presence')
    expect(loadIdentity()).toBeNull()
  })
})

describe('connectPresence', () => {
  it('sends hello with the stored identity, records my id, and seeds the peer table', async () => {
    vi.stubGlobal(
      'localStorage',
      memStorage({
        'nodeterm.presence.me': JSON.stringify({ name: 'Enes', color: PRESENCE_COLORS[1] })
      })
    )
    const api = fakePresenceApi({ clientId: 7, peers: [peer(7, { name: 'Enes' }), peer(8)] })
    const { connectPresence, usePresence, selectOthers } = await import('./presence')

    const stop = connectPresence()
    await vi.waitFor(() => expect(usePresence.getState().myId).toBe(7))
    expect(api.calls[0]).toEqual(['hello', { name: 'Enes', color: PRESENCE_COLORS[1] }])
    expect(usePresence.getState().needsName).toBe(false)
    // My own peer is in the table but never in `others` — I must not draw my own cursor.
    expect(selectOthers(usePresence.getState()).map((p) => p.clientId)).toEqual([8])
    stop()
  })

  it('says hello with a provisional identity when none is stored (so myId is known on first run)', async () => {
    vi.stubGlobal('localStorage', memStorage())
    const api = fakePresenceApi()
    const { connectPresence, usePresence } = await import('./presence')
    const stop = connectPresence()
    // We still need a name from the user…
    expect(usePresence.getState().needsName).toBe(true)
    // …but we must NOT stay anonymous on the wire: without a hello we never learn our own
    // ClientId, and every selector would hand our own peer back to us as a teammate.
    expect(api.presence.hello).toHaveBeenCalledTimes(1)
    // The provisional identity claims nothing: the hub keeps the name/color it assigned at join.
    expect(api.calls[0]).toEqual(['hello', { name: '', color: '' }])
    await vi.waitFor(() => expect(usePresence.getState().myId).toBe(7))
    stop()
  })

  it('never surfaces my own peer while hello is in flight (browser buffer-drain ordering)', async () => {
    vi.stubGlobal('localStorage', memStorage(STORED_ME))
    const d = deferred<HelloRes>()
    const api = fakePresenceApi(() => d.promise)
    const { connectPresence, usePresence, selectOthers, selectVisible, selectFocused, selectFaces } =
      await import('./presence')
    const stop = connectPresence()

    // The ws-bridge drains its early buffer into the first subscriber SYNCHRONOUSLY: the hub's
    // join-time sync (which contains MY OWN peer) and my own join diff land before hello resolves.
    api.emitSync([peer(7, { name: 'Enes', focus: 'node-a' }), peer(8, { name: 'Ada' })])
    api.emitPeer({ op: 'join', peer: peer(7, { name: 'Enes', focus: 'node-a' }) })
    expect(usePresence.getState().myId).toBeNull()

    // No selector may hand back a peer while we do not know which one is us — a ghost of myself
    // in the facepile, and (next task) a ghost cursor chasing my real one.
    const s = usePresence.getState()
    expect(selectOthers(s)).toEqual([])
    expect(selectVisible(s, 'web')).toEqual([])
    expect(selectFocused(s, 'node-a', 'web')).toEqual([])
    expect(selectFaces(s)).toEqual([])

    d.resolve({ clientId: 7, peers: [peer(7, { name: 'Enes' }), peer(8, { name: 'Ada' })] })
    await vi.waitFor(() => expect(usePresence.getState().myId).toBe(7))
    expect(selectOthers(usePresence.getState()).map((p) => p.clientId)).toEqual([8])
    stop()
  })

  it('is idempotent: a second connect is inert and its teardown tears nothing down', async () => {
    vi.stubGlobal('localStorage', memStorage(STORED_ME))
    const api = fakePresenceApi({ clientId: 7, peers: [peer(7), peer(8)] })
    const { connectPresence, usePresence, selectOthers } = await import('./presence')

    const stop1 = connectPresence()
    const stop2 = connectPresence() // Fast Refresh / a stray double mount
    await vi.waitFor(() => expect(usePresence.getState().myId).toBe(7))

    // One subscription pair, one hello — a second pair would double-apply every diff.
    expect(api.subs).toEqual({ sync: 1, peer: 1 })
    expect(api.presence.hello).toHaveBeenCalledTimes(1)

    // The inert connect's teardown must not reset the store out from under the live one.
    stop2()
    expect(api.unSync).not.toHaveBeenCalled()
    expect(api.unPeer).not.toHaveBeenCalled()
    expect(usePresence.getState().myId).toBe(7)
    expect(selectOthers(usePresence.getState()).map((p) => p.clientId)).toEqual([8])

    // The real teardown actually unsubscribes (the fake nulls its callbacks either way, so the
    // spies — not the silence afterwards — are what proves it).
    stop1()
    expect(api.unSync).toHaveBeenCalledTimes(1)
    expect(api.unPeer).toHaveBeenCalledTimes(1)
    expect(usePresence.getState().myId).toBeNull()
    expect(usePresence.getState().peers).toEqual({})

    // …and after a teardown, connecting again works (the guard is released, not sticky).
    const stop3 = connectPresence()
    await vi.waitFor(() => expect(usePresence.getState().myId).toBe(7))
    expect(api.subs).toEqual({ sync: 2, peer: 2 })
    stop3()
  })

  it('survives a hello rejection (no unhandled rejection, defined state, logged once)', async () => {
    vi.stubGlobal('localStorage', memStorage(STORED_ME))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const api = fakePresenceApi(() => Promise.reject(new Error('ws closed')))
    const { connectPresence, usePresence, selectOthers } = await import('./presence')

    const stop = connectPresence()
    await vi.waitFor(() => expect(api.presence.hello).toHaveBeenCalledTimes(1))
    await Promise.resolve()

    // Defined state: no id, so no selector claims anyone is here (never me as my own peer).
    expect(usePresence.getState().myId).toBeNull()
    api.emitSync([peer(7), peer(8)])
    expect(selectOthers(usePresence.getState())).toEqual([])
    expect(warn).toHaveBeenCalledTimes(1)

    // A retry that also fails does not spam the log.
    usePresence.getState().setMe({ name: 'Ada', color: PRESENCE_COLORS[2] })
    await vi.waitFor(() => expect(api.presence.hello).toHaveBeenCalledTimes(2))
    await Promise.resolve()
    expect(warn).toHaveBeenCalledTimes(1)
    stop()
    warn.mockRestore()
  })

  it('setMe persists the identity, clears needsName and says hello', async () => {
    vi.stubGlobal('localStorage', memStorage())
    const api = fakePresenceApi()
    const { connectPresence, usePresence } = await import('./presence')
    const stop = connectPresence()
    usePresence.getState().setMe({ name: 'Ada', color: PRESENCE_COLORS[2] })
    await vi.waitFor(() => expect(usePresence.getState().myId).toBe(7))
    expect(usePresence.getState().needsName).toBe(false)
    // The name submit is a SECOND hello (the first was the provisional one at connect) — it just
    // renames us on the hub.
    expect(api.calls.filter((c) => c[0] === 'hello')).toEqual([
      ['hello', { name: '', color: '' }],
      ['hello', { name: 'Ada', color: PRESENCE_COLORS[2] }]
    ])
    stop()
  })
})

describe('selectFaces (the facepile projection — cursor traffic must not re-render it)', () => {
  it('projects only the facepile fields and keeps object identity across cursor updates', async () => {
    vi.stubGlobal('localStorage', memStorage(STORED_ME))
    const api = fakePresenceApi({ clientId: 7, peers: [peer(7), peer(8, { name: 'Ada' })] })
    const { connectPresence, usePresence, selectFaces } = await import('./presence')
    const stop = connectPresence()
    await vi.waitFor(() => expect(usePresence.getState().myId).toBe(7))

    const before = selectFaces(usePresence.getState())
    expect(before).toEqual([
      { clientId: 8, name: 'Ada', color: PRESENCE_COLORS[0], projectId: 'web', kind: 'browser' }
    ])

    // A cursor patch replaces the PeerState object; the projected face must stay the SAME object,
    // so useShallow sees no change and the facepile does not re-render at 20 Hz.
    api.emitPeer({ op: 'update', clientId: 8, patch: { cursor: { x: 1, y: 2 } } })
    const after = selectFaces(usePresence.getState())
    expect(after[0]).toBe(before[0])

    // A field the facepile DOES show changes → a new object (the pill actually updates).
    api.emitPeer({ op: 'update', clientId: 8, patch: { name: 'Ada L.' } })
    const renamed = selectFaces(usePresence.getState())
    expect(renamed[0]).not.toBe(before[0])
    expect(renamed[0].name).toBe('Ada L.')
    stop()
  })
})

describe('diff application', () => {
  it('applies join / update / leave and replaces the table on sync', async () => {
    vi.stubGlobal(
      'localStorage',
      memStorage({
        'nodeterm.presence.me': JSON.stringify({ name: 'Enes', color: PRESENCE_COLORS[1] })
      })
    )
    const api = fakePresenceApi({ clientId: 7, peers: [peer(7)] })
    const { connectPresence, usePresence, selectOthers, selectFocused } = await import('./presence')
    const stop = connectPresence()
    await vi.waitFor(() => expect(usePresence.getState().myId).toBe(7))

    api.emitPeer({ op: 'join', peer: peer(8, { name: 'Ada' }) })
    expect(selectOthers(usePresence.getState()).map((p) => p.name)).toEqual(['Ada'])

    api.emitPeer({ op: 'update', clientId: 8, patch: { cursor: { x: 4, y: 5 }, focus: 'node-a' } })
    expect(usePresence.getState().peers[8].cursor).toEqual({ x: 4, y: 5 })
    expect(selectFocused(usePresence.getState(), 'node-a', 'web').map((p) => p.clientId)).toEqual([
      8
    ])
    // An update for an unknown peer is ignored (no ghost rows).
    api.emitPeer({ op: 'update', clientId: 99, patch: { chat: 'boo' } })
    expect(usePresence.getState().peers[99]).toBeUndefined()

    api.emitPeer({ op: 'leave', clientId: 8 })
    expect(selectOthers(usePresence.getState())).toEqual([])

    api.emitSync([peer(7), peer(9)])
    expect(selectOthers(usePresence.getState()).map((p) => p.clientId)).toEqual([9])
    stop()
  })
})

describe('project scoping (a peer on another canvas is never drawn on mine)', () => {
  it('selectVisible / selectFocused honour the project; selectOthers (facepile) does not', async () => {
    vi.stubGlobal(
      'localStorage',
      memStorage({
        'nodeterm.presence.me': JSON.stringify({ name: 'Enes', color: PRESENCE_COLORS[1] })
      })
    )
    const api = fakePresenceApi({ clientId: 7, peers: [peer(7, { projectId: 'web' })] })
    const { connectPresence, usePresence, selectOthers, selectVisible, selectFocused } =
      await import('./presence')
    const stop = connectPresence()
    await vi.waitFor(() => expect(usePresence.getState().myId).toBe(7))

    api.emitPeer({ op: 'join', peer: peer(8, { projectId: 'web', focus: 'node-a' }) })
    api.emitPeer({ op: 'join', peer: peer(9, { projectId: 'api', focus: 'node-b' }) })
    api.emitPeer({ op: 'join', peer: peer(10, { projectId: null, kind: 'phone' }) })
    const s = usePresence.getState()

    // Canvas surfaces: only the peers on MY project.
    expect(selectVisible(s, 'web').map((p) => p.clientId)).toEqual([8])
    expect(selectFocused(s, 'node-a', 'web').map((p) => p.clientId)).toEqual([8])
    // A peer focused on a node of ANOTHER project must not chip a node here (ids are global).
    expect(selectFocused(s, 'node-b', 'web')).toEqual([])
    // No project open (welcome screen) → nothing is drawn at all.
    expect(selectVisible(s, null)).toEqual([])

    // The facepile shows everyone, whatever canvas they are on (including the cursorless phone).
    expect(selectOthers(s).map((p) => p.clientId)).toEqual([8, 9, 10])

    // Peer 8 switches to another project → their cursor leaves my canvas immediately.
    api.emitPeer({ op: 'update', clientId: 8, patch: { projectId: 'api' } })
    expect(selectVisible(usePresence.getState(), 'web')).toEqual([])
    stop()
  })
})

describe('reportFocus / reportProject', () => {
  /** Two peers in the table — me and somebody else. Focus is only published when there IS somebody
   *  to draw the chip: alone, the cast is pure cost (see the solo test below). */
  async function withPeer() {
    const mod = await import('./presence')
    mod.usePresence.setState({ myId: 7, peers: { 7: peer(7), 8: peer(8) } })
    return mod
  }

  it('publishes NOTHING while alone: a hover must not cost an IPC round-trip', async () => {
    vi.stubGlobal('localStorage', memStorage(STORED_ME))
    const api = fakePresenceApi()
    const { reportFocus, releaseFocus, usePresence } = await import('./presence')
    usePresence.setState({ myId: 7, peers: { 7: peer(7) } }) // just me

    reportFocus('node-a') // hover-dwell into a terminal
    releaseFocus('node-a') // …and out again
    expect(api.calls.filter((c) => c[0] === 'focus')).toEqual([])

    // A peer shows up: focus is published from the next hover on, and its retraction with it.
    usePresence.setState({ peers: { 7: peer(7), 8: peer(8) } })
    reportFocus('node-a')
    releaseFocus('node-a')
    expect(api.calls.filter((c) => c[0] === 'focus')).toEqual([
      ['focus', 'node-a'],
      ['focus', null]
    ])
  })

  it('still retracts a published focus after the last peer leaves (never a stale chip)', async () => {
    vi.stubGlobal('localStorage', memStorage(STORED_ME))
    const api = fakePresenceApi()
    const { reportFocus, releaseFocus, usePresence } = await import('./presence')
    usePresence.setState({ myId: 7, peers: { 7: peer(7), 8: peer(8) } })
    reportFocus('node-a')

    // Peer 8 closed its tab while we sit in the node. The clear is NOT gated: the hub still holds
    // our focus, and the next peer to join would get it in the snapshot and chip a node we left.
    usePresence.setState({ peers: { 7: peer(7) } })
    releaseFocus('node-a')
    expect(api.calls.filter((c) => c[0] === 'focus')).toEqual([
      ['focus', 'node-a'],
      ['focus', null]
    ])
  })

  it('send only on change (a terminal re-focusing the same node, or a tab switch back, must not spam the wire)', async () => {
    vi.stubGlobal(
      'localStorage',
      memStorage({
        'nodeterm.presence.me': JSON.stringify({ name: 'Enes', color: PRESENCE_COLORS[1] })
      })
    )
    const api = fakePresenceApi()
    const { reportFocus, reportProject } = await withPeer()
    reportFocus('node-a')
    reportFocus('node-a')
    reportFocus(null)
    reportFocus(null)
    expect(api.calls.filter((c) => c[0] === 'focus')).toEqual([
      ['focus', 'node-a'],
      ['focus', null]
    ])

    reportProject('web')
    reportProject('web')
    reportProject('api')
    reportProject(null)
    expect(api.calls.filter((c) => c[0] === 'project')).toEqual([
      ['project', 'web'],
      ['project', 'api'],
      ['project', null]
    ])
  })

  it('releaseFocus only clears the focus THIS node published (a leaving node cannot steal the next one)', async () => {
    vi.stubGlobal('localStorage', memStorage(STORED_ME))
    const api = fakePresenceApi()
    const { reportFocus, releaseFocus } = await withPeer()

    reportFocus('node-a')
    // node-b took over (its dwell fired before node-a's unmount cleanup ran) — node-a going away
    // must NOT report "nobody is focused", which would blank the chips on node-b.
    reportFocus('node-b')
    releaseFocus('node-a')
    expect(api.calls.filter((c) => c[0] === 'focus')).toEqual([
      ['focus', 'node-a'],
      ['focus', 'node-b']
    ])

    // The node we ARE focused on leaving does clear it.
    releaseFocus('node-b')
    expect(api.calls.filter((c) => c[0] === 'focus')).toEqual([
      ['focus', 'node-a'],
      ['focus', 'node-b'],
      ['focus', null]
    ])
  })
})

describe('selectFocusedFaces: the alone / disconnected fast path', () => {
  // This selector runs once PER MOUNTED NODE on EVERY store write — 40 nodes x 5 peers x 20 Hz is
  // ~4k runs/s, each allocating a filtered array and a mapped one for a canvas that, most of the
  // time, has nobody else on it. When there is provably no one to draw, bail out to ONE shared
  // empty array (also stable identity → useShallow bails out too).
  it('returns the SAME empty array while I am alone, or while myId is unknown', async () => {
    vi.stubGlobal('localStorage', memStorage(STORED_ME))
    const api = fakePresenceApi({ clientId: 7, peers: [peer(7, { projectId: 'web' })] })
    const { connectPresence, usePresence, selectFocusedFaces } = await import('./presence')

    // Before hello resolves: myId is null, so nothing may be drawn at all.
    const empty = selectFocusedFaces(usePresence.getState(), 'node-a', 'web')
    expect(empty).toEqual([])

    const stop = connectPresence()
    await vi.waitFor(() => expect(usePresence.getState().myId).toBe(7))

    // Connected, but the table holds only me → still nobody to chip, same array object.
    const alone = selectFocusedFaces(usePresence.getState(), 'node-a', 'web')
    expect(alone).toBe(empty)

    // A peer arrives → the selector does its real work again.
    api.emitPeer({ op: 'join', peer: peer(8, { name: 'Ada', projectId: 'web', focus: 'node-a' }) })
    const faces = selectFocusedFaces(usePresence.getState(), 'node-a', 'web')
    expect(faces.map((f) => f.name)).toEqual(['Ada'])

    // …and when they leave, back to the shared empty array.
    api.emitPeer({ op: 'leave', clientId: 8 })
    expect(selectFocusedFaces(usePresence.getState(), 'node-a', 'web')).toBe(empty)
    stop()
  })

  // The fast path must mean "nobody ELSE to draw", not "fewer than two rows in the table". Our own
  // peer is normally one of those rows — but it need not be (a client that dropped mid-handshake,
  // a hub that answered hello before the join diff landed). A table holding exactly ONE peer, and
  // that peer a REAL teammate, must still chip: the Facepile shows them either way, and the two
  // surfaces must never disagree about who is here.
  it('still chips a lone real peer when my own row is missing from the table', async () => {
    vi.stubGlobal('localStorage', memStorage(STORED_ME))
    const api = fakePresenceApi({ clientId: 7, peers: [] }) // hello answers, but I am not in it
    const { connectPresence, usePresence, selectFocusedFaces, selectFaces } = await import(
      './presence'
    )
    const stop = connectPresence()
    await vi.waitFor(() => expect(usePresence.getState().myId).toBe(7))

    api.emitPeer({ op: 'join', peer: peer(8, { name: 'Ada', projectId: 'web', focus: 'node-a' }) })
    expect(selectFaces(usePresence.getState()).map((f) => f.name)).toEqual(['Ada'])
    expect(selectFocusedFaces(usePresence.getState(), 'node-a', 'web').map((f) => f.name)).toEqual([
      'Ada'
    ])
    stop()
  })
})

describe('selectFocusedFaces (the node-header chips — one per node, so cursor traffic must not re-render them)', () => {
  it('projects the focused peers of THIS project and keeps object identity across cursor updates', async () => {
    vi.stubGlobal('localStorage', memStorage(STORED_ME))
    const api = fakePresenceApi({ clientId: 7, peers: [peer(7, { projectId: 'web' })] })
    const { connectPresence, usePresence, selectFocusedFaces } = await import('./presence')
    const stop = connectPresence()
    await vi.waitFor(() => expect(usePresence.getState().myId).toBe(7))

    api.emitPeer({ op: 'join', peer: peer(8, { name: 'Ada', projectId: 'web', focus: 'node-a' }) })
    // Same node id, ANOTHER project: node ids are globally unique, so without the project filter
    // this peer would chip node-a's header on my canvas.
    api.emitPeer({ op: 'join', peer: peer(9, { name: 'Bo', projectId: 'api', focus: 'node-a' }) })

    const before = selectFocusedFaces(usePresence.getState(), 'node-a', 'web')
    expect(before.map((f) => f.name)).toEqual(['Ada'])
    expect(selectFocusedFaces(usePresence.getState(), 'node-b', 'web')).toEqual([])

    // A cursor patch replaces the whole PeerState object (~20/s). The projected face must stay the
    // SAME object, so useShallow bails out and the chips do not re-render at cursor rate.
    api.emitPeer({ op: 'update', clientId: 8, patch: { cursor: { x: 1, y: 2 } } })
    const after = selectFocusedFaces(usePresence.getState(), 'node-a', 'web')
    expect(after[0]).toBe(before[0])

    // Something the chip actually shows changes → a new object (the chip updates).
    api.emitPeer({ op: 'update', clientId: 8, patch: { name: 'Ada L.' } })
    expect(selectFocusedFaces(usePresence.getState(), 'node-a', 'web')[0]).not.toBe(before[0])

    // Focus moves → the chip moves with it.
    api.emitPeer({ op: 'update', clientId: 8, patch: { focus: 'node-b' } })
    expect(selectFocusedFaces(usePresence.getState(), 'node-a', 'web')).toEqual([])
    expect(selectFocusedFaces(usePresence.getState(), 'node-b', 'web').map((f) => f.clientId)).toEqual([8])
    stop()
  })
})

describe('selectDino (the spectator picks THE authority broadcasting for a node)', () => {
  it('returns the peer broadcasting for this node, excludes self and other node ids, tiebreaks on lowest clientId', async () => {
    vi.stubGlobal('localStorage', memStorage(STORED_ME))
    const api = fakePresenceApi({ clientId: 7, peers: [peer(7)] })
    const { connectPresence, usePresence, selectDino } = await import('./presence')
    const stop = connectPresence()
    await vi.waitFor(() => expect(usePresence.getState().myId).toBe(7))

    // Nobody broadcasting yet → null.
    expect(selectDino(usePresence.getState(), 'dino-a')).toBeNull()

    // A peer becomes the authority for dino-a → we spectate them.
    api.emitPeer({ op: 'join', peer: peer(8, { dino: { nodeId: 'dino-a', snap: snap() } }) })
    expect(selectDino(usePresence.getState(), 'dino-a')?.clientId).toBe(8)

    // A peer broadcasting for a DIFFERENT node must not be picked for dino-a.
    api.emitPeer({ op: 'join', peer: peer(9, { dino: { nodeId: 'dino-b', snap: snap() } }) })
    expect(selectDino(usePresence.getState(), 'dino-a')?.clientId).toBe(8)
    expect(selectDino(usePresence.getState(), 'dino-b')?.clientId).toBe(9)

    // Take-over race: two peers broadcast for dino-a at once → lowest clientId wins.
    api.emitPeer({ op: 'join', peer: peer(5, { dino: { nodeId: 'dino-a', snap: snap() } }) })
    expect(selectDino(usePresence.getState(), 'dino-a')?.clientId).toBe(5)

    stop()
  })

  it('never returns my OWN broadcast, even if I am the authority for the node', async () => {
    vi.stubGlobal('localStorage', memStorage(STORED_ME))
    // My own peer (id 7) is broadcasting for dino-a in the table — I must not spectate myself.
    fakePresenceApi({
      clientId: 7,
      peers: [peer(7, { dino: { nodeId: 'dino-a', snap: snap() } })]
    })
    const { connectPresence, usePresence, selectDino } = await import('./presence')
    const stop = connectPresence()
    await vi.waitFor(() => expect(usePresence.getState().myId).toBe(7))

    expect(selectDino(usePresence.getState(), 'dino-a')).toBeNull()
    stop()
  })
})

describe('session.dino (casts the live snapshot on the api)', () => {
  it('publishes a snapshot only when a peer is watching, but ALWAYS sends the clearing null', async () => {
    vi.stubGlobal('localStorage', memStorage(STORED_ME))
    const api = fakePresenceApi()
    const { defaultPresence, usePresence } = await import('./presence')
    const payload = { nodeId: 'dino-a', snap: snap({ score: 42 }) }

    // Alone: a solo player's ~20 Hz snapshot casts are FREE — skipped (like reportFocus). But the
    // stop (null) still lands (an edge; and it costs nothing) so a spectator can never be stranded.
    usePresence.setState({ myId: 7, peers: { 7: peer(7) } }) // just me
    defaultPresence.dino(payload)
    defaultPresence.dino(null)
    expect(api.calls.filter((c) => c[0] === 'dino')).toEqual([['dino', null]])

    // A peer shows up: the snapshot publishes, and its clearing null with it.
    usePresence.setState({ peers: { 7: peer(7), 8: peer(8) } })
    defaultPresence.dino(payload)
    defaultPresence.dino(null)
    expect(api.calls.filter((c) => c[0] === 'dino')).toEqual([
      ['dino', null],
      ['dino', payload],
      ['dino', null]
    ])
  })
})
