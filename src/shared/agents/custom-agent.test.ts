import { afterEach, describe, expect, it } from 'vitest'
import {
  baseAgentOf,
  canResume,
  capabilityAgentId,
  hasHooks,
  hasPermissionMode,
  mintsSessionId,
  setCustomAgentBaseResolver
} from './config'
import { findCustomAgent, resolveAgentConfig } from './custom-agent'
import type { CustomAgent } from '../types'

const claudeProxy: CustomAgent = {
  id: 'custom:proxy',
  label: 'Claude (proxy)',
  launchCmd: 'claude-wopr',
  baseAgent: 'claude',
  env: { ANTHROPIC_AUTH_TOKEN: '${env:MY_TOKEN}' },
  args: '--model ${env:MY_MODEL}'
}
const vanilla: CustomAgent = {
  id: 'custom:aider',
  label: 'Aider',
  launchCmd: 'aider',
  promptInjectionMode: 'argv'
}

afterEach(() => setCustomAgentBaseResolver(null))

describe('resolveAgentConfig — builtins', () => {
  it('returns the builtin config untouched', () => {
    const c = resolveAgentConfig('claude')
    expect(c).toMatchObject({
      label: 'Claude Code',
      color: '#d97757',
      launchCmd: 'claude',
      promptInjectionMode: 'argv',
      custom: false
    })
    expect(c.argvPromptSeparator).toBeUndefined()
  })
  it('grok carries its separator', () => {
    expect(resolveAgentConfig('grok').argvPromptSeparator).toBe('--')
  })
})

describe('resolveAgentConfig — custom without a base', () => {
  it('uses the custom fields and falls back to grey / argv', () => {
    const c = resolveAgentConfig('custom:aider', vanilla)
    expect(c).toMatchObject({
      label: 'Aider',
      launchCmd: 'aider',
      promptInjectionMode: 'argv',
      color: '#888888',
      custom: true
    })
    expect(c.argvPromptSeparator).toBeUndefined()
    expect(c.expectedProcess).toBeUndefined()
  })
})

describe('resolveAgentConfig — custom with a base harness', () => {
  it('inherits the base command when launchCmd is blank', () => {
    const blank: CustomAgent = { id: 'custom:proxy2', label: 'P', launchCmd: '', baseAgent: 'claude' }
    expect(resolveAgentConfig('custom:proxy2', blank).launchCmd).toBe('claude')
  })
  it('uses the custom launchCmd when set', () => {
    expect(resolveAgentConfig('custom:proxy', claudeProxy).launchCmd).toBe('claude-wopr')
  })
  it('inherits promptInjectionMode / separator / expectedProcess from the base', () => {
    const c = resolveAgentConfig('custom:proxy', claudeProxy)
    expect(c.promptInjectionMode).toBe('argv')
    expect(c.expectedProcess).toBe('claude')
    expect(c.baseAgent).toBe('claude')
  })
  it('ignores a stale flag-prompt on a claude-base agent (claude takes a positional, not --prompt)', () => {
    const stale: CustomAgent = {
      id: 'custom:stale',
      label: 'Stale',
      launchCmd: 'claude-wopr',
      baseAgent: 'claude',
      promptInjectionMode: 'flag-prompt'
    }
    // The prompt grammar is the harness's, not the record's: claude rejects `--prompt`, so a
    // stale flag-prompt must NOT win over the base's `argv`.
    expect(resolveAgentConfig('custom:stale', stale).promptInjectionMode).toBe('argv')
  })
  it('a baseless custom agent keeps its own promptInjectionMode', () => {
    expect(resolveAgentConfig('custom:aider', vanilla).promptInjectionMode).toBe('argv')
    const flagPrompt: CustomAgent = {
      id: 'custom:fp',
      label: 'FP',
      launchCmd: 'opencode',
      promptInjectionMode: 'flag-prompt'
    }
    expect(resolveAgentConfig('custom:fp', flagPrompt).promptInjectionMode).toBe('flag-prompt')
  })
  it('inherits color from the base when the custom record has none', () => {
    expect(resolveAgentConfig('custom:proxy', claudeProxy).color).toBe('#d97757')
  })
})

describe('capability inheritance via the resolver registry', () => {
  it('a custom agent with no resolver registered inherits nothing', () => {
    setCustomAgentBaseResolver(null)
    expect(hasHooks('custom:proxy')).toBe(false)
    expect(canResume('custom:proxy')).toBe(false)
    expect(mintsSessionId('custom:proxy')).toBe(false)
    expect(hasPermissionMode('custom:proxy')).toBe(false)
    expect(capabilityAgentId('custom:proxy')).toBe('custom:proxy')
  })
  it('registering a baseAgent resolver makes the custom agent inherit that harness', () => {
    setCustomAgentBaseResolver((id) => (id === 'custom:proxy' ? 'claude' : undefined))
    expect(baseAgentOf('custom:proxy')).toBe('claude')
    expect(baseAgentOf('claude')).toBeUndefined() // builtins never resolve through the registry
    expect(capabilityAgentId('custom:proxy')).toBe('claude')
    expect(hasHooks('custom:proxy')).toBe(true)
    expect(canResume('custom:proxy')).toBe(true)
    expect(mintsSessionId('custom:proxy')).toBe(true)
    expect(hasPermissionMode('custom:proxy')).toBe(true)
  })
  it('builtins are unaffected by the resolver', () => {
    setCustomAgentBaseResolver((id) => (id === 'custom:proxy' ? 'claude' : undefined))
    expect(hasHooks('codex')).toBe(true)
    expect(mintsSessionId('gemini')).toBe(false)
  })
})

describe('findCustomAgent', () => {
  it('finds a custom agent by id and returns undefined for builtins', () => {
    expect(findCustomAgent([claudeProxy, vanilla], 'custom:proxy')).toBe(claudeProxy)
    expect(findCustomAgent([claudeProxy, vanilla], 'claude')).toBeUndefined()
    expect(findCustomAgent([claudeProxy, vanilla], 'custom:nope')).toBeUndefined()
  })
})
