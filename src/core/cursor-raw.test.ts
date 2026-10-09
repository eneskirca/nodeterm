import { afterEach, describe, expect, it, vi } from 'vitest'
import fs, { readFileSync } from 'fs'
import os from 'os'
import path from 'path'
import { applyCursorRaw, releaseCursorRaw } from './cursor-chat'
import { createCursorSubagentTracker } from './cursor-subagents'
import type { SubagentTail } from './subagent-tail'
import type { NormalizedAgentEvent } from '../shared/agents/normalize'
import { _inboxSnapshot, _resetForTest } from './agent-status-mirror'

// Review 2026-10-02: both shells returned from their first cursor branch, so the subagent tracker
// below it never ran, and a child's tool events re-pointed the node's session (and leaked a tail).
// This replays the captured interactive subagent turn through the ONE step both shells now call.
const fx = JSON.parse(
  readFileSync(path.join(__dirname, '../shared/agents/__fixtures__/cursor/subagent-payloads.json'), 'utf8')
) as { events: Record<string, unknown>[] }
const CONFIG = '/cfg/.cursor'
const ev = fx.events.map((e) =>
  typeof e.transcript_path === 'string'
    ? { ...e, transcript_path: (e.transcript_path as string).replace('<home>/.cursor', CONFIG) }
    : e
)
const PARENT = ev[0].conversation_id as string
const CHILD = ev.find((e) => e.tool_name === 'Read')!.conversation_id as string

function rig(isRemote = false) {
  const emitted: NormalizedAgentEvent[] = []
  const tracked: string[] = []
  const finished: string[] = []
  const tail: SubagentTail = { track: () => {}, trackFile: () => {}, finish: (id) => void finished.push(id) }
  const subagents = createCursorSubagentTracker({ tail, emit: (e) => void emitted.push(e), configDir: () => CONFIG })
  const nodeSession = new Map<string, string>()
  const ctx = { track: (id: string) => void tracked.push(id), pathFor: () => undefined }
  const deps = { tail: ctx, subagents, nodeSession, isRemote: () => isRemote }
  return { emitted, tracked, finished, nodeSession, run: (p: Record<string, unknown>) => applyCursorRaw(deps, 'n1', p) }
}

const settle = () => new Promise((r) => setTimeout(r, 20))

describe('applyCursorRaw over the captured subagent turn', () => {
  it('ends the subagent card on the parent stop (the tracker is reachable)', async () => {
    const r = rig()
    for (const e of ev) {
      r.run(e)
      await settle()
    }
    const kinds = r.emitted.map((e) => e.kind)
    expect(kinds).toContain('subagent-end')
  })

  it("keeps the node on the PARENT chat: a child's tool events never re-point it", async () => {
    const r = rig()
    for (const e of ev) {
      r.run(e)
      await settle()
      expect(r.nodeSession.get('n1')).toBe(PARENT)
    }
    expect(r.nodeSession.get('n1')).not.toBe(CHILD)
  })

  it('a remote node still gets subagent cards but no local meter or session association', async () => {
    const r = rig(true)
    for (const e of ev) {
      r.run(e)
      await settle()
    }
    expect(r.emitted.map((e) => e.kind)).toContain('subagent-end')
    expect(r.nodeSession.size).toBe(0)
  })
})

describe("applyCursorRaw feeds the phone's activity line", () => {
  const activity = () => _inboxSnapshot().nodes['n1']?.activity
  it('a parent tool call is the activity, a child one is not, and stop clears it', () => {
    _resetForTest()
    const r = rig(true) // remote too: the line needs no file
    r.run({ hook_event_name: 'preToolUse', conversation_id: PARENT, generation_id: 'g1', tool_name: 'Shell', tool_input: { command: 'npm test' } })
    expect(activity()).toBe('Running npm test')
    r.run(ev.find((e) => e.hook_event_name === 'preToolUse' && e.tool_name === 'Read')!) // the child's Read
    expect(activity()).toBe('Running npm test')
    r.run({ hook_event_name: 'stop', conversation_id: PARENT, status: 'completed' })
    expect(activity()).toBeUndefined()
    _resetForTest()
  })
})

