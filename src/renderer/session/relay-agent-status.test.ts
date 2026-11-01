// A relay session's own agent-status subscription (bug D), run against REAL stores: a fresh keyless
// agent-status session per test, fed through a fake api whose `onAgentStatus` keeps the listener so
// the test can fire the host's events at it.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NormalizedAgentEvent } from '@shared/agents/normalize'
import type { NodeTerminalApi } from '@shared/types'
import type { AgentStatusSnapshotEntry } from '@shared/agent-status-snapshot'
import { createAgentStatusSession, STALE_WORKING_MS, type AgentNodeStatus } from '../state/agentStatus'
import { applyAgentEvent } from '../state/applyAgentEvent'
import { useAgentNodes } from '../state/agentNodes'
import { playSfx } from '../lib/sfx'
import { applyAgentStatusSnapshot, isHostNodeId, wireRelayAgentStatus } from './relay-agent-status'

// The chime is an interrupt the relay path must never raise. The wiring does not import it; the
// spy makes a future import that plays it fail here.
vi.mock('../lib/sfx', () => ({ playSfx: vi.fn() }))

const N = 'term-node-a'

const ev = (over: Partial<NormalizedAgentEvent> = {}): NormalizedAgentEvent => ({
  nodeId: N,
  agentId: 'claude',
  kind: 'state',
  ...over
})

const working = ev({ state: 'working', newTurn: true, task: 'hello', sessionId: 's1' })
const doneEvent = ev({ state: 'done', lastMessage: 'all green' })

/** A relay api with the two members the wiring uses: `onAgentStatus` keeps the listener and hands
 *  back a spy; `agentStatusSnapshot` returns a promise the test settles (`resolve` / `reject`).
 *  `order` records the calls, so the test can see the subscription comes first. */
function fakeApi() {
  let cb: ((e: NormalizedAgentEvent) => void) | null = null
  const unsub = vi.fn()
  const order: string[] = []
  let settle: { resolve: (v: AgentStatusSnapshotEntry[]) => void; reject: (e: unknown) => void } | null = null
  const api: Pick<NodeTerminalApi, 'onAgentStatus' | 'agentStatusSnapshot'> = {
    onAgentStatus: vi.fn((listener: (e: NormalizedAgentEvent) => void) => {
      order.push('subscribe')
      cb = listener
      return unsub
    }),
    agentStatusSnapshot: vi.fn(() => {
      order.push('snapshot')
      return new Promise<AgentStatusSnapshotEntry[]>((resolve, reject) => {
        settle = { resolve, reject }
      })
    })
  }
  const fire = (e: NormalizedAgentEvent): void => {
    if (!cb) throw new Error('nothing subscribed')
    cb(e)
  }
  const resolve = (entries: AgentStatusSnapshotEntry[]): void => {
    if (!settle) throw new Error('no snapshot was asked for')
    settle.resolve(entries)
  }
  const reject = (err: unknown): void => {
    if (!settle) throw new Error('no snapshot was asked for')
    settle.reject(err)
  }
  return { api, unsub, fire, order, resolve, reject }
}

/** Let a settled snapshot promise run its handlers. */
const flush = async (): Promise<void> => {
  await Promise.resolve()
  await Promise.resolve()
}

let status: ReturnType<typeof createAgentStatusSession>
const entry = (id = N) => status.store.getState().byId[id]

