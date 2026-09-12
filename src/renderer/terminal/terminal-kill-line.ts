import type { SessionSource } from '../session/session'
import {
  KILL_LINE,
  shellKillLineSequence
} from '@shared/shell-kill-line'

export interface TerminalKillLineFacts {
  /** Which core owns the active tab's filesystem and process lifecycle. */
  source: SessionSource
  /** True for the Server Edition's websocket-backed browser tab (currently source `local`). */
  browserRuntime: boolean
  /** The browser/window's OS. It is authoritative only for the local desktop core. */
  viewerWindows: boolean
  /** `process.platform` reported by the core; null means it was not observed yet. */
  corePlatform: string | null
  /** True if this terminal targets an SSH project or remote session node. */
  remoteSession: boolean
  /** Optional shell configured on the node or resolved default. */
  shell?: string | null
}

/**
 * Choose the line-clear sequence for a terminal node (Ctrl-U vs Escape).
 *
 * A browser's OS is not evidence about a Server Edition or relay host: a Windows browser
 * pointed at a Linux Server Edition must not write Escape into bash/readline (where Escape is
 * the meta-prefix). When the core platform has not been observed yet, fail closed to `\x15`.
 * Remote sessions (SSH project or standalone SSH) target POSIX environments and use `\x15`.
 */
export function terminalKillLine(facts: TerminalKillLineFacts): string {
  if (facts.remoteSession) return KILL_LINE

  const platform =
    facts.corePlatform ??
    (facts.source === 'local' && !facts.browserRuntime
      ? facts.viewerWindows
        ? 'win32'
        : 'posix'
      : null)

  if (!platform) return KILL_LINE

  return shellKillLineSequence(undefined, facts.shell, platform)
}
