import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import path from 'path'
import { createCursorSubagentFormatter, createCursorSubagentTracker, cursorChildTranscript } from './cursor-subagents'
import type { SubagentTail } from './subagent-tail'
import type { NormalizedAgentEvent } from '../shared/agents/normalize'

// Interactive TUI capture, cursor-agent 2026.10.01 (see the fixture's _provenance).
const fx = JSON.parse(
  readFileSync(path.join(__dirname, '../shared/agents/__fixtures__/cursor/subagent-payloads.json'), 'utf8')
) as { events: Record<string, unknown>[]; childTranscript: string[] }
const CONFIG = '/cfg/.cursor'
// The fixture's home is redacted to `<home>`; point it at the fake config dir.
const ev = fx.events.map((e) =>
  typeof e.transcript_path === 'string'
    ? { ...e, transcript_path: (e.transcript_path as string).replace('<home>/.cursor', CONFIG) }
    : e
)
const find = (name: string, tool?: string) => ev.find((e) => e.hook_event_name === name && (!tool || e.tool_name === tool))!
const TASK = find('preToolUse', 'Task')
const CHILD_PRE = find('preToolUse', 'Read')
const CHILD_POST = find('postToolUse', 'Read')
const STOP = find('stop')
const TASK_ID = TASK.tool_use_id as string
const CHILD = CHILD_POST.conversation_id as string

function rig() {
  const tracked: [string, string | undefined][] = []
  const finished: string[] = []
  const emitted: NormalizedAgentEvent[] = []
  const tail: SubagentTail = {
    track: () => {},
    trackFile: (id, file) => void tracked.push([id, file]),
    finish: (id) => void finished.push(id)
  }
  const t = createCursorSubagentTracker({ tail, emit: (e) => void emitted.push(e), configDir: () => CONFIG })
  const raw = (p: Record<string, unknown>, node = 'n1') => t.onRaw('cursor', node, p)
  return { tracked, finished, emitted, raw, release: (node: string) => t.release(node) }
}

describe('createCursorSubagentTracker over the captured turn', () => {
  it('tails the child from its first path-bearing event, then ends the card on the parent stop', () => {
    const r = rig()
    r.raw(TASK)
    r.raw(CHILD_PRE) // no transcript_path yet (measured null)
    expect(r.tracked).toEqual([])
    r.raw(CHILD_POST)
    expect(r.tracked).toEqual([[TASK_ID, `${CONFIG}/projects/private-tmp-ntc-f1-proj/agent-transcripts/${CHILD}/${CHILD}.jsonl`]])
    r.raw(CHILD_POST) // a claimed child is not re-tracked
    expect(r.tracked).toHaveLength(1)
    r.raw(STOP)
    expect(r.emitted).toEqual([
      { nodeId: 'n1', agentId: 'cursor', sessionId: STOP.conversation_id, kind: 'subagent-end', toolUseId: TASK_ID }
    ])
    expect(r.finished).toEqual([TASK_ID])
    r.raw(STOP) // a second stop has nothing left to end
    expect(r.emitted).toHaveLength(1)
  })

  it('note: two unclaimed Tasks make the child ambiguous, so no tail (cards still end on stop)', () => {
    const r = rig()
    r.raw(TASK)
    r.raw({ ...TASK, tool_use_id: 'tool_other' })
    r.raw(CHILD_POST)
    expect(r.tracked).toEqual([])
    r.raw(STOP)
    expect(r.emitted.map((e) => e.toolUseId)).toEqual([TASK_ID, 'tool_other'])
  })

  it('release (node closed or recycled mid-Task) finishes the child tail and forgets the node', () => {
    const r = rig()
    r.raw(TASK)
    r.raw(CHILD_POST)
    r.raw(TASK, 'n2')
    r.release('n1')
    expect(r.finished).toEqual([TASK_ID])
    r.raw(STOP) // the entry is gone: a late stop ends nothing for n1
    expect(r.emitted).toEqual([])
    r.release('n1') // idempotent
    expect(r.finished).toEqual([TASK_ID])
    r.raw(STOP, 'n2') // other nodes are untouched
    expect(r.emitted.map((e) => e.nodeId)).toEqual(['n2'])
  })

  it('keeps nodes apart and ignores events with no node', () => {
    const r = rig()
    r.raw(TASK, 'a')
    r.raw(STOP, 'b')
    expect(r.emitted).toEqual([])
    r.raw(STOP, undefined as unknown as string)
    r.raw(STOP, 'a')
    expect(r.emitted).toHaveLength(1)
  })
})

describe('cursorChildTranscript (the path comes from a hook POST)', () => {
  const ok = `${CONFIG}/projects/x/agent-transcripts/${CHILD}/${CHILD}.jsonl`
  it('accepts only the child\'s own file under <config>/projects', () => {
    expect(cursorChildTranscript(ok, CHILD, CONFIG)).toBe(ok)
    expect(cursorChildTranscript('/etc/passwd', CHILD, CONFIG)).toBeUndefined()
    expect(cursorChildTranscript(`${CONFIG}/projects/../../${CHILD}/${CHILD}.jsonl`, CHILD, CONFIG)).toBeUndefined()
    expect(cursorChildTranscript(ok.replace(`${CHILD}.jsonl`, 'other.jsonl'), CHILD, CONFIG)).toBeUndefined()
    expect(cursorChildTranscript(ok, 'not-a-uuid', CONFIG)).toBeUndefined()
    expect(cursorChildTranscript(null, CHILD, CONFIG)).toBeUndefined()
    expect(cursorChildTranscript('relative/x.jsonl', CHILD, CONFIG)).toBeUndefined()
  })
})

describe('createCursorSubagentFormatter', () => {
  it('renders the captured child transcript: task, tool call, answer, end; [REDACTED] dropped', () => {
    const out = createCursorSubagentFormatter()(fx.childTranscript.join('\n'))
    const lines = out.split('\n')
    expect(lines[0]).toMatch(/^You are the probe-reader agent/)
    expect(out).toContain('$ Read <workspace>/config.txt')
    expect(out).toContain('a=1')
    expect(out).not.toContain('[REDACTED]')
    expect(out).not.toContain('<timestamp>')
    expect(lines[lines.length - 1]).toBe('✓ done')
  })

  it('skips torn or foreign lines and names a failed end', () => {
    const f = createCursorSubagentFormatter()
    expect(f('{"role":"assistant"')).toBe('')
    expect(f('[1,2]\n"x"')).toBe('')
    expect(f('{"type":"turn_ended","status":"error"}')).toBe('✗ error')
  })
})
