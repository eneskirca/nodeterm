import type { AgentId } from './config'

export type AgentState = 'working' | 'waiting' | 'blocked' | 'done'

// The universal event shape every agent normalizer produces. Agent-specific
// field names live only inside the per-agent normalizers below.
export interface NormalizedAgentEvent {
  nodeId: string
  agentId: AgentId
  kind: 'state' | 'subagent-start' | 'subagent-end' | 'recurring' | 'session'
  state?: AgentState
  // done only: the turn ended because the user interrupted (Esc/Ctrl-C) — the renderer
  // skips the completion alert/unread for these (the user was right there).
  interrupted?: boolean
  // done only: this `done` was inferred from the CLI going IDLE at its prompt (Claude's
  // `idle_prompt` notification), not from a turn-end hook. It is a RESCUE signal: it may only
  // move a node that is still `working` (see reduceEntry / the Canvas listener), because a
  // pending approval/question is also "idle at the prompt" and must not be cleared by it.
  idle?: boolean
  // waiting only (Codex `request_user_input`): the turn ENDS (Stop fires) with this question
  // still unanswered — the answer arrives as a fresh UserPromptSubmit, not a tool result — so
  // reduceEntry must hold `waiting` through that turn-end `done` instead of letting it flip
  // the node to a green "done" over a blocked session. Cleared by the next genuine turn, any
  // other tool activity, an interrupt, or a session boundary (see reduceEntry).
  awaitingInput?: boolean
  // true only for a genuine new turn (Claude UserPromptSubmit), so the renderer can
  // clear per-turn fan-out without clearing on every mid-turn tool event.
  newTurn?: boolean
  sessionId?: string
  lastMessage?: string
  // blocked (Claude PermissionRequest) only: the deterministic-approval ticket the managed hook
  // generated and is polling for an answer file. Rides from the raw POST body's
  // `nodeterm_pending_id` (merged into the payload by the hook server) so the phone/canvas can
  // answer the held hook. Absent = no held hook (legacy prompt path). See docs/hook-reply-approvals.md.
  pendingId?: string
  // needs-you (blocked/waiting) only: how the shell classified this ask AFTER the mirror's
  // stash-priority reclassification (see agent-status-mirror.recordAgentEvent). 'question' = an
  // AskUserQuestion picker (its `pendingId` is stripped — approve/deny on a question is wrong UX);
  // 'approval' = a genuine permission request (its `pendingId`, if any, is kept). Absent on every
  // non-needs-you event. This is the ENRICHED field the shells broadcast — it is not produced by
  // the normalizers themselves. Present for future UI; the canvas already keys the approve/deny
  // buttons off `pendingId`, which is now absent on a question. */
  askKind?: 'question' | 'approval'
  // session
  sessionTitle?: string
  // session lifecycle phase: 'start' resets to idle, 'end' resets + clears loop/fan-out
  sessionPhase?: 'start' | 'end'
  // subagent
  toolUseId?: string
  subagentType?: string
  taskLabel?: string
  durationMs?: number
  tokens?: number
  toolUses?: number
  result?: string
  // recurring
  recurringKind?: 'loop' | 'schedule' | 'cron'
  /** The recurring job was REMOVED (e.g. CronDelete) — take the card down. */
  recurringEnd?: boolean
  task?: string
  schedule?: string
}

// What the hook server hands a normalizer: the node id, the agent id, and the
// agent's raw hook JSON (parsed) plus the prompt text when present.
export interface RawHookEnvelope {
  nodeId: string
  agentId: AgentId
  payload: Record<string, unknown>
}

const SUBAGENT_TOOLS = new Set(['Agent', 'Task'])
const RECURRING_TOOLS = new Set(['Skill', 'CronCreate', 'ScheduleWakeup'])

interface ClaudePayload {
  hook_event_name?: string
  session_id?: string
  /** Deterministic-approval ticket the managed hook script added to its POST body and the hook
   *  server merged into this payload (PermissionRequest only). */
  nodeterm_pending_id?: string
  /** Deterministic-approval "answered" signal: the managed hook fired a second POST the instant it
   *  read a valid allow/deny answer file, tagged nodeterm_answered=<decision>, merged into this
   *  payload by the hook server. It rides alongside the original PermissionRequest payload, so it is
   *  matched BEFORE hook_event_name and maps to a synthetic working transition (not a new ask). */
  nodeterm_answered?: string
  notification_type?: string
  is_interrupt?: boolean
  last_assistant_message?: string
  prompt?: string
  tool_name?: string
  tool_use_id?: string
  tool_input?: {
    subagent_type?: string
    description?: string
    prompt?: string
    skill?: string
    cron?: string
  }
  tool_response?: {
    status?: string
    isAsync?: boolean
    content?: { type?: string; text?: string }[]
    totalDurationMs?: number
    totalTokens?: number
    totalToolUseCount?: number
  }
}

