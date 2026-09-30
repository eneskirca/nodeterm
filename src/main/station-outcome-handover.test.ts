/**
 * The "new task" rule for `--after-success`, end to end through the REAL messaging service and the
 * REAL delivery queue (`createDeliveryQueue`, the builder both shells use) — the path the review of
 * #1034 found wrong. The report used to be withdrawn when the control ANSWER returned; for a busy
 * station a `send` answers `queued` (ok: true) long before the message reaches the pane, so:
 *
 *   1. the orchestrator `send`s station S task B while S still works on A → queued, report withdrawn;
 *   2. the orchestrator opens D `--after-success S`;
 *   3. S finishes A and reports `succeeded`;
 *   4. S's turn ends → D fires on A's word; on the same idle edge the queue flushes B.
 *
 * Each test below replays one ordering with the shell's own post-answer step
 * (`clearOutcomesAfterControl`, which `finishAnswer` and the Server Edition's wrapper run), so it
 * fails on the answer-time rule and passes on the landing-time one.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createDeliveryQueue,
  deliverFromControl,
  onMessagingAgentEvent,
  type AgentMessagingDeps
} from '../core/agents/agent-messaging'
import { resetMessageFlow } from '../core/agents/agent-message-flow'
import { resetAgentMessageTraceForTests } from '../core/agents/agent-message-trace'
import { MANAGED_SCRIPT_REVISION } from '../core/agents/hooks/managed-script'
import type { MirrorEntry } from '../core/agent-status-mirror'
import { StationOutcomeStore, clearOutcomesAfterControl } from '../core/station-outcome-store'
import { successWaitSatisfied, type SuccessWaitHold } from '../shared/station-outcome'

const entry = (state: 'working' | 'done'): MirrorEntry => ({
  state,
  updatedAt: 1,
  stateVerified: true,
  clientRevision: MANAGED_SCRIPT_REVISION
})

interface Harness {
  deps: AgentMessagingDeps
  store: StationOutcomeStore
  setBusy(busy: boolean): void
  tick(ms: number): number
  sent: string[]
  /** Runs inside the pane write — a station that reports WHILE the delivery is still in flight. */
  duringWrite?: () => void
}

function harness(): Harness {
  let busy = true
  let clock = 1_000_000
  const sent: string[] = []
  const store = new StationOutcomeStore()
  const h: Harness = {
    store,
    sent,
    setBusy: (b) => {
      busy = b
    },
    tick: (ms) => (clock += ms),
    deps: undefined as unknown as AgentMessagingDeps
  }
  const projects = () => [
    { id: 'p1', nodes: [{ id: 'orch', title: 'Orchestrator', agentId: 'claude' }, { id: 'st', title: 'Station', agentId: 'claude' }] }
  ]
  h.deps = {
    paneOwner: async () => ({
      tty: '/dev/pts/9',
      panePid: 100,
      paneId: '%1',
      command: 'claude',
      argv: ['claude'],
      pids: [200]
    }),
    sendEnvelope: async (_nodeId, payload) => {
      sent.push(payload)
      h.duringWrite?.()
      return true
    },
    hasLiveSession: () => true,
    mirrorEntry: () => entry(busy ? 'working' : 'done'),
    projects,
    isRemoteNode: () => false,
    messagingEnabled: () => true,
    paneOwnerProject: () => 'p1',
    customAgents: () => undefined,
    appendBoardLog: async () => false,
    // Every write is confirmed by the station starting a verified turn → `delivered`.
    subscribeReceipts: (cb) => {
      const t = setTimeout(() => cb({ nodeId: 'st', newTurn: true, verified: true }), 1)
      return () => clearTimeout(t)
    },
    now: () => clock,
    // THE WIRING UNDER TEST — exactly what both shells assign.
    onHandover: (ev) => store.onHandover(ev)
  }
  return h
}

const send = { verb: 'send', sourceNodeId: 'orch', targetNodeId: 'st', body: 'task B' } as never
const sendArgs = { node: 'st', text: 'task B' }
/** D's wait, armed right after the hand-over, per the skill text's own advice. */
const hold: SuccessWaitHold = { deps: ['st'], deadlineAt: Number.MAX_SAFE_INTEGER }
/** Would D fire now? The station's turn is over (the idle edge the queue flushes on). */
const dFires = (store: StationOutcomeStore): boolean =>
  successWaitSatisfied(hold, (id) => ({ exists: true, turnDone: true, outcome: store.get(id) }), 0)

beforeEach(() => {
  resetMessageFlow()
  resetAgentMessageTraceForTests()
})

