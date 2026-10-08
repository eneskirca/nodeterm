import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createDeferredBlur } from './deferred-blur'

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

it('waits for a timer task so native mouseleave precedes a blur repaint', async () => {
  const events: string[] = []
  const terminal = { blur: () => events.push('blur repaint') }
  const deferred = createDeferredBlur(() => terminal)

  events.push('mouseout')
  deferred.schedule()
  expect(events).toEqual(['mouseout'])
  // A microtask would still run before the browser finishes the native leave sequence.
  await Promise.resolve()
  expect(events).toEqual(['mouseout'])
  events.push('native mouseleave')
  vi.advanceTimersByTime(0)
  expect(events).toEqual(['mouseout', 'native mouseleave', 'blur repaint'])
})

it('re-entry or explicit focus cancels the pending blur and its timer', () => {
  const terminal = { blur: vi.fn() }
  const deferred = createDeferredBlur(() => terminal)
  deferred.schedule()
  deferred.cancel()
  expect(vi.getTimerCount()).toBe(0)
  vi.runAllTimers()
  expect(terminal.blur).not.toHaveBeenCalled()
})

it('cleanup rejects a queued old blur even when the next run adopts the same terminal', () => {
  const terminal = { blur: vi.fn() }
  const timers = vi.spyOn(globalThis, 'setTimeout')
  const deferred = createDeferredBlur(() => terminal)
  deferred.schedule()
  const queuedOldCallback = timers.mock.calls[0][0] as () => void

  deferred.cancel()
  // Model a callback already queued before cleanup, outside clearTimeout's reach. The object is
  // unchanged after park/adopt or StrictMode replay; cancellation still retires the old run.
  queuedOldCallback()
  expect(terminal.blur).not.toHaveBeenCalled()
  deferred.schedule()
  vi.runAllTimers()
  expect(terminal.blur).toHaveBeenCalledTimes(1)
})

it('never blurs a replaced terminal or its successor from an old leave', () => {
  const oldTerminal = { blur: vi.fn() }
  const replacement = { blur: vi.fn() }
  let current = oldTerminal
  const deferred = createDeferredBlur(() => current)
  deferred.schedule()
  current = replacement
  vi.runAllTimers()
  expect(oldTerminal.blur).not.toHaveBeenCalled()
  expect(replacement.blur).not.toHaveBeenCalled()

  deferred.schedule()
  vi.runAllTimers()
  expect(replacement.blur).toHaveBeenCalledTimes(1)
})

it('does nothing if the terminal ref has been cleared before the next task', () => {
  const terminal = { blur: vi.fn() }
  let current: typeof terminal | null = terminal
  const deferred = createDeferredBlur(() => current)
  deferred.schedule()
  current = null
  vi.runAllTimers()
  expect(terminal.blur).not.toHaveBeenCalled()
})

it('does not schedule a leave before a terminal exists', () => {
  const deferred = createDeferredBlur(() => null)
  deferred.schedule()
  expect(vi.getTimerCount()).toBe(0)
})

it('coalesces repeated leaves into one pending blur', () => {
  const terminal = { blur: vi.fn() }
  const deferred = createDeferredBlur(() => terminal)
  deferred.schedule()
  deferred.schedule()
  deferred.schedule()
  expect(vi.getTimerCount()).toBe(1)
  vi.runAllTimers()
  expect(terminal.blur).toHaveBeenCalledTimes(1)
})

it('an obsolete queued callback cannot discard the newer cancelable timer', () => {
  const terminal = { blur: vi.fn() }
  const timers = vi.spyOn(globalThis, 'setTimeout')
  const deferred = createDeferredBlur(() => terminal)
  deferred.schedule()
  const queuedOldCallback = timers.mock.calls[0][0] as () => void
  deferred.schedule()

  queuedOldCallback()
  expect(terminal.blur).not.toHaveBeenCalled()
  deferred.cancel()
  expect(vi.getTimerCount()).toBe(0)
  vi.runAllTimers()
  expect(terminal.blur).not.toHaveBeenCalled()
})

it('remains reusable after repeated cleanup and focus cancellation', () => {
  const terminal = { blur: vi.fn() }
  const deferred = createDeferredBlur(() => terminal)
  deferred.cancel()
  deferred.cancel()
  deferred.schedule()
  deferred.cancel()
  deferred.schedule()
  vi.runAllTimers()
  expect(terminal.blur).toHaveBeenCalledTimes(1)
  expect(vi.getTimerCount()).toBe(0)
})
