import { afterEach, describe, expect, it } from 'vitest'
import { SubagentReplay, subagentReplay } from './subagent-replay'
import { recordAgentEvent, clearNode, _resetForTest } from './agent-status-mirror'
import { WORKING_STALE_MS } from '../shared/agents/stale'
import type { NormalizedAgentEvent } from '../shared/agents/normalize'
const start: NormalizedAgentEvent = { kind: 'subagent-start', agentId: 'claude', nodeId: 'p', toolUseId: 'child', taskLabel: 'task' }
afterEach(_resetForTest)
describe('subagent reload memory', () => {
  it('restores a running card across turns, with its original time and no authority fields', () => {
    const replay = new SubagentReplay()
    replay.record({ ...start, verified: true, pendingId: 'secret', sessionId: 's' }, 100)
    replay.record({ ...start, kind: 'state', state: 'working', newTurn: true }, 200)
    replay.record(start, 300)
    expect(replay.snapshot(400)).toEqual([{ ...start, subagentType: undefined, subagentStartedAt: 100 }])
    replay.record({ ...start, kind: 'session', sessionTitle: 'renamed' }, 500)
    expect(replay.snapshot(500)).toHaveLength(1)
  })
  it('ends, session boundaries and deletes clear only the intended parent', () => {
    const replay = new SubagentReplay()
    replay.record(start, 100)
    replay.record({ ...start, nodeId: 'other' }, 100)
    replay.record({ ...start, kind: 'subagent-end' }, 200)
    expect(replay.snapshot(200).map((e) => e.nodeId)).toEqual(['other'])
    replay.record({ ...start, nodeId: 'other', kind: 'session', sessionPhase: 'end' }, 300)
    expect(replay.snapshot(300)).toEqual([])
    replay.record(start, 400)
    replay.clearParent('p')
    expect(replay.snapshot(400)).toEqual([])
  })
  it('bounds memory, expires stale work and refuses future-dated starts after clock rollback', () => {
    const replay = new SubagentReplay(2)
    for (const toolUseId of ['a', 'b', 'c']) replay.record({ ...start, toolUseId }, 100)
    expect(replay.snapshot(100).map((e) => e.toolUseId)).toEqual(['b', 'c'])
    expect(replay.snapshot(100 + WORKING_STALE_MS)).toEqual([])
    replay.record(start, 500)
    expect(replay.snapshot(499)).toEqual([])
  })
  it('the shared mirror path records starts and synthetic ends; node deletion clears replay', () => {
    recordAgentEvent(start)
    expect(subagentReplay.snapshot()).toHaveLength(1)
    recordAgentEvent({ ...start, kind: 'subagent-end' })
    expect(subagentReplay.snapshot()).toEqual([])
    recordAgentEvent(start)
    clearNode('p')
    expect(subagentReplay.snapshot()).toEqual([])
  })
})
