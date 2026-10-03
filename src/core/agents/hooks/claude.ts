// Claude hook service. Installs the managed script into ~/.claude/settings.json under
// each Claude Code hook event. Thin wrapper over the shared install helper.
import { homedir } from 'os'
import path from 'path'
import { installHooksInto, removeHooksFrom } from './install-helper'
import { ensureFullscreenTuiInFile } from './claude-tui'
import { claudeCliCaps } from '../../claude-cli'
import { CLAUDE_HOOK_EVENTS } from '@shared/agents/hook-events'


const SCRIPT_FILE_NAME = 'claude.sh'

/** The SYSTEM Claude config dir: `$CLAUDE_CONFIG_DIR` when the app's environment sets it (a
 *  system node inherits that environment, so its claude reads hooks and skills from there), else
 *  `~/.claude`. Never hardcode `~/.claude` (issue #744). */
export function claudeSystemConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.CLAUDE_CONFIG_DIR?.trim()
  return fromEnv && path.isAbsolute(fromEnv) ? fromEnv : path.join(homedir(), '.claude')
}

function configPath(): string {
  return path.join(claudeSystemConfigDir(), 'settings.json')
}

export function installClaudeHooks(): void {
  installHooksInto({
    agentId: 'claude',
    scriptFileName: SCRIPT_FILE_NAME,
    configPath: configPath(),
    events: CLAUDE_HOOK_EVENTS
  })
}

/** Install the managed hook into a specific Claude config dir (managed accounts). */
export function installClaudeHooksInto(configDir: string): void {
  installHooksInto({
    agentId: 'claude',
    scriptFileName: SCRIPT_FILE_NAME,
    configPath: path.join(configDir, 'settings.json'),
    events: CLAUDE_HOOK_EVENTS
  })
}

/**
 * Ensure `"tui": "fullscreen"` in the SYSTEM `~/.claude/settings.json` — write-if-absent, and only
 * when the local CLI is >= 2.1.89 (see FULLSCREEN_TUI_MIN_VERSION / claudeCliCaps.fullscreenTui).
 * Best-effort: the probe is memoized + never rejects, the write fails open. Call it AFTER the hook
 * install so the merge lands on a settings.json that already has the managed hooks.
 */
export async function ensureClaudeFullscreenTui(): Promise<void> {
  if (!(await claudeCliCaps()).fullscreenTui) return
  ensureFullscreenTuiInFile(configPath())
}

/** Same guardrails, for a managed account's config dir (`<dir>/settings.json`). */
export async function ensureClaudeFullscreenTuiInto(configDir: string): Promise<void> {
  if (!(await claudeCliCaps()).fullscreenTui) return
  ensureFullscreenTuiInFile(path.join(configDir, 'settings.json'))
}

export function removeClaudeHooks(): void {
  removeHooksFrom({
    configPath: configPath(),
    events: CLAUDE_HOOK_EVENTS,
    scriptFileName: SCRIPT_FILE_NAME
  })
}

/** Remove the managed hook from a specific Claude config dir (managed/linked accounts, or the
 *  legacy `~/.claude` when `$CLAUDE_CONFIG_DIR` moved the system dir). */
export function removeClaudeHooksFrom(configDir: string): void {
  removeHooksFrom({
    configPath: path.join(configDir, 'settings.json'),
    events: CLAUDE_HOOK_EVENTS,
    scriptFileName: SCRIPT_FILE_NAME
  })
}
