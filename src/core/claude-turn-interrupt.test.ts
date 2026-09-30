// An interrupted Claude turn (Esc / Ctrl+C) fires NO hook — measured on 2.1.285, the capture is
// `shared/agents/__fixtures__/claude/interrupt-capture.json`. The one trace it leaves is a USER
// record in the transcript, `[Request interrupted by user]` (or `… for tool use]`), carrying the
// same `promptId` as the turn's UserPromptSubmit `prompt_id`. These tests replay the capture
// through the real normalizer, the real transcript parser and the real status mirror.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import { normalizeClaude, type NormalizedAgentEvent } from '@shared/agents/normalize'
import { parseTurnInterrupts, CLAUDE_INTERRUPT_MARKERS, createContextTail, createTurnInterruptScanner } from './context-tail'
import {
  recordAgentEvent,
  recordTurnInterrupt,
  initAgentStatusMirror,
  _resetForTest,
  _snapshot
} from './agent-status-mirror'
import { testTmpDir } from './test-tmp'

type Payload = Record<string, unknown>
interface Scenario { description: string; hooks: Payload[]; transcript: Payload[] }
const fixture = JSON.parse(
  fs
    .readFileSync(path.join(__dirname, '../shared/agents/__fixtures__/claude/interrupt-capture.json'), 'utf8')
    .replace(/\r\n/g, '\n')
) as { claudeVersion: string; scenarios: Record<string, Scenario>; idlePrompt: { fired: Payload[] } }

// A REAL "queue a message, then Esc" transcript excerpt (redacted): the marker carries the QUEUED
// prompt's id and the queued prompt record comes right AFTER it.
const queued = JSON.parse(
  fs
    .readFileSync(path.join(__dirname, '../shared/agents/__fixtures__/claude/interrupt-queued.json'), 'utf8')
    .replace(/\r\n/g, '\n')
) as { interruptedTurn: string; queuedTurn: string; records: Payload[] }
const queuedLines = queued.records.map((r) => JSON.stringify(r))

const MARKED = ['esc_streaming', 'esc_tool_call', 'esc_permission_prompt', 'ctrl_c_streaming', 'esc_tool_call_then_80s_idle']
const REWOUND = ['ctrl_c_before_first_token', 'esc_before_first_token']
const sc = (k: string): Scenario => {
  const s = fixture.scenarios[k]
  if (!s) throw new Error(`no scenario ${k}`)
  return s
}
const promptIdOf = (s: Scenario): string =>
  String(s.hooks.find((h) => h.hook_event_name === 'UserPromptSubmit')!.prompt_id)
const lines = (s: Scenario): string[] => s.transcript.map((r) => JSON.stringify(r))

describe('the capture itself (facts the design rests on)', () => {
  it('no hook fires for the interrupt: every interrupted turn ends with no Stop/StopFailure/PostToolUse', () => {
    for (const k of [...MARKED, ...REWOUND]) {
      const names = sc(k).hooks.map((h) => h.hook_event_name)
      expect(names[0], k).toBe('UserPromptSubmit')
      for (const n of ['Stop', 'StopFailure', 'PostToolUse', 'PostToolUseFailure', 'SubagentStop', 'Notification'])
        expect(names, `${k} fired ${n}`).not.toContain(n)
    }
  })

  it('idle_prompt fired only after a NORMAL turn — so the idle rescue does not cover an interrupt', () => {
    const idle = fixture.idlePrompt.fired
    expect(idle.map((p) => p.notification_type)).toEqual(['idle_prompt'])
    const turnsWithIdle = new Set(idle.map((p) => p.prompt_id))
    for (const k of MARKED) expect(turnsWithIdle.has(promptIdOf(sc(k))), k).toBe(false)
  })

  it('the marker carries the SAME id as the turn’s UserPromptSubmit prompt_id', () => {
    for (const k of MARKED) {
      const markers = sc(k).transcript.filter(
        (r) =>
          r.type === 'user' &&
          Array.isArray((r.message as { content?: unknown })?.content) &&
          CLAUDE_INTERRUPT_MARKERS.has(String(((r.message as { content: { text?: string }[] }).content[0])?.text))
      )
      expect(markers.length, k).toBe(1)
      expect(markers[0].promptId, k).toBe(promptIdOf(sc(k)))
    }
  })

  it('an interrupt before the first token leaves NO marker (the prompt is rewound into the input)', () => {
    for (const k of REWOUND) expect(parseTurnInterrupts(lines(sc(k))), k).toEqual([])
  })
})

