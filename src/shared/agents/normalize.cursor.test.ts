// FIXTURE PROVENANCE: `__fixtures__/cursor/hook-payloads.json` was captured live from
// cursor-agent 2026.09.28-64d2043 (headless runs, macOS). It holds NO `beforeSubmitPrompt`, `stop`
// or `postToolUseFailure`: headless runs never fired the first two. Those three cases below use
// payloads built from the bundle's proto, and say so: they pin OUR reading, not Cursor's wire.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import path from 'path'
import { normalizeClaude, normalizeCursor, normalizeFor, type RawHookEnvelope } from './normalize'

const fixture = JSON.parse(
  readFileSync(path.join(__dirname, '__fixtures__/cursor/hook-payloads.json'), 'utf8')
) as { events: Record<string, unknown>[] }

const pick = (name: string, ok?: (p: Record<string, unknown>) => boolean) => {
  const hit = fixture.events.filter((e) => e.hook_event_name === name && (ok ? ok(e) : true))
  if (hit.length !== 1) throw new Error(`fixture needs exactly one ${name}, got ${hit.length}`)
  return hit[0]
}
const env = (payload: Record<string, unknown>): RawHookEnvelope => ({ nodeId: 'n1', agentId: 'cursor', payload })
const CONV = '5a27c746-14a7-472d-8e3f-7f335a9df0db'

// Interactive TUI capture (2026.10.01): a parent turn with a Task, its child's tool events, stop.
const sub = JSON.parse(
  readFileSync(path.join(__dirname, '__fixtures__/cursor/subagent-payloads.json'), 'utf8')
) as { events: Record<string, unknown>[]; childStoreSubagentInfo: { toolCallId: string } }
const PARENT = '13993e38-911a-4558-8af0-73729368b113'
const subPick = (name: string, tool?: string) => {
  const hit = sub.events.filter((e) => e.hook_event_name === name && (tool ? e.tool_name === tool : true))
  if (hit.length !== 1) throw new Error(`subagent fixture needs exactly one ${name}/${tool}, got ${hit.length}`)
  return hit[0]
}

