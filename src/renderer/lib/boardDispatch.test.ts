import { describe, expect, it } from 'vitest'
import { dispatchBinding, sanitizeBoardDispatch } from '@shared/board-dispatch'
import {
  DISPATCH_STARTUP_GRACE_MS,
  decideDispatch,
  dispatchableAgent,
  moveWithdrawsDispatch,
  recheckQueued,
  type RecheckInput,
  occupiesSlot,
  queueToDrop,
  queueToStart,
  type DispatchContext,
  type DispatchQueueEntry,
  type DispatchTrigger
} from './boardDispatch'

const BINDING = dispatchBinding('acme/app', 'Agent', 'status:agent')!
const dispatch = sanitizeBoardDispatch({
  projects: { p1: { columnId: 'agent-col', agentId: 'claude', maxConcurrent: 2, binding: BINDING } }
})

function trigger(over: Partial<DispatchTrigger> = {}): DispatchTrigger {
  return {
    origin: 'user-move',
    projectId: 'p1',
    toColumnId: 'agent-col',
    moveStatus: 'confirmed',
    issue: { number: 7, htmlUrl: 'https://github.com/acme/app/issues/7', state: 'open' },
    ...over
  }
}

function ctx(over: Partial<DispatchContext> = {}): DispatchContext {
  return {
    dispatch,
    project: { remote: false, relay: false },
    completionColumnId: 'done',
    bindingNow: BINDING,
    agentDispatchable: true,
    boundRuns: 0,
    queuedOrStarting: false,
    occupying: 0,
    ...over
  }
}

describe('decideDispatch — who may trigger a run', () => {
  it('a confirmed move by this person into the dispatch column starts a run bound to the issue', () => {
    const d = decideDispatch(trigger(), ctx())
    expect(d).toEqual({
      kind: 'start',
      ref: { owner: 'acme', repo: 'app', number: 7 },
      key: 'acme/app#7'
    })
  })

  it('a card that arrives in the column any other way (refresh after a GitHub label change, a pulled board) starts nothing', () => {
    expect(decideDispatch(trigger({ origin: 'sync' }), ctx())).toEqual({ kind: 'ignore' })
  })

  it('a project that is not switched on on THIS machine starts nothing (opt-out)', () => {
    expect(decideDispatch(trigger({ projectId: 'p2' }), ctx())).toEqual({ kind: 'ignore' })
    expect(decideDispatch(trigger(), ctx({ dispatch: sanitizeBoardDispatch(undefined) }))).toEqual({ kind: 'ignore' })
  })

  it('a move into another column, or to Ungrouped, is not a dispatch', () => {
    expect(decideDispatch(trigger({ toColumnId: 'other' }), ctx())).toEqual({ kind: 'ignore' })
    expect(decideDispatch(trigger({ toColumnId: null }), ctx())).toEqual({ kind: 'ignore' })
  })

  it('a move GitHub did not confirm is not a dispatch', () => {
    for (const moveStatus of ['stale', 'failed', 'read-only', 'invalid-target', 'configuration-changed']) {
      expect(decideDispatch(trigger({ moveStatus }), ctx())).toEqual({ kind: 'ignore' })
    }
    expect(decideDispatch(trigger({ moveStatus: 'refresh-pending' }), ctx()).kind).toBe('start')
  })

  it('the kill switch refuses, and says so', () => {
    const paused = sanitizeBoardDispatch({ paused: true, projects: { p1: { columnId: 'agent-col', agentId: 'claude', binding: BINDING } } })
    expect(decideDispatch(trigger(), ctx({ dispatch: paused }))).toEqual({ kind: 'refuse', reason: 'paused' })
  })

  it('refuses a relay tab, an SSH project, a closed issue, an unreadable address and a missing agent', () => {
    expect(decideDispatch(trigger(), ctx({ project: { remote: false, relay: true } }))).toMatchObject({ reason: 'relay' })
    expect(decideDispatch(trigger(), ctx({ project: undefined }))).toMatchObject({ reason: 'project-gone' })
    expect(decideDispatch(trigger(), ctx({ project: { remote: true, relay: false } }))).toMatchObject({ reason: 'remote-project' })
    expect(decideDispatch(trigger({ issue: { number: 7, htmlUrl: 'https://github.com/acme/app/issues/7', state: 'closed' } }), ctx()))
      .toMatchObject({ reason: 'issue-closed' })
    expect(decideDispatch(trigger({ issue: { number: 7, htmlUrl: 'https://evil.example/acme/app/issues/7', state: 'open' } }), ctx()))
      .toMatchObject({ reason: 'no-reference' })
    expect(decideDispatch(trigger({ issue: { number: 8, htmlUrl: 'https://github.com/acme/app/issues/7', state: 'open' } }), ctx()))
      .toMatchObject({ reason: 'no-reference' })
    expect(decideDispatch(trigger(), ctx({ agentDispatchable: false }))).toMatchObject({ reason: 'agent-unavailable' })
  })

  it('refuses a dispatch column that is also the completion column', () => {
    expect(decideDispatch(trigger(), ctx({ completionColumnId: 'agent-col' }))).toMatchObject({ reason: 'completion-column' })
  })

  it('one run per issue: a second trigger for the same issue starts nothing', () => {
    expect(decideDispatch(trigger(), ctx({ boundRuns: 1 }))).toMatchObject({ kind: 'refuse', reason: 'already-running' })
    expect(decideDispatch(trigger(), ctx({ queuedOrStarting: true }))).toMatchObject({ kind: 'refuse', reason: 'already-queued' })
  })

  it('respects the per-project cap: a full project queues instead of starting', () => {
    expect(decideDispatch(trigger(), ctx({ occupying: 1 })).kind).toBe('start')
    expect(decideDispatch(trigger(), ctx({ occupying: 2 })).kind).toBe('queue')
    expect(decideDispatch(trigger(), ctx({ occupying: 5 })).kind).toBe('queue')
  })
})

