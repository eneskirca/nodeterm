import { afterEach, expect, it, vi } from 'vitest'
import { subscribeAgentReplay } from './agent-replay-subscription'
import type { NormalizedAgentEvent } from './agents/normalize'
const start: NormalizedAgentEvent = { kind: 'subagent-start', agentId: 'claude', nodeId: 'p', toolUseId: 'child', subagentStartedAt: 10 }
function harness() {
  let push!: (e: NormalizedAgentEvent) => void
  let resolve!: (es: NormalizedAgentEvent[]) => void
  let reject!: (e: Error) => void
  const unsub = vi.fn()
  const seen: NormalizedAgentEvent[] = []
  const snapshot = new Promise<NormalizedAgentEvent[]>((a, b) => { resolve = a; reject = b })
  const dispose = subscribeAgentReplay((cb) => { push = cb; return unsub }, () => snapshot, (e) => seen.push(e))
  return { push, resolve, reject, seen, dispose, unsub }
}
afterEach(() => vi.useRealTimers())
it('subscribes before snapshot and drains an end after replay; does not replay alerts', async () => {
  const h = harness()
  const end = { ...start, kind: 'subagent-end' as const }
  const alert = { ...start, kind: 'state' as const, state: 'blocked' as const }
  h.push(end); h.push(alert)
  expect(h.seen).toEqual([alert])
  h.resolve([start, alert])
  await new Promise((r) => setTimeout(r, 0))
  expect(h.seen).toEqual([alert, start, end])
  h.dispose()
})
it('failure still delivers queued and later live events', async () => {
  const h = harness(); h.push(start); h.reject(new Error('old host'))
  await new Promise((r) => setTimeout(r, 0))
  h.push({ ...start, kind: 'subagent-end' })
  expect(h.seen.map((e) => e.kind)).toEqual(['subagent-start', 'subagent-end'])
  h.dispose()
})
it('disposal cancels replay and unsubscribes', async () => {
  const h = harness(); h.push(start); h.dispose(); h.resolve([start])
  await new Promise((r) => setTimeout(r, 0))
  expect(h.seen).toEqual([]); expect(h.unsub).toHaveBeenCalledOnce()
})
it('timeout abandons a late snapshot instead of resurrecting ended work', async () => {
  vi.useFakeTimers()
  const h = harness(); h.push({ ...start, kind: 'subagent-end' })
  await vi.advanceTimersByTimeAsync(3000)
  h.resolve([start]); await vi.runAllTimersAsync()
  expect(h.seen.map((e) => e.kind)).toEqual(['subagent-end'])
  h.dispose()
})
