import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createRemoteContextTail } from './remote-context-tail'
import { codexContextParse, codexContextModel } from '../core/codex-session'
import type { RemoteFile } from './remote-ssh/remote-file'

const ref = { conn: { host: 'fixture', user: 'u' }, controlPath: '/socket', path: '/rollout' }
const model = JSON.stringify({ type: 'turn_context', payload: { model: 'codex-fixture-model' } }) + '\n'
const usage = (input: number, window?: number) => JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: {
  last_token_usage: { input_tokens: input, cached_input_tokens: input - 1 },
  total_token_usage: { input_tokens: input * 10 }, model_context_window: window
} } }) + '\n'
const snapshot = (text: string, initial = false) => ({ data: Buffer.from(text), newOffset: text.length, initial })
beforeEach(() => vi.useFakeTimers())
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers() })
function setup() {
  const send = vi.fn(), onToolResult = vi.fn(), onTaskNotification = vi.fn()
  const readContextWindow = vi.fn().mockResolvedValue(snapshot(''))
  const tail = createRemoteContextTail(send, { readContextWindow } as unknown as RemoteFile,
    { parse: codexContextParse, parseModel: codexContextModel, onToolResult, onTaskNotification })
  return { tail, send, readContextWindow, onToolResult, onTaskNotification }
}
it('uses Codex last input and reported window, preserves separately read model and torn token records', async () => {
  const h = setup()
  const line = usage(25000, 100000)
  h.readContextWindow.mockResolvedValueOnce(snapshot(model, true))
    .mockResolvedValueOnce(snapshot(line.slice(0, 70))).mockResolvedValueOnce(snapshot(line.slice(70)))
  h.tail.track('s', ref, 999999) // Claude environment metadata must never override Codex's denominator.
  await vi.advanceTimersByTimeAsync(1000)
  expect(h.send).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1000)
  expect(h.send).toHaveBeenCalledTimes(1)
  expect(h.send).toHaveBeenLastCalledWith(expect.objectContaining({ sessionId: 's', model: 'codex-fixture-model',
    usedTokens: 25000, windowTokens: 100000, usedPercent: 25, windowSource: 'transcript' }))
  h.tail.replay('s')
  expect(h.send).toHaveBeenCalledTimes(2)
  await vi.advanceTimersByTimeAsync(1000)
  expect(h.send).toHaveBeenCalledTimes(2)
})
it('does not fabricate a Claude window when Codex has not stated its capacity', async () => {
  const h = setup()
  h.readContextWindow.mockResolvedValueOnce(snapshot(model + usage(123), true))
  h.tail.track('s', ref, 999999)
  await vi.advanceTimersByTimeAsync(0)
  expect(h.send).not.toHaveBeenCalled()
  h.readContextWindow.mockResolvedValueOnce(snapshot(usage(200, 2000)))
  await vi.advanceTimersByTimeAsync(1000)
  expect(h.send).toHaveBeenCalledWith(expect.objectContaining({ usedPercent: 10, windowTokens: 2000 }))
})
it('cannot publish an old read after a remote reference is replaced', async () => {
  const h = setup()
  let finish!: (value: ReturnType<typeof snapshot>) => void
  h.readContextWindow.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    .mockResolvedValueOnce(snapshot(usage(20, 100), true))
  h.tail.track('s', ref)
  h.tail.track('s', { ...ref, path: '/new-rollout' })
  await vi.advanceTimersByTimeAsync(0)
  finish(snapshot(usage(99, 100), true)); await vi.advanceTimersByTimeAsync(0)
  expect(h.send).toHaveBeenCalledTimes(1)
  expect(h.send.mock.calls[0][0].usedTokens).toBe(20)
})
