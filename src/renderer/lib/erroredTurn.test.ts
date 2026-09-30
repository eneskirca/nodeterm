// Issue #521 — a station whose first turn dies must not look like one that finished.
//
// Observed in a seven-station run: two stations were launched with a malformed prompt, errored
// immediately, and looked healthy from every surface an orchestrator can read. The damage is not
// the missing badge — `--after` fires on idle, and an errored station reaches idle IMMEDIATELY, so
// every downstream station armed behind it launched against an upstream that had produced nothing.
//
// The three legs of the fix, end to end: the hook says it (`normalizeClaude`/`normalizeGrok` on
// `StopFailure`, which both agents fire INSTEAD of `Stop`), the store keeps it as an annotation
// beside the state rather than as a fifth `AgentState` (an errored station IS idle — the two facts
// coexist), and `depSatisfied` refuses it.
import { beforeEach, describe, expect, it } from 'vitest'
import { normalizeClaude, normalizeGrok } from '@shared/agents/normalize'
import { useAgentStatus } from '../state/agentStatus'
import { erroredDeps, launchesToFire, launchTooltip, unmetDeps } from './pendingLaunch'
import type { StatusById } from './pendingLaunch'

const LIVE = new Set(['up'])
const armed = (after: string[]) => ({ id: 'down', data: { pendingLaunch: { after, command: 'go' } } })

describe('the hook says it (normalize)', () => {
  const env = (payload: Record<string, unknown>) => ({
    nodeId: 'n1',
    agentId: 'claude' as const,
    payload
  })

  it('claude StopFailure carries `errored` beside its `done`', () => {
    const e = normalizeClaude(env({ hook_event_name: 'StopFailure' }))
    expect(e).toMatchObject({ kind: 'state', state: 'done', errored: true })
  })

  it('an ordinary claude Stop does NOT', () => {
    // The whole point: the two must stop being byte-identical.
    const e = normalizeClaude(env({ hook_event_name: 'Stop' }))
    expect(e).toMatchObject({ state: 'done' })
    expect(e?.errored).toBeFalsy()
  })

  it('an INTERRUPTED turn is not an errored one', () => {
    // The user pressed Esc. Nothing failed, so it is not `errored` (no TURN FAILED chip, no
    // station-failure notice). It still holds `--after` dependents, through its OWN annotation —
    // `lastTurnInterrupted`, see turnInterrupt.test.ts.
    const e = normalizeClaude(env({ hook_event_name: 'Stop', is_interrupt: true }))
    expect(e).toMatchObject({ state: 'done', interrupted: true })
    expect(e?.errored).toBeFalsy()
  })

  it('grok reports it the same way — same field, one definition, both shells', () => {
    const e = normalizeGrok({
      nodeId: 'n1',
      agentId: 'grok',
      payload: { hookEventName: 'stop_failure', sessionId: 's1' }
    })
    expect(e).toMatchObject({ state: 'done', errored: true })
  })
})

