import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resumeCommand, withPermissionMode } from '../../shared/agents/config'
import {
  __resetAgentRestartForTests,
  agentRestartFn,
  exitSequence,
  guardConcurrentRestart,
  isShellCommand,
  performRestartResume,
  planBulkRestart,
  registerAgentRestart,
  restartEligibility,
  settleRestart,
  summarizeBulkRestart,
  summarizeOutcomes,
  type BulkRestartCandidate,
  type RestartOutcome
} from './agent-restart'

describe('exitSequence', () => {
  it('knows claude, codex and grok, refuses others', () => {
    expect(exitSequence('claude')).toBe('/exit')
    expect(exitSequence('codex')).toBe('/quit')
    // grok's documented primary is `/quit` (`/exit` is its alias).
    expect(exitSequence('grok')).toBe('/quit')
    expect(exitSequence('gemini')).toBeNull()
    expect(exitSequence('my-custom')).toBeNull()
  })
})

describe('isShellCommand', () => {
  it('matches plain, login-dash and path-prefixed shells', () => {
    for (const c of ['zsh', 'bash', 'sh', 'fish', '-zsh', '/bin/bash', '/usr/local/bin/fish'])
      expect(isShellCommand(c)).toBe(true)
  })
  it('rejects agents, editors and empty', () => {
    for (const c of ['claude', 'codex', 'node', 'vim', '', null, undefined])
      expect(isShellCommand(c as never)).toBe(false)
  })
})

describe('restartEligibility', () => {
  it('ok for a resumable agent with a session id in a non-working state', () => {
    expect(restartEligibility('claude', 'waiting', 'abc-123')).toEqual({ ok: true })
    expect(restartEligibility('codex', 'done', 'abc-123')).toEqual({ ok: true })
  })
  it('treats a blocked (permission prompt) session as busy — /exit would answer the prompt', () => {
    expect(restartEligibility('claude', 'blocked', 'abc')).toEqual({ ok: false, reason: 'working' })
  })
  it('flags working / missing session / non-resumable, in that priority', () => {
    expect(restartEligibility('claude', 'working', 'abc')).toEqual({ ok: false, reason: 'working' })
    expect(restartEligibility('claude', 'waiting', undefined)).toEqual({
      ok: false,
      reason: 'no-session'
    })
    expect(restartEligibility('gemini', 'waiting', 'abc')).toEqual({
      ok: false,
      reason: 'not-resumable'
    })
    expect(restartEligibility(undefined, undefined, undefined)).toEqual({
      ok: false,
      reason: 'not-resumable'
    })
  })
})

function fakeIo() {
  const written: string[] = []
  let cb: ((chunk: string) => void) | null = null
  return {
    written,
    io: {
      write(d: string) {
        written.push(d)
        // deliverCommand verifies by echo: reflect every write back immediately.
        cb?.(d)
      },
      onData(f: (chunk: string) => void) {
        cb = f
        return () => {
          cb = null
        }
      }
    }
  }
}

/** An io the shell never echoes back: deliverCommand cannot verify the line, so it sits
 *  un-submitted in the pane for its whole retry window — the state a second restart must never
 *  write into. */
function silentIo() {
  const written: string[] = []
  return {
    written,
    io: {
      write(d: string) {
        written.push(d)
      },
      onData() {
        return () => {}
      }
    }
  }
}

