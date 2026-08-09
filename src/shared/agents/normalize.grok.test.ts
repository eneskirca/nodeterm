import { describe, expect, it } from 'vitest'
import { grokRawFields, normalizeClaude, normalizeGrok, type RawHookEnvelope } from './normalize'

/**
 * Grok's hook envelope is its own dialect: camelCase keys whose `hookEventName` VALUE is
 * snake_case ("pre_tool_use"), and the grok SDK path converts the top-level keys to snake_case.
 * Both spellings are therefore read, and the event name is canonicalized rather than matched
 * literally — read out of the shipped 1.0.0 docs, not inferred from claude's shape. No payload was
 * ever captured: a hook fires only inside a logged-in grok session, which was never available here.
 */
function env(payload: Record<string, unknown>): RawHookEnvelope {
  return { nodeId: 'n1', agentId: 'grok', payload }
}

describe('normalizeGrok — lifecycle', () => {
  it('maps session_start / session_end to the session phases', () => {
    expect(normalizeGrok(env({ hookEventName: 'session_start', sessionId: 's1' }))).toEqual({
      nodeId: 'n1',
      agentId: 'grok',
      sessionId: 's1',
      kind: 'session',
      sessionPhase: 'start'
    })
    expect(normalizeGrok(env({ hookEventName: 'session_end', sessionId: 's1' }))?.sessionPhase).toBe('end')
  })

  it('treats user_prompt_submit as the turn start (newTurn)', () => {
    const e = normalizeGrok(env({ hookEventName: 'user_prompt_submit', sessionId: 's1', prompt: 'ship it' }))
    expect(e).toMatchObject({ kind: 'state', state: 'working', newTurn: true, task: 'ship it' })
  })

  it('keeps the node working across every tool event, including a tool FAILURE', () => {
    for (const ev of ['pre_tool_use', 'post_tool_use', 'post_tool_use_failure']) {
      expect(normalizeGrok(env({ hookEventName: ev, sessionId: 's1' }))).toMatchObject({
        kind: 'state',
        state: 'working'
      })
    }
  })
})

describe('normalizeGrok — Stop', () => {
  it('a genuine turn end is done, carrying the last assistant message', () => {
    const e = normalizeGrok(
      env({ hookEventName: 'stop', sessionId: 's1', reason: 'end_turn', lastAssistantMessage: 'done' })
    )
    expect(e).toMatchObject({ state: 'done', lastMessage: 'done' })
    // Not interrupted — a genuine turn end DOES earn the completion alert. Asserted separately
    // (as normalize.test.ts does for claude's Stop) because toMatchObject demands the key exist.
    expect(e?.interrupted).toBeFalsy()
  })

  it('an ABSENT reason is still a real turn end (never swallow the badge event)', () => {
    expect(normalizeGrok(env({ hookEventName: 'stop', sessionId: 's1' }))).toMatchObject({ state: 'done' })
  })

  /**
   * The two observe-only reasons are a DENYLIST, not 'end_turn' an allowlist: only grok's session
   * close is observe-only, so any turn-end reason grok labels later must still report its badge and
   * its completion alert. An allowlist would silently mark all of these `interrupted`.
   */
  it('an UNKNOWN reason is a real turn end too, alert and message intact', () => {
    for (const reason of ['max_tokens', 'refusal', 'something_new']) {
      const e = normalizeGrok(env({ hookEventName: 'stop', sessionId: 's1', reason, lastAssistantMessage: 'text' }))
      expect(e, reason).toMatchObject({ state: 'done', lastMessage: 'text' })
      expect(e?.interrupted, reason).toBeFalsy()
    }
  })

  it('the observe-only session-close Stop is marked interrupted, so no completion alert fires', () => {
    for (const reason of ['channel_closed', 'shutdown']) {
      const e = normalizeGrok(env({ hookEventName: 'stop', sessionId: 's1', reason, lastAssistantMessage: 'x' }))
      expect(e).toMatchObject({ state: 'done', interrupted: true })
      expect(e?.lastMessage).toBeUndefined()
    }
  })

  it('stop_failure ends the turn so the badge cannot stick on working', () => {
    expect(
      normalizeGrok(env({ hookEventName: 'stop_failure', sessionId: 's1', lastAssistantMessage: 'rate limited' }))
    ).toMatchObject({ state: 'done', lastMessage: 'rate limited' })
  })
})

