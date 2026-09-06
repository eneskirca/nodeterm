import { describe, expect, it, vi } from 'vitest'
import type { CanvasNodeState } from '../shared/types'
import type { TriggerSpec } from '../shared/trigger'
import { createTriggerDelivery, type TriggerDeliveryDeps } from './trigger-delivery'
import type { TriggerRow, TriggerRun } from './trigger-scheduler'

const spec = (payload = 'npm run report'): TriggerSpec => ({
  schedule: { kind: 'cron', expr: '0 9 * * *' },
  payload,
  target: 'term-tgt-1'
})

const row = (payload?: string): TriggerRow => ({
  projectId: 'project-1',
  nodeId: 'trigger-a-1',
  spec: spec(payload)
})

interface World {
  nodes: Map<string, Partial<CanvasNodeState>>
  state: string | undefined
  pane: string | null
  sent: Array<{ nodeId: string; text: string }>
  sendOk: boolean
  armed: boolean
  triggerSpec: TriggerSpec | undefined
  runs: Array<{ nodeId: string; run: TriggerRun }>
  timers: Array<{ ms: number; fn: () => void }>
  delivery: ReturnType<typeof createTriggerDelivery>
  deps: TriggerDeliveryDeps
}

function world(overrides: Partial<TriggerDeliveryDeps> = {}): World {
  const w = {
    nodes: new Map<string, Partial<CanvasNodeState>>([
      ['term-tgt-1', { agentId: 'claude' }]
    ]),
    state: 'done' as string | undefined,
    pane: null as string | null,
    sent: [] as Array<{ nodeId: string; text: string }>,
    sendOk: true,
    armed: true,
    triggerSpec: spec() as TriggerSpec | undefined,
    runs: [] as Array<{ nodeId: string; run: TriggerRun }>,
    timers: [] as Array<{ ms: number; fn: () => void }>
  }
  const deps: TriggerDeliveryDeps = {
    sendText: vi.fn(async (nodeId: string, text: string) => {
      if (w.sendOk) w.sent.push({ nodeId, text })
      return w.sendOk
    }),
    paneCommand: async () => w.pane,
    agentState: () => (w.state === undefined ? undefined : { state: w.state }),
    targetNode: (nodeId) => w.nodes.get(nodeId) as CanvasNodeState | undefined,
    currentSpec: () => w.triggerSpec,
    isArmed: () => w.armed,
    schedule: (ms, fn) => {
      const t = { ms, fn }
      w.timers.push(t)
      return () => {
        const i = w.timers.indexOf(t)
        if (i >= 0) w.timers.splice(i, 1)
      }
    },
    ...overrides
  }
  const delivery = createTriggerDelivery(deps)
  delivery.setRunSink((_p, nodeId, run) => w.runs.push({ nodeId, run }))
  // Attach onto the SAME object the dep closures capture — a spread copy would let a test mutate
  // fields the delivery never reads.
  return Object.assign(w, { delivery, deps })
}

describe('trigger delivery — immediate outcomes', () => {
  it('delivers into an idle (done) agent target', async () => {
    const w = world()
    const r = await w.delivery.fire(row())
    expect(r.outcome).toBe('fired')
    expect(w.sent).toEqual([{ nodeId: 'term-tgt-1', text: 'npm run report' }])
  })

  it('a gone target is missed — nothing sent', async () => {
    const w = world()
    w.nodes.clear()
    const r = await w.delivery.fire(row())
    expect(r.outcome).toBe('missed')
    expect(r.detail).toMatch(/no longer exists/)
    expect(w.sent).toHaveLength(0)
  })

  it('a dead session is missed (sendText false)', async () => {
    const w = world()
    w.sendOk = false
    const r = await w.delivery.fire(row())
    expect(r.outcome).toBe('missed')
    expect(r.detail).toMatch(/not running/)
  })

  it('a plain terminal delivers only into a SHELL pane, and is never queued', async () => {
    const w = world()
    w.nodes.set('term-tgt-1', {}) // no agentId
    w.pane = 'zsh'
    expect((await w.delivery.fire(row())).outcome).toBe('fired')

    w.pane = 'vim'
    const busy = await w.delivery.fire(row())
    expect(busy.outcome).toBe('missed')
    expect(busy.detail).toContain("running 'vim'")

    w.pane = null
    expect((await w.delivery.fire(row())).outcome).toBe('missed')
    // One successful send total — the vim and null-pane attempts typed nothing.
    expect(w.sent).toHaveLength(1)
  })

  it('a busy agent target queues; an unknown agent state queues too', async () => {
    const w = world()
    w.state = 'working'
    const busy = await w.delivery.fire(row())
    expect(busy.outcome).toBe('queued')
    expect(busy.detail).toContain('working')

    w.state = undefined
    const unknown = await w.delivery.fire(row('second payload'))
    expect(unknown.outcome).toBe('queued')
    expect(w.sent).toHaveLength(0)
  })
})