describe('performRestartResume', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('sends exit, waits for the shell, then delivers the resume command', async () => {
    const { written, io } = fakeIo()
    let pane = 'claude'
    const p = performRestartResume({
      agentId: 'claude',
      sessionId: 'sid-1',
      io,
      paneCommand: async () => pane,
      timeoutMs: 6000,
      pollMs: 100
    })
    await vi.advanceTimersByTimeAsync(250) // a few polls while the CLI is still up
    pane = 'zsh'
    await vi.advanceTimersByTimeAsync(5000)
    expect(await p).toBe('restarted')
    expect(written.slice(0, 2)).toEqual(['\x15', '/exit\r'])
    expect(written.join('')).toContain('claude --resume sid-1')
  })

  it('gives up without delivering when the pane never returns to a shell', async () => {
    const { written, io } = fakeIo()
    const p = performRestartResume({
      agentId: 'claude',
      sessionId: 'sid-1',
      io,
      paneCommand: async () => 'claude',
      timeoutMs: 1000,
      pollMs: 100
    })
    await vi.advanceTimersByTimeAsync(2000)
    expect(await p).toBe('exit-timeout')
    expect(written.join('')).not.toContain('--resume')
  })

  it('gives up when the pane query wedges after the exit was sent', async () => {
    const { written, io } = fakeIo()
    let first = true
    const p = performRestartResume({
      agentId: 'claude',
      sessionId: 'sid-1',
      io,
      // The pre-flight answers, so the exit IS written; then the tmux server wedges and no poll
      // ever settles. The deadline, not the query, has to end the restart.
      paneCommand: () => {
        if (!first) return new Promise<string | null>(() => {})
        first = false
        return Promise.resolve('claude')
      },
      timeoutMs: 1000,
      pollMs: 100
    })
    await vi.advanceTimersByTimeAsync(2000)
    expect(await p).toBe('exit-timeout')
    expect(written.join('')).not.toContain('--resume')
  })

  it('writes NOTHING when the pane cannot be observed at all (tmux off / no tmux binary)', async () => {
    const { written, io } = fakeIo()
    const p = performRestartResume({
      agentId: 'claude',
      sessionId: 'sid-1',
      io,
      paneCommand: async () => null, // no tmux session to query — the poll could never end
      timeoutMs: 1000,
      pollMs: 100
    })
    await vi.advanceTimersByTimeAsync(2000)
    // Quitting a CLI whose pane we cannot watch would leave it dead and never resumed, and then
    // report a 6-second "the session was left running".
    expect(await p).toBe('not-eligible')
    expect(written).toEqual([])
  })

  it('writes nothing when the pre-flight pane query itself wedges', async () => {
    const { written, io } = fakeIo()
    const p = performRestartResume({
      agentId: 'claude',
      sessionId: 'sid-1',
      io,
      paneCommand: () => new Promise<string | null>(() => {}),
      timeoutMs: 1000,
      pollMs: 100
    })
    await vi.advanceTimersByTimeAsync(3000)
    expect(await p).toBe('not-eligible')
    expect(written).toEqual([])
  })

  it('clears the pending input line before asking the CLI to quit', async () => {
    const { written, io } = fakeIo()
    let pane = 'claude'
    const p = performRestartResume({
      agentId: 'claude',
      sessionId: 'sid-1',
      io,
      paneCommand: async () => pane,
      timeoutMs: 6000,
      pollMs: 100
    })
    await vi.advanceTimersByTimeAsync(250)
    pane = 'zsh'
    await vi.advanceTimersByTimeAsync(5000)
    expect(await p).toBe('restarted')
    // Half-typed user text in the prompt would otherwise be SUBMITTED as `…the/exit`.
    expect(written[0]).toBe('\x15')
    expect(written[1]).toBe('/exit\r')
  })

  it('takes a pane command that CHANGED away from the CLI as proof it quit', async () => {
    const { written, io } = fakeIo()
    let pane = 'claude'
    const p = performRestartResume({
      agentId: 'claude',
      sessionId: 'sid-1',
      io,
      paneCommand: async () => pane,
      timeoutMs: 6000,
      pollMs: 100
    })
    await vi.advanceTimersByTimeAsync(250)
    pane = 'nu' // a shell outside the allowlist — the user's `defaultShell`
    await vi.advanceTimersByTimeAsync(5000)
    expect(await p).toBe('restarted')
    expect(written.join('')).toContain('claude --resume sid-1')
  })

  it('does not take a one-poll flicker for a quit (never types into a live CLI)', async () => {
    const { written, io } = fakeIo()
    let pane = 'claude'
    const p = performRestartResume({
      agentId: 'claude',
      sessionId: 'sid-1',
      io,
      paneCommand: async () => pane,
      timeoutMs: 1000,
      pollMs: 100
    })
    await vi.advanceTimersByTimeAsync(150)
    pane = 'node' // a momentary foreground child of the CLI, not its exit
    await vi.advanceTimersByTimeAsync(100)
    pane = 'claude'
    await vi.advanceTimersByTimeAsync(2000)
    expect(await p).toBe('exit-timeout')
    expect(written.join('')).not.toContain('--resume')
  })

  it("launches with the caller's command when one is given (permission mode)", async () => {
    const { written, io } = fakeIo()
    const p = performRestartResume({
      agentId: 'claude',
      sessionId: 'sid-1',
      io,
      command: 'claude --resume sid-1 --permission-mode plan',
      paneCommand: async () => 'zsh',
      timeoutMs: 1000,
      pollMs: 100
    })
    await vi.advanceTimersByTimeAsync(5000)
    expect(await p).toBe('restarted')
    expect(written.join('')).toContain('claude --resume sid-1 --permission-mode plan')
  })

  it('ignores an override for a session id that could never be resumed', async () => {
    const { written, io } = fakeIo()
    expect(
      await performRestartResume({
        agentId: 'claude',
        sessionId: '-bad',
        io,
        command: 'claude --resume -bad --permission-mode plan',
        paneCommand: async () => 'zsh'
      })
    ).toBe('not-eligible')
    expect(written).toEqual([])
  })

  it('refuses an agent without an exit sequence', async () => {
    const { io } = fakeIo()
    expect(
      await performRestartResume({
        agentId: 'gemini',
        sessionId: 's',
        io,
        paneCommand: async () => 'zsh'
      })
    ).toBe('not-eligible')
  })

  it('refuses — without writing the exit — a session id we could never resume into', async () => {
    const { written, io } = fakeIo()
    expect(
      await performRestartResume({
        agentId: 'claude',
        sessionId: '-bad', // rejected by resumeCommand's SAFE_SESSION_ID
        io,
        paneCommand: async () => 'zsh'
      })
    ).toBe('not-eligible')
    expect(written).toEqual([]) // quitting a CLI we cannot resume would just lose the session
  })

  it('hands the delivery cancel to the caller, which stops it writing (node teardown)', async () => {
    const { written, io } = silentIo()
    let cancel: (() => void) | undefined
    const p = performRestartResume({
      agentId: 'claude',
      sessionId: 'sid-1',
      io,
      paneCommand: async () => 'zsh',
      timeoutMs: 1000,
      pollMs: 100,
      onDelivery: (c) => {
        cancel = c
      }
    })
    await vi.advanceTimersByTimeAsync(200)
    expect(typeof cancel).toBe('function') // handed out as the delivery STARTS, not when it ends
    const delivered = written.length
    cancel?.()
    expect(await p).toBe('restarted') // cancelling settles the delivery, and with it the restart
    await vi.advanceTimersByTimeAsync(30_000)
    // No rewrite retries, no fail-open submit: nothing more reaches the torn-down transport.
    expect(written.length).toBe(delivered)
  })

  it('resolves only once the resume line has left the pane', async () => {
    const { io } = silentIo()
    let settled = false
    const p = performRestartResume({
      agentId: 'claude',
      sessionId: 'sid-1',
      io,
      paneCommand: async () => 'zsh',
      timeoutMs: 1000,
      pollMs: 100
    }).then((o) => {
      settled = true
      return o
    })
    await vi.advanceTimersByTimeAsync(200)
    expect(settled).toBe(false) // written, but still un-submitted through the verify retries
    await vi.advanceTimersByTimeAsync(10_000) // the last attempt submits fail-open
    expect(await p).toBe('restarted')
  })

  it('writes nothing when the session is already gone', async () => {
    const { written, io } = fakeIo()
    expect(
      await performRestartResume({
        agentId: 'claude',
        sessionId: 'sid-1',
        io,
        paneCommand: async () => 'zsh',
        isLive: () => false
      })
    ).toBe('not-eligible')
    expect(written).toEqual([])
  })

  it('reports no restart when the session dies while we wait for the shell', async () => {
    const { written, io } = fakeIo()
    let live = true
    const p = performRestartResume({
      agentId: 'claude',
      sessionId: 'sid-1',
      io,
      paneCommand: async () => 'claude',
      timeoutMs: 5000,
      pollMs: 100,
      isLive: () => live
    })
    await vi.advanceTimersByTimeAsync(150)
    live = false // the node was deleted / its tmux session destroyed under us
    await vi.advanceTimersByTimeAsync(200)
    // Not 'exit-timeout': nothing timed out, the pane simply stopped existing — and not
    // 'restarted', which would put a phantom in the bulk summary.
    expect(await p).toBe('not-eligible')
    expect(written.join('')).not.toContain('--resume')
  })

  it('never reports a restart whose resume line the transport refused', async () => {
    // A relay socket still CONNECTING throws InvalidStateError on the very first write. The
    // delivery ends itself (command-delivery.ts) — but ending is not delivering, so the restart
    // must come back as a REJECTION the caller counts as a failure, not as 'restarted'.
    const written: string[] = []
    const io = {
      write(dta: string) {
        written.push(dta)
        if (dta.includes('--resume'))
          throw new DOMException('Still in CONNECTING state.', 'InvalidStateError')
      },
      onData: () => () => {}
    }
    const p = performRestartResume({
      agentId: 'claude',
      sessionId: 'sid-1',
      io,
      paneCommand: async () => 'zsh',
      timeoutMs: 1000,
      pollMs: 100
    })
    const settled = p.then(
      (o) => ({ ok: true, o }),
      (e) => ({ ok: false, e })
    )
    await vi.advanceTimersByTimeAsync(30_000)
    expect(await settled).toEqual({ ok: false, e: expect.any(DOMException) })
  })

  it('hands out no cancel when nothing was delivered', async () => {
    const { io } = fakeIo()
    const handles: Array<() => void> = []
    const p = performRestartResume({
      agentId: 'claude',
      sessionId: 'sid-1',
      io,
      paneCommand: async () => 'claude',
      timeoutMs: 1000,
      pollMs: 100,
      onDelivery: (c) => handles.push(c)
    })
    await vi.advanceTimersByTimeAsync(2000)
    expect(await p).toBe('exit-timeout')
    expect(handles).toEqual([])
  })
})

