// Which account scope a REMOTE (SSH) tmux session is spawned under — the `-e` pairs for the remote
// `tmux new-session`. The local leg answers the same question inline in `buildPtyEnv`; the remote
// leg used to hand EVERY `accountId` to Claude's `CLAUDE_CONFIG_DIR`, so a node bound to a managed
// Codex account on an SSH host got a Claude config dir that does not exist and NO `CODEX_HOME` — and
// its codex silently ran as the host's SYSTEM login. The Codex remote env builder existed and had no
// caller.
//
// The provider is decided exactly as locally: `needsCodexAccountScope` with the caller's
// `isCodexAccount` (the two account lists share an id alphabet, so the id alone cannot say).
import { accountTmuxEnvArgs, remoteAccountConfigDirAbs } from './claude-accounts-core'
import { needsCodexAccountScope, remoteCodexTmuxEnvArgs } from './codex-accounts-core'
import { isSafeRemoteHome } from './remote-safety'

export function remoteAccountScopeEnvArgs(opts: {
  agentId: string | undefined
  accountId: string | undefined
  /** The connection's resolved `$HOME` (tmux copies `-e` values verbatim, so paths are absolute). */
  remoteHome: string | undefined
  isCodexAccount: (id: string) => boolean
}): string[] {
  const { agentId, accountId, remoteHome, isCodexAccount } = opts
  if (!remoteHome) return [] // fail-open, as before: the session runs under the host's defaults
  if (needsCodexAccountScope(agentId, accountId, isCodexAccount)) {
    // The SYSTEM Codex account (no id) is left to the host's own environment: a remote user may
    // point CODEX_HOME elsewhere themselves (a snap install remaps it), and overriding that with
    // `~/.codex` would break them. A managed account gets its private home; a `$HOME` that could
    // smuggle a newline into the `-e` value gets nothing.
    if (!accountId || !isSafeRemoteHome(remoteHome)) return []
    return remoteCodexTmuxEnvArgs(remoteHome, accountId)
  }
  if (!accountId) return []
  return accountTmuxEnvArgs(remoteAccountConfigDirAbs(remoteHome, accountId))
}
