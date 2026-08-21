import { describe, it, expect } from 'vitest'
import {
  agentPidIn,
  isAgentPane,
  AGENT_BINARIES,
  binariesFor,
  binaryFromLaunchCmd
} from './pane-owner-predicate'
import { isShellCommand } from './pane'
import { BUILTIN_AGENT_IDS, AGENT_CONFIG } from './config'

const owner = (argv: string[], command = 'node') => ({
  panePid: 1,
  tty: '/dev/pts/1',
  command,
  argv
})

describe('isAgentPane', () => {
  it('recognises the expected agent binary in the foreground group', () => {
    expect(isAgentPane(owner(['node /usr/local/bin/claude --resume x']), 'claude')).toBe('agent')
    expect(isAgentPane(owner(['/opt/homebrew/bin/codex']), 'codex')).toBe('agent')
    expect(isAgentPane(owner(['gemini']), 'gemini')).toBe('agent')
  })

  it('recognises it anywhere in the group, not only as the leader', () => {
    // A wrapper leads the group; the CLI is a child of it. Both are in the foreground group and
    // both will receive what we write, so either one proving the agent is present is enough.
    expect(
      isAgentPane(owner(['/bin/sh -c claude --resume x', 'node /usr/local/bin/claude --resume x']), 'claude')
    ).toBe('agent')
  })

  it('refuses a DIFFERENT agent — a claude message must not land in a codex pane', () => {
    expect(isAgentPane(owner(['node /usr/local/bin/codex']), 'claude')).toBe('not-agent')
    expect(isAgentPane(owner(['node /usr/local/bin/claude']), 'codex')).toBe('not-agent')
  })

  // The two holes the old negative predicate had, closed:
  it('refuses a shell OUTSIDE the seven-name allowlist', () => {
    for (const sh of ['nu', 'pwsh', 'xonsh', 'elvish', 'ssh host', 'python3 -i']) {
      const cmd = sh.split(' ')[0]
      // The old gate's exact reading: not one of seven shell names, therefore "an agent".
      expect(isShellCommand(cmd)).toBe(false)
      expect(isAgentPane(owner([sh], cmd), 'claude')).toBe('not-agent')
    }
  })

  it('refuses a pane whose CLI exited even though agentId is still persisted', () => {
    expect(isAgentPane(owner(['-zsh'], 'zsh'), 'claude')).toBe('not-agent')
    expect(isAgentPane(owner(['/bin/bash'], 'bash'), 'claude')).toBe('not-agent')
  })

  it('answers unknown — never `agent` — when the read failed', () => {
    expect(isAgentPane(null, 'claude')).toBe('unknown')
    expect(isAgentPane(undefined, 'claude')).toBe('unknown')
    expect(isAgentPane(owner([]), 'claude')).toBe('unknown')
  })

  it('is not fooled by an argument that merely mentions the agent', () => {
    expect(isAgentPane(owner(['vim /etc/claude.conf']), 'claude')).toBe('not-agent')
    expect(isAgentPane(owner(['grep -r claude .']), 'claude')).toBe('not-agent')
    expect(isAgentPane(owner(['tail -f /var/log/claude.log']), 'claude')).toBe('not-agent')
    // The nastiest shape: a shell whose -c string names the agent. `-c` is an option, not a script
    // path, so interpreter resolution must not reach past it.
    expect(isAgentPane(owner(["sh -c 'grep claude .'"]), 'claude')).toBe('not-agent')
  })

  it('resolves an interpreter only when what follows is a script, never an option', () => {
    expect(isAgentPane(owner(['node /home/u/.local/share/npm/bin/claude']), 'claude')).toBe('agent')
    expect(isAgentPane(owner(['bun /opt/bin/codex mcp']), 'codex')).toBe('agent')
    expect(isAgentPane(owner(['node --inspect claude']), 'claude')).toBe('not-agent')
    // An OPTION that reads like the agent once the login-shell dash is stripped. This is the case
    // the "next token must not start with -" rule exists for: without it, `-claude` basenames to
    // `claude` and an interpreter flag is mistaken for the script it is not.
    expect(isAgentPane(owner(['node -claude']), 'claude')).toBe('not-agent')
  })

  it('answers unknown for a custom agent whose definition the caller did not hand over', () => {
    // `custom:<uuid>` alone names nothing, and guessing would be the exact class of mistake this
    // module replaces. The fix for the dead end is `binariesFor(id, customAgents)` below, not a
    // guess here.
    expect(isAgentPane(owner(['node /opt/bin/whatever']), 'custom:abc')).toBe('unknown')
  })

  it('verifies a custom agent once its launch command is supplied', () => {
    const customAgents = [{ id: 'custom:abc', launchCmd: 'npx -y my-agent --serve' }]
    expect(
      isAgentPane(owner(['node /home/u/.npm/_npx/1/node_modules/.bin/my-agent --serve']), 'custom:abc',
        binariesFor('custom:abc', customAgents))
    ).toBe('agent')
    expect(isAgentPane(owner(['-zsh'], 'zsh'), 'custom:abc', binariesFor('custom:abc', customAgents)))
      .toBe('not-agent')
  })

  it('verifies either the wrapper or inherited harness for a base-backed custom agent', () => {
    const customAgents = [
      { id: 'custom:muse', launchCmd: 'claude-wopr', baseAgent: 'claude' }
    ]
    const binaries = binariesFor('custom:muse', customAgents)
    expect(binaries).toEqual(['claude-wopr', ...AGENT_BINARIES.claude])
    expect(isAgentPane(owner(['claude-wopr --resume sid']), 'custom:muse', binaries)).toBe('agent')
    expect(isAgentPane(owner(['claude --resume sid']), 'custom:muse', binaries)).toBe('agent')
    expect(isAgentPane(owner(['codex resume sid']), 'custom:muse', binaries)).toBe('not-agent')
  })

  it('proves the agent is IN the foreground group, not that it is READING the tty', () => {
    // `sh -c "sleep 600 | claude"`: claude really is in the group, so `agent` is the honest answer —
    // but its stdin is the pipe, and text written to the pane waits in the tty buffer for the shell.
    // Documented here so the delivery gate does not read this verdict as "it will be read".
    expect(isAgentPane(owner(['sh -c sleep 600 | claude', 'sleep 600', 'claude']), 'claude')).toBe('agent')
  })

  it('refuses two shapes it cannot see through, rather than guessing (documented false negatives)', () => {
    // A script path with a space splits into two tokens; a symlink carries the name it was invoked
    // as. Both answer not-agent — the safe direction, and the reason they are documented not fixed.
    expect(isAgentPane(owner(['node /opt/my agents/claude']), 'claude')).toBe('not-agent')
    expect(isAgentPane(owner(['/usr/local/bin/claude-work']), 'claude')).toBe('not-agent')
  })

  it('accepts a caller-supplied binary list for a custom agent', () => {
    expect(isAgentPane(owner(['node /opt/bin/whatever']), 'custom:abc', ['whatever'])).toBe('agent')
    expect(isAgentPane(owner(['node /opt/bin/other']), 'custom:abc', ['whatever'])).toBe('not-agent')
  })

  it('covers every built-in agent, so a new one cannot be silently unverifiable', () => {
    for (const id of BUILTIN_AGENT_IDS) {
      expect(AGENT_BINARIES[id], `${id} has no binary list`).toBeTruthy()
      // The list must still name the process the launcher actually starts.
      expect(AGENT_BINARIES[id]).toContain(AGENT_CONFIG[id].expectedProcess)
      expect(isAgentPane(owner([`/usr/local/bin/${AGENT_CONFIG[id].expectedProcess}`]), id)).toBe('agent')
    }
  })
})

