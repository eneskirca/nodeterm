import { describe, expect, it, vi } from 'vitest'
import { executeHeldLaunch, outcomeForLaunchResult, type HeldLaunchDeps } from './launch-intent'
import { createLaunchWriter } from './launch-command'
import { KILL_LINE } from '@shared/command-delivery'
import type { HeldLaunchIntent, LaunchIntentExecutionResult } from '@shared/types'

const COMMAND = `claude 'it'\\''s'`
const HELD: HeldLaunchIntent = {
  command: COMMAND,
  intent: { kind: 'agent', action: 'start', agentId: 'claude', prompt: "it's" }
}
const OK: LaunchIntentExecutionResult = { ok: true }

function deps(extra: Partial<HeldLaunchDeps> = {}) {
  const executeLaunch = vi.fn(async () => OK)
  const hostPlatform = vi.fn(async () => 'win32' as string | null)
  const d: HeldLaunchDeps = {
    held: () => HELD,
    sessionHost: true,
    source: 'local',
    hostPlatform,
    executeLaunch,
    newLaunchId: () => 'id-1',
    ...extra
  }
  return { d, executeLaunch, hostPlatform }
}

describe('executeHeldLaunch', () => {
  it('executes the held intent for a local session-host pane on a win32 core', async () => {
    const { d, executeLaunch } = deps()
    expect(await executeHeldLaunch(COMMAND, d)).toBe('submitted')
    expect(executeLaunch).toHaveBeenCalledWith({ launchId: 'id-1', intent: HELD.intent })
  })

  it('carries a prompt file to the core instead of the `$(cat …)` line', async () => {
    const file: HeldLaunchIntent = {
      ...HELD,
      intent: { kind: 'agent', action: 'start', agentId: 'claude' },
      promptFile: 'C:\\b.md'
    }
    const { d, executeLaunch } = deps({ held: (): HeldLaunchIntent => file })
    await executeHeldLaunch(COMMAND, d)
    expect(executeLaunch).toHaveBeenCalledWith({ launchId: 'id-1', intent: file.intent, promptFile: 'C:\\b.md' })
  })

  const other: HeldLaunchIntent = { ...HELD, command: 'claude other' }
  const fallbacks: Array<[string, Partial<HeldLaunchDeps>]> = [
    ['no held intent', { held: () => undefined }],
    ['an intent for a different line', { held: () => other }],
    ['a tmux pane', { sessionHost: false }],
    ['a relay tab', { source: 'relay' }],
    ['a surface without the channel', { executeLaunch: undefined }]
  ]
  it.each(fallbacks)('falls back without any IPC for %s', async (_n, extra) => {
    const { d, executeLaunch, hostPlatform } = deps(extra)
    expect(await executeHeldLaunch(COMMAND, d)).toBe('fallback')
    expect(executeLaunch).not.toHaveBeenCalled()
    expect(hostPlatform).not.toHaveBeenCalled()
  })

  it.each(['darwin', 'linux', null])('falls back on a %s core', async (platform) => {
    const { d, executeLaunch } = deps({ hostPlatform: async () => platform })
    expect(await executeHeldLaunch(COMMAND, d)).toBe('fallback')
    expect(executeLaunch).not.toHaveBeenCalled()
  })

  it('never falls back after a delivery that may have reached the pane', async () => {
    const thrown = deps({ executeLaunch: async () => { throw new Error('ipc') } })
    expect(await executeHeldLaunch(COMMAND, thrown.d)).toBe('cancelled')
    expect(outcomeForLaunchResult({ ok: false, reason: 'delivery-failed', message: '' })).toBe('cancelled')
    for (const reason of ['invalid-intent', 'agent-unavailable', 'unsupported-shell', 'session-unavailable'] as const) {
      expect(outcomeForLaunchResult({ ok: false, reason, message: '' })).toBe('fallback')
    }
  })
})

describe('createLaunchWriter execute hook', () => {
  function writer(execute: (c: string, m: boolean) => Promise<'submitted' | 'cancelled' | 'fallback'>) {
    const write = vi.fn()
    let echo: ((t: string) => void) | undefined
    const claimAttempt = vi.fn(async () => true as const)
    const w = createLaunchWriter({
      claimAttempt,
      shellReady: async () => true,
      killLine: KILL_LINE,
      cleanup: () => {},
      io: { write, onData: (cb) => { echo = cb; return () => {} } },
      execute
    })
    return { w, write, claimAttempt, echo: (t: string) => echo?.(t) }
  }
  const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }

  it('runs after the exactly-once claim, types nothing, and stays submitted', async () => {
    const execute = vi.fn(async () => 'submitted' as const)
    const f = writer(execute)
    expect(await f.w('claude x', false)).toBe('submitted')
    expect(f.claimAttempt).toHaveBeenCalledTimes(1)
    expect(execute).toHaveBeenCalledWith('claude x', false)
    expect(f.write).not.toHaveBeenCalled()
    expect(await f.w('claude x', true)).toBe('submitted')
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('types the legacy line byte-for-byte on fallback', async () => {
    const f = writer(async () => 'fallback')
    const result = f.w('claude x', false)
    await tick()
    expect(f.write.mock.calls).toEqual([['claude x']])
    f.echo('claude x')
    expect(await result).toBe('submitted')
  })

  it('reports an uncertain direct delivery without typing a second copy', async () => {
    const f = writer(async () => 'cancelled')
    expect(await f.w('claude x', false)).toBe('cancelled')
    expect(f.write).not.toHaveBeenCalled()
  })
})
