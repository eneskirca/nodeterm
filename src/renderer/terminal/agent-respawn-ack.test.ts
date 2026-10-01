import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __resetAgentRespawnAckForTests,
  agentRespawnPending,
  beginAgentRespawn,
  reportAgentRespawn
} from './agent-respawn-ack'

import { DELIVERY_ATTEMPTS, VERIFY_TIMEOUT_MS } from './command-delivery'
import { RESTART_EXIT_TIMEOUT_MS } from './agent-restart'
import { AGENT_RESPAWN_PROCESS_TIMEOUT_MS } from './agent-respawn-process'

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  __resetAgentRespawnAckForTests()
  vi.useRealTimers()
})

describe('agent respawn acknowledgements', () => {
  it('resolves only from the replacement lifecycle', async () => {
    const ticket = beginAgentRespawn('node-1')
    expect(agentRespawnPending('node-1')).toBe(true)
    expect(reportAgentRespawn('node-1', ticket.generation, { ok: true })).toBe(true)
    await expect(ticket.promise).resolves.toEqual({ ok: true })
    expect(agentRespawnPending('node-1')).toBe(false)
  })

  it('keeps a failed replacement actionable', async () => {
    const ticket = beginAgentRespawn('node-1')
    reportAgentRespawn('node-1', ticket.generation, {
      ok: false,
      reason: 'agent-not-running',
      detail: 'replacement failed'
    })
    await expect(ticket.promise).resolves.toEqual({
      ok: false,
      reason: 'agent-not-running',
      detail: 'replacement failed'
    })
  })

  it('times out a lifecycle that never reports', async () => {
    const ticket = beginAgentRespawn('node-1', 25)
    await vi.advanceTimersByTimeAsync(25)
    await expect(ticket.promise).resolves.toEqual({
      ok: false,
      detail: 'the replacement terminal did not become ready in time'
    })
  })

  it('allows a retried resume to fall back fresh and finish process proof', async () => {
    const ticket = beginAgentRespawn('fallback-node')
    // Project preflight, both shell settles and echo-verification windows, the missing-session
    // shell probe, then proof of the replacement process. A 20-second ticket expired mid-fallback.
    const elapsed =
      3_000 +
      2 * 1_500 +
      2 * DELIVERY_ATTEMPTS * VERIFY_TIMEOUT_MS +
      RESTART_EXIT_TIMEOUT_MS +
      AGENT_RESPAWN_PROCESS_TIMEOUT_MS
    await vi.advanceTimersByTimeAsync(elapsed)
    expect(agentRespawnPending('fallback-node', ticket.generation)).toBe(true)
    expect(reportAgentRespawn('fallback-node', ticket.generation, { ok: true })).toBe(true)
    await expect(ticket.promise).resolves.toEqual({ ok: true })
  })

  it('ignores a late acknowledgement from an older lifecycle', async () => {
    const old = beginAgentRespawn('node-1')
    old.cancel('old attempt ended')
    const current = beginAgentRespawn('node-1')
    expect(reportAgentRespawn('node-1', old.generation, { ok: true })).toBe(false)
    expect(agentRespawnPending('node-1', current.generation)).toBe(true)
    reportAgentRespawn('node-1', current.generation, { ok: true })
    await expect(current.promise).resolves.toEqual({ ok: true })
  })
})
