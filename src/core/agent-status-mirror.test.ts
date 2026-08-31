import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { NormalizedAgentEvent } from '@shared/agents/normalize'
import { syntheticAnsweredEvent } from './agents/pending-approvals'
import {
  reduceEntry,
  buildFile,
  filterMirrorForNodes,
  onMirrorFlush,
  recordAgentEvent,
  recordRawToolEvent,
  recordContextUsage,
  clearNode,
  agentStatusSnapshot,
  applyRecoveredAgentStatus,
  ackDone,
  flush,
  initAgentStatusMirror,
  setMirrorSettingsProvider,
  setMirrorServerProvider,
  setMirrorUsageProvider,
  buildMirrorUsage,
  toolActivity,
  buildApprovalSummary,
  firstLine,
  extractQuestionOptions,
  extractQuestionText,
  extractQuestionMultiSelect,
  onNodeStateChange,
  onNodeNowChange,
  onInboxActionable,
  isEventUnresolved,
  trimInboxFeed,
  workingNodes,
  _resetForTest,
  _snapshot,
  _inboxSnapshot,
  DONE_HOLDOFF_MS,
  EXPIRE_MS,
  STASH_MAX_AGE_MS,
  QUESTION_DEDUP_WINDOW_MS,
  INBOX_EVENTS_CAP,
  type MirrorEntry,
  type MirrorFile,
  type MirrorUsage,
  type NodeStateChange,
  type NodeNowChange,
  type InboxEvent,
  sweepStaleWorking
} from './agent-status-mirror'

// Minimal event factory — only the fields the reducer reads.
function ev(partial: Partial<NormalizedAgentEvent>): NormalizedAgentEvent {
  return { nodeId: 'n1', agentId: 'claude', kind: 'state', ...partial } as NormalizedAgentEvent
}

describe('reduceEntry (main-state reduction)', () => {
  it('reduces working → done and records the turn end', () => {
    const a = reduceEntry(undefined, ev({ kind: 'state', state: 'working', newTurn: true }), 1000)
    expect(a.state).toBe('working')
    expect(a.updatedAt).toBe(1000)
    const b = reduceEntry(a, ev({ kind: 'state', state: 'done' }), 2000)
    expect(b.state).toBe('done')
    expect(b.updatedAt).toBe(2000)
  })

  it('captures agentId + sessionId off any event', () => {
    const a = reduceEntry(undefined, ev({ agentId: 'codex', sessionId: 'sess-1', state: 'working' }), 1)
    expect(a.agentId).toBe('codex')
    expect(a.sessionId).toBe('sess-1')
  })

  it('holds done against a late non-newTurn working within the holdoff window', () => {
    const done: MirrorEntry = { state: 'done', agentId: 'claude', updatedAt: 5000 }
    const late = reduceEntry(done, ev({ kind: 'state', state: 'working' }), 5000 + DONE_HOLDOFF_MS - 1)
    expect(late.state).toBe('done')
    expect(late.updatedAt).toBe(5000) // timestamp not refreshed — holdoff keeps measuring from done
  })

  it('lets a genuine new turn override done inside the holdoff window', () => {
    const done: MirrorEntry = { state: 'done', agentId: 'claude', updatedAt: 5000 }
    const turn = reduceEntry(done, ev({ kind: 'state', state: 'working', newTurn: true }), 5000 + 1)
    expect(turn.state).toBe('working')
  })

  it('lets working resume after the holdoff window elapses', () => {
    const done: MirrorEntry = { state: 'done', agentId: 'claude', updatedAt: 5000 }
    const after = reduceEntry(done, ev({ kind: 'state', state: 'working' }), 5000 + DONE_HOLDOFF_MS + 1)
    expect(after.state).toBe('working')
  })

  it('subagent + recurring events do NOT clobber the main state', () => {
    let e: MirrorEntry = reduceEntry(undefined, ev({ kind: 'state', state: 'working' }), 1000)
    e = reduceEntry(e, ev({ kind: 'subagent-start', toolUseId: 't1', sessionId: 's9' }), 1100)
    expect(e.state).toBe('working')
    expect(e.sessionId).toBe('s9') // identity still captured
    e = reduceEntry(e, ev({ kind: 'subagent-end', toolUseId: 't1' }), 1200)
    expect(e.state).toBe('working')
    e = reduceEntry(e, ev({ kind: 'recurring', recurringKind: 'cron' }), 1300)
    expect(e.state).toBe('working')
    expect(e.updatedAt).toBe(1000) // identity-only events don't refresh state freshness
  })

  it('session start/end resets the node to idle', () => {
    const working = reduceEntry(undefined, ev({ kind: 'state', state: 'working' }), 1000)
    const started = reduceEntry(working, ev({ kind: 'session', sessionPhase: 'start' }), 2000)
    expect(started.state).toBeUndefined()
    const done = reduceEntry(started, ev({ kind: 'state', state: 'done' }), 3000)
    const ended = reduceEntry(done, ev({ kind: 'session', sessionPhase: 'end' }), 4000)
    expect(ended.state).toBeUndefined()
    expect(ended.agentId).toBe('claude') // identity preserved across reset
  })

  it('refreshes freshness on a same-state working (mid-turn tool events)', () => {
    const a = reduceEntry(undefined, ev({ kind: 'state', state: 'working' }), 1000)
    const b = reduceEntry(a, ev({ kind: 'state', state: 'working' }), 9000)
    expect(b.state).toBe('working')
    expect(b.updatedAt).toBe(9000)
  })
})

describe('buildFile (shape + expiry)', () => {
  it('produces the documented JSON shape', () => {
    const now = 10_000
    const doc = buildFile(
      { n1: { state: 'working', agentId: 'claude', sessionId: 's1', updatedAt: now } },
      now
    )
    expect(doc.v).toBe(1)
    expect(doc.updatedAt).toBe(now)
    expect(doc.nodes.n1).toEqual({
      state: 'working',
      agentId: 'claude',
      sessionId: 's1',
      updatedAt: now
    })
  })

  it('drops entries older than the expiry window', () => {
    const now = EXPIRE_MS + 100_000
    const doc = buildFile(
      {
        fresh: { state: 'working', updatedAt: now - 1000 },
        stale: { state: 'working', updatedAt: now - EXPIRE_MS - 1 }
      },
      now
    )
    expect(Object.keys(doc.nodes)).toEqual(['fresh'])
  })

  it('keeps display continuity outside the operational expiry window', () => {
    const now = EXPIRE_MS + 100_000
    const remembered = {
      stale: { state: 'done' as const, agentId: 'claude' as const, changedAt: 1 }
    }
    const doc = buildFile(
      { stale: { state: 'done', agentId: 'claude', updatedAt: 1 } },
      now,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      remembered
    )
    expect(doc.nodes.stale).toBeUndefined()
    expect(doc.lastKnown).toEqual(remembered)
  })

  it('omits an undefined state (idle node keeps identity)', () => {
    const doc = buildFile({ n1: { agentId: 'claude', sessionId: 's1', updatedAt: 5 } }, 5)
    expect('state' in JSON.parse(JSON.stringify(doc)).nodes.n1).toBe(false)
    expect(JSON.parse(JSON.stringify(doc)).nodes.n1).toEqual({
      agentId: 'claude',
      sessionId: 's1',
      updatedAt: 5
    })
  })
})

