import { describe, it, expect } from 'vitest'
import {
  normalizeClaude,
  normalizeCodex,
  normalizeCopilot,
  normalizeDevin,
  normalizeFor,
  type RawHookEnvelope
} from './normalize'

function env(payload: Record<string, unknown>): RawHookEnvelope {
  return { nodeId: 'n1', agentId: 'claude', payload }
}

function copilotEnv(payload: Record<string, unknown>): RawHookEnvelope {
  return { nodeId: 'n1', agentId: 'copilot', payload }
}

describe('normalizeCopilot', () => {
  it('maps session boundaries and captures the CLI session id', () => {
    expect(normalizeCopilot(copilotEnv({ hook_event_name: 'SessionStart', session_id: 's1' }))).toEqual({
      nodeId: 'n1',
      agentId: 'copilot',
      sessionId: 's1',
      kind: 'session',
      sessionPhase: 'start'
    })
    expect(normalizeCopilot(copilotEnv({ hook_event_name: 'SessionEnd', session_id: 's1' }))).toMatchObject({
      kind: 'session',
      sessionPhase: 'end'
    })
  })

  it('maps turn and tool lifecycle without treating a failed tool as a finished turn', () => {
    expect(
      normalizeCopilot(copilotEnv({ hook_event_name: 'UserPromptSubmit', prompt: 'fix it' }))
    ).toMatchObject({ state: 'working', newTurn: true, task: 'fix it' })
    for (const hook_event_name of ['PreToolUse', 'PostToolUse', 'PostToolUseFailure']) {
      expect(normalizeCopilot(copilotEnv({ hook_event_name })), hook_event_name).toMatchObject({
        state: 'working'
      })
    }
    expect(
      normalizeCopilot(
        copilotEnv({ hook_event_name: 'Stop', last_assistant_message: 'finished' })
      )
    ).toMatchObject({ state: 'done', lastMessage: 'finished' })
  })

  it('maps only the documented needs-user notifications', () => {
    expect(
      normalizeCopilot(
        copilotEnv({
          hook_event_name: 'Notification',
          notification_type: 'permission_prompt',
          message: 'Approve command?'
        })
      )
    ).toMatchObject({ state: 'blocked', lastMessage: 'Approve command?' })
    expect(
      normalizeCopilot(
        copilotEnv({
          hook_event_name: 'Notification',
          notification_type: 'elicitation_dialog',
          message: 'Which option?'
        })
      )
    ).toMatchObject({ state: 'waiting', lastMessage: 'Which option?' })
    for (const notification_type of ['agent_idle', 'agent_completed', 'unknown_future_type']) {
      expect(
        normalizeCopilot(copilotEnv({ hook_event_name: 'Notification', notification_type })),
        notification_type
      ).toBeNull()
    }
  })

  it('routes through the shared dispatcher', () => {
    expect(normalizeFor('copilot', copilotEnv({ hook_event_name: 'Stop' }))).toMatchObject({
      agentId: 'copilot',
      state: 'done'
    })
  })
})

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

