// Main/server IPC handlers for the custom-agent preview: env-var expansion and command assembly
// run here (against the real `process.env`) because the renderer has no `process.env` of its own.
// The preview is therefore guaranteed to match what `pty-manager` will actually type into the shell.

import { IPC } from '../shared/ipc'
import { platform } from './platform'
import { assembleLaunchCommand, type LaunchInputs } from '../shared/agents/launch'

/** A string-only snapshot of `process.env` (undefined entries omitted), for `${env:VAR}` expansion
 *  in the renderer's preview. */
function envSnapshot(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string') out[k] = v
  }
  return out
}

/** Register the env-snapshot + preview-command handlers. Call once at startup, beside the other
 *  `registerIpc()` calls (main: src/main/index.ts; server: src/server/index.ts). */
export function registerAgentEnvIpc(): void {
  platform().handle(IPC.envSnapshot, () => envSnapshot())
  platform().handle(IPC.agentPreviewCommand, (inputs: LaunchInputs) =>
    assembleLaunchCommand(inputs, envSnapshot())
  )
}