/**
 * Claude Code launches subagents async by default: the Task/Agent PostToolUse fires
 * ~immediately with a launch acknowledgment, not the finished result. Treating that as the
 * subagent's end flips the card to done seconds after it starts, with no output. The real
 * end arrives later as a <task-notification> in the parent transcript.
 */
export function isAsyncSubagentLaunch(r: { status?: string; isAsync?: boolean } | undefined): boolean {
  return r?.status === 'async_launched' || r?.isAsync === true
}

export function normalizeClaude(env: RawHookEnvelope): NormalizedAgentEvent | null {
  const p = env.payload as ClaudePayload
  const base = { nodeId: env.nodeId, agentId: env.agentId, sessionId: p.session_id }
  // Deterministic hook-reply "answered" signal (docs/hook-reply-approvals.md): the managed hook
  // fires this the instant it reads a valid allow/deny answer file — the agent is about to proceed
  // (on 'deny' it typically continues the turn too), so map both to a synthetic 'working' transition
  // that clears the NEEDS YOU badge without waiting for the agent's next real hook. Threads the
  // pendingId so the mirror's state-leave resolves the open approval. It is NOT a new ask — a
  // 'working' state never produces an inbox approval/question. Matched BEFORE hook_event_name because
  // it rides alongside the original PermissionRequest payload.
  if (p.nodeterm_answered === 'allow' || p.nodeterm_answered === 'deny') {
    return {
      ...base,
      kind: 'state',
      state: 'working',
      ...(p.nodeterm_pending_id ? { pendingId: p.nodeterm_pending_id } : {})
    }
  }
  const ev = p.hook_event_name
  const tool = p.tool_name ?? ''

  if (ev === 'PreToolUse' || ev === 'PostToolUse') {
    if (SUBAGENT_TOOLS.has(tool)) {
      if (ev === 'PreToolUse') {
        return {
          ...base,
          kind: 'subagent-start',
          toolUseId: p.tool_use_id,
          subagentType: p.tool_input?.subagent_type,
          taskLabel: p.tool_input?.description ?? p.tool_input?.prompt
        }
      }
      // Async launch acknowledgment — the subagent just started, it didn't finish.
      if (isAsyncSubagentLaunch(p.tool_response)) return { ...base, kind: 'state', state: 'working' }
      return {
        ...base,
        kind: 'subagent-end',
        toolUseId: p.tool_use_id,
        durationMs: p.tool_response?.totalDurationMs,
        tokens: p.tool_response?.totalTokens,
        toolUses: p.tool_response?.totalToolUseCount,
        result: p.tool_response?.content
          ?.filter((c) => c.type === 'text' && c.text)
          .map((c) => c.text)
          .join('\n')
      }
    }
    // A cron outlives turns and sessions — its card leaves the canvas only when the cron
    // itself is removed.
    if (ev === 'PreToolUse' && tool === 'CronDelete') {
      return { ...base, kind: 'recurring', recurringKind: 'cron', recurringEnd: true }
    }
    if (ev === 'PreToolUse' && RECURRING_TOOLS.has(tool)) {
      let recurringKind: NormalizedAgentEvent['recurringKind']
      if (tool === 'Skill') {
        const sk = (p.tool_input?.skill ?? '').split(':').pop()
        if (sk === 'loop' || sk === 'schedule' || sk === 'cron') recurringKind = sk
      } else if (tool === 'CronCreate') recurringKind = 'cron'
      else if (tool === 'ScheduleWakeup') recurringKind = 'loop'
      if (recurringKind) {
        return {
          ...base,
          kind: 'recurring',
          recurringKind,
          schedule: p.tool_input?.cron,
          task: p.tool_input?.prompt
        }
      }
    }
    // Any other tool use is just "working".
    return { ...base, kind: 'state', state: 'working' }
  }

  if (ev === 'UserPromptSubmit') {
    // A completed async subagent is delivered back as a queued <task-notification> prompt.
    // That's not a genuine user turn — flagging it newTurn would clear the subagent fan-out
    // at the exact moment one of the cards completes.
    if ((p.prompt ?? '').trimStart().startsWith('<task-notification>')) {
      return { ...base, kind: 'state', state: 'working' }
    }
    return { ...base, kind: 'state', state: 'working', task: p.prompt, newTurn: true }
  }
  if (ev === 'Stop') {
    return {
      ...base,
      kind: 'state',
      state: 'done',
      interrupted: p.is_interrupt === true,
      lastMessage: p.last_assistant_message
    }
  }
  // The turn died on an API/model error — Claude Code skips the normal Stop hook here,
  // so without this the node would sit on "working" forever.
  if (ev === 'StopFailure') {
    return { ...base, kind: 'state', state: 'done', lastMessage: p.last_assistant_message }
  }
  // The dedicated permission hook (more direct than Notification's permission_prompt).
  if (ev === 'PermissionRequest') {
    return {
      ...base,
      kind: 'state',
      state: 'blocked',
      lastMessage: p.last_assistant_message,
      // Deterministic-approval ticket (present only when the wait-branch of the managed hook ran).
      ...(p.nodeterm_pending_id ? { pendingId: p.nodeterm_pending_id } : {})
    }
  }
  if (ev === 'Notification') {
    // Only the types that genuinely need the user flip the state. Everything else —
    // idle_prompt fires AFTER Stop on a normally-finished turn (mapping it to waiting
    // stuck NEEDS YOU on done nodes), and auth_success / elicitation_complete /
    // elicitation_response / agent_completed are informational — must not touch state,
    // so unknown future types default to no-op rather than a sticky badge.
    if (p.notification_type === 'permission_prompt') {
      return { ...base, kind: 'state', state: 'blocked', lastMessage: p.last_assistant_message }
    }
    if (p.notification_type === 'elicitation_dialog' || p.notification_type === 'agent_needs_input') {
      return { ...base, kind: 'state', state: 'waiting', lastMessage: p.last_assistant_message }
    }
    // `idle_prompt` = the CLI is sitting at its prompt waiting for you to type. It cannot be true
    // while a turn runs, which makes it the ONE signal that rescues a node stuck on `working` when
    // no turn-end hook ever fired — the Esc-during-a-tool-call case, where Claude aborts the tool
    // and returns to "Interrupted · What should Claude do instead?" without running Stop.
    //
    // Marked `idle` (and `interrupted`, since nothing was accomplished) so consumers can apply the
    // narrow rule this needs: it may only move a node that is still WORKING. It also fires after a
    // normally-finished turn (already `done` → no-op) and can fire while an approval prompt is up
    // (`blocked`/`waiting` → must NOT be cleared). Mapping it to `waiting` — the obvious reading —
    // is what stuck NEEDS YOU on finished nodes before, hence the deliberate no-op default below.
    if (p.notification_type === 'idle_prompt') {
      return { ...base, kind: 'state', state: 'done', interrupted: true, idle: true }
    }
    return null
  }
  if (ev === 'SessionStart') return { ...base, kind: 'session', sessionPhase: 'start' }
  if (ev === 'SessionEnd') return { ...base, kind: 'session', sessionPhase: 'end' }
  return null
}