// Review 2026-10-03 (M2): a background agent's sessionEnd (normalizeCursor already drops it) ended
// every open parent Task card and handed its own id over as the parent's session.
describe("a background agent's lifecycle event is not the parent's", () => {
  const BG = '55555555-5555-4555-8555-555555555555'
  const task = (id: string) => ({ hook_event_name: 'preToolUse', conversation_id: PARENT, generation_id: 'turn', tool_name: 'Task', tool_use_id: id })

  it('keeps both cards open and the parent session, then the parent stop ends them', async () => {
    const r = rig()
    r.run(task('task-1'))
    r.run(task('task-2'))
    await settle()
    r.run({ hook_event_name: 'sessionEnd', conversation_id: BG, generation_id: BG, is_background_agent: true })
    r.run({ hook_event_name: 'stop', conversation_id: BG, generation_id: 'g', is_background_agent: true })
    await settle()
    expect(r.emitted.filter((e) => e.kind === 'subagent-end')).toEqual([])
    expect(r.finished).toEqual([])
    expect(r.nodeSession.get('n1')).toBe(PARENT)
    r.run({ hook_event_name: 'stop', conversation_id: PARENT, generation_id: 'turn', status: 'completed' })
    const ends = r.emitted.filter((e) => e.kind === 'subagent-end')
    expect(ends.map((e) => e.toolUseId)).toEqual(['task-1', 'task-2'])
    expect(ends.every((e) => e.sessionId === PARENT)).toBe(true)
  })

  it("a claimed child's own stop does not end the parent's cards", () => {
    const r = rig(true)
    // The captured turn up to (not including) the parent's stop: the child is claimed by then.
    const parentStop = ev.findIndex((e) => e.hook_event_name === 'stop' && e.conversation_id === PARENT)
    for (const e of ev.slice(0, parentStop)) r.run(e)
    r.run({ hook_event_name: 'stop', conversation_id: CHILD, generation_id: 'g', status: 'completed' })
    expect(r.emitted.filter((e) => e.kind === 'subagent-end')).toEqual([])
  })
})

// Review 2026-10-03 (M1): the store lookup is async; a node destroyed or recycled while it was in
// flight got its 1 Hz meter poll (and session association) re-created when it landed.
describe('a release fences a store lookup already in flight', () => {
  const ID = '22222222-2222-4222-8222-222222222222'
  let cfg = ''
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    if (cfg) fs.rmSync(cfg, { recursive: true, force: true })
  })

  it('tracks nothing and associates nothing after releaseCursorRaw', async () => {
    cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-cursor-fence-'))
    vi.stubEnv('CURSOR_CONFIG_DIR', cfg)
    const db = path.join(cfg, 'chats', 'bucket', ID, 'store.db')
    fs.mkdirSync(path.dirname(db), { recursive: true })
    fs.writeFileSync(db, '')
    const realStat = fs.promises.stat.bind(fs.promises)
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    let entered!: () => void
    const sawStat = new Promise<void>((r) => (entered = r))
    vi.spyOn(fs.promises, 'stat').mockImplementation((async (p: fs.PathLike) => {
      if (String(p) === db) {
        entered()
        await gate
      }
      return realStat(p)
    }) as typeof fs.promises.stat)
    const r = rig()
    r.run({ hook_event_name: 'beforeSubmitPrompt', conversation_id: ID, generation_id: 'turn' })
    await sawStat
    releaseCursorRaw('n1') // pty:destroy / pty:recycle
    release()
    await settle()
    expect(r.tracked).toEqual([])
    expect(r.nodeSession.size).toBe(0)
    // The node's next life is metered again.
    r.run({ hook_event_name: 'beforeSubmitPrompt', conversation_id: ID, generation_id: 'turn2' })
    await settle()
    expect(r.tracked).toEqual([ID])
    expect(r.nodeSession.get('n1')).toBe(ID)
    releaseCursorRaw('n1')
  })
})

describe('both shells run the shared step and nothing else for cursor', () => {
  it('calls applyCursorRaw and has no second, unreachable cursor branch', () => {
    for (const f of ['src/main/index.ts', 'src/server/agent-status.ts']) {
      const src = readFileSync(path.join(__dirname, '../..', f), 'utf8').replace(/\r\n/g, '\n')
      expect(src, f).toContain('applyCursorRaw(')
      expect(src.match(/agentId === 'cursor'\) \{/g)?.length ?? 0, f).toBe(1)
      expect(src, f).not.toContain('cursorSubagents.onRaw(')
      // Parity for the two fixes the desktop has no harness for (the server's are behavioural tests):
      // the claude branch ignores Cursor's claude.sh payloads, and a closed node releases its Tasks.
      expect(src, f).toContain('if (isCursorPayload(payload)) return')
      expect(src, f).toContain('cursorSubagents.release(nodeId)')
      expect(src, f).toContain('releaseCursorRaw(nodeId)')
      expect(src, f).toMatch(/releaseCursorNode\??\.?\(nodeId\)/)
    }
  })
})
