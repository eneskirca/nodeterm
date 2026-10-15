import { describe, it, expect } from 'vitest'
import {
  buildRelayLaunch,
  isDialectNeutralCommand,
  parseRelayLaunch,
  relayLaunchDialect,
  type RelayLaunchContext
} from './relay-launch'
import { assembleResumeCommand } from '../shared/agents/launch'
import type { CustomAgent } from '../shared/types'

const SID = '0f3c2a1e-5b7d-4c9a-8e21-3f4a5b6c7d8e'

function ctx(over: Partial<RelayLaunchContext> = {}): RelayLaunchContext {
  return {
    customAgents: [],
    claudeAutoSupported: true,
    isKnownAccount: (id) => id === 'acct-1',
    env: {},
    ...over
  }
}

describe('parseRelayLaunch — everything the phone sends is re-validated', () => {
  it('keeps a well-formed request', () => {
    expect(
      parseRelayLaunch({ agentId: 'claude', sessionId: SID, permissionMode: 'plan', cwd: '/w', accountId: 'acct-1' })
    ).toEqual({ agentId: 'claude', sessionId: SID, permissionMode: 'plan', cwd: '/w', accountId: 'acct-1' })
  })
  it('a missing / non-string / control-bearing agent id is no launch', () => {
    expect(parseRelayLaunch({})).toBeNull()
    expect(parseRelayLaunch({ agentId: 7 })).toBeNull()
    expect(parseRelayLaunch({ agentId: 'claude\n; rm -rf ~' })).toBeNull()
    expect(parseRelayLaunch('claude')).toBeNull()
    expect(parseRelayLaunch(null)).toBeNull()
  })
  it('a forged session id is no launch at all — never silently a fresh session', () => {
    expect(parseRelayLaunch({ agentId: 'claude', sessionId: 'x; curl evil' })).toBeNull()
    expect(parseRelayLaunch({ agentId: 'claude', sessionId: '-rf' })).toBeNull()
    expect(parseRelayLaunch({ agentId: 'claude', sessionId: 42 })).toBeNull()
  })
  it('a forged mode is dropped (the bare, safe command); a forged account is dropped', () => {
    expect(parseRelayLaunch({ agentId: 'claude', permissionMode: 'constructor' })).toEqual({ agentId: 'claude' })
    expect(parseRelayLaunch({ agentId: 'claude', accountId: '../../etc' })).toEqual({ agentId: 'claude' })
  })
})

describe('relayLaunchDialect — read from the pane’s own foreground program', () => {
  it.each([
    ['zsh', 'posix'],
    ['-bash', 'posix'],
    ['pwsh', 'pwsh'],
    ['pwsh.exe', 'pwsh'],
    ['C:\\Program Files\\PowerShell\\7\\pwsh.exe', 'pwsh'],
    ['powershell.exe', 'windows-powershell'],
    ['cmd.exe', 'cmd'],
    [null, 'posix']
  ] as const)('%s → %s', (cmd, dialect) => {
    expect(relayLaunchDialect(cmd)).toBe(dialect)
  })
})

