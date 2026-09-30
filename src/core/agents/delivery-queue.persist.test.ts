import { describe, it, expect } from 'vitest'
import {
  DeliveryQueue,
  DELIVERY_QUEUE_TTL_MS,
  QUEUE_FACT,
  QUEUE_PERSIST_BODY_MAX,
  QUEUE_PERSIST_BYTES_BUDGET,
  restoredBindingVerdict,
  sanitizePersistedQueueEntry,
  type CancelTimer,
  type DeliveryQueueDeps,
  type PersistedQueueEntry,
  type QueueBinding,
  type QueuedDeliveryRequest
} from './delivery-queue'
import type { AgentMessageOutcome } from './agent-message-decide'
import { DURABLE_STATE_MAX_BYTES, DurableFactFile } from '../durable-state'
import { restoreDeliveryQueue } from './agent-messaging'
import fs from 'node:fs'
import { testTmpDir } from '../test-tmp'

/**
 * A queued message across an app restart. Each test writes the queue through ONE instance, then
 * builds a NEW queue (a new process) and restores it — what a restart is to the queue. The rules
 * pinned: the TTL keeps running while the app is down (a lapsed message ends `expired` with the
 * sender told, never delivered late); a restored message goes only into the session it was queued
 * for; a board comment and a station notice are never replayed into a pane.
 */

function instance(opts: {
  now: () => number
  binding: (id: string) => QueueBinding | undefined
  outcome?: AgentMessageOutcome
  trace?: DeliveryQueueDeps['trace']
  onDeliver?: (req: QueuedDeliveryRequest) => void
}) {
  const delivered: QueuedDeliveryRequest[] = []
  const expired: { req: QueuedDeliveryRequest; queuedForMs: number }[] = []
  const flushed: { req: QueuedDeliveryRequest; outcome: AgentMessageOutcome }[] = []
  const queued: QueuedDeliveryRequest[] = []
  const traced: string[] = []
  const timers: { ms: number; fn: () => void; cancelled: boolean }[] = []
  let saved: PersistedQueueEntry[] = []
  const deps: DeliveryQueueDeps = {
    now: opts.now,
    deliver: async (req) => {
      opts.onDeliver?.(req)
      delivered.push(req)
      return opts.outcome ?? { kind: 'delivered', traceId: 'd', traced: 'memory', receipt: 'observed', signal: 'newTurn' }
    },
    trace:
      opts.trace ??
      (async (input) => {
        traced.push(input.outcome)
        return { traceId: `t${traced.length}`, traced: 'memory' }
      }),
    onExpired: (req, info) => expired.push({ req, queuedForMs: info.queuedForMs }),
    onFlushed: (req, outcome) => flushed.push({ req, outcome }),
    onQueued: (req) => queued.push(req),
    schedule: (ms, fn): CancelTimer => {
      const t = { ms, fn, cancelled: false }
      timers.push(t)
      return () => (t.cancelled = true)
    },
    persist: (entries) => (saved = entries),
    bindingOf: opts.binding
  }
  return { queue: new DeliveryQueue(deps), delivered, expired, flushed, queued, traced, timers, saved: () => saved }
}

const req = (over: Partial<QueuedDeliveryRequest> = {}): QueuedDeliveryRequest => ({
  verb: 'send',
  sourceNodeId: 'orch',
  targetNodeId: 'st1',
  sourceTitle: 'orch',
  body: 'next task',
  ...over
})

/** Round-trip through JSON and the read-time sanitizer, like the file does. */
const onDisk = (entries: PersistedQueueEntry[]): PersistedQueueEntry[] =>
  entries.map((e) => sanitizePersistedQueueEntry(JSON.parse(JSON.stringify(e)))).filter((e): e is PersistedQueueEntry => !!e)

