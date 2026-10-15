// The host-owned agent launch behind the phone's relay `pty.attach { launch }`.
//
// The phone used to cold-restore an agent session by TYPING a shell line into the fresh pane after
// `pty.attach` answered `fresh: true` — `cd '<cwd>' 2>/dev/null; <cmd>`, and for a managed account
// `env -u … CLAUDE_CONFIG_DIR=… claude --resume …`. That is POSIX syntax. On a Windows host the
// fresh pane is pwsh / Windows PowerShell / cmd (the session host's shell resolution), where
// `2>/dev/null`, `env -u` and `VAR=x cmd` are errors and cmd does not even understand `'` or `;`:
// the agent failed to start, or started under the wrong account in the wrong folder.
//
// So the phone now sends WHAT it wants (agent, session id, mode, cwd, account) and the host decides
// HOW. Three rules this module exists to hold:
//   - Everything the phone sends is re-validated here (agent id against this machine's registry,
//     session id against SAFE_SESSION_ID, mode against the permission-mode table, account against
//     this machine's account lists). A field that fails is dropped or refuses the whole launch;
//     nothing is ever interpolated unchecked.
//   - cwd and account are NOT typed: they ride the spawn options (`prepareRelayAttach`), where the
//     one env builder (`buildPtyEnv`) sets CLAUDE_CONFIG_DIR and strips AUTH_ENV_STRIP on every
//     backend — so no `cd` and no `env -u` is ever needed.
//   - The command is built by the builders the desktop already uses: on a POSIX pane exactly the
//     line the renderer's cold restore types (`assembleResumeCommand`), on a Windows pane the
//     trusted Windows planner (`prepareAgentLaunch`) when the host has wired its executable
//     resolver. Until then the POSIX-assembled line is used on Windows ONLY when it is
//     dialect-neutral (plain words, which pwsh, Windows PowerShell and cmd all parse identically);
//     anything else is no launch at all, never a guess.
//
// Pure: no tmux, no pty, no settings store. `PtyManager` supplies the pane facts and the context.

import type { CustomAgent } from '../shared/types'
import {
  AGENT_CONFIG,
  canResume,
  capabilityAgentId,
  gatePermissionMode,
  hasPermissionMode,
  isPermissionMode,
  type AgentId,
  type AgentPermissionMode
} from '../shared/agents/config'
import { assembleResumeCommand } from '../shared/agents/launch'
import { SAFE_SESSION_ID } from '../shared/session-id'
import { isSafeAccountId } from '../shared/codex-account'
import {
  prepareAgentLaunch,
  type AgentLaunchDialect,
  type AgentLaunchExecutableKindResolver,
  type PreparedAgentLaunch
} from './agent-launch'
import { windowsLaunchDialectForShell } from './launch-intent-execute'

/** What a phone may ask the host to launch in a session the attach just CREATED. */
export interface RelayLaunchRequest {
  agentId: AgentId
  /** Resume this provider session (SAFE_SESSION_ID); absent = a fresh launch with no prompt. */
  sessionId?: string
  /** Where an UNRECORDED node's session starts. Jailed by the caller (host-service's roots). */
  cwd?: string
  /** Managed account an UNRECORDED node runs under; dropped unless this machine knows it. */
  accountId?: string
  permissionMode?: AgentPermissionMode
}

/** Host-authoritative facts the launch is built from. Never populated from anything the phone sends. */
export interface RelayLaunchContext {
  customAgents: readonly CustomAgent[]
  /** Can THIS host's claude take `--permission-mode auto`? (The claude-only version gate.) */
  claudeAutoSupported: boolean
  codexApprovalValues?: readonly string[] | null
  codexNoDaemon?: boolean | null
  /** Is `accountId` a usable LOCAL managed account on this machine FOR THIS AGENT'S PROVIDER? A
   *  claude agent takes only a claude account and a codex agent only a codex one: the two lists
   *  share an id alphabet, and a cross-provider pair would scope the session to the wrong CLI's
   *  home (or be refused at spawn). */
  isKnownAccount(accountId: string, agentId: AgentId): boolean
  /** `${env:…}` expansion for a custom agent's launchCmd/args (the host process env). */
  env: Record<string, string | undefined>
  /** The trusted Windows planner's executable resolver, once the host wires one. Absent ⇒ the
   *  dialect-neutral fallback below is the only Windows launch. */
  resolveExecutableKind?: AgentLaunchExecutableKindResolver
  windowsPowerShellPath?: string
}

