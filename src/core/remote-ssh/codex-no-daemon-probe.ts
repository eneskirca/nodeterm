// Pure shell command + parser for the REMOTE "does this host's `codex` take `--no-daemon`?" probe.
//
// Why a host needs asking at all: from codex-cli 0.157.0 a plain Codex TUI starts (or joins) ONE
// auto-started app-server per CODEX_HOME that keeps the environment of the pane that started it, so
// on an SSH host every later Codex node's hooks and tool shells run with the FIRST node's
// NODETERM_NODE_ID (measured on 0.159.2 — see shared/agents/codex-daemon.ts). The fix is the flag,
// and clap EXITS on an option it does not know, so it may ride a remote launch line only when THAT
// host's codex advertised it. The laptop's probe says nothing about the host's binary.
//
// Same discipline as `claude-version-probe.ts`: through the LOGIN shell (an exec channel's shell
// usually never sees an nvm/npm-global PATH), with the answer DELIMITED so a profile banner can
// never be read as one. No marker ⇒ unknown ⇒ no flag.
import { posixQuote } from '../../shared/ssh'
import { CODEX_NO_DAEMON_HELP_ERE } from '../../shared/agents/codex-daemon'

export const CODEX_NO_DAEMON_START = '__NT_CODEX_ND__'
export const CODEX_NO_DAEMON_END = '__NT_CODEX_ND_END__'

/**
 * Prints `yes` / `no` between the markers when a `codex` resolves, nothing otherwise. The match is
 * `CODEX_NO_DAEMON_HELP_ERE`, the shell spelling of `codexNoDaemonFrom`'s own rule. A `codex --help` that fails
 * answers `no` — the conservative reading (no flag), and the one a CLI that cannot print its own
 * help page deserves.
 */
export function codexNoDaemonProbeCommand(): string {
  const emit =
    `command -v codex >/dev/null 2>&1 && { ` +
    `if codex --help 2>/dev/null | grep -q -E '${CODEX_NO_DAEMON_HELP_ERE}'; ` +
    `then a=yes; else a=no; fi; ` +
    `printf '${CODEX_NO_DAEMON_START}%s${CODEX_NO_DAEMON_END}' "$a"; }`
  const q = posixQuote(emit)
  return `$SHELL -lc ${q} 2>/dev/null || sh -c ${q} 2>/dev/null`
}

/** `true` / `false` from the markers, `null` when they are absent (no codex, a failed probe). */
export function parseCodexNoDaemonProbe(stdout: string | null | undefined): boolean | null {
  if (!stdout) return null
  const start = stdout.indexOf(CODEX_NO_DAEMON_START)
  if (start < 0) return null
  const from = start + CODEX_NO_DAEMON_START.length
  const end = stdout.indexOf(CODEX_NO_DAEMON_END, from)
  if (end < 0) return null
  const v = stdout.slice(from, end).trim()
  return v === 'yes' ? true : v === 'no' ? false : null
}
