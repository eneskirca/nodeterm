import { describe, it, expect } from 'vitest'
import {
  HANDOVER_FACT,
  StationHandoverTracker,
  sanitizePersistedHandover,
  type PersistedHandover
} from './station-handover'
import { DurableFactFile } from './durable-state'
import { testTmpDir } from './test-tmp'

/**
 * The plain-`--after` hand-over hold across an app restart: write through one tracker, read
 * through a new one. Without it a restart released every dependent on the first `done` it saw.
 */

function disk() {
  let saved: PersistedHandover[] = []
  return {
    durable: {
      load: () => JSON.parse(JSON.stringify(saved)).map(sanitizePersistedHandover).filter(Boolean),
      save: (r: PersistedHandover[]) => (saved = r)
    },
    saved: () => saved
  }
}

describe('station hand-over holds across a restart', () => {
  it('a hold survives, and only a turn that started after the hand-over ends it', () => {
    let now = 1000
    const d = disk()
    const a = new StationHandoverTracker(() => {}, () => now, d.durable)
    a.onAgentEvent({ nodeId: 'st1', state: 'done' })
    a.noteControlAnswer('write', { node: 'st1' }, { ok: true }, 'orch', 1000)
    expect(a.isHandedOver('st1')).toBe(true)
    expect(d.saved()).toEqual([{ nodeId: 'st1', handedAt: 1000, state: 'done' }])

    now = 5000
    const b = new StationHandoverTracker(() => {}, () => now, d.durable)
    expect(b.isHandedOver('st1')).toBe(false) // nothing until loadFromDisk
    b.loadFromDisk()
    expect(b.isHandedOver('st1')).toBe(true)
    // The first `done` after the restart is the PREVIOUS task's: it releases nothing.
    b.onAgentEvent({ nodeId: 'st1', state: 'done' })
    expect(b.isHandedOver('st1')).toBe(true)
    b.onAgentEvent({ nodeId: 'st1', state: 'working' })
    b.onAgentEvent({ nodeId: 'st1', state: 'done' })
    expect(b.isHandedOver('st1')).toBe(false)
    expect(d.saved()).toEqual([])
  })

  it('a turn that started after the hand-over and was still running at the restart ends the hold on its done', () => {
    let now = 1000
    const d = disk()
    const a = new StationHandoverTracker(() => {}, () => now, d.durable)
    a.markHandedOver('st1', 1000)
    now = 2000
    a.onAgentEvent({ nodeId: 'st1', state: 'working' })
    expect(d.saved()[0]).toMatchObject({ turnStartedAt: 2000, state: 'working' })
    const b = new StationHandoverTracker(() => {}, () => 9000, d.durable)
    b.loadFromDisk()
    b.onAgentEvent({ nodeId: 'st1', state: 'done' })
    expect(b.isHandedOver('st1')).toBe(false)
  })

  it('background work survives too, and a present empty inventory clears it', () => {
    const d = disk()
    const a = new StationHandoverTracker(() => {}, () => 1, d.durable)
    a.onAgentEvent({ nodeId: 'st1', state: 'done', backgroundSubagentIds: ['b1'] })
    const b = new StationHandoverTracker(() => {}, () => 2, d.durable)
    b.loadFromDisk()
    expect(b.isHandedOver('st1')).toBe(true)
    b.onAgentEvent({ nodeId: 'st1', state: 'done', backgroundSubagentIds: [] })
    expect(b.isHandedOver('st1')).toBe(false)
  })

  it('queued is not stored: the restored queue replays it', () => {
    const d = disk()
    const a = new StationHandoverTracker(() => {}, () => 1, d.durable)
    a.onHandover({ phase: 'queued', verb: 'send', targetNodeId: 'st1' })
    expect(d.saved()).toEqual([])
    const b = new StationHandoverTracker(() => {}, () => 2, d.durable)
    b.loadFromDisk()
    b.onHandover({ phase: 'queued', verb: 'send', targetNodeId: 'st1' })
    expect(b.list()).toEqual([{ nodeId: 'st1', queued: true }])
    // …and a message that lapsed while the app was down still holds the station.
    b.onHandover({ phase: 'settled', verb: 'send', targetNodeId: 'st1', landed: false })
    expect(b.isHandedOver('st1')).toBe(true)
  })

  it('sanitizes hand-edited entries; one that holds nothing is dropped', () => {
    expect(sanitizePersistedHandover({ nodeId: 'st1', handedAt: 1 })).toEqual({ nodeId: 'st1', handedAt: 1 })
    expect(sanitizePersistedHandover({ nodeId: 'st1' })).toBeNull()
    expect(sanitizePersistedHandover({ nodeId: '../x', handedAt: 1 })).toBeNull()
    expect(sanitizePersistedHandover({ nodeId: 'st1', handedAt: 'x' })).toBeNull()
    expect(sanitizePersistedHandover({ nodeId: 'st1', handedAt: 1, state: 'idle' })).toBeNull()
  })

  it('end to end through the file', async () => {
    const dir = testTmpDir('nt-handover-')
    const f = new DurableFactFile(HANDOVER_FACT, { userDataDir: dir, debounceMs: 1 })
    const a = new StationHandoverTracker(() => {}, () => 1, f)
    a.markHandedOver('st1', 1)
    await f.flush()
    const b = new StationHandoverTracker(() => {}, () => 2, new DurableFactFile(HANDOVER_FACT, { userDataDir: dir }))
    b.loadFromDisk()
    expect(b.isHandedOver('st1')).toBe(true)
  })
})
