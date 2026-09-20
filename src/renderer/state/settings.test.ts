// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/types'
import { useSettings } from './settings'
import { useModelGateway } from './modelGateway'

describe('agent launch mode settings mirror', () => {
  beforeEach(() => {
    ;(window as unknown as { nodeTerminal: any }).nodeTerminal = {
      settings: { load: vi.fn(), save: vi.fn() }
    }
    useSettings.setState({ settings: { ...DEFAULT_SETTINGS }, hydrated: false })
    useModelGateway.setState({
      models: [{ id: 'old', contextWindow: 1_000_000 }],
      status: 'ready',
      error: ''
    })
  })

  it('keeps the legacy boolean synchronized with every launch mode update', () => {
    useSettings.getState().update({ agentLaunchMode: 'subscription' })
    expect(useSettings.getState().settings.vanillaLaunchDefault).toBe(true)

    useSettings.getState().update({ agentLaunchMode: 'gateway' })
    expect(useSettings.getState().settings.vanillaLaunchDefault).toBe(false)

    useSettings.getState().update({ agentLaunchMode: 'gateway-model' })
    expect(useSettings.getState().settings.vanillaLaunchDefault).toBe(false)
  })

  it('invalidates discovery synchronously when gateway configuration changes', () => {
    useSettings.setState({
      settings: {
        ...DEFAULT_SETTINGS,
        modelGateway: { baseUrl: 'https://gateway.test', apiKey: '${env:OLD}' }
      },
      hydrated: true
    })

    useSettings.getState().update({
      modelGateway: {
        baseUrl: 'https://gateway.test',
        apiKey: '${env:OLD}',
        discoveryPath: '/openai/v1/models'
      }
    })

    expect(useModelGateway.getState()).toMatchObject({ models: [], status: 'idle' })
  })

  it('invalidates discovery when hydrate loads a different gateway configuration', async () => {
    useSettings.setState({
      settings: {
        ...DEFAULT_SETTINGS,
        modelGateway: { baseUrl: 'https://old.test', apiKey: 'old' }
      },
      hydrated: false
    })
    vi.mocked(window.nodeTerminal.settings.load).mockResolvedValue({
      ...DEFAULT_SETTINGS,
      modelGateway: { baseUrl: 'https://new.test', apiKey: 'new' }
    })

    await useSettings.getState().hydrate()

    expect(useModelGateway.getState()).toMatchObject({ models: [], status: 'idle' })
  })
})
