import { describe, it, expect, afterEach } from 'vitest'
import { vanillaEnvStripPattern, setCustomAgentBaseResolver } from './config'

afterEach(() => setCustomAgentBaseResolver(null))

describe('vanillaEnvStripPattern', () => {
  it('claude strips ANTHROPIC_* + the OAuth token but keeps the config dir', () => {
    const re = vanillaEnvStripPattern('claude')!
    expect(re).not.toBeNull()
    // Provider + inherited auth vars the gateway and a LaunchAgent export.
    expect(re.test('ANTHROPIC_BASE_URL')).toBe(true)
    expect(re.test('ANTHROPIC_AUTH_TOKEN')).toBe(true)
    expect(re.test('ANTHROPIC_API_KEY')).toBe(true)
    expect(re.test('CLAUDE_CODE_OAUTH_TOKEN')).toBe(true)
    // The managed-account config dir is NOT a provider credential — stripping it would break
    // account isolation, so the pattern must leave it alone.
    expect(re.test('CLAUDE_CONFIG_DIR')).toBe(false)
    // nodeterm's own code constants (not env the pane sets) are left alone.
    expect(re.test('CLAUDE_HOOK_EVENTS')).toBe(false)
  })

  it('codex strips only the two known gateway vars', () => {
    const re = vanillaEnvStripPattern('codex')!
    expect(re.test('OPENAI_BASE_URL')).toBe(true)
    expect(re.test('OPENAI_API_KEY')).toBe(true)
    // Codex credentials live under CODEX_HOME (a config dir), not CODEX_* env — a broad strip is
    // unverified, so unrelated OPENAI_* the user may set must survive.
    expect(re.test('OPENAI_ORG_ID')).toBe(false)
    expect(re.test('CODEX_HOME')).toBe(false)
  })

  it('copilot strips COPILOT_PROVIDER_* but keeps the home dir + hook constants', () => {
    const re = vanillaEnvStripPattern('copilot')!
    expect(re.test('COPILOT_PROVIDER_API_KEY')).toBe(true)
    expect(re.test('COPILOT_PROVIDER_BASE_URL')).toBe(true)
    expect(re.test('COPILOT_HOME')).toBe(false)
    expect(re.test('COPILOT_HOOK_EVENTS')).toBe(false)
  })

  it('gemini/grok/opencode have no pattern (the action is hidden for them)', () => {
    expect(vanillaEnvStripPattern('gemini')).toBeNull()
    expect(vanillaEnvStripPattern('grok')).toBeNull()
    expect(vanillaEnvStripPattern('opencode')).toBeNull()
    // A plain custom agent with no base inherits nothing.
    expect(vanillaEnvStripPattern('custom:plain')).toBeNull()
  })

  it('a custom agent inherits its base harness pattern', () => {
    setCustomAgentBaseResolver((id) => (id === 'custom:proxy' ? 'claude' : undefined))
    const re = vanillaEnvStripPattern('custom:proxy')!
    expect(re.test('ANTHROPIC_BASE_URL')).toBe(true)
    expect(re.test('CLAUDE_CONFIG_DIR')).toBe(false)
  })

  it('is cached: the same source compiles once', () => {
    const a = vanillaEnvStripPattern('claude')
    const b = vanillaEnvStripPattern('claude')
    expect(a).toBe(b) // referentially identical — the cache returns the same compiled RegExp
  })
})
