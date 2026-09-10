import { afterEach, describe, expect, it } from 'vitest'
import { setCustomAgentBaseResolver } from '@shared/agents/config'
import { mesaAgentOptions, mesaDefaultModel, mesaModelsFor, workerLaunchSpec } from './mesaModels'
import { DEFAULT_GROK_MODEL } from '@shared/agents/grok-models'

afterEach(() => setCustomAgentBaseResolver(null))

describe('mesaModelsFor', () => {
  it('offers grok native models without a gateway catalogue', () => {
    const ids = mesaModelsFor('grok', []).map((m) => m.id)
    expect(ids).toContain(DEFAULT_GROK_MODEL)
    expect(ids.length).toBeGreaterThan(0)
  })

  it('offers gateway models to Claude and nothing to Gemini', () => {
    const gateway = [{ id: 'anthropic/claude-sonnet-4', name: 'Sonnet' }]
    expect(mesaModelsFor('claude', gateway).map((m) => m.id)).toEqual(['anthropic/claude-sonnet-4'])
    expect(mesaModelsFor('gemini', gateway)).toEqual([])
  })
})

describe('mesaDefaultModel', () => {
  it('does not invent a model for an agent with no catalogue', () => {
    expect(mesaDefaultModel('gemini', [])).toBe('')
    expect(mesaDefaultModel('claude', [])).toBe('')
  })

  it('stamps grok-4.6 only when the chosen CLI is grok', () => {
    expect(mesaDefaultModel('grok', [])).toBe(DEFAULT_GROK_MODEL)
  })

  it('resolves a custom grok harness through capabilityAgentId', () => {
    setCustomAgentBaseResolver((id) => (id === 'custom:g' ? 'grok' : undefined))
    expect(mesaDefaultModel('custom:g', [])).toBe(DEFAULT_GROK_MODEL)
    expect(mesaModelsFor('custom:g', []).map((m) => m.id)).toContain(DEFAULT_GROK_MODEL)
  })

  it('resolves a custom claude harness through the gateway catalogue', () => {
    setCustomAgentBaseResolver((id) => (id === 'custom:c' ? 'claude' : undefined))
    const gateway = [{ id: 'anthropic/claude-sonnet-4', name: 'Sonnet' }]
    expect(mesaModelsFor('custom:c', gateway).map((m) => m.id)).toEqual(['anthropic/claude-sonnet-4'])
  })
})

describe('mesaAgentOptions', () => {
  const empty = { customAgents: [], disabledAgents: [] as string[] }

  it('lists every builtin CLI, not grok alone', () => {
    const ids = mesaAgentOptions(empty).map((a) => a.id)
    expect(ids).toEqual(['claude', 'codex', 'gemini', 'opencode', 'grok', 'copilot'])
  })

  it('appends custom CLIs and honors disabledAgents', () => {
    const ids = mesaAgentOptions({
      customAgents: [{ id: 'custom:mine', label: 'My CLI' }],
      disabledAgents: ['grok', 'copilot']
    }).map((a) => a.id)
    expect(ids).toContain('claude')
    expect(ids).toContain('custom:mine')
    expect(ids).not.toContain('grok')
    expect(ids).not.toContain('copilot')
  })
})

describe('workerLaunchSpec', () => {
  it('follows the mission agent, not a later composer pick', () => {
    expect(
      workerLaunchSpec({
        preferredAgent: 'grok',
        modelPolicy: 'auto',
        fallbackAgent: 'claude'
      })
    ).toEqual({ agentId: 'grok', runtime: true, permissionMode: 'bypassPermissions' })
  })

  it('pins the mission model only under pinned policy', () => {
    expect(
      workerLaunchSpec({
        preferredAgent: 'claude',
        modelPolicy: 'pinned',
        pinnedModel: 'anthropic/claude-sonnet-4',
        fallbackAgent: 'grok'
      })
    ).toEqual({
      agentId: 'claude',
      model: 'anthropic/claude-sonnet-4',
      runtime: true,
      permissionMode: 'bypassPermissions'
    })
    expect(
      workerLaunchSpec({
        preferredAgent: 'claude',
        modelPolicy: 'auto',
        pinnedModel: 'anthropic/claude-sonnet-4'
      }).model
    ).toBeUndefined()
  })
})
