import { describe, it, expect } from 'vitest'
import {
  launchesToFire,
  queueControlLaunch,
  controlLaunchState,
  launchTooltip,
  unmetDeps,
  LAUNCH_STALL_MS,
  type ArmedNode,
  type StatusById
} from './pendingLaunch'

const armed = (id: string, after: string[], command = `echo ${id}`): ArmedNode => ({
  id,
  data: { pendingLaunch: { after, command } }
})
const plain = (id: string): ArmedNode => ({ id, data: {} })

describe('launchesToFire', () => {
  it('leaves server-owned launches to the headless scheduler', () => {
    const node: ArmedNode = {
      id: 'c',
      data: { pendingLaunch: { after: [], command: 'echo c', executor: 'server' } }
    }
    expect(launchesToFire([node], {}, new Set(['c']))).toEqual([])
  })

  const live = new Set(['a', 'b', 'c'])

  it('fires when every dep has reported done', () => {
    const status: StatusById = { a: { state: 'done' }, b: { state: 'done' } }
    expect(launchesToFire([armed('c', ['a', 'b'])], status, live)).toEqual([
      { id: 'c', command: 'echo c' }
    ])
  })

  it('does NOT fire while a dep is still working', () => {
    const status: StatusById = { a: { state: 'done' }, b: { state: 'working' } }
    expect(launchesToFire([armed('c', ['a', 'b'])], status, live)).toEqual([])
  })

  it('does NOT fire on an unknown state — "no news" is not "finished"', () => {
    // The whole point: right after a fan-out the upstream stations have emitted nothing yet.
    expect(launchesToFire([armed('c', ['a'])], {}, live)).toEqual([])
  })

  it('treats waiting/blocked as not satisfied — the station still needs its user', () => {
    expect(launchesToFire([armed('c', ['a'])], { a: { state: 'waiting' } }, live)).toEqual([])
    expect(launchesToFire([armed('c', ['a'])], { a: { state: 'blocked' } }, live)).toEqual([])
  })

  it('treats a dep that is no longer on the canvas as satisfied', () => {
    // A deleted node can never report; waiting on it would strand the dependent forever.
    const status: StatusById = { a: { state: 'done' } }
    expect(launchesToFire([armed('c', ['a', 'ghost'])], status, new Set(['a', 'c']))).toEqual([
      { id: 'c', command: 'echo c' }
    ])
  })

  it('ignores nodes that are not armed, and armed nodes with an empty command', () => {
    const status: StatusById = { a: { state: 'done' } }
    expect(launchesToFire([plain('c'), armed('d', ['a'], '')], status, live)).toEqual([])
  })

  it('fires immediately when there are no deps left to wait on', () => {
    expect(launchesToFire([armed('c', [])], {}, live)).toEqual([{ id: 'c', command: 'echo c' }])
  })

  it('walks a chain A → B → C one station at a time', () => {
    const chain = [armed('b', ['a']), armed('c', ['b'])]
    // Nothing has reported: nothing fires.
    expect(launchesToFire(chain, {}, live)).toEqual([])
    // A done releases B only — C waits on B, which has not even started.
    expect(launchesToFire(chain, { a: { state: 'done' } }, live)).toEqual([{ id: 'b', command: 'echo b' }])
    // B running is still not B done.
    expect(launchesToFire(chain, { a: { state: 'done' }, b: { state: 'working' } }, live)).toEqual([
      { id: 'b', command: 'echo b' }
    ])
    // B done releases C. (B is still listed here because the caller, not this function, retires a
    // delivered launch by clearing its pendingLaunch — exactly-once lives in `launchInFlight`.)
    expect(launchesToFire(chain, { a: { state: 'done' }, b: { state: 'done' } }, live)).toEqual([
      { id: 'b', command: 'echo b' },
      { id: 'c', command: 'echo c' }
    ])
  })

  it('after a restart (empty status map) a persisted arming holds — nothing will report, ▶ is the escape', () => {
    // Agent state is transient; a live dep that reported `done` before the restart is unknown now,
    // and unknown is NOT satisfied. The manual run-now on the badge exists for exactly this.
    expect(launchesToFire([armed('c', ['a'])], {}, live)).toEqual([])
    expect(unmetDeps(armed('c', ['a']), {}, live)).toEqual(['a'])
  })

  it('a dep deleted mid-chain releases what waited on it, but not what waits further down', () => {
    const chain = [armed('b', ['a']), armed('c', ['b'])]
    const liveWithoutA = new Set(['b', 'c'])
    expect(launchesToFire(chain, {}, liveWithoutA)).toEqual([{ id: 'b', command: 'echo b' }])
  })
})

