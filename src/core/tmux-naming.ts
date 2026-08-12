// Pure tmux naming helpers shared by the PTY manager and the context-link backend.
// No native/electron imports, so this module is safe to import from unit tests.

export const TMUX_SOCKET = 'node-terminal'

/** Per-node tmux session name. Must stay stable — it is the persistence key. */
export function sessionName(persistKey: string): string {
  return `nt-${persistKey.replace(/[^a-zA-Z0-9_-]/g, '_')}`
}

/**
 * Is this a tmux target THIS app generated (i.e. the output of `sessionName` for some node id)?
 *
 * The check exists for the one caller that cannot quote: a tmux control-mode command is a single
 * text line and `encodeSendKeysHex` interpolates its target into it UNQUOTED, so a target carrying
 * a space would split into the wrong arguments and one carrying a newline would run a second
 * command. `sessionName` already sanitizes everything outside `[A-Za-z0-9_-]` away, so this can only
 * fail on a name that did not come from it — an empty node id, or a raw target somebody passed in.
 * Refusing there is cheap; the alternative is a shell-grade escaping problem on a line that reaches
 * a tmux server with every session on it.
 */
export function isSessionName(target: string): boolean {
  return /^nt-[A-Za-z0-9_-]+$/.test(target)
}
