// GitHub Copilot CLI status-hook installer. Copilot discovers and merges every JSON file under
// `$COPILOT_HOME/hooks/` (default `~/.copilot/hooks`), so nodeterm owns one file outright. Its JSON
// grammar is intentionally adapted here rather than pushed into the Claude/Gemini merge helper:
// Copilot entries are `{ type, bash, timeoutSec }` directly under each event, while those agents
// nest `{ type, command }` below a matcher-bearing hook definition.
import fs from 'fs'
import os from 'os'
import path from 'path'
import { COPILOT_HOOK_EVENTS } from '@shared/agents/hook-events'
import {
  buildManagedHookCommand, managedHookScriptPath,
  installManagedHookScript
} from './install-helper'

const SCRIPT_FILE_NAME = 'copilot.sh'
export const COPILOT_HOOK_FILE = 'nodeterm-status.json'

type CopilotEnv = { COPILOT_HOME?: string }
const REMOTE_HOME_MAX = 4096

export interface CopilotHookCommand {
  type: 'command'
  bash: string
  timeoutSec: number
  matcher?: string
}

export interface CopilotHookConfig {
  version: 1
  hooks: Record<string, CopilotHookCommand[]>
}

export function copilotHomeDir(
  env: CopilotEnv = process.env as CopilotEnv,
  home: string = os.homedir()
): string {
  return env.COPILOT_HOME?.trim() || path.join(home, '.copilot')
}

/** Validate a host-reported COPILOT_HOME before it is interpolated into an SSH command. */
export function isSafeRemoteCopilotHome(value: string | undefined): boolean {
  const v = value?.trim()
  if (
    !v ||
    v !== value ||
    !v.startsWith('/') ||
    v.includes('\\') ||
    v.length > REMOTE_HOME_MAX
  ) {
    return false
  }
  return !Array.from(v).some((ch) => {
    const code = ch.charCodeAt(0)
    return code <= 0x1f || code === 0x7f
  })
}

export function copilotHookConfigPath(): string {
  return path.join(copilotHomeDir(), 'hooks', COPILOT_HOOK_FILE)
}

/** Pure config builder shared with the SSH installer, which supplies a remote script path. */
export function buildCopilotHookConfig(command: string): CopilotHookConfig {
  const hooks: Record<string, CopilotHookCommand[]> = {}
  for (const event of COPILOT_HOOK_EVENTS) {
    hooks[event] = [
      {
        type: 'command',
        bash: command,
        timeoutSec: 5,
        // Copilot's notification matcher is a regex on notification_type. These are the only two
        // notifications that change nodeterm state; filtering at source avoids one process per
        // background-agent/shell informational notification.
        ...(event === 'Notification'
          ? { matcher: 'permission_prompt|elicitation_dialog' }
          : {})
      }
    ]
  }
  return { version: 1, hooks }
}

export function installCopilotHooks(): void {
  const script = installManagedHookScript('copilot', SCRIPT_FILE_NAME)
  if (!script) return
  const configPath = copilotHookConfigPath()
  try {
    fs.mkdirSync(path.dirname(configPath), { recursive: true })
    fs.writeFileSync(
      configPath,
      `${JSON.stringify(buildCopilotHookConfig(buildManagedHookCommand(script)), null, 2)}\n`,
      'utf8'
    )
  } catch (e) {
    console.warn('[agent-hooks] copilot install failed', e)
  }
}

export function removeCopilotHooks(): void {
  const configPath = copilotHookConfigPath()
  try {
    const before = fs.readFileSync(configPath, 'utf8')
    const config = JSON.parse(before)
    if (!config || typeof config !== 'object' || !config.hooks || typeof config.hooks !== 'object') return
    let changed = false
    for (const [event, defs] of Object.entries(config.hooks)) {
      if (!Array.isArray(defs)) continue
      const next = defs.filter((d) => {
        const ours = d?.bash === buildManagedHookCommand(managedHookScriptPath(SCRIPT_FILE_NAME))
        changed ||= ours
        return !ours
      })
      if (next.length) config.hooks[event] = next
      else delete config.hooks[event]
    }
    if (changed && fs.readFileSync(configPath, 'utf8') === before) {
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8')
    }
  } catch { /* malformed/unreadable/edited config belongs to the user */ }
}
