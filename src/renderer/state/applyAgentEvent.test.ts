// The store half of the agent-status listener, run against REAL stores: a fresh agent-status session
// per test (in-memory, no persist key) and the real subagent-card store reset to empty. Canvas used
// to hold these writes inside one of its effects, where nothing could dispatch an event at them; the
// reducer exists so a relay session's own store can receive the same writes (bug D).
import { beforeEach, describe, expect, it } from 'vitest'
import type { NormalizedAgentEvent } from '@shared/agents/normalize'
import { createAgentStatusSession } from './agentStatus'
import { useAgentNodes } from './agentNodes'
import { applyAgentEvent } from './applyAgentEvent'

const N = 'term-node-a'

const ev = (over: Partial<NormalizedAgentEvent> = {}): NormalizedAgentEvent => ({
  nodeId: N,
  agentId: 'claude',
  kind: 'state',
  ...over
})

const LOCAL = { observationRemote: false }

let status: ReturnType<typeof createAgentStatusSession>['store']

beforeEach(() => {
  status = createAgentStatusSession(undefined).store
  useAgentNodes.setState({
    byId: {},
    activityById: {},
    lastActivityAt: {},
    positions: {},
    sizes: {},
    expanded: {},
    selectedId: null,
    autoHideFinished: false
  })
})

const entry = (id = N) => status.getState().byId[id]