describe('launchesToFire — awaitSetupGroup (a worktree whose setup script must land first)', () => {
  const live = new Set(['a', 'c'])
  const armedForSetup = (id: string, groupId: string, after: string[] = []): ArmedNode => ({
    id,
    data: { pendingLaunch: { after, command: `echo ${id}`, awaitSetupGroup: groupId } }
  })

  it('holds the launch while the group’s setup run is not done', () => {
    expect(launchesToFire([armedForSetup('c', 'g1')], {}, live, () => false)).toEqual([])
  })

  it('fires once the group’s setup run is done', () => {
    expect(launchesToFire([armedForSetup('c', 'g1')], {}, live, () => true)).toEqual([
      { id: 'c', command: 'echo c' }
    ])
  })

  it('with no setupDone probe at all, the gate is open — an absent probe never strands a node', () => {
    // Reached after an app restart: the run store is empty, and a node armed before the restart
    // would otherwise wait forever for a run nobody is going to report on again.
    expect(launchesToFire([armedForSetup('c', 'g1')], {}, live)).toEqual([
      { id: 'c', command: 'echo c' }
    ])
  })

  it('asks the probe about THIS node’s group', () => {
    const asked: string[] = []
    launchesToFire([armedForSetup('c', 'g-seven')], {}, live, (g) => {
      asked.push(g)
      return true
    })
    expect(asked).toEqual(['g-seven'])
  })

  it('needs BOTH gates: setup done AND every `after` dep satisfied', () => {
    const node = [armedForSetup('c', 'g1', ['a'])]
    // setup done, dep still working
    expect(launchesToFire(node, { a: { state: 'working' } }, live, () => true)).toEqual([])
    // dep done, setup still running
    expect(launchesToFire(node, { a: { state: 'done' } }, live, () => false)).toEqual([])
    // both
    expect(launchesToFire(node, { a: { state: 'done' } }, live, () => true)).toEqual([
      { id: 'c', command: 'echo c' }
    ])
  })

  it('leaves a node with no awaitSetupGroup alone even while some setup is running', () => {
    expect(launchesToFire([armed('c', [])], {}, live, () => false)).toEqual([
      { id: 'c', command: 'echo c' }
    ])
  })
})

describe('unmetDeps', () => {
  it('reports only the deps still outstanding', () => {
    const live = new Set(['a', 'b', 'c'])
    const status: StatusById = { a: { state: 'done' }, b: { state: 'working' } }
    expect(unmetDeps(armed('c', ['a', 'b']), status, live)).toEqual(['b'])
  })

  it('is empty for a node that is not armed', () => {
    expect(unmetDeps(plain('c'), {}, new Set(['c']))).toEqual([])
  })
})

/**
 * Issue #569 item 1 — the delivery policy behind an armed node's held launch.
 *
 * The bug these pin: delivery used to be a flat 5 × 400 ms = 2 s budget started when the CANVAS
 * decided a node was ready to launch, not when the node's terminal existed. A cold project switch
 * spends that budget on loading the canvas, mounting the node and spawning tmux, so the launch was
 * abandoned before there was anything to deliver into — and abandoned into a `console.warn`, which
 * left a node reading QUEUED forever with no way to tell it apart from one still waiting on a
 * dependency.
 */
describe('launch delivery policy (#569 item 1)', () => {
  it('the stall warning waits longer than a cold project switch could plausibly take', () => {
    expect(LAUNCH_STALL_MS).toBeGreaterThanOrEqual(30_000)
  })
})

describe('launchTooltip — the QUEUED badge never goes silent (#569 item 1)', () => {
  const cmd = 'claude "review the diff"'

  it('with nothing to report it names the dependencies, exactly as before', () => {
    const t = launchTooltip(undefined, 'Builder, Tests', cmd)
    expect(t).toContain('Waiting for Builder, Tests to finish')
    expect(t).toContain(cmd)
    expect(t).not.toContain('▶')
  })

  it('a stalled launch says it is still held, and does NOT claim a cause it never measured', () => {
    const t = launchTooltip({ kind: 'stalled', since: 1 }, 'Builder', cmd)
    expect(t).toContain('has not started yet')
    expect(t).toContain('still held')
    expect(t).toContain('▶')
    // We know the terminal is not up; we do not know why. Naming a cause here would be the
    // misleading-error failure this feature exists to avoid.
    expect(t.toLowerCase()).not.toMatch(/ssh|host is down|crash/)
  })

  it('a failed launch reports uncertainty and requires explicit recovery', () => {
    const t = launchTooltip({ kind: 'failed', attempts: 5, at: 1 }, 'Builder', cmd)
    expect(t).toContain('unconfirmed')
    expect(t).toContain('automatic retry is stopped')
    expect(t).toContain('▶')
    expect(t).toContain(cmd)
  })

  it('a manual refusal instructs the user to inspect the terminal', () => {
    expect(launchTooltip({ kind: 'failed', attempts: 1, at: 1 }, 'Builder', cmd)).toContain(
      'Inspect the terminal'
    )
  })

  it('failed outranks the dependency sentence — the warning is never buried', () => {
    const t = launchTooltip({ kind: 'failed', attempts: 5, at: 1 }, 'Builder', cmd)
    expect(t).not.toContain('Waiting for Builder')
  })
})