describe('binaryFromLaunchCmd', () => {
  it('sees through package runners and their verbs and flags', () => {
    expect(binaryFromLaunchCmd('npx -y my-agent')).toBe('my-agent')
    expect(binaryFromLaunchCmd('pnpm dlx some-cli --flag')).toBe('some-cli')
    expect(binaryFromLaunchCmd('bun run my-agent')).toBe('my-agent')
    expect(binaryFromLaunchCmd('npx @acme/my-agent@1.2.3')).toBe('my-agent')
  })

  it('sees through env assignments and interpreters', () => {
    expect(binaryFromLaunchCmd('env FOO=1 BAR=2 my-agent --serve')).toBe('my-agent')
    expect(binaryFromLaunchCmd('node /opt/bin/my-agent.js')).toBe('my-agent.js')
  })

  it('takes a plain command as itself', () => {
    expect(binaryFromLaunchCmd('my-agent')).toBe('my-agent')
    expect(binaryFromLaunchCmd('/opt/vendor/bin/my-agent --x')).toBe('my-agent')
  })

  it('REFUSES to name a program every plain terminal also runs', () => {
    // The danger is not a wrong name that matches nothing — it is a name that matches EVERYTHING.
    // `bash` as an agent binary would make every idle shell on the canvas a delivery target.
    for (const cmd of ['bash -lc "my-agent --serve"', 'sh -c my-agent', 'ssh host my-agent', 'sudo my-agent', 'zsh']) {
      expect(binaryFromLaunchCmd(cmd), cmd).toBeNull()
    }
  })

  it('answers null for nothing at all', () => {
    expect(binaryFromLaunchCmd('')).toBeNull()
    expect(binaryFromLaunchCmd('   ')).toBeNull()
    expect(binaryFromLaunchCmd(null)).toBeNull()
    expect(binaryFromLaunchCmd('--flag --only')).toBeNull()
  })
})

