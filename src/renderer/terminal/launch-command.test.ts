import { commitLaunchAttempt } from './launch-attempt'
import type { PendingLaunch } from '@shared/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createLaunchWriter, deliverInitialLaunch, launchCommand, registerLaunchWriter } from './launch-command'
import { KILL_LINE, WINDOWS_KILL_LINE, VERIFY_TIMEOUT_MS, DELIVERY_ATTEMPTS } from './command-delivery'

function fixture(attempted = false, killLine = KILL_LINE) {
  const cleanups: Array<() => void> = []
  let output: ((text: string) => void) | undefined
  const write = vi.fn()
  const shellReady = vi.fn(async () => true)
  let durable: PendingLaunch = { after: [], command: '', attempted }
  const save = vi.fn(async () => {})
  const writer = createLaunchWriter({ claimAttempt: (manual, command) => commitLaunchAttempt({
    pending: { ...durable, command }, command, manual,
    update: (next) => { durable = next }, save
  }), io: {
    write, onData: (cb) => { output = cb; return () => { output = undefined } }
  }, shellReady, killLine, cleanup: (cancel) => cleanups.push(cancel) })
  return { writer, write, shellReady, save, snapshot: () => JSON.parse(JSON.stringify(durable)) as PendingLaunch, echo: (text: string) => output?.(text),
    dispose: () => cleanups.forEach((fn) => fn()) }
}
async function tick() { for (let i = 0; i < 12; i++) await Promise.resolve() }
afterEach(() => vi.useRealTimers())
describe('durable launch delivery', () => {
  it('acknowledges only after echoed command and Enter; stale UI and concurrent clicks never paste twice', async () => {
    const f = fixture()
    const command = 'claude complete-brief'
    const first = f.writer(command, false)
    expect(f.writer(command, true)).toBe(first)
    await tick()
    expect(f.write.mock.calls).toEqual([[command]])
    f.echo(command)
    expect(await first).toBe('submitted')
    expect(await f.writer(command, true)).toBe('submitted')
    expect(f.write.mock.calls).toEqual([[command], ['\r']])
  })
  it('repairs a swallowed head using Ctrl-U before submitting', async () => {
    vi.useFakeTimers()
    const f = fixture()
    const command = 'claude complete-brief'
    const result = f.writer(command, false)
    await tick()
    f.echo('complete-brief')
    await vi.advanceTimersByTimeAsync(VERIFY_TIMEOUT_MS)
    expect(f.write.mock.calls).toEqual([[command], [KILL_LINE], [command]])
    f.echo(command)
    expect(await result).toBe('submitted')
  })
  it('retains overlong unverified launches and refuses automatic reattempts, but permits an explicit retry', async () => {
    vi.useFakeTimers()
    const f = fixture()
    const command = 'x'.repeat(2000)
    const result = f.writer(command, false)
    await vi.advanceTimersByTimeAsync(VERIFY_TIMEOUT_MS * DELIVERY_ATTEMPTS)
    expect(await result).toBe('line-too-long')
    expect(f.write).not.toHaveBeenCalledWith('\r')
    const calls = f.write.mock.calls.length
    expect(await f.writer(command, false)).toBe('cancelled')
    expect(f.write).toHaveBeenCalledTimes(calls)
    const retry = f.writer(command, true)
    await tick()
    f.echo(command)
    expect(await retry).toBe('submitted')
  })
  it('does not replay a durable command on warm resume even if its successful clear was never saved', async () => {
    const f = fixture(true)
    expect(await f.writer('codex brief', false)).toBe('cancelled')
    expect(f.write).not.toHaveBeenCalled()
    f.shellReady.mockResolvedValue(false) // running agent/editor: manual retry also refuses
    expect(await f.writer('codex brief', true)).toBe('cancelled')
    expect(f.write).not.toHaveBeenCalled()
    f.shellReady.mockResolvedValue(true)
    const retry = f.writer('codex brief', true)
    await tick()
    f.echo('codex brief')
    expect(await retry).toBe('submitted')
  })
  it('manual Windows recovery clears a partial line with Escape and submits Enter separately after echo', async () => {
    const f = fixture(true, WINDOWS_KILL_LINE)
    const result = f.writer('codex brief', true)
    await tick()
    expect(f.write.mock.calls).toEqual([[WINDOWS_KILL_LINE], ['codex brief']])
    f.echo('codex brief')
    expect(await result).toBe('submitted')
    expect(f.write.mock.calls).toEqual([[WINDOWS_KILL_LINE], ['codex brief'], ['\r']])
    expect(f.write).not.toHaveBeenCalledWith(KILL_LINE)
  })
  it('cancels teardown during shell probing without losing the command or writing late', async () => {
    const f = fixture()
    let ready!: (value: boolean) => void
    f.shellReady.mockImplementation(() => new Promise((resolve) => { ready = resolve }))
    const result = f.writer('codex brief', false)
    f.dispose()
    ready(true)
    expect(await result).toBe('cancelled')
    expect(f.write).not.toHaveBeenCalled()
  })
  it('cancels teardown during echo verification without Enter or an orphan retry timer', async () => {
    vi.useFakeTimers()
    const f = fixture()
    const result = f.writer('codex brief', false)
    await tick()
    f.dispose()
    expect(await result).toBe('cancelled')
    await vi.runAllTimersAsync()
    expect(f.write.mock.calls).toEqual([['codex brief']])
  })
  it.each(['probe', 'command', 'enter'])('reports a rejected %s as unconfirmed and allows manual recovery', async (failure) => {
    const f = fixture()
    if (failure === 'probe') f.shellReady.mockRejectedValueOnce(new Error('offline'))
    else f.write.mockImplementation((text) => {
      if (failure === 'command' || text === '\r') throw new Error('offline')
    })
    const result = f.writer('claude brief', false)
    await tick()
    f.echo('claude brief')
    expect(await result).toBe('cancelled')
    f.write.mockReset()
    const retry = f.writer('claude brief', true)
    await tick()
    f.echo('claude brief')
    expect(await retry).toBe('submitted')
  })
  it('an unmounted writer cannot be reached, and an old cleanup cannot remove its replacement', async () => {
    const first = registerLaunchWriter('node', async () => 'cancelled')
    const second = registerLaunchWriter('node', async () => 'submitted')
    first()
    expect(await launchCommand('node', 'cmd')).toBe('submitted')
    second()
    expect(await launchCommand('node', 'cmd', true)).toBe('cancelled')
  })
})

