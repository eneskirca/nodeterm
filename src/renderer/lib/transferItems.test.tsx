import { describe, it, expect } from 'vitest'
import { transferTargets, transferConversationItems, type TransferConversationArgs } from './transferItems'
import type { AgentId } from '@shared/agents/config'
import type { CustomAgent } from '@shared/types'
import type { GatewayModel } from '@shared/agents/model-gateway'
import type { MenuItem } from '../components/ContextMenu'

const customs: CustomAgent[] = [
  { id: 'custom:a', label: 'Agent A', launchCmd: 'a', promptInjectionMode: 'argv' },
  { id: 'custom:b', label: 'Agent B', launchCmd: 'b', promptInjectionMode: 'argv' }
]

const claudeCustom: CustomAgent = {
  id: 'custom:claude-proxy',
  label: 'Claude Proxy',
  launchCmd: 'proxy',
  baseAgent: 'claude',
  promptInjectionMode: 'argv'
}

const models: GatewayModel[] = [
  { id: 'claude-sonnet-5' },
  { id: 'claude-opus-5' }
]

/** Minimal args with sensible defaults; tests override the fields that matter. */
const args = (over: Partial<TransferConversationArgs>): TransferConversationArgs => ({
  sourceAgentId: 'claude' as AgentId,
  sessionId: 'sess-1',
  disabledAgents: [],
  customAgents: customs,
  gatewayModels: [],
  ...over
})

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

/** The targets inside the single "Transfer conversation ▸" submenu the builder returns. */
function rowsOf(items: MenuItem[]): MenuItem[] {
  expect(items).toHaveLength(1)
  const sub = items[0]
  if (sub.type !== 'submenu') throw new Error('expected the Transfer conversation submenu')
  expect(sub.label).toBe('Transfer conversation')
  return sub.children
}

describe('transferConversationItems', () => {
  const handler = () => {}

  it('returns ONE submenu holding a row per target for a transfer-capable agent with a session', () => {
    const items = transferConversationItems('node-1', undefined, args({}), handler)
    expect(rowsOf(items).length).toBeGreaterThan(1)
  })

  it('returns [] when the agent is not transfer-capable', () => {
    // opencode, not grok: grok joined TRANSFER_SOURCE_CAPABLE once `renderGrokTranscript` existed.
    // The list is the gate, so this case needs an agent whose renderer is genuinely unwritten —
    // otherwise it asserts nothing the moment that agent gains one.
    const items = transferConversationItems(
      'node-1',
      undefined,
      args({ sourceAgentId: 'opencode' as AgentId, customAgents: [] }),
      handler
    )
    expect(items).toEqual([])
  })

  it('offers targets for a grok source, now that its transcript can be rendered', () => {
    const items = transferConversationItems(
      'node-1',
      undefined,
      args({ sourceAgentId: 'grok' as AgentId, customAgents: [] }),
      handler
    )
    // grok is never offered as a destination for itself; every other builtin still is.
    const labels = rowsOf(items).map((i) => ('label' in i ? i.label : ''))
    expect(labels).not.toContain('Grok')
    expect(labels).toContain('Claude Code')
  })

  it('returns [] when there is no session id yet', () => {
    const items = transferConversationItems(
      'node-1',
      undefined,
      args({ sessionId: undefined, customAgents: [] }),
      handler
    )
    expect(items).toEqual([])
  })

  it('returns [] when sourceAgentId is undefined (not an agent node)', () => {
    const items = transferConversationItems(
      'node-1',
      undefined,
      args({ sourceAgentId: undefined, customAgents: [] }),
      handler
    )
    expect(items).toEqual([])
  })

  it('renders a switch-capable target as a nested model submenu when models are discovered', () => {
    // claude source → codex is a switch-capable target. With discovered models, codex becomes a
    // submenu: "Default model" + one row per model.
    const items = transferConversationItems(
      'node-1',
      undefined,
      args({ sourceAgentId: 'claude' as AgentId, customAgents: [], gatewayModels: models }),
      handler
    )
    const codex = rowsOf(items).find(
      (i): i is Extract<typeof i, { type: 'submenu' }> => i.type === 'submenu' && i.label === 'Codex'
    )
    expect(codex).toBeDefined()
    expect(codex!.children.map((c) => ('label' in c ? c.label : ''))).toEqual([
      'Default model',
      'claude-sonnet-5',
      'claude-opus-5'
    ])
  })

  it('renders a claude-base custom agent as a nested model submenu (base-resolved capability)', () => {
    const items = transferConversationItems(
      'node-1',
      undefined,
      args({ sourceAgentId: 'codex' as AgentId, customAgents: [claudeCustom], gatewayModels: models }),
      handler
    )
    const proxy = rowsOf(items).find(
      (i): i is Extract<typeof i, { type: 'submenu' }> => i.type === 'submenu' && i.label === 'Claude Proxy'
    )
    expect(proxy).toBeDefined()
    expect(proxy!.children.length).toBe(3) // Default + 2 models
  })

  it('renders a non-capable target (gemini) as a flat row even with models discovered', () => {
    const items = transferConversationItems(
      'node-1',
      undefined,
      args({ sourceAgentId: 'claude' as AgentId, customAgents: [], gatewayModels: models }),
      handler
    )
    const gemini = rowsOf(items).find((i) => 'label' in i && i.label === 'Gemini')
    expect(gemini).toBeDefined()
    expect(gemini).not.toMatchObject({ type: 'submenu' }) // flat row, not a submenu
  })

  it('renders switch-capable targets as flat rows when no models are discovered', () => {
    // gateway unconfigured / loading → empty gatewayModels → codex stays flat (transfer with default).
    const items = transferConversationItems(
      'node-1',
      undefined,
      args({ sourceAgentId: 'claude' as AgentId, customAgents: [], gatewayModels: [] }),
      handler
    )
    const codex = rowsOf(items).find((i) => 'label' in i && i.label === 'Codex')
    expect(codex).toBeDefined()
    expect(codex).not.toMatchObject({ type: 'submenu' })
  })

  it('renders switch-capable targets as flat rows for a relay source (no local gateway)', () => {
    const items = transferConversationItems(
      'node-1',
      undefined,
      args({ sourceAgentId: 'claude' as AgentId, customAgents: [], gatewayModels: models, relaySession: true }),
      handler
    )
    const codex = rowsOf(items).find((i) => 'label' in i && i.label === 'Codex')
    expect(codex).toBeDefined()
    expect(codex).not.toMatchObject({ type: 'submenu' })
  })

  it('passes the chosen model to the handler for a model-submenu row', () => {
    const calls: Array<{ agent: AgentId; model?: string }> = []
    const handler = (_n: string, agent: AgentId, _at: unknown, model?: string) =>
      calls.push({ agent, model })
    const items = transferConversationItems(
      'node-1',
      undefined,
      args({ sourceAgentId: 'claude' as AgentId, customAgents: [], gatewayModels: models }),
      handler as never
    )
    const codex = rowsOf(items).find(
      (i): i is Extract<typeof i, { type: 'submenu' }> => i.type === 'submenu' && i.label === 'Codex'
    )!
    // "Default model" row → no model
    const defaultRow = codex.children[0] as { onClick: () => void }
    defaultRow.onClick()
    // A model row → that model id
    const modelRow = codex.children[1] as { onClick: () => void }
    modelRow.onClick()
    expect(calls).toEqual([
      { agent: 'codex' as AgentId, model: undefined },
      { agent: 'codex' as AgentId, model: 'claude-sonnet-5' }
    ])
  })
})