describe('binariesFor', () => {
  const customAgents = [
    { id: 'custom:abc', launchCmd: 'npx -y my-agent' },
    { id: 'custom:shell', launchCmd: 'bash -lc "run-me"' },
    { id: 'custom:base', launchCmd: 'claude-wopr', baseAgent: 'claude' }
  ]

  it('answers the built-in table for a built-in id', () => {
    expect(binariesFor('claude')).toEqual(AGENT_BINARIES.claude)
  })

  it('derives a custom agent binary from its launch command — the dead end, closed', () => {
    expect(binariesFor('custom:abc', customAgents)).toEqual(['my-agent'])
  })

  it('adds the canonical base harness binaries for an inheriting custom agent', () => {
    expect(binariesFor('custom:base', customAgents)).toEqual([
      'claude-wopr',
      ...AGENT_BINARIES.claude
    ])
  })

  it('stays null when the custom agent is not in the list we were handed', () => {
    expect(binariesFor('custom:zzz', customAgents)).toBeNull()
    expect(binariesFor('custom:abc')).toBeNull()
  })

  it('stays null when the launch command names something every shell runs', () => {
    expect(binariesFor('custom:shell', customAgents)).toBeNull()
  })

  it('treats an unrecognised NON-custom id as its own command, mirroring resolveAgent', () => {
    expect(binariesFor('aider')).toEqual(['aider'])
  })
})


describe('agentPidIn — WHICH agent process, not just whether one is there', () => {
  const withPids = (argv: string[], pids: number[]) => ({
    panePid: 1000,
    tty: '/dev/pts/1',
    command: 'node',
    argv,
    pids
  })

  it('returns the pid of the row that made the pane an agent pane', () => {
    const o = withPids(['/bin/sh -c "while :; do claude; done"', 'node /usr/bin/claude --resume x'], [2000, 2100])
    expect(isAgentPane(o, 'claude')).toBe('agent')
    expect(agentPidIn(o, 'claude')).toBe(2100)
  })

  it('is null when the pane is not an agent pane at all', () => {
    expect(agentPidIn(withPids(['-zsh'], [2000]), 'claude')).toBeNull()
  })

  it('is null when the read carries no pids — unknown is never "unchanged"', () => {
    // An older read, or one whose pid column did not line up with argv. The delivery's post-write
    // check reads null as "cannot confirm" and reports the uncertainty.
    expect(agentPidIn(owner(['node /usr/bin/claude']), 'claude')).toBeNull()
    expect(agentPidIn(null, 'claude')).toBeNull()
    expect(agentPidIn(undefined, 'claude')).toBeNull()
  })

  it('is null for an unnameable agent, exactly like the verdict is `unknown`', () => {
    expect(agentPidIn(withPids(['node /usr/bin/claude'], [2100]), 'custom:abc')).toBeNull()
  })

  it('distinguishes a RESTARTED agent from the same one — the whole reason it exists', () => {
    // Same pane, same wrapper, same name: a wrapper loop replaced the process. Only the pid moved.
    const before = withPids(['/bin/sh -c "while :; do claude; done"', 'claude'], [2000, 2100])
    const after = withPids(['/bin/sh -c "while :; do claude; done"', 'claude'], [2000, 2199])
    expect(isAgentPane(before, 'claude')).toBe(isAgentPane(after, 'claude'))
    expect(agentPidIn(before, 'claude')).not.toBe(agentPidIn(after, 'claude'))
  })

  it('ignores a zero/negative pid rather than reporting a phantom process', () => {
    expect(agentPidIn(withPids(['claude'], [0]), 'claude')).toBeNull()
  })
})
