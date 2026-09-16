// An antigravity station's errored turn must not hold its `--after`
// dependents forever.
//
// `lastTurnError` (issue #521) is retired ONLY by a `newTurn` event (agentStatus.ts), and until the
// fix `normalizeAntigravity` never emitted one: after one `Stop` with `terminationReason: 'ERROR'`
// every dependent stayed QUEUED for the rest of the app run, however many later turns succeeded.
// The fix marks the `PreInvocation` whose `invocationNum === 0` (the first model call of an agy
// execution) as the new turn.
//
// End to end, against the REAL store and the REAL launch gate: the normalizer's event is applied the
// way Canvas's hook listener applies it (`setState(nodeId, state, agentId, newTurn, pendingId,
// verified, errored)`), and `launchesToFire` is asked whether the dependent may go.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { normalizeAntigravity, type NormalizedAgentEvent } from '@shared/agents/normalize'
import { DONE_HOLDOFF_MS, useAgentStatus } from '../state/agentStatus'
import { launchesToFire } from './pendingLaunch'

const UP = 'agy-up'
const LIVE = new Set([UP])
const DOWN = [{ id: 'down', data: { pendingLaunch: { after: [UP], command: 'go' } } }]

/** The hook server's envelope: agy's payload plus the merged `nodeterm_hook_event` form field. */
const hook = (event: string, payload: Record<string, unknown>): NormalizedAgentEvent => {
  const out = normalizeAntigravity({
    nodeId: UP,
    agentId: 'antigravity',
    payload: { conversationId: 'c1', ...payload, nodeterm_hook_event: event }
  })
  if (!out) throw new Error(`${event} normalized to null`)
  return out
}

/** Exactly what Canvas's `agent:status` listener does with a `state` event. */
const apply = (e: NormalizedAgentEvent): void => {
  if (e.kind === 'state' && e.state) {
    useAgentStatus.getState().setState(e.nodeId, e.state, e.agentId, e.newTurn, e.pendingId, e.verified, e.errored)
  }
}

const entry = () => useAgentStatus.getState().byId[UP]
const fires = (): boolean =>
  launchesToFire(DOWN, useAgentStatus.getState().byId, LIVE).some((l) => l.id === 'down')

beforeEach(() => {
  vi.useFakeTimers()
  useAgentStatus.setState({ byId: {} })
})
afterEach(() => {
  vi.useRealTimers()
})

describe('antigravity: an errored turn is retired by the next execution', () => {
  it('ERROR → recorded → PreInvocation(0) clears it → a clean Stop keeps it clear and releases the dependent', () => {
    apply(hook('PreInvocation', { invocationNum: 0 }))
    apply(hook('Stop', { fullyIdle: true, terminationReason: 'ERROR' }))
    expect(entry().state).toBe('done')
    expect(entry().lastTurnError).toBeDefined()
    expect(fires()).toBe(false)

    // The user sends another prompt, after the done-holdoff (an ordinary pace).
    vi.advanceTimersByTime(DONE_HOLDOFF_MS + 1000)
    apply(hook('PreInvocation', { invocationNum: 0 }))
    expect(entry().state).toBe('working')
    expect(entry().lastTurnError).toBeUndefined()
    expect(fires()).toBe(false) // working is not done

    apply(hook('PreInvocation', { invocationNum: 1 }))
    apply(hook('Stop', { fullyIdle: true, terminationReason: 'NO_TOOL_CALL' }))
    expect(entry().state).toBe('done')
    expect(entry().lastTurnError).toBeUndefined()
    expect(fires()).toBe(true)
  })

  it('a later model call of the same execution does NOT retire the error', () => {
    apply(hook('Stop', { fullyIdle: true, terminationReason: 'ERROR' }))
    vi.advanceTimersByTime(DONE_HOLDOFF_MS + 1000)
    apply(hook('PreInvocation', { invocationNum: 3 }))
    expect(entry().lastTurnError).toBeDefined()
  })

  it('the done-holdoff: a PreInvocation(0) right after a done still lights working', () => {
    apply(hook('PreInvocation', { invocationNum: 0 }))
    apply(hook('Stop', { fullyIdle: true, terminationReason: 'NO_TOOL_CALL' }))
    expect(entry().state).toBe('done')
    vi.advanceTimersByTime(500) // well inside DONE_HOLDOFF_MS: a quick follow-up prompt
    apply(hook('PreInvocation', { invocationNum: 0 }))
    expect(entry().state).toBe('working')
  })

  it('…while a late non-first PreInvocation inside the holdoff is still held off', () => {
    apply(hook('Stop', { fullyIdle: true, terminationReason: 'NO_TOOL_CALL' }))
    vi.advanceTimersByTime(500)
    apply(hook('PreInvocation', { invocationNum: 2 }))
    expect(entry().state).toBe('done')
  })

  it("a background tool's late PostToolUse neither retires the error nor releases the dependent", () => {
    apply(hook('Stop', { fullyIdle: true, terminationReason: 'ERROR' }))
    vi.advanceTimersByTime(DONE_HOLDOFF_MS + 1000)
    // A background tool's late PostToolUse says nothing (null) and must not release anything.
    const post = normalizeAntigravity({
      nodeId: UP,
      agentId: 'antigravity',
      payload: { nodeterm_hook_event: 'PostToolUse', toolCall: { name: 'run_command' } }
    })
    expect(post).toBeNull()
    expect(fires()).toBe(false)
  })
})
