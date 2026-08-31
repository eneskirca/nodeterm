// Installer registry: drives install/remove of the managed hook script across every
// built-in agent. Each call is wrapped in try/catch with a per-agent console.warn so one
// agent failing never blocks the others (fail open).
import { installClaudeHooks, ensureClaudeFullscreenTui, removeClaudeHooks } from './claude'
import { installCodexHooks, removeCodexHooks } from './codex'
import { installGeminiHooks, removeGeminiHooks } from './gemini'
import { installOpencodeHooks, removeOpencodeHooks } from './opencode'
import { installGrokHooks, removeGrokHooks } from './grok'
import { installCopilotHooks, removeCopilotHooks } from './copilot'
import { installDevinHooks, removeDevinHooks } from './devin'

type HookInstaller = readonly [string, () => void]

export const MANAGED_HOOK_INSTALLERS: readonly HookInstaller[] = [
  ['claude', installClaudeHooks],
  ['codex', installCodexHooks],
  ['gemini', installGeminiHooks],
  ['opencode', installOpencodeHooks],
  ['grok', installGrokHooks],
  ['copilot', installCopilotHooks],
  ['devin', installDevinHooks]
]

export const MANAGED_HOOK_REMOVERS: readonly HookInstaller[] = [
  ['claude', removeClaudeHooks],
  ['codex', removeCodexHooks],
  ['gemini', removeGeminiHooks],
  ['opencode', removeOpencodeHooks],
  ['grok', removeGrokHooks],
  ['copilot', removeCopilotHooks],
  ['devin', removeDevinHooks]
]

export function installManagedAgentHooks(): void {
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
