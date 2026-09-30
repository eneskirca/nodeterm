import { describe, it, expect, vi } from 'vitest'
import type { PendingLaunch } from '@shared/types'
import {
  launchesToFire,
  queueControlLaunch,
  controlLaunchState,
  deliveriesToRetire,
  launchTooltip,
  unmetDeps,
  LAUNCH_STALL_MS,
  withPrHold,
  withSuccessHold,
  successDepFacts,
  withLaunchBrief,
  launchBriefPresent,
  handedOverDeps,
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

  it('launchTooltip explains a background start (#925)', () => {
    expect(launchTooltip({ kind: 'starting', since: 0 }, '', 'claude', undefined, false)).toMatch(
      /starting in the background/i
    )
  })

  it('a background start outranks every other sentence — none of them may offer ▶ mid-start (#925)', () => {
    for (const t of [
      launchTooltip({ kind: 'starting', since: 0 }, 'Builder', cmd, 'Builder'),
      launchTooltip({ kind: 'starting', since: 0 }, 'Builder', cmd, undefined, true)
    ]) {
      expect(t).toMatch(/starting in the background/i)
      expect(t).not.toContain('▶')
      expect(t).not.toContain('Waiting for Builder')
    }
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
    expect(controlLaunchState(true, { kind: 'starting', since: 1 })).toBe('starting')
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

it('a background start holds the canvas delivery too — core is typing into that pane (#925)', () => {
  // The headless claim normally makes the node manualOnly first; this is the guard for a live
  // copy that has not caught up with the claim yet, when the store already says `starting`.
  const node = armed('new', [])
  expect(launchesToFire([node], {}, new Set(['new']), undefined, { new: { kind: 'starting', since: 1 } })).toEqual([])
})

describe('deliveriesToRetire — the Canvas sweep (#925)', () => {
  const byId = {
    delivered: { kind: 'failed' as const, attempts: 1, at: 1 },
    elsewhere: { kind: 'stalled' as const, since: 1 },
    starting: { kind: 'starting' as const, since: 1 },
    armed: { kind: 'stalled' as const, since: 1 }
  }

  it('retires every record whose node is not an armed node on the active canvas', () => {
    expect(deliveriesToRetire(byId, (id) => id === 'armed')).toEqual(['delivered', 'elsewhere'])
  })

  it('never retires a start in flight: it runs for a node that is NOT on the active canvas', () => {
    // Dropping it would re-enable ▶ the moment the user switches to that project, because the
    // manualOnly claim alone reads as a failed launch.
    expect(deliveriesToRetire({ starting: byId.starting }, () => false)).toEqual([])
  })
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

describe('--after-pr: a PR wait is a third gate, ANDed with the deps and the setup script', () => {
  const NOW = 5_000_000
  const hold = (deadlineAt = NOW + 60_000) => ({
    repository: 'o/r',
    waits: [{ number: 7, until: 'merged' as const }],
    deadlineAt,
    armedAt: 0
  })
  const prNode = (after: string[], deadlineAt?: number): ArmedNode => ({
    id: 'c',
    data: { pendingLaunch: { after, command: 'echo c', afterPr: hold(deadlineAt) } }
  })
  const pull = (lifecycle: 'open' | 'merged') => ({
    number: 7, lifecycle, headRefName: 'b', closes: [] as number[]
  })
  const board = (lifecycle: 'open' | 'merged') => ({
    repository: 'o/r',
    pulls: [pull(lifecycle)],
    stale: false,
    access: { ci: true, merge: true },
    undecided: false,
    truncated: false
  })
  const live = new Set(['a', 'c'])
  const done: StatusById = { a: { state: 'done' } }

  it('fires once the deps are done AND the PR has merged', () => {
    expect(launchesToFire([prNode(['a'])], done, live, undefined, undefined, { board: board('merged'), now: NOW })).toEqual([
      { id: 'c', command: 'echo c' }
    ])
  })

  it('holds while the PR is open, however done the deps are', () => {
    expect(launchesToFire([prNode(['a'])], done, live, undefined, undefined, { board: board('open'), now: NOW })).toEqual([])
  })

  it('holds while the deps are working, however merged the PR is', () => {
    expect(
      launchesToFire([prNode(['a'])], { a: { state: 'working' } }, live, undefined, undefined, { board: board('merged'), now: NOW })
    ).toEqual([])
  })

  it('a caller that passes no PR context never releases a PR hold — unknown is not satisfied', () => {
    expect(launchesToFire([prNode([])], {}, live)).toEqual([])
  })

  it('never fires past the deadline', () => {
    expect(
      launchesToFire([prNode([], NOW)], {}, live, undefined, undefined, { board: board('merged'), now: NOW })
    ).toEqual([])
  })

  it('a node with no PR wait is unaffected by the PR context', () => {
    expect(launchesToFire([armed('c', ['a'])], done, live, undefined, undefined, { board: undefined, now: NOW })).toEqual([
      { id: 'c', command: 'echo c' }
    ])
  })

  it('the list row says EXPIRED once the deadline passes (a delivery record still wins)', () => {
    expect(controlLaunchState(true, undefined, undefined, true)).toBe('expired')
    expect(controlLaunchState(true, undefined, undefined, false)).toBe('queued')
    expect(controlLaunchState(true, { kind: 'failed', attempts: 1, at: 0 }, undefined, true)).toBe('failed')
  })

  it('the tooltip names the PR it waits on, beside any station', () => {
    const pr = { expired: false, summary: 'PR #7 merged (open, not merged)', deadline: '18:00' }
    expect(launchTooltip(undefined, 'Builder', 'claude', undefined, false, pr)).toBe(
      'Waiting for Builder to finish and for PR #7 merged (open, not merged), until 18:00, then runs:\nclaude'
    )
    expect(launchTooltip(undefined, '', 'claude', undefined, false, pr)).toBe(
      'Waiting for PR #7 merged (open, not merged), until 18:00, then runs:\nclaude'
    )
  })

  it('an expired wait says it will not start on its own and offers ▶', () => {
    const t = launchTooltip(undefined, 'Builder', 'claude', undefined, false, {
      expired: true,
      summary: 'PR #7 merged (open, not merged)',
      deadline: '18:00'
    })
    expect(t).toMatch(/passed its deadline/)
    expect(t).toMatch(/will not start on its own/)
    expect(t).toMatch(/▶/)
  })

  it('without a PR wait the existing sentences are byte-identical', () => {
    expect(launchTooltip(undefined, 'Builder', 'claude')).toBe('Waiting for Builder to finish, then runs:\nclaude')
  })
})

describe('--after-success: a success wait is a fourth gate — the turn ending is not enough', () => {
  const NOW = 5_000_000
  // As every open path builds it: the station is in `after` too (a success wait is `--after` plus
  // the report).
  const successNode = (deps: string[], deadlineAt = NOW + 60_000, after = deps): ArmedNode => ({
    id: 'c',
    data: { pendingLaunch: { after, command: 'echo c', afterSuccess: { deps, deadlineAt } } }
  })
  const live = new Set(['a', 'b', 'c'])
  const done: StatusById = { a: { state: 'done' }, b: { state: 'done' } }
  const rec = (nodeId: string, outcome: 'succeeded' | 'failed') => ({ nodeId, outcome, at: 1 })
  const ctx = (...records: ReturnType<typeof rec>[]) => ({
    outcomes: Object.fromEntries(records.map((r) => [r.nodeId, r])),
    now: NOW
  })
  const fire = (node: ArmedNode, status: StatusById, c?: ReturnType<typeof ctx>, l = live) =>
    launchesToFire([node], status, l, undefined, undefined, undefined, c)

  it('a reported success, turn over: fires', () => {
    expect(fire(successNode(['a']), done, ctx(rec('a', 'succeeded')))).toEqual([{ id: 'c', command: 'echo c' }])
  })

  it('a reported FAILURE blocks — the dependent never starts on it', () => {
    expect(fire(successNode(['a']), done, ctx(rec('a', 'failed')))).toEqual([])
  })

  it('no report yet holds, even though the turn is over (the whole point: done is not success)', () => {
    expect(fire(successNode(['a']), done, ctx())).toEqual([])
  })

  it('a reported success mid-turn waits for the turn to end', () => {
    expect(fire(successNode(['a']), { a: { state: 'working' } }, ctx(rec('a', 'succeeded')))).toEqual([])
  })

  it('an errored last turn holds even after a success report (#521 stands)', () => {
    expect(
      fire(successNode(['a']), { a: { state: 'done', lastTurnError: { at: 1 } } }, ctx(rec('a', 'succeeded')))
    ).toEqual([])
  })

  it('needs every station: one success is not enough', () => {
    expect(fire(successNode(['a', 'b']), done, ctx(rec('a', 'succeeded')))).toEqual([])
    expect(fire(successNode(['a', 'b']), done, ctx(rec('a', 'succeeded'), rec('b', 'succeeded')))).toEqual([
      { id: 'c', command: 'echo c' }
    ])
  })

  it('is ANDed with a plain --after on another station', () => {
    const node = successNode(['a'], NOW + 60_000, ['a', 'b'])
    expect(fire(node, { a: { state: 'done' }, b: { state: 'working' } }, ctx(rec('a', 'succeeded')))).toEqual([])
    expect(fire(node, done, ctx(rec('a', 'succeeded')))).toEqual([{ id: 'c', command: 'echo c' }])
  })

  it('never fires past the deadline, whatever was reported', () => {
    expect(fire(successNode(['a'], NOW), done, ctx(rec('a', 'succeeded')))).toEqual([])
  })

  it('a caller that passes no success context never releases a success hold', () => {
    expect(fire(successNode(['a']), done, undefined)).toEqual([])
  })

  it('a CLOSED station releases only if it reported success before it went', () => {
    const gone = new Set(['c'])
    expect(fire(successNode(['a']), {}, ctx(rec('a', 'succeeded')), gone)).toEqual([{ id: 'c', command: 'echo c' }])
    // For plain `--after` a deleted station is satisfied; for a success wait it is not — closing a
    // station is exactly how an orchestrator abandons a failed attempt.
    expect(fire(successNode(['a']), {}, ctx(), gone)).toEqual([])
    expect(fire(successNode(['a']), {}, ctx(rec('a', 'failed')), gone)).toEqual([])
  })

  it('a hostile persisted hold never throws and never fires', () => {
    for (const bad of ['a', ['a'], { deps: 'a', deadlineAt: NOW + 1 }, { deps: [42], deadlineAt: NOW + 1 }, 7]) {
      const node = {
        id: 'c',
        data: { pendingLaunch: { after: ['a'], command: 'echo c', afterSuccess: bad } }
      } as unknown as ArmedNode
      expect(() => fire(node, done, ctx(rec('a', 'succeeded')))).not.toThrow()
      expect(fire(node, done, ctx(rec('a', 'succeeded')))).toEqual([])
    }
  })

  it('successDepFacts reads the --after rule for the turn and an OWN record only', () => {
    expect(successDepFacts('a', done, live, {})).toEqual({ exists: true, turnDone: true })
    expect(successDepFacts('constructor', {}, new Set(), {})).toEqual({ exists: false, turnDone: false })
  })

  it('the list row names the wait: waiting, blocked, expired — a delivery record still wins', () => {
    expect(controlLaunchState(true, undefined, undefined, false, 'waiting')).toBe('waiting-success')
    expect(controlLaunchState(true, undefined, undefined, false, 'blocked')).toBe('blocked-failure')
    expect(controlLaunchState(true, undefined, undefined, false, 'expired')).toBe('success-expired')
    expect(controlLaunchState(true, undefined, undefined, false, 'met')).toBe('queued')
    expect(controlLaunchState(true, { kind: 'failed', attempts: 1, at: 0 }, undefined, false, 'blocked')).toBe('failed')
  })

  it('the tooltip says why it waits, why it is blocked, and that an expired wait needs ▶', () => {
    const waiting = launchTooltip(undefined, 'Linter', 'claude', undefined, false, undefined, {
      status: 'waiting',
      summary: 'Builder (no outcome reported yet)',
      deadline: '18:00'
    })
    expect(waiting).toBe(
      'Waiting for Linter to finish and for a reported success from Builder (no outcome reported yet), until 18:00, then runs:\nclaude'
    )
    const blocked = launchTooltip(undefined, '', 'claude', undefined, false, undefined, {
      status: 'blocked',
      summary: 'Builder (reported failure: "red")',
      deadline: '18:00'
    })
    expect(blocked).toContain('Held on Builder (reported failure: "red")')
    expect(blocked).toContain('▶')
    const expired = launchTooltip(undefined, '', 'claude', undefined, false, undefined, {
      status: 'expired',
      summary: '',
      deadline: '18:00'
    })
    expect(expired).toMatch(/passed its deadline \(18:00\)/)
    expect(expired).toMatch(/will not start on its own/)
  })
})

describe('plain --after on a station handed new work (core/station-handover.ts)', () => {
  const live = new Set(['a', 'b', 'c'])
  const status: StatusById = { a: { state: 'done' }, b: { state: 'done' } }
  const handovers = { a: { nodeId: 'a', since: 10 } }

  it('a handed-over station is never a satisfied dep, whatever its state reads', () => {
    expect(launchesToFire([armed('c', ['a', 'b'])], status, live, undefined, undefined, undefined, undefined, handovers)).toEqual([])
    expect(unmetDeps(armed('c', ['a', 'b']), status, live, handovers)).toEqual(['a'])
    expect(handedOverDeps(armed('c', ['a', 'b']), live, handovers)).toEqual(['a'])
  })

  it('without a hand-over the same state fires as before', () => {
    expect(launchesToFire([armed('c', ['a', 'b'])], status, live, undefined, undefined, undefined, undefined, {})).toEqual([
      { id: 'c', command: 'echo c' }
    ])
  })

  it('a deleted station still counts as satisfied, hand-over or not', () => {
    expect(launchesToFire([armed('c', ['a'])], {}, new Set(['c']), undefined, undefined, undefined, undefined, handovers)).toEqual([
      { id: 'c', command: 'echo c' }
    ])
    expect(handedOverDeps(armed('c', ['a']), new Set(['c']), handovers)).toEqual([])
  })

  it('a success wait on a handed-over station holds: its turn is not over', () => {
    expect(successDepFacts('a', status, live, {}, handovers).turnDone).toBe(false)
    expect(successDepFacts('a', status, live, {}).turnDone).toBe(true)
  })

  it('a prototype key is not a hand-over', () => {
    const bare = Object.create(null) as Record<string, undefined>
    expect(handedOverDeps(armed('c', ['constructor', '__proto__']), new Set(['constructor', '__proto__']), bare)).toEqual([])
    expect(handedOverDeps(armed('c', ['constructor']), new Set(['constructor']), {})).toEqual([])
  })

  it('the tooltip says what the wait is for, not "waiting for X to finish" about an idle X', () => {
    const text = launchTooltip(undefined, 'Builder, Tester', 'claude go', undefined, false, undefined, undefined, undefined, 'Builder')
    expect(text).toBe(
      'Waiting for Builder to finish — a turn that ended before that work was done does not count ' +
        '(all waits: Builder, Tester), then runs:\nclaude go'
    )
    // An errored upstream is still named first: it will not end on its own.
    expect(launchTooltip(undefined, 'Builder', 'claude go', 'Tester', false, undefined, undefined, 'Builder')).toMatch(/^Tester ended/)
  })
})

describe('withSuccessHold — the sibling of withPrHold', () => {
  const hold = { deps: ['a'], deadlineAt: 9 }
  it('adds the hold to a node that already holds its launch, and only then', () => {
    const node = { id: 'n', data: { pendingLaunch: { after: ['a'], command: 'c' } } }
    expect(withSuccessHold(node, hold).data.pendingLaunch).toEqual({ after: ['a'], command: 'c', afterSuccess: hold })
    expect(withSuccessHold(node, undefined)).toBe(node)
    const bare = { id: 'n', data: {} as { pendingLaunch?: PendingLaunch } }
    expect(withSuccessHold(bare, hold)).toBe(bare)
  })
})

describe('withPrHold — one way every open path attaches a PR wait', () => {
  const hold = { repository: 'o/r', waits: [{ number: 7, until: 'merged' as const }], deadlineAt: 9, armedAt: 0 }
  it('adds the hold to a node that already holds its launch', () => {
    const node = { id: 'n', data: { pendingLaunch: { after: ['a'], command: 'c', attempted: false } } }
    expect(withPrHold(node, hold).data.pendingLaunch).toEqual({ after: ['a'], command: 'c', attempted: false, afterPr: hold })
  })
  it('leaves a node alone when there is no hold, or nothing is held to attach it to', () => {
    const held = { id: 'n', data: { pendingLaunch: { after: [], command: 'c' } } }
    expect(withPrHold(held, undefined)).toBe(held)
    const bare = { id: 'n', data: {} as { pendingLaunch?: PendingLaunch } }
    expect(withPrHold(bare, hold)).toBe(bare)
  })
})

describe('the launch brief file is verified at DELIVERY, not only at open (#1014 review)', () => {
  const node = { id: 'n', data: { pendingLaunch: { after: [], command: 'claude "$(cat \'/x/p.txt\')"' } } }

  it('withLaunchBrief records the file the command reads; nothing held, nothing recorded', () => {
    expect(withLaunchBrief(node, '/x/p.txt').data.pendingLaunch).toMatchObject({ promptFile: '/x/p.txt' })
    expect(withLaunchBrief(node, undefined)).toBe(node)
    const bare = { id: 'b', data: {} as { pendingLaunch?: { after: string[]; command: string } } }
    expect(withLaunchBrief(bare, '/x/p.txt')).toBe(bare)
  })

  it('launchesToFire hands the file to the loop, which checks it before typing', () => {
    const armedWithBrief = withLaunchBrief(node, '/x/p.txt')
    expect(launchesToFire([armedWithBrief], {}, new Set(['n']))).toEqual([
      { id: 'n', command: armedWithBrief.data.pendingLaunch.command, briefFile: '/x/p.txt' }
    ])
  })

  it('a missing brief is a named, manual hold — never an agent started with no brief', () => {
    const t = launchTooltip({ kind: 'brief-missing', path: '/x/p.txt', at: 1 }, '', 'claude')
    expect(t).toContain('/x/p.txt')
    expect(t).toMatch(/no longer exists/)
    expect(t).toMatch(/no brief/)
    expect(t).toMatch(/▶/)
    expect(controlLaunchState(true, { kind: 'brief-missing', path: '/x/p.txt', at: 1 })).toBe('brief-missing')
  })
})

describe('launchBriefPresent — only a definite "not there" holds a launch', () => {
  const local = { id: 'p' }
  it('no file to check is present', async () => {
    const exists = vi.fn(async () => false)
    expect(await launchBriefPresent(undefined, local, exists)).toBe(true)
    expect(exists).not.toHaveBeenCalled()
  })
  it('a local file that is gone is absent; one that is there is present', async () => {
    expect(await launchBriefPresent('/x', local, async () => false)).toBe(false)
    expect(await launchBriefPresent('/x', local, async () => true)).toBe(true)
  })
  it('a check that fails answers present — the open-time check fails open the same way', async () => {
    expect(await launchBriefPresent('/x', local, async () => { throw new Error('EIO') })).toBe(true)
    expect(await launchBriefPresent('/x', local, () => { throw new Error('sync') })).toBe(true)
  })
  it('an SSH or relay project is never judged from here (a false there is not evidence of absence)', async () => {
    const exists = vi.fn(async () => false)
    expect(await launchBriefPresent('/x', { id: 'p', ssh: {} }, exists)).toBe(true)
    expect(await launchBriefPresent('/x', { id: 'p', remote: true }, exists)).toBe(true)
    expect(await launchBriefPresent('/x', undefined, exists)).toBe(true)
    expect(exists).not.toHaveBeenCalled()
  })
})