beforeEach(() => {
  status = createAgentStatusSession(undefined)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('wireRelayAgentStatus', () => {
  it('an event lands in the session store through applyAgentEvent', () => {
    const { api, fire } = fakeApi()
    const stop = wireRelayAgentStatus(api, status, { hasFocus: () => false })
    expect(api.onAgentStatus).toHaveBeenCalledTimes(1)
    fire(working)
    expect(entry()?.state).toBe('working')
    expect(entry()?.agentId).toBe('claude')
    expect(entry()?.sessionId).toBe('s1')
    // The account the hook names is another machine's (the host's), so it is recorded as remote.
    fire(ev({ state: 'working', account: { configDir: '/home/u/.claude', accountId: null, known: false } }))
    expect(entry()?.account?.remote).toBe(true)
    stop()
  })

  it('a finish marks unread when the window is not focused on that node', () => {
    const { api, fire } = fakeApi()
    const stop = wireRelayAgentStatus(api, status, { hasFocus: () => false })
    // Active in this store, but the window has no focus: still unread (Canvas's `watching` rule).
    status.store.getState().setActive(N, true)
    fire(working)
    fire(doneEvent)
    const unread = entry()?.unread
    expect(entry()?.state).toBe('done')
    expect(unread).toBe(true)
    // Focused, but on ANOTHER node: a needs-input on this one is unread too.
    const focused = createAgentStatusSession(undefined)
    const other = fakeApi()
    const stopOther = wireRelayAgentStatus(other.api, focused, { hasFocus: () => true })
    focused.store.getState().setActive('term-node-b', true)
    other.fire(ev({ state: 'blocked', pendingId: 'p-1' }))
    expect(focused.store.getState().byId[N]?.unread).toBe(true)
    stop()
    stopOther()
  })

  it('a finish on the focused active node stays read', () => {
    const { api, fire } = fakeApi()
    const stop = wireRelayAgentStatus(api, status, { hasFocus: () => true })
    status.store.getState().setActive(N, true)
    fire(working)
    fire(doneEvent)
    expect(entry()?.state).toBe('done')
    expect(entry()?.unread).toBe(false)
    stop()
  })

  it('never acks, sounds or notifies', () => {
    const ackSpy = vi.fn()
    const local = { ackDone: vi.fn(), notify: vi.fn() }
    vi.stubGlobal('window', { nodeTerminal: local })
    status = createAgentStatusSession(undefined, ackSpy)
    const { api, fire } = fakeApi()
    // Focused on the node: the branch where Canvas acks a watched finish.
    const stop = wireRelayAgentStatus(api, status, { hasFocus: () => true })
    status.store.getState().setActive(N, true)
    fire(working)
    fire(ev({ state: 'blocked', pendingId: 'p-1' }))
    fire(ev({ state: 'working' }))
    fire(doneEvent)
    // And unfocused: the branch where Canvas chimes and notifies.
    status.store.getState().setActive(N, false)
    fire(ev({ state: 'working', newTurn: true }))
    fire(doneEvent)
    expect(entry()?.unread).toBe(true)
    expect(ackSpy).not.toHaveBeenCalled()
    expect(local.ackDone).not.toHaveBeenCalled()
    expect(local.notify).not.toHaveBeenCalled()
    expect(playSfx).not.toHaveBeenCalled()
    // Reading it is the store's own business: the wiring adds no ack of its own and nothing reaches
    // the local api. (The store's ack callback itself is what agentStatusForApi leaves out for a
    // relay api — see agentStatus-session.test.ts.)
    status.store.getState().clearUnread(N)
    expect(entry()?.unread).toBe(false)
    expect(ackSpy).toHaveBeenCalledTimes(1) // the store's own, from clearUnread — none from the wiring
    expect(local.ackDone).not.toHaveBeenCalled()
    expect(local.notify).not.toHaveBeenCalled()
    stop()
  })

  it('teardown unsubscribes, clears the store, and ignores late events', () => {
    const { api, unsub, fire } = fakeApi()
    const stop = wireRelayAgentStatus(api, status, { hasFocus: () => false })
    status.store.getState().setActive(N, true)
    fire(working)
    fire(doneEvent)
    expect(entry()?.unread).toBe(true)
    stop()
    expect(unsub).toHaveBeenCalledTimes(1)
    expect(status.store.getState().byId).toEqual({})
    expect(status.store.getState().activeId).toBeNull()
    // A late frame (the RpcClient delivered it after the drop) writes nothing.
    fire(doneEvent)
    expect(status.store.getState().byId).toEqual({})
    // A second teardown is a no-op.
    stop()
    expect(unsub).toHaveBeenCalledTimes(1)
  })

  it('the stale-working sweep runs on the session store', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-01T10:00:00Z'))
    const { api, fire } = fakeApi()
    const stop = wireRelayAgentStatus(api, status, { hasFocus: () => false, sweepMs: 1000 })
    fire(working)
    vi.setSystemTime(Date.now() + STALE_WORKING_MS + 1)
    // Nothing has swept yet: the decay below is the interval's.
    expect(entry()?.state).toBe('working')
    vi.advanceTimersByTime(1000)
    expect(entry()?.state).toBeUndefined()
    stop()
    // The interval is released with the subscription.
    expect(vi.getTimerCount()).toBe(0)
  })

  it('the same events yield the same state as the Canvas path', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-01T10:00:00Z'))
    useAgentNodes.setState({
      byId: {},
      activityById: {},
      lastActivityAt: {},
      positions: {},
      sizes: {},
      expanded: {},
      selectedId: null,
      autoHideFinished: false
    })
    const account = { configDir: '/home/u/.claude', accountId: null, known: false }
    const events: NormalizedAgentEvent[] = [
      ev({ state: 'working', newTurn: true, task: 'hello', sessionId: 's1', account }), // prompt
      ev({ state: 'working', sessionId: 's1' }), // tool
      ev({ state: 'blocked', pendingId: 'p-1', sessionId: 's1' }), // permission request
      ev({ state: 'working', sessionId: 's1' }), // approved, the turn resumes
      ev({ state: 'done', lastMessage: 'first turn done', sessionId: 's1' }),
      ev({ state: 'working', newTurn: true, task: '/loop 5m check the build', sessionId: 's1' }),
      ev({ state: 'done', lastMessage: 'build green', sessionId: 's1' }),
      ev({ kind: 'session', sessionPhase: 'end', sessionId: 's1' })
    ]
    // A: the Canvas listener's writes on an unfocused window — the reducer against the default-shaped
    // stores, then `markUnread` whenever it answered an alert (its `!watching` branch).
    const a = createAgentStatusSession(undefined)
    // B: the relay wiring, same window.
    const b = createAgentStatusSession(undefined)
    const { api, fire } = fakeApi()
    const stop = wireRelayAgentStatus(api, b, { hasFocus: () => false })
    for (const e of events) {
      const r = applyAgentEvent(a.store, useAgentNodes, e, { observationRemote: false })
      if (r.alert) a.store.getState().markUnread(r.nodeId)
      fire(e)
      vi.setSystemTime(Date.now() + 1000)
    }
    const A = a.store.getState()
    const B = b.store.getState()
    // The one designed difference: the relay records every observed account as another machine's.
    expect(A.byId[N]?.account?.remote).toBe(false)
    expect(B.byId[N]?.account?.remote).toBe(true)
    expect(stripAccountRemote(B.byId)).toEqual(stripAccountRemote(A.byId))
    // The sequence exercised what it claims to: a recorded unread, a loop, and the session end.
    expect(B.byId[N]?.unread).toBe(true)
    expect(B.byId[N]?.sessionEnded).toBe(true)
    stop()
  })
})

