import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
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
    expect(useAgentStatus.getState().byId[id].state).toBeUndefined()
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