describe('delivery queue across a restart', () => {
  it('a queued message comes back and is delivered on the target\'s next done — same session', async () => {
    let now = 1000
    const a = instance({ now: () => now, binding: () => ({ sessionId: 's-A', agentId: 'claude' }) })
    await a.queue.enqueue(req())
    const disk = onDisk(a.saved())
    expect(disk).toHaveLength(1)
    expect(disk[0].binding).toEqual({ sessionId: 's-A', agentId: 'claude' })

    now = 1000 + 60_000 // one minute of downtime
    const b = instance({ now: () => now, binding: () => ({ sessionId: 's-A', agentId: 'claude' }) })
    await b.queue.restore(disk)
    expect(b.queued).toHaveLength(1) // replayed, so "work pending" is rebuilt
    expect(b.queue.depth('st1')).toBe(1)
    // The TTL is what is LEFT, not a fresh five minutes.
    expect(b.timers.filter((t) => !t.cancelled).map((t) => t.ms)).toEqual([DELIVERY_QUEUE_TTL_MS - 60_000])
    await b.queue.onTargetIdle('st1')
    expect(b.delivered.map((r) => r.body)).toEqual(['next task'])
    expect(b.saved()).toEqual([])
  })

  it('a message whose TTL lapsed while the app was down EXPIRES at restore, sender told, never delivered', async () => {
    let now = 1000
    const a = instance({ now: () => now, binding: () => ({ sessionId: 's-A' }) })
    await a.queue.enqueue(req())
    now = 1000 + DELIVERY_QUEUE_TTL_MS + 1
    const b = instance({ now: () => now, binding: () => ({ sessionId: 's-A' }) })
    await b.queue.restore(onDisk(a.saved()))
    expect(b.expired).toHaveLength(1)
    expect(b.expired[0].queuedForMs).toBe(DELIVERY_QUEUE_TTL_MS + 1)
    expect(b.traced).toEqual(['expired'])
    expect(b.queue.depth('st1')).toBe(0)
    await b.queue.onTargetIdle('st1')
    expect(b.delivered).toEqual([])
  })

  it('a DIFFERENT session in the pane ends the message as targetGone — nothing typed, sender told', async () => {
    const a = instance({ now: () => 1000, binding: () => ({ sessionId: 's-A', agentId: 'claude' }) })
    await a.queue.enqueue(req())
    const b = instance({ now: () => 2000, binding: () => ({ sessionId: 's-B', agentId: 'claude' }) })
    await b.queue.restore(onDisk(a.saved()))
    await b.queue.onTargetIdle('st1')
    expect(b.delivered).toEqual([])
    expect(b.flushed.map((f) => f.outcome.kind)).toEqual(['targetGone'])
  })

  it('another AGENT in the pane is also gone; an unknown session waits; no recorded session is gone', () => {
    expect(restoredBindingVerdict({ sessionId: 's', agentId: 'claude' }, { sessionId: 's', agentId: 'codex' })).toBe('gone')
    expect(restoredBindingVerdict({ sessionId: 's' }, undefined)).toBe('wait')
    expect(restoredBindingVerdict({ sessionId: 's' }, { agentId: 'claude' })).toBe('wait')
    expect(restoredBindingVerdict(undefined, { sessionId: 's' })).toBe('gone')
    expect(restoredBindingVerdict({ sessionId: 's' }, { sessionId: 's' })).toBe('deliver')
  })

  it('a restored message waits (TTL still running) while the target has not named a session yet', async () => {
    const a = instance({ now: () => 1000, binding: () => ({ sessionId: 's-A' }) })
    await a.queue.enqueue(req())
    let cur: QueueBinding | undefined
    const b = instance({ now: () => 2000, binding: () => cur })
    await b.queue.restore(onDisk(a.saved()))
    await b.queue.onTargetIdle('st1')
    expect(b.delivered).toEqual([])
    expect(b.queue.depth('st1')).toBe(1)
    cur = { sessionId: 's-A' }
    await b.queue.onTargetIdle('st1')
    expect(b.delivered).toHaveLength(1)
  })

  it('in-run entries are unchanged: a live entry is delivered whatever the binding says now', async () => {
    let cur: QueueBinding = { sessionId: 's-A' }
    const a = instance({ now: () => 1000, binding: () => cur })
    await a.queue.enqueue(req())
    cur = { sessionId: 's-B' }
    await a.queue.onTargetIdle('st1')
    expect(a.delivered).toHaveLength(1)
  })

  it('a board comment and a station notice are expired at restore, never replayed into a pane', async () => {
    const a = instance({ now: () => 1000, binding: () => ({ sessionId: 's-A' }) })
    await a.queue.enqueue(
      req({ verb: 'board-comment', sourceNodeId: 'board-comment:c1', projectId: 'p1', commentId: 'c1', author: 'me', text: '@x hi' })
    )
    await a.queue.enqueue(req({ verb: 'station-notice', targetNodeId: 'st2' }))
    const disk = onDisk(a.saved())
    expect(disk).toHaveLength(2)
    expect(disk[0].req.projectId).toBe('p1') // its trace still finds its board
    const b = instance({ now: () => 2000, binding: () => ({ sessionId: 's-A' }) })
    await b.queue.restore(disk)
    expect(b.expired.map((e) => e.req.verb)).toEqual(['board-comment', 'station-notice'])
    await b.queue.onTargetIdle('st1')
    await b.queue.onTargetIdle('st2')
    expect(b.delivered).toEqual([])
  })

  it('a body too large to store is written without it and expired at restore', async () => {
    const a = instance({ now: () => 1000, binding: () => ({ sessionId: 's-A' }) })
    await a.queue.enqueue(req({ body: 'x'.repeat(QUEUE_PERSIST_BODY_MAX + 1) }))
    const disk = onDisk(a.saved())
    expect(disk[0]).toMatchObject({ bodyOmitted: true, req: { body: '' } })
    const b = instance({ now: () => 2000, binding: () => ({ sessionId: 's-A' }) })
    await b.queue.restore(disk)
    expect(b.expired).toHaveLength(1)
    expect(b.delivered).toEqual([])
  })

  it('sanitizes hand-edited entries', () => {
    const good = { req: req(), enqueuedAt: 1, ttlMs: 1000, queuedTraceId: 't' }
    expect(sanitizePersistedQueueEntry(good)).toBeTruthy()
    expect(sanitizePersistedQueueEntry({ ...good, req: req({ targetNodeId: '../x' }) })).toBeNull()
    expect(sanitizePersistedQueueEntry({ ...good, req: req({ sourceNodeId: 'not a node' }) })).toBeNull()
    expect(sanitizePersistedQueueEntry({ ...good, ttlMs: 1e12 })).toBeNull()
    expect(sanitizePersistedQueueEntry({ ...good, ttlMs: -1 })).toBeNull()
    expect(sanitizePersistedQueueEntry({ ...good, req: { ...req(), extra: { nested: 1 } } })).toBeNull()
    expect(sanitizePersistedQueueEntry({ ...good, binding: { sessionId: 5 } })).toBeNull()
    expect(sanitizePersistedQueueEntry('x')).toBeNull()
  })

  it('end to end through the file: write → new instance → restore → deliver', async () => {
    const dir = testTmpDir('nt-queue-')
    const fileA = new DurableFactFile(QUEUE_FACT, { userDataDir: dir, debounceMs: 1 })
    const a = instance({ now: () => 1000, binding: () => ({ sessionId: 's-A' }) })
    await a.queue.enqueue(req())
    fileA.save(a.saved())
    await fileA.flush()
    const b = instance({ now: () => 2000, binding: () => ({ sessionId: 's-A' }) })
    await b.queue.restore(new DurableFactFile(QUEUE_FACT, { userDataDir: dir }).load())
    await b.queue.onTargetIdle('st1')
    expect(b.delivered.map((r) => r.body)).toEqual(['next task'])
  })

  it('the written file stays under the load limit however much is queued; nothing is silently dropped (review repro)', async () => {
    const dir = testTmpDir('nt-queue-budget-')
    const file = new DurableFactFile(QUEUE_FACT, { userDataDir: dir, debounceMs: 1 })
    const a = instance({ now: () => 1000, binding: () => ({ sessionId: 's' }) })
    for (let t = 0; t < 5; t++)
      for (let i = 0; i < 16; i++)
        await a.queue.enqueue(req({ targetNodeId: `st${t}`, body: `${t}-${i}-` + 'x'.repeat(250_000) }))
    file.save(a.saved())
    await file.flush()
    expect(fs.statSync(file.path).size).toBeLessThan(DURABLE_STATE_MAX_BYTES)
    const loaded = new DurableFactFile(QUEUE_FACT, { userDataDir: dir }).load()
    expect(loaded).toHaveLength(80)
    const full = loaded.filter((e) => !e.bodyOmitted)
    expect(full.length).toBeGreaterThan(0)
    expect(full.reduce((n, e) => n + JSON.stringify(e).length, 0)).toBeLessThanOrEqual(QUEUE_PERSIST_BYTES_BUDGET)
    // Every reduced entry is ENDED loudly at restore, the full ones wait for their target.
    const b = instance({ now: () => 2000, binding: () => ({ sessionId: 's' }) })
    await b.queue.restore(loaded)
    expect(b.expired).toHaveLength(80 - full.length)
    expect(b.expired.length + [0, 1, 2, 3, 4].reduce((n, t) => n + b.queue.depth(`st${t}`), 0)).toBe(80)
  })

  it('lapsed entries never enter the live lists: a flush during an expiry\'s await delivers nothing of them', async () => {
    const a = instance({ now: () => 1000, binding: () => ({ sessionId: 's' }) })
    await a.queue.enqueue(req({ verb: 'board-comment', sourceNodeId: 'board-comment:c1', projectId: 'p1' }))
    await a.queue.enqueue(req({ body: 'x'.repeat(QUEUE_PERSIST_BODY_MAX + 1) }))
    let release = (): void => {}
    let b!: ReturnType<typeof instance>
    const stalled = new Promise<void>((r) => (release = r))
    b = instance({
      now: () => 2000,
      binding: () => ({ sessionId: 's' }),
      trace: async () => {
        await b.queue.onTargetIdle('st1') // a `done` arriving while the expiry is being reported
        await stalled
        return { traceId: 't', traced: 'memory' }
      }
    })
    const restoring = b.queue.restore(onDisk(a.saved()))
    await new Promise((r) => setTimeout(r, 0))
    release()
    await restoring
    expect(b.delivered).toEqual([])
    expect(b.expired).toHaveLength(2)
  })

  it('lapsed entries take no capacity: 16 deliverable ones all come back beside an expired one', async () => {
    const entries: PersistedQueueEntry[] = [
      { req: req({ verb: 'board-comment', sourceNodeId: 'board-comment:c1' }), enqueuedAt: 1000, ttlMs: DELIVERY_QUEUE_TTL_MS, queuedTraceId: 't' },
      ...Array.from({ length: 16 }, (_, i) => ({
        req: req({ body: `m${i}` }),
        enqueuedAt: 1000,
        ttlMs: DELIVERY_QUEUE_TTL_MS,
        queuedTraceId: `t${i}`,
        binding: { sessionId: 's' }
      }))
    ]
    const b = instance({ now: () => 2000, binding: () => ({ sessionId: 's' }) })
    await b.queue.restore(onDisk(entries))
    expect(b.queue.depth('st1')).toBe(16)
    expect(b.expired.map((e) => e.req.verb)).toEqual(['board-comment'])
  })

  it('an entry is written off disk BEFORE its delivery attempt (at most once across a crash)', async () => {
    let onDiskDuringDelivery: PersistedQueueEntry[] | null = null
    let a!: ReturnType<typeof instance>
    a = instance({ now: () => 1000, binding: () => ({ sessionId: 's' }), onDeliver: () => (onDiskDuringDelivery = a.saved()) })
    await a.queue.enqueue(req())
    expect(a.saved()).toHaveLength(1)
    await a.queue.onTargetIdle('st1')
    expect(onDiskDuringDelivery).toEqual([])
  })

  it('restoreDeliveryQueue reports no expiry until `ready` (the desktop workspace index) has resolved', async () => {
    const a = instance({ now: () => 1000, binding: () => ({ sessionId: 's' }) })
    await a.queue.enqueue(req())
    const b = instance({ now: () => 1000 + DELIVERY_QUEUE_TTL_MS + 1, binding: () => ({ sessionId: 's' }) })
    let loaded = (): void => {}
    const ready = new Promise<void>((r) => (loaded = r))
    const disk = onDisk(a.saved())
    const done = restoreDeliveryQueue(b.queue, { load: () => disk }, { ready })
    await new Promise((r) => setTimeout(r, 5))
    expect(b.expired).toEqual([])
    loaded()
    await done
    expect(b.expired).toHaveLength(1)
  })
})
