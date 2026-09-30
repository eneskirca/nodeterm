import { describe, it, expect, vi } from 'vitest'
import {
  OUTCOME_CLEARING_VERBS,
  STATION_OUTCOME_MAX_RECORDS,
  StationOutcomeStore,
  clearOutcomesAfterControl,
  handleReportOutcome,
  registerStationOutcomeIpc,
  type ReportOutcomeDeps
} from './station-outcome-store'
import { REPORT_OUTCOME_CONTROL_REFUSAL } from '../shared/station-outcome'
import { IPC } from '../shared/ipc'
import type { BoardLogEntry } from '../shared/types'

function deps(over: Partial<ReportOutcomeDeps> = {}): ReportOutcomeDeps & { log: BoardLogEntry[] } {
  const log: BoardLogEntry[] = []
  return {
    store: new StationOutcomeStore(),
    now: () => 1_000,
    projectIdOfNode: () => 'p1',
    appendBoardLog: async (_projectId, entry) => {
      log.push(entry)
      return true
    },
    newId: () => 'log-1',
    log,
    ...over
  }
}

describe('handleReportOutcome', () => {
  it('records the caller’s OWN outcome, logs it on its own card and tells it what that releases', async () => {
    const d = deps()
    const onRecorded = vi.fn()
    d.onRecorded = onRecorded
    const r = await handleReportOutcome(
      { nodeId: 'st1', args: { outcome: 'succeeded', note: 'tests\npass' }, verified: true },
      d
    )
    expect(r.ok).toBe(true)
    expect(r.message).toContain('recorded: your task succeeded — "tests pass"')
    expect(r.message).toContain('--after-success')
    expect(r.message).toContain('A new turn does not change it')
    expect(d.store.get('st1')).toEqual({ nodeId: 'st1', outcome: 'succeeded', note: 'tests pass', at: 1_000 })
    expect(d.log).toEqual([
      {
        id: 'log-1',
        ts: 1_000,
        author: { name: 'nodeterm', color: '#8b8b8b' },
        nodeId: 'st1',
        kind: 'event',
        event: { type: 'station-reported', from: 'st1', to: 'succeeded', title: 'tests pass' }
      }
    ])
    expect(onRecorded).toHaveBeenCalledWith(d.store.get('st1'))
  })

  it('refuses an unverified caller and records nothing — a forgeable success is not evidence', async () => {
    const d = deps()
    const r = await handleReportOutcome({ nodeId: 'st1', args: { outcome: 'succeeded' }, verified: false }, d)
    expect(r).toEqual({ ok: false, error: REPORT_OUTCOME_CONTROL_REFUSAL, message: REPORT_OUTCOME_CONTROL_REFUSAL })
    expect(d.store.list()).toEqual([])
    expect(d.log).toEqual([])
  })

  it('refuses a report about ANOTHER node and records nothing, for either node', async () => {
    const d = deps()
    const r = await handleReportOutcome(
      { nodeId: 'orchestrator', args: { outcome: 'succeeded', node: 'st1' }, verified: true },
      d
    )
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/^report-outcome-not-self:/)
    expect(d.store.get('st1')).toBeUndefined()
    expect(d.store.get('orchestrator')).toBeUndefined()
    expect(d.log).toEqual([])
  })

  it('a node that is in no saved project is still recorded — the wait reads the store, not the log', async () => {
    const d = deps({ projectIdOfNode: () => undefined })
    const r = await handleReportOutcome({ nodeId: 'st1', args: { outcome: 'failed' }, verified: true }, d)
    expect(r.ok).toBe(true)
    expect(d.store.get('st1')?.outcome).toBe('failed')
    expect(d.log).toEqual([])
    expect(r.result).toMatchObject({ boardLog: false })
  })

  it('a board log that cannot be written does not fail the report', async () => {
    const d = deps({ appendBoardLog: async () => Promise.reject(new Error('disk full')) })
    const r = await handleReportOutcome({ nodeId: 'st1', args: { outcome: 'failed' }, verified: true }, d)
    expect(r.ok).toBe(true)
    expect(d.store.get('st1')?.outcome).toBe('failed')
  })

  it('a later report supersedes the earlier one', async () => {
    const d = deps()
    await handleReportOutcome({ nodeId: 'st1', args: { outcome: 'failed' }, verified: true }, d)
    await handleReportOutcome({ nodeId: 'st1', args: { outcome: 'succeeded' }, verified: true }, d)
    expect(d.store.get('st1')?.outcome).toBe('succeeded')
    expect(d.store.list()).toHaveLength(1)
  })
})

