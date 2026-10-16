// Gemini hook service. Installs the managed script into ~/.gemini/settings.json under
// each Gemini hook event. Thin wrapper over the shared install helper.
import { homedir } from 'os'
import { GEMINI_HOOK_EVENTS } from '@shared/agents/hook-events'
import path from 'path'
import { installHooksInto, removeHooksFrom } from './install-helper'


const SCRIPT_FILE_NAME = 'gemini.sh'

function configPath(): string {
  return path.join(homedir(), '.gemini', 'settings.json')
}

export function installGeminiHooks(): void {
  installHooksInto({
    agentId: 'gemini',
    scriptFileName: SCRIPT_FILE_NAME,
    configPath: configPath(),
    events: GEMINI_HOOK_EVENTS,
    // Gemini runs a hook through PowerShell on Windows (`getShellConfiguration`: ComSpec when it is
    // powershell/pwsh, else pwsh.exe, else powershell.exe), which cannot parse the POSIX line.
    windowsWrapper: true
  })
}

export function removeGeminiHooks(): void {
  removeHooksFrom({
    configPath: configPath(),
    events: GEMINI_HOOK_EVENTS,
    scriptFileName: SCRIPT_FILE_NAME
  })
}
