// What the tmux pane's foreground command tells us about a session. Shared because BOTH the
// renderer (agent-restart's exit poll) and the main process (the reconnect resync) ask the same
// question of the same `#{pane_current_command}` answer.

// NOT a way to ask "is this an agent pane?". `!isShellCommand(cmd)` was that gate once, and it is
// wrong in both directions: the list below is a fixed allowlist, so `xonsh`, `elvish`, `ssh` and
// `python` all negate to "agent", and `#{pane_current_command}` answers `node` for every
// npm-installed agent CLI anyway. That question is now `isAgentPane`
// (`./pane-owner-predicate.ts`), which reads the pane's foreground process group from the kernel.
//
// This one stays because its callers ask a genuinely different question — "has the CLI let go of
// the pane?" — for which a shell allowlist IS the right shape: an unrecognised command is simply
// "not yet", and the poll goes round again. Recognition is POSITIVE only: widening the set can only
// turn a "not yet" into "a shell owns it", never the reverse.
//
// The Windows session host reports its pane owner as the process image name (`pwsh.exe`,
// `powershell.exe`, `cmd.exe`, sometimes a full `C:\…\cmd.exe`), so the answer is normalised
// before the lookup: leading login '-', either path separator, case, and a trailing `.exe` (which
// also covers Git Bash's `bash.exe` / `sh.exe`). tmux's answers (`-zsh`, `/bin/sh`, `bash`) are
// already in normal form, so they read exactly as before.

/** Foreground commands that mean "the CLI is gone, a shell owns the pane". */
const SHELLS = new Set([
  'zsh',
  'bash',
  'sh',
  'fish',
  'dash',
  'ksh',
  'tcsh',
  'nu',
  'pwsh',
  'powershell',
  'cmd'
])

export function isShellCommand(cmd: string | null | undefined): boolean {
  if (!cmd) return false
  const base = (cmd.replace(/^-/, '').split(/[\\/]/).pop() ?? '').toLowerCase().replace(/\.exe$/, '')
  return SHELLS.has(base)
}

/** Launch/retry gate. Kept as a name for its callers; it is now exactly `isShellCommand`, which
 *  absorbed the native Windows shells this used to add on top. Unknown foregrounds are never
 *  writable. */
export const isLaunchShell = isShellCommand
