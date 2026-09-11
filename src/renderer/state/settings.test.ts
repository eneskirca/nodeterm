import { beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/types'
import { useSettings } from './settings'

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