/** Typed into the pane (`sendText`), or executed through the session host's exactly-once ledger. */
export type RelayLaunchPlan =
  | { kind: 'type'; command: string }
  | { kind: 'execute'; plan: PreparedAgentLaunch }

const MAX_FIELD = 4096
// eslint-disable-next-line no-control-regex -- refusing control chars is the point
const CONTROL = /[\x00-\x1f\x7f-\x9f\u2028\u2029]/

function cleanString(v: unknown, max = MAX_FIELD): string | undefined {
  return typeof v === 'string' && v.length > 0 && v.length <= max && !CONTROL.test(v) ? v : undefined
}

/**
 * Shape-check the wire's `launch` object. `null` = no launch: not an object, no usable agent id,
 * or a session id that is present but malformed (a forged id must not silently become a FRESH
 * session either — the phone asked to resume something specific). A malformed mode is dropped
 * (= no flag, the bare safe command); a malformed cwd/account is dropped (= the record / system
 * default). Registry membership is checked later, against the context.
 */
export function parseRelayLaunch(raw: unknown): RelayLaunchRequest | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  const agentId = cleanString(r.agentId, 128)
  if (!agentId) return null
  const out: RelayLaunchRequest = { agentId }
  if (r.sessionId !== undefined && r.sessionId !== null && r.sessionId !== '') {
    if (typeof r.sessionId !== 'string' || !SAFE_SESSION_ID.test(r.sessionId)) return null
    out.sessionId = r.sessionId
  }
  const cwd = cleanString(r.cwd)
  if (cwd) out.cwd = cwd
  const accountId = cleanString(r.accountId, 128)
  if (accountId && isSafeAccountId(accountId)) out.accountId = accountId
  if (isPermissionMode(r.permissionMode)) out.permissionMode = r.permissionMode
  return out
}

/** Is this agent id one THIS machine can launch (a builtin, or one of its own custom agents)? */
export function relayLaunchAgentKnown(agentId: AgentId, ctx: Pick<RelayLaunchContext, 'customAgents'>): boolean {
  return Object.hasOwn(AGENT_CONFIG, agentId) || ctx.customAgents.some((a) => a.id === agentId)
}

/** The parser the pane's foreground program speaks, from its command name (`paneCommand`). */
export function relayLaunchDialect(paneCommand: string | null | undefined): AgentLaunchDialect {
  // One shell-name → dialect rule (launch-intent-execute.ts); the pane command is already a
  // Windows-side fact here, so the platform gate is satisfied by construction.
  return windowsLaunchDialectForShell(paneCommand ?? undefined, 'win32') ?? 'posix'
}

/**
 * A line every shell we spawn parses the SAME way: words of `[A-Za-z0-9._:/=@+-]`, single spaces.
 * No quote, `;`, `&`, `|`, `<`, `>`, `$`, backtick, `%`, `^`, `!`, parenthesis or `~` — each of
 * which means something different (or nothing) in POSIX sh, pwsh and cmd. `claude --resume <id>
 * --permission-mode auto` qualifies; a custom agent whose args were single-quoted does not.
 */
export function isDialectNeutralCommand(command: string): boolean {
  return /^[A-Za-z0-9._:/=@+-]+( [A-Za-z0-9._:/=@+-]+)*$/.test(command) && !/^-/.test(command)
}

/**
 * Can a launch line be built for this request BEFORE the pane exists? Run before the attach replies
 * `launched: true` (= "phone, type nothing"), so every DETERMINISTIC no-launch — an `${env:…}` that
 * expands to nothing, a custom agent whose line is not dialect-neutral on a Windows pane with no
 * trusted planner — answers `launched: false` and the phone keeps its own path, instead of a reply
 * that promises a launch nobody will ever deliver. `windowsPane` = the pane will be pwsh / Windows
 * PowerShell / cmd (all three take the same neutral-line rule, so one probe answers for them).
 */
