// Seeding the mirror's IDENTITY from the renderer (device report after #993/#994): the phone's chat
// view locates a node's transcript ONLY by the sessionId it reads off this mirror, and the mirror
// learns a session id only from hook events. An entry dropped before #994, or never created in this
// app run (an idle terminal-made conversation after a restart), is simply absent — while the
// renderer's agentStatus store has kept that node's sessionId in localStorage all along. These tests
// pin the seed that closes the gap: identity-only, add-never-overwrite, validated at the boundary,
// existing nodes only, and carried into the pushed SSH slice.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  seedNodeIdentities,
  recordAgentEvent,
  setNodeHibernated,
  setMirrorLiveNodesProvider,
  onMirrorFlush,
  flush,
  initAgentStatusMirror,
  filterMirrorForNodes,
  mirrorEntry,
  sessionNameSweepEntries,
  EXPIRE_MS,
  IDENTITY_EXPIRE_MS,
  _resetForTest,
  _snapshot,
  type MirrorFile
} from './agent-status-mirror'
import { IDENTITY_SEED_MAX, parseIdentitySeed } from '@shared/agent-identity-seed'

let dir = ''
beforeEach(() => {
  _resetForTest()
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-seed-'))
  initAgentStatusMirror(path.join(dir, 'agent-status.json'))
})
afterEach(() => {
  _resetForTest()
  fs.rmSync(dir, { recursive: true, force: true })
})

const account = { configDir: '/home/u/.claude', accountId: null, known: true }

