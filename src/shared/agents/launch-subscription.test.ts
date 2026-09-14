import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { assembleResumeCommand } from './launch'
import { setCustomAgentBaseResolver } from './config'

afterEach(() => setCustomAgentBaseResolver(null))

describe('subscription resume', () => {
  it('keeps the Codex conversation while overriding its saved gateway provider/model', () => {
    const { command } = assembleResumeCommand({
      agentId: 'codex',
      sessionId: 'saved-conversation',
      model: 'vllm/reasoning',
      clearEnv: true,
      sharedIdentity: true
    }, {})
    // Codex's shared daemon ignores resume overrides for an already-loaded thread. This must
    // be a plain client with an explicit config override, even when shared identity is available.
    expect(command).toBe('codex resume saved-conversation -c \'model_provider="openai"\'')
  })

  it('keeps ordinary gateway resumes on the shared launcher with their selected model', () => {
    const { command } = assembleResumeCommand({
      agentId: 'codex', sessionId: 'saved-conversation', model: 'vllm/reasoning', sharedIdentity: true
    }, {})
    expect(command).toBe("nodeterm-codex resume saved-conversation --model 'vllm/reasoning'")
  })

  it('carries the reset into the missing-conversation fresh-launch fallback', () => {
    expect(assembleResumeCommand({
      agentId: 'codex', clearEnv: true, sharedIdentity: true
    }, {}).command).toBe('codex -c \'model_provider="openai"\'')
  })

  it('retains a custom Codex program, arguments, and permissions', () => {
    setCustomAgentBaseResolver((id) => id === 'custom:codex' ? 'codex' : undefined)
    const { command } = assembleResumeCommand({
      agentId: 'custom:codex',
      customAgent: {
        id: 'custom:codex', label: 'Custom Codex', baseAgent: 'codex',
        launchCmd: 'my-codex', args: '--search'
      },
      sessionId: 'saved-conversation', clearEnv: true, permissionMode: 'auto'
    }, {})
    expect(command).toContain("my-codex '--search' resume saved-conversation")
    expect(command).toContain('-c \'model_provider="openai"\'')
    expect(command).toContain('--ask-for-approval on-request')
    expect(command).not.toContain('nodeterm-codex')
  })

  it.each(['claude', 'copilot'] as const)('drops %s gateway model without Codex flags', (agentId) => {
    const { command } = assembleResumeCommand({
      agentId, sessionId: 'saved-conversation', model: 'vllm/reasoning', clearEnv: true
    }, {})
    expect(command).toContain('saved-conversation')
    expect(command).not.toContain('--model')
    expect(command).not.toContain('model_provider')
  })

  it('leaves a native model alone when the harness has no subscription strip mode', () => {
    const inputs = { agentId: 'grok', sessionId: 'saved-conversation', model: 'grok-native' }
    expect(assembleResumeCommand({ ...inputs, clearEnv: true }, {}).command)
      .toBe(assembleResumeCommand(inputs, {}).command)
    expect(assembleResumeCommand(inputs, {}).command).toContain("--model 'grok-native'")
  })

  it.skipIf(process.platform === 'win32')('delivers the provider override as one literal TOML argument', () => {
    const { command } = assembleResumeCommand({
      agentId: 'codex', sessionId: 'saved-conversation', clearEnv: true, sharedIdentity: true
    }, {})
    const argv = execFileSync('/bin/sh', ['-c',
      `codex() { printf '%s\\0' "$@"; }; ${command}`
    ], { encoding: 'utf8' }).split('\0').slice(0, -1)
    expect(argv).toEqual(['resume', 'saved-conversation', '-c', 'model_provider="openai"'])
  })
})
