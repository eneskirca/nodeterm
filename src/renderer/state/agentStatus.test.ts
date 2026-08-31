import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  useAgentStatus,
  createAgentStatusSession,
  inferInterruptAfterSettle,
  DONE_HOLDOFF_MS,
  STALE_WORKING_MS
} from './agentStatus'

let seq = 0
const nid = (): string => `node-${++seq}`

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('done-holdoff race guard', () => {
  // Claude Code runs hooks in parallel: the last PostToolUse's curl can land AFTER the
  // Stop's curl. Without a holdoff that late "working" resurrects a finished turn.
  it('ignores a non-newTurn working arriving right after done', () => {
    const id = nid()
    const s = useAgentStatus.getState()
    s.setState(id, 'working', 'claude')
    s.setState(id, 'done', 'claude')
    vi.advanceTimersByTime(1000)
    useAgentStatus.getState().setState(id, 'working', 'claude')
    expect(useAgentStatus.getState().byId[id].state).toBe('done')
  })

  it('a genuine new turn (newTurn) overrides the holdoff', () => {
    const id = nid()
    const s = useAgentStatus.getState()
    s.setState(id, 'done', 'claude')
    vi.advanceTimersByTime(1000)
    useAgentStatus.getState().setState(id, 'working', 'claude', true)
    expect(useAgentStatus.getState().byId[id].state).toBe('working')
  })

  it('working is accepted again once the holdoff has passed', () => {
    const id = nid()
    useAgentStatus.getState().setState(id, 'done', 'claude')
    vi.advanceTimersByTime(DONE_HOLDOFF_MS + 500)
    useAgentStatus.getState().setState(id, 'working', 'claude')
    expect(useAgentStatus.getState().byId[id].state).toBe('working')
  })
})

describe('stale-working sweeper', () => {
  it('clears a working entry whose last event is older than the stale threshold', () => {
    const id = nid()
    useAgentStatus.getState().setState(id, 'working', 'claude')
    vi.advanceTimersByTime(STALE_WORKING_MS + 60_000)
    useAgentStatus.getState().sweepStaleWorking()
    expect(useAgentStatus.getState().byId[id]).toMatchObject({
      state: undefined,
      lastEventAt: Date.now()
    })
  })

  it('keeps a working entry fresh as long as events keep arriving', () => {
    const id = nid()
    useAgentStatus.getState().setState(id, 'working', 'claude')
    // Repeated same-state events (each tool use) must refresh freshness.
    vi.advanceTimersByTime(STALE_WORKING_MS - 60_000)
    useAgentStatus.getState().setState(id, 'working', 'claude')
    vi.advanceTimersByTime(120_000)
    useAgentStatus.getState().sweepStaleWorking()
    expect(useAgentStatus.getState().byId[id].state).toBe('working')
  })

  it('never touches done/waiting entries', () => {
    const a = nid()
    const b = nid()
    useAgentStatus.getState().setState(a, 'done', 'claude')
    useAgentStatus.getState().setState(b, 'waiting', 'claude')
    vi.advanceTimersByTime(STALE_WORKING_MS * 2)
    useAgentStatus.getState().sweepStaleWorking()
    expect(useAgentStatus.getState().byId[a].state).toBe('done')
    expect(useAgentStatus.getState().byId[b].state).toBe('waiting')
  })

  it('never decays a display-only restored working state', () => {
    const { store } = createAgentStatusSession()
    store.getState().hydrateSnapshot({
      n1: { state: 'working', agentId: 'claude', changedAt: Date.now() - STALE_WORKING_MS * 2 }
    })
    store.getState().sweepStaleWorking()
    expect(store.getState().byId.n1).toMatchObject({ state: 'working', restored: true })
  })
})