describe('buildRelayLaunch', () => {
  it('on a POSIX pane it is the renderer’s cold-restore line, byte for byte', async () => {
    const plan = await buildRelayLaunch({ agentId: 'claude', sessionId: SID, permissionMode: 'auto' }, 'posix', ctx())
    const expected = assembleResumeCommand({ agentId: 'claude', sessionId: SID, permissionMode: 'auto', approvalCaps: {} }, {})
    expect(plan).toEqual({ kind: 'type', command: expected.command })
    expect(plan).toEqual({ kind: 'type', command: `claude --resume ${SID} --permission-mode auto` })
  })
  it('claude’s version gate degrades auto to no flag; other agents are not gated by it', async () => {
    expect(
      await buildRelayLaunch({ agentId: 'claude', permissionMode: 'auto' }, 'posix', ctx({ claudeAutoSupported: false }))
    ).toEqual({ kind: 'type', command: 'claude' })
    const grok = await buildRelayLaunch({ agentId: 'grok', permissionMode: 'auto' }, 'posix', ctx({ claudeAutoSupported: false }))
    expect(grok?.kind).toBe('type')
  })
  it('an agent this machine does not know is no launch', async () => {
    expect(await buildRelayLaunch({ agentId: 'custom:nope' }, 'posix', ctx())).toBeNull()
  })
  it.each(['pwsh', 'windows-powershell', 'cmd'] as const)(
    'on a %s pane (no trusted resolver) a neutral line is typed, and it carries no POSIX syntax',
    async (dialect) => {
      const plan = await buildRelayLaunch(
        { agentId: 'claude', sessionId: SID, permissionMode: 'acceptEdits', accountId: 'acct-1', cwd: 'C:\\w' },
        dialect,
        ctx()
      )
      expect(plan?.kind).toBe('type')
      const text = plan && plan.kind === 'type' ? plan.command : ''
      expect(text).toBe(`claude --resume ${SID} --permission-mode acceptEdits`)
      // cwd and account ride the SPAWN options, never the typed line.
      for (const posixOnly of ['2>/dev/null', 'env -u', ';', 'cd ', 'CLAUDE_CONFIG_DIR', "'"]) {
        expect(text).not.toContain(posixOnly)
      }
    }
  )
  it('a Windows pane refuses a line that is not dialect-neutral (quoted custom args)', async () => {
    const custom: CustomAgent = { id: 'custom:a', label: 'A', launchCmd: 'claude', baseAgent: 'claude', args: '--x "two words"' }
    const posix = await buildRelayLaunch({ agentId: 'custom:a' }, 'posix', ctx({ customAgents: [custom] }))
    expect(posix?.kind).toBe('type')
    expect(await buildRelayLaunch({ agentId: 'custom:a' }, 'pwsh', ctx({ customAgents: [custom] }))).toBeNull()
  })
  it('an unset ${env:…} reference is no launch (never a mangled line)', async () => {
    const custom: CustomAgent = { id: 'custom:b', label: 'B', launchCmd: '${env:NT_MISSING_BIN}' }
    expect(await buildRelayLaunch({ agentId: 'custom:b' }, 'posix', ctx({ customAgents: [custom] }))).toBeNull()
  })
  it('with the trusted Windows resolver wired, a Windows pane gets the planner’s execute plan', async () => {
    const plan = await buildRelayLaunch(
      { agentId: 'claude', sessionId: SID, permissionMode: 'plan' },
      'pwsh',
      ctx({ resolveExecutableKind: async () => ({ kind: 'native', executable: 'C:\\tools\\claude.exe' }) })
    )
    expect(plan?.kind).toBe('execute')
    const cmd = plan && plan.kind === 'execute' ? plan.plan.command : ''
    expect(cmd).toContain("Start-Process -FilePath 'C:\\tools\\claude.exe'")
    expect(cmd).toContain(`--resume ${SID}`)
    expect(cmd).not.toContain('2>/dev/null')
  })
  it('a resolver that cannot find the agent is no launch', async () => {
    expect(
      await buildRelayLaunch({ agentId: 'claude' }, 'cmd', ctx({ resolveExecutableKind: async () => null }))
    ).toBeNull()
  })
})

describe('isDialectNeutralCommand', () => {
  it.each([
    ['claude', true],
    [`claude --resume ${SID} --permission-mode auto`, true],
    ['codex resume abc --ask-for-approval on-request', true],
    ["claude 'x'", false],
    ['claude; rm', false],
    ['claude && x', false],
    ['claude $HOME', false],
    ['claude %PATH%', false],
    ['claude  --x', false],
    ['--version', false],
    ['', false]
  ])('%j → %s', (cmd, ok) => {
    expect(isDialectNeutralCommand(cmd)).toBe(ok)
  })
})
