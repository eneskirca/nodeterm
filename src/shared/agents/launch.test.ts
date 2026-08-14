import { afterEach, describe, expect, it } from 'vitest'
import { assembleLaunchCommand, assembleResumeCommand } from './launch'
import { setCustomAgentBaseResolver } from './config'
import type { CustomAgent } from '../types'

const ENV = { MY_MODEL: 'sonnet', MY_TOKEN: 'sk-abc' }

const claudeProxy: CustomAgent = {
  id: 'custom:proxy',
  label: 'Claude (proxy)',
  launchCmd: 'claude-wopr',
  baseAgent: 'claude',
  args: '--model ${env:MY_MODEL}'
}
const aider: CustomAgent = {
  id: 'custom:aider',
  label: 'Aider',
  launchCmd: 'aider',
  promptInjectionMode: 'argv'
}

afterEach(() => setCustomAgentBaseResolver(null))

describe('assembleLaunchCommand — builtins (byte-identical to the historical path)', () => {
  it('claude bare', () => {
    expect(assembleLaunchCommand({ agentId: 'claude' }, ENV).command).toBe('claude')
  })
  it("claude with a prompt", () => {
    expect(assembleLaunchCommand({ agentId: 'claude', initialPrompt: 'fix the bug' }, ENV).command).toBe(
      "claude 'fix the bug'"
    )
  })
  it('claude with prompt + permission mode + minted session id', () => {
    expect(
      assembleLaunchCommand(
        { agentId: 'claude', initialPrompt: 'fix', permissionMode: 'auto', sessionId: 'abc-123', sessionIdFlagSupported: true },
        ENV
      ).command
    ).toBe("claude 'fix' --permission-mode auto --session-id abc-123")
  })
  it('claude omits --session-id when the CLI does not support it', () => {
    expect(
      assembleLaunchCommand(
        { agentId: 'claude', sessionId: 'abc-123', sessionIdFlagSupported: false },
        ENV
      ).command
    ).toBe('claude')
  })
  it('grok puts the permission flag BEFORE the -- separator', () => {
    expect(
      assembleLaunchCommand({ agentId: 'grok', initialPrompt: 'version', permissionMode: 'plan' }, ENV).command
    ).toBe("grok --permission-mode plan -- 'version'")
  })
  it('opencode uses --prompt (flag-prompt mode)', () => {
    expect(
      assembleLaunchCommand({ agentId: 'opencode', initialPrompt: 'fix it' }, ENV).command
    ).toBe("opencode --prompt 'fix it'")
  })
})

describe('assembleLaunchCommand — custom agents', () => {
  it('a vanilla custom agent launches with its command + prompt', () => {
    expect(
      assembleLaunchCommand({ agentId: 'custom:aider', customAgent: aider, initialPrompt: 'hi' }, ENV).command
    ).toBe("aider 'hi'")
  })
  it('a claude-base proxy inherits the claude command grammar + flags', () => {
    setCustomAgentBaseResolver((id) => (id === 'custom:proxy' ? 'claude' : undefined))
    const r = assembleLaunchCommand(
      { agentId: 'custom:proxy', customAgent: claudeProxy, initialPrompt: 'fix', permissionMode: 'auto', sessionId: 's1', sessionIdFlagSupported: true },
      ENV
    )
    // args are expanded + each token quoted; flags appended like claude.
    expect(r.command).toBe("claude-wopr '--model' 'sonnet' 'fix' --permission-mode auto --session-id s1")
    expect(r.missingEnv).toEqual([])
  })
  it('a claude-base agent with a stale flag-prompt emits a POSITIONAL, not --prompt', () => {
    // Regression: a custom agent with baseAgent:'claude' + a stale promptInjectionMode:'flag-prompt'
    // must NOT emit `--prompt` (claude rejects it). The harness's argv grammar wins.
    setCustomAgentBaseResolver((id) => (id === 'custom:stale' ? 'claude' : undefined))
    const stale: CustomAgent = {
      id: 'custom:stale',
      label: 'Stale',
      launchCmd: 'claude-wopr',
      baseAgent: 'claude',
      promptInjectionMode: 'flag-prompt'
    }
    const r = assembleLaunchCommand(
      { agentId: 'custom:stale', customAgent: stale, initialPrompt: 'read the handoff file' },
      ENV
    )
    expect(r.command).toContain("'read the handoff file'")
    expect(r.command).not.toContain('--prompt')
  })
  it('expands ${env:…} in args and reports missing vars', () => {
    setCustomAgentBaseResolver((id) => (id === 'custom:proxy' ? 'claude' : undefined))
    const r = assembleLaunchCommand(
      { agentId: 'custom:proxy', customAgent: { ...claudeProxy, args: '--model ${env:UNSET}' } },
      {}
    )
    expect(r.missingEnv).toEqual(['UNSET'])
  })
  it('a blank launchCmd with a baseAgent uses the base harness command', () => {
    setCustomAgentBaseResolver((id) => (id === 'custom:blank' ? 'claude' : undefined))
    const blank: CustomAgent = { id: 'custom:blank', label: 'B', launchCmd: '', baseAgent: 'claude' }
    expect(assembleLaunchCommand({ agentId: 'custom:blank', customAgent: blank }, ENV).command).toBe('claude')
  })
})

describe('assembleResumeCommand', () => {
  it('claude resumes with --resume', () => {
    expect(assembleResumeCommand({ agentId: 'claude', sessionId: 'abc-123' }, ENV).command).toBe(
      'claude --resume abc-123'
    )
  })
  it('codex resumes with the subcommand form', () => {
    expect(assembleResumeCommand({ agentId: 'codex', sessionId: 'abc-123' }, ENV).command).toBe(
      'codex resume abc-123'
    )
  })
  it('falls back to the bare launch command when there is no session id', () => {
    expect(assembleResumeCommand({ agentId: 'claude' }, ENV).command).toBe('claude')
  })
  it('a claude-base proxy resumes with its own binary + claude grammar + args', () => {
    setCustomAgentBaseResolver((id) => (id === 'custom:proxy' ? 'claude' : undefined))
    expect(
      assembleResumeCommand(
        { agentId: 'custom:proxy', customAgent: claudeProxy, sessionId: 'abc-123', permissionMode: 'plan' },
        ENV
      ).command
    ).toBe("claude-wopr '--model' 'sonnet' --resume abc-123 --permission-mode plan")
  })
  it('a non-resumable vanilla custom agent falls back to its bare launch command', () => {
    expect(
      assembleResumeCommand({ agentId: 'custom:aider', customAgent: aider }, ENV).command
    ).toBe('aider')
  })
})