describe('recordAgentEvent + atomic write', () => {
  let dir: string
  let file: string

  beforeEach(() => {
    _resetForTest()
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-status-'))
    file = path.join(dir, 'agent-status.json')
    initAgentStatusMirror(file)
  })

  afterEach(() => {
    _resetForTest()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('records events into memory and flushes valid JSON to disk', async () => {
    recordAgentEvent(ev({ nodeId: 'n1', state: 'working', sessionId: 's1' }))
    recordAgentEvent(ev({ nodeId: 'n1', state: 'done' }))
    expect(_snapshot().n1.state).toBe('done')

    await flush()
    const doc = JSON.parse(fs.readFileSync(file, 'utf-8'))
    expect(doc.v).toBe(1)
    expect(typeof doc.updatedAt).toBe('number')
    expect(doc.nodes.n1.state).toBe('done')
    expect(doc.nodes.n1.sessionId).toBe('s1')
    expect(doc.nodes.n1.agentId).toBe('claude')
    expect(doc.lastKnown.n1).toMatchObject({
      state: 'done',
      sessionId: 's1',
      agentId: 'claude'
    })
  })

  it('writes the file with 0600 permissions', async () => {
    recordAgentEvent(ev({ state: 'working' }))
    await flush()
    const mode = fs.statSync(file).mode & 0o777
    expect(mode).toBe(0o600)
  })

  it('clearNode removes an entry from the written file', async () => {
    recordAgentEvent(ev({ nodeId: 'a', state: 'working' }))
    recordAgentEvent(ev({ nodeId: 'b', state: 'working' }))
    clearNode('a')
    await flush()
    const doc = JSON.parse(fs.readFileSync(file, 'utf-8'))
    expect(Object.keys(doc.nodes)).toEqual(['b'])
    expect(Object.keys(doc.lastKnown)).toEqual(['b'])
  })

  it('same-state events refresh live evidence without resetting time in state', () => {
    const now = vi.spyOn(Date, 'now')
    now.mockReturnValueOnce(100).mockReturnValueOnce(200)
    recordAgentEvent(ev({ state: 'working', sessionId: 's1' }))
    recordAgentEvent(ev({ state: 'working', sessionId: 's1' }))
    expect(agentStatusSnapshot().n1.changedAt).toBe(100)
    expect(_snapshot().n1.updatedAt).toBe(200)
    now.mockRestore()
  })

  it('preserves a completed same-conversation label across a session restart', () => {
    const now = vi.spyOn(Date, 'now')
    now.mockReturnValueOnce(100).mockReturnValueOnce(200).mockReturnValueOnce(300)
    recordAgentEvent(ev({ state: 'working', sessionId: 's1' }))
    recordAgentEvent(ev({ state: 'done', sessionId: 's1' }))
    recordAgentEvent(ev({ kind: 'session', sessionPhase: 'start', sessionId: 's1' }))

    expect(_snapshot().n1.state).toBeUndefined()
    expect(agentStatusSnapshot().n1).toMatchObject({
      state: 'done',
      sessionId: 's1',
      changedAt: 200
    })
    now.mockRestore()
  })

  it('forgets the label for a new session or one that ended before completion', () => {
    const now = vi.spyOn(Date, 'now')
    now.mockReturnValueOnce(100).mockReturnValueOnce(200)
    recordAgentEvent(ev({ state: 'working', sessionId: 's1' }))
    recordAgentEvent(ev({ kind: 'session', sessionPhase: 'end', sessionId: 's1' }))
    expect(agentStatusSnapshot().n1).toMatchObject({
      state: undefined,
      sessionId: 's1',
      changedAt: 200
    })

    now.mockReturnValueOnce(300).mockReturnValueOnce(400)
    recordAgentEvent(ev({ state: 'done', sessionId: 's1' }))
    recordAgentEvent(ev({ kind: 'session', sessionPhase: 'start', sessionId: 's2' }))
    expect(agentStatusSnapshot().n1).toMatchObject({
      state: undefined,
      sessionId: 's2',
      changedAt: 400
    })
    now.mockRestore()
  })

  it('applies only newer recovered display evidence and never mutates live state', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(100)
    recordAgentEvent(ev({ state: 'working', sessionId: 's1' }))

    expect(applyRecoveredAgentStatus('n1', { state: 'done', observedAt: 200 })).toBe(true)
    expect(agentStatusSnapshot().n1).toMatchObject({ state: 'done', changedAt: 200 })
    expect(_snapshot().n1.state).toBe('working')

    now.mockReturnValue(300)
    recordAgentEvent(ev({ state: 'working', sessionId: 's1' }))
    expect(applyRecoveredAgentStatus('n1', { state: 'done', observedAt: 250 })).toBe(false)
    expect(agentStatusSnapshot().n1.state).toBe('working')
    now.mockRestore()
  })

  it('onMirrorFlush delivers the built doc on every flush; unsubscribe stops it', async () => {
    const seen: MirrorFile[] = []
    const off = onMirrorFlush((doc) => seen.push(doc))
    recordAgentEvent(ev({ nodeId: 'n1', state: 'working' }))
    await flush()
    expect(seen).toHaveLength(1)
    expect(seen[0].nodes.n1.state).toBe('working')
    off()
    recordAgentEvent(ev({ nodeId: 'n1', state: 'done' }))
    await flush()
    expect(seen).toHaveLength(1)
  })

  it('onMirrorFlush still fires when the local disk write fails', async () => {
    initAgentStatusMirror(path.join(dir, 'no-such-dir', 'x', 'agent-status.json'))
    const seen: MirrorFile[] = []
    onMirrorFlush((doc) => seen.push(doc))
    recordAgentEvent(ev({ nodeId: 'n1', state: 'working' }))
    await flush()
    expect(seen).toHaveLength(1)
  })
})

describe('filterMirrorForNodes', () => {
  it('keeps only the given node ids, preserving header fields', () => {
    const doc: MirrorFile = {
      v: 1,
      updatedAt: 99,
      nodes: {
        a: { state: 'working', updatedAt: 1 },
        b: { state: 'done', updatedAt: 2 },
        c: { updatedAt: 3 }
      },
      lastKnown: {
        a: { state: 'working', changedAt: 1 },
        b: { state: 'done', changedAt: 2 },
        c: { changedAt: 3 }
      }
    }
    const out = filterMirrorForNodes(doc, new Set(['b', 'c', 'ghost']))
    expect(out.v).toBe(1)
    expect(out.updatedAt).toBe(99)
    expect(Object.keys(out.nodes).sort()).toEqual(['b', 'c'])
    expect(out.nodes.b.state).toBe('done')
    expect(Object.keys(out.lastKnown ?? {}).sort()).toEqual(['b', 'c'])
  })

  it('does not mutate the input doc', () => {
    const doc: MirrorFile = { v: 1, updatedAt: 1, nodes: { a: { updatedAt: 1 } } }
    filterMirrorForNodes(doc, new Set())
    expect(Object.keys(doc.nodes)).toEqual(['a'])
  })
})

describe('settings block', () => {
  let tmpDir: string

  beforeEach(() => {
    _resetForTest()
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-status-'))
  })

  afterEach(() => {
    _resetForTest()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('buildFile includes the settings block when given one', () => {
    const doc = buildFile({}, 1000, undefined, {
      claudePermissionMode: 'auto',
      autoSupported: true,
      claudeAccounts: [{ id: 'a1', dir: '/data/claude-accounts/a1' }]
    })
    expect(doc.settings).toEqual({
      claudePermissionMode: 'auto',
      autoSupported: true,
      claudeAccounts: [{ id: 'a1', dir: '/data/claude-accounts/a1' }]
    })
  })

  it('buildFile omits the settings key entirely when none given (old-file shape)', () => {
    const doc = buildFile({}, 1000)
    expect('settings' in doc).toBe(false)
  })

  it('filterMirrorForNodes drops settings from slices', () => {
    const doc = buildFile({}, 1000, undefined, { claudePermissionMode: 'plan' })
    expect('settings' in filterMirrorForNodes(doc, new Set())).toBe(false)
  })

  it('flush consults the provider at flush time', async () => {
    const file = path.join(tmpDir, 'status.json')
    initAgentStatusMirror(file)
    let mode = 'plan'
    setMirrorSettingsProvider(() => ({ claudePermissionMode: mode }))
    await flush()
    expect(JSON.parse(fs.readFileSync(file, 'utf-8')).settings.claudePermissionMode).toBe('plan')
    mode = 'acceptEdits'
    await flush()
    expect(JSON.parse(fs.readFileSync(file, 'utf-8')).settings.claudePermissionMode).toBe('acceptEdits')
  })

  it('a throwing provider fails open (no settings, file still written)', async () => {
    const file = path.join(tmpDir, 'status.json')
    initAgentStatusMirror(file)
    setMirrorSettingsProvider(() => { throw new Error('boom') })
    await flush()
    expect('settings' in JSON.parse(fs.readFileSync(file, 'utf-8'))).toBe(false)
  })
})

// ---- server-update (install metadata block) -------------------------------------------------

describe('server block', () => {
  let tmpDir: string

  beforeEach(() => {
    _resetForTest()
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-status-'))
  })

  afterEach(() => {
    _resetForTest()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('buildFile includes the server block when given one', () => {
    const doc = buildFile({}, 1000, undefined, undefined, undefined, undefined, {
      version: '0.2.17',
      commit: '1e56f83',
      installedAt: '2026-07-23T00:00:00Z'
    })
    expect(doc.server).toEqual({
      version: '0.2.17',
      commit: '1e56f83',
      installedAt: '2026-07-23T00:00:00Z'
    })
  })

  it('buildFile omits the server key entirely when none given (old-file shape)', () => {
    expect('server' in buildFile({}, 1000)).toBe(false)
    // An all-empty block is also omitted (nothing worth advertising).
    expect('server' in buildFile({}, 1000, undefined, undefined, undefined, undefined, {})).toBe(false)
  })

  it('filterMirrorForNodes drops the server block from slices (host-local info)', () => {
    const doc = buildFile({}, 1000, undefined, undefined, undefined, undefined, { version: '0.2.17' })
    expect('server' in doc).toBe(true)
    expect('server' in filterMirrorForNodes(doc, new Set())).toBe(false)
  })

  it('flush consults the server provider at flush time', async () => {
    const file = path.join(tmpDir, 'status.json')
    initAgentStatusMirror(file)
    setMirrorServerProvider(() => ({ version: '0.2.17', commit: 'abc1234' }))
    await flush()
    const written = JSON.parse(fs.readFileSync(file, 'utf-8'))
    expect(written.server).toEqual({ version: '0.2.17', commit: 'abc1234' })
  })

  it('a throwing provider fails open (no server block, file still written)', async () => {
    const file = path.join(tmpDir, 'status.json')
    initAgentStatusMirror(file)
    setMirrorServerProvider(() => {
      throw new Error('boom')
    })
    await flush()
    expect('server' in JSON.parse(fs.readFileSync(file, 'utf-8'))).toBe(false)
  })

  it('writes no server block when no provider is wired (desktop parity)', async () => {
    const file = path.join(tmpDir, 'status.json')
    initAgentStatusMirror(file)
    await flush()
    expect('server' in JSON.parse(fs.readFileSync(file, 'utf-8'))).toBe(false)
  })
})

// ---- mobile-usage-inbox ---------------------------------------------------------------------

describe('inbox event production (via recordAgentEvent)', () => {
  beforeEach(() => _resetForTest())
  afterEach(() => _resetForTest())

  it('emits an approval on blocked and dedups a same-title re-assertion', () => {
    recordAgentEvent(ev({ state: 'working', newTurn: true }))
    recordAgentEvent(ev({ state: 'blocked', lastMessage: 'Approve write to /etc/hosts' }))
    let ib = _inboxSnapshot()
    expect(ib.events).toHaveLength(1)
    expect(ib.events[0].kind).toBe('approval')
    expect(ib.events[0].title).toBe('Approve write to /etc/hosts')
    expect(ib.events[0].resolved).toBeUndefined()
    // Same blocked ask again (still blocked) → deduped, no second event.
    recordAgentEvent(ev({ state: 'blocked', lastMessage: 'Approve write to /etc/hosts' }))
    expect(_inboxSnapshot().events).toHaveLength(1)
    // A genuinely different ask while still blocked DOES land.
    recordAgentEvent(ev({ state: 'blocked', lastMessage: 'Approve rm -rf /tmp/x' }))
    ib = _inboxSnapshot()
    expect(ib.events).toHaveLength(2)
    expect(ib.events[1].title).toBe('Approve rm -rf /tmp/x')
  })

  it('carries the deterministic-approval pendingId onto the approval event (and omits it when absent)', () => {
    recordAgentEvent(ev({ state: 'working', newTurn: true }))
    recordAgentEvent(ev({ state: 'blocked', lastMessage: 'Approve write', pendingId: 'n1-123-9' }))
    const withId = _inboxSnapshot().events[0]
    expect(withId.kind).toBe('approval')
    expect(withId.pendingId).toBe('n1-123-9')

    // A different node whose hook did NOT arm the wait (no pendingId) → the field is omitted.
    recordAgentEvent(ev({ nodeId: 'other', state: 'blocked', lastMessage: 'Approve?' }))
    const noId = _inboxSnapshot().events.find((e) => e.nodeId === 'other')!
    expect(noId.kind).toBe('approval')
    expect('pendingId' in noId).toBe(false)
  })

  it('titles blocked/waiting from lastMessage first line, with fallbacks', () => {
    recordAgentEvent(ev({ nodeId: 'a', state: 'blocked' }))
    recordAgentEvent(ev({ nodeId: 'b', state: 'waiting' }))
    recordAgentEvent(ev({ nodeId: 'c', state: 'waiting', lastMessage: 'Which file?\nsecond line' }))
    const ev3 = _inboxSnapshot().events
    expect(ev3.find((e) => e.nodeId === 'a')!.title).toBe('Needs approval')
    expect(ev3.find((e) => e.nodeId === 'b')!.title).toBe('Waiting for input')
    const q = ev3.find((e) => e.nodeId === 'c')!
    expect(q.kind).toBe('question')
    expect(q.title).toBe('Which file?')
  })

  it('resolves unresolved approval/question when the node leaves blocked/waiting', () => {
    recordAgentEvent(ev({ state: 'working', newTurn: true }))
    recordAgentEvent(ev({ state: 'blocked', lastMessage: 'Approve?' }))
    expect(_inboxSnapshot().events[0].resolved).toBeUndefined()
    recordAgentEvent(ev({ state: 'working' })) // left blocked
    expect(_inboxSnapshot().events[0].resolved).toBe(true)
  })

  // Task 3: the title-dedup must be BOUNDED so a lingering unresolved same-title ask (e.g. a generic
  // "Waiting for input" restored across a restart) can't muzzle a genuinely NEW same-title ask forever.
  describe('bounded title-dedup window (QUESTION_DEDUP_WINDOW_MS)', () => {
    beforeEach(() => {
      vi.useFakeTimers()
      _resetForTest()
    })
    afterEach(() => {
      _resetForTest()
      vi.useRealTimers()
    })

    it('dedups a same-generic-title re-assert INSIDE the window (no duplicate)', () => {
      vi.setSystemTime(0)
      recordAgentEvent(ev({ state: 'waiting' })) // generic title "Waiting for input"
      expect(_inboxSnapshot().events).toHaveLength(1)
      // Re-assert well within the window (node still waiting) → deduped.
      vi.setSystemTime(QUESTION_DEDUP_WINDOW_MS - 1000)
      recordAgentEvent(ev({ state: 'waiting' }))
      const ib = _inboxSnapshot()
      expect(ib.events).toHaveLength(1)
      expect(ib.events[0].resolved).toBeUndefined()
    })

    it('supersedes a STALE unresolved same-title ask and fires the new one (the restart false-suppression fix)', () => {
      vi.setSystemTime(0)
      recordAgentEvent(ev({ state: 'waiting' })) // event 0, title "Waiting for input", unresolved
      // Node stays waiting; the ask lingers unanswered past the dedup window (models an unresolved
      // event surviving a restart, its node never re-passing the state-leave resolve).
      vi.setSystemTime(QUESTION_DEDUP_WINDOW_MS + 1)
      recordAgentEvent(ev({ state: 'waiting' })) // same generic title, but the old dup is now stale
      const ib = _inboxSnapshot()
      expect(ib.events).toHaveLength(2)
      // The stale one is superseded (resolved) so it stops muzzling; the new ask is live.
      expect(ib.events[0].resolved).toBe(true)
      expect(ib.events[1].title).toBe('Waiting for input')
      expect(ib.events[1].resolved).toBeUndefined()
    })

    it('the superseding new ask fires the actionable seam (a genuinely new question is not lost)', () => {
      const fired: string[] = []
      const off = onInboxActionable((e) => fired.push(e.id))
      vi.setSystemTime(0)
      recordAgentEvent(ev({ state: 'waiting' }))
      vi.setSystemTime(QUESTION_DEDUP_WINDOW_MS + 1)
      recordAgentEvent(ev({ state: 'waiting' }))
      off()
      // Two distinct actionable events — the stale one did NOT swallow the new ask.
      expect(fired).toHaveLength(2)
      expect(new Set(fired).size).toBe(2)
    })
  })

  it('session reset also resolves a pending question', () => {
    recordAgentEvent(ev({ state: 'waiting', lastMessage: 'Pick one' }))
    recordAgentEvent(ev({ kind: 'session', sessionPhase: 'end' }))
    expect(_inboxSnapshot().events[0].resolved).toBe(true)
  })

  // A CLI that exits mid-turn (`/exit`, Ctrl-C, a crash) is the one transition that MEANS "this
  // session is over", and it used to emit nothing: `reduceEntry` resets it to `state: undefined`
  // while every `end` was keyed on the edge into `done`. It escaped the rescue too, because
  // `sweepStaleWorking` matches `state === 'working'` — which the reset had just stopped being
  // true. The phone was left holding a card nothing would ever end.
  describe('a session that ends mid-turn ends its Live Activity', () => {
    const edgesFor = (fn: () => void): NodeStateChange[] => {
      const edges: NodeStateChange[] = []
      const un = onNodeStateChange((c) => edges.push(c))
      fn()
      un()
      return edges
    }

    it('emits an end when the agent quits while WORKING', () => {
      recordAgentEvent(ev({ state: 'working', newTurn: true }))
      const edges = edgesFor(() => recordAgentEvent(ev({ kind: 'session', sessionPhase: 'end' })))
      expect(edges).toHaveLength(1)
      expect(edges[0]).toMatchObject({ event: 'end', state: 'done' })
    })

    it('emits an end when the agent quits while it was BLOCKED on an approval', () => {
      // The worst case: the card carries Approve/Deny buttons for a hook ticket that is now gone.
      recordAgentEvent(ev({ state: 'blocked', lastMessage: 'Approve write' }))
      const edges = edgesFor(() => recordAgentEvent(ev({ kind: 'session', sessionPhase: 'end' })))
      expect(edges).toHaveLength(1)
      expect(edges[0]).toMatchObject({ event: 'end', state: 'done' })
    })

    it('stays silent when the turn already finished — the done edge spoke for it', () => {
      recordAgentEvent(ev({ state: 'working', newTurn: true }))
      recordAgentEvent(ev({ state: 'done' }))
      const edges = edgesFor(() => recordAgentEvent(ev({ kind: 'session', sessionPhase: 'end' })))
      expect(edges).toEqual([])
    })

    it('stays silent for an idle node and for a session START', () => {
      // Nothing was live → nothing to end.
      expect(edgesFor(() => recordAgentEvent(ev({ kind: 'session', sessionPhase: 'end' })))).toEqual(
        []
      )
      // A SessionStart also resets to idle, but ending there would kill the activity of the turn
      // that is just beginning.
      recordAgentEvent(ev({ state: 'working', newTurn: true }))
      expect(edgesFor(() => recordAgentEvent(ev({ kind: 'session', sessionPhase: 'start' })))).toEqual(
        []
      )
    })

    it('adds no inbox card — the session going away is not news for the feed', () => {
      recordAgentEvent(ev({ state: 'working', newTurn: true }))
      const before = _inboxSnapshot().events.length
      recordAgentEvent(ev({ kind: 'session', sessionPhase: 'end' }))
      expect(_inboxSnapshot().events.length).toBe(before)
    })
  })

  it('synthetic "answered" working transition resolves the open approval and adds no new ask', () => {
    // The deterministic-approval answered signal (built exactly as the hook POST / desktop optimistic
    // flip does) is a working state → it goes through the same blocked→working path a normal resume
    // would, resolving the approval without pushing a fresh approval/question.
    const changes: NodeStateChange[] = []
    const unsub = onNodeStateChange((c) => changes.push(c))
    recordAgentEvent(ev({ state: 'working', newTurn: true }))
    recordAgentEvent(ev({ state: 'blocked', lastMessage: 'Approve write', pendingId: 'n1-1-1' }))
    expect(_inboxSnapshot().events).toHaveLength(1)
    expect(_inboxSnapshot().events[0].resolved).toBeUndefined()
    // Isolate the state-change edges produced by the answered signal alone.
    changes.length = 0
    const answered = syntheticAnsweredEvent('n1', 'n1-1-1', 'allow')!
    recordAgentEvent(answered)
    const ib = _inboxSnapshot()
    // Approval resolved, and no second inbox event appended (working never produces an ask).
    expect(ib.events).toHaveLength(1)
    expect(ib.events[0].resolved).toBe(true)
    expect(_snapshot().n1.state).toBe('working')
    // Consistent with a normal blocked→working resume: exactly one working 'start' edge (the same
    // a plain `working` event fires on that edge), and no spurious extra state-change kinds.
    expect(changes).toHaveLength(1)
    expect(changes[0]).toMatchObject({ event: 'start', state: 'working' })
    unsub()
  })

  it('a duplicate answered signal is a no-op (same-state working re-assert)', () => {
    recordAgentEvent(ev({ state: 'working', newTurn: true }))
    recordAgentEvent(ev({ state: 'blocked', lastMessage: 'Approve write', pendingId: 'n1-2-2' }))
    const answered = syntheticAnsweredEvent('n1', 'n1-2-2', 'allow')!
    recordAgentEvent(answered) // optimistic flip (desktop write)
    const changes: NodeStateChange[] = []
    const unsub = onNodeStateChange((c) => changes.push(c))
    recordAgentEvent(answered) // the held hook's second POST — an idempotent duplicate
    // No new inbox event, still one (resolved) approval, still working, and no new state edge fired.
    const ib = _inboxSnapshot()
    expect(ib.events).toHaveLength(1)
    expect(ib.events[0].resolved).toBe(true)
    expect(_snapshot().n1.state).toBe('working')
    expect(changes).toHaveLength(0)
    unsub()
  })

  it('emits one done per turn with a detail snippet and passes interrupted through', () => {
    recordAgentEvent(ev({ state: 'working', newTurn: true }))
    recordAgentEvent(ev({ state: 'done', lastMessage: 'All wired up.\nplus extra' }))
    let ib = _inboxSnapshot()
    expect(ib.events).toHaveLength(1)
    expect(ib.events[0]).toMatchObject({ kind: 'done', title: 'Finished', detail: 'All wired up.' })
    expect(ib.events[0].interrupted).toBeUndefined()
    // A duplicate done (no new turn) does not append a second event.
    recordAgentEvent(ev({ state: 'done' }))
    expect(_inboxSnapshot().events).toHaveLength(1)
    // A new turn that ends interrupted titles "Stopped".
    recordAgentEvent(ev({ state: 'working', newTurn: true }))
    recordAgentEvent(ev({ state: 'done', interrupted: true }))
    ib = _inboxSnapshot()
    expect(ib.events).toHaveLength(2)
    expect(ib.events[1]).toMatchObject({ kind: 'done', title: 'Stopped', interrupted: true })
  })

  it('caps the feed at INBOX_EVENTS_CAP, dropping oldest', () => {
    const total = INBOX_EVENTS_CAP + 10
    for (let i = 0; i < total; i++) {
      recordAgentEvent(ev({ state: 'working', newTurn: true }))
      recordAgentEvent(ev({ state: 'done', lastMessage: `turn ${i}` }))
    }
    const events = _inboxSnapshot().events
    expect(events).toHaveLength(INBOX_EVENTS_CAP)
    // The newest survives, the earliest fell off the front.
    expect(events[events.length - 1].detail).toBe(`turn ${total - 1}`)
    expect(events[0].detail).toBe(`turn ${total - INBOX_EVENTS_CAP}`)
  })

  it('clearNode drops the node activity but keeps its events, marked resolved', () => {
    recordAgentEvent(ev({ nodeId: 'x', state: 'working', newTurn: true }))
    recordAgentEvent(ev({ nodeId: 'x', state: 'blocked', lastMessage: 'Q' }))
    recordContextUsage('x', 40)
    clearNode('x')
    const ib = _inboxSnapshot()
    expect(ib.nodes.x).toBeUndefined()
    expect(ib.events).toHaveLength(1)
    expect(ib.events[0].resolved).toBe(true)
  })
})

// P2-7: on a busy multi-agent host the global 50-event cap evicted a node's `done` (and its live
// ask) within minutes, so `ackDone` no-op'd (a retained DONE card on the phone never dismissed) and
// the phone lost that node's newest-done / end-reason. The feed now keeps each node's newest done +
// newest UNRESOLVED ask past the cut, in the same `events` array every reader already walks.
describe('per-node retention past the cap (P2-7)', () => {
  beforeEach(() => _resetForTest())
  afterEach(() => _resetForTest())

  /** Push one `done` inbox event for `nodeId` (a working-start pushes no feed event). */
  function pushDone(nodeId: string, detail: string): void {
    recordAgentEvent(ev({ nodeId, state: 'working', newTurn: true }))
    recordAgentEvent(ev({ nodeId, state: 'done', lastMessage: detail }))
  }

  it("keeps a node's newest done when >CAP newer events from other nodes would evict it", () => {
    pushDone('slow', 'Slow node finished') // the load-bearing done, pushed first (oldest)
    // A busy sibling floods the feed well past the cap.
    for (let i = 0; i < INBOX_EVENTS_CAP + 10; i++) pushDone('busy', `busy turn ${i}`)

    const events = _inboxSnapshot().events
    const slow = events.filter((e) => e.nodeId === 'slow')
    // The slow node's single done SURVIVES despite being far outside the newest-CAP window.
    expect(slow).toHaveLength(1)
    expect(slow[0].kind).toBe('done')
    expect(slow[0].detail).toBe('Slow node finished')

    // ...and ackDone now finds + resolves it and fires exactly one ack 'end' seam (the bug: a no-op).
    const changes: NodeStateChange[] = []
    const off = onNodeStateChange((c) => changes.push(c))
    ackDone('slow')
    off()
    expect(_inboxSnapshot().events.find((e) => e.nodeId === 'slow')!.resolved).toBe(true)
    expect(changes).toHaveLength(1)
    expect(changes[0]).toMatchObject({ nodeId: 'slow', event: 'end', state: 'done', ack: true })
  })

  it("keeps a node's newest UNRESOLVED ask past the cap (isEventUnresolved stays true)", () => {
    recordAgentEvent(ev({ nodeId: 'ask', state: 'blocked', lastMessage: 'Approve deploy?' }))
    const askId = _inboxSnapshot().events.find((e) => e.nodeId === 'ask')!.id
    for (let i = 0; i < INBOX_EVENTS_CAP + 10; i++) pushDone('busy', `busy turn ${i}`)

    const ask = _inboxSnapshot().events.filter((e) => e.nodeId === 'ask')
    expect(ask).toHaveLength(1)
    expect(ask[0].kind).toBe('approval')
    expect(ask[0].resolved).toBeUndefined()
    // The push-notify present→away hold reads this — it must still see the held event as live.
    expect(isEventUnresolved('ask', askId)).toBe(true)
  })

  it('does NOT retain a RESOLVED ask past the cap — it drops with plain history', () => {
    recordAgentEvent(ev({ nodeId: 'ask', state: 'blocked', lastMessage: 'Approve deploy?' }))
    recordAgentEvent(ev({ nodeId: 'ask', state: 'working', newTurn: true })) // leaves blocked → resolved
    expect(_inboxSnapshot().events.find((e) => e.nodeId === 'ask')!.resolved).toBe(true)
    for (let i = 0; i < INBOX_EVENTS_CAP + 10; i++) pushDone('busy', `busy turn ${i}`)

    // The resolved ask is no longer protected, so the cap evicts it like any other history.
    expect(_inboxSnapshot().events.some((e) => e.nodeId === 'ask')).toBe(false)
  })

  it('still bounds plain history to the cap (only the load-bearing extras survive)', () => {
    pushDone('slow', 'Slow node finished') // one protected out-of-window survivor
    for (let i = 0; i < INBOX_EVENTS_CAP + 10; i++) pushDone('busy', `busy turn ${i}`)

    const events = _inboxSnapshot().events
    const busy = events.filter((e) => e.nodeId === 'busy')
    // The busy node's own history is still capped — the oldest turns fell off the front.
    expect(busy).toHaveLength(INBOX_EVENTS_CAP)
    expect(busy.some((e) => e.detail === 'busy turn 0')).toBe(false)
    expect(busy[busy.length - 1].detail).toBe(`busy turn ${INBOX_EVENTS_CAP + 9}`)
    // Total = the CAP window + the single protected survivor, not unbounded growth.
    expect(events).toHaveLength(INBOX_EVENTS_CAP + 1)
  })

  it('trimInboxFeed (pure): drops resolved asks & old history, keeps newest done + unresolved ask', () => {
    const mk = (id: string, nodeId: string, kind: InboxEvent['kind'], resolved?: boolean): InboxEvent => ({
      id,
      ts: Number(id.split('-')[0]),
      nodeId,
      kind,
      title: id,
      ...(resolved ? { resolved: true } : {})
    })
    // oldest→newest; cap 3 keeps the last 3 wholesale, older survive only if protected.
    const feed = [
      mk('1-1', 'A', 'approval', true), // resolved ask, out of window → DROP
      mk('2-1', 'B', 'question'), // unresolved ask, out of window → KEEP
      mk('3-1', 'C', 'done'), // newest done for C, out of window → KEEP
      mk('4-1', 'D', 'done'),
      mk('5-1', 'D', 'done'),
      mk('6-1', 'D', 'done')
    ]
    const kept = trimInboxFeed(feed, 3)
    expect(kept.map((e) => e.id)).toEqual(['2-1', '3-1', '4-1', '5-1', '6-1'])
    // A no-op below the cap returns the same reference (order untouched).
    const small = [mk('1-1', 'A', 'done')]
    expect(trimInboxFeed(small, 3)).toBe(small)
  })
})

describe('ackDone (read-a-finished-session)', () => {
  beforeEach(() => _resetForTest())
  afterEach(() => _resetForTest())

  /** Drive a node to a done inbox event. */
  function toDone(nodeId: string): void {
    recordAgentEvent(ev({ nodeId, state: 'working', newTurn: true }))
    recordAgentEvent(ev({ nodeId, state: 'done', lastMessage: 'All done.' }))
  }

  it('resolves the done event and fires one end/ack seam', () => {
    const changes: NodeStateChange[] = []
    const unsub = onNodeStateChange((c) => changes.push(c))
    toDone('n1')
    // Seams so far: working 'start' + done 'end' (the natural turn-end). Snapshot the count.
    const before = changes.length
    expect(_inboxSnapshot().events[0].resolved).toBeUndefined()

    ackDone('n1')

    const ib = _inboxSnapshot()
    expect(ib.events).toHaveLength(1)
    expect(ib.events[0].kind).toBe('done')
    expect(ib.events[0].resolved).toBe(true)
    // Exactly one new seam, an ack 'end' carrying identity from the done event.
    expect(changes.length).toBe(before + 1)
    expect(changes[changes.length - 1]).toMatchObject({
      nodeId: 'n1',
      event: 'end',
      state: 'done',
      ack: true,
      agentId: 'claude'
    })
    unsub()
  })

  it('is idempotent — a second ack resolves nothing new and fires no seam', () => {
    toDone('n1')
    ackDone('n1')
    const changes: NodeStateChange[] = []
    const unsub = onNodeStateChange((c) => changes.push(c))
    ackDone('n1') // already resolved
    expect(changes).toHaveLength(0)
    expect(_inboxSnapshot().events[0].resolved).toBe(true)
    unsub()
  })

  it('no-ops for a node with no unresolved done event (working focus / unknown node)', () => {
    const changes: NodeStateChange[] = []
    const unsub = onNodeStateChange((c) => changes.push(c))
    // A node that is only working (no done yet) — the renderer gate should prevent this, but the
    // mirror must be defensive: no seam, nothing to resolve.
    recordAgentEvent(ev({ nodeId: 'w', state: 'working', newTurn: true }))
    changes.length = 0
    ackDone('w')
    ackDone('nope') // unknown node
    expect(changes).toHaveLength(0)
    unsub()
  })

  it('resolves done ONLY — leaves an unrelated node and approval/question events untouched', () => {
    toDone('n1')
    // A separate node sitting on an approval card.
    recordAgentEvent(ev({ nodeId: 'n2', state: 'working', newTurn: true }))
    recordAgentEvent(ev({ nodeId: 'n2', state: 'blocked', lastMessage: 'Approve?' }))
    ackDone('n1')
    const events = _inboxSnapshot().events
    const done = events.find((e) => e.nodeId === 'n1')
    const approval = events.find((e) => e.nodeId === 'n2')
    expect(done?.resolved).toBe(true)
    expect(approval?.kind).toBe('approval')
    expect(approval?.resolved).toBeUndefined() // approval NOT touched by a done-ack
  })

  it('resolves the newest done and carries its identity', () => {
    // Two finished turns on one node → two done events; ack resolves both, seam uses the newest.
    recordAgentEvent(ev({ nodeId: 'n1', state: 'working', newTurn: true }))
    recordAgentEvent(ev({ nodeId: 'n1', state: 'done', sessionId: 's1' }))
    recordAgentEvent(ev({ nodeId: 'n1', state: 'working', newTurn: true }))
    recordAgentEvent(ev({ nodeId: 'n1', state: 'done', sessionId: 's2' }))
    const changes: NodeStateChange[] = []
    const unsub = onNodeStateChange((c) => changes.push(c))
    ackDone('n1')
    const dones = _inboxSnapshot().events.filter((e) => e.kind === 'done')
    expect(dones).toHaveLength(2)
    expect(dones.every((e) => e.resolved)).toBe(true)
    expect(changes).toHaveLength(1)
    expect(changes[0].sessionId).toBe('s2') // newest done's identity
    unsub()
  })
})

describe('activity mapping (toolActivity + recordRawToolEvent)', () => {
  beforeEach(() => _resetForTest())
  afterEach(() => _resetForTest())

  it('maps each tool to its activity line', () => {
    expect(toolActivity('Edit', { file_path: '/a/b/foo.ts' })).toBe('Editing foo.ts')
    expect(toolActivity('Write', { file_path: 'x/bar.py' })).toBe('Editing bar.py')
    expect(toolActivity('NotebookEdit', { notebook_path: '/n/nb.ipynb' })).toBe('Editing nb.ipynb')
    expect(toolActivity('Read', { file_path: '/a/baz.md' })).toBe('Reading baz.md')
    expect(toolActivity('Bash', { command: 'npm test' })).toBe('Running npm test')
    expect(toolActivity('Grep', { pattern: 'foo.*bar' })).toBe('Searching foo.*bar')
    expect(toolActivity('Glob', { pattern: '**/*.ts' })).toBe('Searching **/*.ts')
    expect(toolActivity('Task', { description: 'refactor auth' })).toBe('Delegating: refactor auth')
    expect(toolActivity('WebFetch', { url: 'https://example.com/x?q=1' })).toBe('Fetching example.com')
    expect(toolActivity('WebSearch', { query: 'weather today' })).toBe('Fetching weather today')
    expect(toolActivity('CustomThing', {})).toBe('Using CustomThing')
  })

  it('truncates a long Bash command', () => {
    const long = 'echo ' + 'a'.repeat(200)
    const out = toolActivity('Bash', { command: long })
    expect(out.startsWith('Running ')).toBe(true)
    expect(out.length).toBeLessThanOrEqual('Running '.length + 60)
    expect(out.endsWith('…')).toBe(true)
  })

  it('records activity on PreToolUse and clears it on Stop/SessionEnd', () => {
    recordRawToolEvent('n1', { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls -la' } })
    expect(_inboxSnapshot().nodes.n1).toMatchObject({ activity: 'Running ls -la', tool: 'Bash' })
    recordRawToolEvent('n1', { hook_event_name: 'Stop' })
    expect(_inboxSnapshot().nodes.n1.activity).toBeUndefined()

    recordRawToolEvent('n2', { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: 'a.ts' } })
    recordRawToolEvent('n2', { hook_event_name: 'SessionEnd' })
    expect(_inboxSnapshot().nodes.n2.activity).toBeUndefined()
  })

  it('a done event clears live activity but keeps context %', () => {
    recordRawToolEvent('n3', { hook_event_name: 'PreToolUse', tool_name: 'Grep', tool_input: { pattern: 'x' } })
    recordContextUsage('n3', 30)
    expect(_inboxSnapshot().nodes.n3).toMatchObject({ activity: 'Searching x', contextPercent: 30 })
    recordAgentEvent(ev({ nodeId: 'n3', state: 'working', newTurn: true }))
    recordAgentEvent(ev({ nodeId: 'n3', state: 'done' }))
    const n3 = _inboxSnapshot().nodes.n3
    expect(n3.activity).toBeUndefined()
    expect(n3.contextPercent).toBe(30)
  })

  it('recordContextUsage clamps to 0–100 and coexists with activity', () => {
    recordContextUsage('c', 42.5)
    expect(_inboxSnapshot().nodes.c.contextPercent).toBe(42.5)
    recordContextUsage('c', 150)
    expect(_inboxSnapshot().nodes.c.contextPercent).toBe(100)
    recordRawToolEvent('c', { hook_event_name: 'PreToolUse', tool_name: 'Glob', tool_input: { pattern: '*.md' } })
    expect(_inboxSnapshot().nodes.c).toMatchObject({ activity: 'Searching *.md', contextPercent: 100 })
  })

  it('firstLine takes the first non-empty line and clips', () => {
    expect(firstLine('  \n\n hello there \nmore', 100)).toBe('hello there')
    expect(firstLine('abcdefghij', 5)).toBe('abcd…')
    expect(firstLine(undefined, 10)).toBe('')
  })
})

// ---- interactive-push-live-activities -------------------------------------------------------

describe('question options (AskUserQuestion)', () => {
  beforeEach(() => _resetForTest())
  afterEach(() => _resetForTest())

  const q1 = (opts: unknown[]) => ({ questions: [{ options: opts }] })

  it('extracts ≤4 labels clipped to 60, first question only, fail-open on bad shape', () => {
    expect(extractQuestionOptions(q1([{ label: 'Dark' }, { label: 'Light' }]))).toEqual(['Dark', 'Light'])
    // clips each label to 60
    const long = 'x'.repeat(100)
    expect(extractQuestionOptions(q1([{ label: long }]))![0]).toBe('x'.repeat(59) + '…')
    // caps at 4
    expect(extractQuestionOptions(q1([1, 2, 3, 4, 5].map((n) => ({ label: `o${n}` })))))
      .toEqual(['o1', 'o2', 'o3', 'o4'])
    // only the FIRST question's options
    expect(
      extractQuestionOptions({ questions: [{ options: [{ label: 'A' }] }, { options: [{ label: 'B' }] }] })
    ).toEqual(['A'])
    // fail-open on every shape mismatch
    expect(extractQuestionOptions(undefined)).toBeUndefined()
    expect(extractQuestionOptions({})).toBeUndefined()
    expect(extractQuestionOptions({ questions: [] })).toBeUndefined()
    expect(extractQuestionOptions(q1([]))).toBeUndefined()
    expect(extractQuestionOptions(q1([{ nope: 1 }]))).toBeUndefined()
    expect(extractQuestionOptions({ questions: 'x' } as unknown as Record<string, unknown>)).toBeUndefined()
  })

  it('stashes options on the raw AskUserQuestion hook and attaches them to the next question', () => {
    recordRawToolEvent('n1', {
      hook_event_name: 'PreToolUse',
      tool_name: 'AskUserQuestion',
      tool_input: q1([{ label: 'Dark' }, { label: 'Light' }, { label: 'System' }])
    })
    recordAgentEvent(ev({ nodeId: 'n1', state: 'waiting', lastMessage: 'Pick a theme' }))
    const q = _inboxSnapshot().events.find((e) => e.nodeId === 'n1' && e.kind === 'question')!
    expect(q.options).toEqual(['Dark', 'Light', 'System'])
  })

  it('a plain question (no AskUserQuestion) carries no options', () => {
    recordAgentEvent(ev({ nodeId: 'n2', state: 'waiting', lastMessage: 'Which file?' }))
    expect(_inboxSnapshot().events.find((e) => e.nodeId === 'n2')!.options).toBeUndefined()
  })

  it('extracts the first question text, clipped to 120, fail-open on bad shape', () => {
    expect(extractQuestionText({ questions: [{ question: 'Which theme?' }] })).toBe('Which theme?')
    // only the first question
    expect(extractQuestionText({ questions: [{ question: 'A?' }, { question: 'B?' }] })).toBe('A?')
    // clips to 120
    const long = 'x'.repeat(200)
    const out = extractQuestionText({ questions: [{ question: long }] })!
    expect(out.length).toBe(120)
    expect(out.endsWith('…')).toBe(true)
    // fail-open
    expect(extractQuestionText(undefined)).toBeUndefined()
    expect(extractQuestionText({})).toBeUndefined()
    expect(extractQuestionText({ questions: [] })).toBeUndefined()
    expect(extractQuestionText({ questions: [{ options: [] }] })).toBeUndefined()
  })

  // Stash-priority classification (fixes: AskUserQuestion always shown as an approval on the
  // phone). A pending picker reaches us as a permission-style `blocked`; a fresh stash reclassifies
  // it as a question with its options and the real question text, and suppresses the hook ticket.
  it('a blocked edge WITH a stash becomes a question (options + question-text title + NO pendingId)', () => {
    recordRawToolEvent('n3', {
      hook_event_name: 'PreToolUse',
      tool_name: 'AskUserQuestion',
      tool_input: { questions: [{ question: 'Which theme?', options: [{ label: 'Dark' }, { label: 'Light' }] }] }
    })
    // The CLI signals the picker as a permission-style blocked carrying a held-hook pendingId.
    recordAgentEvent(ev({ nodeId: 'n3', state: 'blocked', lastMessage: 'Approve?', pendingId: 'n3-1-1' }))
    const e = _inboxSnapshot().events.find((x) => x.nodeId === 'n3')!
    expect(e.kind).toBe('question')
    expect(e.options).toEqual(['Dark', 'Light'])
    expect(e.title).toBe('Which theme?') // question text, not the lastMessage / generic
    expect('pendingId' in e).toBe(false) // suppressed — approve/deny on a question is wrong UX
  })

  it('a blocked edge WITHOUT a stash stays an approval with no options (unchanged)', () => {
    recordAgentEvent(ev({ nodeId: 'n3b', state: 'blocked', lastMessage: 'Approve write' }))
    const e = _inboxSnapshot().events.find((x) => x.nodeId === 'n3b')!
    expect(e.kind).toBe('approval')
    expect(e.options).toBeUndefined()
  })

  it('a stash-blocked question with no question text falls back to the lastMessage title', () => {
    recordRawToolEvent('n3c', {
      hook_event_name: 'PreToolUse',
      tool_name: 'AskUserQuestion',
      tool_input: q1([{ label: 'A' }]) // options only, no `question`
    })
    recordAgentEvent(ev({ nodeId: 'n3c', state: 'blocked', lastMessage: 'Pick something' }))
    const e = _inboxSnapshot().events.find((x) => x.nodeId === 'n3c')!
    expect(e.kind).toBe('question')
    expect(e.title).toBe('Pick something')
    expect(e.options).toEqual(['A'])
  })

  it('ignores a stale stash (older than STASH_MAX_AGE_MS) — a later blocked stays an approval', () => {
    const spy = vi.spyOn(Date, 'now')
    spy.mockReturnValue(1_000_000)
    recordRawToolEvent('n3d', {
      hook_event_name: 'PreToolUse',
      tool_name: 'AskUserQuestion',
      tool_input: { questions: [{ question: 'Q', options: [{ label: 'A' }] }] }
    })
    // Jump past the freshness window before an UNRELATED approval fires.
    spy.mockReturnValue(1_000_000 + STASH_MAX_AGE_MS + 1)
    recordAgentEvent(ev({ nodeId: 'n3d', state: 'blocked', lastMessage: 'Approve rm -rf', pendingId: 'p' }))
    const e = _inboxSnapshot().events.find((x) => x.nodeId === 'n3d')!
    expect(e.kind).toBe('approval')
    expect(e.options).toBeUndefined()
    expect(e.pendingId).toBe('p') // a real approval keeps its held-hook ticket
    spy.mockRestore()
  })

  it('clears the stash when the node leaves waiting (no reuse on a later question)', () => {
    recordRawToolEvent('n4', {
      hook_event_name: 'PreToolUse',
      tool_name: 'AskUserQuestion',
      tool_input: q1([{ label: 'A' }])
    })
    recordAgentEvent(ev({ nodeId: 'n4', state: 'waiting', lastMessage: 'Q1' }))
    recordAgentEvent(ev({ nodeId: 'n4', state: 'working' })) // leaves waiting → clears stash
    recordAgentEvent(ev({ nodeId: 'n4', state: 'waiting', lastMessage: 'Q2' }))
    const qs = _inboxSnapshot().events.filter((e) => e.nodeId === 'n4' && e.kind === 'question')
    expect(qs[qs.length - 1].options).toBeUndefined()
  })

  it('clears the stash on a new turn', () => {
    recordRawToolEvent('n5', {
      hook_event_name: 'PreToolUse',
      tool_name: 'AskUserQuestion',
      tool_input: q1([{ label: 'A' }])
    })
    recordAgentEvent(ev({ nodeId: 'n5', state: 'working', newTurn: true })) // new turn clears
    recordAgentEvent(ev({ nodeId: 'n5', state: 'waiting', lastMessage: 'Q' }))
    expect(_inboxSnapshot().events.find((e) => e.nodeId === 'n5' && e.kind === 'question')!.options).toBeUndefined()
  })
})

// The enrichment recordAgentEvent RETURNS is what the shells broadcast to the canvas — the single
// source of truth for the approve/deny gate (field report: buttons showed during AskUserQuestion).
describe('recordAgentEvent enrichment (returned broadcast event)', () => {
  beforeEach(() => _resetForTest())
  afterEach(() => _resetForTest())

  it('a stash-classified question strips pendingId and gains askKind:question', () => {
    recordRawToolEvent('e1', {
      hook_event_name: 'PreToolUse',
      tool_name: 'AskUserQuestion',
      tool_input: { questions: [{ question: 'Which theme?', options: [{ label: 'Dark' }, { label: 'Light' }] }] }
    })
    // The CLI signals the picker as a permission-style blocked carrying a held-hook pendingId.
    const out = recordAgentEvent(ev({ nodeId: 'e1', state: 'blocked', pendingId: 'e1-1-1' }))
    expect(out.state).toBe('blocked')
    expect(out.askKind).toBe('question')
    expect(out.pendingId).toBeUndefined() // suppressed — approve/deny on a question is wrong UX
  })

  it('a genuine approval keeps its pendingId and gains askKind:approval', () => {
    const out = recordAgentEvent(ev({ nodeId: 'e2', state: 'blocked', pendingId: 'e2-1-1' }))
    expect(out.state).toBe('blocked')
    expect(out.askKind).toBe('approval')
    expect(out.pendingId).toBe('e2-1-1')
  })

  it('a plain waiting (no stash) is a question with no options and no pendingId', () => {
    const out = recordAgentEvent(ev({ nodeId: 'e3', state: 'waiting', lastMessage: 'Pick one' }))
    expect(out.askKind).toBe('question')
    expect(out.pendingId).toBeUndefined()
  })

  it('non-needs-you events pass through untouched (no askKind added)', () => {
    const working = ev({ nodeId: 'e4', state: 'working', newTurn: true })
    const outW = recordAgentEvent(working)
    expect(outW).toBe(working) // same reference — nothing to enrich
    expect('askKind' in outW).toBe(false)
    const outD = recordAgentEvent(ev({ nodeId: 'e4', state: 'done', lastMessage: 'done' }))
    expect(outD.askKind).toBeUndefined()
    const outS = recordAgentEvent(ev({ nodeId: 'e4', kind: 'session', sessionPhase: 'end' }))
    expect(outS.askKind).toBeUndefined()
  })

  it('enrichment does not mutate the caller-supplied event', () => {
    recordRawToolEvent('e5', {
      hook_event_name: 'PreToolUse',
      tool_name: 'AskUserQuestion',
      tool_input: { questions: [{ options: [{ label: 'A' }] }] }
    })
    const original = ev({ nodeId: 'e5', state: 'blocked', pendingId: 'e5-1-1' })
    const out = recordAgentEvent(original)
    expect(original.pendingId).toBe('e5-1-1') // unchanged
    expect(original.askKind).toBeUndefined() // unchanged
    expect(out).not.toBe(original) // enriched is a copy
  })
})

// ---- multiSelect (rides the AskUserQuestion pipeline) ---------------------------------------

describe('question multiSelect (AskUserQuestion)', () => {
  beforeEach(() => _resetForTest())
  afterEach(() => _resetForTest())

  const qms = (multiSelect: unknown) => ({
    questions: [{ question: 'Pick', options: [{ label: 'A' }, { label: 'B' }], multiSelect }]
  })

  it('extracts the tolerant boolean, undefined on absence/non-boolean/bad shape', () => {
    expect(extractQuestionMultiSelect(qms(true))).toBe(true)
    expect(extractQuestionMultiSelect(qms(false))).toBe(false)
    // absent multiSelect key → undefined
    expect(extractQuestionMultiSelect({ questions: [{ options: [{ label: 'A' }] }] })).toBeUndefined()
    // non-boolean is tolerated as undefined (never coerced)
    expect(extractQuestionMultiSelect(qms('yes'))).toBeUndefined()
    expect(extractQuestionMultiSelect(qms(1))).toBeUndefined()
    // only the FIRST question's flag
    expect(
      extractQuestionMultiSelect({ questions: [{ multiSelect: true }, { multiSelect: false }] })
    ).toBe(true)
    // fail-open on every shape mismatch
    expect(extractQuestionMultiSelect(undefined)).toBeUndefined()
    expect(extractQuestionMultiSelect({})).toBeUndefined()
    expect(extractQuestionMultiSelect({ questions: [] })).toBeUndefined()
    expect(extractQuestionMultiSelect({ questions: 'x' } as unknown as Record<string, unknown>)).toBeUndefined()
  })

  it('stashes multiSelect and attaches it to the next question event', () => {
    recordRawToolEvent('n1', {
      hook_event_name: 'PreToolUse',
      tool_name: 'AskUserQuestion',
      tool_input: qms(true)
    })
    recordAgentEvent(ev({ nodeId: 'n1', state: 'waiting', lastMessage: 'Pick some' }))
    const q = _inboxSnapshot().events.find((e) => e.nodeId === 'n1' && e.kind === 'question')!
    expect(q.options).toEqual(['A', 'B'])
    expect(q.multiSelect).toBe(true)
  })

  it('omits multiSelect from the event when the flag is false', () => {
    recordRawToolEvent('n2', {
      hook_event_name: 'PreToolUse',
      tool_name: 'AskUserQuestion',
      tool_input: qms(false)
    })
    recordAgentEvent(ev({ nodeId: 'n2', state: 'waiting', lastMessage: 'Pick one' }))
    const q = _inboxSnapshot().events.find((e) => e.nodeId === 'n2')!
    expect(q.options).toEqual(['A', 'B'])
    expect('multiSelect' in q).toBe(false)
  })

  it('omits multiSelect for a plain question and for an approval (no stash)', () => {
    recordAgentEvent(ev({ nodeId: 'q', state: 'waiting', lastMessage: 'Which file?' }))
    recordAgentEvent(ev({ nodeId: 'a', state: 'blocked', lastMessage: 'Approve write' }))
    expect('multiSelect' in _inboxSnapshot().events.find((e) => e.nodeId === 'q')!).toBe(false)
    expect('multiSelect' in _inboxSnapshot().events.find((e) => e.nodeId === 'a')!).toBe(false)
  })

  it('rides a stash-reclassified blocked edge (options force question) and survives a PermissionRequest merge', () => {
    recordRawToolEvent('n3', {
      hook_event_name: 'PreToolUse',
      tool_name: 'AskUserQuestion',
      tool_input: qms(true)
    })
    // A PermissionRequest for the same picker merges onto the stash — multiSelect must survive.
    recordRawToolEvent('n3', {
      hook_event_name: 'PermissionRequest',
      tool_name: 'AskUserQuestion',
      tool_input: qms(true)
    })
    recordAgentEvent(ev({ nodeId: 'n3', state: 'blocked', lastMessage: 'Approve?', pendingId: 'n3-1-1' }))
    const e = _inboxSnapshot().events.find((x) => x.nodeId === 'n3')!
    expect(e.kind).toBe('question')
    expect(e.multiSelect).toBe(true)
  })

  it('clears multiSelect with the stash when the node leaves waiting', () => {
    recordRawToolEvent('n4', {
      hook_event_name: 'PreToolUse',
      tool_name: 'AskUserQuestion',
      tool_input: qms(true)
    })
    recordAgentEvent(ev({ nodeId: 'n4', state: 'waiting', lastMessage: 'Q1' }))
    recordAgentEvent(ev({ nodeId: 'n4', state: 'working' })) // leaves waiting → clears stash
    recordAgentEvent(ev({ nodeId: 'n4', state: 'waiting', lastMessage: 'Q2' }))
    const qs = _inboxSnapshot().events.filter((e) => e.nodeId === 'n4' && e.kind === 'question')
    expect('multiSelect' in qs[qs.length - 1]).toBe(false)
  })

  it('the onNodeStateChange needsYou edge carries multiSelect (present true / omitted false)', () => {
    const seen: NodeStateChange[] = []
    const unsub = onNodeStateChange((c) => seen.push(c))
    recordRawToolEvent('n5', {
      hook_event_name: 'PreToolUse',
      tool_name: 'AskUserQuestion',
      tool_input: qms(true)
    })
    recordAgentEvent(ev({ nodeId: 'n5', state: 'waiting', lastMessage: 'Pick some' }))
    const ny = seen.find((c) => c.nodeId === 'n5' && c.state === 'needsYou')!
    expect(ny.kind).toBe('question')
    expect(ny.multiSelect).toBe(true)

    // A false flag is omitted from the edge.
    recordRawToolEvent('n6', {
      hook_event_name: 'PreToolUse',
      tool_name: 'AskUserQuestion',
      tool_input: qms(false)
    })
    recordAgentEvent(ev({ nodeId: 'n6', state: 'waiting', lastMessage: 'Pick one' }))
    const ny2 = seen.find((c) => c.nodeId === 'n6' && c.state === 'needsYou')!
    expect(ny2.kind).toBe('question')
    expect('multiSelect' in ny2).toBe(false)
    unsub()
  })
})

// ---- Approval summary (PermissionRequest → "what's being approved") -------------------------

describe('buildApprovalSummary (builder table)', () => {
  it('summarizes each tool family with a title + detail', () => {
    // Edit: title from basename, detail = path with rough +added/−removed line counts.
    expect(buildApprovalSummary('Edit', { file_path: 'src/components/App.tsx', old_string: 'a\nb', new_string: 'x\ny\nz' }))
      .toEqual({ title: 'Edit App.tsx', detail: 'src/components/App.tsx +3 −2' })
    // NotebookEdit shares the Edit shape (notebook_path / *_source fallbacks).
    expect(buildApprovalSummary('NotebookEdit', { notebook_path: '/n/nb.ipynb', old_source: '', new_source: 'one' }))
      .toEqual({ title: 'Edit nb.ipynb', detail: '/n/nb.ipynb +1 −0' })
    // Write: line count of content.
    expect(buildApprovalSummary('Write', { file_path: 'x/bar.py', content: 'l1\nl2\nl3' }))
      .toEqual({ title: 'Write bar.py', detail: 'x/bar.py (3 lines)' })
    // Read: detail is the path.
    expect(buildApprovalSummary('Read', { file_path: '/a/baz.md' })).toEqual({ title: 'Read baz.md', detail: '/a/baz.md' })
    // Bash: generic title, command as detail.
    expect(buildApprovalSummary('Bash', { command: 'npm test' })).toEqual({ title: 'Run command', detail: 'npm test' })
    // Bash multiline: first line + " …".
    expect(buildApprovalSummary('Bash', { command: 'cd x\nnpm test' })).toEqual({ title: 'Run command', detail: 'cd x …' })
    // WebFetch: host in title, url in detail.
    expect(buildApprovalSummary('WebFetch', { url: 'https://example.com/x?q=1' }))
      .toEqual({ title: 'Fetch example.com', detail: 'https://example.com/x?q=1' })
    // WebSearch: fixed title, query in detail.
    expect(buildApprovalSummary('WebSearch', { query: 'weather today' })).toEqual({ title: 'Search', detail: 'weather today' })
    // Task: subagent launch.
    expect(buildApprovalSummary('Task', { description: 'refactor auth' }))
      .toEqual({ title: 'Launch subagent', detail: 'refactor auth' })
    // mcp__ tool: short name in title, stringified input in detail.
    expect(buildApprovalSummary('mcp__claude_ai_Gmail__get_message', { id: 'm1' }))
      .toEqual({ title: 'Use get_message', detail: '{"id":"m1"}' })
    // Unknown tool: "Use <tool>" + stringified input.
    expect(buildApprovalSummary('SomethingNew', { a: 1 })).toEqual({ title: 'Use SomethingNew', detail: '{"a":1}' })
  })

  it('clips title ≤120 and detail ≤240', () => {
    const longName = 'x'.repeat(300)
    const s = buildApprovalSummary('Read', { file_path: longName })!
    expect(s.title.length).toBe(120)
    expect(s.title.endsWith('…')).toBe(true)
    expect(s.detail!.length).toBe(240)
    expect(s.detail!.endsWith('…')).toBe(true)
  })

  it('fails open (no stash) on an empty tool name or a degenerate detail', () => {
    expect(buildApprovalSummary('', { file_path: 'x' })).toBeUndefined()
    // Missing path → title kept, degenerate detail dropped (no path to show).
    expect(buildApprovalSummary('Read', {})).toEqual({ title: 'Read file' })
    expect(buildApprovalSummary('Edit', {})).toEqual({ title: 'Edit file' })
    // Unknown tool with empty input → no useful detail.
    expect(buildApprovalSummary('Weird', {})).toEqual({ title: 'Use Weird' })
    // Garbage tool_input types don't throw.
    expect(buildApprovalSummary('Bash', { command: 42 } as unknown as Record<string, unknown>))
      .toEqual({ title: 'Run command' })
  })
})

describe('approval summary stash (PermissionRequest → approval card)', () => {
  beforeEach(() => _resetForTest())
  afterEach(() => _resetForTest())

  // A PermissionRequest raw hook stashes the summary; the following blocked event picks it up.
  function permReq(nodeId: string, toolName: string, toolInput: Record<string, unknown>): void {
    recordRawToolEvent(nodeId, { hook_event_name: 'PermissionRequest', tool_name: toolName, tool_input: toolInput })
  }

  it('titles + details a blocked approval from the stashed summary (title + detail precedence)', () => {
    recordAgentEvent(ev({ state: 'working', newTurn: true }))
    permReq('n1', 'Edit', { file_path: 'src/components/App.tsx', old_string: 'a\nb', new_string: 'x\ny' })
    recordAgentEvent(ev({ state: 'blocked', lastMessage: 'Claude wants to edit a file', pendingId: 'n1-1-1' }))
    const e = _inboxSnapshot().events.find((x) => x.nodeId === 'n1')!
    expect(e.kind).toBe('approval')
    expect(e.title).toBe('Edit App.tsx') // stashed title beats the lastMessage
    expect(e.detail).toBe('src/components/App.tsx +2 −2')
    expect(e.pendingId).toBe('n1-1-1') // a real approval keeps its held-hook ticket
  })

  it('falls back to lastMessage then generic when there is no stash (detail dropped when == title)', () => {
    recordAgentEvent(ev({ nodeId: 'a', state: 'blocked', lastMessage: 'Approve write to /etc/hosts' }))
    recordAgentEvent(ev({ nodeId: 'b', state: 'blocked' }))
    const evs = _inboxSnapshot().events
    const a = evs.find((x) => x.nodeId === 'a')!
    expect(a.title).toBe('Approve write to /etc/hosts')
    expect(a.detail).toBeUndefined() // detail equal to the title (both from lastMessage) is dropped
    expect(evs.find((x) => x.nodeId === 'b')!.title).toBe('Needs approval')
  })

  it('does not misclassify an approval stash as a question (options are the only question signal)', () => {
    permReq('n2', 'Bash', { command: 'rm -rf /tmp/x' })
    recordAgentEvent(ev({ nodeId: 'n2', state: 'blocked', lastMessage: 'Approve?', pendingId: 'p' }))
    const e = _inboxSnapshot().events.find((x) => x.nodeId === 'n2')!
    expect(e.kind).toBe('approval')
    expect(e.options).toBeUndefined()
    expect(e.title).toBe('Run command')
    expect(e.detail).toBe('rm -rf /tmp/x')
  })

  it('leaves the question stash untouched — an AskUserQuestion still classifies as a question', () => {
    recordRawToolEvent('n3', {
      hook_event_name: 'PreToolUse',
      tool_name: 'AskUserQuestion',
      tool_input: { questions: [{ question: 'Which theme?', options: [{ label: 'Dark' }, { label: 'Light' }] }] }
    })
    // Even if a PermissionRequest for the AskUserQuestion tool itself also fires, options win.
    permReq('n3', 'AskUserQuestion', { questions: [{ question: 'Which theme?', options: [{ label: 'Dark' }] }] })
    recordAgentEvent(ev({ nodeId: 'n3', state: 'blocked', lastMessage: 'Approve?', pendingId: 'n3-1-1' }))
    const e = _inboxSnapshot().events.find((x) => x.nodeId === 'n3')!
    expect(e.kind).toBe('question')
    expect(e.options).toEqual(['Dark', 'Light'])
    expect(e.title).toBe('Which theme?')
    expect('pendingId' in e).toBe(false)
    expect(e.detail).toBeUndefined()
  })
})

describe('onNodeStateChange seam', () => {
  beforeEach(() => _resetForTest())
  afterEach(() => _resetForTest())

  it('fires start on working, needsYou on blocked/waiting, end on done — with the mapped messages', () => {
    const seen: NodeStateChange[] = []
    onNodeStateChange((c) => seen.push(c))
    recordAgentEvent(ev({ state: 'working', newTurn: true }))
    recordAgentEvent(ev({ state: 'blocked', lastMessage: 'Approve write' }))
    recordAgentEvent(ev({ state: 'working' })) // resume — an edge back into working
    recordAgentEvent(ev({ state: 'done', lastMessage: 'Wrapped up.' }))
    expect(seen.map((c) => [c.event, c.state])).toEqual([
      ['start', 'working'],
      ['update', 'needsYou'],
      ['start', 'working'],
      ['end', 'done']
    ])
    expect(seen[1].message).toBe('Approve write')
    expect(seen[3].message).toBe('Finished')
  })

  it('folds the stashed approval summary into the needsYou message (title — detail)', () => {
    const seen: NodeStateChange[] = []
    onNodeStateChange((c) => seen.push(c))
    recordAgentEvent(ev({ state: 'working', newTurn: true }))
    recordRawToolEvent('n1', {
      hook_event_name: 'PermissionRequest',
      tool_name: 'Edit',
      tool_input: { file_path: 'src/components/App.tsx', old_string: 'a\nb', new_string: 'x\ny' }
    })
    recordAgentEvent(ev({ state: 'blocked', lastMessage: 'Claude wants to edit a file', pendingId: 'n1-1-1' }))
    const nu = seen.find((c) => c.state === 'needsYou')!
    // Consistent with the inbox card (title + detail) so Live Activities / push alerts read the same.
    expect(nu.message).toBe('Edit App.tsx — src/components/App.tsx +2 −2')
    expect(nu.kind).toBe('approval')
    expect(nu.pendingId).toBe('n1-1-1')
    const card = _inboxSnapshot().events.find((x) => x.nodeId === 'n1')!
    expect(card.title).toBe('Edit App.tsx')
    expect(card.detail).toBe('src/components/App.tsx +2 −2')
  })

  it('maps waiting to needsYou and titles interrupted done "Stopped"', () => {
    const seen: NodeStateChange[] = []
    onNodeStateChange((c) => seen.push(c))
    recordAgentEvent(ev({ nodeId: 'q', state: 'waiting', lastMessage: 'Which one?' }))
    recordAgentEvent(ev({ nodeId: 'q', state: 'working', newTurn: true }))
    recordAgentEvent(ev({ nodeId: 'q', state: 'done', interrupted: true }))
    expect(seen.find((c) => c.state === 'needsYou')!.message).toBe('Which one?')
    expect(seen.find((c) => c.state === 'done')!.message).toBe('Stopped')
  })

  it('does not refire start for a same-state working tick, nor needsYou for a re-asserted blocked', () => {
    const seen: NodeStateChange[] = []
    onNodeStateChange((c) => seen.push(c))
    recordAgentEvent(ev({ state: 'working', newTurn: true }))
    recordAgentEvent(ev({ state: 'working' })) // tool tick
    recordAgentEvent(ev({ state: 'blocked', lastMessage: 'A' }))
    recordAgentEvent(ev({ state: 'blocked', lastMessage: 'A' })) // re-assert
    expect(seen.filter((c) => c.event === 'start')).toHaveLength(1)
    expect(seen.filter((c) => c.state === 'needsYou')).toHaveLength(1)
  })

  it('does not fire a start for a held-off late working (done-holdoff)', () => {
    recordAgentEvent(ev({ state: 'working', newTurn: true }))
    recordAgentEvent(ev({ state: 'done' }))
    const seen: NodeStateChange[] = []
    onNodeStateChange((c) => seen.push(c))
    // A late, non-newTurn working within DONE_HOLDOFF_MS is held off by reduceEntry → no start.
    recordAgentEvent(ev({ state: 'working' }))
    expect(seen.filter((c) => c.event === 'start')).toHaveLength(0)
  })

  it('the needsYou edge into blocked carries kind:approval + the pendingId (from the approval event)', () => {
    const seen: NodeStateChange[] = []
    onNodeStateChange((c) => seen.push(c))
    recordAgentEvent(ev({ state: 'blocked', lastMessage: 'Approve write', pendingId: 'n1-123-9' }))
    const ny = seen.find((c) => c.state === 'needsYou')!
    expect(ny.kind).toBe('approval')
    expect(ny.pendingId).toBe('n1-123-9')
    expect('options' in ny).toBe(false)
  })

  it('an approval edge whose hook did not arm a wait omits pendingId (still kind:approval)', () => {
    const seen: NodeStateChange[] = []
    onNodeStateChange((c) => seen.push(c))
    recordAgentEvent(ev({ state: 'blocked', lastMessage: 'Approve write' }))
    const ny = seen.find((c) => c.state === 'needsYou')!
    expect(ny.kind).toBe('approval')
    expect('pendingId' in ny).toBe(false)
  })

  it('the needsYou edge into waiting carries kind:question + the stashed AskUserQuestion options', () => {
    const seen: NodeStateChange[] = []
    onNodeStateChange((c) => seen.push(c))
    recordRawToolEvent('n1', {
      hook_event_name: 'PreToolUse',
      tool_name: 'AskUserQuestion',
      tool_input: { questions: [{ options: [{ label: 'Dark' }, { label: 'Light' }, { label: 'System' }] }] }
    })
    recordAgentEvent(ev({ state: 'waiting', lastMessage: 'Pick a theme' }))
    const ny = seen.find((c) => c.state === 'needsYou')!
    expect(ny.kind).toBe('question')
    expect(ny.options).toEqual(['Dark', 'Light', 'System'])
    expect('pendingId' in ny).toBe(false)
  })

  it('a stash-blocked edge emits kind:question + options + question-text message and drops pendingId', () => {
    const seen: NodeStateChange[] = []
    onNodeStateChange((c) => seen.push(c))
    recordRawToolEvent('n1', {
      hook_event_name: 'PreToolUse',
      tool_name: 'AskUserQuestion',
      tool_input: { questions: [{ question: 'Pick a theme', options: [{ label: 'Dark' }, { label: 'Light' }] }] }
    })
    // Picker signaled as a permission-style blocked with a held-hook pendingId.
    recordAgentEvent(ev({ state: 'blocked', lastMessage: 'Approve?', pendingId: 'n1-1-1' }))
    const ny = seen.find((c) => c.state === 'needsYou')!
    expect(ny.kind).toBe('question')
    expect(ny.options).toEqual(['Dark', 'Light'])
    expect(ny.message).toBe('Pick a theme')
    expect('pendingId' in ny).toBe(false) // approval ticket suppressed on a question edge
  })

  it('a plain waiting edge (no AskUserQuestion stash) is kind:question with no options', () => {
    const seen: NodeStateChange[] = []
    onNodeStateChange((c) => seen.push(c))
    recordAgentEvent(ev({ state: 'waiting', lastMessage: 'Which one?' }))
    const ny = seen.find((c) => c.state === 'needsYou')!
    expect(ny.kind).toBe('question')
    expect('options' in ny).toBe(false)
  })

  it('working and done edges carry no kind/options/pendingId', () => {
    const seen: NodeStateChange[] = []
    onNodeStateChange((c) => seen.push(c))
    recordAgentEvent(ev({ state: 'working', newTurn: true }))
    recordAgentEvent(ev({ state: 'done', lastMessage: 'Wrapped up.' }))
    for (const c of seen) {
      expect('kind' in c).toBe(false)
      expect('options' in c).toBe(false)
      expect('pendingId' in c).toBe(false)
    }
  })
})

describe('onNodeNowChange seam', () => {
  beforeEach(() => _resetForTest())
  afterEach(() => _resetForTest())

  it('fires on an activity change and on a context change', () => {
    const seen: NodeNowChange[] = []
    onNodeNowChange((c) => seen.push(c))
    recordRawToolEvent('n1', { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } })
    recordContextUsage('n1', 55)
    expect(seen).toHaveLength(2)
    expect(seen[0]).toMatchObject({ nodeId: 'n1', activity: 'Running ls' })
    expect(seen[1]).toMatchObject({ nodeId: 'n1', contextPercent: 55 })
  })

  it('fires with activity undefined when a Stop clears the line', () => {
    const seen: NodeNowChange[] = []
    recordRawToolEvent('n2', { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: 'a.ts' } })
    onNodeNowChange((c) => seen.push(c))
    recordRawToolEvent('n2', { hook_event_name: 'Stop' })
    expect(seen).toHaveLength(1)
    expect(seen[0].activity).toBeUndefined()
  })
})

describe('buildMirrorUsage', () => {
  it('maps snapshots to accounts, system first, with defensive limit fields + labels', () => {
    const snap = [
      {
        accountId: null,
        usage: {
          email: 'sys@x',
          updatedAt: 100,
          status: 'ok',
          limits: [{ kind: 'session', usedPercent: 20, severity: 'normal', resetsAt: 999 }]
        }
      },
      {
        accountId: 'a1',
        usage: { email: null, updatedAt: 200, status: 'ok', limits: [{ kind: 'weekly_all', usedPercent: 80 }] }
      }
    ]
    const mu = buildMirrorUsage(snap, [{ id: 'a1', label: 'Work', email: 'work@x' }], 500)!
    expect(mu.accounts[0].accountId).toBeNull()
    expect(mu.accounts[0].label).toBeNull()
    expect(mu.accounts[0].email).toBe('sys@x')
    expect(mu.accounts[0].agentId).toBe('claude')
    expect(mu.accounts[0].limits[0]).toEqual({
      kind: 'session',
      group: null,
      usedPercent: 20,
      severity: 'normal',
      resetsAt: 999,
      windowMinutes: null,
      scopeLabel: null,
      isActive: false
    })
    // Managed account: label from settings, email backfilled from settings when usage has none,
    // and its limit's absent severity passes through as null (not defaulted to a colour).
    expect(mu.accounts[1]).toMatchObject({ accountId: 'a1', label: 'Work', email: 'work@x' })
    expect(mu.accounts[1].limits[0].severity).toBeNull()
    // updatedAt is the freshest account's stamp.
    expect(mu.updatedAt).toBe(200)
  })

  it('orders the system account first regardless of snapshot order', () => {
    const snap = [
      { accountId: 'a1', usage: { status: 'ok', limits: [] } },
      { accountId: null, usage: { status: 'ok', limits: [] } }
    ]
    const mu = buildMirrorUsage(snap, [], 9)!
    expect(mu.accounts.map((a) => a.accountId)).toEqual([null, 'a1'])
  })

  it('returns undefined for an empty snapshot', () => {
    expect(buildMirrorUsage([], [], 5)).toBeUndefined()
  })
})

describe('usage block on flush', () => {
  let tmpDir: string
  let file: string

  beforeEach(() => {
    _resetForTest()
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-status-usage-'))
    file = path.join(tmpDir, 'status.json')
    initAgentStatusMirror(file)
  })
  afterEach(() => {
    _resetForTest()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('writes the usage block from the provider', async () => {
    const usage: MirrorUsage = {
      updatedAt: 5,
      accounts: [
        { accountId: null, label: null, email: 'e', agentId: 'claude', status: 'ok', updatedAt: 5, limits: [] }
      ]
    }
    setMirrorUsageProvider(() => usage)
    await flush()
    const doc = JSON.parse(fs.readFileSync(file, 'utf-8'))
    expect(doc.usage.accounts[0].email).toBe('e')
  })

  it('omits usage when no provider is wired (old-file shape)', async () => {
    await flush()
    expect('usage' in JSON.parse(fs.readFileSync(file, 'utf-8'))).toBe(false)
  })

  it('a throwing usage provider fails open (no usage, file still written)', async () => {
    setMirrorUsageProvider(() => { throw new Error('boom') })
    recordAgentEvent(ev({ state: 'working' }))
    await flush()
    const doc = JSON.parse(fs.readFileSync(file, 'utf-8'))
    expect('usage' in doc).toBe(false)
    expect(doc.nodes.n1.state).toBe('working')
  })
})

describe('filterMirrorForNodes (usage + inbox)', () => {
  it('drops usage entirely and filters inbox events + nodes to the slice', () => {
    const doc = buildFile(
      { a: { state: 'working', updatedAt: 1 }, b: { state: 'done', updatedAt: 2 } },
      10,
      undefined,
      undefined,
      {
        updatedAt: 5,
        accounts: [
          { accountId: null, label: null, email: null, agentId: 'claude', status: 'ok', updatedAt: 5, limits: [] }
        ]
      },
      {
        events: [
          { id: '1', ts: 1, nodeId: 'a', kind: 'approval', title: 'A' },
          { id: '2', ts: 2, nodeId: 'b', kind: 'done', title: 'Finished' }
        ],
        nodes: { a: { activity: 'x', updatedAt: 1 }, b: { activity: 'y', updatedAt: 2 } }
      }
    )
    expect('usage' in doc).toBe(true)
    const slice = filterMirrorForNodes(doc, new Set(['a']))
    expect('usage' in slice).toBe(false)
    expect(slice.inbox!.events.map((e) => e.nodeId)).toEqual(['a'])
    expect(Object.keys(slice.inbox!.nodes)).toEqual(['a'])
  })

  it('buildFile omits an empty inbox (old-file shape preserved)', () => {
    const d = buildFile({}, 1, undefined, undefined, undefined, { events: [], nodes: {} })
    expect('inbox' in d).toBe(false)
  })
})

describe('isEventUnresolved (presence-hold flush lookup)', () => {
  beforeEach(() => _resetForTest())
  afterEach(() => _resetForTest())

  it('true for a live unresolved approval, false once the node leaves blocked', () => {
    recordAgentEvent(ev({ nodeId: 'n1', state: 'working', newTurn: true }))
    recordAgentEvent(ev({ nodeId: 'n1', state: 'blocked', lastMessage: 'Approve write' }))
    const id = _inboxSnapshot().events.find((e) => e.kind === 'approval')!.id
    expect(isEventUnresolved('n1', id)).toBe(true)
    // Leaving blocked resolves the card (resolveUnresolvedFor).
    recordAgentEvent(ev({ nodeId: 'n1', state: 'working' }))
    expect(isEventUnresolved('n1', id)).toBe(false)
  })

  it('true for an unread done, false after ackDone', () => {
    recordAgentEvent(ev({ nodeId: 'n2', state: 'working', newTurn: true }))
    recordAgentEvent(ev({ nodeId: 'n2', state: 'done', lastMessage: 'All set.' }))
    const id = _inboxSnapshot().events.find((e) => e.kind === 'done')!.id
    expect(isEventUnresolved('n2', id)).toBe(true)
    ackDone('n2')
    expect(isEventUnresolved('n2', id)).toBe(false)
  })

  it('false for an unknown event id or the wrong node', () => {
    recordAgentEvent(ev({ nodeId: 'n3', state: 'working', newTurn: true }))
    recordAgentEvent(ev({ nodeId: 'n3', state: 'blocked', lastMessage: 'Approve' }))
    const id = _inboxSnapshot().events.find((e) => e.kind === 'approval')!.id
    expect(isEventUnresolved('n3', 'no-such-id')).toBe(false)
    expect(isEventUnresolved('other-node', id)).toBe(false)
  })
})


describe('stale-working sweep (shared/agents/stale)', () => {
  it('ends a working node nobody has heard from, once, without an inbox event', () => {
    _resetForTest()
    const edges: NodeStateChange[] = []
    const un = onNodeStateChange((c) => edges.push(c))
    recordAgentEvent({
      nodeId: 'n1',
      agentId: 'claude',
      kind: 'state',
      state: 'working',
      newTurn: true,
      task: 'do a thing'
    } as never)
    const before = _inboxSnapshot().events.length
    edges.length = 0

    // Not yet stale.
    expect(sweepStaleWorking(Date.now(), 20 * 60_000)).toEqual([])
    // Nothing heard for the whole window → presumed gone.
    const swept = sweepStaleWorking(Date.now() + 21 * 60_000, 20 * 60_000)
    expect(swept).toEqual(['n1'])
    expect(edges).toHaveLength(1)
    expect(edges[0]).toMatchObject({ nodeId: 'n1', event: 'end', state: 'done', stale: true })
    // Nothing "finished", so the feed (and the push it drives) stays untouched.
    expect(_inboxSnapshot().events.length).toBe(before)
    // Idempotent: it is no longer working, so a second sweep says nothing.
    expect(sweepStaleWorking(Date.now() + 40 * 60_000, 20 * 60_000)).toEqual([])
    un()
  })

  it('self-heals — a later event puts the node back to working', () => {
    _resetForTest()
    recordAgentEvent({ nodeId: 'n2', agentId: 'claude', kind: 'state', state: 'working' } as never)
    expect(sweepStaleWorking(Date.now() + 21 * 60_000, 20 * 60_000)).toEqual(['n2'])
    expect(_snapshot().n2.state).toBe('done')
    recordAgentEvent({ nodeId: 'n2', agentId: 'claude', kind: 'state', state: 'working', newTurn: true } as never)
    expect(_snapshot().n2.state).toBe('working')
  })
})


describe('idle_prompt rescue (Esc that ran no Stop hook)', () => {
  it('moves a stuck working node off working', () => {
    const prev = reduceEntry(undefined, ev({ state: 'working' }), 1000)
    expect(prev.state).toBe('working')
    const next = reduceEntry(prev, ev({ state: 'done', idle: true, interrupted: true }), 2000)
    expect(next.state).toBe('done')
    expect(next.updatedAt).toBe(2000)
  })

  it('never clears a pending approval / question — those are idle at the prompt too', () => {
    for (const state of ['blocked', 'waiting'] as const) {
      const prev = reduceEntry(undefined, ev({ state }), 1000)
      const next = reduceEntry(prev, ev({ state: 'done', idle: true, interrupted: true }), 2000)
      expect(next.state).toBe(state)
      expect(next.updatedAt).toBe(1000) // untouched, so the freshness window keeps measuring
    }
  })

  it('is a no-op on an already-finished node (it fires after every normal turn)', () => {
    const prev = reduceEntry(undefined, ev({ state: 'done' }), 1000)
    const next = reduceEntry(prev, ev({ state: 'done', idle: true, interrupted: true }), 2000)
    expect(next.state).toBe('done')
    expect(next.updatedAt).toBe(1000)
  })

  it('marks the RESCUED done as inferred, so a consumer can tell it from a turn end', () => {
    // A node blocked on an approval is also "idle at its prompt". Messaging's gate 2 refuses this
    // shape, and it can only refuse what the entry remembers.
    const working = reduceEntry(undefined, ev({ state: 'working' }), 1000)
    const rescued = reduceEntry(working, ev({ state: 'done', idle: true }), 2000)
    expect(rescued).toMatchObject({ state: 'done', idleInferred: true })
    const genuine = reduceEntry(undefined, ev({ state: 'done' }), 1000)
    expect(genuine.idleInferred).toBeUndefined()
  })

  it('a later genuine turn-end CLEARS the marker — it describes the current state only', () => {
    const working = reduceEntry(undefined, ev({ state: 'working' }), 1000)
    const rescued = reduceEntry(working, ev({ state: 'done', idle: true }), 2000)
    expect(rescued.idleInferred).toBe(true)
    const nextTurn = reduceEntry(rescued, ev({ state: 'working', newTurn: true }), 3000)
    expect(nextTurn.idleInferred).toBeUndefined()
    const ended = reduceEntry(nextTurn, ev({ state: 'done' }), 4000)
    expect(ended.idleInferred).toBeUndefined()
  })

  it('an idle event that commits NOTHING leaves the marker alone', () => {
    // The rescue may only move a node that is still `working`; on a blocked node it returns early
    // and must not stamp a state it did not commit.
    const blocked = reduceEntry(undefined, ev({ state: 'blocked' }), 1000)
    const next = reduceEntry(blocked, ev({ state: 'done', idle: true }), 2000)
    expect(next.state).toBe('blocked')
    expect(next.idleInferred).toBeUndefined()
  })
})


describe('consecutive asks (answered on the desktop)', () => {
  it('a new ask settles the previous card and refreshes the live-update', () => {
    _resetForTest()
    const edges: NodeStateChange[] = []
    const un = onNodeStateChange((c) => edges.push(c))

    // Ask #1 — the edge into needs-you fires and a card appears.
    recordAgentEvent(ev({ nodeId: 'n1', state: 'blocked', lastMessage: 'Edit App.tsx?' }))
    const first = _inboxSnapshot().events.filter((e) => e.nodeId === 'n1' && e.kind === 'approval')
    expect(first).toHaveLength(1)
    expect(edges.filter((e) => e.state === 'needsYou')).toHaveLength(1)

    // The user answers in the terminal; the agent immediately asks something else. The node never
    // leaves `blocked`, which is exactly why the old card used to linger forever.
    edges.length = 0
    recordAgentEvent(ev({ nodeId: 'n1', state: 'blocked', lastMessage: 'Run npm test?' }))
    const cards = _inboxSnapshot().events.filter((e) => e.nodeId === 'n1' && e.kind === 'approval')
    expect(cards).toHaveLength(2)
    expect(cards.find((c) => c.title === 'Edit App.tsx?')?.resolved).toBe(true)
    expect(cards.find((c) => c.title === 'Run npm test?')?.resolved).toBeFalsy()
    // …and the Lock Screen / island is told about the CURRENT ask, not left on the answered one.
    const needs = edges.filter((e) => e.state === 'needsYou')
    expect(needs).toHaveLength(1)
    expect(needs[0].message).toContain('Run npm test?')
    un()
  })

  it('a re-asserted SAME ask still fires nothing and adds no card', () => {
    _resetForTest()
    const edges: NodeStateChange[] = []
    const un = onNodeStateChange((c) => edges.push(c))
    recordAgentEvent(ev({ nodeId: 'n2', state: 'blocked', lastMessage: 'Edit App.tsx?' }))
    edges.length = 0
    recordAgentEvent(ev({ nodeId: 'n2', state: 'blocked', lastMessage: 'Edit App.tsx?' }))
    expect(_inboxSnapshot().events.filter((e) => e.nodeId === 'n2')).toHaveLength(1)
    expect(edges.filter((e) => e.state === 'needsYou')).toHaveLength(0)
    un()
  })
})

describe('reduceEntry — codex request_user_input hold (awaitingInput)', () => {
  const ask = (): NormalizedAgentEvent =>
    ev({ agentId: 'codex', kind: 'state', state: 'waiting', awaitingInput: true })

  it('holds waiting through the turn-end done that follows an unanswered ask', () => {
    const a = reduceEntry(undefined, ask(), 1000)
    expect(a.state).toBe('waiting')
    expect(a.awaitingInput).toBe(true)
    const b = reduceEntry(a, ev({ agentId: 'codex', kind: 'state', state: 'done' }), 2000)
    expect(b.state).toBe('waiting')
    expect(b.awaitingInput).toBe(true)
  })

  it('the answer (a genuine new turn) releases the hold; the NEXT done lands normally', () => {
    let e = reduceEntry(undefined, ask(), 1000)
    e = reduceEntry(e, ev({ agentId: 'codex', kind: 'state', state: 'done' }), 2000)
    e = reduceEntry(e, ev({ agentId: 'codex', kind: 'state', state: 'working', newTurn: true }), 3000)
    expect(e.state).toBe('working')
    expect(e.awaitingInput).toBeFalsy()
    e = reduceEntry(e, ev({ agentId: 'codex', kind: 'state', state: 'done' }), 4000)
    expect(e.state).toBe('done')
  })

  it('an interrupt clears the ask (the user was right there)', () => {
    const a = reduceEntry(undefined, ask(), 1000)
    const b = reduceEntry(
      a,
      ev({ agentId: 'codex', kind: 'state', state: 'done', interrupted: true }),
      2000
    )
    expect(b.state).toBe('done')
    expect(b.awaitingInput).toBeFalsy()
  })

  it('other tool activity supersedes the ask', () => {
    const a = reduceEntry(undefined, ask(), 1000)
    const b = reduceEntry(a, ev({ agentId: 'codex', kind: 'state', state: 'working' }), 2000)
    expect(b.awaitingInput).toBeFalsy()
    const c = reduceEntry(b, ev({ agentId: 'codex', kind: 'state', state: 'done' }), 3000)
    expect(c.state).toBe('done')
  })

  it('a session boundary resets the hold', () => {
    const a = reduceEntry(undefined, ask(), 1000)
    const b = reduceEntry(a, ev({ agentId: 'codex', kind: 'session', sessionPhase: 'end' }), 2000)
    expect(b.state).toBeUndefined()
    expect(b.awaitingInput).toBeFalsy()
  })
})

describe('recordAgentEvent — codex request_user_input broadcast conversion', () => {
  let dir: string
  let file: string

  beforeEach(() => {
    _resetForTest()
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-status-'))
    file = path.join(dir, 'agent-status.json')
    initAgentStatusMirror(file)
  })

  afterEach(() => {
    _resetForTest()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('rewrites the held turn-end done to waiting, so every consumer agrees', () => {
    recordAgentEvent(ev({ agentId: 'codex', state: 'waiting', awaitingInput: true }))
    const out = recordAgentEvent(ev({ agentId: 'codex', state: 'done' }))
    expect(out.state).toBe('waiting')
    expect(_snapshot().n1.state).toBe('waiting')
  })
})

describe('workingNodes', () => {
  beforeEach(() => _resetForTest())
  afterEach(() => _resetForTest())

  it('lists only the nodes currently believed to be working, with their identity', () => {
    recordAgentEvent(ev({ nodeId: 'n1', agentId: 'claude', state: 'working', sessionId: 's1' }))
    recordAgentEvent(ev({ nodeId: 'n2', agentId: 'claude', state: 'done', sessionId: 's2' }))

    expect(workingNodes()).toEqual([{ nodeId: 'n1', agentId: 'claude', sessionId: 's1' }])
  })

  it('is empty when nothing is working', () => {
    recordAgentEvent(ev({ nodeId: 'n3', agentId: 'codex', state: 'done' }))
    expect(workingNodes()).toEqual([])
  })
})

describe('reduceEntry records whether the state transition was verified', () => {
  it('a verified state transition stamps verifiedAt and sets stateVerified', () => {
    const e = reduceEntry(undefined, ev({ state: 'done', verified: true }), 1000)
    expect(e.state).toBe('done')
    expect(e.stateVerified).toBe(true)
    expect(e.verifiedAt).toBe(1000)
  })

  it('an UNVERIFIED transition clears stateVerified — a later legacy event un-proves an earlier proof', () => {
    const a = reduceEntry(undefined, ev({ state: 'done', verified: true }), 1000)
    const b = reduceEntry(a, ev({ state: 'working', verified: false, newTurn: true }), 2000)
    expect(b.stateVerified).toBe(false)
    // verifiedAt is NOT cleared: it is "when we last saw proof", which stays true.
    expect(b.verifiedAt).toBe(1000)
  })

  it('an event that does not change state does not fabricate proof', () => {
    const a = reduceEntry(undefined, ev({ state: 'done', verified: false }), 1000)
    const b = reduceEntry(a, ev({ kind: 'context', verified: true } as never), 2000)
    expect(b.stateVerified).toBe(false)
  })

  it('a held-off late working leaves the proof of the done it did not override', () => {
    // The done-holdoff deliberately does not commit the state, so it must not restate the proof
    // either — the entry still describes the `done`, and that done WAS verified.
    const a = reduceEntry(undefined, ev({ state: 'done', verified: true }), 1000)
    const b = reduceEntry(a, ev({ state: 'working', verified: false }), 1000 + DONE_HOLDOFF_MS - 1)
    expect(b.state).toBe('done')
    expect(b.stateVerified).toBe(true)
  })

  it('a VERIFIED session boundary still drops the proof — idle is not a proven state', () => {
    // The `false` at that call site is explicit, so it needs a case where `ev.verified` is true
    // and the answer is still false; without this, passing `ev.verified === true` there would be
    // an untested equivalent. What a SessionStart proves is that a token holder started a
    // session, not that the node is idle-and-accounted-for, and gate 2 reads `done` anyway.
    const a = reduceEntry(undefined, ev({ state: 'done', verified: true }), 1000)
    const b = reduceEntry(a, ev({ kind: 'session', sessionPhase: 'start', verified: true }), 2000)
    expect(b.state).toBeUndefined()
    expect(b.stateVerified).toBe(false)
    expect(b.verifiedAt).toBe(1000)
  })

  it('a session boundary drops the proof with the state it was about', () => {
    // SessionStart/End reset the node to idle. A `stateVerified: true` left standing beside a
    // state of `undefined` would assert proof about a state that no longer exists.
    const a = reduceEntry(undefined, ev({ state: 'done', verified: true }), 1000)
    const b = reduceEntry(a, ev({ kind: 'session', sessionPhase: 'start' }), 2000)
    expect(b.state).toBeUndefined()
    expect(b.stateVerified).toBe(false)
    expect(b.verifiedAt).toBe(1000)
  })
})

describe('the request_user_input hold carries its own evidence', () => {
  // MEASURED on the first version of this PR: a verified `waiting` at t=1000 followed by a
  // TOKENLESS `done` produced { state: 'waiting', stateVerified: true, updatedAt: 2000 }. The hold
  // was the one branch that wrote `next.state` without co-writing the proof, so the label survived
  // an event that never presented a token — and since /hook/* is fail-open by contract, any caller
  // can replay that event forever, refreshing `updatedAt` so the entry never expires either.
  it('a TOKENLESS done that gets held to waiting un-proves the entry', () => {
    const a = reduceEntry(undefined, ev({ state: 'waiting', awaitingInput: true, verified: true }), 1000)
    expect(a.stateVerified).toBe(true)
    const b = reduceEntry(a, ev({ state: 'done', verified: false }), 2000)
    expect(b.state).toBe('waiting')
    expect(b.stateVerified).toBe(false)
    expect(b.verifiedAt).toBe(1000) // "we once saw proof" is still true
  })

  it('stays false however many times the tokenless event is replayed', () => {
    let e = reduceEntry(undefined, ev({ state: 'waiting', awaitingInput: true, verified: true }), 1000)
    for (let i = 0; i < 98; i++) e = reduceEntry(e, ev({ state: 'done', verified: false }), 2000 + i)
    expect(e.state).toBe('waiting')
    expect(e.stateVerified).toBe(false)
  })

  it('and a VERIFIED held done proves it — the flag tracks the event, not the branch', () => {
    const a = reduceEntry(undefined, ev({ state: 'waiting', awaitingInput: true, verified: false }), 1000)
    const b = reduceEntry(a, ev({ state: 'done', verified: true }), 2000)
    expect(b.state).toBe('waiting')
    expect(b.stateVerified).toBe(true)
    expect(b.verifiedAt).toBe(2000)
  })

  it('carries the client stamp on that edge too', () => {
    const a = reduceEntry(undefined, ev({ state: 'waiting', awaitingInput: true, clientRevision: 3 }), 1000)
    const b = reduceEntry(a, ev({ state: 'done' }), 2000)
    expect(b.clientRevision).toBeUndefined() // the held event carried no stamp — say so
  })
})

describe('a restored entry is never proof', () => {
  let dir = ''
  beforeEach(() => {
    _resetForTest()
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-status-restored-'))
  })
  afterEach(() => {
    _resetForTest()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('is marked, and carries no proof, however the file was written', () => {
    const file = path.join(dir, 'agent-status.json')
    // `stateVerified: true` cannot come out of buildFile — but a hand-edited, downgraded or
    // future-written file is not a thing this process controls, and the restore is what gate 2
    // would read. Force the hostile shape.
    fs.writeFileSync(
      file,
      JSON.stringify({
        v: 1,
        updatedAt: Date.now(),
        nodes: { n1: { state: 'done', agentId: 'claude', stateVerified: true, updatedAt: Date.now() } }
      })
    )
    initAgentStatusMirror(file)
    expect(_snapshot().n1?.state).toBe('done')
    expect(_snapshot().n1?.restored).toBe(true)
    expect(_snapshot().n1?.stateVerified).toBe(false)
  })

  it('the first live event that COMMITS a state clears `restored`', () => {
    // `newTurn` matters here and the first draft of this test omitted it: at now=5 against a
    // restored `done` stamped 0, a bare `working` is inside the done-holdoff, commits nothing, and
    // therefore — correctly — leaves the entry restored. A genuine UserPromptSubmit is what
    // actually replaces the state that came off disk.
    const a = { state: 'done', stateVerified: false, restored: true, updatedAt: 0 } as MirrorEntry
    const b = reduceEntry(a, ev({ state: 'working', newTurn: true, verified: true }), 5)
    expect(b.restored).toBeUndefined()
    expect(b.state).toBe('working')
  })

  // THIS ASSERTION USED TO SAY THE OPPOSITE, and it was wrong in the direction that matters.
  // `restored` means "this entry's STATE came off disk at boot" — that is what its docblock says
  // and what gate 2 will read it as. The first version cleared it on ANY event, so a `context`
  // event left `restored` gone while `state` and `updatedAt` were still the six-hour-old on-disk
  // ones: a future `!restored && state === 'done'` would then admit a stale restored `done` after
  // one tool event. Not exploitable while `stateVerified` is the real input, but a loaded gun.
  it('an event that commits NO state leaves it restored — a context event is not a state', () => {
    const a = { state: 'done', restored: true, updatedAt: 111 } as MirrorEntry
    const b = reduceEntry(a, ev({ kind: 'context' } as never), 999)
    expect(b.restored).toBe(true)
    expect(b.state).toBe('done')
    expect(b.updatedAt).toBe(111) // still the on-disk stamp — nothing about the state is new
  })

  it('a HELD-OFF late working leaves it restored — the state is still the restored one', () => {
    const a = { state: 'done', restored: true, updatedAt: 111 } as MirrorEntry
    expect(reduceEntry(a, ev({ state: 'working' }), 111 + 500).restored).toBe(true)
  })

  it('the idle RESCUE leaves it restored — it returns before committing anything', () => {
    const a = { state: 'done', restored: true, updatedAt: 111 } as MirrorEntry
    expect(reduceEntry(a, ev({ state: 'done', idle: true }), 999).restored).toBe(true)
  })

  it('a session boundary clears it — that DOES commit a state (idle)', () => {
    const a = { state: 'done', restored: true, updatedAt: 111 } as MirrorEntry
    const b = reduceEntry(a, ev({ kind: 'session', sessionPhase: 'start' }), 999)
    expect(b.restored).toBeUndefined()
    expect(b.state).toBeUndefined()
  })

  it('the request_user_input hold clears it — it commits `waiting`', () => {
    const a = { state: 'waiting', awaitingInput: true, restored: true, updatedAt: 111 } as MirrorEntry
    const b = reduceEntry(a, ev({ state: 'done' }), 999)
    expect(b.state).toBe('waiting')
    expect(b.restored).toBeUndefined()
  })

  it('buildFile\'s allowlist keeps neither field on disk (its sibling above covers the restore)', () => {
    const file = path.join(dir, 'agent-status.json')
    fs.writeFileSync(
      file,
      JSON.stringify({
        v: 1,
        updatedAt: Date.now(),
        nodes: { n1: { state: 'done', stateVerified: true, restored: true, updatedAt: Date.now() } }
      })
    )
    initAgentStatusMirror(file)
    const doc = buildFile(_snapshot(), Date.now())
    expect('stateVerified' in doc.nodes.n1).toBe(false)
    expect('restored' in doc.nodes.n1).toBe(false)
  })
})

// `clearNode` had NO production caller, so deleting a node told the live surfaces nothing: the
// notch HUD kept its needs-you/done row until the 6 h prune and the phone's Live Activity for it
// was never ended. It now fires the one end edge those surfaces listen for.
describe('clearNode (permanent node destroy) fires the end edge', () => {
  beforeEach(() => _resetForTest())
  afterEach(() => _resetForTest())

  it('fires ONE end edge for a node deleted mid-turn, carrying its identity', () => {
    const edges: NodeStateChange[] = []
    const off = onNodeStateChange((c) => edges.push(c))
    recordAgentEvent(ev({ nodeId: 'n1', sessionId: 's1', state: 'working', newTurn: true }))
    edges.length = 0

    clearNode('n1')

    expect(edges).toHaveLength(1)
    expect(edges[0]).toMatchObject({
      nodeId: 'n1',
      agentId: 'claude',
      sessionId: 's1',
      event: 'end',
      state: 'done'
    })
    off()
  })

  it('fires the end edge for a node deleted while BLOCKED, and pushes no inbox event', () => {
    const edges: NodeStateChange[] = []
    const off = onNodeStateChange((c) => edges.push(c))
    recordAgentEvent(ev({ nodeId: 'n1', state: 'working', newTurn: true }))
    recordAgentEvent(ev({ nodeId: 'n1', state: 'blocked', lastMessage: 'Approve?' }))
    const feedBefore = _inboxSnapshot().events.length
    edges.length = 0

    clearNode('n1')

    expect(edges).toHaveLength(1)
    expect(edges[0]).toMatchObject({ nodeId: 'n1', event: 'end', state: 'done' })
    // The node is GONE — there is nothing left to read or act on, so no feed card is produced.
    expect(_inboxSnapshot().events).toHaveLength(feedBefore)
    // Its unanswered card is archived rather than dropped (unchanged behavior).
    expect(_inboxSnapshot().events[0].resolved).toBe(true)
    off()
  })

  it('fires NOTHING for an already-done node — the done edge already ended that card', () => {
    recordAgentEvent(ev({ nodeId: 'n1', state: 'working', newTurn: true }))
    recordAgentEvent(ev({ nodeId: 'n1', state: 'done' }))
    const edges: NodeStateChange[] = []
    const off = onNodeStateChange((c) => edges.push(c))

    clearNode('n1')

    expect(edges).toEqual([])
    off()
  })

  it('fires NOTHING for an idle node, or one the mirror never saw', () => {
    const edges: NodeStateChange[] = []
    const off = onNodeStateChange((c) => edges.push(c))
    // A session end resets the node to idle (state undefined) — and fires its own end edge.
    recordAgentEvent(ev({ nodeId: 'n1', state: 'working', newTurn: true }))
    recordAgentEvent(ev({ nodeId: 'n1', kind: 'session', sessionPhase: 'end' }))
    edges.length = 0

    clearNode('n1')
    clearNode('never-seen')

    expect(edges).toEqual([])
    off()
  })
})

// The feed's only bound was INBOX_EVENTS_CAP, so an unresolved approval on a node nobody came back
// to stayed a red "Needs you" card with the tray badge lit forever.
describe('inbox event age prune (flush)', () => {
  let dir: string
  let file: string
  let nowSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    _resetForTest()
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-status-'))
    file = path.join(dir, 'agent-status.json')
    initAgentStatusMirror(file)
    nowSpy = vi.spyOn(Date, 'now')
  })

  afterEach(() => {
    nowSpy.mockRestore()
    _resetForTest()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('drops events older than EXPIRE_MS — unresolved AND resolved alike — on the flush that finds them', async () => {
    nowSpy.mockReturnValue(1_000_000)
    // An UNRESOLVED ask nobody ever answered: the red card + the lit tray badge.
    recordAgentEvent(ev({ nodeId: 'old', state: 'blocked', lastMessage: 'Approve?' }))
    // A RESOLVED done: the phone's archive/history.
    recordAgentEvent(ev({ nodeId: 'arch', state: 'working', newTurn: true }))
    recordAgentEvent(ev({ nodeId: 'arch', state: 'done', lastMessage: 'All done.' }))
    ackDone('arch')
    expect(_inboxSnapshot().events).toHaveLength(2)
    expect(_inboxSnapshot().events[0].resolved).toBeUndefined()
    expect(_inboxSnapshot().events[1].resolved).toBe(true)

    // A fresh ask arrives just past the window on the two above.
    nowSpy.mockReturnValue(1_000_000 + EXPIRE_MS + 1)
    recordAgentEvent(ev({ nodeId: 'new', state: 'blocked', lastMessage: 'Approve me?' }))

    await flush()

    // Both aged kinds are gone from memory; only the fresh card survives.
    expect(_inboxSnapshot().events.map((e) => e.nodeId)).toEqual(['new'])
    // ...and the FILE the phone reads agrees on the SAME flush: `buildFile` passes `inbox` through
    // verbatim, so a prune placed after it would leave the aged card on disk for one more write —
    // and an abandoned node schedules none.
    const doc = JSON.parse(fs.readFileSync(file, 'utf-8'))
    expect(doc.inbox.events.map((e: { nodeId: string }) => e.nodeId)).toEqual(['new'])
  })

  it('keeps an unresolved ask INSIDE the window — a human may still be coming back to answer it', async () => {
    nowSpy.mockReturnValue(1_000_000)
    recordAgentEvent(ev({ nodeId: 'n1', state: 'blocked', lastMessage: 'Approve?' }))

    nowSpy.mockReturnValue(1_000_000 + EXPIRE_MS - 1)
    await flush()

    expect(_inboxSnapshot().events).toHaveLength(1)
    expect(_inboxSnapshot().events[0].resolved).toBeUndefined()
  })
})
