import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/types'
import { useSettings } from './settings'
import { useModelGateway } from './modelGateway'

describe('coalesced settings save', () => {
  const g = globalThis as { window?: unknown }

  afterEach(() => {
    delete g.window
    vi.useRealTimers()
  })

  // A jsdom test file can end inside the coalesce window: vitest then deletes `window` from the
  // globals while the Node timer is still pending, and a callback that dereferences `window`
  // throws an unhandled ReferenceError that fails the whole run.
  it('drops the pending save when window is gone by the time the timer fires', () => {
    vi.useFakeTimers()
    const save = vi.fn(async (_s: unknown) => undefined)
    g.window = { nodeTerminal: { settings: { save } } }
    useSettings.getState().update({ panHoverDelay: 123 })
    delete g.window

    expect(() => vi.runAllTimers()).not.toThrow()
    expect(save).not.toHaveBeenCalled()
  })

  it('still writes the latest snapshot once when window is present', () => {
    vi.useFakeTimers()
    const save = vi.fn(async (_s: unknown) => undefined)
    g.window = { nodeTerminal: { settings: { save } } }
    useSettings.getState().update({ panHoverDelay: 1 })
    useSettings.getState().update({ panHoverDelay: 2 })
    vi.runAllTimers()

    expect(save).toHaveBeenCalledTimes(1)
    expect(save.mock.calls[0][0]).toMatchObject({ panHoverDelay: 2 })
  })
})

describe('agent launch mode settings mirror', () => {
  beforeEach(() => {
    useSettings.setState({ settings: { ...DEFAULT_SETTINGS }, hydrated: false })
  })

  it('keeps the legacy boolean synchronized with every launch mode update', () => {
    useSettings.getState().update({ agentLaunchMode: 'subscription' })
    expect(useSettings.getState().settings.vanillaLaunchDefault).toBe(true)

    useSettings.getState().update({ agentLaunchMode: 'gateway' })
    expect(useSettings.getState().settings.vanillaLaunchDefault).toBe(false)

    useSettings.getState().update({ agentLaunchMode: 'gateway-model' })
    expect(useSettings.getState().settings.vanillaLaunchDefault).toBe(false)
  })
})

describe('gateway discovery invalidation', () => {
  beforeEach(() => {
    ;(globalThis as unknown as { window: unknown }).window = {
      nodeTerminal: { settings: { load: vi.fn(), save: vi.fn() } }
    }
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
    vi.mocked((globalThis as { window: { nodeTerminal: { settings: { load: () => Promise<unknown> } } } }).window.nodeTerminal.settings.load).mockResolvedValue({
      ...DEFAULT_SETTINGS,
      modelGateway: { baseUrl: 'https://new.test', apiKey: 'new' }
    })

    await useSettings.getState().hydrate()

    expect(useModelGateway.getState()).toMatchObject({ models: [], status: 'idle' })
  })
})
