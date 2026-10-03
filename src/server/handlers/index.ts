import { stat } from 'node:fs/promises'
import type { DownloadTicket, Settings } from '../../shared/types'
import type { ServerPlatform } from '../platform-server'
import type { DownloadTickets } from '../../core/download-tickets'
import { DOWNLOAD_PATH, downloadName } from '../download'
import { GitService } from '../../core/git-service'
import { generateCommitMessage } from '../../core/commit-message'
import { registerFsHandlers } from '../../core/fs-handlers'
import { claudeCliCaps, registerClaudeCliIpc } from '../../core/claude-cli'
import { registerGrokCliIpc } from '../../core/grok-cli'
import { registerCodexIdentityIpc } from '../../core/codex-identity-caps'
import { registerCodexCliIpc } from '../../core/codex-cli'
import { registerWallpaperIpc } from '../../core/wallpaper'
import { registerRunConfigIpc } from '../../core/run-service'
import { startUsageService } from '../../core/usage/usage-service'
import { registerClaudeAccountsIpc } from '../../core/claude-accounts-service'
import { codexUsageAccounts } from '../../core/codex-accounts-core'
import { codexHomeFor } from '../../core/codex-config-dir'
import {
  setMirrorUsageProvider,
  buildMirrorUsage,
  flush as flushAgentStatusMirror
} from '../../core/agent-status-mirror'
import { IPC } from '../../shared/ipc'

/** Register the Phase-3a handler surface (fs + git + commit) on the server platform.
 *  git.setActiveRemote is a local-only no-op here: it exists to arm SSH-project remote
 *  routing on desktop, which the server edition does not have (terminals are local). */
export function registerCoreHandlers(
  platform: ServerPlatform,
  deps: {
    getSettings: () => Settings
    /** Lets the wallpaper cache prune what a changed choice left behind. */
    onSettingsChange?: (cb: (s: Settings) => void) => unknown
    downloadTickets?: DownloadTickets
    /** See fs-handlers' dep of the same name — the canvas-image write directory. */
    localProjectCwd?: (projectId: string) => string | undefined
  }
): { gitService: GitService } {
  // Explorer downloads: mint a one-shot ticket over this (authenticated) channel; the transfer
  // itself is a plain HTTP GET the browser performs (src/server/download.ts). Statting here keeps
  // the URL honest about the name — a folder arrives as `<name>.tar.gz`.
  const { downloadTickets } = deps
  registerFsHandlers(platform, {
    issueDownloadTicket: downloadTickets
      ? async (p: string): Promise<DownloadTicket | null> => {
          let dir = false
          try {
            dir = (await stat(p)).isDirectory()
          } catch {
            return null
          }
          const token = downloadTickets.issue(p, dir)
          return { url: `${DOWNLOAD_PATH}?t=${encodeURIComponent(token)}`, name: downloadName(p, dir) }
        }
      : undefined,
    localProjectCwd: deps.localProjectCwd
  })

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
  // Invariant 11 for probes: registered in BOTH shells, or session-id minting silently works on
  // the desktop and not in the browser, with nothing to say which.
  registerGrokCliIpc()
  // The codex CLI's own approval vocabulary, and this one is registered FOR REAL rather than
  // stubbed. `registerCodexIdentityIpc` below declines a shared app-server on purpose; this is the
  // opposite case, and the distinction matters — the Server Edition's Codex sessions run on THIS
  // machine, on THIS `codex`, so the browser must be told what that binary accepts. A constant
  // here would silently drop "Ask each time" for a Server Edition user on codex <= 0.148.0 and
  // hand a later codex a value it removed: exactly the "a stub compiles fine while doing nothing"
  // failure the three-surfaces rule warns about.
  registerCodexCliIpc()
  registerWallpaperIpc({
    get: deps.getSettings,
    onChange: (cb) => deps.onSettingsChange?.(cb)
  })
  // The run node's host side: core, so the browser's run nodes run on this server.
  registerRunConfigIpc()
  void claudeCliCaps()

  // The answer is populated after server node identity is armed. Early browser callers wait for
  // that refresh instead of being pinned to a false "plain Codex" answer for the whole app run.
  registerCodexIdentityIpc()

  // Managed CLAUDE accounts (issue #313). The lifecycle is core, so a browser-only deployment can
  // create, log into and remove them exactly as the desktop does — env injection, the transcript
  // readers, usage and the account pickers were already core and had nothing to bind to here.
  // No `installSkill`: canvas control is not wired on this edition (its hook server answers
  // `control unavailable` by name), so a per-account skill file would point at nothing.
  // No `remote`: the Server Edition has no SSH-project manager, so an `AccountCtx` carrying a
  // projectId takes the LOCAL path — the same degrade desktop takes before its manager exists.
  registerClaudeAccountsIpc()

  // Claude subscription usage. Previously desktop-only — the browser bridge answered `null`, so
  // the pill never rendered in the Server Edition. The poll runs UNGATED here (the default), not
  // browser-gated: the phone reads this host's agent-status mirror over plain SSH with no browser
  // attached, so "no client connected" does NOT mean "nobody is looking" — a connected-clients
  // gate starved the mirror's `usage` block empty forever on a headless host (the field bug that
  // shipped v1). The 15-min cadence is 4 requests/hour — well inside the endpoint's budget.
  // Feeds the agent-status mirror's per-account `usage` block for the phone (mobile-usage-inbox):
  // poll all local managed accounts, and re-flush the mirror on every cache update.
  const localClaudeAccountIds = (): string[] =>
    (deps.getSettings().claudeAccounts ?? []).filter((a) => !a.host && !a.pending).map((a) => a.id)
  // Local managed Codex accounts + their isolated homes, for the per-account usage fan-out
  // (S6 §4.3). Managed Codex accounts run on the headless host too, so the Server Edition serves
  // them the same way desktop does — a src/core change ships on both shells by construction.
  const localCodexAccounts = (): Array<{
    id: string
    home: string
    label: string
    email?: string | null
  }> =>
    codexUsageAccounts(
      (deps.getSettings().codexAccounts ?? []).filter((a) => !a.host && !a.pending),
      codexHomeFor
    )
  const usageService = startUsageService({
    localAccounts: localClaudeAccountIds,
    codexAccounts: localCodexAccounts,
    onCacheUpdate: () => {
      void flushAgentStatusMirror()
    }
  })
  // The provider is consulted fresh at every flush, pairing the usage service's cache with the
  // settings account labels. Dropped from SSH slices by filterMirrorForNodes (no SSH server-side
  // anyway). Wired here (not index.ts) since the usage service is created here.
  setMirrorUsageProvider(() =>
    buildMirrorUsage(usageService.snapshot(), deps.getSettings().claudeAccounts ?? [], Date.now())
  )

  return { gitService }
}
