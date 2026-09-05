import { expect, it } from 'vitest'
import { SubagentReplay } from './subagent-replay'
import type { NormalizedAgentEvent } from '../shared/agents/normalize'

it('isolates identical tool ids by parent and bounds retained history', () => {
  const replay = new SubagentReplay()
  const event = { agentId: 'claude', kind: 'subagent-start', toolUseId: 'shared' } as const
  replay.record({ ...event, nodeId: 'one' })
  replay.record({ ...event, nodeId: 'two' })
  replay.record({ agentId: 'claude', nodeId: 'one', kind: 'session', sessionPhase: 'end' })
  expect(replay.snapshot().map(e => e.nodeId)).toEqual(['two'])
  for (let i = 0; i < 600; i++) replay.record({ ...event, nodeId: 'parent-' + i })
  expect(replay.snapshot()).toHaveLength(512)
  const snapshot = replay.snapshot()
  snapshot[0].nodeId = 'mutated'
  expect(replay.snapshot()[0].nodeId).not.toBe('mutated')
})

it.each(['claude', 'codex'] as const)('rehydrates %s fan-out without replaying alerts', (agentId) => {
  const replay = new SubagentReplay()
  const start: NormalizedAgentEvent = { agentId, nodeId: 'parent', toolUseId: 'child', kind: 'subagent-start' }
  replay.record(start)
  const original = replay.snapshot()[0]
  replay.record(start)
  expect(replay.snapshot()).toEqual([original])
  replay.record({ ...start, kind: 'state', state: 'blocked' })
  expect(replay.snapshot()).toEqual([original])
  replay.record({ ...start, kind: 'subagent-end', result: 'done' })
  expect(replay.snapshot().map((e) => e.kind)).toEqual(['subagent-start', 'subagent-end'])
  replay.record({ agentId, nodeId: 'parent', kind: 'state', newTurn: true })
  expect(replay.snapshot()).toEqual([])
  replay.record(start)
  replay.record({ agentId, nodeId: 'parent', kind: 'state', newTurn: true })
  expect(replay.snapshot()).toHaveLength(1)
  replay.record({ agentId, nodeId: 'parent', kind: 'session', sessionPhase: 'end' })
  expect(replay.snapshot()).toEqual([])
})
