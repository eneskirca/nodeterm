/**
 * Keep every nodeterm-launched Codex TUI out of Codex's auto-started shared app-server.
 *
 * From codex-cli 0.157.0 the `daemon_auto_start` feature is `stable, true`: a plain `codex` TUI
 * starts (or joins) ONE background app-server per `CODEX_HOME`, and that daemon keeps the
 * environment of the pane that STARTED it. nodeterm tells a node apart by environment
 * (`NODETERM_NODE_ID`, the hook endpoint — `buildPtyEnv`), and the daemon is what spawns tool
 * shells and hook processes, so every later Codex node's hooks, canvas-control verbs and
 * context-link reads were attributed to the first pane's node. Measured on 0.159.2 (see
 * `codexNoDaemonFrom` in core/codex-cli.ts): `--no-daemon` fixes it, `-c
 * features.daemon_auto_start=false` does not (it still joins a running daemon), and there is no
 * environment switch.
 *
 * The flag goes on the line only when the CLI that will run it has been SEEN to accept it
 * (`caps.codexNoDaemon === true`): clap exits on an unknown option, so an unprobed or remote CLI
 * gets today's command line byte for byte. Never next to `--remote` — measured, codex refuses the
 * pair ("--no-daemon cannot be used with --remote") — which is also why the managed launcher strips
 * it again before its own `codex --remote unix:// resume` (core/codex-identity-proxy.ts) and keeps
 * it for its plain-codex fallbacks.
 */
import { argvHasFlag } from '../shell-quote'
import type { ApprovalCaps } from './approval-mode'
import type { AgentId } from './config'

export const CODEX_NO_DAEMON_FLAG = '--no-daemon'

/**
 * The ONE detection rule, spelled for both readers: an option HEADER line (indent <= 6, which is
 * where clap puts options; descriptions sit at 10), and the flag followed by whitespace or the end
 * of the line — so a future `--no-daemon-x` option is not read as this one. The TS reader
 * (`codexNoDaemonFrom`) and every generated shell reader (`grep -E`, the managed launcher and the
 * remote probe) use these two strings; a test pins that they agree on the same inputs.
 */
export const CODEX_NO_DAEMON_HELP_RE = /^ {0,6}--no-daemon(\s|$)/
export const CODEX_NO_DAEMON_HELP_ERE = '^ {0,6}--no-daemon([[:space:]]|$)'

/**
 * Which host a remote `--no-daemon` answer belongs to: `user@host:port`. The PORT is part of it on
 * purpose — two containers on one machine (`root@localhost:2222`, `:2223`) are two binaries, and a
 * key without the port let the last probe answer for both (a 0.148 container handed the flag dies).
 */
export function codexProbeHostKey(conn: { user?: unknown; host?: unknown; port?: unknown }): string | null {
  if (typeof conn.host !== 'string' || typeof conn.user !== 'string') return null
  const port = typeof conn.port === 'number' && Number.isFinite(conn.port) ? conn.port : 22
  return `${conn.user}@${conn.host}:${port}`
}

/** Append `--no-daemon` to a codex launch/resume line. `agentId` is the CAPABILITY id (a custom
 *  agent whose `baseAgent` is codex passes `codex`, exactly as `withPermissionMode` is called). */
export function withCodexNoDaemon(cmd: string, agentId: AgentId, caps: ApprovalCaps = {}): string {
  if (agentId !== 'codex' || caps.codexNoDaemon !== true) return cmd
  if (argvHasFlag(cmd, CODEX_NO_DAEMON_FLAG) || argvHasFlag(cmd, '--remote')) return cmd
  return `${cmd} ${CODEX_NO_DAEMON_FLAG}`
}
