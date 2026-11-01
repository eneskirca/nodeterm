// A relay session's own agent-status subscription (bug D), run against REAL stores: a fresh keyless
// agent-status session per test, fed through a fake api whose `onAgentStatus` keeps the listener so
// the test can fire the host's events at it.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NormalizedAgentEvent } from '@shared/agents/normalize'
import type { NodeTerminalApi } from '@shared/types'
import { createAgentStatusSession, STALE_WORKING_MS, type AgentNodeStatus } from '../state/agentStatus'
import { applyAgentEvent } from '../state/applyAgentEvent'
import { useAgentNodes } from '../state/agentNodes'
import { playSfx } from '../lib/sfx'
import { wireRelayAgentStatus } from './relay-agent-status'

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

/** A relay api whose only member is `onAgentStatus`: it keeps the listener and hands back a spy. */
function fakeApi() {
  let cb: ((e: NormalizedAgentEvent) => void) | null = null
  const unsub = vi.fn()
  const api: Pick<NodeTerminalApi, 'onAgentStatus'> = {
    onAgentStatus: vi.fn((listener: (e: NormalizedAgentEvent) => void) => {
      cb = listener
      return unsub
    })
  }
  const fire = (e: NormalizedAgentEvent): void => {
    if (!cb) throw new Error('nothing subscribed')
    cb(e)
  }
  return { api, unsub, fire }
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
