/**
 * Plain `--after` must not fire on a `done` from BEFORE new work was handed over — end to end, across
 * the layers that decide it: the REAL messaging service and delivery queue (`createDeliveryQueue`,
 * which both shells build) emit the hand-over events, core's tracker (src/core/station-handover.ts)
 * turns them and the station's agent events into "handed over", and the RENDERER's real launch
 * decision (`launchesToFire`) reads that list, exactly as Canvas passes it.
 *
 * The orchestrator's scenario: station S is reused. It hands S its next task B, then opens D
 * `--after S`. S still reads `done` from task A (or is still working on A and is about to go
 * `done`), so before this change D fired at once — on A's output, irreversibly.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createDeliveryQueue,
  deliverFromControl,
  onMessagingAgentEvent,
  type AgentMessagingDeps
} from '../../src/core/agents/agent-messaging'
import { resetMessageFlow } from '../../src/core/agents/agent-message-flow'
import { resetAgentMessageTraceForTests } from '../../src/core/agents/agent-message-trace'
import { MANAGED_SCRIPT_REVISION } from '../../src/core/agents/hooks/managed-script'
import type { MirrorEntry } from '../../src/core/agent-status-mirror'
import { StationHandoverTracker } from '../../src/core/station-handover'
import type { AgentState } from '../../src/shared/agents/normalize'
import type { StationHandoverRecord } from '../../src/shared/station-handover'
import { launchesToFire, type ArmedNode } from '../../src/renderer/lib/pendingLaunch'
import { normalizeClaude } from '../../src/shared/agents/normalize'

interface Harness {
  deps: AgentMessagingDeps
  tracker: StationHandoverTracker
  /** What the renderer's mirror holds (`useStationHandovers.byId`), fed by the tracker's pushes. */
  mirror: () => Record<string, StationHandoverRecord>
  state: Record<string, AgentState | undefined>
  tick(ms: number): number
  sent: string[]
  /** An agent event, fed the way both shells do: tracker FIRST, then the messaging queue. */
  event(state: AgentState): void
}

function harness(): Harness {
  let clock = 1_000_000
  const sent: string[] = []
  let byId: Record<string, StationHandoverRecord> = Object.create(null)
  const tracker = new StationHandoverTracker(
    (records) => {
      byId = Object.create(null)
      for (const r of records) byId[r.nodeId] = r
    },
    () => clock
  )
  const state: Record<string, AgentState | undefined> = { st: 'working' }
  const h: Harness = {
    tracker,
    mirror: () => byId,
    state,
    sent,
    tick: (ms) => (clock += ms),
    event: () => undefined,
    deps: undefined as unknown as AgentMessagingDeps
  }
  const entry = (): MirrorEntry => ({
    state: state.st === 'done' ? 'done' : 'working',
    updatedAt: 1,
    stateVerified: true,
    clientRevision: MANAGED_SCRIPT_REVISION
  })
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
      return true
    },
    hasLiveSession: () => true,
    mirrorEntry: () => entry(),
    projects: () => [
      {
        id: 'p1',
        nodes: [
          { id: 'orch', title: 'Orchestrator', agentId: 'claude' },
          { id: 'st', title: 'Station', agentId: 'claude' }
        ]
      }
    ],
    isRemoteNode: () => false,
    messagingEnabled: () => true,
    paneOwnerProject: () => 'p1',
    customAgents: () => undefined,
    appendBoardLog: async () => false,
    subscribeReceipts: (cb) => {
      const t = setTimeout(() => cb({ nodeId: 'st', newTurn: true, verified: true }), 1)
      return () => clearTimeout(t)
    },
    now: () => clock,
    // THE WIRING UNDER TEST — exactly what both shells assign (beside the outcome store).
    onHandover: (ev) => tracker.onHandover(ev)
  }
  h.event = (s) => {
    h.tick(10)
    state.st = s
    tracker.onAgentEvent({ nodeId: 'st', state: s })
    if (h.deps.queue)
      onMessagingAgentEvent({ nodeId: 'st', state: s, verified: true, newTurn: false } as never, h.deps.queue)
  }
  return h
}

const send = { verb: 'send', sourceNodeId: 'orch', targetNodeId: 'st', body: 'task B' } as never
/** D: `open-claude --after st`, held (as every control open is) in `pendingLaunch`. */
const d: ArmedNode = { id: 'd', data: { pendingLaunch: { after: ['st'], command: 'claude go' } } }
const live = new Set(['orch', 'st', 'd'])

/** Would the renderer's launch loop start D right now? */
function dFires(h: Harness): boolean {
  const status = { st: { state: h.state.st } }
  return launchesToFire([d], status, live, undefined, undefined, undefined, undefined, h.mirror()).length > 0
}

beforeEach(() => {
  resetMessageFlow()
  resetAgentMessageTraceForTests()
})

