// The semantic twin of a prompt-bearing first launch (`data.launchIntent`, `HeldLaunchIntent`).
//
// `assembleLaunchCommand` builds POSIX source, which a Windows session-host pane running pwsh,
// Windows PowerShell or cmd.exe mis-parses the moment the prompt holds an apostrophe, a double
// quote or a cmd metacharacter (or a `$(cat …)` prompt file). The core can encode the same launch
// correctly for that pane's own parser (`pty:execute-launch`, core/launch-intent-execute.ts) — but
// only from a SEMANTIC request, never by re-parsing the typed line. This builds that request.
//
// It is built only where it is a faithful description of the legacy line. Anything the core
// planner does not model — a launch-command override, a per-node model, a custom agent (its own
// args / ${env:…} expansion / baseAgent inheritance), a remote node, a resume — yields NO intent,
// and such a node keeps its legacy line on every surface. A launch with no prompt yields none
// either: without a prompt the legacy line holds only bare flag words and validated ids, which
// every Windows shell already parses the same way.

import type { HeldLaunchIntent } from '../types'
import {
  AGENT_CONFIG,
  hasPermissionMode,
  mintsSessionId,
  type AgentId,
  type AgentPermissionMode
} from './config'

export interface HeldLaunchInputs {
  agentId: AgentId
  /** The exact legacy line this intent stands in for. */
  command: string
  launchCmdOverride?: string
  model?: string
  /** An SSH / relay node: its shell is on another machine, never a local session host. */
  remote: boolean
  /** The node RESUMES an existing conversation (no prompt by construction). */
  resume: boolean
  initialPrompt?: string
  promptFile?: string
  permissionMode?: AgentPermissionMode
  /** The id the factory minted AND put on the legacy line (`--session-id`). */
  mintedSessionId?: string
}

export function heldLaunchIntentFor(inputs: HeldLaunchInputs): HeldLaunchIntent | undefined {
  if (inputs.resume || inputs.remote) return undefined
  if (!Object.hasOwn(AGENT_CONFIG, inputs.agentId)) return undefined
  if (inputs.launchCmdOverride?.trim() || inputs.model) return undefined
  const promptFile = inputs.promptFile?.trim()
  // Collapsed exactly like the legacy line collapses it (`assembleLaunchCommand`).
  const prompt = promptFile ? undefined : inputs.initialPrompt?.replace(/\s+/g, ' ').trim()
  if (!promptFile && !prompt) return undefined
  return {
    command: inputs.command,
    intent: {
      kind: 'agent',
      action: 'start',
      agentId: inputs.agentId,
      ...(prompt ? { prompt } : {}),
      // The legacy line carries a mode flag only for an agent that has one; the core planner
      // refuses a mode for any other, so the two agree by construction.
      ...(inputs.permissionMode && hasPermissionMode(inputs.agentId)
        ? { permissionMode: inputs.permissionMode }
        : {}),
      ...(inputs.mintedSessionId && mintsSessionId(inputs.agentId)
        ? { newSessionId: inputs.mintedSessionId }
        : {})
    },
    ...(promptFile ? { promptFile } : {})
  }
}