describe('performRestartResume — grok', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it("quits with grok's own exit line and resumes by session id", async () => {
    const { written, io } = fakeIo()
    let pane = 'grok'
    const p = performRestartResume({
      agentId: 'grok',
      sessionId: 'abc-1',
      io,
      paneCommand: async () => pane,
      timeoutMs: 6000,
      pollMs: 100
    })
    await vi.advanceTimersByTimeAsync(250) // a few polls while the CLI is still up
    pane = 'zsh'
    await vi.advanceTimersByTimeAsync(5000)
    expect(await p).toBe('restarted')
    // `/quit`, not claude's `/exit` — the table is per CLI.
    expect(written.slice(0, 2)).toEqual(['\x15', '/quit\r'])
    expect(written.join('')).toContain('grok --resume abc-1')
  })

  it("delivers the caller's permission-mode resume line, composed as TerminalNode composes it", async () => {
    const { written, io } = fakeIo()
    // The one place the two grok rules meet: `resumeCommand` builds the resume line and
    // `withPermissionMode` appends the flag (no `--` separator here — the resume line carries no
    // positional prompt). Pinned on the COMPOSED string, because that is what reaches the pane.
    const command = withPermissionMode(resumeCommand('grok', 'abc-1')!, 'grok', 'plan')
    expect(command).toBe('grok --resume abc-1 --permission-mode plan')
    const p = performRestartResume({
      agentId: 'grok',
      sessionId: 'abc-1',
      io,
      command,
      paneCommand: async () => 'zsh',
      timeoutMs: 1000,
      pollMs: 100
    })
    await vi.advanceTimersByTimeAsync(5000)
    expect(await p).toBe('restarted')
    expect(written.join('')).toContain('grok --resume abc-1 --permission-mode plan')
  })
})

