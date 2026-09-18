import { afterEach, describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  BUILTIN_AGENT_IDS,
  setCustomAgentBaseResolver,
  type AgentId,
  type BuiltinAgentId
} from '@shared/agents/config'
import { AgentIcon } from './agentIcons'

const renderIcon = (agentId: AgentId, size = 18): string =>
  renderToStaticMarkup(<AgentIcon agentId={agentId} size={size} />)

afterEach(() => setCustomAgentBaseResolver(null))

describe('AgentIcon custom-agent inheritance', () => {
  it('renders the exact base harness icon for inheriting custom agents', () => {
    const bases: BuiltinAgentId[] = [...BUILTIN_AGENT_IDS]
    setCustomAgentBaseResolver((id) => {
      const base = id.startsWith('custom:') ? id.slice('custom:'.length) : ''
      return bases.includes(base as BuiltinAgentId) ? (base as BuiltinAgentId) : undefined
    })

    for (const base of bases) {
      expect(renderIcon(`custom:${base}`), base).toBe(renderIcon(base))
    }
  })

  it('keeps the terminal fallback for baseless custom agents', () => {
    setCustomAgentBaseResolver(() => undefined)

    const custom = renderIcon('custom:plain')
    expect(custom).not.toBe(renderIcon('claude'))
    expect(custom).not.toBe(renderIcon('grok'))
    expect(custom).toContain('<svg')
  })

  it('preserves the requested size after resolving the base icon', () => {
    setCustomAgentBaseResolver((id) => (id === 'custom:claude' ? 'claude' : undefined))
    expect(renderIcon('custom:claude', 23)).toBe(renderIcon('claude', 23))
  })

  it('uses the node snapshot when the custom definition no longer exists', () => {
    setCustomAgentBaseResolver(() => undefined)
    expect(
      renderToStaticMarkup(
        <AgentIcon agentId="custom:deleted" agentBaseId="claude" size={21} />
      )
    ).toBe(renderIcon('claude', 21))
  })
})
