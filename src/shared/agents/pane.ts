// What the tmux pane's foreground command tells us about a session. Shared because BOTH the
// renderer (agent-restart's exit poll) and the main process (the reconnect resync) ask the same
// question of the same `#{pane_current_command}` answer.

/** Foreground commands that mean "the CLI is gone, a shell owns the pane". Login shells
 *  report as '-zsh'; tmux may report a full path. */
const SHELLS = new Set(['zsh', 'bash', 'sh', 'fish', 'dash', 'ksh', 'tcsh'])

export function isShellCommand(cmd: string | null | undefined): boolean {
  if (!cmd) return false
  const base = cmd.replace(/^-/, '').split('/').pop() ?? ''
  return SHELLS.has(base)
}
