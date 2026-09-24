// Desktop wiring for the managed-Claude-account lifecycle. The lifecycle itself lives in
// src/core/claude-accounts-service.ts so the Server Edition serves the same four channels
// (issue #313); this file supplies only the two things core cannot reach — the canvas-control
// skill installer (which imports electron's `app`) and the SSH project manager.
import { registerClaudeAccountsIpc } from '../core/claude-accounts-service'
import { installCanvasSkillInto } from './canvas-control'
import type { SshProjectManager } from './remote-ssh/ssh-project'

// Re-exported for this module's other consumers (claude-usage.ts) so their import path is
// unchanged; the implementation now lives in core (../core/claude-config-dir).
export { claudeConfigDirFor } from '../core/claude-config-dir'

/**
 * @param getSshManager Lazily resolves the SSH project manager (created after this init in index.ts).
 * Returns undefined when SSH isn't wired — every remote path then falls back to local behavior.
 */
export function initClaudeAccounts(getSshManager?: () => SshProjectManager | undefined): void {
  registerClaudeAccountsIpc({
    installSkill: installCanvasSkillInto,
    remote: () => {
      const mgr = getSshManager?.()
      if (!mgr) return undefined
      return {
        add: (projectId, id) => mgr.remoteAccountAdd(projectId, id),
        readLogin: (projectId, id) => mgr.remoteAccountReadLogin(projectId, id),
        remove: (projectId, id) => mgr.remoteAccountRemove(projectId, id),
        copySession: (projectId, sessionId, source, target) =>
          mgr.remoteClaudeSessionCopy(projectId, sessionId, source, target)
      }
    }
  })
}
