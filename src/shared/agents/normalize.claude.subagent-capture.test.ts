// Behavioural pin over REAL Claude Code subagent hook payloads.
//
// FIXTURE PROVENANCE: `__fixtures__/claude/subagent-hook-payloads.json` was captured live from
// Claude Code 2.1.284 (linux-x64) on 2026-09-29, from a logged-in account, in a THROWAWAY
// `CLAUDE_CONFIG_DIR` whose only settings were capture hooks (one file per hook invocation, kept
// in firing order). Nine scenarios, print mode (`claude -p`) and the interactive TUI (inside a
// private tmux socket). Paths and session ids redacted; agent ids, tool_use ids, KEYS AND SHAPES
// UNCHANGED. The measured facts these tests pin are written up in CLAUDE.md (Subagent visualization).
//
// Why a capture and not hand-written payloads: the grok lesson (normalize.grok.capture.test.ts) —
// a payload built from documentation agrees with our reading of the documentation, not with the CLI.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import path from 'path'
import { normalizeClaude, type RawHookEnvelope } from './normalize'
import { claudeSubagentTranscriptPath } from './claude-subagents'
import { CLAUDE_HOOK_EVENTS, managedEventName } from './hook-events'

type Payload = Record<string, unknown>
const fixture = JSON.parse(
  readFileSync(path.join(__dirname, '__fixtures__/claude/subagent-hook-payloads.json'), 'utf8').replace(/\r\n/g, '\n')
) as { claudeVersion: string; scenarios: Record<string, { mode: string; events: Payload[] }> }

const events = (scenario: string): Payload[] => {
  const s = fixture.scenarios[scenario]
  if (!s) throw new Error(`no scenario ${scenario}`)
  return s.events
}
const named = (scenario: string, name: string): Payload[] => events(scenario).filter((e) => e.hook_event_name === name)
const env = (payload: Payload): RawHookEnvelope => ({ nodeId: 'node-1', agentId: 'claude', payload })
const all = (): Payload[] => Object.values(fixture.scenarios).flatMap((s) => s.events)

describe('the capture itself (facts the design rests on)', () => {
  it('SubagentStart and SubagentStop carry the PARENT session id — unlike grok, whose stop carries the child', () => {
    for (const [name, s] of Object.entries(fixture.scenarios)) {
      // The parent is whoever took the user's prompts (one scenario continues an earlier session,
      // so it has no SessionStart of its own).
      const parents = new Set(s.events.filter((e) => e.hook_event_name === 'UserPromptSubmit').map((e) => e.session_id))
      expect(parents.size, name).toBe(1)
      for (const e of s.events.filter((x) => String(x.hook_event_name).startsWith('Subagent'))) {
        expect(parents.has(e.session_id), `${name}: ${e.hook_event_name} ${e.agent_id}`).toBe(true)
      }
    }
  })

  it('SubagentStart names the child only by agent_id + agent_type: no tool_use_id, no task text', () => {
    const starts = all().filter((e) => e.hook_event_name === 'SubagentStart')
    expect(starts.length).toBeGreaterThan(10)
    for (const s of starts) {
      expect(typeof s.agent_id).toBe('string')
      expect(s.tool_use_id).toBeUndefined()
      expect(s.tool_input).toBeUndefined()
      expect(s.agent_transcript_path).toBeUndefined()
    }
  })

  it("the child transcript lives at <parent transcript dir>/subagents/agent-<agent_id>.jsonl — nested children too", () => {
    // SubagentStart does not name the file; SubagentStop does. The tail must start at SubagentStart,
    // so the path is DERIVED — and this checks the derivation against every stop the CLI produced.
    let checked = 0
    for (const s of Object.values(fixture.scenarios)) {
      const startPath = new Map(
        s.events.filter((e) => e.hook_event_name === 'SubagentStart').map((e) => [e.agent_id, e.transcript_path])
      )
      for (const stop of s.events.filter((e) => e.hook_event_name === 'SubagentStop' && startPath.has(e.agent_id))) {
        expect(
          claudeSubagentTranscriptPath(startPath.get(stop.agent_id) as string, stop.agent_id as string)
        ).toBe(stop.agent_transcript_path)
        checked++
      }
    }
    expect(checked).toBeGreaterThanOrEqual(14)
  })

  it('internal side-agents fire SubagentStop with an EMPTY agent_type and no SubagentStart at all', () => {
    const phantoms = all().filter((e) => e.hook_event_name === 'SubagentStop' && e.agent_type === '')
    expect(phantoms.length).toBeGreaterThanOrEqual(8)
    const started = new Set(all().filter((e) => e.hook_event_name === 'SubagentStart').map((e) => e.agent_id))
    for (const p of phantoms) expect(started.has(p.agent_id)).toBe(false)
  })

  it('one agent_id can start, stop, start again and stop again (a background agent resumed by its own child)', () => {
    const ev = events('interactive_nested_resume').filter((e) => String(e.hook_event_name).startsWith('Subagent'))
    const counts = new Map<string, number>()
    for (const e of ev.filter((x) => x.hook_event_name === 'SubagentStart')) {
      counts.set(e.agent_id as string, (counts.get(e.agent_id as string) ?? 0) + 1)
    }
    expect([...counts.values()]).toContain(2)
  })

  it('a killed child fires no SubagentStop (SDK interrupt)', () => {
    const ev = events('print_interrupt_foreground')
    expect(ev.some((e) => e.hook_event_name === 'SubagentStart')).toBe(true)
    expect(ev.some((e) => e.hook_event_name === 'SubagentStop')).toBe(false)
  })

  it('the async launch ack names the agent id the SubagentStart just announced', () => {
    for (const name of ['print_async', 'interactive_parallel']) {
      const ev = events(name)
      const started = ev.filter((e) => e.hook_event_name === 'SubagentStart').map((e) => e.agent_id)
      const acked = ev
        .filter((e) => e.hook_event_name === 'PostToolUse' && e.tool_name === 'Agent' && !e.agent_id)
        .map((e) => (e.tool_response as { agentId?: string }).agentId)
      expect(acked.length).toBeGreaterThan(0)
      for (const a of acked) expect(started).toContain(a)
    }
  })
})