/**
 * Notification is the one grok event nobody here could measure, and the two sources that describe it
 * disagree — so every expectation below cites the source it encodes, and ALL of it is inference:
 *
 *  - orca (`/root/orca-main`, MIT, a shipping grok integration) — `permission_prompt` plus prose
 *    messages, `src/shared/agent-hook-listener.ts:2370-2402` (readers) and `:3994-4012` (precedence).
 *  - grok's own shipped docs — `turn_complete | approval_required | session_ready | task_complete |
 *    agent_error`, `~/.grok/docs/user-guide/05-configuration.md:414`.
 *
 * The mapping is therefore built to be safe under BOTH vocabularies: the routine per-tool prompt is
 * suppressed, a genuine ask still reaches NEEDS YOU under either spelling, and anything unrecognized
 * changes no state.
 */
describe('normalizeGrok — Notification', () => {
  /**
   * THE regression this branch's first mapping had backwards. Orca's
   * `isGrokRoutinePermissionPromptNotification` (`agent-hook-listener.ts:2378-2389`) exists because
   * "Grok emits this before each tool even under bypassPermissions; PreToolUse already covers
   * progress" — its own named regression test is
   * `src/renderer/src/hooks/agent-hook-completion-notifications.test.ts:654`. Mapping it to `blocked`
   * fires markUnread (no cooldown), the needs-you chime, an OS notification while unfocused and a
   * phone inbox card on EVERY tool call.
   */
  it('the routine per-tool permission prompt is suppressed, not a NEEDS YOU', () => {
    expect(
      normalizeGrok(
        env({
          hookEventName: 'notification',
          notificationType: 'permission_prompt',
          message: 'Tool permission requested',
          level: 'info'
        })
      )
    ).toBeNull()
    // Level absent is the same routine case (orca: `!level || level === 'info'`), and the message is
    // compared trimmed + case-folded.
    expect(
      normalizeGrok(
        env({
          hookEventName: 'notification',
          notificationType: 'permission_prompt',
          message: '  tool permission requested  '
        })
      )
    ).toBeNull()
  })

  /**
   * The suppression must survive grok's OTHER dialect. grok's envelope is documented camelCase
   * throughout, so `permissionPrompt` is a plausible spelling of the same type — and comparing the
   * type raw would make it miss the suppression and fall through to `includes('permission')`, i.e.
   * bring the per-tool-call strobe straight back. The type therefore goes through the same
   * `grokCanonical` rule the event name uses (orca canonicalizes too, to snake_case:
   * `normalizeHookEventName`, `agent-hook-listener.ts:2201-2210`).
   */
  it('suppresses the routine prompt in EVERY spelling of its type', () => {
    for (const notificationType of ['permissionPrompt', 'permission_prompt', 'Permission-Prompt', 'PERMISSION_PROMPT']) {
      expect(
        normalizeGrok(
          env({ hookEventName: 'notification', notificationType, message: 'tool permission requested' })
        ),
        notificationType
      ).toBeNull()
    }
  })

  it('reads the other ask + idle types in camelCase too (one canonicalization, not three)', () => {
    expect(
      normalizeGrok(env({ hookEventName: 'notification', notificationType: 'agentNeedsInput' }))
    ).toMatchObject({ state: 'waiting' })
    expect(
      normalizeGrok(env({ hookEventName: 'notification', notificationType: 'elicitationDialog' }))
    ).toMatchObject({ state: 'waiting' })
    expect(
      normalizeGrok(env({ hookEventName: 'notification', notificationType: 'approvalRequired' }))
    ).toMatchObject({ state: 'blocked' })
    // And the closed set stays closed under canonicalization: an elicitation END is still inert.
    expect(
      normalizeGrok(env({ hookEventName: 'notification', notificationType: 'elicitationComplete' }))
    ).toBeNull()
  })

  it('a GENUINE ask still reaches NEEDS YOU — the suppression is narrow, not a mute', () => {
    // Same type, a real message: this is the ask a human must answer.
    expect(
      normalizeGrok(
        env({
          hookEventName: 'notification',
          notificationType: 'permission_prompt',
          message: 'Bash wants to run `rm -rf build`'
        })
      )
    ).toMatchObject({ state: 'blocked' })
    // Same type and the routine message, but LOUDER than info — orca's level condition fails, so it
    // is treated as a real ask rather than swallowed.
    expect(
      normalizeGrok(
        env({
          hookEventName: 'notification',
          notificationType: 'permission_prompt',
          message: 'tool permission requested',
          level: 'warn'
        })
      )
    ).toMatchObject({ state: 'blocked' })
    expect(
      normalizeGrok(env({ hookEventName: 'notification', notificationType: 'agent_needs_input' }))
    ).toMatchObject({ state: 'waiting' })
  })

  /**
   * grok's own docs name `approval_required` (05-configuration.md:414) where orca names
   * `permission_prompt`; the two share no substring, so both are matched. Without this the mapping
   * fires for NOTHING if the docs' vocabulary turns out to be the real one.
   */
  it("maps grok's own documented `approval_required` to NEEDS YOU as well", () => {
    expect(
      normalizeGrok(env({ hookEventName: 'notification', notificationType: 'approval_required' }))
    ).toMatchObject({ state: 'blocked' })
  })

  /**
   * The rescue signal, and the reason it must key off the MESSAGE: grok states its idle prompt in
   * prose (orca's `isGrokIdleNotification`, `agent-hook-listener.ts:2391-2402`) and neither source
   * names an "idle" TYPE — so the type-only test this replaced could never fire. It is the only thing
   * that can clear a node stuck on `working` after an Esc, because grok sends no hook for an
   * interrupted turn at all.
   */
  it('detects idle from the MESSAGE — each of orca\'s four phrases clears the badge', () => {
    for (const message of [
      'Type your message or @path/to/file',
      'enter send · shift-tab normal mode',
      'shift-tab normal mode',
      'Ask a side question without interrupting'
    ]) {
      expect(
        normalizeGrok(env({ hookEventName: 'notification', notificationType: 'session_ready', message })),
        message
      ).toMatchObject({ state: 'done', idle: true, interrupted: true })
    }
    // No type at all is still enough — the message carries it.
    expect(
      normalizeGrok(env({ hookEventName: 'notification', message: 'TYPE YOUR MESSAGE' }))
    ).toMatchObject({ state: 'done', idle: true, interrupted: true })
  })

  it('keeps a type-based idle fallback for a message-less notification', () => {
    // Belt and braces: unlike a substring test on an ASK word, a false positive here can only CLEAR
    // a badge — it can never leave one stuck.
    expect(normalizeGrok(env({ hookEventName: 'notification', notificationType: 'idle_prompt' }))).toMatchObject({
      state: 'done',
      idle: true,
      interrupted: true
    })
  })

  /**
   * Precedence, mirroring orca's own order (`agent-hook-listener.ts:3994-4012`: routine-suppress,
   * then ask, then idle): a payload claiming BOTH an ask type and idle prose is asking. A wrongly
   * cleared NEEDS YOU is the failure this branch exists to prevent; a badge that lingers one hook
   * longer is not.
   */
  it('an ask type wins over idle prose in the same payload', () => {
    expect(
      normalizeGrok(
        env({
          hookEventName: 'notification',
          notificationType: 'permission_request',
          message: 'Approve? (type your message to answer)'
        })
      )
    ).toMatchObject({ state: 'blocked' })
  })

  /**
   * Orca reads the kind from THREE keys (`notificationType ?? notification_type ?? type`,
   * `agent-hook-listener.ts:2370-2376`); the third was missing here.
   */
  it('reads the notification kind from the bare `type` key too', () => {
    expect(normalizeGrok(env({ hookEventName: 'notification', type: 'approval_required' }))).toMatchObject({
      state: 'blocked'
    })
    expect(
      normalizeGrok(env({ hookEventName: 'notification', type: 'agent_needs_input' }))
    ).toMatchObject({ state: 'waiting' })
  })

  it('an UNKNOWN notification type is a no-op — a future type must not stick a badge', () => {
    expect(normalizeGrok(env({ hookEventName: 'notification', notificationType: 'auth_success' }))).toBeNull()
    expect(normalizeGrok(env({ hookEventName: 'notification' }))).toBeNull()
  })

  /**
   * The asking types are matched EXACTLY, not by substring: grok's vocabulary is claude-derived, and
   * claude's `elicitation_complete` / `elicitation_response` fire when an elicitation ENDS. A
   * substring test on 'elicit' would read those as a fresh ask and leave NEEDS YOU on a node that
   * just finished — the exact bug normalizeClaude's closed set exists to avoid
   * (normalize.test.ts, 'informational / unknown Notification types do not change state').
   */
  it('the elicitation END notifications are informational, NOT a new ask', () => {
    for (const type of ['elicitation_complete', 'elicitation_response', 'agent_completed']) {
      expect(normalizeGrok(env({ hookEventName: 'notification', notificationType: type })), type).toBeNull()
    }
    // The dialog OPENING is the one elicitation type that does ask.
    expect(
      normalizeGrok(env({ hookEventName: 'notification', notificationType: 'elicitation_dialog' }))
    ).toMatchObject({ state: 'waiting' })
  })

  it('reads the notification type in the SDK snake_case dialect too', () => {
    expect(
      normalizeGrok(env({ hook_event_name: 'notification', notification_type: 'permission_prompt' }))
    ).toMatchObject({ state: 'blocked' })
    expect(
      normalizeGrok(env({ hook_event_name: 'notification', notification_type: 'agent_needs_input' }))
    ).toMatchObject({ state: 'waiting' })
    expect(
      normalizeGrok(env({ hook_event_name: 'notification', notification_type: 'idle_prompt' }))
    ).toMatchObject({ state: 'done', idle: true, interrupted: true })
  })
})