describe('restart snapshot hydration', () => {
  it('restores workflow context without changing durable read state', () => {
    const acked: string[] = []
    const { store } = createAgentStatusSession(undefined, (id) => acked.push(id))
    store.getState().markUnread('n1')

    store.getState().hydrateSnapshot({
      n1: { state: 'done', agentId: 'claude', sessionId: 's1', changedAt: 123 }
    })

    expect(store.getState().byId.n1).toMatchObject({
      state: 'done',
      restored: true,
      lastEventAt: 123,
      unread: true,
      stateVerified: false
    })
    expect(acked).toEqual([])
  })

  it('a live same-state event replaces restored provenance and stamps a live clock', () => {
    const { store } = createAgentStatusSession()
    store.getState().hydrateSnapshot({ n1: { state: 'done', changedAt: 123 } })
    store.getState().setState('n1', 'done', 'claude')
    expect(store.getState().byId.n1.restored).toBeUndefined()
    expect(store.getState().byId.n1.stateAt).toBe(Date.now())
    expect(store.getState().byId.n1.lastEventAt).toBe(Date.now())
  })

  it('a late snapshot never rewinds state already observed live', () => {
    const { store } = createAgentStatusSession()
    store.getState().setState('n1', 'working', 'claude')
    store.getState().hydrateSnapshot({ n1: { state: 'done', changedAt: 123 } })
    expect(store.getState().byId.n1).toMatchObject({ state: 'working' })
    expect(store.getState().byId.n1.restored).toBeUndefined()
  })

  it('preserves same-conversation completion through a process restart as display-only', () => {
    const { store } = createAgentStatusSession()
    store.getState().hydrateSnapshot({
      n1: { state: 'done', agentId: 'claude', sessionId: 's1', changedAt: 123 }
    })
    store.getState().setSessionBoundary('n1', 'start', 'claude', 's1')
    expect(store.getState().byId.n1).toMatchObject({
      state: 'done',
      restored: true,
      lastEventAt: 123,
      sessionId: 's1'
    })
  })

  it('makes a new session or a mid-turn session end Unknown', () => {
    const { store } = createAgentStatusSession()
    store.getState().hydrateSnapshot({
      n1: { state: 'working', agentId: 'claude', sessionId: 's1', changedAt: 123 },
      n2: { state: 'done', agentId: 'claude', sessionId: 's1', changedAt: 123 }
    })
    store.getState().setSessionBoundary('n1', 'end', 'claude', 's1')
    store.getState().setSessionBoundary('n2', 'start', 'claude', 's2')
    expect(store.getState().byId.n1).toMatchObject({ state: undefined, restored: true })
    expect(store.getState().byId.n2).toMatchObject({
      state: undefined,
      restored: true,
      sessionId: 's2'
    })
  })
})

describe('focus tracking', () => {
  it('switches the watched node without changing either session state', () => {
    const left = nid()
    const right = nid()
    const status = useAgentStatus.getState()
    status.setState(left, 'done', 'claude')
    status.setState(right, 'working', 'claude')
    status.setActive(left, true)
    status.setActive(right, true)

    expect(useAgentStatus.getState().activeId).toBe(right)
    expect(useAgentStatus.getState().byId[left].state).toBe('done')
    expect(useAgentStatus.getState().byId[right].state).toBe('working')
  })
})

describe('interrupt inference (Esc/Ctrl-C with no final hook)', () => {
  it('flips a still-working node to done after the settle window', () => {
    const id = nid()
    useAgentStatus.getState().setState(id, 'working', 'claude')
    inferInterruptAfterSettle(id, 1500)
    vi.advanceTimersByTime(1500)
    expect(useAgentStatus.getState().byId[id].state).toBe('done')
  })

  it('aborts when any hook event lands during the settle window (agent still alive)', () => {
    const id = nid()
    useAgentStatus.getState().setState(id, 'working', 'claude')
    inferInterruptAfterSettle(id, 1500)
    vi.advanceTimersByTime(700)
    useAgentStatus.getState().setState(id, 'working', 'claude') // e.g. next PreToolUse
    vi.advanceTimersByTime(800)
    expect(useAgentStatus.getState().byId[id].state).toBe('working')
  })

  it('is a no-op when the node is not working (Esc at an idle prompt)', () => {
    const id = nid()
    useAgentStatus.getState().setState(id, 'done', 'claude')
    inferInterruptAfterSettle(id, 1500)
    vi.advanceTimersByTime(1500)
    expect(useAgentStatus.getState().byId[id].state).toBe('done')
  })
})

