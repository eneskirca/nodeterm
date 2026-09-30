import { describe, it, expect } from 'vitest'
import {
  OUTCOME_FACT,
  StationOutcomeStore,
  sameConversation,
  sanitizePersistedOutcome,
  type OutcomeBinding,
  type PersistedOutcome
} from './station-outcome-store'
import { DurableFactFile } from './durable-state'
import { testTmpDir } from './test-tmp'
import type { StationOutcomeRecord } from '../shared/station-outcome'

/**
 * Station reports across an app restart: a report comes back bound to the session that made it; a
 * node id that now runs a different session (or agent) does not inherit it.
 */

function memoryDisk() {
  let saved: PersistedOutcome[] = []
  return {
    durable: { load: () => JSON.parse(JSON.stringify(saved)).map(sanitizePersistedOutcome).filter(Boolean), save: (r: PersistedOutcome[]) => (saved = r) },
    saved: () => saved
  }
}

function store(disk: ReturnType<typeof memoryDisk>, sessions: Record<string, OutcomeBinding>) {
  const published: StationOutcomeRecord[][] = []
  const s = new StationOutcomeStore((r) => published.push(r), { durable: disk.durable, sessionOf: (id) => sessions[id] })
  return { s, published }
}

describe('station outcome reports across a restart', () => {
  it('a report comes back after a restart (write → new instance → read) and is published', () => {
    const disk = memoryDisk()
    const a = store(disk, { st1: { sessionId: 's-A', agentId: 'claude' } }).s
    a.record({ nodeId: 'st1', outcome: 'succeeded', at: 5, note: 'done' })
    expect(disk.saved()).toEqual([{ nodeId: 'st1', outcome: 'succeeded', at: 5, note: 'done', sessionId: 's-A', agentId: 'claude' }])

    const b = store(disk, { st1: { sessionId: 's-A', agentId: 'claude' } })
    expect(b.s.get('st1')).toBeUndefined() // nothing until loadFromDisk() — the mirror loads first
    b.s.loadFromDisk()
    expect(b.s.get('st1')).toEqual({ nodeId: 'st1', outcome: 'succeeded', at: 5, note: 'done' })
    expect(b.published.at(-1)).toHaveLength(1)
  })

  it('a node id that now belongs to a DIFFERENT session does not inherit the report', () => {
    const disk = memoryDisk()
    store(disk, { st1: { sessionId: 's-A' }, st2: { sessionId: 's-X', agentId: 'claude' } }).s.record({ nodeId: 'st1', outcome: 'succeeded', at: 1 })
    const b = store(disk, { st1: { sessionId: 's-B' } }).s
    b.loadFromDisk()
    expect(b.get('st1')).toBeUndefined()
    expect(disk.saved()).toEqual([]) // and the dropped report is gone from disk too
  })

  it('another agent under the same node id does not inherit it either; an unknown current session keeps it', () => {
    expect(sameConversation({ sessionId: 's', agentId: 'claude' }, { sessionId: 's', agentId: 'codex' })).toBe(false)
    expect(sameConversation({ sessionId: 's' }, undefined)).toBe(true)
    expect(sameConversation({}, { sessionId: 's' })).toBe(true)
  })

  it('a SessionStart naming a different session withdraws the report; the same session, a subagent or a non-start event does not', () => {
    const disk = memoryDisk()
    const s = store(disk, { st1: { sessionId: 's-A' } }).s
    s.record({ nodeId: 'st1', outcome: 'succeeded', at: 1 })
    s.onAgentEvent({ nodeId: 'st1', sessionPhase: 'start', sessionId: 's-A' })
    s.onAgentEvent({ nodeId: 'st1', sessionId: 's-B' })
    s.onAgentEvent({ nodeId: 'st1', sessionPhase: 'start', sessionId: 's-B', subagentType: 'explore' })
    expect(s.get('st1')).toBeDefined()
    s.onAgentEvent({ nodeId: 'st1', sessionPhase: 'start', sessionId: 's-B' })
    expect(s.get('st1')).toBeUndefined()
    expect(disk.saved()).toEqual([])
  })

  it('"work pending" is not stored — the restored queue replays it — and a lapsed message withdraws the report', () => {
    const disk = memoryDisk()
    const a = store(disk, {}).s
    a.record({ nodeId: 'st1', outcome: 'succeeded', at: 1 })
    a.onHandover({ phase: 'queued', verb: 'send', targetNodeId: 'st1' })
    expect(disk.saved()[0]).not.toHaveProperty('workPending')
    const b = store(disk, {}).s
    b.loadFromDisk()
    // The queue's restore replays `queued`, then settles the lapsed entry without landing.
    b.onHandover({ phase: 'queued', verb: 'send', targetNodeId: 'st1' })
    expect(b.get('st1')?.workPending).toBe(true)
    b.onHandover({ phase: 'settled', verb: 'send', targetNodeId: 'st1', landed: false })
    expect(b.get('st1')).toBeUndefined()
    expect(disk.saved()).toEqual([])
  })

  it('sanitizes hand-edited reports through the same rules as a live one', () => {
    expect(sanitizePersistedOutcome({ nodeId: 'st1', outcome: 'succeeded', at: 1 })).toBeTruthy()
    expect(sanitizePersistedOutcome({ nodeId: 'st1', outcome: 'maybe', at: 1 })).toBeNull()
    expect(sanitizePersistedOutcome({ nodeId: '../x', outcome: 'failed', at: 1 })).toBeNull()
    expect(sanitizePersistedOutcome({ nodeId: 'st1', outcome: 'failed', at: 1, sessionId: 7 })).toBeNull()
  })

  it('end to end through the file', async () => {
    const dir = testTmpDir('nt-outcome-')
    const f = new DurableFactFile(OUTCOME_FACT, { userDataDir: dir, debounceMs: 1 })
    const a = new StationOutcomeStore(() => {}, { durable: f, sessionOf: () => ({ sessionId: 's' }) })
    a.record({ nodeId: 'st1', outcome: 'failed', at: 3, note: 'tests red' })
    await f.flush()
    const b = new StationOutcomeStore(() => {}, {
      durable: new DurableFactFile(OUTCOME_FACT, { userDataDir: dir }),
      sessionOf: () => ({ sessionId: 's' })
    })
    b.loadFromDisk()
    expect(b.get('st1')).toEqual({ nodeId: 'st1', outcome: 'failed', at: 3, note: 'tests red' })
  })
})
