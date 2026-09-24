import { afterEach, expect, it, vi } from 'vitest'
import { approvePhoneWithFeedback } from './phone-approval'
afterEach(() => vi.useRealTimers())
it('distinguishes stale, failed persistence and a saved but disconnected phone', async () => {
  const report = vi.fn()
  await approvePhoneWithFeedback(async () => ({ status: 'stale' }), report)
  expect(report).toHaveBeenLastCalledWith(expect.stringContaining('expired or was replaced'))
  await approvePhoneWithFeedback(async () => ({ status: 'persistence-failed' }), report)
  expect(report).toHaveBeenLastCalledWith(expect.stringContaining('could not be saved'))
  await approvePhoneWithFeedback(async () => ({ status: 'saved-disconnected' }), report)
  expect(report).toHaveBeenLastCalledWith(expect.stringContaining('approval saved'))
  await approvePhoneWithFeedback(async () => ({ status: 'approved' }), report)
  expect(report).toHaveBeenCalledTimes(3)
})
it('reports missing IPC and bounded missing responses as unconfirmed, never success', async () => {
  vi.useFakeTimers()
  const report = vi.fn()
  await approvePhoneWithFeedback(async () => { throw new Error('No handler registered') }, report)
  expect(report).toHaveBeenLastCalledWith(expect.stringContaining('unconfirmed'))
  const waiting = approvePhoneWithFeedback(() => new Promise(() => {}), report)
  await vi.advanceTimersByTimeAsync(15_000)
  await waiting
  expect(report).toHaveBeenCalledTimes(2)
  expect(report).toHaveBeenLastCalledWith(expect.stringContaining('unconfirmed'))
})
