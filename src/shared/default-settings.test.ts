import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from './types'

describe('DEFAULT_SETTINGS', () => {
  it('enables git auto-fetch by default', () => {
    expect(DEFAULT_SETTINGS.gitAutoFetch).toBe(true)
  })

  it('ships pty shadow clients ON, so the kill switch is a real one', () => {
    // Default OFF would mean the mechanism never runs in the field and the flag proves nothing;
    // default ON means a field report can be answered with "turn it off", and that instruction
    // reaches existing installs through the { ...DEFAULT_SETTINGS, ...saved } merge.
    expect(DEFAULT_SETTINGS.ptyShadowClients).toBe(true)
  })

  it('defaults to auto permission mode for new and existing users', () => {
    // Deliberate behavior change: auto mode ensures Claude sessions start with
    // permission auto-grants enabled. This reaches existing users via
    // { ...DEFAULT_SETTINGS, ...saved } hydration. Do not change without a decision.
    expect(DEFAULT_SETTINGS.claudePermissionMode).toBe('auto')
  })
})
