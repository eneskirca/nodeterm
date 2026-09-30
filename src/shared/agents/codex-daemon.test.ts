import { describe, it, expect, afterEach } from 'vitest'
import { withCodexNoDaemon } from './codex-daemon'
import { assembleLaunchCommand, assembleResumeCommand } from './launch'
import type { CustomAgent } from '../types'
import { setCustomAgentBaseResolver } from './config'

afterEach(() => setCustomAgentBaseResolver(null))

const ON = { codexNoDaemon: true }

describe('withCodexNoDaemon', () => {
  it('appends the flag to a codex line only when the CLI was SEEN to accept it', () => {
    expect(withCodexNoDaemon('codex', 'codex', ON)).toBe('codex --no-daemon')
    expect(withCodexNoDaemon('codex', 'codex', {})).toBe('codex')
    expect(withCodexNoDaemon('codex', 'codex', { codexNoDaemon: null })).toBe('codex')
    expect(withCodexNoDaemon('codex', 'codex', { codexNoDaemon: false })).toBe('codex')
  })

  it('never touches another agent', () => {
    expect(withCodexNoDaemon('claude', 'claude', ON)).toBe('claude')
    expect(withCodexNoDaemon('gemini', 'gemini', ON)).toBe('gemini')
  })

  it('is idempotent, and never pairs the flag with --remote (codex refuses the pair)', () => {
    expect(withCodexNoDaemon('codex --no-daemon', 'codex', ON)).toBe('codex --no-daemon')
    expect(withCodexNoDaemon('codex --remote ws://h:1', 'codex', ON)).toBe('codex --remote ws://h:1')
    expect(withCodexNoDaemon('codex --remote=unix://', 'codex', ON)).toBe('codex --remote=unix://')
  })

  it('reads a quoted prompt as data, not as the flag', () => {
    expect(withCodexNoDaemon("codex 'mention --no-daemon'", 'codex', ON)).toBe(
      "codex 'mention --no-daemon' --no-daemon"
    )
  })
})

describe('every codex launch and resume line carries it (the two assemblers)', () => {
  it('fresh launch with a prompt and a permission mode', () => {
    const { command } = assembleLaunchCommand(
      { agentId: 'codex', initialPrompt: 'fix it', permissionMode: 'auto', approvalCaps: ON },
      {}
    )
    expect(command).toBe("codex 'fix it' --ask-for-approval on-request --no-daemon")
  })

  it('cold-restore / restart resume', () => {
    const { command } = assembleResumeCommand(
      { agentId: 'codex', sessionId: 'abc-123', permissionMode: 'auto', approvalCaps: ON },
      {}
    )
    expect(command).toBe('codex resume abc-123 --ask-for-approval on-request --no-daemon')
  })

  it('a resume with no known session (a fresh relaunch)', () => {
    const { command } = assembleResumeCommand({ agentId: 'codex', approvalCaps: ON }, {})
    expect(command).toBe('codex --no-daemon')
  })

  it('the managed launcher line too — the launcher strips it before its own --remote', () => {
    const { command } = assembleLaunchCommand(
      { agentId: 'codex', sharedIdentity: true, approvalCaps: ON },
      {}
    )
    expect(command).toBe('nodeterm-codex --no-daemon')
  })

  it('a custom agent whose baseAgent is codex (its own launch command)', () => {
    const custom = {
      id: 'custom:x',
      label: 'My codex',
      launchCmd: 'codex -m o4',
      baseAgent: 'codex'
    } as unknown as CustomAgent
    setCustomAgentBaseResolver((id) => (id === 'custom:x' ? 'codex' : undefined))
    const { command } = assembleLaunchCommand({ agentId: 'custom:x', customAgent: custom, approvalCaps: ON }, {})
    expect(command).toBe('codex -m o4 --no-daemon')
  })

  it('a launch-command override (the user wrapper) keeps it too', () => {
    const { command } = assembleLaunchCommand(
      { agentId: 'codex', launchCmdOverride: 'my-codex-wrapper', approvalCaps: ON },
      {}
    )
    expect(command).toBe('my-codex-wrapper --no-daemon')
  })

  it('unknown caps (a remote host nobody probed, an older CLI) leave every line byte-identical', () => {
    expect(assembleLaunchCommand({ agentId: 'codex', initialPrompt: 'x' }, {}).command).toBe("codex 'x'")
    expect(assembleResumeCommand({ agentId: 'codex', sessionId: 's1' }, {}).command).toBe('codex resume s1')
  })

  it('never lands on a non-codex agent even with the caps set', () => {
    expect(assembleLaunchCommand({ agentId: 'claude', approvalCaps: ON }, {}).command).toBe('claude')
  })
})

describe('one detection rule, two spellings', () => {
  it('the TS regex and the shell ERE agree, and neither reads a future --no-daemon-x', async () => {
    const { CODEX_NO_DAEMON_HELP_RE, CODEX_NO_DAEMON_HELP_ERE } = await import('./codex-daemon')
    const { execFileSync } = await import('node:child_process')
    const cases: Array<[string, boolean]> = [
      ['      --no-daemon', true],
      ['      --no-daemon   Run without the shared background server', true],
      ['  --no-daemon', true],
      ['      --no-daemon-x', false],
      ['      --no-daemons', false],
      ['          Unlike --no-daemon this needs an address', false],
      ['--remote --no-daemon', false]
    ]
    for (const [line, want] of cases) {
      expect(CODEX_NO_DAEMON_HELP_RE.test(line), line).toBe(want)
      let sh = true
      try {
        execFileSync('grep', ['-q', '-E', CODEX_NO_DAEMON_HELP_ERE], { input: `${line}\n` })
      } catch {
        sh = false
      }
      expect(sh, `grep -E: ${line}`).toBe(want)
    }
  })

  it('the probe host key carries the port', async () => {
    const { codexProbeHostKey } = await import('./codex-daemon')
    expect(codexProbeHostKey({ user: 'root', host: 'localhost', port: 2222 })).toBe('root@localhost:2222')
    expect(codexProbeHostKey({ user: 'root', host: 'localhost' })).toBe('root@localhost:22')
    expect(codexProbeHostKey({ host: 'localhost' })).toBeNull()
  })
})
