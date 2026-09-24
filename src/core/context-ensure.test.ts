// The context meter's mount-time rehydration (issue #813).
//
// Four properties, each of which was a real failure before this handler existed:
//  1. a REMOTE node resolves on its host and never on this machine's disk;
//  2. a remote resolve that FAILED is not remembered as an absence;
//  3. codex and gemini rehydrate from THEIR OWN transcripts — and a codex node never, under any
//     circumstance, reaches claude's resolver (the regression `readsClaudeTranscript` exists to
//     prevent, now pinned at the layer that actually routes);
//  4. an agent with no rehydration path (grok) gets nothing rather than somebody else's numbers.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fakePlatform } from './platform-fake'
import { initPlatform, resetPlatformForTests } from './platform'
import { registerContextEnsureIpc, type ContextEnsureQuery } from './context-ensure'
import type { ContextTail } from './context-tail'
import { IPC } from '../shared/ipc'

const SID = '46b36ce2-dd77-4f5e-a89e-4a0e831e83df'
const CWD = '/srv/app'

/** A ContextTail that only records what it was asked to track. */
function fakeTail(): ContextTail & { tracked: [string | undefined, string | undefined][] } {
  const tracked: [string | undefined, string | undefined][] = []
  return {
    tracked,
    replay: vi.fn(),
    track: (sessionId, transcriptPath) => void tracked.push([sessionId, transcriptPath]),
    untrack: () => {},
    pathFor: () => undefined
  }
}

let home: string
let f: ReturnType<typeof fakePlatform>
let claude: ReturnType<typeof fakeTail>
let codex: ReturnType<typeof fakeTail>
let gemini: ReturnType<typeof fakeTail>

// The registered listener is async; `CorePlatform.on` types its return as void (a cast is
// fire-and-forget on the wire), so awaiting it here — which is what lets these tests assert on the
// resolve's RESULT rather than on a timer — needs the hop through `unknown`.
const ensure = (over: Partial<ContextEnsureQuery> = {}): Promise<void> =>
  f.listeners[IPC.contextEnsure](
    over.sessionId ?? SID,
    'cwd' in over ? over.cwd : CWD,
    over.accountId,
    over.nodeId,
    over.agentId
  ) as unknown as Promise<void>

const tailFor = (agentId: string | undefined): ContextTail | undefined => {
  switch (agentId) {
    case undefined:
    case 'claude':
      return claude
    case 'codex':
      return codex
    case 'gemini':
      return gemini
    default:
      return undefined
  }
}

/** Write a claude transcript for SID under `~/.claude/projects/<encoded cwd>/`. */
function writeClaudeTranscript(sessionId = SID): string {
  const dir = path.join(home, '.claude', 'projects', '-srv-app')
  fs.mkdirSync(dir, { recursive: true })
  const p = path.join(dir, `${sessionId}.jsonl`)
  fs.writeFileSync(p, '{"type":"user","message":{"content":"hi"}}\n')
  return p
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-context-ensure-'))
  vi.spyOn(os, 'homedir').mockReturnValue(home)
  f = fakePlatform()
  initPlatform(f)
  claude = fakeTail()
  codex = fakeTail()
  gemini = fakeTail()
})
afterEach(() => {
  vi.restoreAllMocks()
  resetPlatformForTests()
  fs.rmSync(home, { recursive: true, force: true })
})

