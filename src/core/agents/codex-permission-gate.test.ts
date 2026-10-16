import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { normalizeCodex, type NormalizedAgentEvent } from '../../shared/agents/normalize'
import { testTmpDir } from '../test-tmp'
import {
  createCodexPermissionGate,
  isCodexPermissionRequest,
  isCodexRolloutPath,
  readRolloutReviewer,
  type CodexPermissionGateDeps
} from './codex-permission-gate'
import fixture from '../../shared/agents/__fixtures__/codex/auto-review-permission.json'

type Rec = { type: string; payload: Record<string, unknown> }
const hooks = (fixture.hooks as { payload: Record<string, unknown> }[]).map((h) => h.payload)
const rollout = fixture.rollout as unknown as Rec[]
const permission = hooks.find((h) => h.hook_event_name === 'PermissionRequest')!
const turnCtx = rollout.find((r) => r.type === 'turn_context')!
const TURN = permission.turn_id as string

const dir = testTmpDir('nodeterm-codexgate-')
const roots = { fixed: [path.join(dir, 'codex', 'sessions')], managedRoot: path.join(dir, 'cx') }
let n = 0
function writeRollout(recs: Rec[], root = roots.fixed[0]): string {
  const file = path.join(root, '2026', '10', '16', `rollout-2026-10-16T12-36-34-${n++}.jsonl`)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, recs.map((r) => JSON.stringify(r) + '\n').join(''))
  return file
}
const withReviewer = (v: unknown): Rec[] =>
  rollout.map((r) => (r.type === 'turn_context' ? { ...r, payload: { ...r.payload, approvals_reviewer: v } } : r))

const ev = (p: Record<string, unknown>): NormalizedAgentEvent =>
  normalizeCodex({ nodeId: 'c1', agentId: 'codex', payload: p }) as NormalizedAgentEvent

describe('codex rollout reviewer read', () => {
  it('the captured PermissionRequest carries no reviewer field and the turn ids match', () => {
    expect(JSON.stringify(permission)).not.toMatch(/review/i)
    expect(turnCtx.payload.turn_id).toBe(TURN)
    expect(turnCtx.payload.approvals_reviewer).toBe('auto_review')
  })

  it('finds the turn_context for the hook turn, scanning backward across chunk boundaries', async () => {
    const pad = { type: 'event_msg', payload: { type: 'x', text: 'y'.repeat(5000) } }
    const file = writeRollout([...rollout.slice(0, 5), ...Array(40).fill(pad), ...rollout.slice(5)])
    for (const chunk of [7, 64, 999, 1 << 20]) {
      expect(await readRolloutReviewer(file, TURN, 16 << 20, chunk)).toBe('auto_review')
    }
  })

  it('reads the turn_context when it is the first line of the file', async () => {
    const file = writeRollout([turnCtx])
    expect(await readRolloutReviewer(file, TURN, 1 << 20, 13)).toBe('auto_review')
  })

  it('takes only the record for THIS turn, never a newer or older one', async () => {
    const other = { ...turnCtx, payload: { ...turnCtx.payload, turn_id: 'other', approvals_reviewer: 'auto_review' } }
    const mine = { ...turnCtx, payload: { ...turnCtx.payload, approvals_reviewer: 'user' } }
    const file = writeRollout([mine, other])
    expect(await readRolloutReviewer(file, TURN)).toBe('user')
    expect(await readRolloutReviewer(file, 'missing')).toBeNull()
  })

  it('gives up past the byte bound', async () => {
    const pad = { type: 'event_msg', payload: { text: 'z'.repeat(4000) } }
    const file = writeRollout([turnCtx, ...Array(20).fill(pad)])
    expect(await readRolloutReviewer(file, TURN, 40_000, 1000)).toBeNull()
    expect(await readRolloutReviewer(file, TURN, 200_000, 1000)).toBe('auto_review')
  })

  it('missing file and symlinked file read as unknown', async () => {
    expect(await readRolloutReviewer(path.join(dir, 'nope.jsonl'), TURN)).toBeNull()
    const real = writeRollout(withReviewer('auto_review'))
    const link = path.join(path.dirname(real), 'rollout-link.jsonl')
    fs.symlinkSync(real, link)
    expect(await readRolloutReviewer(link, TURN)).toBeNull()
  })

  it('the path jail admits only rollouts under the codex sessions roots', () => {
    const ok = path.join(roots.fixed[0], '2026', '10', '16', 'rollout-a.jsonl')
    expect(isCodexRolloutPath(ok, roots)).toBe(true)
    expect(isCodexRolloutPath(path.join(roots.managedRoot, '0123456789abcdef', 'sessions', 'x', 'rollout-a.jsonl'), roots)).toBe(true)
    expect(isCodexRolloutPath(path.join(roots.managedRoot, '0123456789abcdef', 'auth', 'rollout-a.jsonl'), roots)).toBe(false)
    expect(isCodexRolloutPath(path.join(roots.managedRoot, '..', 'sessions', 'rollout-a.jsonl'), roots)).toBe(false)
    expect(isCodexRolloutPath(path.join(roots.fixed[0], '..', '..', 'id_rsa'), roots)).toBe(false)
    expect(isCodexRolloutPath(path.join(roots.fixed[0], 'a', '..', '..', 'rollout-a.jsonl'), roots)).toBe(false)
    expect(isCodexRolloutPath(path.join(roots.fixed[0], 'a', 'notes.jsonl'), roots)).toBe(false)
    expect(isCodexRolloutPath('relative/rollout-a.jsonl', roots)).toBe(false)
  })
})

