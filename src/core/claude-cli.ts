// Capability probe for the LOCAL Claude CLI. Today it answers exactly one question — does this
// CLI accept `--permission-mode auto`? (Claude Code >= 2.1.71; older CLIs exit 1 on the value, see
// AUTO_PERMISSION_MODE_MIN_VERSION) — but it is shaped as a caps bag so the next version-gated
// flag lands here instead of growing another probe.
//
// Lives in core (not main) so the Server Edition boots it through the same CorePlatform seam.
// The remote (SSH) CLI is probed separately on its own host — see SshProjectManager.
import { execFile } from 'child_process'
import { promisify } from 'util'
import { supportsAutoPermissionMode, supportsFullscreenTui } from '../shared/agents/config'
import { IPC } from '../shared/ipc'
import { UNKNOWN_CLAUDE_CLI_CAPS, type ClaudeCliCaps } from '../shared/types'
import { directExecutableInvocation } from './exec-path'
import { findInLoginPath } from './pty-manager'
import { platform } from './platform'

const execFileP = promisify(execFile)
const PROBE_TIMEOUT_MS = 5000

export { UNKNOWN_CLAUDE_CLI_CAPS, type ClaudeCliCaps }

/**
 * Pure: probe output → caps. The impure probe below is just plumbing around it.
 *
 * `--session-id` is FEATURE-detected from `--help` rather than gated on a version, because the
 * release it first appeared in is not documented anywhere this repo can verify. Guessing a floor
 * is uniquely dangerous for this flag: an unrecognised flag makes the CLI exit, so a floor set too
 * low would kill every claude launch on the machines below it. Reading the help text asks the CLI
 * in front of us what it actually accepts. Absent help output ⇒ false ⇒ no flag ⇒ today's command.
 */
export function claudeCliCapsFrom(
  versionOutput: string | null | undefined,
  helpOutput?: string | null
): ClaudeCliCaps {
  const version = versionOutput?.trim() || null
  return {
    version,
    autoPermissionMode: supportsAutoPermissionMode(version),
    fullscreenTui: supportsFullscreenTui(version),
    // Anchored on a word boundary so `--session-id-file` or prose mentioning the flag inside
    // another option's description cannot answer yes for it.
    sessionIdFlag: /(^|\s)--session-id(\s|=|$)/m.test(helpOutput ?? '')
  }
}

export async function probeClaudeCliAt(bin: string): Promise<ClaudeCliCaps> {
  try {
    const versionInvocation = directExecutableInvocation(bin, ['--version'])
    if (!versionInvocation) return UNKNOWN_CLAUDE_CLI_CAPS
    const { stdout } = await execFileP(versionInvocation.executable, versionInvocation.args, {
      ...versionInvocation.options,
      timeout: PROBE_TIMEOUT_MS
    })
    // `--help` is a second spawn, paid once per process (this whole probe is memoized). Its
    // failure must not cost us the version answer, so it degrades on its own: no help text just
    // means no minted session ids.
    const helpInvocation = directExecutableInvocation(bin, ['--help'])
    const help = helpInvocation
      ? await execFileP(helpInvocation.executable, helpInvocation.args, {
          ...helpInvocation.options,
          timeout: PROBE_TIMEOUT_MS
        })
          .then((r) => r.stdout)
          .catch(() => null)
      : null
    return claudeCliCapsFrom(stdout, help)
  } catch {
    // Missing CLI, timeout, non-zero exit — all mean "unknown", which means "omit the flag".
    return UNKNOWN_CLAUDE_CLI_CAPS
  }
}

let cached: Promise<ClaudeCliCaps> | null = null

async function probe(): Promise<ClaudeCliCaps> {
  // GUI apps don't inherit the shell PATH — resolve through the login shell like every other
  // CLI lookup in the app (pty-manager, commit-message).
  const bin = await findInLoginPath('claude')
  if (!bin) return UNKNOWN_CLAUDE_CLI_CAPS
  return probeClaudeCliAt(bin)
}

/**
 * The local Claude CLI's capabilities. Memoized for the process lifetime: `claude --version`
 * spawns a login shell + node, and the answer only changes when the user upgrades the CLI (which a
 * relaunch picks up). Never rejects.
 */
export function claudeCliCaps(): Promise<ClaudeCliCaps> {
  if (!cached) cached = probe()
  return cached
}

/** Wire the probe onto the platform's RPC surface (Electron ipcMain / server WS-RPC alike). */
export function registerClaudeCliIpc(): void {
  platform().handle(IPC.claudeCliCaps, () => claudeCliCaps())
}
