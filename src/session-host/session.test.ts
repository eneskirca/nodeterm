import { describe, expect, it, vi } from 'vitest'
import type { Socket } from 'net'
import type { IPty } from 'node-pty'
import {
  HostSession,
  KILL_LINE,
  SESSION_EMULATOR_OUTPUT_HIGH_WATER_BYTES,
  SESSION_EMULATOR_OUTPUT_LOW_WATER_BYTES,
  WINDOWS_KILL_LINE,
  shellKillLineSequence
} from './session'
import type { TerminalEmulator } from './terminal-emulator'
import type { SessionHostSpawnOptions } from './protocol'

const SPAWN: SessionHostSpawnOptions = {
  shell: 'unused-in-tests',
  args: [],
  cwd: '.',
  env: {},
  cols: 80,
  rows: 24
}

function fakeProc(): {
  value: IPty
  pause: ReturnType<typeof vi.fn>
  resume: ReturnType<typeof vi.fn>
  resize: ReturnType<typeof vi.fn>
} {
  const pause = vi.fn()
  const resume = vi.fn()
  const resize = vi.fn()
  return {
    value: {
      pid: 42,
      pause,
      resume,
      resize
    } as unknown as IPty,
    pause,
    resume,
    resize
  }
}

function inertTerm(): TerminalEmulator {
  return {
    write: vi.fn(async () => {}),
    serialize: vi.fn(() => ''),
    resize: vi.fn(),
    dispose: vi.fn()
  } as unknown as TerminalEmulator
}
describe('HostSession terminal-output ordering', () => {
  it('waits for every prior asynchronous xterm write before serializing', async () => {
    const proc = fakeProc()
    const applied: string[] = []
    const releases: Array<() => void> = []
    const serialize = vi.fn(() => applied.join(''))
    const write = vi.fn(
      (data: string) =>
        new Promise<void>((resolve) => {
          releases.push(() => {
            applied.push(data)
            resolve()
          })
        })
    )
    const term = {
      write,
      serialize,
      resize: vi.fn(),
      dispose: vi.fn()
    } as unknown as TerminalEmulator
    const session = new HostSession('ordered', SPAWN, 100, { proc: proc.value, term })

    const first = session.recordOutput('first')
    const second = session.recordOutput('second')
    const snapshot = session.serialize()

    await Promise.resolve()
    expect(write).toHaveBeenCalledTimes(1)
    expect(serialize).not.toHaveBeenCalled()

    releases[0]()
    await first
    await Promise.resolve()
    expect(write).toHaveBeenCalledTimes(2)
    expect(serialize).not.toHaveBeenCalled()

    releases[1]()
    await second
    await expect(snapshot).resolves.toBe('firstsecond')
    expect(serialize).toHaveBeenCalledTimes(1)
  })

  it('recovers the ordering tail after one mirror write rejects', async () => {
    const proc = fakeProc()
    const applied: string[] = []
    const term = {
      write: vi.fn(async (data: string) => {
        if (data === 'bad') throw new Error('synthetic mirror rejection')
        applied.push(data)
      }),
      serialize: vi.fn(() => applied.join('')),
      resize: vi.fn(),
      dispose: vi.fn()
    } as unknown as TerminalEmulator
    const session = new HostSession('recover', SPAWN, 100, { proc: proc.value, term })

    await expect(session.recordOutput('bad')).rejects.toThrow('synthetic mirror rejection')
    await expect(session.recordOutput('good')).resolves.toBeUndefined()
    await expect(session.serialize()).resolves.toBe('good')
  })
})

