import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NormalizedAgentEvent } from '@shared/agents/normalize'
import { IPC } from '@shared/ipc'
import type { CorePlatform } from './platform'
import { registerAgentStatusHandlers } from './agent-status-handlers'
import { _resetForTest, recordAgentEvent } from './agent-status-mirror'

function event(): NormalizedAgentEvent {
  return {
    nodeId: 'n1',
    agentId: 'claude',
    sessionId: 's1',
    kind: 'state',
    state: 'working'
  }
}

beforeEach(() => _resetForTest())
afterEach(() => {
  _resetForTest()
  vi.restoreAllMocks()
})

describe('registerAgentStatusHandlers', () => {
  it('returns durable state reconciled by a newer per-agent inspection', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(100)
    recordAgentEvent(event())
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    const platform = {
      handle: (channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn)
    } as unknown as CorePlatform
    registerAgentStatusHandlers(platform, {
      inspectors: {
        claude: async () => ({
          state: 'done',
          observedAt: 200,
          source: 'claude-transcript'
        })
      }
    })

    const result = await handlers.get(IPC.agentStatusSnapshot)!()

    expect(result).toEqual({
      n1: {
        state: 'done',
        agentId: 'claude',
        sessionId: 's1',
        changedAt: 200
      }
    })
  })
})