describe('the store keeps it as an annotation, not a state', () => {
  let n = 0
  const nid = () => `n${++n}`
  beforeEach(() => useAgentStatus.setState({ byId: {} }))

  it('records the error without displacing `done`', () => {
    const id = nid()
    useAgentStatus.getState().setState(id, 'done', 'claude', false, undefined, false, true)
    const e = useAgentStatus.getState().byId[id]
    expect(e.state).toBe('done')
    expect(e.lastTurnError?.at).toBeGreaterThan(0)
  })

  it('an ordinary done leaves it unset', () => {
    const id = nid()
    useAgentStatus.getState().setState(id, 'done', 'claude')
    expect(useAgentStatus.getState().byId[id].lastTurnError).toBeUndefined()
  })

  it('the next genuine new turn retires the verdict', () => {
    const id = nid()
    const s = useAgentStatus.getState()
    s.setState(id, 'done', 'claude', false, undefined, false, true)
    s.setState(id, 'working', 'claude', true)
    expect(useAgentStatus.getState().byId[id].lastTurnError).toBeUndefined()
  })

  it('an intermediate transition that is NOT a new turn leaves it standing', () => {
    // Between the failure and the next prompt a station still emits tool/notification events. None
    // of them says anything about whether that turn produced something.
    const id = nid()
    const s = useAgentStatus.getState()
    s.setState(id, 'done', 'claude', false, undefined, false, true)
    s.setState(id, 'blocked', 'claude')
    expect(useAgentStatus.getState().byId[id].lastTurnError).toBeDefined()
  })

  it('a StopFailure re-asserting the SAME state still lands', () => {
    // The same-state path refreshes freshness IN PLACE to avoid a re-render — which is exactly what
    // a badge appearing needs, so an event that moves the verdict must not take that path.
    const id = nid()
    const s = useAgentStatus.getState()
    s.setState(id, 'done', 'claude')
    s.setState(id, 'done', 'claude', false, undefined, false, true)
    expect(useAgentStatus.getState().byId[id].lastTurnError).toBeDefined()
  })

  it('is transient — never reaches the persisted whitelist', async () => {
    // Same rule as `state` and `lastEventAt`: after a relaunch no hook has spoken, nothing armed
    // can fire anyway, and a restored verdict would describe a turn from another app run.
    const { vi } = await import('vitest')
    const mem = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => void mem.set(k, v),
      removeItem: (k: string) => void mem.delete(k)
    })
    const id = nid()
    const s = useAgentStatus.getState()
    s.setState(id, 'done', 'claude', false, undefined, false, true)
    s.setHibernated(id, true) // a write that DOES reach disk, so there is something to inspect
    expect(mem.get('nodeterm.agentStatus') ?? '').not.toContain('lastTurnError')
    expect(mem.get('nodeterm.agentStatus') ?? '').toContain('hibernated')
    vi.unstubAllGlobals()
  })
})

describe('depSatisfied refuses an errored upstream (the arming bug)', () => {
  const done: StatusById = { up: { state: 'done' } }
  const erroredDone: StatusById = { up: { state: 'done', lastTurnError: { at: 1 } } }

  it('fires on a clean done', () => {
    expect(launchesToFire([armed(['up'])], done, LIVE)).toEqual([{ id: 'down', command: 'go' }])
  })

  it('does NOT fire on a done that errored', () => {
    // The seven-station run: this is the launch that started a chain on bad ground.
    expect(launchesToFire([armed(['up'])], erroredDone, LIVE)).toEqual([])
  })

  it('reports the upstream as still unmet, and says WHY', () => {
    expect(unmetDeps(armed(['up']), erroredDone, LIVE)).toEqual(['up'])
    expect(erroredDeps(armed(['up']), erroredDone, LIVE)).toEqual(['up'])
  })

  it('distinguishes "errored" from "has not finished" — only one of them is named', () => {
    const working: StatusById = { up: { state: 'working' } }
    expect(unmetDeps(armed(['up']), working, LIVE)).toEqual(['up'])
    expect(erroredDeps(armed(['up']), working, LIVE)).toEqual([])
  })

  it('a DELETED errored dep is still satisfied — it can never report again', () => {
    // The existing rule, unchanged: treating it as pending would strand the dependent forever.
    expect(launchesToFire([armed(['up'])], erroredDone, new Set())).toEqual([
      { id: 'down', command: 'go' }
    ])
    expect(erroredDeps(armed(['up']), erroredDone, new Set())).toEqual([])
  })

  it('the refusal ends by itself once the station completes a turn', () => {
    // No manual clearing, no flag to unset: the next genuine new turn retires the verdict in the
    // store, and the very next sweep of `launchesToFire` releases everything armed behind it.
    expect(launchesToFire([armed(['up'])], done, LIVE)).toHaveLength(1)
  })

  it('the QUEUED tooltip names the errored upstream instead of promising a wait', () => {
    const t = launchTooltip(undefined, 'Contract station', 'go', 'Contract station')
    expect(t).toContain('ended its last turn on an error')
    expect(t).not.toContain('Waiting for')
    // The manual escape must still be offered — a dependent held on a dead upstream needs a way out.
    expect(t).toContain('▶')
  })

  it('an ordinary hold still reads as an ordinary hold', () => {
    expect(launchTooltip(undefined, 'Contract station', 'go')).toContain('Waiting for')
  })
})
