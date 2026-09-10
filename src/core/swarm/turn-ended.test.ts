import { describe, expect, it } from 'vitest'
import { isSwarmTurnEndedEvent, swarmHookKind } from './turn-ended'

describe('swarm turn-ended events', () => {
  it('treats Stop/done as a turn end and ignores idle_prompt rescue', () => {
    expect(isSwarmTurnEndedEvent({ state: 'done' })).toBe(true)
    expect(isSwarmTurnEndedEvent({ state: 'done', idle: true })).toBe(false)
    expect(isSwarmTurnEndedEvent({ state: 'working' })).toBe(false)
    expect(isSwarmTurnEndedEvent({ sessionPhase: 'end' })).toBe(true)
    expect(swarmHookKind({ sessionPhase: 'end' })).toBe('session-end')
    expect(swarmHookKind({})).toBe('stop')
  })
})
