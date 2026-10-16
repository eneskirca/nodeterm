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
  buildManagedHookCommand,
  installManagedHookScript,
  installWindowsHookWrapper,
  writeManagedHookFileAtomic
} from './install-helper'

const SCRIPT_FILE_NAME = 'copilot.sh'
export const COPILOT_HOOK_FILE = 'nodeterm-status.json'

type CopilotEnv = { COPILOT_HOME?: string }
const REMOTE_HOME_MAX = 4096

export interface CopilotHookCommand {
  type: 'command'
  bash: string
  /** What Copilot runs on Windows instead of `bash`. Present only in a Windows install. */
  powershell?: string
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

/**
 * Pure config builder shared with the SSH installer, which supplies a remote script path.
 *
 * `windowsCommand` adds Copilot's `powershell` key — the one it runs on Windows, where the `bash`
 * line is never consulted. `bash` stays in either case (Copilot requires a command for the
 * platform it runs on, and keeping the POSIX line means a config copied off a Windows box still
 * works elsewhere). The SSH installer passes none, so a host's file is byte-identical.
 */
export function buildCopilotHookConfig(command: string, windowsCommand?: string): CopilotHookConfig {
  const hooks: Record<string, CopilotHookCommand[]> = {}
  for (const event of COPILOT_HOOK_EVENTS) {
    hooks[event] = [
      {
        type: 'command',
        bash: command,
        ...(windowsCommand !== undefined ? { powershell: windowsCommand } : {}),
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

export function installCopilotHooks(platform: NodeJS.Platform | string = process.platform, cmdExe?: string): void {
  const script = installManagedHookScript('copilot', SCRIPT_FILE_NAME)
  if (!script) return
  // On Windows Copilot runs the `powershell` key, so its wrapper must exist before the config
  // names it (same order rule as installHooksInto).
  const windows = platform === 'win32'
  if (windows && !installWindowsHookWrapper('copilot', script)) return
  const configPath = copilotHookConfigPath()
  try {
    fs.mkdirSync(path.dirname(configPath), { recursive: true })
    const config = buildCopilotHookConfig(
      buildManagedHookCommand(script),
      windows ? buildManagedHookCommand(script, {}, 'win32', cmdExe) : undefined
    )
    // Our own file, published by rename so copilot never reads it half written.
    writeManagedHookFileAtomic(configPath, `${JSON.stringify(config, null, 2)}\n`)
  } catch (e) {
    console.warn('[agent-hooks] copilot install failed', e)
  }
}

export function removeCopilotHooks(): void {
  const configPath = copilotHookConfigPath()
  try {
    writeManagedHookFileAtomic(configPath, `${JSON.stringify({ version: 1, hooks: {} }, null, 2)}\n`)
  } catch {
    /* fail open */
  }
}