describe('normalizeCursor over captured cursor-agent payloads', () => {
  it('records conversation_id (== session_id on the wire) as the session id', () => {
    const e = subPick('beforeSubmitPrompt')
    expect(e.conversation_id).toBe(e.session_id)
    expect(normalizeCursor(env(e))?.sessionId).toBe(PARENT)
    // Either spelling alone is enough.
    expect(normalizeCursor(env({ hook_event_name: 'postToolUse', session_id: 's' }))?.sessionId).toBe('s')
    expect(normalizeCursor(env({ hook_event_name: 'postToolUse' }))?.sessionId).toBeUndefined()
  })

  it('maps a parent tool event to working (interactive: generation_id is the turn, not the chat)', () => {
    const e: Record<string, unknown> = { ...subPick('beforeSubmitPrompt'), hook_event_name: 'postToolUse', tool_name: 'Read' }
    expect(e.generation_id).not.toBe(e.conversation_id)
    expect(normalizeCursor(env(e))).toEqual({ nodeId: 'n1', agentId: 'cursor', sessionId: PARENT, kind: 'state', state: 'working' })
  })

  it('a HEADLESS (-p) capture has generation_id == conversation_id, so its tool events read as a child and drive nothing', () => {
    // Trade-off, documented in docs/cursor-agent.md: a headless run fires no beforeSubmitPrompt
    // or stop either, so its tool events only ever lit a RUNNING badge nothing could clear.
    const e = pick('preToolUse')
    expect(e.generation_id).toBe(e.conversation_id)
    expect(e.conversation_id).toBe(CONV)
    expect(normalizeCursor(env(e))).toBeNull()
  })

  it('ignores every captured event it does not subscribe to', () => {
    for (const n of ['sessionStart', 'beforeShellExecution', 'afterShellExecution', 'afterAgentThought'])
      for (const e of fixture.events.filter((x) => x.hook_event_name === n)) expect(normalizeCursor(env(e)), n).toBeNull()
  })

  it('maps sessionEnd to a session end, but not a background agent\'s', () => {
    for (const e of fixture.events.filter((x) => x.hook_event_name === 'sessionEnd')) {
      const n = normalizeCursor(env(e))
      expect(n?.kind).toBe('session')
      expect(n?.sessionPhase).toBe('end')
      expect(n?.sessionId).toBe(e.conversation_id)
    }
    expect(normalizeCursor(env({ hook_event_name: 'sessionEnd', conversation_id: 'c', is_background_agent: true }))).toBeNull()
  })

  it('matches the event name exactly, never as a substring', () => {
    for (const n of ['PreToolUse', 'pretooluse', 'preToolUseX', 'stopped', 'beforeSubmitPromptNow', '', 5])
      expect(normalizeCursor(env({ hook_event_name: n, conversation_id: 'c' })), String(n)).toBeNull()
    expect(normalizeCursor(env({}))).toBeNull()
  })

  it('a subagent tool call (parent_tool_call_id) drives nothing and records no session', () => {
    // UNMEASURED marker, from the bundle's PreToolUseRequestQuery field 10.
    const child = { hook_event_name: 'preToolUse', conversation_id: 'child', generation_id: 'turn', parent_tool_call_id: 't1' }
    expect(normalizeCursor(env(child))).toBeNull()
    expect(normalizeCursor(env({ ...child, parent_tool_call_id: undefined }))?.state).toBe('working')
  })

  it('MEASURED child tool events (own chat id as conversation AND generation id) drive nothing', () => {
    const pre = subPick('preToolUse', 'Read')
    const post = subPick('postToolUse', 'Read')
    for (const e of [pre, post]) {
      expect(e.conversation_id).not.toBe(PARENT)
      expect(e.parent_tool_call_id).toBeUndefined()
      expect(normalizeCursor(env(e))).toBeNull()
    }
  })

  it('the parent Task preToolUse starts a subagent card keyed by tool_use_id', () => {
    const task = subPick('preToolUse', 'Task')
    expect(normalizeCursor(env(task))).toEqual({
      nodeId: 'n1',
      agentId: 'cursor',
      sessionId: PARENT,
      kind: 'subagent-start',
      toolUseId: task.tool_use_id,
      subagentType: 'explore',
      taskLabel: (task.tool_input as { description: string }).description
    })
    // The child's store names the same id: the correlation exists on disk, never in a hook payload.
    expect(sub.childStoreSubagentInfo.toolCallId).toBe(task.tool_use_id)
  })

  it('a Task without a tool_use_id, or a postToolUse for Task, stays a plain working event', () => {
    const task = subPick('preToolUse', 'Task')
    expect(normalizeCursor(env({ ...task, tool_use_id: undefined }))?.kind).toBe('state')
    expect(normalizeCursor(env({ ...task, hook_event_name: 'postToolUse' }))?.state).toBe('working')
  })

  it('beforeSubmitPrompt starts a turn (built from the bundle schema, never captured)', () => {
    expect(normalizeCursor(env({ hook_event_name: 'beforeSubmitPrompt', conversation_id: 'c', prompt: 'x' }))).toEqual({
      nodeId: 'n1', agentId: 'cursor', sessionId: 'c', kind: 'state', state: 'working', newTurn: true
    })
  })

  it('stop ends the turn; aborted is interrupted, error is errored, anything else is plain done (never captured)', () => {
    const stop = (status?: unknown) => normalizeCursor(env({ hook_event_name: 'stop', conversation_id: 'c', status }))
    expect(stop('completed')).toEqual({ nodeId: 'n1', agentId: 'cursor', sessionId: 'c', kind: 'state', state: 'done' })
    expect(stop('aborted')?.interrupted).toBe(true)
    expect(stop('aborted')?.errored).toBeUndefined()
    expect(stop('error')?.errored).toBe(true)
    expect(stop('error')?.interrupted).toBeUndefined()
    expect(stop('surprise')).toMatchObject({ state: 'done' })
    expect(stop(undefined)).toMatchObject({ state: 'done' })
  })

  it('never claims NEEDS YOU (no measured signal exists)', () => {
    for (const e of fixture.events) {
      const r = normalizeCursor(env(e))
      expect(r?.state === 'waiting' || r?.state === 'blocked').toBe(false)
    }
  })

  it('is what the hook server dispatches for the cursor route', () => {
    expect(normalizeFor('cursor', env(subPick('stop')))?.state).toBe('done')
  })

  it('cross-fire is inert: nodeterm\'s claude hook also runs under cursor and finds nothing it knows', () => {
    // cursor-agent loads ~/.claude/settings.json hooks (measured: a matcher-bearing claude-format
    // project file fired on cursor's preToolUse/postToolUse/sessionStart), so /hook/claude receives
    // cursor's camelCase payloads for the same node. normalizeClaude compares exact PascalCase names.
    for (const e of fixture.events)
      expect(normalizeClaude({ nodeId: 'n1', agentId: 'claude', payload: e }), String(e.hook_event_name)).toBeNull()
    for (const n of ['beforeSubmitPrompt', 'stop', 'postToolUseFailure'])
      expect(normalizeClaude({ nodeId: 'n1', agentId: 'claude', payload: { hook_event_name: n, session_id: 'c' } }), n).toBeNull()
  })
})
