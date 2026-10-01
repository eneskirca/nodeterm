/**
 * A station started a moment ago (`--run-now`, `run`) has a node identity but has not posted a
 * verified status yet, so a `send` right after the start answers `targetStatusStale`. A retry
 * cannot help until its first hook lands, and its first verified `done` is what flushes the queue,
 * so the message is queued instead of refused.
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('../core/agents/node-token-files', async (orig) => ({
  ...(await orig<typeof import('../core/agents/node-token-files')>()),
  nodeTokenFilePresent: () => true
}))

import { deliverFromControl, createDeliveryQueue, type AgentMessagingDeps } from '../core/agents/agent-messaging'
import { DELIVERY_QUEUE_TTL_MS } from '../core/agents/delivery-queue'

const deps = (): AgentMessagingDeps => {
  const projects = () => [
    { id: 'p1', nodes: [{ id: 'a1', title: 'A', agentId: 'claude' }, { id: 'b1', title: 'B', agentId: 'claude' }] }
  ]
  return {
    paneOwner: async () => ({ tty: '/dev/pts/9', panePid: 1, paneId: '%1', command: 'claude', argv: ['claude'], pids: [2] }),
    sendEnvelope: async () => true,
    hasLiveSession: () => true,
    // Never seen: no hook has arrived from the fresh session yet.
    mirrorEntry: () => undefined,
    projects,
    isRemoteNode: () => false,
    messagingEnabled: () => true,
    paneOwnerProject: () => 'p1',
    customAgents: () => undefined,
    appendBoardLog: async () => false,
    now: () => 1_000_000
  }
}

describe('a freshly started station that has not reported yet', () => {
  it('is refused targetStatusStale without a queue', async () => {
    const { outcome } = await deliverFromControl(
      { verb: 'send', sourceNodeId: 'a1', targetNodeId: 'b1', body: 'hi' } as never,
      deps()
    )
    expect(outcome.kind).toBe('targetStatusStale')
  })

  it('is queued with the ordinary TTL when a queue is wired', async () => {
    const d = deps()
    d.queue = createDeliveryQueue(d, { schedule: () => () => {} })
    const { outcome } = await deliverFromControl(
      { verb: 'send', sourceNodeId: 'a1', targetNodeId: 'b1', body: 'hi' } as never,
      d
    )
    expect(outcome.kind).toBe('queued')
    expect(outcome.kind === 'queued' && outcome.ttlMs).toBe(DELIVERY_QUEUE_TTL_MS)
  })
})
