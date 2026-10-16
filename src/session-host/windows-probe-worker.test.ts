// The probe worker, driven through a PassThrough fake child: runs on every CI host, spawns nothing.
import { EventEmitter } from 'events'
import { PassThrough } from 'stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WindowsProbeWorker, getWindowsProbeWorker, type ProbeChild } from './windows-probe-worker'
import { WINDOWS_PROBE_WORKER_SCRIPT, windowsConsoleProbeScript } from './windows-probe-script'

interface FakeChild extends ProbeChild {
  written: string[]
  killed: boolean
  reply(body: Record<string, unknown>): void
  requests(): Array<{ id: number; op: string; pid?: number }>
  exit(): void
}

function fakeChild(): FakeChild {
  const events = new EventEmitter()
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const written: string[] = []
  stdin.on('data', (c: Buffer) => written.push(...String(c).split('\n').filter(Boolean)))
  const child: FakeChild = {
    stdin,
    stdout,
    written,
    killed: false,
    kill() {
      child.killed = true
    },
    on(event, listener) {
      events.on(event, listener)
      return child
    },
    reply(body) {
      stdout.write(JSON.stringify(body) + '\n')
    },
    requests() {
      return written.map((l) => JSON.parse(l))
    },
    exit() {
      events.emit('exit', 1)
    }
  }
  return child
}

/** Let PassThrough deliver what was written. */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
  await new Promise((r) => setImmediate(r))
}