describe('seedNodeIdentities', () => {
  it('creates an IDENTITY-ONLY entry (no state) for a node the mirror has never seen', () => {
    expect(seedNodeIdentities([{ nodeId: 'n1', agentId: 'claude', sessionId: 'sess-1' }])).toBe(1)
    const e = mirrorEntry('n1')!
    expect(e.agentId).toBe('claude')
    expect(e.sessionId).toBe('sess-1')
    expect(e.state).toBeUndefined()
    expect(e.stateExpired).toBe(true)
    // Not evidence about any state: nothing that gates on proof may read it as proven or restored.
    expect(e.stateVerified).toBeUndefined()
  })

  it('writes the identity to the flushed doc (no state key)', async () => {
    let doc: MirrorFile | null = null
    onMirrorFlush((d) => (doc = d))
    seedNodeIdentities([{ nodeId: 'n1', agentId: 'claude', sessionId: 'sess-1', account }])
    await flush()
    const n1 = JSON.parse(JSON.stringify(doc!)).nodes.n1
    expect(n1).toMatchObject({ agentId: 'claude', sessionId: 'sess-1', account })
    expect('state' in n1).toBe(false)
  })

  it('NEVER overrides an existing entry or its sessionId', () => {
    recordAgentEvent({ nodeId: 'n1', agentId: 'claude', kind: 'state', state: 'working', sessionId: 'live' })
    expect(seedNodeIdentities([{ nodeId: 'n1', agentId: 'claude', sessionId: 'stale' }])).toBe(0)
    expect(mirrorEntry('n1')!.sessionId).toBe('live')
    expect(mirrorEntry('n1')!.state).toBe('working')
    expect(mirrorEntry('n1')!.stateExpired).toBeUndefined()
  })

  it('never changes the agentId of an entry that already names one', () => {
    recordAgentEvent({ nodeId: 'n1', agentId: 'codex', kind: 'session', sessionPhase: 'end' })
    expect(seedNodeIdentities([{ nodeId: 'n1', agentId: 'claude', sessionId: 's' }])).toBe(0)
    expect(mirrorEntry('n1')!.agentId).toBe('codex')
    expect(mirrorEntry('n1')!.sessionId).toBeUndefined()
  })

  it('never fills an entry that holds a live STATE this run, even with no session id', () => {
    // A seeded id is last-known and possibly stale; next to a live state it would read as the id
    // of the session that state belongs to (the phone's permission-dialog guard reads it so).
    recordAgentEvent({ nodeId: 'n1', agentId: 'claude', kind: 'state', state: 'blocked' })
    expect(mirrorEntry('n1')!.sessionId).toBeUndefined()
    expect(seedNodeIdentities([{ nodeId: 'n1', agentId: 'claude', sessionId: 'stale' }])).toBe(0)
    expect(mirrorEntry('n1')!.sessionId).toBeUndefined()
    expect(mirrorEntry('n1')!.state).toBe('blocked')
  })

  it('fills the identity of a hibernated-only entry without touching the flag', () => {
    // The renderer's boot replay reports hibernated nodes BEFORE the seed; those are exactly the
    // long-idle nodes the phone could not open.
    setNodeHibernated('n1', true)
    expect(seedNodeIdentities([{ nodeId: 'n1', agentId: 'claude', sessionId: 'sess-1' }])).toBe(1)
    const e = mirrorEntry('n1')!
    expect(e.hibernated).toBe(true)
    expect(e.sessionId).toBe('sess-1')
    expect(e.agentId).toBe('claude')
  })

  it('skips nodes the workspace does not know (a deleted node\'s stale localStorage entry)', () => {
    setMirrorLiveNodesProvider(() => new Set(['alive']))
    expect(
      seedNodeIdentities([
        { nodeId: 'alive', agentId: 'claude', sessionId: 's1' },
        { nodeId: 'deleted', agentId: 'claude', sessionId: 's2' }
      ])
    ).toBe(1)
    expect(Object.keys(_snapshot())).toEqual(['alive'])
  })

  it('rejects invalid ids at the boundary', () => {
    const n = seedNodeIdentities([
      { nodeId: 'a;rm -rf', agentId: 'claude', sessionId: 's' },
      { nodeId: '..', agentId: 'claude', sessionId: 's' },
      { nodeId: 'n2', agentId: 'claude', sessionId: '$(touch x)' },
      { nodeId: 'n3', agentId: 'claude', sessionId: '-flag' },
      { nodeId: 'n4', agentId: 'claude; x', sessionId: 's' },
      { nodeId: 'n5', agentId: 'claude', sessionId: 's', account: { configDir: 1 } },
      { nodeId: 'n6', sessionId: 's' },
      { nodeId: 'n7', agentId: 'claude' },
      'n8',
      null
    ] as unknown)
    expect(n).toBe(0)
    expect(_snapshot()).toEqual({})
    expect(seedNodeIdentities('nope' as unknown)).toBe(0)
    expect(seedNodeIdentities({ nodeId: 'n1' } as unknown)).toBe(0)
  })

  it('accepts a custom agent id', () => {
    expect(
      seedNodeIdentities([{ nodeId: 'n1', agentId: 'custom:3f0e-aa', sessionId: 'sess-1' }])
    ).toBe(1)
  })

  it('caps the number of entries per call', () => {
    const many = Array.from({ length: IDENTITY_SEED_MAX + 50 }, (_, i) => ({
      nodeId: `n${i}`,
      agentId: 'claude',
      sessionId: `s${i}`
    }))
    expect(seedNodeIdentities(many)).toBe(IDENTITY_SEED_MAX)
    expect(Object.keys(_snapshot())).toHaveLength(IDENTITY_SEED_MAX)
  })

  it('a seeded entry reads as OLD: past EXPIRE_MS, inside the identity TTL, out of the name sweep', () => {
    // The clock is pinned: the seed dates the entry `now - EXPIRE_MS - 1`, so its age is exactly
    // EXPIRE_MS + 1. Reading a real clock BEFORE the seed flaked whenever it ticked between the two
    // reads (age measured as exactly EXPIRE_MS, which is not "past" it).
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(1_800_000_000_000)
      seedNodeIdentities([{ nodeId: 'n1', agentId: 'claude', sessionId: 's' }])
      const at = mirrorEntry('n1')!.updatedAt
      expect(Date.now() - at).toBeGreaterThan(EXPIRE_MS)
      expect(Date.now() - at).toBeLessThan(IDENTITY_EXPIRE_MS)
      expect(sessionNameSweepEntries()).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('stays identity-only across a restart (the marker itself is not persisted)', async () => {
    const file = path.join(dir, 'agent-status.json')
    seedNodeIdentities([{ nodeId: 'n1', agentId: 'claude', sessionId: 's' }])
    await flush()
    _resetForTest()
    initAgentStatusMirror(file)
    const e = mirrorEntry('n1')!
    expect(e.sessionId).toBe('s')
    expect(e.stateExpired).toBe(true)
    expect(sessionNameSweepEntries()).toEqual([])
  })

  it('a later hook event supersedes the seed normally', () => {
    seedNodeIdentities([{ nodeId: 'n1', agentId: 'claude', sessionId: 'old' }])
    recordAgentEvent({ nodeId: 'n1', agentId: 'claude', kind: 'state', state: 'working', sessionId: 'new' })
    const e = mirrorEntry('n1')!
    expect(e.sessionId).toBe('new')
    expect(e.state).toBe('working')
    expect(e.stateExpired).toBeUndefined()
  })

  it('the pushed per-project slice carries the seeded identity', async () => {
    let doc: MirrorFile | null = null
    onMirrorFlush((d) => (doc = d))
    seedNodeIdentities([
      { nodeId: 'ssh-node', agentId: 'claude', sessionId: 'remote-sess' },
      { nodeId: 'other', agentId: 'claude', sessionId: 'x' }
    ])
    await flush()
    const slice = filterMirrorForNodes(doc!, new Set(['ssh-node']))
    expect(Object.keys(slice.nodes)).toEqual(['ssh-node'])
    expect(slice.nodes['ssh-node']).toMatchObject({ agentId: 'claude', sessionId: 'remote-sess' })
  })
})

describe('parseIdentitySeed', () => {
  it('keeps a valid account label and drops a remote flag that is not boolean true', () => {
    const [e] = parseIdentitySeed([
      { nodeId: 'n1', agentId: 'claude', sessionId: 's', account: { ...account, remote: 'yes' } }
    ])
    expect(e.account).toEqual(account)
  })

  it('rejects an account label with control characters in its config dir', () => {
    expect(
      parseIdentitySeed([
        { nodeId: 'n1', agentId: 'claude', sessionId: 's', account: { ...account, configDir: '/a\nb' } }
      ])
    ).toEqual([])
  })
})
