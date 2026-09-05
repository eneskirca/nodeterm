import type { AgentId } from './config'
import type { ObservedClaudeAccount } from '../types'

export type AgentState = 'working' | 'waiting' | 'blocked' | 'done'

// The universal event shape every agent normalizer produces. Agent-specific
// field names live only inside the per-agent normalizers below.
export interface NormalizedAgentEvent {
  nodeId: string
  agentId: AgentId
  kind: 'state' | 'subagent-start' | 'subagent-end' | 'recurring' | 'session' | 'background-task'
  state?: AgentState
  // done only: the turn ended because the user interrupted (Esc/Ctrl-C) — the renderer
  // skips the completion alert/unread for these (the user was right there).
  interrupted?: boolean
  /**
   * done only: this turn ended on an API/model ERROR rather than by finishing (issue #521).
   *
   * An annotation, not a fifth `AgentState`, and the reason is not only that a new state would
   * ripple through both raw listeners and the mobile mirror: **errored is a fact about the last
   * turn, not a mutually exclusive live state.** A station whose turn 1 errored IS idle — the two
   * facts coexist, and only one of them is the station's state.
   *
   * It is set from the agent's own `StopFailure` hook, which claude and grok both fire INSTEAD of
   * `Stop` when the turn dies (`CLAUDE_HOOK_EVENTS`/`GROK_HOOK_EVENTS` already subscribe to it —
   * without the subscription the badge would stick on RUNNING). So the source is a real hook, not
   * a heuristic: a `Stop` whose turn produced no assistant message was considered and refused on
   * the closed-set rule — interrupted and tool-only turns look identical to it, and a false
   * attention signal has no later hook to clear it.
   *
   * Carried on the event so both shells change together by construction: `normalizeClaude` /
   * `normalizeGrok` live in `src/shared` and both raw listeners forward what they return.
   *
   * NO ERROR TEXT accompanies it. Whether claude's `StopFailure` payload carries the failure
   * message has not been measured, and `last_assistant_message` is the previous assistant turn
   * rather than the error — reporting that as "the error" would be a wrong fact stated
   * confidently. The flag says only what the hook said.
   */
  errored?: boolean
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
  /** Original start time when recovering an in-flight fan-out after renderer reload. */
  subagentStartedAt?: number
  // grok StopCancelled only: normalized state-less so the mirror can make the session-aware badge
  // decision (a subagent cancellation must not end its parent session).
  cancelReason?:
    | 'user_interrupt'
    | 'permission_rejected'
    | 'permission_cancelled'
    | 'max_turns'
    | 'no_progress'
    | 'unknown'
  // grok compaction lifecycle. These events carry the old/new session ids but do not themselves
  // prove the agent is working or idle, so consumers may update identity without moving state.
  compactionPhase?: 'pre' | 'post'
  taskLabel?: string
  durationMs?: number
  tokens?: number
  toolUses?: number
  result?: string
  /**
   * The POST that produced this event presented a per-node token the running instance had minted
   * for THIS node id. Set by the hook server, never by a normalizer.
   *
   * It is a LABEL, not a permission: `false` covers every client that predates the token, the
   * phone, and the documented cross-instance failover, so no consumer may treat it as "reject".
   */
  verified?: boolean
  /**
   * The revision of the managed hook script that posted this event (`MANAGED_SCRIPT_REVISION`,
   * sent as `X-Nodeterm-Hook-Client`). Set by the hook server, never by a normalizer.
   *
   * `undefined` means the client sent no stamp — a script that predates the header, i.e. one that
   * also predates per-node identity. That is a DISTINCT state from `verified: false`, and telling
   * them apart is the entire point: a session with no token file needs "retry after its next turn",
   * a session running an old script needs "reconnect the project / restart the app", and before
   * this field the two were indistinguishable on the wire.
   *
   * Like `verified` it is a LABEL: nothing may refuse a POST because of it.
   */
  clientRevision?: number
  /**
   * Which Claude account the posting session was OBSERVED to run under, derived by the hook server
   * from the payload's `transcript_path` (claude events only). Set by the hook server, never by a
   * normalizer. A LABEL like `verified`: it drives the per-node account chip and the account-scoped
   * transcript readers for nodes that carry no `data.accountId`; nothing may refuse or grant on it.
   */
  account?: ObservedClaudeAccount
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
    /** Bash only: the task was launched as a background shell (`run_in_background: true`). */
    run_in_background?: boolean
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
    // A background shell task lives INSIDE the CLI process: /exit kills it silently. This event
    // is the stamp Eco hibernation and the bulk restart exclude on (see hibernation-policy /
    // planBulkRestart). PreToolUse only, and `=== true` — an absent or false flag is a foreground
    // command, which the generic "working" below already covers. Claude-only: no other dialect
    // carries the field (closed set, CLAUDE.md agent rule 7).
    if (ev === 'PreToolUse' && tool === 'Bash' && p.tool_input?.run_in_background === true) {
      return { ...base, kind: 'background-task' }
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
  // so without this the node would sit on "working" forever. `errored` is what keeps this
  // distinguishable from an ordinary finish afterwards (issue #521): the station is idle either
  // way, and before the flag existed a `--after` dependent fired on a station that produced
  // nothing.
  if (ev === 'StopFailure') {
    return {
      ...base,
      kind: 'state',
      state: 'done',
      errored: true,
      lastMessage: p.last_assistant_message
    }
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
  // Subagent (spawn_agent collaboration) fields, measured on codex-cli 0.146.0:
  // SubagentStart/SubagentStop carry agent_id + agent_type, and a CHILD's own tool events carry
  // agent_id/agent_type too (the child runs inside the same codex process, so its hooks fire
  // through the parent's subscription). SubagentStop adds last_assistant_message.
  agent_id?: string
  agent_type?: string
  last_assistant_message?: string
}

export function normalizeCodex(env: RawHookEnvelope): NormalizedAgentEvent | null {
  const p = env.payload as CodexPayload
  const ev = p.hook_event_name ?? p.hookEventName
  const base = { nodeId: env.nodeId, agentId: env.agentId, sessionId: p.session_id }

  // Subagent fan-out (spawn_agent). Keyed by agent_id — the child's rollout/session uuid —
  // NOT tool_use_id: the spawn tool's Pre/PostToolUse and the SubagentStart it launches carry
  // different turn ids and nothing correlates them, while agent_id is stable across the child's
  // whole life (measured: parallel + nested spawns each get a distinct agent_id, and a nested
  // child's Start/Stop fire through the same subscription). No taskLabel: the spawn message is
  // encrypted end-to-end (tool_input.message AND the NEW_TASK payload in the child rollout are
  // Fernet blobs), so there is no task text to show — the live transcript tail carries the
  // readable "Task name:" header instead.
  if (ev === 'SubagentStart' && p.agent_id) {
    return { ...base, kind: 'subagent-start', toolUseId: p.agent_id, subagentType: p.agent_type }
  }
  // The real end signal — codex fires SubagentStop when the child's turn completes, so unlike
  // claude there is no async-launch-ack trap to dodge here. Duration/token counts are not in the
  // payload; the card keeps its live-timer elapsed and the result text.
  if (ev === 'SubagentStop' && p.agent_id) {
    return { ...base, kind: 'subagent-end', toolUseId: p.agent_id, result: p.last_assistant_message }
  }
  // A CHILD's own tool events (tagged agent_id) must not drive the PARENT node's state: after an
  // async spawn the parent's turn can end (Stop → done) while the child still runs, and a child
  // Bash event mapping to 'working' would flip a finished node back to RUNNING with no later
  // parent event to clear it. Child activity reaches the card via the rollout tail instead.
  if (p.agent_id) return null

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

// Gemini hook payload. Its envelope is snake_case and claude-shaped — every event carries
// `session_id`, `transcript_path`, `cwd`, `hook_event_name` and `timestamp` (gemini 0.54.4's own
// `docs/hooks/reference.md:48-58`). The event name is still read defensively (`hookEventName` /
// `event`) because older builds spelled it differently and those payloads cost nothing to accept.
interface GeminiPayload {
  hook_event_name?: string
  hookEventName?: string
  event?: string
  session_id?: string
  /** Notification only (reference.md:272-285). The documented type is `"ToolPermission"`. */
  notification_type?: string
  /** Notification only: the alert's summary — shown on the needs-you badge (reference.md:279). */
  message?: string
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
  // `source` is startup|resume|clear and `reason` is exit|clear|logout|prompt_input_exit|other
  // (reference.md:250-251, 265-266). Neither changes what a session boundary MEANS to us, so both
  // phases map unconditionally — a `/clear` really is one session ending and another beginning.
  if (ev === 'SessionStart') return { ...base, kind: 'session', sessionPhase: 'start' }
  if (ev === 'SessionEnd') return { ...base, kind: 'session', sessionPhase: 'end' }
  if (ev === 'Notification') {
    // Gemini's ONE ask-the-user signal (reference.md:272-285, "for example, Tool Permissions"), and
    // the reason this event was worth subscribing to: without it a node waiting on a permission
    // answer sat on RUNNING, because the last hook we heard was `BeforeTool`.
    //
    // `blocked` rather than `waiting` for two reasons: normalizeClaude already uses it for a
    // permission ask (every consumer treats the two alike), and BUSY_STATES then refuses an
    // in-place restart on this node — correct, since `/quit` typed into a permission prompt would
    // ANSWER the prompt instead of quitting. That refusal only became REACHABLE for gemini once
    // gemini joined `EXIT_SEQUENCES` (agent-restart.ts): `restartEligibility` returns
    // `not-resumable` before it ever consults BUSY_STATES, so until then no gemini node could be
    // restarted at all, blocked or otherwise.
    //
    // A CLOSED match, not a substring: the docs name exactly ONE type (reference.md:278), and an
    // unknown future one must stay a no-op — a badge that sticks on a finished node is a failure
    // this codebase has shipped before. Grok is the cautionary tale: there, a substring match on
    // "permission" turned a notification that fires before every tool call into a strobing NEEDS
    // YOU. Widening this "to be safe" is the unsafe direction.
    //
    // Nothing here can be answered from our side: the hook is observability only and its
    // flow-control fields are ignored (reference.md:284-285), so this reports state and no more —
    // no `pendingId`, unlike claude's deterministic-approval path.
    if (p.notification_type === 'ToolPermission') {
      return { ...base, kind: 'state', state: 'blocked', lastMessage: p.message }
    }
    return null
  }
  return null
}

// GitHub Copilot CLI hook payload. Its event names and snake_case envelope intentionally resemble
// Claude's, but its event set and notification vocabulary are a separate protocol contract. Keep a
// dedicated normalizer so a future change in one harness cannot silently change the other's state.
interface CopilotPayload {
  hook_event_name?: string
  session_id?: string
  prompt?: string
  notification_type?: string
  message?: string
  last_assistant_message?: string
}

export function normalizeCopilot(env: RawHookEnvelope): NormalizedAgentEvent | null {
  const p = env.payload as CopilotPayload
  const base = { nodeId: env.nodeId, agentId: env.agentId, sessionId: p.session_id }

  if (p.hook_event_name === 'SessionStart') {
    return { ...base, kind: 'session', sessionPhase: 'start' }
  }
  if (p.hook_event_name === 'SessionEnd') {
    return { ...base, kind: 'session', sessionPhase: 'end' }
  }
  if (p.hook_event_name === 'UserPromptSubmit') {
    return { ...base, kind: 'state', state: 'working', task: p.prompt, newTurn: true }
  }
  if (
    p.hook_event_name === 'PreToolUse' ||
    p.hook_event_name === 'PostToolUse' ||
    p.hook_event_name === 'PostToolUseFailure'
  ) {
    return { ...base, kind: 'state', state: 'working' }
  }
  if (p.hook_event_name === 'Stop') {
    return {
      ...base,
      kind: 'state',
      state: 'done',
      lastMessage: p.last_assistant_message
    }
  }
  if (p.hook_event_name === 'Notification') {
    // Closed matches only. Informational/background notification types must never create a sticky
    // NEEDS YOU badge on a finished parent session.
    if (p.notification_type === 'permission_prompt') {
      return { ...base, kind: 'state', state: 'blocked', lastMessage: p.message }
    }
    if (p.notification_type === 'elicitation_dialog') {
      return { ...base, kind: 'state', state: 'waiting', lastMessage: p.message }
    }
  }
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

// grok hook payload. Its dialect differs from every other agent here in two ways, both taken from
// the shipped 1.0.0 DOCS: the keys are camelCase, and `hookEventName`'s VALUE is snake_case
// ("pre_tool_use"). NO payload here was ever captured — a hook only fires inside a logged-in grok
// session, and the branch never had one. Hooks registered through the grok SDK convert the top-level keys to
// snake_case instead, so both spellings occur in the wild — hence every field is read twice and
// the event name is CANONICALIZED (lowercased, letters only) rather than compared literally.
// `transcript_path` is deliberately absent from THIS envelope -- but not from the wire. Grok does
// send `transcriptPath` (MEASURED on 1.0.13, 14 of 15 payloads) and it names `updates.jsonl`, the
// file that holds no readable conversation. The transcript is DERIVED from (cwd, sessionId)
// instead, which is why the shells' raw listeners need `grokRawFields` below.
interface GrokPayload {
  hookEventName?: string
  hook_event_name?: string
  sessionId?: string
  session_id?: string
  cwd?: string
  toolName?: string
  tool_name?: string
  toolUseId?: string
  tool_use_id?: string
  toolInput?: Record<string, unknown>
  tool_input?: Record<string, unknown>
  lastAssistantMessage?: string
  last_assistant_message?: string
  notificationType?: string
  notification_type?: string
  /** Notification only, THIRD spelling of the kind. Not from grok's docs — from orca
   *  (`/root/orca-main`, MIT), a shipping grok integration whose reader is
   *  `notificationType ?? notification_type ?? type` (`src/shared/agent-hook-listener.ts:2370-2376`).
   *  Reading a key a shipped integration reads costs nothing and closes a whole dialect. */
  type?: string
  /** Stop only: 'end_turn' for a genuine turn end; 'channel_closed'/'shutdown' at session close. */
  reason?: string
  /** StopFailure only: the closed error class tested by its matcher. */
  error?: string
  /** PreCompact/PostCompact only: `manual` or `auto`. MEASURED on grok 1.0.13 (2026-09-01): the
   *  wire spells this `source`; `trigger` is Claude's spelling and never appears in a grok payload.
   *  Both are read because the SDK path may still present the Claude-shaped key, and reading a key
   *  that never arrives costs nothing — while reading only `trigger` cost us every compaction
   *  event: the guard below rejected 100% of real ones while the docs-derived test payloads,
   *  which carried `trigger`, kept it green. */
  source?: string
  trigger?: string
  /** Events fired inside a subagent use its type as identity; there is no measured instance id. */
  subagentType?: string
  subagent_type?: string
  prompt?: string
}

/**
 * ONE canonicalization for every grok VALUE we compare — lowercase, letters only, so all of
 * 'pre_tool_use', 'PreToolUse', 'preToolUse' and 'Pre-Tool-Use' land on 'pretooluse'. grok's envelope
 * is documented camelCase while its event values are snake_case, and the SDK path flips the keys, so
 * one dialect rule shared by every comparison in this file is the point: a second spelling rule is
 * how a value gets normalized in one branch and matched raw in another.
 */
const grokCanonical = (v: string | undefined): string => (v ?? '').toLowerCase().replace(/[^a-z]/g, '')

const GROK_CANCEL_REASONS: Record<string, NonNullable<NormalizedAgentEvent['cancelReason']>> = {
  userinterrupt: 'user_interrupt',
  permissionrejected: 'permission_rejected',
  permissioncancelled: 'permission_cancelled',
  maxturns: 'max_turns',
  noprogress: 'no_progress',
  unknown: 'unknown'
}

/** Canonical form of a grok event name: 'pre_tool_use', 'PreToolUse' and 'preToolUse' all → 'pretooluse'. */
const grokEventName = (p: GrokPayload): string =>
  grokCanonical(p.hookEventName ?? p.hook_event_name)

/**
 * The fields the SHELLS need from a raw grok payload, in nodeterm's own names — one definition
 * shared by `src/main` and `src/server` so their raw listeners can never drift. Exported (and
 * unit-tested) rather than re-read at each call site, because the two-dialect reading is exactly
 * the kind of detail that gets half-copied.
 */
export function grokRawFields(payload: Record<string, unknown>): {
  event: string
  sessionId?: string
  cwd?: string
  toolName?: string
  toolUseId?: string
  toolInput?: Record<string, unknown>
} {
  const p = payload as GrokPayload
  return {
    event: grokEventName(p),
    sessionId: p.sessionId ?? p.session_id,
    cwd: p.cwd,
    toolName: p.toolName ?? p.tool_name,
    toolUseId: p.toolUseId ?? p.tool_use_id,
    toolInput: p.toolInput ?? p.tool_input
  }
}

export function normalizeGrok(env: RawHookEnvelope): NormalizedAgentEvent | null {
  const p = env.payload as GrokPayload
  const base = { nodeId: env.nodeId, agentId: env.agentId, sessionId: p.sessionId ?? p.session_id }
  const ev = grokEventName(p)
  const lastMessage = p.lastAssistantMessage ?? p.last_assistant_message

  if (ev === 'sessionstart') return { ...base, kind: 'session', sessionPhase: 'start' }
  if (ev === 'sessionend') return { ...base, kind: 'session', sessionPhase: 'end' }

  // grok's turn start. Flagged newTurn so per-turn fan-out clears once per turn, not per tool event.
  if (ev === 'userpromptsubmit') {
    return { ...base, kind: 'state', state: 'working', task: p.prompt, newTurn: true }
  }
  // A FAILED tool is still mid-turn: grok fires PostToolUseFailure and carries on, so mapping it
  // to anything but `working` would clear RUNNING while the agent is still going.
  if (ev === 'pretooluse' || ev === 'posttooluse' || ev === 'posttoolusefailure') {
    return { ...base, kind: 'state', state: 'working' }
  }
  if (ev === 'stop') {
    // grok fires a SECOND, observe-only Stop when the session itself closes — and ONLY those two
    // reasons, 'channel_closed' and 'shutdown', are that fire. Reporting them as a finished turn
    // would pop a "your agent is done" notification every time a session ends, so they are marked
    // `interrupted` — the flag the renderer already reads as "skip the completion alert and the
    // unread dot" — and their lastAssistantMessage (an earlier turn's text) is dropped.
    //
    // The test is a DENYLIST of those two, not an allowlist of 'end_turn', so everything else —
    // an absent reason, or a genuine turn end grok labels later ('max_tokens', 'refusal', …) —
    // reports normally. Stop is the one event the RUNNING badge depends on ending, so an unknown
    // dialect must fail towards reporting the badge-clearing event, never towards swallowing it.
    const sessionClose = p.reason === 'channel_closed' || p.reason === 'shutdown'
    return !sessionClose
      ? { ...base, kind: 'state', state: 'done', lastMessage }
      : { ...base, kind: 'state', state: 'done', interrupted: true }
  }
  // The turn died on an API error — grok skips Stop entirely here, exactly as Claude does.
  //
  // THE EVENT IS THE TURN END, whatever its error class. This used to return null for a class
  // outside the documented six, on the "closed vocabulary" reasoning applied everywhere else in this
  // file. That reasoning is right for a value that DECIDES something and wrong here, because the
  // class decides nothing: every branch of it ends the turn. Gating on it meant an absent or
  // future-dialect `error` left the node stuck on RUNNING until the idle_prompt backstop, or forever
  // if none came — the silent half of the failure, the one nobody reports because nothing looks
  // broken. Grok's own docs make `unknown` the catch-all, so a value outside the set can only be a
  // dialect we have not seen, and the turn has ended either way.
  //
  // The documented classes (1.0.13, `10-hooks.md:162`) are `rate_limit`, `authentication_failed`,
  // `invalid_request`, `server_error`, `max_output_tokens` and `unknown` — recorded here because
  // they are measured and worth keeping, and NOT kept as a Set, because nothing branches on them and
  // a set nothing reads is the same dead weight the PostCompact branch was. The day one of them
  // earns a distinct badge, that is where the set comes back — and it must still fall through to
  // `done`, never to null.
  // `errored: true` is NOT decoration: `erroredTurn.ts` is the one definition of "this turn died",
  // shared by every agent and by both shells, and dropping it here made grok the only agent whose
  // failed turn looked like a clean one. It went missing when this branch's version of the return
  // was taken over upstream's without diffing what upstream had — the same "believe the side you
  // are holding" that the rest of this comment is about.
  if (ev === 'stopfailure')
    return { ...base, kind: 'state', state: 'done', errored: true, lastMessage }
  if (ev === 'permissiondenied') return { ...base, kind: 'state', state: 'working' }
  if (ev === 'stopcancelled') {
    const cancelReason = GROK_CANCEL_REASONS[grokCanonical(p.reason)]
    if (!cancelReason) return null
    // Transport the classified reason state-less: the mirror owns the session-aware transition
    // and can ignore a subagent cancellation without losing session identity.
    return {
      ...base,
      kind: 'state',
      cancelReason,
      subagentType: p.subagentType ?? p.subagent_type,
      lastMessage
    }
  }
  if (ev === 'subagentstart' || ev === 'subagentstop') {
    return {
      ...base,
      kind: ev === 'subagentstart' ? 'subagent-start' : 'subagent-end',
      subagentType: p.subagentType ?? p.subagent_type
    }
  }
  if (ev === 'precompact' || ev === 'postcompact') {
    const trigger = grokCanonical(p.source ?? p.trigger)
    if (trigger !== 'manual' && trigger !== 'auto') return null
    return {
      ...base,
      kind: 'state',
      compactionPhase: ev === 'precompact' ? 'pre' : 'post'
    }
  }
  if (ev === 'notification') {
    // Grok 1.0.13 publishes this CLOSED vocabulary in
    // `~/.grok/docs/user-guide/10-hooks.md:99`: idle_prompt, permission_prompt, task_complete.
    // `:162` is the load-bearing correction to the old orca-derived branch: permission_prompt fires
    // ONLY while a permission UI is actually waiting, never routinely before every tool call.
    // Exact classification prevents a future permission-like name from sticking NEEDS YOU with no
    // later hook guaranteed to clear it.
    const type = p.notificationType ?? p.notification_type ?? p.type
    // NO ROUTINE-PROMPT SUPPRESSION HERE, and that is a measured decision rather than an omission.
    //
    // The old orca-derived branch dropped a `permission_prompt` whose message was exactly
    // "Tool permission requested" at level `info`, because orca reports grok emitting one before
    // EVERY tool call. Captured live on 1.0.13 (2026-09-01), the GENUINE prompt — fired with a real
    // permission dialog on screen — is byte-for-byte that same triple:
    //     notificationType 'permission_prompt' · message 'Tool permission requested' · level 'info'
    // and no routine per-tool-call notification was emitted at all. So that filter cannot separate
    // the routine case from a real ask on this version: it can only swallow the real one.
    //
    // Swallowing it is the worse of the two failures. A strobe is loud and obvious; a suppressed ask
    // leaves grok waiting for approval with the node showing nothing, and no later hook is
    // guaranteed to correct it. If a future grok does emit the routine prompt, it must be told apart
    // by something that actually differs — not by a message the real ask also carries.
    if (type === 'permission_prompt') {
      return { ...base, kind: 'state', state: 'blocked', lastMessage }
    }
    if (type === 'idle_prompt') {
      return { ...base, kind: 'state', state: 'done', interrupted: true, idle: true }
    }
    // The spec names task_complete as a user-attention notification, but never says it ends a turn.
    // Stop remains the documented turn-end signal, so task_complete and every future type are
    // informational no-ops rather than guessed badge transitions.
    return null
  }
  return null
}

export function normalizeFor(agentId: AgentId, env: RawHookEnvelope): NormalizedAgentEvent | null {
  if (agentId === 'claude') return normalizeClaude(env)
  if (agentId === 'codex') return normalizeCodex(env)
  if (agentId === 'gemini') return normalizeGemini(env)
  if (agentId === 'opencode') return normalizeOpencode(env)
  if (agentId === 'grok') return normalizeGrok(env)
  if (agentId === 'copilot') return normalizeCopilot(env)
  return null
}