describe('occupiesSlot', () => {
  const now = 1_000_000
  it('working, waiting, blocked and a held launch hold a slot; an idle turn does not', () => {
    expect(occupiesSlot({ state: 'working', pending: false }, now)).toBe(true)
    expect(occupiesSlot({ state: 'waiting', pending: false }, now)).toBe(true)
    expect(occupiesSlot({ state: 'blocked', pending: false }, now)).toBe(true)
    expect(occupiesSlot({ pending: true }, now)).toBe(true)
    expect(occupiesSlot({ state: 'done', pending: false, startedAt: now }, now)).toBe(false)
  })
  it('an unknown state holds a slot only while it is a run this app just started', () => {
    expect(occupiesSlot({ pending: false }, now)).toBe(false)
    expect(occupiesSlot({ pending: false, startedAt: now - 1000 }, now)).toBe(true)
    expect(occupiesSlot({ pending: false, startedAt: now - DISPATCH_STARTUP_GRACE_MS }, now)).toBe(false)
  })
})

describe('queue', () => {
  const two = sanitizeBoardDispatch({
    projects: {
      p1: { columnId: 'c', agentId: 'claude', maxConcurrent: 2, binding: 'b' },
      p2: { columnId: 'c', agentId: 'claude', maxConcurrent: 1, binding: 'b' }
    }
  })
  const entry = (key: string, projectId: string, queuedAt: number): DispatchQueueEntry => ({
    key,
    projectId,
    ref: { owner: 'a', repo: 'b', number: queuedAt },
    number: queuedAt,
    queuedAt
  })
  const queue = [entry('x3', 'p1', 3), entry('x1', 'p1', 1), entry('x2', 'p1', 2), entry('y1', 'p2', 1), entry('y2', 'p2', 2)]

  it('starts oldest first, never past each project\'s free slots', () => {
    const occ = new Map([['p1', 1], ['p2', 0]])
    expect(queueToStart(queue, two, (p) => occ.get(p) ?? 0).map((e) => e.key)).toEqual(['x1', 'y1'])
    expect(queueToStart(queue, two, () => 0).map((e) => e.key)).toEqual(['x1', 'y1', 'x2'])
    expect(queueToStart(queue, two, () => 9)).toEqual([])
  })

  it('an entry that may not start now (the browser, off screen) is skipped and takes no slot', () => {
    expect(queueToStart(queue, two, () => 0, (e) => e.projectId === 'p2').map((e) => e.key)).toEqual(['y1'])
  })

  it('the kill switch starts nothing and drops everything; an opted-out project is dropped', () => {
    const paused = { ...two, paused: true }
    expect(queueToStart(queue, paused, () => 0)).toEqual([])
    expect(queueToDrop(queue, paused)).toHaveLength(queue.length)
    const onlyP1 = sanitizeBoardDispatch({ projects: { p1: { columnId: 'c', agentId: 'claude', binding: 'b' } } })
    expect(queueToStart(queue, onlyP1, () => 0).every((e) => e.projectId === 'p1')).toBe(true)
    expect(queueToDrop(queue, onlyP1).map((e) => e.key).sort()).toEqual(['y1', 'y2'])
  })
})

