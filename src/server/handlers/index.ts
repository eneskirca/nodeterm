import type { Settings } from '../../shared/types'
import type { ServerPlatform } from '../platform-server'
import { GitService } from '../../core/git-service'
import { generateCommitMessage } from '../../core/commit-message'
import { registerFsHandlers } from '../../core/fs-handlers'
import { claudeCliCaps, registerClaudeCliIpc } from '../../core/claude-cli'
import { startUsageService } from '../../core/usage/usage-service'
import { IPC } from '../../shared/ipc'

/** Register the Phase-3a handler surface (fs + git + commit) on the server platform.
 *  git.setActiveRemote is a local-only no-op here: it exists to arm SSH-project remote
 *  routing on desktop, which the server edition does not have (terminals are local). */
export function registerCoreHandlers(
  platform: ServerPlatform,
  deps: { getSettings: () => Settings }
): { gitService: GitService } {
  registerFsHandlers(platform)

  const gitService = new GitService()
  // registers all git:* channels via the global core platform().handle
  gitService.registerIpc()

  // Desktop: ipcMain.handle(IPC.commitGenerate, (_e, cwd) => generateCommitMessage(cwd, settingsStore.get()))
  platform.handle(IPC.commitGenerate, (cwd: string) =>
    generateCommitMessage(cwd, deps.getSettings())
  )
  // Local server has no SSH projects; keep git running against the local remote.
  platform.handle(IPC.gitSetActiveRemote, () => null)

  // Desktop: ipcMain.handle(IPC.appUserDataDir, () => app.getPath('userData')).
  // The browser needs the REAL data dir: it is the writable base the worktree dialog derives its
  // default path from, and an empty answer there proposes `/worktrees/…` at the filesystem root.
  platform.handle(IPC.appUserDataDir, () => platform.userDataDir)

  // The browser needs the same `--permission-mode auto` version gate as desktop: the server's own
  // claude CLI is the one that will run the terminal nodes. Warm it so the first call is cached.
  registerClaudeCliIpc()
  void claudeCliCaps()

  // Claude subscription usage. Previously desktop-only — the browser bridge answered `null`, so
  // the pill never rendered in the Server Edition. Poll only while a browser is attached: with
  // no client there is nobody to show it to, and the usage endpoint's request budget is tight.
  startUsageService({ shouldPoll: () => platform.clientIds().length > 0 })

  return { gitService }
}
