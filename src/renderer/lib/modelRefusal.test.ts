import { describe, expect, it } from 'vitest'
import { gatewayCatalogueKey, modelCheckApplies, unknownModelRefusal, type ModelRefusalInput } from './modelRefusal'
import type { ProjectLaunchInfo } from '@shared/project-settings'

const gateway = { baseUrl: 'https://gw.example', apiKey: '${env:GW_KEY}' }
const info = (agents: ProjectLaunchInfo['resolved']['agents'] = {}): ProjectLaunchInfo => ({
  resolved: { setup: {}, worktree: {}, agents, terminal: {} },
  trusted: { agents: true, shell: true }
})
const base = (over: Partial<ModelRefusalInput> = {}): ModelRefusalInput => ({
  agentId: 'claude',
  model: 'claude-sonnet-9',
  catalogue: {
    models: [{ id: 'anthropic/claude-opus-5' }, { id: 'gpt-6' }, { id: 'claude-haiku-5' }],
    status: 'ready',
    forKey: gatewayCatalogueKey(gateway)
  },
  gateway,
  launchMode: 'gateway',
  projectInfo: info(),
  ...over
})

describe('unknownModelRefusal (issue #519) — refuses only a confident negative', () => {
  it('refuses an id the current, finished catalogue does not list, naming the list', () => {
    const r = unknownModelRefusal(base())
    expect(r).toMatch(/--model "claude-sonnet-9" is not in the model list your model gateway reports for claude/)
    expect(r).toMatch(/anthropic\/claude-opus-5, gpt-6, claude-haiku-5/)
    expect(r).toMatch(/Nothing was opened/)
  })

  it('accepts listed ids, provider-prefixed in either direction, any case', () => {
    for (const model of ['claude-haiku-5', 'CLAUDE-HAIKU-5', 'claude-opus-5', 'anthropic/claude-haiku-5', 'claude-opus-5[1m]'])
      expect(unknownModelRefusal(base({ model })), model).toBeNull()
    expect(unknownModelRefusal(base({ agentId: 'codex', model: 'gpt-6' }))).toBeNull()
  })

  it('passes claude aliases through: the CLI resolves them itself', () => {
    for (const model of ['sonnet', 'opus', 'haiku', 'opusplan', 'sonnet[1m]'])
      expect(unknownModelRefusal(base({ model })), model).toBeNull()
  })

  it('passes through whenever the list is not a trustworthy answer', () => {
    const cases: Partial<ModelRefusalInput>[] = [
      { model: undefined },
      { model: '  ' },
      { agentId: 'grok' },
      { agentId: 'gemini' },
      { agentId: 'custom:abc' },
      { launchMode: 'subscription' },
      { gateway: { baseUrl: '', apiKey: '' } },
      { gateway: { baseUrl: 'https://other.example', apiKey: 'k' } },
      { catalogue: { models: [{ id: 'x' }], status: 'loading', forKey: gatewayCatalogueKey(gateway) } },
      { catalogue: { models: [{ id: 'x' }], status: 'error', forKey: gatewayCatalogueKey(gateway) } },
      { catalogue: { models: [], status: 'ready', forKey: gatewayCatalogueKey(gateway) } },
      { projectInfo: null },
      { projectInfo: undefined },
      { relay: true },
      { projectInfo: info({ env: { value: { ANTHROPIC_BASE_URL: 'x' }, source: 'local' } }) },
      { projectInfo: info({ launchCmd: { value: 'my-claude', source: 'shared' } }) }
    ]
    for (const c of cases) expect(unknownModelRefusal(base(c)), JSON.stringify(c)).toBeNull()
  })

  it('codex and copilot are checked the same way', () => {
    expect(unknownModelRefusal(base({ agentId: 'codex', model: 'gpt-7' }))).toMatch(/for codex/)
    expect(unknownModelRefusal(base({ agentId: 'copilot', model: 'openai/gpt-7' }))).toMatch(/for copilot/)
  })

  it('does not quote hostile ids from the gateway or the caller', () => {
    const r = unknownModelRefusal(base({
      model: 'bad\u001b[31m',
      catalogue: { models: [{ id: 'ok-1' }, { id: 'evil\nline' }], status: 'ready', forKey: gatewayCatalogueKey(gateway) }
    }))
    expect(r).toMatch(/--model "that id"/)
    expect(r).toMatch(/\(ok-1\)/)
    expect(r).not.toMatch(/evil/)
  })

  it('modelCheckApplies says false before any lookup is needed', () => {
    expect(modelCheckApplies(base())).toBe(true)
    expect(modelCheckApplies(base({ model: 'sonnet' }))).toBe(false)
    expect(modelCheckApplies(base({ launchMode: 'subscription' }))).toBe(false)
  })
})