describe('local rehydration, per agent', () => {
  it('replays a tracked session on each remount without resolving or tracking again', async () => {
    claude.pathFor = () => '/already-tracked.jsonl'
    registerContextEnsureIpc({ tailFor })
    await ensure({ agentId: 'claude' })
    await ensure({ agentId: 'claude' })
    expect(claude.replay).toHaveBeenCalledTimes(2)
    expect(claude.replay).toHaveBeenCalledWith(SID)
    expect(claude.tracked).toEqual([])
  })

  it('tracks a claude session on claude’s tail from its own transcript', async () => {
    const p = writeClaudeTranscript()
    registerContextEnsureIpc({ tailFor })
    await ensure({ agentId: 'claude' })
    expect(claude.tracked).toEqual([[SID, p]])
  })

  it('still resolves as claude when no agent id is sent (the legacy call shape)', async () => {
    const p = writeClaudeTranscript()
    registerContextEnsureIpc({ tailFor })
    await ensure({})
    expect(claude.tracked).toEqual([[SID, p]])
  })

  it('rehydrates a codex node from codex’s OWN rollout, on codex’s tail', async () => {
    const dir = path.join(home, '.codex', 'sessions', '2026', '09', '18')
    fs.mkdirSync(dir, { recursive: true })
    const rollout = path.join(dir, `rollout-2026-09-18T10-00-00-${SID}.jsonl`)
    fs.writeFileSync(rollout, '{}\n')
    registerContextEnsureIpc({ tailFor })
    await ensure({ agentId: 'codex' })
    expect(codex.tracked).toEqual([[SID, rollout]])
    expect(claude.tracked).toEqual([])
  })

  it('rehydrates a gemini node from gemini’s own chat file, on gemini’s tail', async () => {
    const chats = path.join(home, '.gemini', 'tmp', 'proj', 'chats')
    fs.mkdirSync(chats, { recursive: true })
    const chat = path.join(chats, 'session-1.jsonl')
    fs.writeFileSync(chat, `${JSON.stringify({ sessionId: SID })}\n`)
    registerContextEnsureIpc({ tailFor })
    await ensure({ agentId: 'gemini' })
    expect(gemini.tracked).toEqual([[SID, chat]])
    expect(claude.tracked).toEqual([])
  })

  /**
   * THE regression this routing exists to prevent, and the reason the renderer gate could move.
   *
   * Claude's `resolveTranscript` falls back to *the newest claude transcript for the cwd* when its
   * sessionId leg misses — and a codex session id ALWAYS misses, since no `<that id>.jsonl` exists
   * under `~/.claude/projects`. So the scenario below (a codex node sharing a cwd with a claude
   * session, which is the normal case: they are two nodes on one project) is exactly where a
   * gate-widening without routing hands the codex node a stranger's conversation — wrong numerator,
   * wrong denominator, then flapping against the correct codex tail.
   *
   * Pinned on BOTH tails: nothing claude-shaped may be tracked anywhere for a codex node.
   */
  it('NEVER resolves a codex node through claude’s transcript, even sharing its cwd', async () => {
    writeClaudeTranscript('11111111-2222-3333-4444-555555555555') // a stranger's session, same cwd
    registerContextEnsureIpc({ tailFor })
    await ensure({ agentId: 'codex' })
    expect(codex.tracked).toEqual([])
    expect(claude.tracked).toEqual([])
  })

  it('gives an agent with no rehydration path (grok) nothing at all', async () => {
    writeClaudeTranscript()
    registerContextEnsureIpc({ tailFor })
    await ensure({ agentId: 'grok' })
    expect([...claude.tracked, ...codex.tracked, ...gemini.tracked]).toEqual([])
  })

  it('ignores a malformed session id without touching any resolver', async () => {
    writeClaudeTranscript()
    registerContextEnsureIpc({ tailFor })
    await ensure({ sessionId: '../../etc/passwd', agentId: 'claude' })
    expect(claude.tracked).toEqual([])
  })
})

describe('remote (SSH-project) rehydration', () => {
  it('fills a remote node’s meter at mount, with no hook event — issue #813', async () => {
    const seen: ContextEnsureQuery[] = []
    registerContextEnsureIpc({
      tailFor,
      ensureRemote: async (q) => {
        seen.push(q)
        return 'tracked'
      }
    })
    await ensure({ agentId: 'claude', nodeId: 'n1' })
    // The remote leg owns it end to end: it received everything it needs to ask the HOST, and the
    // local tail was never involved.
    expect(seen).toEqual([
      { sessionId: SID, cwd: CWD, accountId: undefined, nodeId: 'n1', agentId: 'claude' }
    ])
    expect(claude.tracked).toEqual([])
  })

  /**
   * The load-bearing half. A remote session's transcript is on the other machine, so an unresolved
   * remote answer must END the ensure — falling through would run claude's cwd fallback against
   * THIS machine's disk and meter whatever local session happens to share the cwd, under the remote
   * node's session id.
   */
  it('does not fall through to the local resolver when the host could not answer', async () => {
    writeClaudeTranscript('99999999-2222-3333-4444-555555555555') // a local session, same cwd
    registerContextEnsureIpc({ tailFor, ensureRemote: async () => 'unresolved' })
    await ensure({ agentId: 'claude', nodeId: 'n1' })
    expect(claude.tracked).toEqual([])
  })

  it('takes the local path for a node the remote leg says is not remote', async () => {
    const p = writeClaudeTranscript()
    registerContextEnsureIpc({ tailFor, ensureRemote: async () => null })
    await ensure({ agentId: 'claude', nodeId: 'n1' })
    expect(claude.tracked).toEqual([[SID, p]])
  })

  /**
   * A failed read is never evidence of absence. The handler holds no negative memory of its own, so
   * a resolve that failed because the ControlMaster was momentarily down is retried in full by the
   * next ensure — which is what makes the meter heal on the next mount instead of staying blank
   * until the session's next turn (i.e. the bug, re-arrived by another route).
   */
  it('remembers nothing after an unresolved remote attempt, and retries in full', async () => {
    let attempt = 0
    registerContextEnsureIpc({
      tailFor,
      ensureRemote: async () => (++attempt === 1 ? 'unresolved' : 'tracked')
    })
    await ensure({ agentId: 'claude', nodeId: 'n1' })
    await ensure({ agentId: 'claude', nodeId: 'n1' })
    expect(attempt).toBe(2)
  })

  /**
   * De-duplicating CONCURRENT calls is not caching: a canvas of dozens of remote nodes mounts at
   * once, and each resolve is an ssh exec on someone else's machine. The previous test pins that
   * the guard releases, so this one can only be about overlap.
   */
  it('coalesces a second ensure that arrives while the first is still in flight', async () => {
    let calls = 0
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => (release = r))
    registerContextEnsureIpc({
      tailFor,
      ensureRemote: async () => {
        calls++
        await gate
        return 'tracked'
      }
    })
    const a = ensure({ agentId: 'claude', nodeId: 'n1' })
    const b = ensure({ agentId: 'claude', nodeId: 'n1' })
    release()
    await Promise.all([a, b])
    expect(calls).toBe(1)
  })
})
