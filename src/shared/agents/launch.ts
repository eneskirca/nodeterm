// Pure command assembly — the ONE place an agent's launch / resume command line is built.
//
// Used by the renderer (fresh node creation in `workspace.ts createAgentNode`, cold-restore resume
// in `TerminalNode.tsx`) and by the main process (the preview IPC handler, so the settings card
// can show the exact command nodeterm will run). Pure: the environment is an explicit parameter
// (the renderer passes an IPC-fetched snapshot; main passes `process.env`), so the same function
// serves every caller and the preview can never drift from the real launch.
//
// Inheritance: a custom agent with a `baseAgent` resolves its prompt convention, separator, and
// capability flags through that base harness (`capabilityAgentId`), so a claude-compatible proxy
// gets `--permission-mode` / `--session-id` / `--resume` exactly as claude does — while its own
// `launchCmd`, `args`, and `env` override the binary and the surroundings.

import type { CustomAgent } from '../types'
import { shellSingleQuote, shellSplit } from '../shell-quote'
import { expandEnvVars } from './expansion'
import {
  agentLaunchProgram,
  capabilityAgentId,
  mintsSessionId,
  resumeCommandWith,
  withSessionId,
  type AgentId,
  type AgentPermissionMode
} from './config'
import { withPermissionMode } from './approval-mode'
import { resolveAgentConfig } from './custom-agent'

export interface LaunchInputs {
  agentId: AgentId
  /** The matching `CustomAgent` record when `agentId` is a custom id. `undefined` for builtins. */
  customAgent?: CustomAgent
  /** First-launch prompt. Empty/undefined = start the agent with no prompt. */
  initialPrompt?: string
  /** Permission mode to start in. `undefined` = no flag (the agent's own default). */
  permissionMode?: AgentPermissionMode
  /** A minted session id for FIRST launch (claude-base only, when the CLI supports `--session-id`).
   *  Ignored on resume. */
  sessionId?: string
  /** Whether the local claude CLI advertises `--session-id` (probe result). When false, no
   *  `--session-id` is emitted even for a claude-base agent — an unknown flag would kill the
   *  launch, so this fails open to the bare command. */
  sessionIdFlagSupported?: boolean
  /** Should a SHARED_IDENTITY_CAPABLE agent (codex) name its managed launcher instead of the bare
   *  CLI? The caller's answer to "will the launcher actually be there?" — false (the default) emits
   *  the bare command byte-for-byte. A remote node must pass false (the host has no launcher). */
  sharedIdentity?: boolean
}

export interface ResumeInputs {
  agentId: AgentId
  customAgent?: CustomAgent
  /** The provider session id to resume (live hook id, or the minted id persisted on the node). */
  sessionId?: string
  permissionMode?: AgentPermissionMode
  /** Should a SHARED_IDENTITY_CAPABLE agent (codex) name its managed launcher on resume? Same
   *  semantics as `LaunchInputs.sharedIdentity`. */
  sharedIdentity?: boolean
}

export interface AssembledCommand {
  /** The command string to type into the shell. */
  command: string
  /** Env vars referenced in `launchCmd`/`args` that were unset and had no fallback (expanded to
   *  empty). Surfaced for a spawn warning / a red `<unset>` in the preview. */
  missingEnv: string[]
}

/** Expand + shell-split + re-quote a custom agent's `args` into a safe argv fragment. Expansion
 *  (`${env:…}`) runs first; the shell-split then tokenizes; each token is single-quoted so a
 *  resolved value carrying spaces or metacharacters stays one argument and a stray `;`/`$` in the
 *  raw text can never reach the shell as syntax. Returns '' when there are no args. */
function expandedArgs(raw: string, env: Record<string, string | undefined>): { fragment: string; missing: string[] } {
  if (!raw?.trim()) return { fragment: '', missing: [] }
  const { value, missing } = expandEnvVars(raw, env)
  const tokens = shellSplit(value).map(shellSingleQuote)
  return { fragment: tokens.join(' '), missing }
}