describe('trigger delivery — the deliver-on-idle queue', () => {
  it('flushes on the idle edge and reports delivered-late', async () => {
    const w = world()
    w.state = 'working'
    expect((await w.delivery.fire(row())).outcome).toBe('queued')
    w.state = 'done'
    await w.delivery.onTargetIdle('term-tgt-1')
    expect(w.sent).toEqual([{ nodeId: 'term-tgt-1', text: 'npm run report' }])
    expect(w.runs.map((r) => r.run.outcome)).toEqual(['delivered-late'])
    expect(w.runs[0].nodeId).toBe('trigger-a-1')
  })

  it('FLUSH-TIME RE-VALIDATION: disarmed while queued is dropped, never delivered', async () => {
    const w = world()
    w.state = 'working'
    await w.delivery.fire(row())
    w.armed = false // the user disarmed the trigger while its payload waited
    w.state = 'done'
    await w.delivery.onTargetIdle('term-tgt-1')
    expect(w.sent).toHaveLength(0)
    expect(w.runs.map((r) => r.run.outcome)).toEqual(['missed'])
    expect(w.runs[0].run.detail).toMatch(/disarmed or edited/)
  })

  it('FLUSH-TIME RE-VALIDATION: a spec edited while queued is dropped', async () => {
    const w = world()
    w.state = 'working'
    await w.delivery.fire(row())
    w.triggerSpec = spec('some new payload') // git pull rewrote the trigger
    w.state = 'done'
    await w.delivery.onTargetIdle('term-tgt-1')
    expect(w.sent).toHaveLength(0)
    expect(w.runs.map((r) => r.run.outcome)).toEqual(['missed'])
  })

  it('a target still busy at flush is re-queued, then delivered on the next idle', async () => {
    const w = world()
    w.state = 'working'
    await w.delivery.fire(row())
    // The idle edge fires but the target picked up new work before the flush ran.
    await w.delivery.onTargetIdle('term-tgt-1')
    expect(w.sent).toHaveLength(0)
    w.state = 'done'
    await w.delivery.onTargetIdle('term-tgt-1')
    expect(w.sent).toHaveLength(1)
    expect(w.runs.map((r) => r.run.outcome)).toEqual(['delivered-late'])
  })

  it('a queued payload that waits out its TTL expires with a run record, nothing sent', async () => {
    const w = world()
    w.state = 'working'
    await w.delivery.fire(row())
    expect(w.timers).toHaveLength(1)
    w.timers[0].fn() // the TTL timer fires
    await Promise.resolve()
    expect(w.sent).toHaveLength(0)
    expect(w.runs.map((r) => r.run.outcome)).toEqual(['expired'])
    expect(w.runs[0].run.detail).toMatch(/never went idle/)
  })

  it('a target that disappears while queued is a missed run at flush', async () => {
    const w = world()
    w.state = 'working'
    await w.delivery.fire(row())
    w.nodes.clear()
    w.state = 'done'
    await w.delivery.onTargetIdle('term-tgt-1')
    expect(w.sent).toHaveLength(0)
    expect(w.runs.map((r) => r.run.outcome)).toEqual(['missed'])
    expect(w.runs[0].run.detail).toMatch(/went away/)
  })
})
