/**
 * Which multiplexer holds a LOCAL terminal's persistent session on POSIX (issue: Zellij as a
 * session backend). tmux is the default and stays the default; `zellij` is opt-in per machine.
 *
 * settings.json is hand-editable, so every reader goes through `normalizeSessionBackend`: an
 * unknown value — a typo, a future backend this build does not know, a non-string — reads as
 * `tmux`, never as "no persistence". The setting only decides where a NEW session is created: a
 * node whose session already lives in one backend keeps reattaching there (see pty-manager.ts,
 * "the backend follows the session that exists").
 *
 * Windows keeps the session host whatever this says; SSH projects keep the remote tmux.
 */
export type SessionBackend = 'tmux' | 'zellij'

export const SESSION_BACKENDS: readonly SessionBackend[] = ['tmux', 'zellij']

export const DEFAULT_SESSION_BACKEND: SessionBackend = 'tmux'

export function normalizeSessionBackend(value: unknown): SessionBackend {
  return value === 'zellij' ? 'zellij' : 'tmux'
}

/**
 * What a Zellij-backed terminal does NOT get, named so the Settings row can say it out loud.
 * Every entry is a capability whose tmux leg has no Zellij equivalent this build uses; each one
 * degrades to "unknown" / "refused" rather than to a guess (docs/session-backends.md has the
 * measurement behind every line). Kept in @shared so the list the UI prints is the list the
 * docs test pins.
 */
export const ZELLIJ_BACKEND_GAPS: readonly string[] = [
  'Agent-to-agent messaging and triggers into Zellij sessions are refused (no pane-owner or paste-mode probe).',
  'Model switch refuses: it cannot stop the foreground process of a Zellij pane.',
  'The session-memory panel counts Zellij sessions but does not measure them; the idle-session reaper does not see them.',
  'Pasted text reaches Zellij as a command-line argument (readable by other local users while the call runs); pastes over 120 KB are refused.',
  'The stale-folder banner and the live pane folder for file links are unavailable.',
  'SSH projects and Windows keep tmux / the session host.',
  'nodeterm mobile’s direct SSH attach only finds tmux sessions.'
]
