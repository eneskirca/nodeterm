import { describe, it, expect, vi } from 'vitest'
import type { SleepingWakeResult } from '@shared/agents/sleeping-wake'
import { wakeOffscreen, type OffscreenWakeIo, type OffscreenWakeTarget } from './offscreen-wake'
import { guardConcurrentRestart } from './agent-restart'

const target: OffscreenWakeTarget = { projectId: 'hidden-project', nodeId: 'term-sleep', agentId: 'gemini', sessionId: 's1', hibernated: true, paused: false,
  recorded: { panePid: 55, paneId: '%9', command: 'bash' } }
function setup() {
  return { resolve: (() => target) as OffscreenWakeIo['resolve'], current: (() => true) as OffscreenWakeIo['current'],
    command: vi.fn<OffscreenWakeIo['command']>(async (t) => t.projectId === 'hidden-project' ? 'gemini --resume s1 --approval-mode plan' : null),
    deliver: vi.fn<OffscreenWakeIo['deliver']>(async () => ({ delivered: true, verdict: 'resume' })),
    completed: vi.fn<OffscreenWakeIo['completed']>(), refused: vi.fn<OffscreenWakeIo['refused']>(), wait: vi.fn(async () => {}) }
}

describe('offscreen wake uses saved ownership without changing the visible project', () => {
  it('assembles for the saved owner and carries exact pane proof to core', async () => {
    const io = setup()
    await wakeOffscreen('term-sleep', true, io)
    expect(io.deliver).toHaveBeenCalledExactlyOnceWith({ nodeId: 'term-sleep', agentId: 'gemini', command: 'gemini --resume s1 --approval-mode plan', exitedByUs: true, recorded: target.recorded })
    expect(io.completed).toHaveBeenCalledExactlyOnceWith(target)
  })
  it('automatic attach leaves a paused node untouched but explicit wake may resume it', async () => {
    const io = setup(); io.resolve = () => ({ ...target, paused: true })
    await wakeOffscreen('term-sleep', true, io)
    expect(io.deliver).not.toHaveBeenCalled()
    await wakeOffscreen('term-sleep', false, io)
    expect(io.deliver).toHaveBeenCalledTimes(1)
  })
  it('leaves unknown or awake nodes untouched', async () => {
    for (const t of [null, { ...target, hibernated: false }]) {
      const io = setup(); io.resolve = () => t
      await wakeOffscreen('term-sleep', false, io)
      expect(io.deliver).not.toHaveBeenCalled()
    }
  })
  it('does not deliver when command assembly awaited a replaced project or status', async () => {
    const io = setup(); io.current = () => false
    await wakeOffscreen('term-sleep', false, io)
    expect(io.deliver).not.toHaveBeenCalled(); expect(io.completed).not.toHaveBeenCalled()
  })
  it('does not clear newer sleep state when core delivery finishes after it changed', async () => {
    const io = setup(); let current = true
    io.current = () => current
    io.deliver.mockImplementation(async () => { current = false; return { delivered: true, verdict: 'resume' } })
    await wakeOffscreen('term-sleep', false, io)
    expect(io.completed).not.toHaveBeenCalled()
  })
  it('shares the mounted restart exclusion and never delivers two concurrent wake requests', async () => {
    const io = setup(); const finishes: Array<() => void> = []
    io.command.mockImplementation(() => new Promise((resolve) => { finishes.push(() => resolve('gemini --resume s1')) }))
    const first = wakeOffscreen('term-sleep', false, io)
    const second = wakeOffscreen('term-sleep', false, io)
    try {
      expect(io.command).toHaveBeenCalledTimes(1)
      expect(await guardConcurrentRestart('term-sleep', async () => 'resumed')()).toBe('not-eligible')
    } finally {
      finishes.forEach((finish) => finish())
      await Promise.all([first, second])
    }
    expect(io.deliver).toHaveBeenCalledTimes(1)
  })
  it('retries only unreadable pre-write answers after relay registration and bounds failures', async () => {
    const io = setup(); io.deliver.mockResolvedValueOnce({ delivered: false, verdict: 'unreadable' })
    await wakeOffscreen('term-sleep', true, io)
    expect(io.deliver).toHaveBeenCalledTimes(2); expect(io.completed).toHaveBeenCalledTimes(1)
    const failed = setup(); failed.deliver.mockResolvedValue({ delivered: false, verdict: 'unreadable' })
    await wakeOffscreen('term-sleep', true, failed)
    expect(failed.deliver).toHaveBeenCalledTimes(3); expect(failed.completed).not.toHaveBeenCalled()
    expect(failed.refused).toHaveBeenCalledTimes(1)
  })
  it('does not retry a changed pane, missing proof, or uncertain delivery', async () => {
    for (const verdict of ['context-changed', 'no-proof', 'delivery-failed'] as SleepingWakeResult['verdict'][]) {
      const io = setup(); io.deliver.mockResolvedValue({ delivered: false, verdict })
      await wakeOffscreen('term-sleep', true, io)
      expect(io.deliver).toHaveBeenCalledTimes(1); expect(io.completed).not.toHaveBeenCalled(); expect(io.refused).toHaveBeenCalledTimes(1)
    }
  })
})