export async function relayLaunchPreflight(
  req: RelayLaunchRequest,
  ctx: RelayLaunchContext,
  windowsPane: boolean
): Promise<boolean> {
  if (windowsPane && ctx.resolveExecutableKind) return relayLaunchAgentKnown(req.agentId, ctx)
  return (await buildRelayLaunch(req, windowsPane ? 'pwsh' : 'posix', ctx).catch(() => null)) !== null
}

/** The mode the launch carries: claude's own version gate, and nothing for an agent with no modes. */
function effectiveMode(req: RelayLaunchRequest, ctx: RelayLaunchContext): AgentPermissionMode | undefined {
  const mode = req.permissionMode
  if (!mode || !hasPermissionMode(capabilityAgentId(req.agentId))) return undefined
  // The gate is CLAUDE's alone (CLAUDE.md "Version gate"): it is fed by a `claude --version` probe.
  return req.agentId === 'claude' ? gatePermissionMode(mode, ctx.claudeAutoSupported) : mode
}

/**
 * Build the launch for a pane whose parser is `dialect`. `null` = no launch (unknown agent, an env
 * reference that would type a mangled line, or a Windows pane with no trusted way to say it).
 */
export async function buildRelayLaunch(
  req: RelayLaunchRequest,
  dialect: AgentLaunchDialect,
  ctx: RelayLaunchContext
): Promise<RelayLaunchPlan | null> {
  if (!relayLaunchAgentKnown(req.agentId, ctx)) return null
  const customAgent = ctx.customAgents.find((a) => a.id === req.agentId)
  const mode = effectiveMode(req, ctx)

  if (dialect !== 'posix' && ctx.resolveExecutableKind) {
    // Resume needs a builtin grammar in the trusted planner; a custom agent starts fresh.
    const builtin = Object.hasOwn(AGENT_CONFIG, req.agentId)
    const resume = !!req.sessionId && builtin && canResume(req.agentId)
    try {
      const plan = await prepareAgentLaunch(
        resume
          ? { kind: 'agent', action: 'resume', agentId: req.agentId, sessionId: req.sessionId as string, ...(mode ? { permissionMode: mode } : {}) }
          : { kind: 'agent', action: 'start', agentId: req.agentId, ...(mode ? { permissionMode: mode } : {}) },
        dialect,
        {
          expectedAgentId: req.agentId,
          ...(customAgent
            ? {
                customAgent: {
                  id: customAgent.id,
                  launchCmd: customAgent.launchCmd,
                  promptInjectionMode: customAgent.promptInjectionMode ?? 'argv'
                }
              }
            : {}),
          sharedIdentityAvailable: false,
          resolveExecutableKind: ctx.resolveExecutableKind,
          windowsPowerShellPath: ctx.windowsPowerShellPath,
          codexApprovalValues: ctx.codexApprovalValues,
          codexNoDaemon: ctx.codexNoDaemon
        }
      )
      return { kind: 'execute', plan }
    } catch {
      return null
    }
  }

  // The renderer's cold-restore line, byte for byte (bare program: no shared-identity launcher and
  // no launch-command override — the phone's own typed line never had either).
  const { command, missingEnv } = assembleResumeCommand(
    {
      agentId: req.agentId,
      customAgent,
      sessionId: req.sessionId,
      permissionMode: mode,
      approvalCaps: { codexApprovalValues: ctx.codexApprovalValues, codexNoDaemon: ctx.codexNoDaemon }
    },
    ctx.env
  )
  // Never type a knowingly mangled line (an unset ${env:…} expanded to nothing).
  if (missingEnv.length || !command.trim()) return null
  if (dialect === 'posix') return { kind: 'type', command }
  return isDialectNeutralCommand(command) ? { kind: 'type', command } : null
}