describe('HostSession connection-scoped pause ownership', () => {
  it('resumes only after the last pausing connection returns its ticket', () => {
    const proc = fakeProc()
    const term = {
      write: vi.fn(async () => {}),
      serialize: vi.fn(() => ''),
      resize: vi.fn(),
      dispose: vi.fn()
    } as unknown as TerminalEmulator
    const session = new HostSession('flow', SPAWN, 100, { proc: proc.value, term })
    const a = {} as Socket
    const b = {} as Socket
    const stranger = {} as Socket
    session.subscribers.add(a)
    session.subscribers.add(b)

    session.pauseFor(a)
    session.pauseFor(a) // a re-asserted high-water pause is idempotent
    session.pauseFor(b)
    expect(proc.pause).toHaveBeenCalledTimes(1)

    session.resumeFor(stranger) // a socket cannot release another socket's pause
    session.resumeFor(a)
    expect(proc.resume).not.toHaveBeenCalled()

    session.resumeFor(b)
    expect(proc.resume).toHaveBeenCalledTimes(1)
    session.resumeFor(b)
    expect(proc.resume).toHaveBeenCalledTimes(1)
  })

  it('returns a crashed connection\'s pause ticket during detach without disturbing peers', async () => {
    const proc = fakeProc()
    const term = {
      write: vi.fn(async () => {}),
      serialize: vi.fn(() => ''),
      resize: vi.fn(),
      dispose: vi.fn()
    } as unknown as TerminalEmulator
    const session = new HostSession('disconnect', SPAWN, 100, { proc: proc.value, term })
    const crashed = {} as Socket
    const healthy = {} as Socket
    session.subscribers.add(crashed)
    session.subscribers.add(healthy)

    session.pauseFor(crashed)
    session.pauseFor(healthy)
    await session.detach(crashed)
    expect(session.subscribers.has(crashed)).toBe(false)
    expect(session.subscribers.has(healthy)).toBe(true)
    expect(proc.resume).not.toHaveBeenCalled()

    await session.detach(healthy)
    expect(proc.resume).toHaveBeenCalledTimes(1)
  })

  it('keeps explicit and transport ownership independent and gates strangers', () => {
    const proc = fakeProc()
    const session = new HostSession('owner-kinds', SPAWN, 100, {
      proc: proc.value,
      term: inertTerm()
    })
    const subscriber = {} as Socket
    const stranger = {} as Socket
    session.subscribers.add(subscriber)

    session.pauseFor(subscriber)
    session.pauseTransportFor(subscriber)
    session.pauseFor(stranger)
    session.pauseTransportFor(stranger)
    expect(proc.pause).toHaveBeenCalledTimes(1)

    session.resumeTransportFor(subscriber)
    session.resumeFor(stranger)
    expect(proc.resume).not.toHaveBeenCalled()
    session.resumeFor(subscriber)
    expect(proc.resume).toHaveBeenCalledTimes(1)
  })

  it('books reconnect pause synchronously before a pending output barrier', async () => {
    const proc = fakeProc()
    let releaseOutput!: () => void
    const term = {
      write: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            releaseOutput = resolve
          })
      ),
      serialize: vi.fn(() => ''),
      resize: vi.fn(),
      dispose: vi.fn()
    } as unknown as TerminalEmulator
    const session = new HostSession('paused-reconnect', SPAWN, 100, { proc: proc.value, term })
    const socket = {} as Socket
    const output = session.recordOutput('pending')

    const preparing = session.prepareAttachment(socket, SPAWN.cols, SPAWN.rows, true)
    expect(proc.pause).toHaveBeenCalledTimes(1)
    expect(session.subscribers.has(socket)).toBe(false)
    await Promise.resolve()
    releaseOutput()
    await output
    const transaction = await preparing
    await transaction.rollback()
    expect(proc.resume).toHaveBeenCalledTimes(1)
  })

  it('inherits an already-backed-up transport on commit and releases it on detach', async () => {
    const proc = fakeProc()
    const session = new HostSession('pre-backed-up', SPAWN, 100, {
      proc: proc.value,
      term: inertTerm()
    })
    const socket = { writableNeedDrain: true } as Socket
    const transaction = await session.prepareAttachment(
      socket,
      SPAWN.cols,
      SPAWN.rows,
      false
    )

    expect(transaction.commit()).toBe(true)
    expect(proc.pause).toHaveBeenCalledTimes(1)
    await session.detach(socket)
    expect(proc.resume).toHaveBeenCalledTimes(1)
  })
})

