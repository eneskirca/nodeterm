import path from 'path'
import { homedir } from 'os'
import { installHooksInto, removeHooksFrom } from './install-helper'
import { DEVIN_HOOK_EVENTS } from '@shared/agents/hook-events'

const SCRIPT_FILE_NAME = 'devin.sh'

/**
 * Devin's user-level config path. macOS/Linux use `~/.config/devin/config.json`; Windows uses
 * `%APPDATA%\devin\config.json` (Devin's docs explicitly list this). Project-level hooks live in
 * `.devin/hooks.v1.json` or `.devin/config.json`, but the user config is the right place for a
 * machine-wide nodeterm integration, matching where we install Claude/Gemini/Grok hooks.
 */
export function devinConfigDir(): string {
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(homedir(), 'AppData', 'Roaming'), 'devin')
  }
  return path.join(homedir(), '.config', 'devin')
}

export function devinConfigPath(): string {
  return path.join(devinConfigDir(), 'config.json')
}

export function installDevinHooks(): void {
  installHooksInto({
    agentId: 'devin',
    scriptFileName: SCRIPT_FILE_NAME,
    configPath: devinConfigPath(),
    events: DEVIN_HOOK_EVENTS
  })
}

export function removeDevinHooks(): void {
  removeHooksFrom({
    configPath: devinConfigPath(),
    events: DEVIN_HOOK_EVENTS,
    scriptFileName: SCRIPT_FILE_NAME
  })
}