describe('StationOutcomeStore', () => {
  it('publishes the WHOLE list, newest first, on every change', () => {
    const publish = vi.fn()
    const s = new StationOutcomeStore(publish)
    s.record({ nodeId: 'a', outcome: 'failed', at: 1 })
    s.record({ nodeId: 'b', outcome: 'succeeded', at: 2 })
    expect(publish).toHaveBeenLastCalledWith([
      { nodeId: 'b', outcome: 'succeeded', at: 2 },
      { nodeId: 'a', outcome: 'failed', at: 1 }
    ])
    expect(s.clear('a')).toBe(true)
    expect(publish).toHaveBeenLastCalledWith([{ nodeId: 'b', outcome: 'succeeded', at: 2 }])
    // Clearing nothing publishes nothing.
    const calls = publish.mock.calls.length
    expect(s.clear('zzz')).toBe(false)
    expect(publish.mock.calls.length).toBe(calls)
  })

  it('is bounded, evicting the oldest first', () => {
    const s = new StationOutcomeStore()
    for (let i = 0; i < STATION_OUTCOME_MAX_RECORDS + 3; i++) {
      s.record({ nodeId: `n${i}`, outcome: 'succeeded', at: i })
    }
    expect(s.list()).toHaveLength(STATION_OUTCOME_MAX_RECORDS)
    expect(s.get('n0')).toBeUndefined()
    expect(s.get('n2')).toBeUndefined()
    expect(s.get('n3')).toBeDefined()
  })

  it('serves the read channel from the store the thunk returns', async () => {
    const handlers = new Map<string, (...a: unknown[]) => unknown>()
    const s = new StationOutcomeStore()
    s.record({ nodeId: 'a', outcome: 'succeeded', at: 1 })
    let current: StationOutcomeStore | null = null
    registerStationOutcomeIpc({ handle: (ch, fn) => handlers.set(ch, fn) }, () => current)
    expect(handlers.get(IPC.stationOutcomeList)?.()).toEqual([])
    current = s
    expect(handlers.get(IPC.stationOutcomeList)?.()).toEqual([{ nodeId: 'a', outcome: 'succeeded', at: 1 }])
  })
})

describe('clearOutcomesAfterControl — a write / run landing in a station withdraws its OLDER report', () => {
  const seeded = () => {
    const s = new StationOutcomeStore()
    s.record({ nodeId: 'st1', outcome: 'succeeded', at: 1 })
    s.record({ nodeId: 'st2', outcome: 'succeeded', at: 2 })
    return s
  }

  it.each(['write', 'run'])('a successful %s aimed at a station withdraws a report made before its answer', (verb) => {
    const s = seeded()
    clearOutcomesAfterControl(s, verb, { node: 'st1', text: 'next task' }, { ok: true }, 'orch', 10)
    expect(s.get('st1')).toBeUndefined()
    expect(s.get('st2')).toBeDefined()
  })

  it('a report made after the answer (about the new work) stands', () => {
    const s = seeded()
    clearOutcomesAfterControl(s, 'write', { node: 'st1' }, { ok: true }, 'orch', 1)
    expect(s.get('st1')).toBeDefined()
  })

  it('send / reply are NOT decided by their answer — a queued answer comes back before the pane gets it', () => {
    const s = seeded()
    for (const verb of ['send', 'reply']) clearOutcomesAfterControl(s, verb, { node: 'st1' }, { ok: true }, 'orch', 10)
    expect(s.get('st1')).toBeDefined()
    expect([...OUTCOME_CLEARING_VERBS].sort()).toEqual(['run', 'write'])
  })

  it('a refused request handed nothing, and other verbs hand no work', () => {
    const s = seeded()
    clearOutcomesAfterControl(s, 'write', { node: 'st1' }, { ok: false }, 'orch', 10)
    for (const verb of ['notify', 'rename', 'list', 'close', 'color', 'assign']) {
      clearOutcomesAfterControl(s, verb, { node: 'st1' }, { ok: true }, 'orch', 10)
    }
    expect(s.get('st1')).toBeDefined()
  })

  it('a node writing into its OWN pane is not handed work by anyone', () => {
    const s = seeded()
    clearOutcomesAfterControl(s, 'write', { node: 'st1' }, { ok: true }, 'st1', 10)
    expect(s.get('st1')).toBeDefined()
  })

  it('reads a comma list, and ignores an id it would not vouch for', () => {
    const s = seeded()
    clearOutcomesAfterControl(s, 'run', { node: 'st1, st2, ../x' }, { ok: true }, 'orch', 10)
    expect(s.list()).toEqual([])
  })
})

