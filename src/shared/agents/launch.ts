// Pure command assembly — the ONE place an agent's launch / resume command line is built.
//
// Used by the renderer for fresh node creation, cold restore, wake, variant resume and Settings
// preview, and by Server Edition's headless node factory for fresh launches. Pure: the environment
// is an explicit parameter. Renderer callers pass the SAME boot-time snapshot
// (`src/renderer/lib/agentEnv.ts`), so its preview cannot drift from its launch by construction;
// the server passes its own process environment directly and exposes no preview endpoint. There is
// deliberately no main/server preview IPC: expanding ${env:…} for a caller-supplied agent record
// would be an environment-variable oracle for relay peers (the #171/#190 review).
//
// Inheritance: a custom agent with a `baseAgent` resolves its prompt convention, separator, and
// capability flags through that base harness (`capabilityAgentId`), so a claude-compatible proxy
// gets `--permission-mode` / `--session-id` / `--resume` exactly as claude does — while its own
// `launchCmd`, `args`, and `env` override the binary and the surroundings.

import type { CustomAgent } from '../types'
import { shellQuoteIfNeeded, shellSingleQuote, shellSplit } from '../shell-quote'
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
import { withAgentModel } from './model-gateway'

export interface LaunchInputs {
  agentId: AgentId
  /** The matching `CustomAgent` record when `agentId` is a custom id. `undefined` for builtins. */
  customAgent?: CustomAgent
  /** Per-builtin launch-command override (Settings → Agents → Launch commands). When set it
   *  replaces the resolved program outright — a wrapper the user runs the CLI through. Undefined
   *  for a builtin with no override and for custom agents (their `launchCmd` already IS the value).
   *  Trusted verbatim, exactly like a custom agent's `launchCmd`: it is the local user's own
   *  settings and is typed into their own pane. */
  launchCmdOverride?: string
  /** First-launch prompt. Empty/undefined = start the agent with no prompt. Collapsed to ONE
   *  line (every whitespace run → a single space): the prompt rides argv on a command line typed
   *  into the pane, and a newline would submit the half-typed line. Multi-line briefs go through
   *  `promptFile` instead. */
  initialPrompt?: string
  /** Absolute path to a file holding the first-launch prompt (canvas-control `--prompt-file`).
   *  Wins over `initialPrompt`. Composed as `"$(cat '<path>')"` so the TYPED line stays one line
   *  while the pane's shell expands the file — newlines and all — into a single argv element at
   *  execution. Requires a POSIX-style shell in the new node; validate with
   *  `promptFilePathError` before passing. */
  promptFile?: string
  /** Permission mode to start in. `undefined` = no flag (the agent's own default). */
  permissionMode?: AgentPermissionMode
  /** Per-node model override, applied through the effective base harness. */
  model?: string
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
  /** Per-builtin launch-command override — same meaning as `LaunchInputs.launchCmdOverride`, so a
   *  cold-restore / restart resumes through the same wrapper the fresh launch used. */
  launchCmdOverride?: string
  /** The provider session id to resume (live hook id, or the minted id persisted on the node). */
  sessionId?: string
  permissionMode?: AgentPermissionMode
  /** Per-node model override, applied through the effective base harness. */
  model?: string
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

/** Shell-split + expand + re-quote a custom agent's `args` into a safe argv fragment. The split
 *  runs FIRST, so token boundaries are fixed before any environment value enters the string;
 *  `${env:…}` then expands per token and each token is single-quoted — a resolved value carrying
 *  spaces or metacharacters stays ONE argument, and a stray `;`/`$`/backtick in an env value can
 *  never reach the shell as syntax or smuggle an extra flag. A token whose env references all
 *  expand to nothing vanishes (matching what an unquoted `$VAR` does at a real shell); the names
 *  are still reported in `missing`. Returns '' when there are no args. */
function expandedArgs(raw: string, env: Record<string, string | undefined>): { fragment: string; missing: string[] } {
  if (!raw?.trim()) return { fragment: '', missing: [] }
  const missing: string[] = []
  const tokens: string[] = []
  for (const token of shellSplit(raw)) {
    const r = expandEnvVars(token, env)
    missing.push(...r.missing)
    if (r.value === '' && token !== '') continue
    tokens.push(shellSingleQuote(r.value))
  }
  return { fragment: tokens.join(' '), missing }
}

/** Expand `${env:…}` in a custom `launchCmd`. A launchCmd with no env tokens — every builtin, and
 *  almost every custom agent — is returned byte-for-byte, raw shell text included, exactly as it
 *  always was. When a token DOES reference the environment, the whole command is re-tokenized and
 *  each token re-quoted unless shell-inert: the program position is typed unquoted into the pane,
 *  so an env value expanding to `x; rm -rf ~` must land as literal text, never as syntax. This is
 *  the local-shell-injection hole from the #171/#190 review, closed by construction instead of by
 *  trusting whoever set the variable. */
function expandedProgram(
  raw: string,
  env: Record<string, string | undefined>
): { value: string; missing: string[] } {
  if (!raw.includes('${env:')) return { value: raw, missing: [] }
  const missing: string[] = []
  const tokens: string[] = []
  for (const token of shellSplit(raw)) {
    const r = expandEnvVars(token, env)
    missing.push(...r.missing)
    if (r.value === '' && token !== '') continue
    tokens.push(shellQuoteIfNeeded(r.value))
  }
  return { value: tokens.join(' '), missing }
}

/**
 * Validate a `--prompt-file` path BEFORE it is composed into the launch line. Returns a short
 * error fragment, or null when the path is usable. The rules exist because the path is
 * interpolated into a command that is typed into the pane as ONE line: a newline in the path
 * would break the single-line delivery the whole mechanism exists to preserve, and a relative
 * path is ambiguous between the calling agent's cwd and the new node's cwd — requiring an
 * absolute path removes the guess. (Quoting itself is `shellSingleQuote`'s job — a space or a
 * quote in the path is fine.)
 */
export function promptFilePathError(p: string): string | null {
  const t = p.trim()
  if (!t) return 'needs a path'
  // eslint-disable-next-line no-control-regex
  if (/[\r\n\x00]/.test(t)) return 'must not contain newlines or control characters'
  if (!(t.startsWith('/') || /^[A-Za-z]:[\\/]/.test(t))) {
    return `must be an absolute path (got "${t}")`
  }
  return null
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

  // A per-builtin launch-command override replaces the resolved program (a wrapper the user runs
  // the CLI through). It is expanded + quoted like any launchCmd, and — like a custom agent's own
  // launchCmd — is NOT routed through the shared-identity launcher: an explicit override is the
  // user saying "launch it exactly like this".
  const overrideCmd = inputs.launchCmdOverride?.trim()
  const { value: launchCmd, missing: m1 } = expandedProgram(overrideCmd || eff.launchCmd, env)
  // Route a SHARED_IDENTITY_CAPABLE builtin (codex) through its managed launcher when this machine
  // has one, so the pane re-claims its own thread. Custom agents are not in that list, so a custom
  // launchCmd is returned unchanged. Applied to the already-expanded launchCmd (the launcher is a
  // bare program name, never an ${env:…} token). Skipped when an override is set.
  const program = overrideCmd
    ? launchCmd
    : agentLaunchProgram(inputs.agentId, launchCmd, inputs.sharedIdentity)
  const { fragment: argsFragment, missing: m2 } = expandedArgs(inputs.customAgent?.args ?? '', env)
  const harnessArgs = inputs.initialPrompt || inputs.promptFile
    ? eff.promptLaunchArgs ?? eff.launchArgs ?? []
    : eff.launchArgs ?? []
  const harnessFragment = harnessArgs.map(shellQuoteIfNeeded).join(' ')
  const baseCmd = [program, harnessFragment, argsFragment].filter(Boolean).join(' ')

  // The prompt becomes an ARGUMENT on a command line that is then typed into the pane
  // (`writeWhenShellReady` → `deliverCommand`, which echo-verifies the line before submitting).
  // A raw newline inside it would submit the half-typed line and fail that verification, so:
  // - `initialPrompt` (a literal) has every whitespace run collapsed to a single space —
  //   load-bearing for the delivery path, not tidying (PR #516's finding). Callers that let a
  //   user or an agent supply the prompt must say the text arrives on one line — see
  //   `buildCanvasSkillBody` / `buildCanvasControlInstructions`.
  // - `promptFile` (issue #520) keeps structure WITHOUT putting it on the typed line: the
  //   argument is a `"$(cat '<path>')"` command substitution, so the pane's shell reads the file
  //   at execution and hands the CLI its exact contents as ONE argv element. The double quotes
  //   make the substitution a single word and keep its RESULT data — file content is never
  //   re-parsed as shell syntax. On an SSH project the path (and the `cat`) are on the host,
  //   which is exactly where the node runs. Only the PATH is interpolated, single-quoted.
  const promptArg = inputs.promptFile
    ? `"$(cat ${shellSingleQuote(inputs.promptFile.trim())})"`
    : inputs.initialPrompt
      ? shellSingleQuote(inputs.initialPrompt.replace(/\s+/g, ' ').trim())
      : null
  const sep = eff.argvPromptSeparator
  const promptFlag =
    eff.promptInjectionMode === 'flag-prompt'
      ? eff.promptFlag ?? '--prompt'
      : eff.promptInjectionMode === 'flag-interactive'
        ? eff.promptFlag ?? '--interactive'
        : null
  const isFlagPrompt = !!promptFlag
  const usesSep = !!promptArg && !!sep && !isFlagPrompt
  const withPrompt = promptArg
    ? isFlagPrompt
      ? `${baseCmd} ${promptFlag} ${promptArg}`
      : `${baseCmd} ${promptArg}`
    : baseCmd

  const flagged = (cmd: string): string => {
    const withMode = inputs.permissionMode
      ? withPermissionMode(cmd, capId, inputs.permissionMode)
      : cmd
    // Session-id minting: claude-base + CLI supports the flag. On resume this branch is never
    // taken (assembleResumeCommand does not pass sessionId).
    if (inputs.sessionId && mintsSessionId(capId) && inputs.sessionIdFlagSupported) {
      return withAgentModel(withSessionId(withMode, capId, inputs.sessionId), capId, inputs.model)
    }
    return withAgentModel(withMode, capId, inputs.model)
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

  // A per-builtin launch-command override wins over the program and the launcher (same rule as the
  // fresh-launch path), so a cold-restore / restart resumes through the same wrapper.
  const overrideCmd = inputs.launchCmdOverride?.trim()
  const { value: launchCmd, missing: m1 } = expandedProgram(overrideCmd || eff.launchCmd, env)
  // Same launcher routing as the fresh-launch path: a SHARED_IDENTITY_CAPABLE builtin (codex) names
  // its managed launcher so the resumed session re-claims its own thread. Skipped for an override.
  const program = overrideCmd
    ? launchCmd
    : agentLaunchProgram(inputs.agentId, launchCmd, inputs.sharedIdentity)
  const { fragment: argsFragment, missing: m2 } = expandedArgs(inputs.customAgent?.args ?? '', env)
  const baseCmd = argsFragment ? `${program} ${argsFragment}` : program

  const resumeBase = inputs.sessionId ? resumeCommandWith(baseCmd, capId, inputs.sessionId) : null
  const base = resumeBase ?? baseCmd
  const withMode = inputs.permissionMode
    ? withPermissionMode(base, capId, inputs.permissionMode)
    : base
  const command = withAgentModel(withMode, capId, inputs.model)
  return { command, missingEnv: [...m1, ...m2] }
}
