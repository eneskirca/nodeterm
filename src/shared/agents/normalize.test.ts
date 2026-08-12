import { describe, it, expect } from 'vitest'
import { normalizeClaude, normalizeCodex, normalizeFor, type RawHookEnvelope } from './normalize'

function env(payload: Record<string, unknown>): RawHookEnvelope {
  return { nodeId: 'n1', agentId: 'claude', payload }
}

describe('normalizeClaude — turn-end signals', () => {
  it('Stop → done, not interrupted', () => {
    const e = normalizeClaude(env({ hook_event_name: 'Stop', session_id: 's1' }))
    expect(e).toMatchObject({ kind: 'state', state: 'done', sessionId: 's1' })
    expect(e?.interrupted).toBeFalsy()
  })

  it('Stop with is_interrupt → done + interrupted (user pressed Esc)', () => {
    const e = normalizeClaude(env({ hook_event_name: 'Stop', is_interrupt: true }))
    expect(e).toMatchObject({ kind: 'state', state: 'done', interrupted: true })
  })

  // Claude Code skips the normal Stop hook when the turn dies on an API/model error and
  // fires StopFailure instead — without mapping it, the badge sticks on RUNNING forever.
  it('StopFailure → done (API-error turn end)', () => {
    const e = normalizeClaude(env({ hook_event_name: 'StopFailure' }))
    expect(e).toMatchObject({ kind: 'state', state: 'done' })
  })
})

describe('normalizeClaude — PermissionRequest (deterministic approvals)', () => {
  it('PermissionRequest → blocked, threading the merged nodeterm_pending_id', () => {
    const e = normalizeClaude(
      env({
        hook_event_name: 'PermissionRequest',
        session_id: 's1',
        last_assistant_message: 'Approve write',
        nodeterm_pending_id: 'n1-1720-42'
      })
    )
    expect(e).toMatchObject({ kind: 'state', state: 'blocked', pendingId: 'n1-1720-42' })
  })

  it('omits pendingId when the hook did not arm the wait branch (legacy prompt path)', () => {
    const e = normalizeClaude(env({ hook_event_name: 'PermissionRequest', session_id: 's1' }))
    expect(e).toMatchObject({ kind: 'state', state: 'blocked' })
    expect(e && 'pendingId' in e).toBe(false)
  })
})

describe('normalizeClaude — deterministic-approval "answered" signal', () => {
  // The signal rides ALONGSIDE the original PermissionRequest payload, so it must be matched BEFORE
  // hook_event_name (which would otherwise map to blocked) and yield a synthetic working transition.
  it('nodeterm_answered=allow → working, threading pendingId, over the PermissionRequest payload', () => {
    const e = normalizeClaude(
      env({
        hook_event_name: 'PermissionRequest',
        session_id: 's1',
        nodeterm_pending_id: 'n1-1720-42',
        nodeterm_answered: 'allow'
      })
    )
    expect(e).toMatchObject({ kind: 'state', state: 'working', pendingId: 'n1-1720-42', sessionId: 's1' })
    // A working state carries no blocked/waiting signal — it never produces a new inbox ask.
    expect(e?.state).not.toBe('blocked')
  })

  it('nodeterm_answered=deny also → working (the agent typically continues the turn)', () => {
    const e = normalizeClaude(
      env({ hook_event_name: 'PermissionRequest', nodeterm_pending_id: 'n1-9-9', nodeterm_answered: 'deny' })
    )
    expect(e).toMatchObject({ kind: 'state', state: 'working', pendingId: 'n1-9-9' })
  })

  it('an unrecognized nodeterm_answered value is ignored (falls through to the PermissionRequest map)', () => {
    const e = normalizeClaude(env({ hook_event_name: 'PermissionRequest', nodeterm_answered: 'maybe' }))
    expect(e).toMatchObject({ kind: 'state', state: 'blocked' })
  })
})