// Payload shapes below are the LIVE capture from codex-cli 0.146.0 (spawn_agent measurement run,
// 2026-08-24): parent session_id + the child's agent_id/agent_type; SubagentStart's
// transcript_path is the CHILD's rollout; a child's own tool events carry agent_id too.
describe('normalizeCodex — subagents (spawn_agent)', () => {
  function cenv(payload: Record<string, unknown>): RawHookEnvelope {
    return { nodeId: 'n1', agentId: 'codex', payload }
  }

  it('SubagentStart → subagent-start keyed by agent_id, typed by agent_type', () => {
    const e = normalizeCodex(
      cenv({
        hook_event_name: 'SubagentStart',
        session_id: '01a0343d-d249-73e2-a462-e824df60d95c',
        turn_id: '01a0343d-ef3a-7840-b6ed-683b7b024519',
        transcript_path: '/home/u/.codex/sessions/2026/08/24/rollout-child.jsonl',
        agent_id: '01a0343d-ef01-7700-b32f-c32ee1fc21f9',
        agent_type: 'default'
      })
    )
    expect(e).toMatchObject({
      kind: 'subagent-start',
      toolUseId: '01a0343d-ef01-7700-b32f-c32ee1fc21f9',
      subagentType: 'default',
      sessionId: '01a0343d-d249-73e2-a462-e824df60d95c'
    })
    // The spawn message is encrypted end-to-end — there is no task text to label the card with.
    expect(e?.taskLabel).toBeUndefined()
  })

  it('SubagentStop → subagent-end carrying the child final answer as result', () => {
    const e = normalizeCodex(
      cenv({
        hook_event_name: 'SubagentStop',
        session_id: '01a0343d-d249-73e2-a462-e824df60d95c',
        agent_id: '01a0343d-ef01-7700-b32f-c32ee1fc21f9',
        agent_type: 'default',
        agent_transcript_path: '/home/u/.codex/sessions/2026/08/24/rollout-child.jsonl',
        last_assistant_message: 'The command output was:\n\n`hello-from-subagent`'
      })
    )
    expect(e).toMatchObject({
      kind: 'subagent-end',
      toolUseId: '01a0343d-ef01-7700-b32f-c32ee1fc21f9',
      result: 'The command output was:\n\n`hello-from-subagent`'
    })
  })

  // After an async spawn the parent's turn can end while the child still runs; a child Bash
  // event mapping to 'working' would flip the finished parent back to RUNNING with nothing to
  // clear it. Child activity reaches the card via the rollout tail, not the state machine.
  it("a child's own tool events (agent_id-tagged) do not drive the parent state", () => {
    for (const ev of ['PreToolUse', 'PostToolUse']) {
      const e = normalizeCodex(
        cenv({
          hook_event_name: ev,
          session_id: '01a0343d-d249-73e2-a462-e824df60d95c',
          agent_id: '01a0343d-ef01-7700-b32f-c32ee1fc21f9',
          agent_type: 'default',
          tool_name: 'Bash',
          tool_input: { command: 'echo hello-from-subagent' }
        })
      )
      expect(e).toBeNull()
    }
  })

  // The PARENT's spawn/wait tool calls carry no agent_id and stay ordinary working events —
  // the card is keyed off SubagentStart, never off the spawn tool call.
  it('the parent spawn_agent tool call remains a plain working event', () => {
    const e = normalizeCodex(
      cenv({
        hook_event_name: 'PreToolUse',
        session_id: 's1',
        tool_name: 'collaborationspawn_agent',
        tool_input: { task_name: 'echo_check', fork_turns: 'all', message: 'gAAAA…' }
      })
    )
    expect(e).toMatchObject({ kind: 'state', state: 'working' })
  })
})

describe('normalizeDevin', () => {
  function denv(payload: Record<string, unknown>): RawHookEnvelope {
    return { nodeId: 'n1', agentId: 'devin', payload }
  }

  it('maps session boundaries and captures the provider session id', () => {
    expect(
      normalizeDevin(denv({ hook_event_name: 'SessionStart', session_id: 'almondine-loganberry', source: 'startup' }))
    ).toEqual({
      nodeId: 'n1',
      agentId: 'devin',
      sessionId: 'almondine-loganberry',
      kind: 'session',
      sessionPhase: 'start'
    })
    expect(
      normalizeDevin(denv({ hook_event_name: 'SessionEnd', session_id: 'almondine-loganberry' }))
    ).toMatchObject({ kind: 'session', sessionPhase: 'end' })
  })

  it('maps user prompt to working with a new turn, and tool lifecycle to working', () => {
    expect(
      normalizeDevin(denv({ hook_event_name: 'UserPromptSubmit', session_id: 's1', prompt_id: 'p1', prompt: 'do it' }))
    ).toMatchObject({ kind: 'state', state: 'working', task: 'do it', newTurn: true })
    for (const hook_event_name of ['PreToolUse', 'PostToolUse']) {
      expect(
        normalizeDevin(
          denv({ hook_event_name, session_id: 's1', prompt_id: 'p1', tool_name: 'write', tool_use_id: 't1' })
        ),
        hook_event_name
      ).toMatchObject({ kind: 'state', state: 'working' })
    }
  })

  it('maps PermissionRequest to blocked and Stop to done', () => {
    const blocked = normalizeDevin(
      denv({
        hook_event_name: 'PermissionRequest',
        session_id: 's1',
        prompt_id: 'p1',
        tool_name: 'write',
        nodeterm_pending_id: 'n1-1234'
      })
    )
    expect(blocked).toMatchObject({ kind: 'state', state: 'blocked', pendingId: 'n1-1234', lastMessage: 'write' })

    const done = normalizeDevin(denv({ hook_event_name: 'Stop', session_id: 's1', prompt_id: 'p1' }))
    expect(done).toMatchObject({ kind: 'state', state: 'done' })
    expect(done?.interrupted).toBeFalsy()
  })

  it('routes through the shared dispatcher', () => {
    expect(
      normalizeFor('devin', denv({ hook_event_name: 'UserPromptSubmit', session_id: 's1', prompt: 'hi' }))
    ).toMatchObject({ agentId: 'devin', state: 'working' })
  })
})