// Codex hook payload. Event name is read defensively; codex emits a session id under
// `session_id`. Tool events carry `tool_name`/`tool_input` (same shape as Claude's —
// codex-rs/hooks serializes them on pre_tool_use/post_tool_use).
interface CodexPayload {
  hook_event_name?: string
  hookEventName?: string
  session_id?: string
  prompt?: string
  tool_name?: string
  tool_input?: { prompt?: string; question?: string; questions?: { question?: string }[] }
}

export function normalizeCodex(env: RawHookEnvelope): NormalizedAgentEvent | null {
  const p = env.payload as CodexPayload
  const ev = p.hook_event_name ?? p.hookEventName
  const base = { nodeId: env.nodeId, agentId: env.agentId, sessionId: p.session_id }

  // UserPromptSubmit is codex's turn start — flag newTurn so the renderer clears
  // per-turn fan-out once per turn, not on every tool event.
  if (ev === 'UserPromptSubmit') {
    return { ...base, kind: 'state', state: 'working', newTurn: true }
  }
  // `request_user_input` is Codex's ask-the-user tool, and it is NOT a blocking tool: the
  // turn ENDS (Stop fires) with the question still unanswered, and the answer arrives as a
  // fresh UserPromptSubmit. Mapping its tool-start to `working` left the node lit green as
  // "done" while the agent sat on a question (observed live, codex-cli 0.145.0). Emit
  // `waiting` + `awaitingInput` so reduceEntry can hold the ask through the turn-end Stop.
  if (p.tool_name === 'request_user_input' && (ev === 'PreToolUse' || ev === 'PostToolUse')) {
    // A PostToolUse for the ask itself (an immediate ack) must not clear the ask.
    if (ev === 'PostToolUse') return null
    const q = p.tool_input
    const question = q?.questions?.[0]?.question ?? q?.question ?? q?.prompt
    return {
      ...base,
      kind: 'state',
      state: 'waiting',
      awaitingInput: true,
      ...(question ? { lastMessage: question } : {})
    }
  }
  // SessionStart + tool events keep the node "working".
  if (ev === 'SessionStart' || ev === 'PreToolUse' || ev === 'PostToolUse') {
    return { ...base, kind: 'state', state: 'working' }
  }
  if (ev === 'PermissionRequest') return { ...base, kind: 'state', state: 'waiting' }
  if (ev === 'Stop') return { ...base, kind: 'state', state: 'done' }
  return null
}