describe('wireRelayAgentStatus — the snapshot a late joiner starts from', () => {
  const byIdOf = () => status.store.getState().byId
  const doneFor = (nodeId: string): NormalizedAgentEvent => ev({ nodeId, state: 'done', lastMessage: 'ok' })

  it('asks for the snapshot after subscribing, and applies it', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-01T10:00:00Z'))
    const { api, order, resolve } = fakeApi()
    const stop = wireRelayAgentStatus(api, status, { hasFocus: () => false })
    expect(order).toEqual(['subscribe', 'snapshot'])
    resolve([{ nodeId: 'a', state: 'working', agentId: 'claude', sessionId: 's', ageMs: 5000 }])
    await flush()
    const byId = byIdOf()
    expect(byId.a.state).toBe('working')
    expect(byId.a.agentId).toBe('claude')
    expect(byId.a.sessionId).toBe('s')
    // The freshness clock is the host's age on this machine's clock; the transition clocks stay
    // unset: the joiner saw no transition, and a stamped one would claim it did.
    expect(byId.a.stateAt).toBe(Date.now() - 5000)
    expect(byId.a.lastEventAt).toBeUndefined()
    expect(byId.a.lastSeen).toBeUndefined()
    expect(byId.a.unread).toBe(false)
    stop()
  })

  it('a snapshot working survives the stale-working sweep', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-01T10:00:00Z'))
    const { api, resolve } = fakeApi()
    const stop = wireRelayAgentStatus(api, status, { hasFocus: () => false, sweepMs: 1000 })
    resolve([
      { nodeId: 'a', state: 'working', ageMs: 2000 },
      // The host has held this one quiet for longer than the window: the same decay a live event
      // that old would get.
      { nodeId: 'b', state: 'working', ageMs: STALE_WORKING_MS + 1 },
      // An age below zero is no age: the clock is never put ahead of this machine's.
      { nodeId: 'c', state: 'working', ageMs: -60_000 }
    ])
    await flush()
    const t0 = Date.now()
    expect(byIdOf().c.stateAt).toBe(t0)
    vi.advanceTimersByTime(1000)
    expect(byIdOf().a.state).toBe('working')
    expect(byIdOf().c.state).toBe('working')
    expect(byIdOf().b.state).toBeUndefined()
    stop()
  })

  it('a live event that lands before the snapshot is not overwritten by it', async () => {
    const { api, fire, resolve } = fakeApi()
    const stop = wireRelayAgentStatus(api, status, { hasFocus: () => false })
    const set = vi.spyOn(status.store, 'setState')
    fire(doneFor('a'))
    set.mockClear()
    resolve([
      { nodeId: 'a', state: 'working', sessionId: 'stale' },
      { nodeId: 'b', state: 'blocked', agentId: 'codex' }
    ])
    await flush()
    const byId = byIdOf()
    expect(byId.a.state).toBe('done')
    expect(byId.a.sessionId).toBeUndefined()
    expect(byId.a.unread).toBe(true) // the live finish's own mark, kept
    // The untouched node is written, and the whole snapshot is ONE store write.
    expect(byId.b.state).toBe('blocked')
    expect(set).toHaveBeenCalledTimes(1)
    stop()
  })

  it('an entry without state writes identity only', async () => {
    const { api, resolve } = fakeApi()
    const stop = wireRelayAgentStatus(api, status, { hasFocus: () => false })
    const account = { configDir: '/home/u/.claude-2', accountId: 'acc-2', known: true }
    // Already known here (unread, a session title) before the snapshot lands: the merge keeps it.
    status.store.setState({ byId: { a: { unread: true, session: 'kept title' } } })
    resolve([{ nodeId: 'a', agentId: 'claude', sessionId: 's-old', account }])
    await flush()
    const a = byIdOf().a
    expect(a.state).toBeUndefined()
    expect('state' in a).toBe(false)
    expect(a.stateAt).toBeUndefined() // no state, so no freshness clock for one
    expect(a.sessionId).toBe('s-old')
    expect(a.agentId).toBe('claude')
    // The host's account label is another machine's, exactly as a live relay event records it.
    expect(a.account).toEqual({ ...account, remote: true })
    expect(a.unread).toBe(true)
    expect(a.session).toBe('kept title')
    stop()
  })

  it('a snapshot that resolves after teardown writes nothing', async () => {
    const { api, resolve } = fakeApi()
    const stop = wireRelayAgentStatus(api, status, { hasFocus: () => false })
    stop()
    resolve([{ nodeId: 'a', state: 'working', agentId: 'claude' }])
    await flush()
    expect(byIdOf()).toEqual({})
  })

  it('a rejected snapshot is ignored', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { api, fire, reject } = fakeApi()
    const stop = wireRelayAgentStatus(api, status, { hasFocus: () => false })
    fire(working)
    const before = structuredClone(byIdOf())
    // An older host has no handler for the channel.
    reject(Object.assign(new Error('no handler for agent:status-snapshot'), { code: 'E_NO_HANDLER' }))
    await flush()
    expect(byIdOf()).toEqual(before)
    expect(warn).toHaveBeenCalledTimes(1)
    // A rejection that lands after teardown says nothing: the session is gone, not the host's handler.
    warn.mockClear()
    const late = fakeApi()
    const stopLate = wireRelayAgentStatus(late.api, status, { hasFocus: () => false })
    stopLate()
    late.reject(new Error('carrier closed'))
    await flush()
    expect(warn).not.toHaveBeenCalled()
    stop()
  })

  it('a replayed subagent start does not hold the node out of the snapshot', async () => {
    // onAgentStatus replays the host's running subagents into the same listener at subscribe time;
    // a subagent event carries no state, so it is no fresher evidence than the snapshot.
    const { api, fire, resolve } = fakeApi()
    const stop = wireRelayAgentStatus(api, status, { hasFocus: () => false })
    fire(ev({ nodeId: 'a', kind: 'subagent-start', toolUseId: 't-1', taskLabel: 'look around' }))
    resolve([{ nodeId: 'a', state: 'working', agentId: 'claude', sessionId: 's' }])
    await flush()
    expect(byIdOf().a.state).toBe('working')
    stop()
  })
})