describe('normalizeClaude over the captured native subagent hooks', () => {
  it('SubagentStart → subagent-start keyed by agent_id, typed by agent_type, marked native', () => {
    const start = named('print_sync', 'SubagentStart')[0]
    expect(normalizeClaude(env(start))).toMatchObject({
      kind: 'subagent-start',
      toolUseId: start.agent_id,
      subagentType: 'general-purpose',
      subagentSignal: 'native',
      sessionId: start.session_id
    })
  })

  it('SubagentStop → subagent-end keyed by agent_id, carrying the last assistant message', () => {
    const stop = named('print_sync', 'SubagentStop')[0]
    expect(normalizeClaude(env(stop))).toMatchObject({
      kind: 'subagent-end',
      toolUseId: stop.agent_id,
      subagentSignal: 'native',
      result: stop.last_assistant_message
    })
  })

  it('a side-agent stop still normalizes (an empty agent_type is not ours to judge here)', () => {
    // Dropping it is the lifecycle's job, by id: it never announced a start. Judging by the empty
    // type in the normalizer would also drop a REAL stop the day a release sends an empty type.
    const phantom = all().find((e) => e.hook_event_name === 'SubagentStop' && e.agent_type === '')!
    expect(normalizeClaude(env(phantom))).toMatchObject({ kind: 'subagent-end', subagentSignal: 'native' })
  })

  it('an agent id that is not a plain token is refused (it becomes a card key and a file name)', () => {
    const start = named('print_sync', 'SubagentStart')[0]
    expect(normalizeClaude(env({ ...start, agent_id: '../../x' }))).toBeNull()
    expect(normalizeClaude(env({ ...start, agent_id: 42 }))).toBeNull()
  })

  it("the tool-pairing start is marked 'tool' so the two paths can be told apart", () => {
    const pre = events('print_sync').find((e) => e.hook_event_name === 'PreToolUse' && e.tool_name === 'Agent')!
    expect(normalizeClaude(env(pre))).toMatchObject({
      kind: 'subagent-start',
      toolUseId: pre.tool_use_id,
      subagentSignal: 'tool',
      taskLabel: (pre.tool_input as { description: string }).description
    })
  })

  it('the sync tool end carries the exact agent id from tool_response.agentId', () => {
    const post = events('print_sync').find((e) => e.hook_event_name === 'PostToolUse' && e.tool_name === 'Agent')!
    expect(normalizeClaude(env(post))).toMatchObject({
      kind: 'subagent-end',
      toolUseId: post.tool_use_id,
      subagentSignal: 'tool',
      subagentAgentId: (post.tool_response as { agentId: string }).agentId
    })
  })

  it('the async launch ack stays a working state and names the exact tool_use_id → agent_id pair', () => {
    const ack = events('print_async').find((e) => e.hook_event_name === 'PostToolUse' && e.tool_name === 'Agent')!
    expect(normalizeClaude(env(ack))).toMatchObject({
      kind: 'state',
      state: 'working',
      subagentLaunch: { toolUseId: ack.tool_use_id, agentId: (ack.tool_response as { agentId: string }).agentId }
    })
  })

  it('Stop reports the ids of the background tasks still running (and none when the list is empty)', () => {
    const [first, last] = named('print_async', 'Stop')
    expect(normalizeClaude(env(first))).toMatchObject({ state: 'done', backgroundTaskIds: [
      (first.background_tasks as { id: string }[])[0].id
    ] })
    expect(normalizeClaude(env(last))?.backgroundTaskIds).toEqual([])
  })

  it('a Stop without the inventory (an older CLI) says nothing about background tasks', () => {
    const stop = named('print_async', 'Stop')[0]
    const { background_tasks: _drop, ...older } = stop
    expect(normalizeClaude(env(older))?.backgroundTaskIds).toBeUndefined()
  })

  it('a finished entry is not counted as running, and an unknown status is (the safe direction)', () => {
    const stop = named('print_async', 'Stop')[0]
    const e = normalizeClaude(
      env({
        ...stop,
        background_tasks: [
          { id: 'done1', type: 'subagent', status: 'completed' },
          { id: 'odd1', type: 'local_bash', status: 'something-new' },
          { id: 'run1', type: 'subagent', status: 'running' },
          { id: 5, status: 'running' },
          'junk'
        ]
      })
    )
    expect(e?.backgroundTaskIds).toEqual(['odd1', 'run1'])
  })

  it('backgroundSubagentIds is the SUBAGENT subset — the only background work plain --after holds on', () => {
    // The measured fixture: every running entry is an async child (`type: 'subagent'`).
    const [first, last] = named('print_async', 'Stop')
    const e1 = normalizeClaude(env(first))
    expect(e1?.backgroundSubagentIds).toEqual(e1?.backgroundTaskIds)
    expect(normalizeClaude(env(last))?.backgroundSubagentIds).toEqual([])
    // A background shell, an unknown type and a finished child do not count; no inventory = absent.
    const mixed = normalizeClaude(
      env({
        ...first,
        background_tasks: [
          { id: 'bash_devserver', type: 'local_bash', status: 'running' },
          { id: 'odd', type: 'something-new', status: 'running' },
          { id: 'done1', type: 'subagent', status: 'completed' },
          { id: 'run1', type: 'subagent', status: 'running' }
        ]
      })
    )
    expect(mixed?.backgroundTaskIds).toEqual(['bash_devserver', 'odd', 'run1'])
    expect(mixed?.backgroundSubagentIds).toEqual(['run1'])
    const { background_tasks: _drop, ...older } = first
    expect(normalizeClaude(env(older))?.backgroundSubagentIds).toBeUndefined()
  })

  it('the subagent hand-back prompt is not a genuine user turn (same rule as <task-notification>)', () => {
    const handback = events('interactive_background_then_esc').find(
      (e) => e.hook_event_name === 'UserPromptSubmit' && String(e.prompt).startsWith('<agent-message')
    )!
    expect(String(handback.prompt)).toMatch(/\[Subagent hand-back\]/)
    const e = normalizeClaude(env(handback))
    expect(e).toMatchObject({ kind: 'state', state: 'working' })
    expect(e?.newTurn).toBeUndefined()
  })

  it('an <agent-message> that is NOT a subagent hand-back stays a genuine turn', () => {
    const e = normalizeClaude(
      env({ hook_event_name: 'UserPromptSubmit', session_id: 's1', prompt: '<agent-message from="x"> hello there' })
    )
    expect(e?.newTurn).toBe(true)
  })

  it('child tool events (agent_id set) still never drive the parent — nested Agent calls included', () => {
    const nested = events('print_nested').find(
      (e) => e.hook_event_name === 'PreToolUse' && e.tool_name === 'Agent' && e.agent_id
    )!
    expect(normalizeClaude(env(nested))).toBeNull()
  })
})

describe('the managed hook subscribes what the normalizer reads', () => {
  it('every event name the captured stream maps to something is in CLAUDE_HOOK_EVENTS', () => {
    // ONE list feeds every installer (local, managed account dirs, the SSH remote host). An event
    // the normalizer understands but nobody subscribes is a feature that silently never fires.
    const subscribed = new Set<string>(CLAUDE_HOOK_EVENTS.map(managedEventName))
    const used = new Set(all().filter((e) => normalizeClaude(env(e))).map((e) => e.hook_event_name as string))
    expect(used.has('SubagentStart') && used.has('SubagentStop')).toBe(true)
    for (const name of used) expect(subscribed.has(name), name).toBe(true)
  })
})