describe('parseTurnInterrupts', () => {
  it('finds exactly the captured turn id in every marked scenario, and nothing elsewhere', () => {
    for (const k of MARKED) expect(parseTurnInterrupts(lines(sc(k))), k).toEqual([promptIdOf(sc(k))])
    expect(parseTurnInterrupts(lines(sc('esc_after_background_subagent')))).toEqual([])
  })

  it('the queued-prompt case: the marker names the NEXT prompt, whose record comes after it — dropped', () => {
    const marker = queued.records.find(
      (r) => Array.isArray((r.message as { content?: unknown })?.content) &&
        CLAUDE_INTERRUPT_MARKERS.has(String(((r.message as { content: { text?: string }[] }).content[0])?.text))
    )!
    // The fact the rule rests on: the id is the queued prompt's, not the interrupted turn's.
    expect(marker.promptId).toBe(queued.queuedTurn)
    expect(marker.promptId).not.toBe(queued.interruptedTurn)
    expect(queued.records.some((r) => r.type === 'queue-operation')).toBe(true)
    expect(parseTurnInterrupts(queuedLines)).toEqual([])
    // Also when the tail read the interrupted turn's prompt in an EARLIER chunk.
    const scanner = createTurnInterruptScanner()
    expect(scanner.scan(queuedLines.slice(0, 3))).toEqual([])
    expect(scanner.scan(queuedLines.slice(3))).toEqual([])
  })

  it('a turn opened in an earlier chunk still counts (the scanner carries what it has read)', () => {
    const l = lines(sc('esc_streaming'))
    const scanner = createTurnInterruptScanner()
    expect(scanner.scan(l.slice(0, 1))).toEqual([])
    expect(scanner.scan(l.slice(1))).toEqual([promptIdOf(sc('esc_streaming'))])
    // record-only reads (the remote tail's history) remember prompts but never report.
    const r = createTurnInterruptScanner()
    expect(r.scan(l, { record: true })).toEqual([])
  })

  it('remembers a bounded number of turns, oldest dropped first', () => {
    const scanner = createTurnInterruptScanner(2)
    const prompt = (id: string) => JSON.stringify({ type: 'user', promptId: id, message: { content: 'hi' } })
    const mark = (id: string) => JSON.stringify({ type: 'user', promptId: id, message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] } })
    scanner.scan([prompt('a'), prompt('b'), prompt('c')])
    expect(scanner.scan([mark('a'), mark('b'), mark('c')])).toEqual(['b', 'c'])
  })

  const rec = (over: Payload): string =>
    JSON.stringify({
      type: 'user',
      promptId: 'p-1',
      message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] },
      ...over
    })

  it('refuses shapes that are not the CLI’s marker', () => {
    const opened = JSON.stringify({ type: 'user', promptId: 'p-1', message: { content: 'typed prompt' } })
    // No opening prompt before it: not this turn's marker.
    expect(parseTurnInterrupts([rec({})])).toEqual([])
    expect(parseTurnInterrupts([opened, rec({})])).toEqual(['p-1'])
    // A prompt the user typed is a plain string, even when it says the same words.
    expect(parseTurnInterrupts([opened, rec({ message: { role: 'user', content: '[Request interrupted by user]' } })])).toEqual([])
    // Other wording: closed set, a future spelling degrades to nothing.
    expect(parseTurnInterrupts([opened, rec({ message: { content: [{ type: 'text', text: '[Request interrupted by user!]' }] } })])).toEqual([])
    // Extra parts, a sidechain, an assistant record, a hostile id, no id, a torn line.
    expect(parseTurnInterrupts([opened, rec({ message: { content: [{ type: 'text', text: '[Request interrupted by user]' }, { type: 'text', text: 'x' }] } })])).toEqual([])
    expect(parseTurnInterrupts([opened, rec({ isSidechain: true })])).toEqual([])
    expect(parseTurnInterrupts([opened, rec({ type: 'assistant' })])).toEqual([])
    expect(parseTurnInterrupts([rec({ promptId: 'a b;rm' })])).toEqual([])
    expect(parseTurnInterrupts([rec({ promptId: undefined })])).toEqual([])
    expect(parseTurnInterrupts([opened, rec({}).slice(0, 60)])).toEqual([])
  })
})

