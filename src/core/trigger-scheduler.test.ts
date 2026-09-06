import { describe, expect, it, vi } from 'vitest'
import type { CanvasNodeState } from '../shared/types'
import type { TriggerSpec } from '../shared/trigger'
import {
  computeNextFire,
  createTriggerScheduler,
  triggerRowsFromCanvases,
  type TriggerFireResult,
  type TriggerRow
} from './trigger-scheduler'

const MIN = 60_000
const T0 = new Date(2026, 8, 2, 12, 0).getTime()

const intervalSpec = (everyMinutes = 5): TriggerSpec => ({
  schedule: { kind: 'interval', everyMinutes },
  payload: 'npm test',
  target: 'term-tgt-1'
})

interface Harness {
  clock: { t: number }
  rows: TriggerRow[]
  armed: Set<string>
  fires: TriggerRow[]
  fire: ReturnType<typeof vi.fn>
  scheduler: ReturnType<typeof createTriggerScheduler>
}

function harness(fireImpl?: (row: TriggerRow) => Promise<TriggerFireResult>): Harness {
  const clock = { t: T0 }
  const rows: TriggerRow[] = []
  const armed = new Set<string>()
  const fires: TriggerRow[] = []
  const fire = vi.fn(
    fireImpl ??
      (async (row: TriggerRow) => {
        fires.push(row)
        return { outcome: 'fired' as const }
      })
  )
  const scheduler = createTriggerScheduler({
    listTriggers: () => rows,
    isArmed: (p, n) => armed.has(`${p}/${n}`),
    fire,
    now: () => clock.t
  })
  return { clock, rows, armed, fires, fire, scheduler }
}

describe('triggerRowsFromCanvases', () => {
  it('collects valid trigger nodes and drops everything else', () => {
    const nodes: CanvasNodeState[] = [
      {
        id: 'trigger-a-1', kind: 'trigger', position: { x: 0, y: 0 },
        size: { width: 1, height: 1 }, title: '', color: '', group: null,
        trigger: intervalSpec()
      },
      {
        id: 'trigger-bad-1', kind: 'trigger', position: { x: 0, y: 0 },
        size: { width: 1, height: 1 }, title: '', color: '', group: null,
        trigger: { schedule: { kind: 'weekly' } } as never
      },
      {
        id: 'term-c-1', kind: 'terminal', position: { x: 0, y: 0 },
        size: { width: 1, height: 1 }, title: '', color: '', group: null
      }
    ]
    const out = triggerRowsFromCanvases([{ id: 'project-1', nodes }])
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ projectId: 'project-1', nodeId: 'trigger-a-1' })
  })
})

describe('computeNextFire', () => {
  it('interval anchors to from, once honors only a future time', () => {
    expect(computeNextFire(intervalSpec(5), T0)).toBe(T0 + 5 * MIN)
    const future = new Date(T0 + 60 * MIN).toISOString()
    expect(
      computeNextFire({ ...intervalSpec(), schedule: { kind: 'once', at: future } }, T0)
    ).toBe(T0 + 60 * MIN)
    const past = new Date(T0 - MIN).toISOString()
    expect(
      computeNextFire({ ...intervalSpec(), schedule: { kind: 'once', at: past } }, T0)
    ).toBeNull()
  })

  it('an unparseable cron schedules nothing', () => {
    expect(
      computeNextFire({ ...intervalSpec(), schedule: { kind: 'cron', expr: 'not cron' } }, T0)
    ).toBeNull()
  })
})