describe('HostSession per-socket geometry', () => {
  it('applies the componentwise minimum before snapshot and grows when the smaller owner leaves', async () => {
    const proc = fakeProc()
    let geometry = { cols: SPAWN.cols, rows: SPAWN.rows }
    const term = {
      write: vi.fn(async () => {}),
      serialize: vi.fn(() => `${geometry.cols}x${geometry.rows}`),
      resize: vi.fn((cols: number, rows: number) => {
        geometry = { cols, rows }
      }),
      dispose: vi.fn()
    } as unknown as TerminalEmulator
    const session = new HostSession('geometry', SPAWN, 100, { proc: proc.value, term })
    const wide = {} as Socket
    const narrow = {} as Socket

    const wideAttach = await session.prepareAttachment(wide, 100, 50, false)
    wideAttach.commit()
    const narrowAttach = await session.prepareAttachment(narrow, 80, 60, false)

    // The warm snapshot sees the effective 80x50 cross-product before live delivery starts.
    await expect(session.serialize()).resolves.toBe('80x50')
    expect(session.subscribers.has(narrow)).toBe(false)
    narrowAttach.commit()
    expect(proc.resize).toHaveBeenLastCalledWith(80, 50)

    await session.detach(narrow)
    expect(proc.resize).toHaveBeenLastCalledWith(100, 50)
    await expect(session.serialize()).resolves.toBe('100x50')
  })

  it('overwrites a reconnecting socket claim and rolls a failed attach back exactly', async () => {
    const proc = fakeProc()
    const term = inertTerm()
    const session = new HostSession('reconnect-geometry', SPAWN, 100, { proc: proc.value, term })
    const socket = {} as Socket

    const initial = await session.prepareAttachment(socket, 100, 40, false)
    initial.commit()
    const retry = await session.prepareAttachment(socket, 40, 10, true)
    expect(proc.pause).toHaveBeenCalledTimes(1)
    await retry.rollback()

    expect(session.subscribers.has(socket)).toBe(true)
    expect(proc.resume).toHaveBeenCalledTimes(1)
    expect(proc.resize).toHaveBeenLastCalledWith(100, 40)
  })

  it('ignores a resize claim from a non-subscriber', async () => {
    const proc = fakeProc()
    const term = inertTerm()
    const session = new HostSession('resize-membership', SPAWN, 100, {
      proc: proc.value,
      term
    })

    await session.resizeFor({} as Socket, 10, 5)
    expect(proc.resize).not.toHaveBeenCalled()
    expect(term.resize).not.toHaveBeenCalled()
  })

  it('cancels a delayed attach on detach instead of resurrecting its socket or claim', async () => {
    const proc = fakeProc()
    let releaseOutput!: () => void
    const term = {
      write: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            releaseOutput = resolve
          })
      ),
      serialize: vi.fn(() => ''),
      resize: vi.fn(),
      dispose: vi.fn()
    } as unknown as TerminalEmulator
    const session = new HostSession('cancelled-attach', SPAWN, 100, { proc: proc.value, term })
    const cancelled = {} as Socket
    const replacement = {} as Socket

    const output = session.recordOutput('real-output-barrier')
    await Promise.resolve()
    const preparing = session.prepareAttachment(cancelled, 40, 10, true)
    let prepared = false
    void preparing.then(() => {
      prepared = true
    })
    await Promise.resolve()
    expect(prepared).toBe(false)
    const detaching = session.detach(cancelled)
    releaseOutput()
    await output
    const transaction = await preparing
    expect(transaction.commit()).toBe(false)
    await detaching
    expect(session.subscribers.has(cancelled)).toBe(false)
    expect(proc.resume).toHaveBeenCalledTimes(1)

    const replacementTransaction = await session.prepareAttachment(replacement, 100, 50, false)
    expect(replacementTransaction.commit()).toBe(true)
    expect(proc.resize).toHaveBeenLastCalledWith(100, 50)
  })

  it('retries an identical geometry after the emulator rejected its first resize', async () => {
    const proc = fakeProc()
    let attempts = 0
    const term = {
      write: vi.fn(async () => {}),
      serialize: vi.fn(() => ''),
      resize: vi.fn(() => {
        attempts++
        if (attempts === 1) throw new Error('synthetic resize failure')
      }),
      dispose: vi.fn()
    } as unknown as TerminalEmulator
    const session = new HostSession('resize-retry', SPAWN, 100, { proc: proc.value, term })
    const socket = {} as Socket
    const attached = await session.prepareAttachment(socket, SPAWN.cols, SPAWN.rows, false)
    attached.commit()

    const first = session.resizeFor(socket, 100, 40)
    const identicalFollower = session.resizeFor(socket, 100, 40)
    await expect(first).rejects.toThrow('synthetic resize failure')
    await expect(identicalFollower).rejects.toThrow('synthetic resize failure')
    await expect(session.resizeFor(socket, 100, 40)).resolves.toBeUndefined()
    expect(term.resize).toHaveBeenCalledTimes(2)
    expect(proc.resize).toHaveBeenCalledTimes(2)
  })

  it('rejects non-finite geometry without poisoning a healthy peer claim', async () => {
    const proc = fakeProc()
    const term = inertTerm()
    const session = new HostSession('finite-geometry', SPAWN, 100, { proc: proc.value, term })
    const wide = {} as Socket
    const narrow = {} as Socket
    const wideAttach = await session.prepareAttachment(wide, 100, 50, false)
    wideAttach.commit()
    const narrowAttach = await session.prepareAttachment(narrow, 80, 40, false)
    narrowAttach.commit()

    await expect(session.resizeFor(wide, Number.POSITIVE_INFINITY, 30)).rejects.toThrow(
      'finite positive integer'
    )
    await session.detach(narrow)
    expect(proc.resize).toHaveBeenLastCalledWith(100, 50)
    await expect(session.serialize()).resolves.toBe('')
  })
})

