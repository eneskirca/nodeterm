import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CanvasNodeState } from '../shared/types'
import type { TriggerSpec } from '../shared/trigger'
import { startTriggerService, type TriggerService } from './trigger-service'

const MIN = 60_000
const T0 = new Date(2026, 8, 2, 12, 0).getTime()

const spec = (): TriggerSpec => ({
  schedule: { kind: 'interval', everyMinutes: 5 },
  payload: 'npm test',
  target: 'term-tgt-1'
})

const node = (partial: Partial<CanvasNodeState> & { id: string }): CanvasNodeState => ({
  kind: 'terminal',
  position: { x: 0, y: 0 },
  size: { width: 1, height: 1 },
  title: '',
  color: '',
  group: null,
  ...partial
})

describe('startTriggerService (end to end over fakes)', () => {
  let dir: string
  let service: TriggerService
  let clock: { t: number }
  let sent: string[]
  let nodes: CanvasNodeState[]
  let handlers: Map<string, (...args: unknown[]) => unknown>

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nt-trigger-svc-'))
    clock = { t: T0 }
    sent = []
    handlers = new Map()
    // A trigger node and its PLAIN-TERMINAL target (shell pane ⇒ deliverable without any
    // agent-status mirror state, which this test deliberately leaves untouched).
    nodes = [
      node({ id: 'trigger-a-1', kind: 'trigger', trigger: spec() }),
      node({ id: 'term-tgt-1' })
    ]
    service = startTriggerService({
      userDataDir: dir,
      listCanvases: () => [{ id: 'project-1', nodes }],
      getNode: (id) => nodes.find((n) => n.id === id),
      sendText: async (_id, text) => {
        sent.push(text)
        return true
      },
      paneCommand: async () => 'bash',
      handle: (channel, handler) => handlers.set(channel, handler),
      now: () => clock.t
    })
  })

  afterEach(async () => {
    service.stop()
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('an armed trigger fires end to end; a disarmed one never does', async () => {
    await service.scheduler.sweepOnce() // anchor
    clock.t = T0 + 5 * MIN
    await service.scheduler.sweepOnce() // due, but DISARMED (nothing ever armed it)
    expect(sent).toHaveLength(0)

    expect(await service.armStore.arm('project-1', 'trigger-a-1', spec())).toBe(true)
    clock.t = T0 + 10 * MIN
    await service.scheduler.sweepOnce()
    expect(sent).toEqual(['npm test'])
    const runs = service.scheduler.runsFor('project-1', 'trigger-a-1')
    expect(runs.map((r) => r.outcome)).toEqual(['fired'])
  })

  const invoke = <T,>(channel: string, payload: unknown): Promise<T> => {
    const h = handlers.get(channel)
    if (!h) throw new Error(`no handler registered for ${channel}`)
    return Promise.resolve(h(payload)) as Promise<T>
  }

  it('registers the card IPC surface: arm → status → run-now → disarm round trip', async () => {
    const armed = await invoke<boolean>('triggers:arm', {
      projectId: 'project-1',
      nodeId: 'trigger-a-1',
      spec: spec()
    })
    expect(armed).toBe(true)

    const status = await invoke<{ armed: boolean; nextFireAt: number | null; runs: unknown[] }>(
      'triggers:status',
      { projectId: 'project-1', nodeId: 'trigger-a-1' }
    )
    expect(status.armed).toBe(true)
    // The sweep has not anchored yet — the status computes a countdown from the spec itself.
    expect(status.nextFireAt).toBe(T0 + 5 * MIN)

    // Run-now resolves the payload CORE-side (the caller chooses when, never what) and records
    // the run in the same ring the scheduler uses.
    const result = await invoke<{ outcome: string }>('triggers:run-now', {
      projectId: 'project-1',
      nodeId: 'trigger-a-1'
    })
    expect(result.outcome).toBe('fired')
    expect(sent).toEqual(['npm test'])
    expect(service.scheduler.runsFor('project-1', 'trigger-a-1').map((r) => r.outcome)).toEqual([
      'fired'
    ])

    await invoke('triggers:disarm', { projectId: 'project-1', nodeId: 'trigger-a-1' })
    const after = await invoke<{ armed: boolean }>('triggers:status', {
      projectId: 'project-1',
      nodeId: 'trigger-a-1'
    })
    expect(after.armed).toBe(false)
  })

  it('the IPC boundary re-validates: bad keys and a smuggled spec are refused', async () => {
    expect(
      await invoke<boolean>('triggers:arm', { projectId: 'p;rm', nodeId: 'trigger-a-1', spec: spec() })
    ).toBe(false)
    expect(
      await invoke<boolean>('triggers:arm', {
        projectId: 'project-1',
        nodeId: 'trigger-a-1',
        spec: { ...spec(), payload: '' }
      })
    ).toBe(false)
    const r = await invoke<{ outcome: string }>('triggers:run-now', {
      projectId: 'project-1',
      nodeId: 'term-tgt-1' // not a trigger node
    })
    expect(r.outcome).toBe('failed')
    expect(sent).toHaveLength(0)
  })

  it('status reports armed-for-other-content after the spec changes', async () => {
    await invoke('triggers:arm', { projectId: 'project-1', nodeId: 'trigger-a-1', spec: spec() })
    nodes[0] = node({
      id: 'trigger-a-1',
      kind: 'trigger',
      trigger: { ...spec(), payload: 'something else' }
    })
    const status = await invoke<{ armed: boolean; armedForOtherContent: boolean }>(
      'triggers:status',
      { projectId: 'project-1', nodeId: 'trigger-a-1' }
    )
    expect(status.armed).toBe(false)
    expect(status.armedForOtherContent).toBe(true)
  })

  it('the arm binds to content across the whole service: an edited spec stops firing', async () => {
    await service.armStore.arm('project-1', 'trigger-a-1', spec())
    await service.scheduler.sweepOnce()
    // A git pull rewrites the payload. The next sweep re-anchors (spec changed) and every
    // due check re-asks the content-bound arm gate, which now says no.
    nodes[0] = node({
      id: 'trigger-a-1',
      kind: 'trigger',
      trigger: { ...spec(), payload: 'rm -rf /' }
    })
    clock.t = T0 + 5 * MIN
    await service.scheduler.sweepOnce() // re-anchor on the new content
    clock.t = T0 + 15 * MIN
    await service.scheduler.sweepOnce() // due — disarmed for THIS content
    expect(sent).toHaveLength(0)
  })
})
