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
  it('keeps a long-running start while its transcript streams, and expires it after the window of silence', () => {
    // WORKING_STALE_MS is "this long without a sign of life": counted from the start alone, a
    // subagent running longer than the window was dropped here, so a renderer reload lost its card.
    const replay = new SubagentReplay()
    replay.record(start, 100)
    replay.touch('child', 100 + WORKING_STALE_MS * 2)
    expect(replay.snapshot(100 + WORKING_STALE_MS * 2 + 60_000)).toEqual([
      { ...start, subagentType: undefined, subagentStartedAt: 100, subagentLastActivityAt: 100 + WORKING_STALE_MS * 2 }
    ])
    expect(replay.snapshot(100 + WORKING_STALE_MS * 3 + 1)).toEqual([])
  })
  it('an activity time left in the future by a clock step back is clamped, so the start still expires', () => {
    const replay = new SubagentReplay()
    replay.record(start, 100)
    replay.touch('child', 10_000_000) // stamped before the clock stepped back
    expect(replay.snapshot(200)).toHaveLength(1) // clamped to now, the window restarts once
    expect(replay.snapshot(200 + WORKING_STALE_MS)).toEqual([])
  })
  it('touch ignores unknown ids and never resurrects an ended start', () => {
    const replay = new SubagentReplay()
    replay.touch('child', 100)
    replay.record(start, 200)
    replay.record({ ...start, kind: 'subagent-end' }, 300)
    replay.touch('child', 400)
    expect(replay.snapshot(400)).toEqual([])
    replay.record(start, 500)
    expect(replay.snapshot(500 + WORKING_STALE_MS)).toEqual([])
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
describe('Claude native subagents (core/claude-subagent-lifecycle.ts)', () => {
  it('a start that supersedes a tool-drawn card replaces it: one running card, under the new key', () => {
    const replay = new SubagentReplay()
    replay.record({ ...start, toolUseId: 'toolu_1' }, 100)
    replay.record({ ...start, toolUseId: 'a1', supersedes: 'toolu_1' }, 150)
    expect(replay.snapshot(200).map((e) => [e.toolUseId, e.subagentStartedAt])).toEqual([['a1', 100]])
  })
  it('a supersede moves the replaced card\'s last activity to the new key and drops the old entry', () => {
    const replay = new SubagentReplay()
    replay.record({ ...start, toolUseId: 'toolu_1' }, 100)
    replay.touch('toolu_1', 140)
    replay.record({ ...start, toolUseId: 'a1', supersedes: 'toolu_1' }, 150)
    expect(replay.snapshot(200)).toEqual([expect.objectContaining({ toolUseId: 'a1', subagentLastActivityAt: 140 })])
    // A later start that reuses the old key must not inherit the orphaned activity time.
    replay.record({ ...start, toolUseId: 'toolu_1' }, 300)
    const reused = replay.snapshot(300).find((e) => e.toolUseId === 'toolu_1')
    expect(reused?.subagentLastActivityAt).toBeUndefined()
  })
  it('a replayed start keeps which signal drew it, so a reloaded native card stays native', () => {
    const replay = new SubagentReplay()
    replay.record({ ...start, toolUseId: 'toolu_1', subagentSignal: 'tool' }, 100)
    replay.record({ ...start, toolUseId: 'a1', subagentSignal: 'native', supersedes: 'toolu_1' }, 150)
    replay.record({ ...start, agentId: 'grok', toolUseId: 'g1' }, 160)
    const snap = replay.snapshot(200)
    expect(snap.find((e) => e.toolUseId === 'a1')).toMatchObject({ subagentSignal: 'native', agentId: 'claude' })
    expect(snap.find((e) => e.toolUseId === 'g1')).not.toHaveProperty('subagentSignal')
  })
  it('a repeated start of a running card corrects its label and keeps its start time', () => {
    const replay = new SubagentReplay()
    replay.record({ ...start, toolUseId: 'a1', taskLabel: 'guess' }, 100)
    replay.record({ ...start, toolUseId: 'a1', taskLabel: 'exact' }, 150)
    expect(replay.snapshot(200)).toEqual([expect.objectContaining({ toolUseId: 'a1', taskLabel: 'exact', subagentStartedAt: 100 })])
  })
})