describe('applyAgentEvent', () => {
  it('records state, agent and session id', () => {
    const r = applyAgentEvent(status, useAgentNodes, ev({ state: 'working', newTurn: true, sessionId: 'sess-1' }), LOCAL)
    expect(r).toEqual({ nodeId: N, alert: null })
    expect(entry().state).toBe('working')
    expect(entry().agentId).toBe('claude')
    expect(entry().sessionId).toBe('sess-1')
  })

  it('a clean done answers a finished alert', () => {
    applyAgentEvent(status, useAgentNodes, ev({ state: 'working', newTurn: true }), LOCAL)
    const r = applyAgentEvent(status, useAgentNodes, ev({ state: 'done', lastMessage: 'all green' }), LOCAL)
    expect(r.alert).toEqual({ kind: 'finished', quiet: false })
    expect(entry().state).toBe('done')
  })

  it('an interrupted done answers no alert', () => {
    applyAgentEvent(status, useAgentNodes, ev({ state: 'working', newTurn: true }), LOCAL)
    const r = applyAgentEvent(status, useAgentNodes, ev({ state: 'done', interrupted: true }), LOCAL)
    expect(r.alert).toBeNull()
    // The badge still moves: the turn ended, nobody needs telling.
    expect(entry().state).toBe('done')
    expect(entry().lastTurnInterrupted).toBeDefined()
  })

  it('the idle rescue on a node that was not working answers no alert', () => {
    applyAgentEvent(status, useAgentNodes, ev({ state: 'working', newTurn: true }), LOCAL)
    applyAgentEvent(status, useAgentNodes, ev({ state: 'done' }), LOCAL)
    const before = entry()
    const r = applyAgentEvent(status, useAgentNodes, ev({ state: 'done', idle: true, lastMessage: 'x' }), LOCAL)
    expect(r.alert).toBeNull()
    // Skipped outright: no state write, no loop bump — the entry is the very same object.
    expect(entry()).toBe(before)
  })

  it('blocked and waiting answer needs-input', () => {
    const blocked = applyAgentEvent(status, useAgentNodes, ev({ state: 'blocked', pendingId: 'p-1' }), LOCAL)
    expect(blocked.alert).toEqual({ kind: 'needs-input' })
    expect(entry().state).toBe('blocked')
    expect(entry().pendingId).toBe('p-1')
    const waiting = applyAgentEvent(status, useAgentNodes, ev({ nodeId: 'term-node-b', state: 'waiting' }), LOCAL)
    expect(waiting).toEqual({ nodeId: 'term-node-b', alert: { kind: 'needs-input' } })
    expect(entry('term-node-b').state).toBe('waiting')
  })

  it('a done while a subagent card still works is quiet', () => {
    applyAgentEvent(status, useAgentNodes, ev({ state: 'working', newTurn: true }), LOCAL)
    applyAgentEvent(
      status,
      useAgentNodes,
      ev({ kind: 'subagent-start', toolUseId: 'tool-1', subagentType: 'Explore', taskLabel: 'scan' }),
      LOCAL
    )
    expect(useAgentNodes.getState().byId['tool-1']).toMatchObject({ parentNodeId: N, state: 'working' })
    const r = applyAgentEvent(status, useAgentNodes, ev({ state: 'done' }), LOCAL)
    expect(r.alert).toEqual({ kind: 'finished', quiet: true })
    // Once the card reports done, the next turn end is a real finish again.
    applyAgentEvent(status, useAgentNodes, ev({ kind: 'subagent-end', toolUseId: 'tool-1', tokens: 10 }), LOCAL)
    expect(useAgentNodes.getState().byId['tool-1']).toMatchObject({ state: 'done', tokens: 10 })
    applyAgentEvent(status, useAgentNodes, ev({ state: 'working', newTurn: true }), LOCAL)
    // The new turn dropped the finished card (and only finished ones).
    expect(useAgentNodes.getState().byId['tool-1']).toBeUndefined()
    expect(applyAgentEvent(status, useAgentNodes, ev({ state: 'done' }), LOCAL).alert).toEqual({
      kind: 'finished',
      quiet: false
    })
  })

  it('a /loop prompt sets the loop and a done bumps it', () => {
    applyAgentEvent(status, useAgentNodes, ev({ state: 'working', newTurn: true, task: '/loop watch CI' }), LOCAL)
    expect(entry().loop).toMatchObject({ kind: 'loop', count: 0, task: '/loop watch CI' })
    applyAgentEvent(status, useAgentNodes, ev({ state: 'done', lastMessage: 'iteration one' }), LOCAL)
    expect(entry().loop).toMatchObject({ kind: 'loop', count: 1, items: ['iteration one'] })
  })

  it('session start clears hibernated, paused and sessionEnded; session end sets sessionEnded', () => {
    const s = status.getState()
    s.setState(N, 'done', 'claude')
    s.setHibernated(N, true)
    s.setPaused(N, true)
    s.setSessionEnded(N, true)
    expect(entry()).toMatchObject({ hibernated: true, paused: true, sessionEnded: true })

    const start = applyAgentEvent(status, useAgentNodes, ev({ kind: 'session', sessionPhase: 'start', sessionTitle: 'fix the build' }), LOCAL)
    expect(start.alert).toBeNull()
    expect(entry().state).toBeUndefined()
    expect(entry().session).toBe('fix the build')
    expect(entry().hibernated).toBeFalsy()
    expect(entry().paused).toBeFalsy()
    expect(entry().sessionEnded).toBeFalsy()

    applyAgentEvent(status, useAgentNodes, ev({ state: 'working', newTurn: true }), LOCAL)
    const end = applyAgentEvent(status, useAgentNodes, ev({ kind: 'session', sessionPhase: 'end' }), LOCAL)
    expect(end.alert).toBeNull()
    expect(entry().state).toBeUndefined()
    expect(entry().sessionEnded).toBe(true)
  })

  it('a session end clears an in-session loop but keeps a cron card', () => {
    const C = 'term-node-cron'
    applyAgentEvent(status, useAgentNodes, ev({ kind: 'recurring', recurringKind: 'loop', task: 'poll' }), LOCAL)
    applyAgentEvent(
      status,
      useAgentNodes,
      ev({ nodeId: C, kind: 'recurring', recurringKind: 'cron', schedule: '*/5 * * * *', task: 'report' }),
      LOCAL
    )
    useAgentNodes.getState().setPosition(`loop-${N}`, { x: 10, y: 20 })
    useAgentNodes.getState().setPosition(`loop-${C}`, { x: 30, y: 40 })
    // A subagent card of the ending session goes with it, finished or not.
    applyAgentEvent(status, useAgentNodes, ev({ kind: 'subagent-start', toolUseId: 'tool-9' }), LOCAL)

    applyAgentEvent(status, useAgentNodes, ev({ kind: 'session', sessionPhase: 'end' }), LOCAL)
    applyAgentEvent(status, useAgentNodes, ev({ nodeId: C, kind: 'session', sessionPhase: 'end' }), LOCAL)

    expect(entry().loop).toBeUndefined()
    expect(useAgentNodes.getState().positions[`loop-${N}`]).toBeUndefined()
    expect(useAgentNodes.getState().byId['tool-9']).toBeUndefined()
    expect(entry(C).loop).toMatchObject({ kind: 'cron', schedule: '*/5 * * * *', task: 'report' })
    expect(useAgentNodes.getState().positions[`loop-${C}`]).toEqual({ x: 30, y: 40 })
  })

  it('with nodes = null, subagent events change nothing and do not throw', () => {
    // A card on the DEFAULT store proves a null `nodes` reads it no more than it writes it.
    useAgentNodes.getState().start('tool-local', { parentNodeId: N, type: 'Explore' })
    const cards = useAgentNodes.getState().byId
    const before = status.getState().byId
    expect(() => {
      applyAgentEvent(status, null, ev({ kind: 'subagent-start', toolUseId: 'tool-1', taskLabel: 'scan' }), LOCAL)
      applyAgentEvent(status, null, ev({ kind: 'subagent-end', toolUseId: 'tool-local', tokens: 3 }), LOCAL)
    }).not.toThrow()
    expect(status.getState().byId).toBe(before)
    expect(useAgentNodes.getState().byId).toBe(cards)

    // The turn and session paths that clear cards skip them too, and a done is never quiet.
    expect(() => {
      applyAgentEvent(status, null, ev({ state: 'working', newTurn: true, task: '/loop poll' }), LOCAL)
    }).not.toThrow()
    expect(applyAgentEvent(status, null, ev({ state: 'done' }), LOCAL).alert).toEqual({
      kind: 'finished',
      quiet: false
    })
    expect(() => {
      applyAgentEvent(status, null, ev({ kind: 'recurring', recurringEnd: true }), LOCAL)
      applyAgentEvent(status, null, ev({ kind: 'session', sessionPhase: 'end' }), LOCAL)
    }).not.toThrow()
    expect(useAgentNodes.getState().byId).toBe(cards)
    expect(entry().sessionEnded).toBe(true)
  })

  it('setAccount carries opts.observationRemote', () => {
    const account = { configDir: '/home/u/.claude-2', accountId: 'acct-2', known: true }
    applyAgentEvent(status, useAgentNodes, ev({ state: 'working', newTurn: true, account }), {
      observationRemote: true
    })
    expect(entry().account?.remote).toBe(true)
    expect(entry().account?.configDir).toBe('/home/u/.claude-2')
    applyAgentEvent(status, useAgentNodes, ev({ nodeId: 'term-node-b', state: 'working', newTurn: true, account }), LOCAL)
    expect(entry('term-node-b').account?.remote).toBe(false)
  })
})
