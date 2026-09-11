import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionHostSpawnOptions } from '../session-host/protocol'

class FakePty {
  readonly pid = 4242
  readonly cols = 80
  readonly rows = 24
  readonly process = 'fake-shell'
  handleFlowControl = false
  readonly writes: string[] = []
  echoWrites = true
  onWrite: ((data: string) => void) | undefined
  private readonly dataListeners = new Set<(data: string) => void>()
  private readonly exitListeners = new Set<(event: { exitCode: number }) => void>()

  readonly onData = (listener: (data: string) => void): { dispose(): void } => {
    this.dataListeners.add(listener)
    return { dispose: () => this.dataListeners.delete(listener) }
  }

  readonly onExit = (
    listener: (event: { exitCode: number }) => void
  ): { dispose(): void } => {
    this.exitListeners.add(listener)
    return { dispose: () => this.exitListeners.delete(listener) }
  }

  write(data: string): void {
    this.writes.push(data)
    this.onWrite?.(data)
    if (this.echoWrites && data !== '\r' && data !== '\x15' && data !== '\x1b') this.emitData(data)
  }

  emitData(data: string): void {
    for (const listener of [...this.dataListeners]) listener(data)
  }

  emitExit(exitCode = 0): void {
    for (const listener of [...this.exitListeners]) listener({ exitCode })
  }

  resize(): void {}
  clear(): void {}
  kill(): void {}
  pause(): void {}
  resume(): void {}
}

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  termWrite: vi.fn(),
  termSerialize: vi.fn(() => ''),
  termDispose: vi.fn()
}))

vi.mock('node-pty', () => ({ spawn: mocks.spawn }))
vi.mock('../session-host/terminal-emulator', () => ({
  TerminalEmulator: class {
    write = mocks.termWrite
    serialize = mocks.termSerialize
    dispose = mocks.termDispose
    resize = vi.fn()
  }
}))

import { HostSession } from '../session-host/session'

const LAUNCH_ID = '123e4567-e89b-42d3-a456-426614174000'
const COMMAND = 'private command --with opaque arguments'

function spawnOptions(over: Partial<SessionHostSpawnOptions> = {}): SessionHostSpawnOptions {
  return {
    cwd: 'C:\\project',
    shell: 'C:\\Windows\\System32\\cmd.exe',
    args: [],
    env: {},
    cols: 80,
    rows: 24,
    launchDialect: 'cmd',
    ...over
  }
}

function session(over: Partial<SessionHostSpawnOptions> = {}): {
  host: HostSession
  proc: FakePty
  spawn: SessionHostSpawnOptions
} {
  const proc = new FakePty()
  mocks.spawn.mockReturnValueOnce(proc)
  const spawn = spawnOptions(over)
  return { host: new HostSession('nt-launch', spawn, 1_000), proc, spawn }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
})

describe('HostSession generation-scoped launch ledger', () => {
  it('executes one launch id once, caches success, and rejects a changed fingerprint', async () => {
    const { host, proc } = session()
    const privateStates: boolean[] = []
    proc.onWrite = () => privateStates.push(host.suppressingPrivateLaunchOutput)

    const first = host.executeLaunch(LAUNCH_ID, COMMAND)
    await vi.advanceTimersByTimeAsync(1_500)
    await expect(first).resolves.toEqual({ status: 'executed' })
    await expect(host.executeLaunch(LAUNCH_ID, COMMAND)).resolves.toEqual({
      status: 'already-executed'
    })
    await expect(host.executeLaunch(LAUNCH_ID, COMMAND + ' changed')).rejects.toThrow(
      'launch id was reused with different input'
    )

    expect(proc.writes).toEqual([COMMAND, '\r'])
    expect(privateStates).toEqual([true, true])
    expect(host.suppressingPrivateLaunchOutput).toBe(false)
  })

  it('caches a sanitized failed outcome and never writes the same id again', async () => {
    const { host, proc } = session()
    proc.echoWrites = false
    // Attach the rejection handler BEFORE advancing timers. The launch rejects during the timer
    // advance, so creating the promise and only asserting on it afterwards leaves a window with
    // no handler attached — Vitest reports that as an unhandled rejection and warns it "might
    // cause false positive tests". It was the only thing making an otherwise all-passing suite
    // exit non-zero.
    const first = host.executeLaunch(LAUNCH_ID, COMMAND)
    const firstSettled = expect(first).rejects.toThrow('session-host launch delivery failed')
    await vi.advanceTimersByTimeAsync(8_000)
    await firstSettled
    const writesAfterFailure = [...proc.writes]
    await expect(host.executeLaunch(LAUNCH_ID, COMMAND)).rejects.toThrow(
      'session-host launch delivery previously failed'
    )
    expect(proc.writes).toEqual(writesAfterFailure)
    expect(proc.writes.filter((value) => value === COMMAND)).toHaveLength(3)
    expect(host.suppressingPrivateLaunchOutput).toBe(false)
  })

  it('uses the same ledger for an atomic initial launch and its lost-reply replay', async () => {
    const { host, proc, spawn } = session({
      initialLaunch: { launchId: LAUNCH_ID, command: COMMAND }
    })
    const first = host.executeInitialLaunch(spawn)
    await vi.advanceTimersByTimeAsync(1_500)
    await expect(first).resolves.toEqual({ status: 'executed' })
    await expect(host.executeInitialLaunch(spawn)).resolves.toEqual({
      status: 'already-executed'
    })
    expect(proc.writes.filter((value) => value === COMMAND)).toHaveLength(1)
  })

  it('never types stdin-after-start when the agent readiness probe stays false', async () => {
    const { host, proc } = session()
    const prompt = 'private Gemini prompt'
    // Attach the rejection handler BEFORE advancing timers. The launch rejects during the timer
    // advance, so creating the promise and only asserting on it afterwards leaves a window with
    // no handler attached — Vitest reports that as an unhandled rejection and warns it "might
    // cause false positive tests". It was the only thing making an otherwise all-passing suite
    // exit non-zero.
    const launched = host.executeLaunch(LAUNCH_ID, COMMAND, prompt, async () => false)
    const settled = expect(launched).rejects.toThrow('session-host launch delivery failed')
    await vi.advanceTimersByTimeAsync(7_000)
    await settled
    expect(proc.writes).not.toContain(prompt)
    expect(proc.writes.filter((value) => value === COMMAND)).toHaveLength(1)
  })

  it('types stdin-after-start exactly once only after readiness is confirmed', async () => {
    const { host, proc } = session()
    const prompt = 'private Gemini prompt'
    let probes = 0
    const launched = host.executeLaunch(LAUNCH_ID, COMMAND, prompt, async () => ++probes >= 2)
    await vi.advanceTimersByTimeAsync(4_000)
    await expect(launched).resolves.toEqual({ status: 'executed' })
    await expect(
      host.executeLaunch(LAUNCH_ID, COMMAND, prompt, async () => true)
    ).resolves.toEqual({ status: 'already-executed' })
    expect(proc.writes.filter((value) => value === prompt)).toHaveLength(1)
    expect(probes).toBeGreaterThanOrEqual(2)
  })
})