describe('restartEligibility — grok', () => {
  it('is a target once it has a session id and is not busy', () => {
    expect(restartEligibility('grok', 'done', 'abc-1')).toEqual({ ok: true })
    expect(restartEligibility('grok', 'waiting', 'abc-1')).toEqual({ ok: true })
    expect(restartEligibility('grok', 'done', undefined)).toEqual({
      ok: false,
      reason: 'no-session'
    })
  })

  it('refuses a working OR blocked session — `/quit` typed into a prompt ANSWERS it', () => {
    // Agent-agnostic by construction (BUSY_STATES), so grok needs no branch of its own.
    for (const state of ['working', 'blocked'] as const)
      expect(restartEligibility('grok', state, 'abc-1'), state).toEqual({
        ok: false,
        reason: 'working'
      })
  })

  it('keeps a busy grok node out of the bulk run', () => {
    const plan = planBulkRestart([
      { id: 'idle', agentId: 'grok', state: 'done', sessionId: 'sid-1', wired: true },
      { id: 'busy', agentId: 'grok', state: 'working', sessionId: 'sid-2', wired: true },
      { id: 'prompt', agentId: 'grok', state: 'blocked', sessionId: 'sid-3', wired: true }
    ])
    expect(plan.runnable).toEqual(['idle'])
    expect(plan.skipped).toEqual({ working: 2, noSession: 0 })
  })
})

