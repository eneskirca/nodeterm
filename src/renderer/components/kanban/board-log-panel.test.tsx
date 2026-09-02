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

  it('names the kind and the item for an attach / detach', () => {
    expect(eventBody({ type: 'github-attached', to: 'pull', title: '#584 Pull cards' }))
      .toBe('attached PR #584 Pull cards')
    expect(eventBody({ type: 'github-detached', to: 'issue', title: '#462 Board' }))
      .toBe('detached issue #462 Board')
  })

  it('an unknown future type falls back neutrally', () => {
    expect(eventBody({ type: 'something-new' as BoardLogEvent['type'] })).toBe('updated this card')
  })
})