describe('a QUEUED send marks the station "work pending" — the reviewer\'s scenario', () => {
  it('the report S makes for the task it is still on does NOT release D; only the report after B lands does', async () => {
    const h = harness()
    const queue = createDeliveryQueue(h.deps, { schedule: () => () => {} })
    h.deps.queue = queue

    // 1. hand-over while S is busy on A → queued. The shell runs its post-answer step.
    const { outcome, reply } = await deliverFromControl(send, h.deps)
    expect(outcome.kind).toBe('queued')
    expect(reply.ok).toBe(true)
    clearOutcomesAfterControl(h.store, 'send', sendArgs, reply, 'orch')

    // 3. S finishes A and reports success — AFTER the hand-over, BEFORE B reached it.
    h.tick(100)
    h.store.record({ nodeId: 'st', outcome: 'succeeded', at: h.tick(0) })
    expect(h.store.get('st')?.workPending).toBe(true)
    // 4. S's turn ends: D must not fire on A's word.
    expect(dFires(h.store)).toBe(false)

    // The same idle edge flushes B into the pane.
    h.tick(100)
    h.setBusy(false)
    onMessagingAgentEvent({ nodeId: 'st', state: 'done', verified: true, newTurn: false } as never, queue)
    await vi.waitFor(() => expect(queue.depth('st')).toBe(0))
    await vi.waitFor(() => expect(h.sent).toHaveLength(1))
    // B landed: A's report is gone, the mark is dropped, and D still waits.
    await vi.waitFor(() => expect(h.store.get('st')).toBeUndefined())
    expect(dFires(h.store)).toBe(false)

    // S works on B and reports: now — and only now — D is released.
    h.tick(100)
    h.store.record({ nodeId: 'st', outcome: 'succeeded', at: h.tick(0) })
    expect(h.store.get('st')?.workPending).toBeUndefined()
    expect(dFires(h.store)).toBe(true)
  })

  it('a queued message that EXPIRES unread withdraws the report too — D never starts on A', async () => {
    const h = harness()
    let expire: (() => void) | null = null
    const queue = createDeliveryQueue(h.deps, {
      schedule: (_ms, fn) => {
        expire = fn
        return () => {
          expire = null
        }
      }
    })
    h.deps.queue = queue
    const { reply } = await deliverFromControl(send, h.deps)
    clearOutcomesAfterControl(h.store, 'send', sendArgs, reply, 'orch')
    h.tick(50)
    h.store.record({ nodeId: 'st', outcome: 'succeeded', at: h.tick(0) })
    expect(dFires(h.store)).toBe(false)
    expect(expire).toBeTruthy()
    expire!()
    await vi.waitFor(() => expect(h.store.get('st')).toBeUndefined())
    expect(dFires(h.store)).toBe(false)
    // Nothing is left pending: the station's next report counts at once.
    h.store.record({ nodeId: 'st', outcome: 'succeeded', at: h.tick(10) })
    expect(dFires(h.store)).toBe(true)
  })
})

describe('a report about the NEW work survives however late the answer comes back', () => {
  it('a direct delivery withdraws only reports older than the moment it STARTED', async () => {
    const h = harness()
    h.setBusy(false)
    // An old report from task A.
    h.store.record({ nodeId: 'st', outcome: 'failed', at: h.tick(0) - 10 })
    // While the delivery of B is still in flight (the settle-and-submit wait), S already reports
    // B — the "stalled / late answer" ordering.
    h.duringWrite = () => {
      h.store.record({ nodeId: 'st', outcome: 'succeeded', at: h.tick(50) })
    }
    const { outcome, reply } = await deliverFromControl(send, h.deps)
    expect(outcome.kind).toBe('delivered')
    // The shell's post-answer step, arriving after that report.
    h.tick(1_000)
    clearOutcomesAfterControl(h.store, 'send', sendArgs, reply, 'orch')
    expect(h.store.get('st')?.outcome).toBe('succeeded')
    expect(dFires(h.store)).toBe(true)
  })

  it('an old report is withdrawn when the delivery lands', async () => {
    const h = harness()
    h.setBusy(false)
    h.store.record({ nodeId: 'st', outcome: 'succeeded', at: h.tick(0) - 10 })
    await deliverFromControl(send, h.deps)
    expect(h.store.get('st')).toBeUndefined()
    expect(dFires(h.store)).toBe(false)
  })
})

describe('only a task handed through canvas control counts', () => {
  it('a board comment or a station notice reaching the pane does not withdraw a report', async () => {
    const h = harness()
    h.setBusy(false)
    h.store.record({ nodeId: 'st', outcome: 'succeeded', at: h.tick(0) - 10 })
    h.store.onHandover({ phase: 'landed', verb: 'board-comment', targetNodeId: 'st', at: h.tick(0) })
    h.store.onHandover({ phase: 'queued', verb: 'station-notice', targetNodeId: 'st' })
    expect(h.store.get('st')).toMatchObject({ outcome: 'succeeded' })
    expect(h.store.get('st')?.workPending).toBeUndefined()
  })
})
