import { describe, it, expect } from 'vitest'
import {
  needsYouQueue,
  nextNeedingYou,
  noAgentWaitingNotice,
  waitingBeforeRestart,
  type NeedsYouProject
} from './nextNeedingYou'
import type { AgentNodeStatus } from '../state/agentStatus'
import type { AgentStatusLookup } from '../session/agent-status-lookup'

// The queue reads status per PROJECT (`buildStatusList`'s lookup). These cases have one store, so
// a map that ignores the project stands in.
const lookupFromMap =
  (byId: Record<string, AgentNodeStatus>): AgentStatusLookup =>
  (_projectId, nodeId) =>
    byId[nodeId]

const node = (id: string, title = id) => ({ id, kind: 'terminal' as const, title, color: '#888' })

const projects = (): NeedsYouProject[] => [
  { id: 'p1', name: 'Alpha', color: '#111', nodes: [node('a1'), node('a2'), node('a3')] },
  { id: 'p2', name: 'Beta', color: '#222', nodes: [node('b1'), node('b2')] },
  { id: 'p3', name: 'Gamma', color: '#333', nodes: [node('c1')] }
]

const st = (state: AgentNodeStatus['state'], at?: number, unread = false): AgentNodeStatus => ({
  unread,
  state,
  lastEventAt: at
})

describe('needsYouQueue', () => {
  it('lists waiting AND blocked agents across projects, oldest wait first', () => {
    const status: Record<string, AgentNodeStatus> = {
      a1: st('waiting', 300),
      a2: st('working', 50),
      b1: st('blocked', 100),
      b2: st('done', 10, true),
      c1: st('waiting', 200)
    }
    // Working, done and unread rows are not "needing you"; the active project is irrelevant to order.
    expect(needsYouQueue(projects(), null, 'p1', lookupFromMap(status))).toEqual(['b1', 'c1', 'a1'])
    expect(needsYouQueue(projects(), null, 'p3', lookupFromMap(status))).toEqual(['b1', 'c1', 'a1'])
  })

  it('breaks clock ties by project store order, then title, deterministically', () => {
    const ps = projects()
    ps[0].nodes = [node('a1', 'zeta'), node('a2', 'Alpha')]
    const status = { a1: st('waiting', 100), a2: st('waiting', 100), b1: st('waiting', 100) }
    expect(needsYouQueue(ps, null, 'p1', lookupFromMap(status))).toEqual(['a2', 'a1', 'b1'])
  })

  it('sorts a row with no clock last instead of first', () => {
    const status = { a1: st('waiting'), b1: st('waiting', 999) }
    expect(needsYouQueue(projects(), null, 'p1', lookupFromMap(status))).toEqual(['b1', 'a1'])
  })

  it('matches the sidebar: closed projects are out, an unavailable one cannot be travelled to', () => {
    const ps = projects()
    ps[1].closed = true
    ps[2].unavailable = true
    const status = { a1: st('waiting', 3), b1: st('waiting', 1), c1: st('waiting', 2) }
    expect(needsYouQueue(ps, null, 'p1', lookupFromMap(status))).toEqual(['a1'])
  })

  it('counts a live active-project node that is not committed to the store yet', () => {
    const live = [...projects()[0].nodes, node('fresh')]
    const status = { fresh: st('blocked', 5), b1: st('waiting', 9) }
    expect(needsYouQueue(projects(), live, 'p1', lookupFromMap(status))).toEqual(['fresh', 'b1'])
  })

  it('is empty when nothing needs the user', () => {
    expect(needsYouQueue(projects(), null, 'p1', lookupFromMap({ a1: st('working', 1) }))).toEqual([])
  })
})

describe('nextNeedingYou', () => {
  const q = ['x', 'y', 'z']

  it('starts at the oldest, then walks the queue and wraps', () => {
    expect(nextNeedingYou(q, null, null)).toBe('x')
    expect(nextNeedingYou(q, 'x', null)).toBe('y')
    expect(nextNeedingYou(q, 'y', null)).toBe('z')
    expect(nextNeedingYou(q, 'z', null)).toBe('x')
  })

  it('restarts at the oldest still waiting when the last stop was answered', () => {
    expect(nextNeedingYou(['y', 'z'], 'x', null)).toBe('y')
  })

  it('skips the node the user is already in, unless it is the only one', () => {
    expect(nextNeedingYou(q, null, 'x')).toBe('y')
    expect(nextNeedingYou(q, 'y', 'z')).toBe('x')
    expect(nextNeedingYou(['x'], null, 'x')).toBe('x')
  })

  it('is null on an empty queue', () => {
    expect(nextNeedingYou([], 'x', 'x')).toBeNull()
  })
})

describe('after a restart: agents last seen waiting, with nothing reported since', () => {
  // Live state is transient: right after a relaunch every agent reads unknown, and one already
  // sitting at a prompt sends no new hook. Only the persisted `lastSeen` clock comes back.
  const restored = (state: AgentNodeStatus['state']): AgentNodeStatus => ({
    unread: false,
    lastSeen: { at: 1000, state, restored: true }
  })

  it('counts the restored waiting/blocked clocks, not the queue', () => {
    const status: Record<string, AgentNodeStatus> = {
      a1: restored('waiting'),
      a2: restored('blocked'),
      a3: restored('done'),
      b1: restored('working'),
      c1: restored('waiting')
    }
    expect(needsYouQueue(projects(), null, 'p1', lookupFromMap(status))).toEqual([])
    expect(waitingBeforeRestart(projects(), null, 'p1', lookupFromMap(status))).toBe(3)
  })

  it('a clock from THIS run, a live state, or a closed project does not count', () => {
    const ps = projects()
    ps[2].closed = true
    const status: Record<string, AgentNodeStatus> = {
      a1: { unread: false, lastSeen: { at: 5, state: 'waiting' } }, // seen this run, not restored
      a2: { ...restored('waiting'), state: 'working', lastEventAt: 9 }, // it reported since
      c1: restored('waiting') // its project is closed, like the queue's membership
    }
    expect(waitingBeforeRestart(ps, null, 'p1', lookupFromMap(status))).toBe(0)
  })

  it('says why the queue is empty instead of "no agent is waiting"', () => {
    expect(noAgentWaitingNotice(0)).toBe('No agent is waiting for you.')
    expect(noAgentWaitingNotice(1)).toBe(
      'No agent has reported waiting since the restart (1 was waiting before it).'
    )
    expect(noAgentWaitingNotice(4)).toBe(
      'No agent has reported waiting since the restart (4 were waiting before it).'
    )
  })
})
