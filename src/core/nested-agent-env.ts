/**
 * Markers that say "this process IS an agent CLI session", inherited from whatever launched the
 * app — stripped from every pty nodeterm spawns.
 *
 * The same reasoning as the `TMUX` strip beside it in `buildPtyEnv`: launching the app from inside
 * a session must not make the sessions it spawns believe they are nested inside that one. Both are
 * one hazard — an environment describing the LAUNCHER, inherited by children that are not it.
 *
 * MEASURED (2026-09-11, this repo, which is developed from inside nodeterm): with nodeterm started
 * from a Claude Code terminal, every canvas terminal inherited `CLAUDE_CODE_CHILD_SESSION=1`, and
 * the Claude CLI in each pane correctly concluded it was a nested child session and turned
 * TRANSCRIPT SAVING OFF. That is not cosmetic — a session with no transcript has no ⌘M chat view,
 * no context meter, no find-bar index and nothing for `claude --resume` to resume, i.e. most of
 * what this app reads about an agent node. The pane reported it (`⚠ Transcript saving is off —
 * inherited CLAUDE_CODE_CHILD_SESSION marker`); nothing else did.
 *
 * EXPLICIT NAMES, NEVER A `CLAUDE*` PREFIX SWEEP. `CLAUDE_CONFIG_DIR` is set BY this app to select
 * a managed account (see `ACCOUNT_SCOPE_UPDATE_ENV`), and `CODEX_HOME` likewise — a prefix sweep
 * would delete the very variable the account binding rides on and silently run every managed-account
 * node as the system account. Credential names are a different hazard with its own list
 * (`AUTH_ENV_STRIP`); this one is only about identity markers.
 *
 * Claude Code only, deliberately. These eight are measured from a real session. Codex's own
 * `CODEX_THREAD_ID` is the obvious analogue, but it is also load-bearing for the shared-identity
 * prelude (`codexThreadIdentityResolverSh`, see CLAUDE.md), so it needs its own reasoning and its
 * own measurement rather than being swept in here by symmetry — follow-up.
 */
export const NESTED_AGENT_ENV_STRIP: readonly string[] = [
  'CLAUDECODE',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_BRIDGE_SESSION_ID',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_PID'
]
