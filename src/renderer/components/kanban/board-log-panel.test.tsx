import { describe, it, expect } from 'vitest'
import { eventBody } from './BoardLogPanel'
import type { BoardLogEvent } from '@shared/types'

describe('eventBody — the activity sentence', () => {
  it('renders the new agent-read-cookies type as a loud, domain-naming line (Task 9.2)', () => {
    const e: BoardLogEvent = { type: 'agent-read-cookies', from: 'claude-1', to: 'github.com', title: 'browser-3' }
    expect(eventBody(e)).toBe('read cookies for github.com via browser-3')
  })

  it('names the domain even without a browser title', () => {
    expect(eventBody({ type: 'agent-read-cookies', from: 'claude-1', to: 'github.com' })).toBe(
      'read cookies for github.com'
    )
  })

  it('a known peer type still renders its own sentence (not the neutral fallback)', () => {
    // Guards against the new case accidentally swallowing a sibling type.
    expect(eventBody({ type: 'agent-message', to: 'claude-2', title: 'delivered' })).toBe(
      'sent a message to claude-2 (delivered)'
    )
  })

  it('a board comment\'s delivery line (shown alone only off its comment\'s card) says what happened', () => {
    expect(
      eventBody({ type: 'agent-message', from: 'board-comment:c-1', to: 'b1', title: 'notPermitted', reason: 'switch-off' })
    ).toBe('routed a board comment here: not delivered — agent messaging is off for this project (Settings → Agents)')
    expect(eventBody({ type: 'agent-message', from: 'board-comment:c-1', to: 'b1', title: 'delivered' })).toBe(
      'routed a board comment here: delivered'
    )
  })

  it('an unknown future type falls back neutrally', () => {
    expect(eventBody({ type: 'something-new' as BoardLogEvent['type'] })).toBe('updated this card')
  })

  it('renders a run on an issue card, naming the session and how it ended', () => {
    expect(eventBody({ type: 'run-started', title: 'Claude', run: { nodeId: 'term-1', agentId: 'claude' } })).toBe(
      'started Claude (term-1) on this issue'
    )
    expect(eventBody({ type: 'run-ended', title: 'Claude', run: { nodeId: 'term-1', end: 'done' } })).toBe(
      'closed Claude (term-1) (last state: done)'
    )
  })

  it('a run line survives a malformed run record from a hand-edited log', () => {
    expect(eventBody({ type: 'run-ended', run: { nodeId: 42 } as never })).toBe('closed a session')
  })

  it('renders a station notice from the closed reason table, never from the station', () => {
    expect(
      eventBody({ type: 'station-failed', from: 'st1', to: 'turn-errored', title: 'Worker' })
    ).toBe(
      'told this agent that station "Worker" (st1) stopped: its last turn ended on an API/model error and produced nothing'
    )
    // An unknown reason code (a newer peer, a hand edit) reads as a plain "stopped".
    expect(eventBody({ type: 'station-failed', from: 'st1', to: 'rm -rf ~' })).toBe(
      'told this agent that station st1 stopped: it stopped'
    )
  })

  it('renders a station outcome report from the outcome code, the note as text only', () => {
    expect(eventBody({ type: 'station-reported', from: 'st1', to: 'succeeded', title: 'tests pass' })).toBe(
      'recorded this session\'s report: its task succeeded — "tests pass"'
    )
    expect(eventBody({ type: 'station-reported', from: 'st1', to: 'failed' })).toBe(
      'recorded this session\'s report: its task failed'
    )
    // An outcome code this build does not know (a newer peer, a hand edit) reads as a plain report.
    expect(eventBody({ type: 'station-reported', from: 'st1', to: 'rm -rf ~' })).toBe(
      'recorded this session\'s report: an outcome'
    )
  })
})