describe('UI initial-command lifecycle', () => {
  it.each(['submitted', 'cancelled', 'line-too-long'] as const)('retains intent through settle and only discards it on submitted (%s)', async (outcome) => {
    let ready!: () => void
    let settle!: (outcome: 'submitted' | 'cancelled' | 'line-too-long') => void
    const state: { initialCommand?: string; pendingLaunch?: { command: string } } = { initialCommand: 'claude original-brief' }
    const write = vi.fn(() => new Promise<'submitted' | 'cancelled' | 'line-too-long'>((resolve) => { settle = resolve }))
    const onFailure = vi.fn()
    deliverInitialLaunch(state.initialCommand!, {
      whenReady: (run) => { ready = run }, write,
      update: (patch) => { Object.assign(state, patch) }, onFailure
    })
    // Teardown/park before ready cannot lose the brief: both live and durable intent remain.
    expect(write).not.toHaveBeenCalled()
    expect(state.initialCommand).toBe('claude original-brief')
    expect(state.pendingLaunch).toEqual({ after: [], command: 'claude original-brief', attempted: false })
    ready()
    expect(write).toHaveBeenCalledWith('claude original-brief', false)
    expect(state.initialCommand).toBe('claude original-brief')
    settle(outcome)
    await tick()
    expect(state.initialCommand).toBeUndefined()
    if (outcome === 'submitted') {
      expect(state.pendingLaunch).toBeUndefined()
      expect(onFailure).not.toHaveBeenCalled()
    } else {
      expect(state.pendingLaunch?.command).toBe('claude original-brief')
      expect(onFailure).toHaveBeenCalledWith(outcome)
    }
  })
})

