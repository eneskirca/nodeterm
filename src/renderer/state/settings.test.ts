import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/types'
import { useSettings } from './settings'

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