describe('performRestartResume — the delivery await is bounded', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.doUnmock('./command-delivery')
    vi.resetModules()
  })

  it('stops waiting on a delivery that never announces it settled', async () => {
    // A transport whose write() throws used to kill deliverCommand's retry callback before it
    // could submit — `onSettled` then never fired, this await never settled, the node stayed
    // locked out by guardConcurrentRestart for the app's life and the bulk loop hung with no
    // summary. The transport is fixed in command-delivery.ts; this is the belt to that braces —
    // NOTHING may wait forever, whatever the delivery does.
    vi.doMock('./command-delivery', () => ({
      VERIFY_TIMEOUT_MS: 2000,
      DELIVERY_ATTEMPTS: 3,
      KILL_LINE: '\x15',
      deliverCommand: () => () => {} // started, never settles
    }))
    const mod = await import('./agent-restart')
    let outcome: string | undefined
    void mod
      .performRestartResume({
        agentId: 'claude',
        sessionId: 'sid-1',
        io: { write: () => {}, onData: () => () => {} },
        paneCommand: async () => 'zsh',
        timeoutMs: 1000,
        pollMs: 100
      })
      .then((o) => (outcome = o))
    await vi.advanceTimersByTimeAsync(200)
    expect(outcome).toBeUndefined() // still holding the node, as designed
    await vi.advanceTimersByTimeAsync(60_000)
    expect(outcome).toBe('restarted')
  })
})