describe('wireRelayAgentStatus — a host node id that names a prototype member', () => {
  // The fields a store write would put on the object a bare `byId[id]` lookup answers.
  const FIELDS = ['stateAt', 'lastSeen', 'stateVerified', 'sessionEnded', 'state', 'agentId', 'sessionId', 'unread']
  const PROTO_IDS = ['__proto__', 'constructor']
  // What `byId['__proto__']` / `byId['constructor']` answer with no own entry.
  const targets = (): object[] => [Object.prototype, Object]
  const polluted = (): string[] =>
    targets().flatMap((t) => FIELDS.filter((k) => Object.hasOwn(t, k)).map((k) => `${t === Object ? 'Object' : 'Object.prototype'}.${k}`))

  afterEach(() => {
    // A regression must fail THIS test, not every test that runs after it in the worker.
    for (const t of targets()) for (const k of FIELDS) delete (t as Record<string, unknown>)[k]
  })

  it('isHostNodeId accepts the ids the app mints and refuses prototype names and unsafe ids', () => {
    for (const ok of ['term-node-a', 'term-mh3k2x-12', '3f2a9c1e-7b4d-4e8a-9c0f-1a2b3c4d5e6f', 'a.b_c-d']) {
      expect(isHostNodeId(ok), ok).toBe(true)
    }
    for (const bad of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf', '', '.', '..', 'a b', 'a/b']) {
      expect(isHostNodeId(bad), bad).toBe(false)
    }
    for (const bad of [undefined, null, 42, {}]) expect(isHostNodeId(bad)).toBe(false)
  })

  it('a live event for __proto__ or constructor writes nothing and leaves the prototypes alone', () => {
    const { api, fire } = fakeApi()
    const stop = wireRelayAgentStatus(api, status, { hasFocus: () => false })
    fire(working) // a real node, so the table is not empty
    const before = status.store.getState().byId
    for (const nodeId of PROTO_IDS) {
      // The reviewer's frame: a session event with no agent id takes the store's same-state path.
      fire({ nodeId, kind: 'session', sessionPhase: 'end' } as NormalizedAgentEvent)
      fire({ nodeId, kind: 'session', sessionPhase: 'start', sessionTitle: 'x' } as NormalizedAgentEvent)
      fire(ev({ nodeId, state: 'working', newTurn: true, sessionId: 's-evil' }))
      fire(ev({ nodeId, state: 'done', lastMessage: 'ok' })) // would raise an alert, so a markUnread
      fire(ev({ nodeId, kind: 'background-task' }))
    }
    expect(polluted()).toEqual([])
    expect(Object.hasOwn(Object.prototype, 'stateAt')).toBe(false)
    expect(Object.hasOwn(Object.prototype, 'lastSeen')).toBe(false)
    expect(Object.hasOwn(Object.prototype, 'stateVerified')).toBe(false)
    const byId = status.store.getState().byId
    expect(byId).toBe(before) // not one store write
    for (const nodeId of PROTO_IDS) expect(Object.hasOwn(byId, nodeId), nodeId).toBe(false)
    expect(Object.keys(byId)).toEqual([N])
    stop()
  })

  it('a snapshot entry for __proto__ or constructor is skipped, and the rest is written', async () => {
    const { api, resolve } = fakeApi()
    const stop = wireRelayAgentStatus(api, status, { hasFocus: () => false })
    resolve([
      { nodeId: '__proto__', state: 'working', agentId: 'claude', sessionId: 's-evil', ageMs: 1000 },
      { nodeId: 'constructor', state: 'blocked', agentId: 'codex' },
      { nodeId: 'a', state: 'working', agentId: 'claude' }
    ])
    await flush()
    const byId = status.store.getState().byId
    expect(Object.keys(byId)).toEqual(['a'])
    for (const nodeId of PROTO_IDS) expect(Object.hasOwn(byId, nodeId), nodeId).toBe(false)
    expect(polluted()).toEqual([])
    stop()
    // The applier on its own says how many it wrote: the two refused entries are not counted.
    const other = createAgentStatusSession(undefined)
    const wrote = applyAgentStatusSnapshot(
      other.store,
      [{ nodeId: '__proto__', state: 'done' }, { nodeId: 'constructor' }, { nodeId: 'toString', state: 'working' }],
      new Set()
    )
    expect(wrote).toBe(0)
    expect(other.store.getState().byId).toEqual({})
    expect(polluted()).toEqual([])
  })
})

/** The byId table with only `account.remote` removed — everything else must match exactly. */
function stripAccountRemote(byId: Record<string, AgentNodeStatus>): Record<string, AgentNodeStatus> {
  const out: Record<string, AgentNodeStatus> = {}
  for (const [id, v] of Object.entries(byId)) {
    if (!v.account) {
      out[id] = v
      continue
    }
    const { remote: _remote, ...account } = v.account
    out[id] = { ...v, account }
  }
  return out
}
