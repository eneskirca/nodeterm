// Installer registry: drives install/remove of the managed hook script across every
// built-in agent. Each call is wrapped in try/catch with a per-agent console.warn so one
// agent failing never blocks the others (fail open).
import { installClaudeHooks, ensureClaudeFullscreenTui, removeClaudeHooks } from './claude'
import { installCodexHooks, removeCodexHooks } from './codex'
import { installGeminiHooks, removeGeminiHooks } from './gemini'
import { installOpencodeHooks, removeOpencodeHooks } from './opencode'
import { installGrokHooks, removeGrokHooks } from './grok'
import { ensureGrokHomeProbed, grokHomeDir, grokHomeFallbackWasSilent } from '../grok-paths'
import { installCopilotHooks, removeCopilotHooks } from './copilot'

type HookInstaller = readonly [string, () => void]

export const MANAGED_HOOK_INSTALLERS: readonly HookInstaller[] = [
  ['claude', installClaudeHooks],
  ['codex', installCodexHooks],
  ['gemini', installGeminiHooks],
  ['opencode', installOpencodeHooks],
  ['grok', installGrokHooks],
  ['copilot', installCopilotHooks]
]

export const MANAGED_HOOK_REMOVERS: readonly HookInstaller[] = [
  ['claude', removeClaudeHooks],
  ['codex', removeCodexHooks],
  ['gemini', removeGeminiHooks],
  ['opencode', removeOpencodeHooks],
  ['grok', removeGrokHooks],
  ['copilot', removeCopilotHooks]
]

export function installManagedAgentHooks(): void {
  // Ask the login shell where grok lives BEFORE writing its hook file, and re-write it if the answer
  // moves the target. A GUI app launched from Finder/Dock/`.desktop` never sourced the user's rc,
  // while the grok CLI — started by the shell inside a tmux pane — did; for a user whose only
  // `export GROK_HOME=…` lives there, we install into `~/.grok` and grok reads somewhere else. That
  // failure is TOTAL and SILENT: no badge, no unread dot, no notification, no session name, ever.
  //
  // Fire-and-forget and fail-open, exactly like the claude TUI call below: the first install still
  // happens synchronously against today's answer, so boot is never delayed and the pre-probe
  // behaviour is preserved. When the probe lands somewhere else, the second install puts the file
  // where grok will actually look — and when it lands nowhere, `grokHomeFallbackWasSilent` records
  // that we fell back without evidence, which is the diagnostic this bug never had.
  const grokHomeAtInstall = grokHomeDir()
  void ensureGrokHomeProbed().then(() => {
    // The diagnostic the flag exists for. Without this line `grokHomeFallbackWasSilent` promised an
    // explanation the user never saw, which is the very failure it was written to close.
    if (grokHomeFallbackWasSilent()) {
      console.warn(
        `[agent-hooks] grok: could not confirm $GROK_HOME (the login-shell probe returned nothing), ` +
          `so hooks were installed into the default ${grokHomeDir()}. If grok reads a different ` +
          `GROK_HOME, its nodes will show no status, no session name and no notifications, silently. ` +
          `Set GROK_HOME in the environment nodeterm itself is launched from to make this definite.`
      )
    }
    if (grokHomeDir() === grokHomeAtInstall) return
    try {
      installGrokHooks()
    } catch (e) {
      console.warn('[agent-hooks] grok re-install after $GROK_HOME probe failed', e)
    }
  })
  for (const [agent, install] of MANAGED_HOOK_INSTALLERS) {
    try {
      install()
    } catch (e) {
      console.warn(`[agent-hooks] ${agent} install failed`, e)
    }
  }
  // Ensure Claude's fullscreen TUI in the system `~/.claude/settings.json` (write-if-absent,
  // version-gated) right after its hooks land. Fire-and-forget (it awaits the memoized CLI probe)
  // and fail-open, so it never blocks boot — and runs on BOTH desktop and Server Edition, which
  // both call this at launch. Managed account dirs are ensured by their own install call sites.
  void ensureClaudeFullscreenTui()
}

export function removeManagedAgentHooks(): void {
  for (const [agent, remove] of MANAGED_HOOK_REMOVERS) {
    try {
      remove()
    } catch (e) {
      console.warn(`[agent-hooks] ${agent} remove failed`, e)
    }
  }
}
