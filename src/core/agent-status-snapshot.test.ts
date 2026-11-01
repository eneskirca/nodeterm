// `agent:status-snapshot` — what a relay tab that joins late reads to start from the host's states
// (bug D). Built from the agent-status mirror, registered by both shells.
import { afterEach, describe, expect, it } from 'vitest'
import { AGENT_STATUS_SNAPSHOT_MAX } from '../shared/agent-status-snapshot'
import { IPC } from '../shared/ipc'
import type { CorePlatform } from './platform'
import { _resetForTest, recordAgentEvent, type MirrorEntry } from './agent-status-mirror'
import { buildAgentStatusSnapshot, registerAgentStatusSnapshotIpc } from './agent-status-snapshot'

const account = { configDir: '/home/u/.claude', accountId: null, known: false }

const ENTRIES: Array<[string, MirrorEntry]> = [
  ['live', { state: 'working', agentId: 'claude', sessionId: 's-live', account, updatedAt: 300, stateVerified: true }],
  ['expired', { agentId: 'codex', sessionId: 's-expired', updatedAt: 200, stateExpired: true }],
  ['restored', { state: 'done', agentId: 'claude', sessionId: 's-restored', updatedAt: 100, restored: true, stateVerified: false }]
]

const entry = (nodeId: string) => {
  const e = buildAgentStatusSnapshot(ENTRIES).find((x) => x.nodeId === nodeId)
  if (!e) throw new Error(`no snapshot entry for ${nodeId}`)
  return e
}

afterEach(() => _resetForTest())

describe('buildAgentStatusSnapshot', () => {
  it('maps mirror entries to snapshot entries', () => {
    // Only the five fields a joiner's store takes travel: no proof, no clock, no inbox ticket.
    expect(entry('live')).toEqual({ nodeId: 'live', state: 'working', agentId: 'claude', sessionId: 's-live', account })
  })

  it('omits state for identity-only and restored entries', () => {
    expect(entry('expired').state).toBeUndefined()
    expect(entry('restored').state).toBeUndefined()
    expect(entry('expired').sessionId).toBe('s-expired') // identity still travels
    expect(entry('expired').agentId).toBe('codex')
    expect(entry('restored').sessionId).toBe('s-restored')
    expect('state' in entry('restored')).toBe(false)
  })

  it('keeps the newest AGENT_STATUS_SNAPSHOT_MAX entries by updatedAt', () => {
    const many: Array<[string, MirrorEntry]> = []
    // Inserted oldest-last, so a cap that kept insertion order would keep the wrong end.
    for (let i = AGENT_STATUS_SNAPSHOT_MAX + 50; i > 0; i--) {
      many.push([`n${i}`, { state: 'done', agentId: 'claude', updatedAt: i }])
    }
    const out = buildAgentStatusSnapshot(many)
    expect(out).toHaveLength(AGENT_STATUS_SNAPSHOT_MAX)
    const ids = new Set(out.map((e) => e.nodeId))
    expect(ids.has(`n${AGENT_STATUS_SNAPSHOT_MAX + 50}`)).toBe(true) // the newest
    expect(ids.has('n51')).toBe(true) // the oldest one kept
    expect(ids.has('n50')).toBe(false) // the newest one dropped
  })

  it('registers agent:status-snapshot on the platform', async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    const platform = { handle: (ch: string, fn: (...args: unknown[]) => unknown) => void handlers.set(ch, fn) } as unknown as CorePlatform
    registerAgentStatusSnapshotIpc(platform)
    expect([...handlers.keys()]).toEqual([IPC.agentStatusSnapshot])
    // The default read is the REAL mirror, as each shell's hook events left it.
    recordAgentEvent({ nodeId: 'term-a', agentId: 'claude', kind: 'state', state: 'working', sessionId: 's1', newTurn: true })
    expect(await handlers.get(IPC.agentStatusSnapshot)!()).toEqual([
      { nodeId: 'term-a', state: 'working', agentId: 'claude', sessionId: 's1' }
    ])
    // An injected read replaces it.
    registerAgentStatusSnapshotIpc(platform, () => [{ nodeId: 'x' }])
    expect(await handlers.get(IPC.agentStatusSnapshot)!()).toEqual([{ nodeId: 'x' }])
  })
})