describe('createTriggerScheduler', () => {
  it('fires an armed trigger when due — and asks the arm gate at FIRE time', async () => {
    const h = harness()
    h.rows.push({ projectId: 'project-1', nodeId: 'trigger-a-1', spec: intervalSpec(5) })
    await h.scheduler.sweepOnce() // anchors: next = T0 + 5min
    expect(h.scheduler.nextFireAt('project-1', 'trigger-a-1')).toBe(T0 + 5 * MIN)

    h.clock.t = T0 + 5 * MIN
    await h.scheduler.sweepOnce() // due, but DISARMED → silent skip, schedule advances
    expect(h.fire).not.toHaveBeenCalled()
    expect(h.scheduler.runsFor('project-1', 'trigger-a-1')).toHaveLength(0)
    expect(h.scheduler.nextFireAt('project-1', 'trigger-a-1')).toBe(T0 + 10 * MIN)

    h.armed.add('project-1/trigger-a-1')
    h.clock.t = T0 + 10 * MIN
    await h.scheduler.sweepOnce()
    expect(h.fire).toHaveBeenCalledTimes(1)
    const runs = h.scheduler.runsFor('project-1', 'trigger-a-1')
    expect(runs).toHaveLength(1)
    expect(runs[0].outcome).toBe('fired')
  })

  it('no catch-up: sleeping through three intervals fires ONCE, re-anchored from now', async () => {
    const h = harness()
    h.armed.add('project-1/trigger-a-1')
    h.rows.push({ projectId: 'project-1', nodeId: 'trigger-a-1', spec: intervalSpec(5) })
    await h.scheduler.sweepOnce()
    h.clock.t = T0 + 17 * MIN // three slots (5, 10, 15) passed
    await h.scheduler.sweepOnce()
    expect(h.fire).toHaveBeenCalledTimes(1)
    expect(h.scheduler.nextFireAt('project-1', 'trigger-a-1')).toBe(T0 + 22 * MIN)
  })

  it('a spec edit re-anchors the schedule and is never due on the same sweep', async () => {
    const h = harness()
    h.armed.add('project-1/trigger-a-1')
    h.rows.push({ projectId: 'project-1', nodeId: 'trigger-a-1', spec: intervalSpec(5) })
    await h.scheduler.sweepOnce()
    h.clock.t = T0 + 5 * MIN
    h.rows[0] = { ...h.rows[0], spec: intervalSpec(30) } // edited right as the old slot came due
    await h.scheduler.sweepOnce()
    expect(h.fire).not.toHaveBeenCalled()
    expect(h.scheduler.nextFireAt('project-1', 'trigger-a-1')).toBe(T0 + 35 * MIN)
  })

  it('a spent `once` records a single honest miss — armed only — and never fires late', async () => {
    const h = harness()
    const past = new Date(T0 - 10 * MIN).toISOString()
    const spec: TriggerSpec = { ...intervalSpec(), schedule: { kind: 'once', at: past } }
    h.rows.push(
      { projectId: 'project-1', nodeId: 'trigger-armed-1', spec },
      { projectId: 'project-1', nodeId: 'trigger-clone-1', spec }
    )
    h.armed.add('project-1/trigger-armed-1')
    await h.scheduler.sweepOnce()
    await h.scheduler.sweepOnce()
    expect(h.fire).not.toHaveBeenCalled()
    const armedRuns = h.scheduler.runsFor('project-1', 'trigger-armed-1')
    expect(armedRuns).toHaveLength(1)
    expect(armedRuns[0].outcome).toBe('missed')
    // The disarmed clone (fresh from git) spams nothing.
    expect(h.scheduler.runsFor('project-1', 'trigger-clone-1')).toHaveLength(0)
  })

  it('a future `once` fires exactly once and is then spent', async () => {
    const h = harness()
    h.armed.add('project-1/trigger-a-1')
    const at = new Date(T0 + 10 * MIN).toISOString()
    h.rows.push({
      projectId: 'project-1', nodeId: 'trigger-a-1',
      spec: { ...intervalSpec(), schedule: { kind: 'once', at } }
    })
    await h.scheduler.sweepOnce()
    h.clock.t = T0 + 11 * MIN
    await h.scheduler.sweepOnce()
    expect(h.fire).toHaveBeenCalledTimes(1)
    h.clock.t = T0 + 60 * MIN
    await h.scheduler.sweepOnce()
    expect(h.fire).toHaveBeenCalledTimes(1)
    expect(h.scheduler.nextFireAt('project-1', 'trigger-a-1')).toBeNull()
  })

  it('a failed or throwing delivery records `failed` and the schedule keeps going', async () => {
    let call = 0
    const h = harness(async () => {
      call++
      if (call === 1) return { outcome: 'missed' as const, detail: 'target not running' }
      throw new Error('boom')
    })
    h.armed.add('project-1/trigger-a-1')
    h.rows.push({ projectId: 'project-1', nodeId: 'trigger-a-1', spec: intervalSpec(5) })
    await h.scheduler.sweepOnce()
    h.clock.t = T0 + 5 * MIN
    await h.scheduler.sweepOnce()
    h.clock.t = T0 + 10 * MIN
    await h.scheduler.sweepOnce()
    const runs = h.scheduler.runsFor('project-1', 'trigger-a-1')
    expect(runs.map((r) => r.outcome)).toEqual(['missed', 'failed'])
    expect(runs[0].detail).toBe('target not running')
    expect(runs[1].detail).toBe('boom')
    expect(h.scheduler.nextFireAt('project-1', 'trigger-a-1')).toBe(T0 + 15 * MIN)
  })

  it('an in-flight delivery is not double-fired by an overlapping sweep', async () => {
    let release: (() => void) | undefined
    const h = harness(
      () =>
        new Promise<TriggerFireResult>((resolve) => {
          release = () => resolve({ outcome: 'fired' })
        })
    )
    h.armed.add('project-1/trigger-a-1')
    h.rows.push({ projectId: 'project-1', nodeId: 'trigger-a-1', spec: intervalSpec(5) })
    await h.scheduler.sweepOnce()
    h.clock.t = T0 + 5 * MIN
    const slow = h.scheduler.sweepOnce() // enters fire, blocks
    await Promise.resolve()
    // The next slot comes due while the previous delivery is still in flight — the in-flight
    // guard must skip it rather than stack a second fire on the same trigger.
    h.clock.t = T0 + 10 * MIN
    await h.scheduler.sweepOnce()
    expect(h.fire).toHaveBeenCalledTimes(1)
    release!()
    await slow
    expect(h.scheduler.runsFor('project-1', 'trigger-a-1')).toHaveLength(1)
  })

  it('a deleted trigger drops its schedule state and run history', async () => {
    const h = harness()
    h.armed.add('project-1/trigger-a-1')
    h.rows.push({ projectId: 'project-1', nodeId: 'trigger-a-1', spec: intervalSpec(5) })
    await h.scheduler.sweepOnce()
    h.clock.t = T0 + 5 * MIN
    await h.scheduler.sweepOnce()
    expect(h.scheduler.runsFor('project-1', 'trigger-a-1')).toHaveLength(1)
    h.rows.length = 0
    await h.scheduler.sweepOnce()
    expect(h.scheduler.nextFireAt('project-1', 'trigger-a-1')).toBeNull()
    expect(h.scheduler.runsFor('project-1', 'trigger-a-1')).toHaveLength(0)
  })

  it('a listing failure changes no schedule state', async () => {
    const clock = { t: T0 }
    let throwNow = false
    const rows: TriggerRow[] = [
      { projectId: 'project-1', nodeId: 'trigger-a-1', spec: intervalSpec(5) }
    ]
    const scheduler = createTriggerScheduler({
      listTriggers: () => {
        if (throwNow) throw new Error('index unavailable')
        return rows
      },
      isArmed: () => true,
      fire: async () => ({ outcome: 'fired' as const }),
      now: () => clock.t
    })
    await scheduler.sweepOnce()
    throwNow = true
    clock.t = T0 + 5 * MIN
    await scheduler.sweepOnce() // failure: neither fires nor forgets
    expect(scheduler.nextFireAt('project-1', 'trigger-a-1')).toBe(T0 + 5 * MIN)
  })
})