describe('normalizeClaude carries the turn id', () => {
  it('on UserPromptSubmit only, and only as a plain token', () => {
    const s = sc('esc_tool_call')
    const evs = s.hooks.map((payload) => normalizeClaude({ nodeId: 'n', agentId: 'claude', payload }))
    expect(evs[0]).toMatchObject({ state: 'working', newTurn: true, turnId: promptIdOf(s) })
    expect(evs[1]?.turnId).toBeUndefined()
    // A prompt with no usable id says so with '' — which makes the mirror FORGET the old turn id.
    const hostile = normalizeClaude({ nodeId: 'n', agentId: 'claude', payload: { ...s.hooks[0], prompt_id: 'x y' } })
    expect(hostile?.turnId).toBe('')
    const { prompt_id: _drop, ...noId } = s.hooks[0]
    expect(normalizeClaude({ nodeId: 'n', agentId: 'claude', payload: noId })?.turnId).toBe('')
  })
})

describe('recordTurnInterrupt (the status mirror decides)', () => {
  let dir: string
  beforeEach(() => {
    _resetForTest()
    dir = testTmpDir('nt-turn-interrupt-')
    initAgentStatusMirror(path.join(dir, 'agent-status.json'))
  })
  afterEach(() => {
    _resetForTest()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  const NODE = 'node-1'
  const replayHooks = (s: Scenario): NormalizedAgentEvent[] =>
    s.hooks
      .map((payload) => normalizeClaude({ nodeId: NODE, agentId: 'claude', payload }))
      .filter((e): e is NormalizedAgentEvent => !!e)
      .map((e) => recordAgentEvent(e))
  const sessionOf = (s: Scenario): string => String(s.hooks[0].session_id)

  it('ends the live turn for every captured interrupt: working (or blocked) → interrupted done', () => {
    for (const k of MARKED) {
      _resetForTest()
      const s = sc(k)
      replayHooks(s)
      const before = _snapshot()[NODE]?.state
      expect(before, k).toBe(k === 'esc_permission_prompt' ? 'blocked' : 'working')
      const [turn] = parseTurnInterrupts(lines(s))
      const ev = recordTurnInterrupt(NODE, sessionOf(s), turn)
      expect(ev, k).toMatchObject({ nodeId: NODE, kind: 'state', state: 'done', interrupted: true })
      expect(ev?.verified, k).toBeUndefined()
      expect(_snapshot()[NODE]?.state, k).toBe('done')
      // Idempotent: the same marker read twice ends nothing more.
      expect(recordTurnInterrupt(NODE, sessionOf(s), turn), k).toBeUndefined()
    }
  })

  it('a marker from an OLDER turn changes nothing (e.g. read back from history on a first read)', () => {
    const a = sc('esc_streaming')
    replayHooks(a)
    const [oldTurn] = parseTurnInterrupts(lines(a))
    // A new turn in the same session.
    recordAgentEvent({ nodeId: NODE, agentId: 'claude', sessionId: sessionOf(a), kind: 'state', state: 'working', newTurn: true, turnId: 'next-turn' })
    expect(recordTurnInterrupt(NODE, sessionOf(a), oldTurn)).toBeUndefined()
    expect(_snapshot()[NODE]?.state).toBe('working')
  })

  it('queue a message, then Esc: the NEW live turn is NOT ended (the review’s blocker)', () => {
    const SID = 'sess-q'
    recordAgentEvent({ nodeId: NODE, agentId: 'claude', sessionId: SID, kind: 'state', state: 'working', newTurn: true, turnId: queued.interruptedTurn })
    // The queued prompt's UserPromptSubmit: it is the node's current turn now.
    recordAgentEvent({ nodeId: NODE, agentId: 'claude', sessionId: SID, kind: 'state', state: 'working', newTurn: true, turnId: queued.queuedTurn })
    // The tail's 1 Hz read lands after that hook and sees marker + queued prompt together — also
    // on a first read that starts at the queued prompt.
    for (const id of createTurnInterruptScanner().scan(queuedLines)) recordTurnInterrupt(NODE, SID, id)
    for (const id of createTurnInterruptScanner().scan(queuedLines.slice(-2))) recordTurnInterrupt(NODE, SID, id)
    expect(_snapshot()[NODE]?.state).toBe('working')
  })

  it('a prompt with no usable id forgets the previous turn id', () => {
    const s = sc('esc_tool_call')
    replayHooks(s)
    recordAgentEvent(normalizeClaude({ nodeId: NODE, agentId: 'claude', payload: { ...s.hooks[0], prompt_id: undefined } })!)
    expect(_snapshot()[NODE]?.turnId).toBeUndefined()
    expect(recordTurnInterrupt(NODE, sessionOf(s), promptIdOf(s))).toBeUndefined()
  })

  it('refuses another session, a finished turn, and an entry with no turn id (after a restart)', () => {
    const s = sc('esc_tool_call')
    replayHooks(s)
    const turn = promptIdOf(s)
    expect(recordTurnInterrupt(NODE, 'another-session', turn)).toBeUndefined()
    expect(recordTurnInterrupt('another-node', sessionOf(s), turn)).toBeUndefined()
    recordAgentEvent({ nodeId: NODE, agentId: 'claude', sessionId: sessionOf(s), kind: 'state', state: 'done' })
    expect(recordTurnInterrupt(NODE, sessionOf(s), turn)).toBeUndefined()

    _resetForTest()
    recordAgentEvent({ nodeId: NODE, agentId: 'claude', sessionId: sessionOf(s), kind: 'state', state: 'working' })
    expect(recordTurnInterrupt(NODE, sessionOf(s), turn)).toBeUndefined()
    expect(_snapshot()[NODE]?.state).toBe('working')
  })

  it('a session boundary forgets the turn', () => {
    const s = sc('esc_tool_call')
    replayHooks(s)
    recordAgentEvent({ nodeId: NODE, agentId: 'claude', sessionId: sessionOf(s), kind: 'session', sessionPhase: 'start' })
    recordAgentEvent({ nodeId: NODE, agentId: 'claude', sessionId: sessionOf(s), kind: 'state', state: 'working' })
    expect(recordTurnInterrupt(NODE, sessionOf(s), promptIdOf(s))).toBeUndefined()
  })
})

it('the local context tail reports a marker appended to a tracked transcript, torn line included', async () => {
  const dir = testTmpDir('nt-interrupt-tail-')
  const file = path.join(dir, 'session.jsonl')
  const s = sc('esc_streaming')
  const onTurnInterrupted = (sessionId: string, turnId: string): void => void got.push([sessionId, turnId])
  const got: [string, string][] = []
  const tail = createContextTail(() => {}, { onTurnInterrupted })
  try {
    fs.writeFileSync(file, lines(s).slice(0, -1).join('\n') + '\n')
    tail.track('session', file)
    await new Promise((r) => setTimeout(r, 1200))
    expect(got).toEqual([])
    const marker = lines(s).at(-1)!
    fs.appendFileSync(file, marker.slice(0, 50))
    await new Promise((r) => setTimeout(r, 1200))
    expect(got).toEqual([])
    fs.appendFileSync(file, marker.slice(50) + '\n')
    await new Promise((r) => setTimeout(r, 1200))
    expect(got).toEqual([['session', promptIdOf(s)]])
  } finally {
    tail.untrack('session')
    fs.rmSync(dir, { recursive: true, force: true })
  }
}, 8000)
