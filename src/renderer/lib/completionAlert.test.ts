import { describe, expect, it } from 'vitest'
import { fanoutStillWorking } from './completionAlert'
import { useAgentNodes } from '../state/agentNodes'
import { WORKING_STALE_MS } from '@shared/agents/stale'

const cards = (...cs: { parentNodeId: string; state?: string }[]): typeof cs => cs

describe('fanoutStillWorking — the completion alert’s quiet gate (issue #708)', () => {
  it('is loud with no cards at all — the ordinary agent node must never lose its chime', () => {
    expect(fanoutStillWorking([], 'n1')).toBe(false)
  })

  it('is quiet while this parent still holds a working card', () => {
    expect(fanoutStillWorking(cards({ parentNodeId: 'n1', state: 'working' }), 'n1')).toBe(true)
  })

  it('is loud once every card of this parent is done — the last one lands, the chime fires', () => {
    expect(
      fanoutStillWorking(
        cards(
          { parentNodeId: 'n1', state: 'done' },
          { parentNodeId: 'n1', state: 'done' },
          { parentNodeId: 'n1', state: 'done' }
        ),
        'n1'
      )
    ).toBe(false)
  })

  it('is quiet with nine done and one still working — the case in the report', () => {
    const nine = Array.from({ length: 9 }, () => ({ parentNodeId: 'n1', state: 'done' }))
    expect(fanoutStillWorking([...nine, { parentNodeId: 'n1', state: 'working' }], 'n1')).toBe(true)
  })

  it('is scoped per parent — another node’s live fan-out never silences this one', () => {
    expect(fanoutStillWorking(cards({ parentNodeId: 'n2', state: 'working' }), 'n1')).toBe(false)
  })

  it('is LOUD for an unknown/absent state — the opposite direction from Eco’s liveSubagents', () => {
    // Eco counts anything not provably `done` as live, because being wrong there kills running
    // work. Being wrong HERE swallows a completion, so only a positive `working` may silence.
    expect(fanoutStillWorking(cards({ parentNodeId: 'n1' }), 'n1')).toBe(false)
    expect(fanoutStillWorking(cards({ parentNodeId: 'n1', state: 'queued' }), 'n1')).toBe(false)
  })
})

describe('the real store feeds it the shape it expects', () => {
  const P = 'parent-708'
  const reset = (): void => useAgentNodes.getState().clearForParent(P)

  it('goes quiet on start() and loud again on finish() — no adapter in between', () => {
    reset()
    const values = (): { parentNodeId: string; state?: string }[] =>
      Object.values(useAgentNodes.getState().byId)

    useAgentNodes.getState().start('t1', { parentNodeId: P })
    useAgentNodes.getState().start('t2', { parentNodeId: P })
    expect(fanoutStillWorking(values(), P)).toBe(true)

    useAgentNodes.getState().finish('t1', {})
    expect(fanoutStillWorking(values(), P)).toBe(true) // t2 still out there

    useAgentNodes.getState().finish('t2', {})
    expect(fanoutStillWorking(values(), P)).toBe(false)
    reset()
  })

  it('the 20-minute stale decay is what bounds a lost subagent end', () => {
    // A subagent whose end never arrives would otherwise silence this node's chimes forever.
    reset()
    useAgentNodes.getState().start('t3', { parentNodeId: P })
    const startedAt = useAgentNodes.getState().byId['t3'].startedAt
    const values = (): { parentNodeId: string; state?: string }[] =>
      Object.values(useAgentNodes.getState().byId)

    useAgentNodes.getState().sweepStaleWorking(startedAt + WORKING_STALE_MS - 1)
    expect(fanoutStillWorking(values(), P)).toBe(true)

    useAgentNodes.getState().sweepStaleWorking(startedAt + WORKING_STALE_MS + 1)
    expect(fanoutStillWorking(values(), P)).toBe(false)
    reset()
  })
})