describe('plain --after after a QUEUED hand-over — the scenario that fired on the old task', () => {
  it('D does not fire when S finishes the OLD task; it fires only after the new task\'s turn ends', async () => {
    const h = harness()
    const queue = createDeliveryQueue(h.deps, { schedule: () => () => {} })
    h.deps.queue = queue
    h.event('working') // S is busy on task A

    // 1. The orchestrator hands S task B → queued (S is busy).
    const { outcome } = await deliverFromControl(send, h.deps)
    expect(outcome.kind).toBe('queued')
    // 2. …and opens D `--after S`.
    expect(dFires(h)).toBe(false)

    // 3. S finishes task A. Its state is `done` — the OLD task's. The queue flushes B on this edge.
    h.event('done')
    expect(dFires(h)).toBe(false)
    await vi.waitFor(() => expect(queue.depth('st')).toBe(0))
    await vi.waitFor(() => expect(h.sent).toHaveLength(1))
    expect(dFires(h)).toBe(false)

    // 4. S starts B, then ends that turn: now — and only now — D starts.
    h.event('working')
    expect(dFires(h)).toBe(false)
    h.event('done')
    expect(dFires(h)).toBe(true)
  })

  it('a queued hand-over that EXPIRES unread holds D until S finishes a later turn', async () => {
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
    h.event('working')
    await deliverFromControl(send, h.deps)
    expect(expire).toBeTruthy()
    h.tick(10)
    expire!()
    // The queue settles the entry after its trace write.
    await vi.waitFor(() => expect(h.tracker.list()).toEqual([{ nodeId: 'st', since: expect.any(Number) }]))
    // S is idle on task A's `done` — which is not what the orchestrator armed D for.
    h.state.st = 'done'
    h.tracker.onAgentEvent({ nodeId: 'st', state: 'done' })
    expect(dFires(h)).toBe(false)
    h.event('working')
    h.event('done')
    expect(dFires(h)).toBe(true)
  })
})

describe('plain --after after a hand-over that LANDED on an idle station', () => {
  it('D waits while S has not started the new work yet, then fires after that turn', async () => {
    const h = harness()
    h.event('done') // idle after task A
    const { outcome } = await deliverFromControl(send, h.deps)
    expect(outcome.kind).toBe('delivered')
    // Landed, but S has not emitted `working` yet: its `done` is task A's.
    expect(dFires(h)).toBe(false)
    h.event('working')
    h.event('done')
    expect(dFires(h)).toBe(true)
  })
})

describe('plain --after after a write / run', () => {
  it('the answer marks the station from when the request arrived', () => {
    const h = harness()
    h.event('done')
    const requestAt = h.tick(5)
    h.tracker.noteControlAnswer('write', { node: 'st', text: 'task B' }, { ok: true }, 'orch', requestAt)
    expect(dFires(h)).toBe(false)
    h.event('working')
    h.event('done')
    expect(dFires(h)).toBe(true)
  })

  it('a refused write hands nothing over', () => {
    const h = harness()
    h.event('done')
    h.tracker.noteControlAnswer('write', { node: 'st' }, { ok: false }, 'orch', h.tick(5))
    expect(dFires(h)).toBe(true)
  })
})

describe('plain --after on a station whose turn ended with background work still running', () => {
  // Measured live (2026-09-30): an agent's turn ended while its work went on in the background, and
  // the node armed `--after` it fired before anything had been pushed. Only background SUBAGENTS
  // hold: an async child ends and its task-notification wakes the parent into another turn, while a
  // background SHELL (a dev server, a watcher) may never end — holding on it would hold forever.
  // Fed through the REAL Claude normalizer, so the `type` split is the one production applies.
  const stop = (h: Harness, tasks: Array<{ id: string; type: string; status: string }> | undefined) => {
    h.tick(10)
    h.state.st = 'done'
    const ev = normalizeClaude({
      nodeId: 'st',
      agentId: 'claude',
      payload: {
        hook_event_name: 'Stop',
        session_id: 's1',
        ...(tasks ? { background_tasks: tasks } : {})
      }
    })!
    h.tracker.onAgentEvent(ev)
  }

  it('an async SUBAGENT still running holds D until a later turn end with none left', () => {
    const h = harness()
    h.event('working')
    stop(h, [{ id: 'a1b2c3', type: 'subagent', status: 'running' }])
    expect(dFires(h)).toBe(false)
    // The child's task-notification wakes the station; that turn ends with the child gone.
    h.event('working')
    expect(dFires(h)).toBe(false)
    stop(h, [{ id: 'a1b2c3', type: 'subagent', status: 'completed' }])
    expect(dFires(h)).toBe(true)
  })

  it('a background SHELL that never ends (a dev server) does NOT hold D — before and after this PR', () => {
    const h = harness()
    h.event('working')
    stop(h, [{ id: 'bash_devserver', type: 'local_bash', status: 'running' }])
    expect(dFires(h)).toBe(true)
    // …and it keeps not holding on every later turn that still lists it.
    h.event('working')
    stop(h, [{ id: 'bash_devserver', type: 'local_bash', status: 'running' }])
    expect(dFires(h)).toBe(true)
  })

  it('a CLI that sends no inventory keeps today\'s behaviour: its done releases D', () => {
    const h = harness()
    h.event('working')
    stop(h, undefined)
    expect(dFires(h)).toBe(true)
  })
})

describe('the ordinary case is unchanged', () => {
  it('a station nobody handed anything fires D on its done, as before', () => {
    const h = harness()
    h.event('working')
    expect(dFires(h)).toBe(false)
    h.event('done')
    expect(dFires(h)).toBe(true)
  })
})
