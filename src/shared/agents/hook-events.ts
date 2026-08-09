// The hook events each agent's managed installer subscribes to — ONE list per agent, shared by
// every installer (local desktop, Server Edition, and the SSH remote installer).
//
// They used to be declared twice, and the copies had drifted: the remote installer subscribed
// claude to `SessionStart`/`SubagentStop` but NOT to `StopFailure`/`PermissionRequest` (so a
// remote agent's errored turn stuck on "working" and its permission prompts arrived late), and it
// subscribed gemini to CLAUDE's event names, which gemini never fires — remote gemini nodes
// reported no status at all.
//
// The drift also produced a broken settings.json on any machine where two installers ran: each
// rewrites only the events IT knows, so a stale instance's command survived on every event the
// other list lacked. Keeping the lists here is what makes an install a complete rewrite.

/**
 * One managed hook subscription: an event name, or an event name PLUS the matcher to write for it.
 * Only grok needs the second form — its tool-event `matcher` is a real REGEX
 * (`~/.grok/docs/user-guide/10-hooks.md:153`), so a bare `*` is not a valid match-all but an invalid
 * pattern, and the expected failure is silence: the tool events simply never fire. We write `.*`.
 * That is read off the docs, not observed — no hook was ever seen firing here (see GROK_HOOK_EVENTS).
 * claude/codex/gemini stay plain strings, so their emitted config is byte-identical to what it has
 * always been.
 */
export type ManagedHookEvent = string | { event: string; matcher: string }

/** Claude Code hook events. Each maps to a `NormalizedAgentEvent` in shared/agents/normalize.ts. */
export const CLAUDE_HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'Stop',
  // Fires INSTEAD of Stop when the turn ends on an API/model error — without it the
  // status badge sticks on "working" after any errored turn.
  'StopFailure',
  'Notification',
  // Dedicated permission-prompt signal (→ blocked), more direct than Notification.
  'PermissionRequest',
  'SessionEnd',
  'PreToolUse',
  'PostToolUse'
] as const

/** Gemini CLI hook events — its own names, NOT Claude's (see normalizeGemini). */
export const GEMINI_HOOK_EVENTS = ['BeforeAgent', 'AfterAgent', 'AfterTool', 'BeforeTool'] as const

/**
 * Grok hook events (→ normalizeGrok). Grok's shipped 1.0.0 docs list fourteen
 * (`~/.grok/docs/user-guide/10-hooks.md:84-101`); nine are subscribed — the ones `normalizeGrok` has
 * a mapping for. The other five are left off deliberately: PermissionDenied is a post-decision event
 * we would have nothing to do with, SubagentStart/SubagentStop drive subagent cards that are not
 * built for grok, and PreCompact/PostCompact have no consumer. No event here was ever seen FIRING —
 * that needs a logged-in session, which the branch never had — so subscribing one is a claim about
 * the docs, not a measurement. Grok skips hook event names it does not recognize (that is how a shared Claude
 * settings file loads at all), so adding one later is safe.
 */
export const GROK_HOOK_EVENTS: readonly ManagedHookEvent[] = [
  'SessionStart',
  'UserPromptSubmit',
  'Stop',
  // Fires INSTEAD of Stop when the turn dies on an API error — without it the badge sticks.
  'StopFailure',
  'Notification',
  'SessionEnd',
  // The matcher is a REGEX, and an omitted one already matches everything
  // (~/.grok/docs/user-guide/10-hooks.md:153) — so this is not a requirement, it is an explicit
  // statement of "every tool". It is spelled `.*` and never `*`, because a bare `*` is not a
  // valid regex at all (nothing to repeat) and the failure mode is silence: the tool lifecycle
  // hooks simply never fire, so RUNNING clears mid-turn on a long tool call with nothing saying why.
  { event: 'PreToolUse', matcher: '.*' },
  { event: 'PostToolUse', matcher: '.*' },
  { event: 'PostToolUseFailure', matcher: '.*' }
]
