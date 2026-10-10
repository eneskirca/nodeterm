import { describe, it, expect, vi, beforeEach } from 'vitest'
import { usePendingPause, shouldFirePendingPause, startPendingPauseWatcher } from './pendingPause'
import { useAgentStatus } from './agentStatus'

const T = { nodeId: 'n1', agentId: 'claude', relay: false, hostKey: 'local' }

describe('shouldFirePendingPause', () => {
  it('fires on working → done', () =>
    expect(shouldFirePendingPause({ state: 'working' } as never, { state: 'done' } as never)).toBe(true))
  it('not on an errored done', () =>
    expect(shouldFirePendingPause({ state: 'working' } as never, { state: 'done', lastTurnError: { at: 1 } } as never)).toBe(false))
  it('not on an interrupted done', () =>
    expect(shouldFirePendingPause({ state: 'working' } as never, { state: 'done', lastTurnInterrupted: { at: 1 } } as never)).toBe(false))
  it('not while a ticket is held', () =>
    expect(shouldFirePendingPause({ state: 'working' } as never, { state: 'done', held: {} } as never)).toBe(false))
  it('not on done → done', () =>
    expect(shouldFirePendingPause({ state: 'done' } as never, { state: 'done' } as never)).toBe(false))
})

describe('watcher', () => {
  beforeEach(() => {
    usePendingPause.setState({ byId: {} })
    useAgentStatus.setState({ byId: {} })
  })
  it('fires once and removes the entry', () => {
    const fire = vi.fn()
    const stop = startPendingPauseWatcher(fire)
    usePendingPause.getState().add([T])
    useAgentStatus.getState().setState('n1', 'working')
    useAgentStatus.getState().setState('n1', 'done')
    useAgentStatus.getState().setState('n1', 'working')
    useAgentStatus.getState().setState('n1', 'done')
    expect(fire).toHaveBeenCalledTimes(1)
    expect(usePendingPause.getState().byId.n1).toBeUndefined()
    stop()
  })
  it('a node removed from the agent table drops its pending pause', () => {
    const stop = startPendingPauseWatcher(vi.fn())
    usePendingPause.getState().add([T])
    useAgentStatus.getState().setState('n1', 'working')
    useAgentStatus.getState().remove('n1')
    expect(usePendingPause.getState().byId.n1).toBeUndefined()
    stop()
  })
})