describe('guardConcurrentRestart', () => {
  // The in-flight set is module-global: a test that leaves a restart running would otherwise
  // refuse the next test's restart of the same node id.
  beforeEach(() => {
    __resetAgentRestartForTests()
    vi.useFakeTimers()
  })
  afterEach(() => vi.useRealTimers())

  it('holds the node until the delivery settles, not merely until the restart resolves', async () => {
    const { written, io } = silentIo()
    const run = guardConcurrentRestart('n-overlap', () =>
      performRestartResume({
        agentId: 'claude',
        sessionId: 'sid-1',
        io,
        paneCommand: async () => 'zsh',
        timeoutMs: 1000,
        pollMs: 100
      })
    )
    const probe = guardConcurrentRestart('n-overlap', async () => 'restarted')
    const first = run()
    await vi.advanceTimersByTimeAsync(150)
    // The resume line is in the pane but NOT submitted (no echo to verify it).
    expect(written.join('')).toContain('claude --resume sid-1')
    // A second menu/bulk click landing in that window would splice `/exit` into the pending line
    // and submit `claude --resume sid-1/exit`.
    expect(await run()).toBe('not-eligible')
    expect(await probe()).toBe('not-eligible')
    expect(written.filter((w) => w === '/exit\r')).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(10_000) // the fail-open submit ends the delivery
    expect(await first).toBe('restarted')
    expect(await probe()).toBe('restarted') // pane free again
  })

  it('refuses a second call while one is in flight, without running it twice', async () => {
    let runs = 0
    let release: (o: RestartOutcome) => void = () => {}
    const guarded = guardConcurrentRestart('n1', () => {
      runs += 1
      return new Promise<RestartOutcome>((r) => (release = r))
    })
    const first = guarded()
    expect(await guarded()).toBe('not-eligible') // menu + bulk hitting one node
    expect(runs).toBe(1)
    release('restarted')
    expect(await first).toBe('restarted')
    const second = guarded() // guard released once the run settled
    expect(runs).toBe(2)
    release('exit-timeout')
    expect(await second).toBe('exit-timeout')
  })

  it('guards per node, not globally', async () => {
    const pending = (): Promise<RestartOutcome> => new Promise(() => {})
    const a = guardConcurrentRestart('n1', pending)
    const b = guardConcurrentRestart('n2', async () => 'restarted')
    void a()
    expect(await b()).toBe('restarted')
  })

  it('releases the guard when the run throws', async () => {
    let runs = 0
    const guarded = guardConcurrentRestart('n3', async () => {
      runs += 1
      throw new Error('ipc died')
    })
    await expect(guarded()).rejects.toThrow('ipc died')
    await expect(guarded()).rejects.toThrow('ipc died')
    expect(runs).toBe(2)
  })
})

describe('agent restart registry', () => {
  beforeEach(() => __resetAgentRestartForTests())

  it('registers, resolves and unregisters; re-register supersedes', () => {
    const a = async (): Promise<RestartOutcome> => 'restarted'
    const un = registerAgentRestart('n1', a)
    expect(agentRestartFn('n1')).toBe(a)
    const b = async (): Promise<RestartOutcome> => 'exit-timeout'
    registerAgentRestart('n1', b)
    un() // stale unregister from the superseded registration must be inert
    expect(agentRestartFn('n1')).toBe(b)
  })

  it('drops a live registration on unregister (node unmount)', () => {
    const fn = async (): Promise<RestartOutcome> => 'restarted'
    registerAgentRestart('n2', fn)()
    expect(agentRestartFn('n2')).toBeUndefined()
  })
})

describe('summarizeOutcomes', () => {
  it('counts restarted / timeout / pre-skips into the toast line', () => {
    expect(
      summarizeOutcomes(['restarted', 'restarted', 'exit-timeout'], { working: 2, noSession: 1 })
    ).toBe('2 restarted · 1 failed (exit timeout) · 2 skipped (working) · 1 skipped (no session)')
    expect(summarizeOutcomes(['restarted'], { working: 0, noSession: 0 })).toBe('1 restarted')
  })
})