describe('background-task stamp (Eco / bulk-restart guard)', () => {
  it('markBackgroundTask stamps, and a non-working transition never clears it', () => {
    const id = nid()
    const s = useAgentStatus.getState()
    s.setState(id, 'done', 'claude')
    s.markBackgroundTask(id)
    expect(useAgentStatus.getState().byId[id]?.backgroundTaskAt).toBeTypeOf('number')
    // done → waiting is a transition, but the task is still running: the guard must hold.
    s.setState(id, 'waiting', 'claude')
    expect(useAgentStatus.getState().byId[id]?.backgroundTaskAt).toBeTypeOf('number')
  })

  // Only a turn START — a `working` arriving from `done` — clears the stamp. Everything else keeps
  // it. blocked/waiting → working is a MID-TURN RESUMPTION (the same turn picking back up; see the
  // approval walk-through below), and an UNKNOWN previous state is not evidence of a turn start
  // at all: it is what a renderer reload or the stale-working sweeper leaves behind MID-TURN, so
  // clearing there would delete the stamp for a task that is still running.
  it('clears only on a turn start (done → working), never on a resumption or from an unknown state', () => {
    for (const { from, cleared } of [
      { from: 'blocked' as const, cleared: false },
      { from: 'waiting' as const, cleared: false },
      { from: undefined, cleared: false },
      { from: 'done' as const, cleared: true }
    ]) {
      const id = nid()
      const s = useAgentStatus.getState()
      if (from) s.setState(id, from, 'claude')
      s.markBackgroundTask(id)
      // A `done` predecessor needs the holdoff to lapse, or the working event is dropped whole.
      if (from === 'done') vi.advanceTimersByTime(DONE_HOLDOFF_MS + 500)
      useAgentStatus.getState().setState(id, 'working', 'claude')
      const label = String(from)
      expect(useAgentStatus.getState().byId[id].state, label).toBe('working')
      const stamp = useAgentStatus.getState().byId[id].backgroundTaskAt
      if (cleared) expect(stamp, label).toBeUndefined()
      else expect(stamp, label).toBeTypeOf('number')
    }
  })

  // The scenario the predicate exists for: a background Bash whose command needs approval runs
  // UserPromptSubmit(working) → PreToolUse(stamp) → PermissionRequest(blocked) → approve →
  // PostToolUse(working). That last edge IS a transition, and clearing on it would drop the guard
  // milliseconds after the stamp was set, while the task runs on.
  it('a background task that needed approval keeps its stamp across the approve edge', () => {
    const id = nid()
    const s = useAgentStatus.getState()
    s.setState(id, 'working', 'claude', true) // UserPromptSubmit — the turn starts
    s.markBackgroundTask(id) // PreToolUse Bash, run_in_background
    s.setState(id, 'blocked', 'claude') // PermissionRequest
    s.setState(id, 'working', 'claude') // approved, the turn resumes
    expect(useAgentStatus.getState().byId[id].backgroundTaskAt).toBeTypeOf('number')
  })

  it('stamps a node with no entry yet (the task can precede any state event)', () => {
    const id = nid()
    useAgentStatus.getState().markBackgroundTask(id)
    expect(useAgentStatus.getState().byId[id]?.backgroundTaskAt).toBeTypeOf('number')
    expect(useAgentStatus.getState().byId[id]?.unread).toBe(false)
  })
})

describe('clearUnread — cross-surface ack vs. external (host-driven) clear', () => {
  it('a normal clear of a done+unread node ACKs the read (dismisses the phone activity)', () => {
    const acked: string[] = []
    const { store } = createAgentStatusSession(undefined, (id) => acked.push(id))
    const id = 'nt-1'
    store.getState().setState(id, 'done', 'claude')
    store.getState().markUnread(id)
    store.getState().clearUnread(id)
    expect(store.getState().byId[id].unread).toBe(false)
    expect(acked).toEqual(['nt-1'])
  })

  it('an EXTERNAL clear (driven by a swept phone read-ack) does NOT re-ack — no loop', () => {
    const acked: string[] = []
    const { store } = createAgentStatusSession(undefined, (id) => acked.push(id))
    const id = 'nt-2'
    store.getState().setState(id, 'done', 'claude')
    store.getState().markUnread(id)
    store.getState().clearUnread(id, { external: true })
    expect(store.getState().byId[id].unread).toBe(false)
    // The ack already happened phone-side; re-acking here would loop host→renderer→ackDone.
    expect(acked).toEqual([])
  })

  it('acks a done with NO unread flag — the session the user watched finish', () => {
    const acked: string[] = []
    const { store } = createAgentStatusSession(undefined, (id) => acked.push(id))
    const id = 'nt-watched'
    // Watching the node when it finished means markUnread was skipped, so opening it is the only
    // read signal there will ever be. Without this ack the notch blob / phone activity kept glowing.
    store.getState().setState(id, 'done', 'claude')
    store.getState().clearUnread(id)
    expect(acked).toEqual(['nt-watched'])
    expect(store.getState().byId[id].unread).toBeFalsy()
  })

  it('acks even while the node is WORKING — a previous turn may still be unread', () => {
    const acked: string[] = []
    const { store } = createAgentStatusSession(undefined, (id) => acked.push(id))
    const id = 'nt-3'
    // The user opens a node whose last turn finished while a NEW turn is already running. That
    // finish is on screen, so it is read; the mirror no-ops if there is nothing pending, and it
    // only ever resolves `done` events, so a live approval is untouched.
    store.getState().setState(id, 'working', 'claude')
    store.getState().markUnread(id)
    store.getState().clearUnread(id)
    expect(acked).toEqual(['nt-3'])
  })

  it('an EXTERNAL clear still never acks, whatever the state', () => {
    const acked: string[] = []
    const { store } = createAgentStatusSession(undefined, (id) => acked.push(id))
    const id = 'nt-4'
    store.getState().setState(id, 'working', 'claude')
    store.getState().markUnread(id)
    store.getState().clearUnread(id, { external: true })
    expect(acked).toEqual([])
  })
})