describe('normalizeGrok — dialects', () => {
  it('reads the SDK snake_case key spelling too', () => {
    expect(
      normalizeGrok(env({ hook_event_name: 'stop', session_id: 's9', last_assistant_message: 'ok' }))
    ).toMatchObject({ sessionId: 's9', state: 'done', lastMessage: 'ok' })
  })

  it('accepts a PascalCase event name (canonicalized, not matched literally)', () => {
    expect(normalizeGrok(env({ hookEventName: 'PreToolUse' }))).toMatchObject({ state: 'working' })
  })

  it('ignores events we do not subscribe to yet', () => {
    for (const ev of ['pre_compact', 'post_compact', 'subagent_start', 'subagent_stop', 'permission_denied']) {
      expect(normalizeGrok(env({ hookEventName: ev, sessionId: 's1' })), ev).toBeNull()
    }
  })
})

/**
 * Grok also merges `~/.claude/settings.json`, where nodeterm's CLAUDE managed hook already lives —
 * so every grok event ALSO fires claude.sh and POSTs to /hook/claude. That leg must stay inert:
 * this is the test that keeps it a property instead of a coincidence.
 */
describe('the claude-compat cross-fire is inert', () => {
  const GROK_EVENTS = ['session_start', 'user_prompt_submit', 'pre_tool_use', 'post_tool_use', 'stop', 'session_end']

  it('normalizeClaude returns null for every grok payload (camelCase dialect)', () => {
    for (const ev of GROK_EVENTS) {
      expect(
        normalizeClaude({ nodeId: 'n1', agentId: 'claude', payload: { hookEventName: ev, sessionId: 's1' } }),
        ev
      ).toBeNull()
    }
  })

  /**
   * This is the leg that actually carries the property: in the SDK dialect grok writes the key
   * claude DOES read (`hook_event_name`), so inertness rests entirely on claude's compare being
   * case-sensitive and literal — 'stop' is not 'Stop'. Anyone who "helpfully" lowercases claude's
   * event name breaks this and nothing else.
   */
  it('normalizeClaude returns null for every grok payload (SDK snake_case dialect)', () => {
    for (const ev of GROK_EVENTS) {
      expect(
        normalizeClaude({ nodeId: 'n1', agentId: 'claude', payload: { hook_event_name: ev, session_id: 's1' } }),
        ev
      ).toBeNull()
    }
  })
})

describe('grokRawFields', () => {
  it('hands the shells ONE canonical field set from either dialect', () => {
    expect(
      grokRawFields({
        hookEventName: 'pre_tool_use',
        sessionId: 's1',
        cwd: '/w',
        toolName: 'spawn_subagent',
        toolUseId: 't1',
        toolInput: { subagent_type: 'explore' }
      })
    ).toEqual({
      event: 'pretooluse',
      sessionId: 's1',
      cwd: '/w',
      toolName: 'spawn_subagent',
      toolUseId: 't1',
      toolInput: { subagent_type: 'explore' }
    })
    // Every field the function reads, in the SDK dialect — dual-dialect reading is its whole reason
    // to exist, so dropping any one `?? p.snake_case` fallback has to fail here.
    expect(
      grokRawFields({
        hook_event_name: 'post_tool_use',
        session_id: 's2',
        cwd: '/w2',
        tool_name: 'read_file',
        tool_use_id: 't2',
        tool_input: { path: '/w2/a.ts' }
      })
    ).toEqual({
      event: 'posttooluse',
      sessionId: 's2',
      cwd: '/w2',
      toolName: 'read_file',
      toolUseId: 't2',
      toolInput: { path: '/w2/a.ts' }
    })
  })
})
