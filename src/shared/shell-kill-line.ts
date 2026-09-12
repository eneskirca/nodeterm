/**
 * LINE-CLEAR SEQUENCES FOR SHELLS VS AGENT TUIS.
 *
 * Line clearing before command delivery (command-delivery.ts) or after delivery refusal
 * targets an interactive SHELL (PowerShell, cmd.exe, bash, zsh).
 *
 *  - POSIX shells (bash, zsh, dash) bind `\x15` (Ctrl-U) to kill the pending line in readline/ZLE.
 *  - Windows shells (PowerShell, cmd.exe) bind `\x1b` (Escape) to clear the line. In PowerShell,
 *    `\x15` is not bound by default; typing `\x15` leaves junk on the prompt and mangles retried commands.
 *
 * CRITICAL LOAD-BEARING SPLIT:
 * `WINDOWS_KILL_LINE` (`\x1b`) is ONLY for shells. A live AGENT TUI (Claude Code, Codex, etc.) treats
 * a lone `\x1b` as the INTERRUPT gesture (cancelling turns / thinking), not a line-clear gesture!
 * Therefore, agent exit phases (`performExitPhase` in `agent-restart.ts`) write into panes owned by
 * agent TUIs and MUST continue to write `KILL_LINE` (`\x15`), NEVER `WINDOWS_KILL_LINE` (`\x1b`).
 */

/** Ctrl-U — line-kill sequence in POSIX shells (readline/ZLE) and default agent TUI line clear. */
export const KILL_LINE = '\x15'

/** Escape — line-clear sequence in Windows native shells (PowerShell, cmd.exe). */
export const WINDOWS_KILL_LINE = '\x1b'

export type ShellKillLineDialect = 'posix' | 'pwsh' | 'windows-powershell' | 'cmd'

/**
 * Determine the appropriate line-clear sequence for a shell given its dialect, executable name,
 * and host platform.
 *
 * If a dialect is specified ('pwsh', 'windows-powershell', 'cmd'), it takes precedence.
 * If dialect is 'posix' (including git-bash / MSYS on Windows), returns `\x15`.
 * If dialect is omitted, the executable name is checked (e.g. bash.exe vs pwsh.exe), stripping directory paths.
 * Finally, falls back to the host platform ('win32' -> Escape, others -> Ctrl-U).
 * Unobserved or unknown platforms fail closed to `KILL_LINE` ('\x15').
 */
export function shellKillLineSequence(
  dialect?: ShellKillLineDialect | string | null,
  shellExecutableName?: string | null,
  platform: NodeJS.Platform | string | null = typeof process !== 'undefined' ? process.platform : null
): string {
  if (dialect === 'pwsh' || dialect === 'windows-powershell' || dialect === 'cmd') {
    return WINDOWS_KILL_LINE
  }
  if (dialect === 'posix') {
    return KILL_LINE
  }
  const raw = shellExecutableName ?? ''
  const exe = raw.replace(/^.*[/\\]/, '').toLowerCase()
  if (
    exe === 'powershell' ||
    exe === 'powershell.exe' ||
    exe === 'pwsh' ||
    exe === 'pwsh.exe' ||
    exe === 'cmd' ||
    exe === 'cmd.exe'
  ) {
    return WINDOWS_KILL_LINE
  }
  if (exe === 'bash' || exe === 'bash.exe' || exe === 'zsh' || exe === 'sh' || exe === 'fish') {
    return KILL_LINE
  }
  return platform === 'win32' ? WINDOWS_KILL_LINE : KILL_LINE
}
