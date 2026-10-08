import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import {
  AGENT_CONFIG, BUILTIN_AGENT_IDS, canSwitchModel, gatePermissionMode,
  resolvePermissionMode, supportsSessionIdFlag, type BuiltinAgentId
} from '../shared/agents/config'
import { agentAccountColor } from '../shared/agents/account-color'
import { assembleLaunchCommand } from '../shared/agents/launch'
import { isLaunchShell } from '../shared/agents/pane'
import { isSafeAccountId } from '../shared/codex-account'
import { safeSessionProgram } from '../shared/node-exec'
import { resolveProjectSettings } from '../shared/project-settings'
import { shellSplit } from '../shared/shell-quote'
import type { ClaudeCliCaps, CodexCliCaps, CodexIdentityCaps, GrokCliCaps, Settings } from '../shared/types'
import { accountConfigDir, normalizeLinkedConfigDir } from './claude-accounts-core'
import { codexAccountHome } from './codex-accounts-core'
import type { ManagedTerminalPlan, ManagedTerminalRequest } from './managed-terminals'
import type { ProjectTrustStore } from './project-trust-store'
import { projectFamilyTrusted, projectTrustKeyFor } from './project-trust-verdict'
import type { WorkspaceStore } from './workspace-store'

export interface ManagedTerminalPlannerDeps {
  store: Pick<WorkspaceStore, 'load' | 'projectTargetInfo' | 'readProjectSettings'>
  userData: string
  settings(): Settings
  trust: Pick<ProjectTrustStore, 'isTrusted'>
  executable(program: string): Promise<string | null>
  sessionShell(program: string | undefined, defaultShell: string): string
  claudeCaps(): Promise<ClaudeCliCaps>
  codexCaps(): Promise<CodexCliCaps>
  grokCaps(): Promise<GrokCliCaps>
  codexIdentity(): Promise<Pick<CodexIdentityCaps, 'shared' | 'launcherPath'>>
  env?: Record<string, string | undefined>
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const FIELDS = new Set(['creationId', 'projectId', 'kind', 'agentId', 'accountId', 'title', 'cols', 'rows'])
const CONTROL = /[\p{Cc}\u2028\u2029]/u
function refuse(message: string): never { throw new Error(message) }
function text(value: unknown, cap: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= cap && !CONTROL.test(value)
}
function validate(request: ManagedTerminalRequest, nodeId: string): void {
  if (!request || typeof request !== 'object' || Array.isArray(request) ||
      Object.keys(request).some((key) => !FIELDS.has(key)) || !UUID.test(request.creationId) ||
      !text(request.projectId, 200) || !/^[A-Za-z0-9._-]{1,256}$/.test(nodeId) ||
      !Number.isInteger(request.cols) || request.cols < 2 || request.cols > 500 ||
      !Number.isInteger(request.rows) || request.rows < 2 || request.rows > 500 ||
      (request.title !== undefined && !text(request.title, 120))) refuse('Invalid managed terminal request.')
  if (request.kind === 'shell') {
    if (request.agentId !== undefined || request.accountId !== undefined) refuse('A shell cannot select an agent account.')
  } else if (request.kind !== 'agent' || !BUILTIN_AGENT_IDS.includes(request.agentId as BuiltinAgentId)) {
    refuse('This agent is not supported for managed SSH creation.')
  }
  if (request.accountId !== undefined && !isSafeAccountId(request.accountId)) refuse('Invalid managed account.')
}

async function directoryIdentity(dir: string): Promise<{ real: string; dev: number; ino: number }> {
  if (!path.isAbsolute(dir) || CONTROL.test(dir)) refuse('The project folder is unavailable.')
  const real = await fs.realpath(dir)
  const stat = await fs.stat(real)
  if (!stat.isDirectory()) refuse('The project folder is unavailable.')
  return { real, dev: stat.dev, ino: stat.ino }
}

function providerSessionId(userData: string, request: ManagedTerminalRequest): string {
  const bytes = createHash('sha256').update('nodeterm-managed-session-v1\0' + userData + '\0' +
    request.projectId + '\0' + request.agentId + '\0' + request.creationId).digest().subarray(0, 16)
  bytes[6] = (bytes[6] & 15) | 64
  bytes[8] = (bytes[8] & 63) | 128
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** No executable material comes from the phone. The plan stays private to the host coordinator. */
export function createManagedTerminalPlanner(deps: ManagedTerminalPlannerDeps): {
  plan(request: ManagedTerminalRequest, nodeId: string): Promise<ManagedTerminalPlan>
  revalidate(request: ManagedTerminalRequest, plan: ManagedTerminalPlan): Promise<boolean>
} {
  const plan = async (request: ManagedTerminalRequest, nodeId: string): Promise<ManagedTerminalPlan> => {
    validate(request, nodeId)
    const workspace = await deps.store.load({ sideline: false })
    const matches = workspace.projects.filter((p) => p.id === request.projectId)
    if (matches.length !== 1) refuse('The project is unavailable or ambiguous.')
    const project = matches[0]
    const info = deps.store.projectTargetInfo(request.projectId)
    if (!info?.cwd || info.ssh || project.ssh || project.closed || !project.cwd ||
        (project as unknown as { drivenRemotely?: boolean }).drivenRemotely || info.cwd !== project.cwd) {
      refuse('Managed SSH creation requires an open local folder project.')
    }
    const folder = await directoryIdentity(info.cwd)
    const snapshot = await deps.store.readProjectSettings(request.projectId)
    if (snapshot?.conflict) refuse('Resolve the project settings conflict before creating a terminal.')
    const resolved = resolveProjectSettings(snapshot?.local, snapshot?.shared ?? undefined)
    const key = projectTrustKeyFor(info)
    const shared = snapshot?.shared ?? {}
    const trustedAgents = await projectFamilyTrusted(deps.trust, key, 'agents', shared)
    const trustedShell = await projectFamilyTrusted(deps.trust, key, 'shell', shared)
    const admitted = <T>(setting: { source: string; value: T } | undefined, trusted: boolean): T | undefined =>
      setting && (setting.source !== 'shared' || trusted) ? setting.value : undefined
    const effectiveEnv = admitted(resolved.agents.env, trustedAgents)
    const projectShell = admitted(resolved.terminal.shell, trustedShell)
    if (projectShell && !safeSessionProgram(projectShell)) refuse('The configured project shell is unsupported.')
    const settings = deps.settings()
    const shell = deps.sessionShell(projectShell, settings.defaultShell)
    if (!safeSessionProgram(shell) || !await deps.executable(shell)) refuse('The configured shell is unavailable.')
    const agentId = request.kind === 'agent' ? request.agentId as BuiltinAgentId : undefined
    if (agentId && !isLaunchShell(shell)) refuse('The configured shell cannot launch this agent safely.')
    let accountId: string | undefined
    let accountIdentity: unknown
    // V1 absence is an explicit System choice. The phone freezes any displayed project default
    // by sending its account id; consulting the mutable project default here would undo System.
    if (request.accountId !== undefined) {
      if (agentId !== 'claude' && agentId !== 'codex') refuse('This agent cannot use a managed account.')
      accountId = request.accountId
      if (!accountId || !isSafeAccountId(accountId)) refuse('The managed account is unavailable.')
      const accounts = agentId === 'claude' ? settings.claudeAccounts : settings.codexAccounts
      const rows = Array.isArray(accounts) ? accounts.filter((a) => a?.id === accountId) : []
      if (rows.length !== 1 || rows[0].host || rows[0].pending) refuse('The managed account is unavailable on this computer.')
      const row = rows[0]
      const linked = 'configDir' in row && row.configDir !== undefined
        ? normalizeLinkedConfigDir(row.configDir) : undefined
      if ('configDir' in row && row.configDir !== undefined && !linked) refuse('The linked account directory is unavailable.')
      const dir = linked || (agentId === 'claude'
        ? accountConfigDir(deps.userData, accountId) : codexAccountHome(deps.userData, accountId))
      accountIdentity = { row: { ...row }, directory: await directoryIdentity(dir) }
    }
    let command: string | undefined
    let sessionId: string | undefined
    let model: string | undefined
    let agentFacts: unknown
    if (agentId) {
      const cli = await deps.executable(AGENT_CONFIG[agentId].launchCmd)
      if (!cli) refuse('The selected agent CLI is unavailable on this computer.')
      // Only the project-declared agent consumes its paired launch override. Shared command
      // tokens never read this process environment; untrusted shared values use the global layer.
      const paired = resolved.agents.defaultAgentId?.value === agentId
      const projectCommand = paired ? admitted(resolved.agents.launchCmd, trustedAgents)?.trim() : undefined
      const override = projectCommand && !projectCommand.includes('${env:')
        ? projectCommand : settings.agentLaunchCommands?.[agentId]?.trim() || undefined
      if (override && (CONTROL.test(override) || override.length > 4096)) refuse('The agent launch override is unsupported.')
      const [claude, codex, grok, identity] = await Promise.all([
        agentId === 'claude' ? deps.claudeCaps() : null,
        agentId === 'codex' ? deps.codexCaps() : null,
        agentId === 'grok' ? deps.grokCaps() : null,
        agentId === 'codex' ? deps.codexIdentity() : null
      ])
      const sharedIdentity = identity?.shared === true
      if (sharedIdentity && (!identity?.launcherPath || !await deps.executable(identity.launcherPath))) {
        refuse('The shared Codex launcher is unavailable.')
      }
      const mode = resolvePermissionMode(project, settings)
      const permissionMode = agentId === 'claude' ? gatePermissionMode(mode, claude?.autoPermissionMode === true) : mode
      const sessionIdFlagSupported = supportsSessionIdFlag(agentId, claude?.sessionIdFlag === true, grok?.sessionIdFlag === true)
      sessionId = sessionIdFlagSupported ? providerSessionId(deps.userData, request) : undefined
      model = settings.agentLaunchMode === 'gateway-model' && canSwitchModel(agentId)
        ? settings.modelGatewayDefaultModel || undefined : undefined
      if (model && (!text(model, 1024))) refuse('The configured agent model is invalid.')
      const assembled = assembleLaunchCommand({ agentId, launchCmdOverride: override, permissionMode,
        sessionId, sessionIdFlagSupported, sharedIdentity,
        approvalCaps: { codexApprovalValues: codex?.approvalValues }, model }, deps.env ?? process.env)
      if (assembled.missingEnv.length || !assembled.command || CONTROL.test(assembled.command) ||
          Buffer.byteLength(assembled.command) > 30_000) refuse('The configured agent launch is unavailable.')
      command = assembled.command
      // A machine-local wrapper is still real executable input: validate its leading program
      // rather than silently accepting a missing wrapper and falling back to the bare CLI.
      const leading = shellSplit(command).find((word) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word))
      if (!leading || !(sharedIdentity && !override && leading === 'nodeterm-codex') && !await deps.executable(leading)) {
        refuse('The configured agent launcher is unavailable.')
      }
      agentFacts = { cli, claude, codex, grok, identity, override, permissionMode, model }
    }
    const node = {
      id: nodeId, kind: 'terminal' as const, cwd: info.cwd, shell,
      title: request.title ?? (agentId ? AGENT_CONFIG[agentId].label : 'Terminal'),
      color: agentId ? agentAccountColor(agentId, accountId, {
        claude: Array.isArray(settings.claudeAccounts) ? settings.claudeAccounts : [],
        codex: Array.isArray(settings.codexAccounts) ? settings.codexAccounts : []
      }) ?? AGENT_CONFIG[agentId].color : '#0a84ff',
      position: { x: 80 + (project.nodes.length % 4) * 40, y: 80 + (project.nodes.length % 4) * 40 },
      size: { width: 640, height: 440 }, group: null,
      ...(agentId ? { agentId, titleAuto: request.title === undefined } : {}),
      ...(accountId ? { accountId } : {}), ...(model ? { agentModel: model } : {}),
      ...(sessionId ? { agentSessionId: sessionId } : {})
    }
    const options = { persistKey: nodeId, ownerProjectId: request.projectId, cwd: info.cwd, shell,
      cols: request.cols, rows: request.rows, ...(agentId ? { agentId } : {}),
      ...(accountId ? { accountId } : {}), ...(model ? { agentModel: model } : {}) }
    const validation = createHash('sha256').update(JSON.stringify({ projectId: request.projectId,
      folder, options, command, accountIdentity, agentFacts, effectiveEnv, projectShell,
      launchMode: settings.agentLaunchMode, gateway: settings.modelGateway,
      trustedAgents, trustedShell })).digest('hex')
    return { node, options, command, validation }
  }
  return { plan, revalidate: async (request, previous) => {
    try { return !!previous.validation && (await plan(request, previous.node.id)).validation === previous.validation }
    catch { return false }
  } }
}