// Gemini hook payload. Event name is read defensively (some builds use
// `hook_event_name`/`hookEventName`); a session id may be present under `session_id`.
interface GeminiPayload {
  hook_event_name?: string
  hookEventName?: string
  event?: string
  session_id?: string
}

export function normalizeGemini(env: RawHookEnvelope): NormalizedAgentEvent | null {
  const p = env.payload as GeminiPayload
  const ev = p.hook_event_name ?? p.hookEventName ?? p.event
  const base = { nodeId: env.nodeId, agentId: env.agentId, sessionId: p.session_id }

  // BeforeAgent is gemini's turn start — flag newTurn (mirrors Claude's UserPromptSubmit)
  // so per-turn fan-out clears once per turn rather than on every tool event.
  if (ev === 'BeforeAgent') {
    return { ...base, kind: 'state', state: 'working', newTurn: true }
  }
  if (ev === 'BeforeTool' || ev === 'AfterTool') {
    return { ...base, kind: 'state', state: 'working' }
  }
  if (ev === 'AfterAgent') return { ...base, kind: 'state', state: 'done' }
  // Gemini has no waiting/blocked states.
  return null
}

// opencode plugin payload (see core/agents/hooks/opencode.ts). The managed plugin forwards
// { event, sessionID?, role? } per hook; field names beyond `event` are read defensively —
// opencode's event payload shapes are not a contract, so the event NAME carries the mapping.
interface OpencodePayload {
  event?: string
  sessionID?: string
  session_id?: string
  role?: string
}

export function normalizeOpencode(env: RawHookEnvelope): NormalizedAgentEvent | null {
  const p = env.payload as OpencodePayload
  const base = { nodeId: env.nodeId, agentId: env.agentId, sessionId: p.sessionID ?? p.session_id }

  if (p.event === 'session.created') return { ...base, kind: 'session', sessionPhase: 'start' }
  // The plugin forwards message.updated only for user messages — opencode's turn start
  // (mirrors Claude's UserPromptSubmit), so per-turn fan-out clears once per turn.
  if (p.event === 'message.updated' && p.role === 'user') {
    return { ...base, kind: 'state', state: 'working', newTurn: true }
  }
  if (p.event === 'tool.execute.before') return { ...base, kind: 'state', state: 'working' }
  if (p.event === 'permission.asked') return { ...base, kind: 'state', state: 'blocked' }
  if (p.event === 'permission.replied') return { ...base, kind: 'state', state: 'working' }
  // Question (elicitation) dialog: blocks the turn but the session never idles.
  if (p.event === 'question.asked') return { ...base, kind: 'state', state: 'blocked' }
  if (p.event === 'question.replied' || p.event === 'question.rejected') {
    return { ...base, kind: 'state', state: 'working' }
  }
  if (p.event === 'session.idle' || p.event === 'session.error') {
    return { ...base, kind: 'state', state: 'done' }
  }
  return null
}

export function normalizeFor(agentId: AgentId, env: RawHookEnvelope): NormalizedAgentEvent | null {
  if (agentId === 'claude') return normalizeClaude(env)
  if (agentId === 'codex') return normalizeCodex(env)
  if (agentId === 'gemini') return normalizeGemini(env)
  if (agentId === 'opencode') return normalizeOpencode(env)
  return null
}
