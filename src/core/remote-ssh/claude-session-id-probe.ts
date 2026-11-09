// Pure shell command + parser for the REMOTE "does this host's `claude` take `--session-id`?" probe.
//
// Who needs the answer: the PHONE. A session it starts on this host is launched by the phone
// itself, and it can only add `--session-id <uuid>` — the flag that gives the node a persisted
// conversation id (`agentSessionId`, see core/project-node-append.ts) — when it knows the host's
// CLI accepts it: claude EXITS on an option it does not know, taking the launch with it. The
// answer travels in the agent-status slice pushed onto the host (`MirrorSettings
// .claudeSessionIdFlag`), and this machine's own probe says nothing about another machine's binary.
//
// Same discipline as `claude-version-probe.ts` and `codex-no-daemon-probe.ts`: through the LOGIN
// shell (an exec channel's shell usually never sees an nvm/npm-global PATH), with claude's own
// install locations prepended (the official installer targets `~/.local/bin`, which a stock root
// `.profile` never adds), and the answer DELIMITED so a profile banner can never be read as one.
// No marker ⇒ unknown ⇒ the phone launches the bare command, exactly as it always has.
import { posixQuote } from '../../shared/ssh'
import { CLAUDE_SESSION_ID_HELP_ERE } from '../../shared/agents/claude-session-id-flag'

export const CLAUDE_SESSION_ID_START = '__NT_CLAUDE_SID__'
export const CLAUDE_SESSION_ID_END = '__NT_CLAUDE_SID_END__'

/**
 * Prints `yes` / `no` between the markers when a `claude` resolves, nothing otherwise. A
 * `claude --help` that fails answers `no` — the conservative reading (no flag).
 */
export function claudeSessionIdProbeCommand(): string {
  const emit =
    `PATH="$HOME/.local/bin:$HOME/.claude/local:$PATH"; ` +
    `command -v claude >/dev/null 2>&1 && { ` +
    `if claude --help 2>/dev/null | grep -q -E '${CLAUDE_SESSION_ID_HELP_ERE}'; ` +
    `then a=yes; else a=no; fi; ` +
    `printf '${CLAUDE_SESSION_ID_START}%s${CLAUDE_SESSION_ID_END}' "$a"; }`
  const q = posixQuote(emit)
  return `$SHELL -lc ${q} 2>/dev/null || sh -c ${q} 2>/dev/null`
}

/** `true` / `false` from the markers, `null` when they are absent (no claude, a failed probe). */
export function parseClaudeSessionIdProbe(stdout: string | null | undefined): boolean | null {
  if (!stdout) return null
  const start = stdout.indexOf(CLAUDE_SESSION_ID_START)
  if (start < 0) return null
  const from = start + CLAUDE_SESSION_ID_START.length
  const end = stdout.indexOf(CLAUDE_SESSION_ID_END, from)
  if (end < 0) return null
  const v = stdout.slice(from, end).trim()
  return v === 'yes' ? true : v === 'no' ? false : null
}