/**
 * Assemble the FIRST-LAUNCH command: `<launchCmd> <args> [sep] [prompt] [permission flag]
 * [session-id flag]`. The prompt and flags land per the resolved prompt convention (separator
 * agents put flags before `--`; positional agents put them last), exactly as the historical
 * per-builtin path did — byte-identical for a builtin with no custom args.
 */
export function assembleLaunchCommand(
  inputs: LaunchInputs,
  env: Record<string, string | undefined>
): AssembledCommand {
  const eff = resolveAgentConfig(inputs.agentId, inputs.customAgent)
  const capId = capabilityAgentId(inputs.agentId)

  const { value: launchCmd, missing: m1 } = expandEnvVars(eff.launchCmd, env)
  // Route a SHARED_IDENTITY_CAPABLE builtin (codex) through its managed launcher when this machine
  // has one, so the pane re-claims its own thread. Custom agents are not in that list, so a custom
  // launchCmd is returned unchanged. Applied to the already-expanded launchCmd (the launcher is a
  // bare program name, never an ${env:…} token).
  const program = agentLaunchProgram(inputs.agentId, launchCmd, inputs.sharedIdentity)
  const { fragment: argsFragment, missing: m2 } = expandedArgs(inputs.customAgent?.args ?? '', env)
  const baseCmd = argsFragment ? `${program} ${argsFragment}` : program

  const promptArg = inputs.initialPrompt
    ? shellSingleQuote(inputs.initialPrompt.replace(/\s+/g, ' ').trim())
    : null
  const sep = eff.argvPromptSeparator
  const isFlagPrompt = eff.promptInjectionMode === 'flag-prompt'
  const usesSep = !!promptArg && !!sep && !isFlagPrompt
  const withPrompt = promptArg
    ? isFlagPrompt
      ? `${baseCmd} --prompt ${promptArg}`
      : `${baseCmd} ${promptArg}`
    : baseCmd

  const flagged = (cmd: string): string => {
    const withMode = inputs.permissionMode
      ? withPermissionMode(cmd, capId, inputs.permissionMode)
      : cmd
    // Session-id minting: claude-base + CLI supports the flag. On resume this branch is never
    // taken (assembleResumeCommand does not pass sessionId).
    if (inputs.sessionId && mintsSessionId(capId) && inputs.sessionIdFlagSupported) {
      return withSessionId(withMode, capId, inputs.sessionId)
    }
    return withMode
  }

  const command = usesSep ? `${flagged(baseCmd)} ${sep} ${promptArg}` : flagged(withPrompt)
  return { command, missingEnv: [...m1, ...m2] }
}

/**
 * Assemble the RESUME command for a cold restore / in-place restart: `<launchCmd> <args>
 * --resume <sid>` (grammar per the base harness) when a session id is known, else a fresh launch
 * with no prompt and no minted id. The permission flag is applied in both cases. Returns the
 * fresh-launch command (no resume) for a non-resumable base, so a vanilla custom agent still
 * relaunches cleanly.
 */
export function assembleResumeCommand(
  inputs: ResumeInputs,
  env: Record<string, string | undefined>
): AssembledCommand {
  const eff = resolveAgentConfig(inputs.agentId, inputs.customAgent)
  const capId = capabilityAgentId(inputs.agentId)

  const { value: launchCmd, missing: m1 } = expandEnvVars(eff.launchCmd, env)
  // Same launcher routing as the fresh-launch path: a SHARED_IDENTITY_CAPABLE builtin (codex) names
  // its managed launcher so the resumed session re-claims its own thread.
  const program = agentLaunchProgram(inputs.agentId, launchCmd, inputs.sharedIdentity)
  const { fragment: argsFragment, missing: m2 } = expandedArgs(inputs.customAgent?.args ?? '', env)
  const baseCmd = argsFragment ? `${program} ${argsFragment}` : program

  const resumeBase = inputs.sessionId ? resumeCommandWith(baseCmd, capId, inputs.sessionId) : null
  const base = resumeBase ?? baseCmd
  const command = inputs.permissionMode
    ? withPermissionMode(base, capId, inputs.permissionMode)
    : base
  return { command, missingEnv: [...m1, ...m2] }
}
