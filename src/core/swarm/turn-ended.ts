import type { NormalizedAgentEvent } from '../../shared/agents/normalize'

/** Live Stop/done is a turn end. idle_prompt rescue and SessionEnd-without-sawAgent are not. */
export function isSwarmTurnEndedEvent(
  e: Pick<NormalizedAgentEvent, 'state' | 'idle' | 'sessionPhase'>
): boolean {
  if (e.sessionPhase === 'end') return true
  return e.state === 'done' && e.idle !== true
}

export function swarmHookKind(
  e: Pick<NormalizedAgentEvent, 'sessionPhase'>
): 'stop' | 'session-end' {
  return e.sessionPhase === 'end' ? 'session-end' : 'stop'
}