describe('HostSession emulator output watermarks', () => {
  it('pauses at 4 MiB and resumes only after the queued tail drains to 1 MiB', async () => {
    const proc = fakeProc()
    const releases: Array<() => void> = []
    const applied: number[] = []
    const term = {
      write: vi.fn(
        (data: string) =>
          new Promise<void>((resolve) => {
            releases.push(() => {
              applied.push(data.length)
              resolve()
            })
          })
      ),
      serialize: vi.fn(() => applied.join(',')),
      resize: vi.fn(),
      dispose: vi.fn()
    } as unknown as TerminalEmulator
    const session = new HostSession('bounded-tail', SPAWN, 100, { proc: proc.value, term })
    const first = session.recordOutput('a'.repeat(2 * 1024 * 1024))
    const second = session.recordOutput('b'.repeat(1024 * 1024))
    const third = session.recordOutput('c'.repeat(1024 * 1024))
    const snapshot = session.serialize()

    expect(SESSION_EMULATOR_OUTPUT_HIGH_WATER_BYTES).toBe(4 * 1024 * 1024)
    expect(SESSION_EMULATOR_OUTPUT_LOW_WATER_BYTES).toBe(1024 * 1024)
    expect(proc.pause).toHaveBeenCalledTimes(1)
    await Promise.resolve()
    releases[0]()
    await first
    expect(proc.resume).not.toHaveBeenCalled() // 2 MiB still queued

    await Promise.resolve()
    releases[1]()
    await second
    expect(proc.resume).toHaveBeenCalledTimes(1) // exactly 1 MiB remains
    expect(term.serialize).not.toHaveBeenCalled()

    await Promise.resolve()
    releases[2]()
    await third
    await expect(snapshot).resolves.toBe('2097152,1048576,1048576')
  })

  it('counts UTF-8 bytes rather than JavaScript code units', async () => {
    const proc = fakeProc()
    let release!: () => void
    const term = {
      write: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            release = resolve
          })
      ),
      serialize: vi.fn(() => ''),
      resize: vi.fn(),
      dispose: vi.fn()
    } as unknown as TerminalEmulator
    const session = new HostSession('utf8-tail', SPAWN, 100, { proc: proc.value, term })

    const write = session.recordOutput('💥'.repeat(SESSION_EMULATOR_OUTPUT_HIGH_WATER_BYTES / 4))
    expect(proc.pause).toHaveBeenCalledTimes(1)
    await Promise.resolve()
    release()
    await write
    expect(proc.resume).toHaveBeenCalledTimes(1)
  })

  it('does not let transport or explicit drains release the emulator owner', async () => {
    const proc = fakeProc()
    let release!: () => void
    const term = {
      write: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            release = resolve
          })
      ),
      serialize: vi.fn(() => ''),
      resize: vi.fn(),
      dispose: vi.fn()
    } as unknown as TerminalEmulator
    const session = new HostSession('three-owners', SPAWN, 100, { proc: proc.value, term })
    const socket = {} as Socket
    session.subscribers.add(socket)

    session.pauseFor(socket)
    session.pauseTransportFor(socket)
    const write = session.recordOutput('x'.repeat(SESSION_EMULATOR_OUTPUT_HIGH_WATER_BYTES))
    session.resumeTransportFor(socket)
    session.resumeFor(socket)
    expect(proc.resume).not.toHaveBeenCalled()

    await Promise.resolve()
    release()
    await write
    expect(proc.resume).toHaveBeenCalledTimes(1)
  })

  it('does not let the emulator low-water drain release an explicit owner', async () => {
    const proc = fakeProc()
    let release!: () => void
    const term = {
      write: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            release = resolve
          })
      ),
      serialize: vi.fn(() => ''),
      resize: vi.fn(),
      dispose: vi.fn()
    } as unknown as TerminalEmulator
    const session = new HostSession('explicit-after-emulator', SPAWN, 100, {
      proc: proc.value,
      term
    })
    const socket = {} as Socket
    session.subscribers.add(socket)
    session.pauseFor(socket)
    const write = session.recordOutput('x'.repeat(SESSION_EMULATOR_OUTPUT_HIGH_WATER_BYTES))

    await Promise.resolve()
    release()
    await write
    expect(proc.resume).not.toHaveBeenCalled()
    session.resumeFor(socket)
    expect(proc.resume).toHaveBeenCalledTimes(1)
  })

  it('releases a rejected chunk\'s bytes and heals the ordering tail', async () => {
    const proc = fakeProc()
    const applied: string[] = []
    const term = {
      write: vi.fn(async (data: string) => {
        if (data.startsWith('bad')) throw new Error('synthetic flood rejection')
        applied.push(data)
      }),
      serialize: vi.fn(() => applied.join('')),
      resize: vi.fn(),
      dispose: vi.fn()
    } as unknown as TerminalEmulator
    const session = new HostSession('rejected-tail', SPAWN, 100, { proc: proc.value, term })

    await expect(
      session.recordOutput('bad'.padEnd(SESSION_EMULATOR_OUTPUT_HIGH_WATER_BYTES, '!'))
    ).rejects.toThrow('synthetic flood rejection')
    expect(proc.pause).toHaveBeenCalledTimes(1)
    expect(proc.resume).toHaveBeenCalledTimes(1)
    await expect(session.recordOutput('good')).resolves.toBeUndefined()
    await expect(session.serialize()).resolves.toBe('good')
  })
})

