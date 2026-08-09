// Grok hook service. Grok's hook config is a DIRECTORY — it merges every `$GROK_HOME/hooks/*.json`
// — so unlike claude and gemini there is no shared settings file to merge into: nodeterm owns one
// file outright and rewrites it. We still route through the shared install helper, because that is
// where the missing-script guard, the idempotent re-install and the "sweep events we no longer
// subscribe to" repair live.
import path from 'path'
import { GROK_HOOK_EVENTS } from '@shared/agents/hook-events'
import { GROK_HOOK_FILE, grokHomeDir } from '../grok-paths'
import { installHooksInto, removeHooksFrom } from './install-helper'

const SCRIPT_FILE_NAME = 'grok.sh'

/** Our hook file inside grok's hooks directory. Exported for tests and for the SSH installer,
 *  which must write the identical name on the host. */
export function grokHookConfigPath(): string {
  return path.join(grokHomeDir(), 'hooks', GROK_HOOK_FILE)
}

export function installGrokHooks(): void {
  installHooksInto({
    agentId: 'grok',
    scriptFileName: SCRIPT_FILE_NAME,
    configPath: grokHookConfigPath(),
    events: GROK_HOOK_EVENTS
  })
}

export function removeGrokHooks(): void {
  removeHooksFrom({
    configPath: grokHookConfigPath(),
    events: GROK_HOOK_EVENTS,
    scriptFileName: SCRIPT_FILE_NAME
  })
}