describe('warm launch recovery after the park expires', () => {
  it('automatically runs a never-attempted saved launch after a new writer attaches to its shell', async () => {
    const original = fixture()
    const snapshot = original.snapshot()
    original.dispose() // park expiry destroys the view, not the saved intent or tmux shell
    const warm = fixture(snapshot.attempted)
    const delivery = warm.writer('claude upstream-result', false)
    await tick()
    expect(warm.save).toHaveBeenCalledTimes(1)
    expect(warm.snapshot().attempted).toBe(true)
    warm.echo('claude upstream-result')
    expect(await delivery).toBe('submitted')
    expect(warm.write.mock.calls).toEqual([['claude upstream-result'], ['\r']])
  })
  it('will not write before the durable attempt save resolves, and refuses a failed save', async () => {
    const f = fixture()
    let reject!: (e: Error) => void
    f.save.mockImplementationOnce(() => new Promise((_, fail) => { reject = fail }))
    const result = f.writer('claude brief', false)
    await tick()
    expect(f.snapshot().attempted).toBe(true)
    expect(f.write).not.toHaveBeenCalled()
    reject(new Error('disk offline'))
    expect(await result).toBe('cancelled')
    expect(f.write).not.toHaveBeenCalled()
  })
  it('rechecks shell ownership after persistence before writing', async () => {
    const f = fixture()
    f.shellReady.mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    expect(await f.writer('claude brief', false)).toBe('cancelled')
    expect(f.save).toHaveBeenCalledTimes(1)
    expect(f.write).not.toHaveBeenCalled()
    const warm = fixture(f.snapshot().attempted)
    expect(await warm.writer('claude brief', false)).toBe('cancelled')
    expect(warm.write).not.toHaveBeenCalled()
  })
})

it.each([true, undefined])('a retained initialCommand alias cannot reset attempted=%s', (attempted) => {
  const state = { initialCommand: 'cmd' as string | undefined,
    pendingLaunch: { after: [], command: 'cmd', attempted, manualOnly: true } }
  const write = vi.fn(), whenReady = vi.fn(), onFailure = vi.fn()
  deliverInitialLaunch('cmd', { pending: state.pendingLaunch, write, whenReady, onFailure,
    update: (patch) => Object.assign(state, patch) })
  expect(state.initialCommand).toBeUndefined()
  expect(state.pendingLaunch).toMatchObject({ attempted, manualOnly: true, command: 'cmd' })
  expect(whenReady).not.toHaveBeenCalled()
  expect(write).not.toHaveBeenCalled()
})

it('a pre-input deferred claim preserves UI intent and the same parked writer can later deliver once', async () => {
  let ready!: () => void
  let echo!: (text: string) => void
  const write = vi.fn(), failure = vi.fn()
  const claimAttempt = vi.fn<() => Promise<boolean | 'deferred'>>()
    .mockResolvedValueOnce('deferred').mockResolvedValue(true)
  const writer = createLaunchWriter({ claimAttempt, shellReady: async () => true,
    killLine: KILL_LINE, cleanup: () => {},
    io: { write, onData: (cb) => { echo = cb; return () => {} } } })
  const state: { initialCommand?: string; pendingLaunch?: PendingLaunch } = { initialCommand: 'claude brief' }
  deliverInitialLaunch('claude brief', { write: writer, whenReady: (run) => { ready = run },
    update: (patch) => Object.assign(state, patch), onFailure: failure })
  ready()
  await tick()
  expect(state).toMatchObject({ initialCommand: 'claude brief', pendingLaunch: { attempted: false } })
  expect(write).not.toHaveBeenCalled()
  expect(failure).not.toHaveBeenCalled()
  const resumed = writer('claude brief', false)
  await tick()
  expect(write.mock.calls).toEqual([['claude brief']])
  echo('claude brief')
  expect(await resumed).toBe('submitted')
  expect(await writer('claude brief', false)).toBe('submitted')
  expect(write.mock.calls).toEqual([['claude brief'], ['\r']])
})