describe('HostSession launch echo verification', () => {
  // The launch line this leg actually carries: long enough that head and tail windows
  // (ECHO_EDGE_CHARS = 24 each) do not overlap.
  const COMMAND = 'claude --permission-mode auto --session-id 0f9a1c3e-5b7d-4e21-9a86-1d2c3b4a5e6f'

  function deliveryProc(): { value: IPty; written: string[]; emit: (chunk: string) => void } {
    let sink: ((d: string) => void) | undefined
    const written: string[] = []
    return {
      value: {
        pid: 42,
        pause: vi.fn(),
        resume: vi.fn(),
        resize: vi.fn(),
        write: (d: string) => {
          written.push(d)
        },
        onData: (cb: (d: string) => void) => {
          sink = cb
          return { dispose: vi.fn() }
        },
        onExit: () => ({ dispose: vi.fn() })
      } as unknown as IPty,
      written,
      emit: (chunk: string) => sink?.(chunk)
    }
  }

  function deliver(session: HostSession, command: string): Promise<void> {
    return (
      session as unknown as { deliverVerifiedCommand(c: string): Promise<void> }
    ).deliverVerifiedCommand(command)
  }

  it('submits when the head scrolled out of the bounded window before the tail arrived', async () => {
    const proc = deliveryProc()
    const session = new HostSession('echo-window', SPAWN, 100, {
      proc: proc.value,
      term: inertTerm()
    })
    const delivered = deliver(session, COMMAND)

    // The shell echoes the head, then a full-line ZLE redraw pushes more than the window
    // (max(command.length + 256, 512)) of visible characters through before the tail lands.
    // Without a sticky head the two substrings never coexist in `echoed`, all three attempts
    // fail, and this leg REFUSES the launch — the node never starts.
    proc.emit(COMMAND.slice(0, 32))
    proc.emit('x'.repeat(700))
    proc.emit(COMMAND.slice(-32))

    await expect(delivered).resolves.toBeUndefined()
    expect(proc.written.at(-1)).toBe('\r')
  })

  it('still requires the head: a tail-only echo does not submit', async () => {
    const proc = deliveryProc()
    const session = new HostSession('echo-tail-only', SPAWN, 100, {
      proc: proc.value,
      term: inertTerm()
    })
    // Left pending on purpose: this asserts the NON-event, and the retry timer is unref'd.
    void deliver(session, COMMAND).catch(() => {})

    proc.emit('x'.repeat(700))
    proc.emit(COMMAND.slice(-32))

    // submit() is synchronous inside the data handler, so its absence is observable now.
    expect(proc.written).not.toContain('\r')
  })

  it('clears line with \\x1b on Windows PowerShell during retry and refusal', async () => {
    vi.useFakeTimers()
    try {
      const proc = deliveryProc()
      const winSpawn: SessionHostSpawnOptions = {
        ...SPAWN,
        shell: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
        launchDialect: 'windows-powershell'
      }
      const session = new HostSession('echo-win-retry', winSpawn, 100, {
        proc: proc.value,
        term: inertTerm()
      })
      const delivered = deliver(session, COMMAND)
      const failure = expect(delivered).rejects.toThrow(
        'session-host could not verify launch command delivery'
      )
      await vi.advanceTimersByTimeAsync(2_000 * 3)
      await failure
      expect(proc.written).toEqual([
        COMMAND,
        WINDOWS_KILL_LINE,
        COMMAND,
        WINDOWS_KILL_LINE,
        COMMAND,
        WINDOWS_KILL_LINE
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it('clears line with \\x15 on POSIX shells during retry and refusal', async () => {
    vi.useFakeTimers()
    try {
      const proc = deliveryProc()
      const posixSpawn: SessionHostSpawnOptions = {
        ...SPAWN,
        shell: '/bin/zsh',
        launchDialect: 'posix'
      }
      const session = new HostSession('echo-posix-retry', posixSpawn, 100, {
        proc: proc.value,
        term: inertTerm()
      })
      const delivered = deliver(session, COMMAND)
      const failure = expect(delivered).rejects.toThrow(
        'session-host could not verify launch command delivery'
      )
      await vi.advanceTimersByTimeAsync(2_000 * 3)
      await failure
      expect(proc.written).toEqual([
        COMMAND,
        KILL_LINE,
        COMMAND,
        KILL_LINE,
        COMMAND,
        KILL_LINE
      ])
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('shellKillLineSequence', () => {
  it('returns \\x1b for Windows PowerShell, pwsh, and cmd dialects', () => {
    expect(shellKillLineSequence('windows-powershell')).toBe(WINDOWS_KILL_LINE)
    expect(shellKillLineSequence('pwsh')).toBe(WINDOWS_KILL_LINE)
    expect(shellKillLineSequence('cmd')).toBe(WINDOWS_KILL_LINE)
  })

  it('returns \\x15 for posix dialect', () => {
    expect(shellKillLineSequence('posix')).toBe(KILL_LINE)
  })

  it('infers sequence from shell executable name when dialect is omitted', () => {
    expect(shellKillLineSequence(undefined, 'powershell.exe')).toBe(WINDOWS_KILL_LINE)
    expect(shellKillLineSequence(undefined, 'powershell')).toBe(WINDOWS_KILL_LINE)
    expect(shellKillLineSequence(undefined, 'pwsh.exe')).toBe(WINDOWS_KILL_LINE)
    expect(shellKillLineSequence(undefined, 'cmd.exe')).toBe(WINDOWS_KILL_LINE)
    expect(shellKillLineSequence(undefined, 'bash.exe')).toBe(KILL_LINE)
    expect(shellKillLineSequence(undefined, 'zsh')).toBe(KILL_LINE)
  })

  it('falls back based on host platform when dialect and shell executable are unknown', () => {
    expect(shellKillLineSequence(undefined, undefined, 'win32')).toBe(WINDOWS_KILL_LINE)
    expect(shellKillLineSequence(undefined, undefined, 'darwin')).toBe(KILL_LINE)
    expect(shellKillLineSequence(undefined, undefined, 'linux')).toBe(KILL_LINE)
  })
})