describe('moveWithdrawsDispatch', () => {
  it('a landed move out of the dispatch column withdraws a queued dispatch; nothing else does', () => {
    expect(moveWithdrawsDispatch(trigger({ toColumnId: 'other' }), dispatch)).toBe(true)
    expect(moveWithdrawsDispatch(trigger({ toColumnId: null }), dispatch)).toBe(true)
    expect(moveWithdrawsDispatch(trigger(), dispatch)).toBe(false)
    expect(moveWithdrawsDispatch(trigger({ toColumnId: 'other', moveStatus: 'failed' }), dispatch)).toBe(false)
    expect(moveWithdrawsDispatch(trigger({ toColumnId: 'other', origin: 'sync' }), dispatch)).toBe(false)
    expect(moveWithdrawsDispatch(trigger({ toColumnId: 'other', projectId: 'p9' }), dispatch)).toBe(false)
  })
})

describe('consent binding — what the column MEANS is git-shared', () => {
  it('a pulled commit that swaps column titles turns a routine drag into nothing, not a dispatch', () => {
    // The person consented to the column titled "Agent" with label status:agent. After the pull,
    // the same column id is titled "In Progress".
    const swapped = dispatchBinding('acme/app', 'In Progress', 'status:agent')
    expect(decideDispatch(trigger(), ctx({ bindingNow: swapped }))).toEqual({ kind: 'refuse', reason: 'consent-stale' })
    const relabelled = dispatchBinding('acme/app', 'Agent', 'status:in-progress')
    expect(decideDispatch(trigger(), ctx({ bindingNow: relabelled }))).toMatchObject({ reason: 'consent-stale' })
  })

  it('a board re-pointed at another repository refuses until re-confirmed', () => {
    const other = dispatchBinding('someone/else', 'Agent', 'status:agent')
    expect(decideDispatch(trigger(), ctx({ bindingNow: other }))).toMatchObject({ reason: 'consent-stale' })
    expect(decideDispatch(trigger(), ctx({ bindingNow: undefined }))).toMatchObject({ reason: 'consent-stale' })
    // Repository case does not matter (GitHub names are case-insensitive).
    expect(decideDispatch(trigger(), ctx({ bindingNow: dispatchBinding('ACME/App', 'Agent', 'status:agent') })).kind).toBe('start')
  })
})

describe('dispatchableAgent', () => {
  it('only an agent that exists AND reports status through hooks (a hookless one would break the cap)', () => {
    expect(dispatchableAgent('claude', true)).toBe(true)
    expect(dispatchableAgent('claude', false)).toBe(false)
    expect(dispatchableAgent('custom:no-base-agent', true)).toBe(false)
  })
})

describe('recheckQueued — a queued dispatch is re-asked before it starts', () => {
  const config = dispatch.projects.p1
  const ok: RecheckInput = {
    config,
    paused: false,
    project: { remote: false, relay: false, closed: false },
    bindingNow: BINDING,
    agentDispatchable: true,
    card: { kind: 'found', state: 'open', columnId: 'agent-col' }
  }
  it('starts only when everything still holds', () => {
    expect(recheckQueued(ok)).toEqual({ kind: 'start' })
  })
  it('a teammate closing or moving the issue while it waited drops it', () => {
    expect(recheckQueued({ ...ok, card: { kind: 'found', state: 'closed', columnId: 'agent-col' } }))
      .toEqual({ kind: 'drop', reason: 'issue-closed' })
    expect(recheckQueued({ ...ok, card: { kind: 'found', state: 'open', columnId: 'other' } }))
      .toEqual({ kind: 'drop', reason: 'not-in-column' })
    expect(recheckQueued({ ...ok, card: { kind: 'absent' } })).toEqual({ kind: 'drop', reason: 'not-in-column' })
  })
  it('an unreadable card waits — a failed read is never evidence', () => {
    expect(recheckQueued({ ...ok, card: { kind: 'unreadable' } })).toEqual({ kind: 'wait' })
  })
  it('consent, agent, project and the kill switch are re-asked too', () => {
    expect(recheckQueued({ ...ok, paused: true })).toMatchObject({ reason: 'paused' })
    expect(recheckQueued({ ...ok, config: undefined })).toMatchObject({ reason: 'switched-off' })
    expect(recheckQueued({ ...ok, bindingNow: 'x' })).toMatchObject({ reason: 'consent-stale' })
    expect(recheckQueued({ ...ok, agentDispatchable: false })).toMatchObject({ reason: 'agent-unavailable' })
    expect(recheckQueued({ ...ok, project: undefined })).toMatchObject({ reason: 'project-gone' })
    expect(recheckQueued({ ...ok, project: { remote: false, relay: false, closed: true } })).toMatchObject({ reason: 'project-closed' })
    expect(recheckQueued({ ...ok, project: { remote: true, relay: false, closed: false } })).toMatchObject({ reason: 'remote-project' })
  })
})