describe('the verified evidence for a transition', () => {
  it('setState records it', () => {
    const s = useAgentStatus.getState()
    const id = nid()
    s.setState(id, 'done', 'claude', false, undefined, true)
    expect(useAgentStatus.getState().byId[id].stateVerified).toBe(true)
    s.setState(id, 'working', 'claude', true, undefined, false)
    expect(useAgentStatus.getState().byId[id].stateVerified).toBe(false)
  })

  it('an omitted argument is not proof (every existing call site keeps compiling, and lies about nothing)', () => {
    const id = nid()
    useAgentStatus.getState().setState(id, 'done', 'claude')
    expect(useAgentStatus.getState().byId[id].stateVerified).toBe(false)
  })

  it('Canvas hands the event\'s flag to the store — the drop this whole change exists to fix', () => {
    // A store field with no writer is the same bug in a new place, and this one is a plain
    // argument list: nothing else in the suite would notice if the last argument disappeared.
    const src = readFileSync(resolve(__dirname, '../../..', 'src/renderer/canvas/Canvas.tsx'), 'utf8')
    expect(src).toMatch(
      /cs\.setState\(\s*e\.nodeId,\s*e\.state,\s*e\.agentId,\s*e\.newTurn,\s*e\.pendingId,\s*e\.verified\s*\)/
    )
  })

  it('a same-state re-assert by a legacy POST drops the earlier proof', () => {
    // The same-state fast path refreshes in place instead of allocating; the evidence has to ride
    // along, or this copy would keep saying `verified` about a state a tokenless event re-asserted.
    const s = useAgentStatus.getState()
    const id = nid()
    s.setState(id, 'working', 'claude', true, undefined, true)
    s.setState(id, 'working', 'claude', false, undefined, false)
    expect(useAgentStatus.getState().byId[id].stateVerified).toBe(false)
  })

  it('stateVerified is TRANSIENT — never persisted', () => {
    // This suite runs under node, not jsdom, so the store's localStorage writes are swallowed by
    // its own try/catch. A minimal in-memory stub is what makes the durable whitelist observable
    // at all — without it this assertion would pass against ANY whitelist, including a broken one.
    const mem = new Map<string, string>()
    ;(globalThis as unknown as { localStorage: unknown }).localStorage = {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => void mem.set(k, v),
      removeItem: (k: string) => void mem.delete(k)
    }
    try {
      const KEY = 'nodeterm.agentStatus.verified-test'
      const { store } = createAgentStatusSession(KEY)
      const id = nid()
      // ORDER IS LOAD-BEARING, and the first draft of this test had it backwards. `setState` does
      // not itself call `save`, and `save` skips entries with no durable field — so writing the
      // blob BEFORE the verified transition produced a blob that could not contain `stateVerified`
      // whatever the whitelist said, and the assertion below passed against a whitelist that
      // included it. Set the flag first, then trigger a save with a durable write.
      store.getState().setState(id, 'done', 'claude', false, undefined, true)
      expect(store.getState().byId[id].stateVerified).toBe(true)
      store.getState().markUnread(id)
      const saved = JSON.parse(mem.get(KEY) ?? '{}')
      expect(saved[id]).toBeTruthy()
      expect(saved[id].unread).toBe(true)
      expect(saved[id].stateVerified).toBeUndefined()
    } finally {
      delete (globalThis as unknown as { localStorage?: unknown }).localStorage
    }
  })
})