describe('normalizeClaude — async subagents', () => {
  it('PostToolUse for a sync subagent → subagent-end with stats', () => {
    const e = normalizeClaude(
      env({
        hook_event_name: 'PostToolUse',
        tool_name: 'Task',
        tool_use_id: 'tu1',
        tool_response: { content: [{ type: 'text', text: 'the answer' }], totalDurationMs: 1200 }
      })
    )
    expect(e).toMatchObject({ kind: 'subagent-end', toolUseId: 'tu1', durationMs: 1200, result: 'the answer' })
  })

  // Claude Code launches subagents async by default: PostToolUse fires ~immediately with a
  // launch acknowledgment ({isAsync, status:'async_launched'}), NOT the finished result. That
  // must not end the card — the real end arrives later via the parent's <task-notification>.
  it('PostToolUse for an async launch → NOT subagent-end (card stays working)', () => {
    const e = normalizeClaude(
      env({
        hook_event_name: 'PostToolUse',
        tool_name: 'Task',
        tool_use_id: 'tu1',
        tool_response: { isAsync: true, status: 'async_launched', agentId: 'a1' }
      })
    )
    expect(e?.kind).not.toBe('subagent-end')
    expect(e).toMatchObject({ kind: 'state', state: 'working' })
  })

  it('UserPromptSubmit → working with newTurn', () => {
    const e = normalizeClaude(env({ hook_event_name: 'UserPromptSubmit', prompt: 'do things' }))
    expect(e).toMatchObject({ kind: 'state', state: 'working', newTurn: true, task: 'do things' })
  })

  // A completed async subagent is delivered back as a queued <task-notification> prompt.
  // That is not a genuine user turn: flagging it newTurn would clear the whole subagent
  // fan-out at the exact moment one of the cards completes.
  it('UserPromptSubmit of a <task-notification> → working but NOT a new turn', () => {
    const e = normalizeClaude(
      env({
        hook_event_name: 'UserPromptSubmit',
        prompt: '<task-notification>\n<task-id>a1</task-id>\n<tool-use-id>tu1</tool-use-id>\n</task-notification>'
      })
    )
    expect(e).toMatchObject({ kind: 'state', state: 'working' })
    expect(e?.newTurn).toBeFalsy()
  })
})

describe('normalizeClaude — recurring (cron/schedule/loop)', () => {
  it('CronCreate PreToolUse → recurring cron with schedule + task', () => {
    const e = normalizeClaude(
      env({
        hook_event_name: 'PreToolUse',
        tool_name: 'CronCreate',
        tool_input: { cron: '0 9 * * *', prompt: 'daily report' }
      })
    )
    expect(e).toMatchObject({
      kind: 'recurring',
      recurringKind: 'cron',
      schedule: '0 9 * * *',
      task: 'daily report'
    })
    expect(e?.recurringEnd).toBeFalsy()
  })

  // A cron outlives turns and sessions — its card should only leave the canvas when the
  // cron itself is removed. CronDelete is that signal.
  it('CronDelete PreToolUse → recurring END (clears the cron card)', () => {
    const e = normalizeClaude(env({ hook_event_name: 'PreToolUse', tool_name: 'CronDelete' }))
    expect(e).toMatchObject({ kind: 'recurring', recurringEnd: true })
  })
})

describe('normalizeClaude — background shell tasks', () => {
  // A background shell task lives INSIDE the CLI process, so `/exit` (Eco hibernation, the bulk
  // restart) kills it silently. This event is the stamp those two exclude on.
  it('claude PreToolUse Bash with run_in_background=true is a background-task event', () => {
    const e = normalizeClaude(
      env({
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'sleep 999', run_in_background: true }
      })
    )
    expect(e?.kind).toBe('background-task')
  })

  // The mutation guard: dropping the `tool_name` check, the `ev` check, or matching truthily
  // instead of `=== true` each flips a row here — the truthy match flips two. Those two
  // truthy-but-not-`true` rows are what pin the strict compare: the boolean rows below are both
  // falsy, so on their own they would pass a `!!p.tool_input?.run_in_background` implementation.
  it('foreground Bash, false/absent/truthy-non-true flags, PostToolUse and other tools stay generic working', () => {
    for (const payload of [
      { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } },
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'ls', run_in_background: false }
      },
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        // A hand-rolled/forwarded payload could carry 1 or "true"; only a real boolean counts.
        tool_input: { command: 'ls', run_in_background: 1 }
      },
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'ls', run_in_background: 'true' }
      },
      {
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'ls', run_in_background: true }
      },
      { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { run_in_background: true } }
    ]) {
      const e = normalizeClaude(env(payload))
      expect(e?.kind, JSON.stringify(payload)).toBe('state')
      expect(e?.state, JSON.stringify(payload)).toBe('working')
    }
  })
})

describe('normalizeClaude — permission signals', () => {
  it('PermissionRequest → blocked', () => {
    const e = normalizeClaude(env({ hook_event_name: 'PermissionRequest' }))
    expect(e).toMatchObject({ kind: 'state', state: 'blocked' })
  })

  it('Notification permission_prompt still maps to blocked', () => {
    const e = normalizeClaude(
      env({ hook_event_name: 'Notification', notification_type: 'permission_prompt' })
    )
    expect(e).toMatchObject({ kind: 'state', state: 'blocked' })
  })

  // Claude Code fires an idle_prompt Notification whenever it is sitting at its prompt: after a
  // normally-finished turn (already done → the consumers' working-only rule makes it a no-op) AND
  // after an Esc that aborted a tool call without ever running Stop — the one case that left a node
  // stuck on `working`. It is a RESCUE, hence `idle` + `interrupted`, never a celebration.
  // Mapping it to `waiting` (the obvious reading) is what used to stick NEEDS YOU on finished nodes.
  it('Notification idle_prompt → an idle, interrupted done (the stuck-working rescue)', () => {
    const e = normalizeClaude(
      env({
        hook_event_name: 'Notification',
        notification_type: 'idle_prompt',
        message: 'Claude is waiting for your input'
      })
    )
    expect(e).toMatchObject({ kind: 'state', state: 'done', idle: true, interrupted: true })
  })

  it('Notification elicitation_dialog / agent_needs_input → waiting', () => {
    for (const t of ['elicitation_dialog', 'agent_needs_input']) {
      const e = normalizeClaude(env({ hook_event_name: 'Notification', notification_type: t }))
      expect(e).toMatchObject({ kind: 'state', state: 'waiting' })
    }
  })

  it('informational / unknown Notification types do not change state', () => {
    for (const t of ['auth_success', 'elicitation_complete', 'elicitation_response', 'agent_completed', 'something_new', undefined]) {
      const e = normalizeClaude(env({ hook_event_name: 'Notification', notification_type: t }))
      expect(e).toBeNull()
    }
  })
})