describe('planBulkRestart', () => {
  const cand = (over: Partial<BulkRestartCandidate> & { id: string }): BulkRestartCandidate => ({
    agentId: 'claude',
    state: 'waiting',
    sessionId: `sid-${over.id}`,
    wired: true,
    ...over
  })

  it('runs the eligible nodes and counts the busy / session-less ones', () => {
    const plan = planBulkRestart([
      cand({ id: 'a' }),
      cand({ id: 'b', state: 'working' }),
      cand({ id: 'c', state: 'blocked' }), // permission prompt — busy, same bucket
      cand({ id: 'd', sessionId: undefined }),
      cand({ id: 'e', agentId: 'codex' })
    ])
    expect(plan.runnable).toEqual(['a', 'e'])
    expect(plan.skipped).toEqual({ working: 2, noSession: 1 })
  })

  it('ignores nodes that were never restart targets, instead of counting them as skips', () => {
    const plan = planBulkRestart([
      cand({ id: 'shell', agentId: undefined }), // plain terminal
      cand({ id: 'gem', agentId: 'gemini' }), // no exit sequence / no --resume
      cand({ id: 'a' })
    ])
    expect(plan.runnable).toEqual(['a'])
    expect(plan.skipped).toEqual({ working: 0, noSession: 0 })
  })

  it('counts an eligible but unwired node (parked / not mounted) as a no-session skip', () => {
    const plan = planBulkRestart([cand({ id: 'a' }), cand({ id: 'parked', wired: false })])
    expect(plan.runnable).toEqual(['a'])
    expect(plan.skipped).toEqual({ working: 0, noSession: 1 })
  })

  it('keeps canvas order', () => {
    const plan = planBulkRestart([cand({ id: 'z' }), cand({ id: 'm' }), cand({ id: 'a' })])
    expect(plan.runnable).toEqual(['z', 'm', 'a'])
  })
})

describe('settleRestart', () => {
  it('passes a resolved outcome through untouched', async () => {
    await expect(settleRestart(async () => 'restarted')).resolves.toBe('restarted')
    await expect(settleRestart(async () => 'exit-timeout')).resolves.toBe('exit-timeout')
    await expect(settleRestart(async () => 'not-eligible')).resolves.toBe('not-eligible')
  })

  it('turns a thrown restart into a counted failure', async () => {
    await expect(
      settleRestart(async () => {
        // what a CONNECTING relay websocket does to the very first write
        throw new DOMException('Still in CONNECTING state.', 'InvalidStateError')
      })
    ).resolves.toBe('exit-timeout')
  })

  it('lets a bulk run keep going, and reach its summary, past a throwing node', async () => {
    const fns: (() => Promise<RestartOutcome>)[] = [
      async () => 'restarted',
      async () => {
        throw new Error('ws send failed')
      },
      async () => 'restarted'
    ]
    const outcomes: RestartOutcome[] = []
    for (const fn of fns) outcomes.push(await settleRestart(fn))
    expect(outcomes).toEqual(['restarted', 'exit-timeout', 'restarted'])
    expect(summarizeBulkRestart(outcomes, { working: 0, noSession: 0 })).toBe(
      '2 restarted · 1 failed (exit timeout)'
    )
  })
})

describe('summarizeBulkRestart', () => {
  it("folds 'not-eligible' outcomes into the no-session skips (the line stays four parts)", () => {
    expect(
      summarizeBulkRestart(['restarted', 'not-eligible', 'not-eligible'], {
        working: 1,
        noSession: 1
      })
    ).toBe('1 restarted · 1 skipped (working) · 3 skipped (no session)')
  })

  it('reports a run where every node was busy', () => {
    expect(summarizeBulkRestart([], { working: 2, noSession: 0 })).toBe(
      '0 restarted · 2 skipped (working)'
    )
  })

  it('matches summarizeOutcomes when nothing turned out ineligible', () => {
    const outcomes: RestartOutcome[] = ['restarted', 'exit-timeout']
    expect(summarizeBulkRestart(outcomes, { working: 0, noSession: 0 })).toBe(
      summarizeOutcomes(outcomes, { working: 0, noSession: 0 })
    )
  })
})