describe('control opens retain an unacknowledged launch (#827/#811)', () => {
  it.each(['claude', 'codex'])('queues %s even on a visible canvas with no dependencies', (agent) => {
    const original = { id: 'new', data: { initialCommand: `${agent} brief`, pendingLaunch: undefined } }
    const node = queueControlLaunch(original)
    expect(node.data.initialCommand).toBeUndefined()
    expect(node.data.pendingLaunch).toEqual({ after: [], command: `${agent} brief`, attempted: false })
    expect(controlLaunchState(!!node.data.pendingLaunch, undefined)).toBe('queued')
    // Simulate a project save/view: only durable data survives; the command must still fire.
    const restored = JSON.parse(JSON.stringify(node))
    expect(launchesToFire([restored], {}, new Set(['new']))).toEqual([{ id: 'new', command: `${agent} brief` }])
    expect(original.data.initialCommand).toBe(`${agent} brief`)
  })

  it('preserves dependency and setup gates until delivery, including already-done dependencies', () => {
    const node = queueControlLaunch({ id: 'new', data: { initialCommand: 'claude brief' } }, ['upstream'], 'setup')
    const live = new Set(['new', 'upstream'])
    expect(launchesToFire([node], {}, live, () => true)).toEqual([])
    expect(launchesToFire([node], { upstream: { state: 'done' } }, live, () => false)).toEqual([])
    expect(launchesToFire([node], { upstream: { state: 'done' } }, live, () => true)).toEqual([{ id: 'new', command: 'claude brief' }])
  })

  it('does not invent a launch for a plain shell or overwrite an existing hold', () => {
    const node = armed('held', ['upstream'])
    expect(queueControlLaunch(node)).toBe(node)
    const shell = { data: {} }
    expect(queueControlLaunch(shell)).toBe(shell)
  })

  it('does not infer running from delivery, idle, or absence of errors', () => {
    expect(controlLaunchState(false, undefined)).toBeUndefined()
    expect(controlLaunchState(false, undefined, { state: 'done' })).toBeUndefined()
    expect(controlLaunchState(false, undefined, { state: 'working' })).toBe('working')
    expect(controlLaunchState(false, undefined, { state: 'working', dropped: true })).toBe('dropped')
    expect(controlLaunchState(true, { kind: 'failed', attempts: 5, at: 1 })).toBe('failed')
    expect(controlLaunchState(true, { kind: 'stalled', since: 1 })).toBe('stalled')
  })
})


it('a dependency-free launch tooltip names delivery rather than an empty dependency', () => {
  expect(launchTooltip(undefined, '', 'codex')).toBe('Queued; waiting for launch delivery.\nRuns:\ncodex')
})


it('an exhausted delivery stays held on rerender; a stalled terminal may still become ready', () => {
  const node = armed('new', [])
  const live = new Set(['new'])
  expect(launchesToFire([node], {}, live, undefined, { new: { kind: 'failed', attempts: 5, at: 1 } })).toEqual([])
  expect(node.data.pendingLaunch?.command).toBe('echo new')
  expect(launchesToFire([node], {}, live, undefined, { new: { kind: 'stalled', since: 1 } })).toEqual([{ id: 'new', command: 'echo new' }])
})

 it('a durable manual-only launch stays held after a reload and unrelated successful hooks', () => {
  const node = armed('new', [])
  node.data.pendingLaunch!.manualOnly = true
  const restored = JSON.parse(JSON.stringify(node))
  expect(launchesToFire([restored], { other: { state: 'done' } }, new Set(['new', 'other']))).toEqual([])
  expect(restored.data.pendingLaunch.command).toBe('echo new')
})

it('manual recovery does not promise that retrying an errored dependency will automatically release it', () => {
  const tooltip = launchTooltip({ kind: 'failed', attempts: 1, at: 0 }, 'upstream', 'claude brief', 'upstream')
  expect(tooltip).toContain('automatic retry is stopped')
  expect(tooltip).not.toContain('successful turn releases')
})

it('a refused relay launch explains host recovery rather than promising a working retry', () => {
  const text = launchTooltip({ kind: 'failed', attempts: 1, at: 0 }, '', 'claude brief', undefined, true)
  expect(text).toContain('Open the host to run this command')
  expect(text).toContain('claude brief')
  expect(text).not.toContain('press ▶')
})