describe('normalizeOpencode', () => {
  const ocEnv = (payload: Record<string, unknown>): RawHookEnvelope => ({
    nodeId: 'n1',
    agentId: 'opencode',
    payload
  })

  it('maps session.created to a session start with the id', () => {
    expect(normalizeFor('opencode', ocEnv({ event: 'session.created', sessionID: 'ses_1' }))).toEqual({
      nodeId: 'n1',
      agentId: 'opencode',
      sessionId: 'ses_1',
      kind: 'session',
      sessionPhase: 'start'
    })
  })

  it('maps a user message.updated to working + newTurn', () => {
    expect(
      normalizeFor('opencode', ocEnv({ event: 'message.updated', role: 'user', sessionID: 'ses_1' }))
    ).toMatchObject({ kind: 'state', state: 'working', newTurn: true })
  })

  it('maps tool.execute.before to working (no newTurn)', () => {
    const e = normalizeFor('opencode', ocEnv({ event: 'tool.execute.before' }))
    expect(e).toMatchObject({ kind: 'state', state: 'working' })
    expect(e?.newTurn).toBeUndefined()
  })

  it('maps permission.asked to blocked and permission.replied back to working', () => {
    expect(normalizeFor('opencode', ocEnv({ event: 'permission.asked' }))).toMatchObject({ state: 'blocked' })
    expect(normalizeFor('opencode', ocEnv({ event: 'permission.replied' }))).toMatchObject({ state: 'working' })
    // Question (elicitation) dialog, measured on 1.18.3 — blocks the turn without idling.
    expect(normalizeFor('opencode', ocEnv({ event: 'question.asked' }))).toMatchObject({ state: 'blocked' })
    expect(normalizeFor('opencode', ocEnv({ event: 'question.replied' }))).toMatchObject({ state: 'working' })
    expect(normalizeFor('opencode', ocEnv({ event: 'question.rejected' }))).toMatchObject({ state: 'working' })
  })

  it('maps session.idle and session.error to done', () => {
    expect(normalizeFor('opencode', ocEnv({ event: 'session.idle' }))).toMatchObject({ state: 'done' })
    expect(normalizeFor('opencode', ocEnv({ event: 'session.error' }))).toMatchObject({ state: 'done' })
  })

  it('ignores unknown events', () => {
    expect(normalizeFor('opencode', ocEnv({ event: 'tui.toast.show' }))).toBeNull()
  })
})

describe('normalizeCodex — request_user_input (ask-the-user)', () => {
  function cenv(payload: Record<string, unknown>): RawHookEnvelope {
    return { nodeId: 'n1', agentId: 'codex', payload }
  }

  it('PreToolUse(request_user_input) → waiting + awaitingInput, carrying the question', () => {
    const e = normalizeCodex(
      cenv({
        hook_event_name: 'PreToolUse',
        session_id: 's1',
        tool_name: 'request_user_input',
        tool_input: { questions: [{ question: 'Choose A or B?' }] }
      })
    )
    expect(e).toMatchObject({
      kind: 'state',
      state: 'waiting',
      awaitingInput: true,
      lastMessage: 'Choose A or B?',
      sessionId: 's1'
    })
  })

  // The ask ends the turn; a PostToolUse for the ask itself is an immediate ack, not the
  // user's answer (that arrives as a fresh UserPromptSubmit) — it must not clear the ask.
  it('PostToolUse(request_user_input) → null (must not clear the ask)', () => {
    const e = normalizeCodex(cenv({ hook_event_name: 'PostToolUse', tool_name: 'request_user_input' }))
    expect(e).toBeNull()
  })

  it('other tool events still map to working, without the flag', () => {
    const e = normalizeCodex(cenv({ hook_event_name: 'PreToolUse', tool_name: 'shell' }))
    expect(e).toMatchObject({ kind: 'state', state: 'working' })
    expect(e?.awaitingInput).toBeFalsy()
  })
})