describe('WindowsProbeWorker', () => {
  let children: FakeChild[]
  let worker: WindowsProbeWorker
  const make = (over: Partial<ConstructorParameters<typeof WindowsProbeWorker>[0]> = {}): WindowsProbeWorker =>
    new WindowsProbeWorker({
      spawn: () => {
        const c = fakeChild()
        children.push(c)
        return c
      },
      ...over
    })

  beforeEach(() => {
    children = []
    worker = make()
  })
  afterEach(() => {
    worker.dispose()
    vi.useRealTimers()
  })

  it('serves sequential probes from ONE child (the type is compiled once)', async () => {
    for (let i = 0; i < 3; i++) {
      const p = worker.request({ op: 'owner', pid: 10 + i })
      await flush()
      const req = children[0].requests()[i]
      expect(req).toEqual({ id: req.id, op: 'owner', pid: 10 + i })
      children[0].reply({ id: req.id, ok: true, result: { console: [], processes: [] } })
      await expect(p).resolves.toEqual({ kind: 'ok', result: { console: [], processes: [] } })
    }
    expect(worker.spawnCount).toBe(1)
  })

  it('coalesces identical requests and serializes different ones (never two in flight)', async () => {
    const a1 = worker.request({ op: 'owner', pid: 10 })
    const a2 = worker.request({ op: 'owner', pid: 10 })
    const b = worker.request({ op: 'owner', pid: 20 })
    const t = worker.request({ op: 'table' })
    expect(a2).toBe(a1)
    await flush()
    expect(children[0].requests()).toHaveLength(1)
    children[0].reply({ id: children[0].requests()[0].id, ok: true, result: 'a' })
    await expect(a1).resolves.toEqual({ kind: 'ok', result: 'a' })
    await flush()
    expect(children[0].requests().map((r) => r.pid ?? r.op)).toEqual([10, 20])
    children[0].reply({ id: children[0].requests()[1].id, ok: true, result: 'b' })
    await expect(b).resolves.toEqual({ kind: 'ok', result: 'b' })
    await flush()
    expect(children[0].requests()[2].op).toBe('table')
    children[0].reply({ id: children[0].requests()[2].id, ok: true, result: [] })
    await expect(t).resolves.toEqual({ kind: 'ok', result: [] })
  })

  it('a probe the worker reports as failed is `failed`, and a stale id is ignored', async () => {
    const p = worker.request({ op: 'owner', pid: 10 })
    await flush()
    const id = children[0].requests()[0].id
    children[0].reply({ id: id + 99, ok: true, result: 'not ours' })
    children[0].reply({ id, ok: false })
    await expect(p).resolves.toEqual({ kind: 'failed' })
  })

  it('refuses an invalid pid before anything is written or spawned', async () => {
    await expect(worker.request({ op: 'owner', pid: -1 })).resolves.toEqual({ kind: 'failed' })
    await expect(worker.request({ op: 'owner', pid: 1.5 })).resolves.toEqual({ kind: 'failed' })
    await expect(worker.request({ op: 'owner', pid: Number.NaN })).resolves.toEqual({ kind: 'failed' })
    expect(worker.spawnCount).toBe(0)
  })

  it('a timeout kills the child, answers unavailable, and the next request respawns', async () => {
    vi.useFakeTimers()
    worker = make({ firstRequestTimeoutMs: 100, requestTimeoutMs: 50 })
    const p = worker.request({ op: 'table' })
    await vi.advanceTimersByTimeAsync(101)
    await expect(p).resolves.toEqual({ kind: 'unavailable' })
    expect(children[0].killed).toBe(true)
    const q = worker.request({ op: 'table' })
    await vi.advanceTimersByTimeAsync(0)
    expect(worker.spawnCount).toBe(2)
    children[1].reply({ id: children[1].requests()[0].id, ok: true, result: [] })
    await expect(q).resolves.toEqual({ kind: 'ok', result: [] })
  })

  it('the first request after a spawn gets the startup allowance, later ones the short deadline', async () => {
    vi.useFakeTimers()
    worker = make({ firstRequestTimeoutMs: 1000, requestTimeoutMs: 50 })
    const p = worker.request({ op: 'table' })
    await vi.advanceTimersByTimeAsync(500) // past the warm deadline, inside the startup one
    children[0].reply({ id: children[0].requests()[0].id, ok: true, result: [] })
    await expect(p).resolves.toEqual({ kind: 'ok', result: [] })
    const q = worker.request({ op: 'table' })
    await vi.advanceTimersByTimeAsync(51)
    await expect(q).resolves.toEqual({ kind: 'unavailable' })
  })

  it('a malformed reply or a dying child is unavailable', async () => {
    const p = worker.request({ op: 'table' })
    await flush()
    ;(children[0].stdout as PassThrough).write('WARNING: not json\n')
    await expect(p).resolves.toEqual({ kind: 'unavailable' })
    const q = worker.request({ op: 'table' })
    await flush()
    children[1].exit()
    await expect(q).resolves.toEqual({ kind: 'unavailable' })
  })

  it('two consecutive failures bench the worker: no respawn loop', async () => {
    vi.useFakeTimers()
    let t = 0
    worker = make({ maxFailures: 2, cooldownMs: 1000, now: () => t })
    for (let i = 0; i < 2; i++) {
      const p = worker.request({ op: 'table' })
      await vi.advanceTimersByTimeAsync(0)
      children[i].exit()
      await expect(p).resolves.toEqual({ kind: 'unavailable' })
    }
    await expect(worker.request({ op: 'table' })).resolves.toEqual({ kind: 'unavailable' })
    expect(worker.spawnCount).toBe(2)
    t = 1001
    void worker.request({ op: 'table' })
    await vi.advanceTimersByTimeAsync(0)
    expect(worker.spawnCount).toBe(3)
  })

  it('a spawn that throws is unavailable, never a crash', async () => {
    worker = new WindowsProbeWorker({
      spawn: () => {
        throw new Error('ENOENT')
      }
    })
    await expect(worker.request({ op: 'table' })).resolves.toEqual({ kind: 'unavailable' })
  })

  it('ends the child after the idle window', async () => {
    vi.useFakeTimers()
    worker = make({ idleMs: 1000 })
    const p = worker.request({ op: 'table' })
    await vi.advanceTimersByTimeAsync(0)
    children[0].reply({ id: children[0].requests()[0].id, ok: true, result: [] })
    await p
    await vi.advanceTimersByTimeAsync(999)
    expect(children[0].killed).toBe(false)
    await vi.advanceTimersByTimeAsync(2)
    expect(children[0].killed).toBe(true)
  })

  it('there is no worker off Windows', () => {
    expect(getWindowsProbeWorker('linux')).toBeNull()
    expect(getWindowsProbeWorker('darwin')).toBeNull()
  })
})

describe('the worker script', () => {
  it('compiles the probe type once, outside the request loop', () => {
    const addType = WINDOWS_PROBE_WORKER_SCRIPT.indexOf('Add-Type')
    const loop = WINDOWS_PROBE_WORKER_SCRIPT.indexOf('while ($true)')
    expect(addType).toBeGreaterThan(0)
    expect(WINDOWS_PROBE_WORKER_SCRIPT.split('Add-Type').length).toBe(2)
    expect(addType).toBeLessThan(loop)
  })

  it('holds its own stdio before any probe can Free/AttachConsole', () => {
    expect(WINDOWS_PROBE_WORKER_SCRIPT.indexOf('OpenStandardOutput')).toBeLessThan(
      WINDOWS_PROBE_WORKER_SCRIPT.indexOf('FreeConsole()')
    )
  })

  it('reads the same console as the one-shot script', () => {
    const oneShot = windowsConsoleProbeScript(4242)
    const body = oneShot.slice(oneShot.indexOf('$self = $PID'))
    expect(WINDOWS_PROBE_WORKER_SCRIPT).toContain(body.replace('AttachConsole(4242)', 'AttachConsole($rootPid)'))
  })
})