describe('codex permission gate', () => {
  const out: NormalizedAgentEvent[] = []
  let gate: ReturnType<typeof createCodexPermissionGate> | undefined
  afterEach(() => {
    gate?.dispose()
    out.length = 0
  })
  const deps = (over: Partial<CodexPermissionGateDeps> = {}): CodexPermissionGateDeps => ({
    roots: () => roots,
    readReviewer: (f, t) => readRolloutReviewer(f, t),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
    confirmTimeoutMs: 2000,
    ...over
  })
  const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 30))
  const run = async (reviewer: unknown, over: Partial<CodexPermissionGateDeps> = {}, payload = permission): Promise<void> => {
    const file = writeRollout(withReviewer(reviewer))
    gate = createCodexPermissionGate((e) => out.push(e), deps(over))
    for (const h of hooks) {
      const p = h === permission ? { ...payload, transcript_path: file } : { ...h, transcript_path: file }
      gate.handle('c1', p, ev(p))
    }
    await settle()
  }

  it('under auto_review the PermissionRequest is not shown as NEEDS YOU, order kept', async () => {
    await run('auto_review')
    expect(out.map((e) => e.state)).toEqual(['working', 'working', 'working', 'working', 'done'])
    expect(out.some((e) => e.state === 'waiting')).toBe(false)
  })

  it('the legacy guardian_subagent spelling is the same reviewer', async () => {
    await run('guardian_subagent')
    expect(out.some((e) => e.state === 'waiting')).toBe(false)
  })

  for (const [label, value] of [
    ['user', 'user'],
    ['an unknown value', 'auto_review_v2'],
    ['a non-string', 1]
  ] as const) {
    it(`keeps NEEDS YOU for ${label}`, async () => {
      await run(value)
      expect(out.map((e) => e.state)).toEqual(['working', 'working', 'working', 'waiting', 'working', 'done'])
    })
  }

  it('keeps NEEDS YOU when the hook carries no turn_id', async () => {
    const { turn_id: _drop, ...noTurn } = permission
    await run('auto_review', {}, noTurn)
    expect(out.map((e) => e.state)).toContain('waiting')
  })

  it('keeps NEEDS YOU for a transcript path outside the jail', async () => {
    const file = writeRollout(withReviewer('auto_review'), path.join(dir, 'elsewhere'))
    gate = createCodexPermissionGate((e) => out.push(e), deps())
    gate.handle('c1', { ...permission, transcript_path: file }, ev(permission))
    await settle()
    expect(out.map((e) => e.state)).toEqual(['waiting'])
  })

  it('keeps NEEDS YOU when the read is slower than the timeout, and later events wait behind it', async () => {
    await run('auto_review', {
      confirmTimeoutMs: 5,
      readReviewer: () => new Promise((r) => setTimeout(() => r('auto_review'), 60))
    })
    await new Promise((r) => setTimeout(r, 80))
    expect(out.map((e) => e.state)).toEqual(['working', 'working', 'working', 'waiting', 'working', 'done'])
  })

  it('keeps NEEDS YOU when the read throws', async () => {
    await run('auto_review', { readReviewer: () => Promise.reject(new Error('x')) })
    expect(out.map((e) => e.state)).toContain('waiting')
  })

  it('reads a turn once', async () => {
    let reads = 0
    const file = writeRollout(withReviewer('auto_review'))
    gate = createCodexPermissionGate((e) => out.push(e), deps({
      readReviewer: (f, t) => {
        reads++
        return readRolloutReviewer(f, t)
      }
    }))
    const p = { ...permission, transcript_path: file }
    gate.handle('c1', p, ev(p))
    gate.handle('c1', p, ev(p))
    await settle()
    expect(reads).toBe(1)
    expect(out).toEqual([])
  })

  it('isCodexPermissionRequest is a closed match', () => {
    expect(isCodexPermissionRequest(permission, ev(permission))).toBe(true)
    const pre = hooks.find((h) => h.hook_event_name === 'PreToolUse')!
    expect(isCodexPermissionRequest(pre, ev(pre))).toBe(false)
    expect(isCodexPermissionRequest({ ...permission, agent_id: 'a' }, ev(permission))).toBe(false)
    expect(isCodexPermissionRequest(permission, null)).toBe(false)
  })
})
