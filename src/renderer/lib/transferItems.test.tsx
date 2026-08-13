import { describe, it, expect } from 'vitest'
import { transferTargets, transferConversationItems } from './transferItems'
import type { AgentId } from '@shared/agents/config'
import type { CustomAgent } from '@shared/types'

const customs: CustomAgent[] = [
  { id: 'custom:a', label: 'Agent A', launchCmd: 'a', promptInjectionMode: 'argv' },
  { id: 'custom:b', label: 'Agent B', launchCmd: 'b', promptInjectionMode: 'argv' }
]

describe('transferTargets', () => {
  it('excludes the source agent and disabled agents', () => {
    const targets = transferTargets('claude' as AgentId, ['gemini'], customs)
    const ids = targets.map((t) => t.id)
    expect(ids).not.toContain('claude') // source excluded
    expect(ids).not.toContain('gemini') // disabled excluded
    expect(ids).toContain('codex')
    expect(ids).toContain('grok')
    expect(ids).toContain('opencode')
    // customs both present (neither is the source nor disabled)
    expect(ids).toContain('custom:a')
    expect(ids).toContain('custom:b')
  })

  it('excludes a custom agent that is the source', () => {
    const targets = transferTargets('custom:a' as AgentId, [], customs)
    const ids = targets.map((t) => t.id)
    expect(ids).not.toContain('custom:a')
    expect(ids).toContain('custom:b')
    // builtins still present
    expect(ids).toContain('claude')
  })

  it('excludes disabled custom agents', () => {
    const targets = transferTargets('claude' as AgentId, ['custom:b'], customs)
    const ids = targets.map((t) => t.id)
    expect(ids).not.toContain('custom:b')
    expect(ids).toContain('custom:a')
  })
})

describe('transferConversationItems', () => {
  const handler = () => {}

  it('returns the label + one item per target for a transfer-capable agent with a session', () => {
    const items = transferConversationItems(
      'node-1',
      undefined,
      {
        sourceAgentId: 'claude' as AgentId,
        sessionId: 'sess-1',
        disabledAgents: [],
        customAgents: customs
      },
      handler
    )
    expect(items.length).toBeGreaterThan(1)
    expect(items[0]).toMatchObject({ type: 'label', label: 'Transfer conversation to' })
  })

  it('returns [] when the agent is not transfer-capable', () => {
    const items = transferConversationItems(
      'node-1',
      undefined,
      { sourceAgentId: 'grok' as AgentId, sessionId: 'sess-1', disabledAgents: [], customAgents: [] },
      handler
    )
    expect(items).toEqual([])
  })

  it('returns [] when there is no session id yet', () => {
    const items = transferConversationItems(
      'node-1',
      undefined,
      { sourceAgentId: 'claude' as AgentId, sessionId: undefined, disabledAgents: [], customAgents: [] },
      handler
    )
    expect(items).toEqual([])
  })

  it('returns [] when sourceAgentId is undefined (not an agent node)', () => {
    const items = transferConversationItems(
      'node-1',
      undefined,
      { sourceAgentId: undefined, sessionId: 'sess-1', disabledAgents: [], customAgents: [] },
      handler
    )
    expect(items).toEqual([])
  })
})