describe('StationOutcomeStore.onHandover — decided by when the work reaches the pane', () => {
  it('queued → every report stops counting (workPending), including one made after', () => {
    const publish = vi.fn()
    const s = new StationOutcomeStore(publish)
    s.record({ nodeId: 'st', outcome: 'succeeded', at: 5 })
    s.onHandover({ phase: 'queued', verb: 'send', targetNodeId: 'st' })
    expect(s.get('st')).toEqual({ nodeId: 'st', outcome: 'succeeded', at: 5, workPending: true })
    s.record({ nodeId: 'st', outcome: 'succeeded', at: 7 })
    expect(s.list()).toEqual([{ nodeId: 'st', outcome: 'succeeded', at: 7, workPending: true }])
    expect(publish).toHaveBeenLastCalledWith([{ nodeId: 'st', outcome: 'succeeded', at: 7, workPending: true }])
  })

  it('landed withdraws only reports older than when the delivery started; settled drops the mark', () => {
    const s = new StationOutcomeStore()
    s.onHandover({ phase: 'queued', verb: 'reply', targetNodeId: 'st' })
    s.record({ nodeId: 'st', outcome: 'succeeded', at: 5 })
    s.onHandover({ phase: 'landed', verb: 'reply', targetNodeId: 'st', at: 10 })
    expect(s.get('st')).toBeUndefined()
    s.onHandover({ phase: 'settled', verb: 'reply', targetNodeId: 'st', landed: true })
    s.record({ nodeId: 'st', outcome: 'failed', at: 12 })
    expect(s.get('st')).toEqual({ nodeId: 'st', outcome: 'failed', at: 12 })
    // A later landing whose delivery started BEFORE that report leaves it alone.
    s.onHandover({ phase: 'landed', verb: 'send', targetNodeId: 'st', at: 11 })
    expect(s.get('st')?.outcome).toBe('failed')
  })

  it('two queued messages keep the mark until BOTH have settled', () => {
    const s = new StationOutcomeStore()
    s.onHandover({ phase: 'queued', verb: 'send', targetNodeId: 'st' })
    s.onHandover({ phase: 'queued', verb: 'send', targetNodeId: 'st' })
    s.onHandover({ phase: 'landed', verb: 'send', targetNodeId: 'st', at: 1 })
    s.onHandover({ phase: 'settled', verb: 'send', targetNodeId: 'st', landed: true })
    s.record({ nodeId: 'st', outcome: 'succeeded', at: 2 })
    expect(s.get('st')?.workPending).toBe(true)
    s.onHandover({ phase: 'landed', verb: 'send', targetNodeId: 'st', at: 3 })
    s.onHandover({ phase: 'settled', verb: 'send', targetNodeId: 'st', landed: true })
    expect(s.get('st')).toBeUndefined()
    s.record({ nodeId: 'st', outcome: 'succeeded', at: 4 })
    expect(s.get('st')?.workPending).toBeUndefined()
  })

  it('a queued entry that ends without landing withdraws the report and drops the mark', () => {
    const s = new StationOutcomeStore()
    s.onHandover({ phase: 'queued', verb: 'send', targetNodeId: 'st' })
    s.record({ nodeId: 'st', outcome: 'succeeded', at: 5 })
    s.onHandover({ phase: 'settled', verb: 'send', targetNodeId: 'st', landed: false })
    expect(s.get('st')).toBeUndefined()
    s.record({ nodeId: 'st', outcome: 'succeeded', at: 6 })
    expect(s.get('st')?.workPending).toBeUndefined()
  })

  it('only send / reply count — a board comment, a station notice or notify hand no task', () => {
    const s = new StationOutcomeStore()
    s.record({ nodeId: 'st', outcome: 'succeeded', at: 1 })
    for (const verb of ['board-comment', 'station-notice', 'notify']) {
      s.onHandover({ phase: 'queued', verb, targetNodeId: 'st' })
      s.onHandover({ phase: 'landed', verb, targetNodeId: 'st', at: 10 })
      s.onHandover({ phase: 'settled', verb, targetNodeId: 'st', landed: false })
    }
    expect(s.get('st')).toEqual({ nodeId: 'st', outcome: 'succeeded', at: 1 })
  })
})
