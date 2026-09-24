// What the tmux pane's foreground command tells us about a session. Shared because BOTH the
// renderer (agent-restart's exit poll) and the main process (the reconnect resync) ask the same
// question of the same `#{pane_current_command}` answer.

// NOT a way to ask "is this an agent pane?". `!isShellCommand(cmd)` was that gate once, and it is
// wrong in both directions: the list below is SEVEN names, so `nu`, `pwsh`, `xonsh`, `elvish`,
// `ssh` and `python` all negate to "agent", and `#{pane_current_command}` answers `node` for every
// npm-installed agent CLI anyway. That question is now `isAgentPane`
// (`./pane-owner-predicate.ts`), which reads the pane's foreground process group from the kernel.
//
// This one stays, unchanged, because its callers ask a genuinely different question — "has the CLI
// let go of the pane?" — for which a shell allowlist IS the right shape: an unrecognised command is
// simply "not yet", and the poll goes round again.

/** Foreground commands that mean "the CLI is gone, a shell owns the pane". Login shells
 *  report as '-zsh'; tmux may report a full path. */
const SHELLS = new Set(['zsh', 'bash', 'sh', 'fish', 'dash', 'ksh', 'tcsh'])

export function isShellCommand(cmd: string | null | undefined): boolean {
  if (!cmd) return false
  const base = cmd.replace(/^-/, '').split('/').pop() ?? ''
  return SHELLS.has(base)
}

/** Launch/retry gate, including native Windows shells. Unknown foregrounds are never writable. */
export function isLaunchShell(cmd: string | null | undefined): boolean {
  if (isShellCommand(cmd)) return true
  const base = cmd?.split(/[\\/]/).pop()?.toLowerCase().replace(/\.exe$/, '')
  return base === 'pwsh' || base === 'powershell' || base === 'cmd'
}
