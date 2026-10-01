// An interrupted turn (Esc / Ctrl+C) holds `--after` dependents, like an errored one (#521), but
// through its OWN annotation — an interrupt is not a failure. Claude sends no hook for it (measured
// on 2.1.285); the `done` comes from the transcript marker the core reads (`recordTurnInterrupt`,
// core/claude-turn-interrupt.test.ts) or from the renderer's own keystroke guess.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useAgentStatus, inferInterruptAfterSettle, interruptVerdict } from '../state/agentStatus'
import { interruptedDeps, erroredDeps, launchesToFire, launchTooltip, unmetDeps, type StatusById } from './pendingLaunch'
import { storedNodeListing, controlListingText } from './controlRouting'

const LIVE = new Set(['up'])
const armed = (after: string[]) => ({ id: 'down', data: { pendingLaunch: { after, command: 'go' } } })

let n = 0
const nid = () => `ti${++n}`

describe('the store keeps the verdict beside the state', () => {
  beforeEach(() => useAgentStatus.setState({ byId: {} }))

  const interruptedDone = (id: string) =>
    useAgentStatus.getState().setState(id, 'done', 'claude', undefined, undefined, undefined, undefined, undefined, true)

  it('an interrupted done records it; it is NOT an error', () => {
    const id = nid()
    useAgentStatus.getState().setState(id, 'working', 'claude', true)
    interruptedDone(id)
    const e = useAgentStatus.getState().byId[id]
    expect(e.state).toBe('done')
    expect(e.lastTurnInterrupted?.at).toBeGreaterThan(0)
    expect(e.lastTurnError).toBeUndefined()
  })

  it('lands even when the node is ALREADY done (the renderer guess ran first)', () => {
    const id = nid()
    useAgentStatus.getState().setState(id, 'done', 'claude')
    interruptedDone(id)
    expect(useAgentStatus.getState().byId[id].lastTurnInterrupted).toBeDefined()
  })

  it('a new turn, or a turn that then ends normally, retires it; intermediate states leave it', () => {
    const id = nid()
    const s = useAgentStatus.getState()
    interruptedDone(id)
    s.setState(id, 'blocked', 'claude')
    expect(useAgentStatus.getState().byId[id].lastTurnInterrupted).toBeDefined()
    s.setState(id, 'working', 'claude', true)
    expect(useAgentStatus.getState().byId[id].lastTurnInterrupted).toBeUndefined()

    const id2 = nid()
    interruptedDone(id2)
    s.setState(id2, 'done', 'claude') // e.g. an injected <task-notification> turn that finished
    expect(useAgentStatus.getState().byId[id2].lastTurnInterrupted).toBeUndefined()
  })

  it('interruptVerdict is the whole rule', () => {
    const prev = { at: 1 }
    expect(interruptVerdict(undefined, 'done', false, true)).toBe('set')
    expect(interruptVerdict(prev, 'done', false, false)).toBeUndefined()
    expect(interruptVerdict(prev, 'working', true)).toBeUndefined()
    expect(interruptVerdict(prev, 'working', false)).toBe(prev)
    expect(interruptVerdict(prev, undefined)).toBe(prev)
  })

  it('the keystroke guess records an INTERRUPTED done, so it cannot release dependents early', () => {
    vi.useFakeTimers()
    try {
      const id = nid()
      useAgentStatus.getState().setState(id, 'working', 'claude')
      inferInterruptAfterSettle(id, 1500)
      vi.advanceTimersByTime(1500)
      const e = useAgentStatus.getState().byId[id]
      expect(e.state).toBe('done')
      expect(e.lastTurnInterrupted).toBeDefined()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('--after holds on an interrupted upstream', () => {
  const done: StatusById = { up: { state: 'done' } }
  const interrupted: StatusById = { up: { state: 'done', lastTurnInterrupted: { at: 1 } } }

  it('does not fire, names the upstream, and says why', () => {
    expect(launchesToFire([armed(['up'])], done, LIVE)).toHaveLength(1)
    expect(launchesToFire([armed(['up'])], interrupted, LIVE)).toEqual([])
    expect(unmetDeps(armed(['up']), interrupted, LIVE)).toEqual(['up'])
    expect(interruptedDeps(armed(['up']), interrupted, LIVE)).toEqual(['up'])
    expect(erroredDeps(armed(['up']), interrupted, LIVE)).toEqual([])
  })

  it('an errored dep is named as errored only, and a deleted one is still satisfied', () => {
    const both: StatusById = { up: { state: 'done', lastTurnError: { at: 1 }, lastTurnInterrupted: { at: 1 } } }
    expect(interruptedDeps(armed(['up']), both, LIVE)).toEqual([])
    expect(launchesToFire([armed(['up'])], interrupted, new Set())).toHaveLength(1)
  })

  it('the QUEUED tooltip says the upstream was interrupted and offers ▶', () => {
    const t = launchTooltip(undefined, 'A', 'go', undefined, false, undefined, undefined, 'A')
    expect(t).toContain('was interrupted before its turn finished')
    expect(t).toContain('▶')
    expect(t).not.toContain('Waiting for')
  })

  it('`list` marks the row LAST TURN INTERRUPTED (and an error outranks it)', () => {
    const rows = storedNodeListing(
      [{ id: 'i', agentId: 'claude' }, { id: 'e', agentId: 'claude' }],
      {
        i: { state: 'done', lastTurnInterrupted: { at: 1 } },
        e: { state: 'done', lastTurnError: { at: 1 }, lastTurnInterrupted: { at: 1 } }
      }
    )
    const text = controlListingText(rows)
    expect(text).toContain('i [terminal]  — IDLE — LAST TURN INTERRUPTED')
    expect(text).toContain('e [terminal]  — IDLE — LAST TURN ERRORED')
    expect(text).not.toMatch(/e \[terminal\].*INTERRUPTED/)
  })
})

describe('review follow-ups', () => {
  it('the idle rescue does NOT record an interrupt (it means a lost Stop on a normal turn)', async () => {
    const { recordsTurnInterrupt } = await import('../state/agentStatus')
    expect(recordsTurnInterrupt({ interrupted: true })).toBe(true)
    expect(recordsTurnInterrupt({ interrupted: true, idle: true })).toBe(false)
    expect(recordsTurnInterrupt({})).toBe(false)
  })

  it('Canvas: the launch effect re-runs when a last-turn verdict clears under a steady `done`', async () => {
    const { readFileSync } = await import('fs')
    const { resolve } = await import('path')
    const src = readFileSync(resolve(__dirname, '../canvas/Canvas.tsx'), 'utf8')
    const sig = src.slice(src.indexOf('const armedDepSig = useAgentStatus'), src.indexOf('// ---- the setup gate'))
    expect(sig).toContain('lastTurnInterrupted')
    expect(sig).toContain('lastTurnError')
  })

  it('team progress does not count an interrupted station as done', async () => {
    const { stationKind, summarizeTeam } = await import('./teamProgress')
    const k = stationKind({ id: 's', title: 's', agentId: 'claude', queued: false } as never, {
      state: 'done',
      lastTurnInterrupted: { at: 1 }
    })
    expect(k).toBe('interrupted')
    expect(summarizeTeam([k]).done).toBe(0)
  })
})
