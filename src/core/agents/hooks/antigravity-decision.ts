// THE stdout contract of an Antigravity CLI (`agy`) hook — written ONCE, consumed by every place
// that can answer `agy`: the POSIX managed script, the missing-script fallback inside the
// hooks.json command, and the Windows batch wrapper's bail path.
//
// WHY THIS MATTERS MORE THAN ANYTHING ELSE IN THE INTEGRATION. `agy` runs hooks SYNCHRONOUSLY and
// reads their stdout as a decision. Our hook is installed in the GLOBAL `~/.gemini/config/hooks.json`
// and subscribes to `PreToolUse`, so it stands in front of every tool call of every `agy` on the
// machine — inside nodeterm and outside it. What `agy` 1.2.3 does with each stdout, measured
// on agy 1.2.3, Windows 11, in a temporary HOME, every row reproduced with a real run):
//
//   PreToolUse stdout            result
//   (nothing), exit 0            tool RUNS
//   {}                           DENIED   ("tool call denied by pre-tool hook")
//   {"decision":""}              DENIED
//   {"decision":"ask"}           runs under the user's normal policy (respects "always allow";
//                                loses to --dangerously-skip-permissions, measured)
//   {"decision":"allow"}         runs with no prompt — approves what the USER did not approve
//   non-JSON text                DENIED   (protojson unmarshal error)
//   (nothing), exit 1            DENIED
//
// Hence the table below, and the rules around it:
//   - PreToolUse answers `ask`: safe under both readings (it runs here, and it is what an older
//     `agy` that denied silence also accepted). NEVER `allow` (we would be approving on the user's
//     behalf) and NEVER `force_ask` (re-opens the prompt, ignoring the user's cache).
//   - Stop answers an empty decision. `"continue"` would PREVENT `agy` from stopping.
//   - The lifecycle events answer `{}`.
//   - An UNKNOWN or EMPTY event answers NOTHING. `{}` is the tempting default and it is exactly
//     wrong: if the event name is ever lost and the real event was PreToolUse, `{}` denies the tool.
//     Silence was measured running normally for all five events.
//   - Nothing else may ever reach stdout. `PreInvocation` accepts `injectSteps`, so our stdout can
//     become a message in the user's conversation; and a stray byte from curl turns into "non-JSON →
//     DENY". The script redirects stdout to /dev/null right after answering.
//
// Two copies of this table already diverged once within fifteen minutes during development.
// Keep it here.

export type AntigravityHookEvent = 'PreInvocation' | 'PostInvocation' | 'PreToolUse' | 'PostToolUse' | 'Stop'

const DECISIONS: Readonly<Record<AntigravityHookEvent, string>> = {
  PreToolUse: '{"decision":"ask"}',
  Stop: '{"decision":""}',
  PreInvocation: '{}',
  PostInvocation: '{}',
  PostToolUse: '{}'
}

/** Every event `agy` knows, in a stable order (generators iterate it). */
export const ANTIGRAVITY_EVENTS: readonly AntigravityHookEvent[] = [
  'PreInvocation',
  'PostInvocation',
  'PreToolUse',
  'PostToolUse',
  'Stop'
]

/**
 * What a hook must print for `event`, or `null` for "print nothing". The lookup is by OWN key only,
 * so `constructor`/`__proto__` and every other non-event string answer `null` (silence).
 */
export function antigravityDecisionFor(event: string | undefined | null): string | null {
  if (typeof event !== 'string' || !Object.hasOwn(DECISIONS, event)) return null
  return DECISIONS[event as AntigravityHookEvent]
}

/**
 * The env var carrying the event name from the hooks.json command into the script (POSIX) or
 * from the wrapper's argument into the script (Windows). Shared so neither side can misspell it.
 */
export const ANTIGRAVITY_EVENT_ENV = 'NODETERM_AGY_EVENT'

// The generators interpolate the table into shell and batch source. Every value is checked here
// so a future edit that introduces a quote or a batch metacharacter fails at import, loudly,
// instead of emitting a command that answers wrong.
for (const [event, out] of Object.entries(DECISIONS)) {
  if (!/^[A-Za-z]+$/.test(event)) throw new Error(`antigravity event name not shell-safe: ${event}`)
  if (/['\r\n%!^&|<>()]/.test(out)) throw new Error(`antigravity decision not shell/batch-safe: ${out}`)
}

/**
 * POSIX `case` answering from `$NODETERM_AGY_EVENT`. No default branch: an unknown event prints
 * nothing. `printf` rather than `echo` — some shells' `echo` interprets backslashes.
 */
export function antigravityDecisionCaseSh(): string {
  const arms = ANTIGRAVITY_EVENTS.map((ev) => `  ${ev}) printf '%s\\n' '${DECISIONS[ev]}' ;;`)
  return [`case "$${ANTIGRAVITY_EVENT_ENV}" in`, ...arms, 'esac'].join('\n')
}

/**
 * Batch lines answering from `%NODETERM_AGY_EVENT%`, one `if` per event, case-SENSITIVE (no `/i`:
 * `stop` is not an event). Nothing matches an unknown value, so nothing is echoed. The values hold
 * no batch metacharacter (checked above); `echo` prints the braces and quotes literally.
 */
export function antigravityDecisionBatch(): string[] {
  return ANTIGRAVITY_EVENTS.map(
    (ev) => `if "%${ANTIGRAVITY_EVENT_ENV}%"=="${ev}" echo ${DECISIONS[ev]}`
  )
}
