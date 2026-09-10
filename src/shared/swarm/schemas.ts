import { isPermissionMode } from '../agents/config'
import { isSafeNodeId } from '../safe-id'
import type {
  BudgetKind,
  MissionGoal,
  ModelPolicy,
  SwarmApproval,
  SwarmArtifact,
  SwarmBudget,
  SwarmExecution,
  SwarmMission,
  SwarmRoleId,
  SwarmTask,
  TaskObserveState,
  TaskStatus
} from './types'
import { ALL_SWARM_ROLES, SWARM_ROLE_LABEL } from './types'

export function isSwarmRoleId(value: unknown): value is SwarmRoleId {
  return typeof value === 'string' && (ALL_SWARM_ROLES as readonly string[]).includes(value)
}

const TASK_STATUSES: readonly TaskStatus[] = [
  'queued',
  'ready',
  'running',
  'waiting_approval',
  'validating',
  'needs_review',
  'accepted',
  'failed',
  'cancelled',
  'stale'
]

export function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === 'string' && (TASK_STATUSES as readonly string[]).includes(value)
}

/** A worker result is accepted only when the payload matches this envelope. */
export interface StructuredTaskResult {
  taskId: string
  summary: string
  evidence: string[]
  criteriaMet: string[]
  executionId?: string
  usage?: { kind: 'measured' | 'estimated'; usd: number }
}

/** Turn-ended is not evidence. Host must never stamp requested criteria as met. */
export function isFabricatedTurnResult(
  raw: Pick<StructuredTaskResult, 'summary' | 'evidence'> | null | undefined
): boolean {
  if (!raw) return true
  if (raw.summary === 'Agent turn finished') return true
  return raw.evidence.length === 1 && raw.evidence[0] === 'agent-turn'
}

export function parseStructuredTaskResult(raw: unknown): StructuredTaskResult | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  if (typeof o.taskId !== 'string' || !o.taskId.trim()) return null
  if (typeof o.summary !== 'string' || !o.summary.trim()) return null
  if (!Array.isArray(o.evidence) || o.evidence.length === 0 || !o.evidence.every((x) => typeof x === 'string')) {
    return null
  }
  if (!Array.isArray(o.criteriaMet) || !o.criteriaMet.every((x) => typeof x === 'string')) return null
  if (o.criteriaMet.length === 0) return null
  const parsed: StructuredTaskResult = {
    taskId: o.taskId,
    summary: o.summary,
    evidence: o.evidence as string[],
    criteriaMet: o.criteriaMet as string[]
  }
  if (isFabricatedTurnResult(parsed)) return null
  if (typeof o.executionId === 'string' && o.executionId.trim()) parsed.executionId = o.executionId.trim()
  const usage = parseTaskUsage(o)
  if (usage) parsed.usage = usage
  return parsed
}

/** Parsed JSON may be collected. Only this check may accept the task. */
export function resultMatchesTask(
  parsed: StructuredTaskResult,
  task: Pick<SwarmTask, 'id' | 'executionId' | 'acceptanceCriteria'>
): boolean {
  if (parsed.taskId !== task.id) return false
  if (parsed.executionId && task.executionId && parsed.executionId !== task.executionId) return false
  const needed = task.acceptanceCriteria
  if (needed.length && !needed.every((c) => parsed.criteriaMet.includes(c))) return false
  return true
}

/** Spend is never inferred. Missing/invalid usage is unavailable, not $0. */
export function parseTaskUsage(raw: unknown): { kind: 'measured' | 'estimated'; usd: number } | null {
  if (!raw || typeof raw !== 'object') return null
  const u = (raw as Record<string, unknown>).usage
  if (!u || typeof u !== 'object') return null
  const o = u as Record<string, unknown>
  if (o.kind !== 'measured' && o.kind !== 'estimated') return null
  if (typeof o.usd !== 'number' || !Number.isFinite(o.usd) || o.usd < 0) return null
  return { kind: o.kind, usd: o.usd }
}

export function parentRoleOf(role: SwarmRoleId): SwarmRoleId | null {
  if (role === 'O') return null
  if (role.length === 1) return 'O'
  return role[0] as SwarmRoleId
}

/** Dormant, failed, or stale — the roster/inspector may activate without minting the other 20 PTYs. */
export function roleNeedsActivation(task?: { status: string } | null): boolean {
  if (!task) return true
  return task.status === 'failed' || task.status === 'stale' || task.status === 'needs_review'
}

/** Mesa writers: worktree approve is the human gate; the CLI itself must not sit on prompts. */
export const MESA_FULL_ACCESS_MODE = 'bypassPermissions' as const

const WORKER_PANE_STATUSES = new Set(['queued', 'ready', 'running', 'waiting_approval'])
const UNFINISHED = new Set([
  'queued',
  'ready',
  'running',
  'waiting_approval',
  'validating',
  'needs_review'
])

export function taskFailLabel(reason?: string | null): string | null {
  if (!reason) return null
  if (reason === 'no-validated-result') {
    return 'El CLI no dejó un resultado Mesa. Reintentá el rol.'
  }
  if (reason === 'unvalidated-turn') {
    return 'El turno terminó sin un resultado Mesa válido. Requiere revisión.'
  }
  if (reason === 'cli-never-started') {
    return 'El CLI no arrancó (sigue el shell). Reintentá el rol.'
  }
  if (reason === 'criteria-mismatch') {
    return 'El resultado no cubre los criterios. No se validó.'
  }
  if (reason === 'start-failed') return 'No se pudo lanzar el CLI.'
  if (reason === 'lost-observation') {
    return 'Sin conexión con la ejecución. No se relanzó el CLI. Requiere revisión.'
  }
  if (reason === 'cli-exit') return 'El CLI salió con error. El turno no se validó.'
  if (reason === 'unsupported-harness') return 'Este CLI no tiene un transporte de prompt soportado.'
  if (reason === 'prompt-too-large') return 'El brief de la tarea supera el límite de prompt.'
  if (reason === 'launch-line-too-long') return 'La línea de lanzamiento supera el límite del shell.'
  if (reason === 'bad-prompt-path') return 'La ruta del prompt no es válida.'
  return reason.slice(0, 200)
}

/** User-facing execution state. Status strings are not quality. */
export function taskLifecycleLabel(
  task?: Pick<SwarmTask, 'status' | 'observeState' | 'failReason'> | null
): string {
  if (!task) return 'dormido'
  if (task.status === 'running' && task.observeState === 'unobservable') return 'Sin conexión'
  if (task.status === 'needs_review' && task.failReason === 'lost-observation') return 'Sin conexión'
  if (task.status === 'running' && task.observeState === 'starting') return 'Arrancando'
  if (task.status === 'running' && task.observeState === 'turn-ended') return 'Turno terminado'
  if (task.status === 'running') return 'Trabajando'
  if (task.status === 'validating') return 'Validando'
  if (task.status === 'needs_review') return 'Turno terminado'
  if (task.status === 'accepted') return 'Aceptado'
  if (task.status === 'waiting_approval') return 'Esperando aprobación'
  if (task.status === 'queued') return 'En cola'
  if (task.status === 'ready') return 'Listo'
  if (task.status === 'failed') return 'Falló'
  if (task.status === 'cancelled') return 'Cancelado'
  if (task.status === 'stale') return 'Obsoleto'
  return task.status
}

export function cliEffectiveLabel(
  task: Pick<SwarmTask, 'requestedAgent' | 'requestedModel' | 'observedPane' | 'agentId' | 'agentModel'>
): string {
  const requested =
    [task.requestedAgent || task.agentId, task.requestedModel || task.agentModel].filter(Boolean).join(' / ') ||
    '—'
  const effective = task.observedPane?.trim() || 'No confirmado'
  return `CLI ${requested} · Efectivo: ${effective}`
}

export type MissionProgressKind =
  | 'none'
  | 'cancelled'
  | 'paused'
  | 'blocked'
  | 'in-progress'
  | 'failed'
  | 'unvalidated'
  | 'complete'
  | 'idle'

/** Honest mission sentence. `Lista` is not a synonym for “nothing is running”. */
export function missionProgress(mission: SwarmMission | null | undefined): {
  kind: MissionProgressKind
  label: string
  hint?: string
} {
  if (!mission) return { kind: 'none', label: 'Sin misión' }
  if (mission.cancelled) return { kind: 'cancelled', label: 'Cancelada' }
  if (mission.paused) return { kind: 'paused', label: 'En pausa' }

  const pending = mission.approvals.filter((a) => a.status === 'pending')
  const blocked = pending.find((a) => a.blockedReason)
  if (blocked) {
    return {
      kind: 'blocked',
      label: 'Bloqueada',
      hint: writerWorktreeBlockLabel(blocked.blockedReason) ?? blocked.blockedReason
    }
  }
  if (pending.length) {
    const roles = pending.map((a) => mission.tasks.find((t) => t.id === a.taskId)?.roleId ?? '?')
    return { kind: 'blocked', label: `Esperando aprobación: ${roles.join(', ')}` }
  }

  const unfinished = mission.tasks.filter((t) => UNFINISHED.has(t.status))
  if (unfinished.length) {
    const bits = unfinished.map((t) => `${t.roleId} ${t.status}`).join(', ')
    const waitingResult = unfinished.some((t) => t.status === 'running')
    return {
      kind: 'in-progress',
      label: `En curso · ${bits}`,
      hint: waitingResult
        ? 'Un turno terminado no acepta la tarea. Falta validar el resultado.'
        : undefined
    }
  }

  const failed = mission.tasks.filter((t) => t.status === 'failed')
  if (failed.length) {
    const first = taskFailLabel(failed[0]?.failReason)
    return {
      kind: 'failed',
      label: `Falló · ${failed.map((t) => t.roleId).join(', ')}`,
      hint: first ?? 'No se validó. Reintentá el rol.'
    }
  }

  const activated = mission.tasks.filter((t) => t.roleId !== 'O')
  if (!activated.length) return { kind: 'idle', label: 'Plan listo · activá A–D' }

  const writersDone = mission.tasks.filter((t) => roleWritesFiles(t.roleId) && t.status === 'accepted')
  const dAccepted = mission.tasks.some(
    (t) => (t.roleId === 'D' || t.roleId.startsWith('D')) && t.status === 'accepted'
  )
  if (writersDone.length && !dAccepted) {
    return {
      kind: 'unvalidated',
      label: 'Construcción lista · validación no corrió',
      hint: 'Activá D para verificar. Sin D, Mesa no afirma que el trabajo esté bien.'
    }
  }

  if (activated.every((t) => t.status === 'accepted' || t.status === 'cancelled')) {
    return { kind: 'complete', label: dAccepted ? 'Terminada y validada' : 'Terminada' }
  }

  return { kind: 'idle', label: 'Sin avance pendiente' }
}

/**
 * Live Mesa mints a host-owned pane only while the task still needs one.
 * `accepted` / `failed` / `cancelled` / `stale` must not grow an empty agent terminal —
 * mock accepts without typing a CLI, and a second spawn after bind shifts the queue.
 */
export function needsWorkerPane(task: {
  roleId: string
  nodeId?: string
  status: string
}): boolean {
  if (task.roleId === 'O' || task.nodeId) return false
  return WORKER_PANE_STATUSES.has(task.status)
}

export function countActiveTasks(statuses: Array<{ status: string }>): number {
  return statuses.filter((t) => t.status === 'running' || t.status === 'waiting_approval').length
}

export function countAcceptedCriteria(goalCriteria: string[], acceptedCriteria: string[]): { met: number; total: number } {
  const total = goalCriteria.length
  if (!total) return { met: 0, total: 0 }
  const accepted = new Set(acceptedCriteria)
  return { met: goalCriteria.filter((c) => accepted.has(c)).length, total }
}

/** Goal criteria (plan-presented) is not mission complete. Count activated worker roles. */
export function countActivatedRoles(mission: Pick<SwarmMission, 'tasks'> | null | undefined): {
  met: number
  total: number
} {
  if (!mission) return { met: 0, total: 0 }
  const workers = mission.tasks.filter((t) => t.roleId !== 'O')
  return {
    met: workers.filter((t) => t.status === 'accepted').length,
    total: workers.length
  }
}

/** Goal criteria verified by accepted artifacts — never by turn-end or O's TUI stamp. */
export function countVerifiedGoalCriteria(
  mission: Pick<SwarmMission, 'goal' | 'artifacts'> | null | undefined
): { met: number; total: number } {
  const total = mission?.goal.acceptanceCriteria.length ?? 0
  if (!mission || !total) return { met: 0, total }
  const verified = new Set<string>()
  for (const artifact of mission.artifacts) {
    const parsed = parseStructuredTaskResult(artifact.payload)
    if (!parsed) continue
    if (parsed.evidence.length === 1 && parsed.evidence[0] === 'tui') continue
    for (const c of parsed.criteriaMet) {
      if (mission.goal.acceptanceCriteria.includes(c)) verified.add(c)
    }
  }
  return { met: verified.size, total }
}

export function countUnobservableExecutions(tasks: Array<{ observeState?: string; status: string }>): number {
  return tasks.filter((t) => t.status === 'running' && t.observeState === 'unobservable').length
}

/** Explicit mission / project folder only. A terminal cwd is never auto-bound. */
export function mesaFolderRoot(projectCwd?: string | null): string | undefined {
  return absoluteWorkspaceRoot(projectCwd)
}

/** Propose a folder only when there is exactly one absolute candidate. Never pick the first of many. */
export function mesaUniqueFolderCandidate(extraCwds: Array<string | null | undefined> = []): string | undefined {
  const unique = [
    ...new Set(extraCwds.map((cwd) => absoluteWorkspaceRoot(cwd)).filter((cwd): cwd is string => !!cwd))
  ]
  return unique.length === 1 ? unique[0] : undefined
}

export function formatBudgetLine(opts: {
  kind: 'measured' | 'estimated' | 'unavailable'
  usd?: number
}): { label: string; kind: 'measured' | 'estimated' | 'unavailable' } {
  if (opts.kind === 'unavailable' || opts.usd == null) {
    return { label: 'No disponible', kind: 'unavailable' }
  }
  const prefix = opts.kind === 'estimated' ? '~' : ''
  return { label: `${prefix}$${opts.usd.toFixed(2)}`, kind: opts.kind }
}

export function childRolesOf(role: SwarmRoleId): SwarmRoleId[] {
  if (role === 'O') return ['A', 'B', 'C', 'D']
  if (role === 'A') return ['A1', 'A2', 'A3', 'A4']
  if (role === 'B') return ['B1', 'B2', 'B3', 'B4']
  if (role === 'C') return ['C1', 'C2', 'C3', 'C4']
  if (role === 'D') return ['D1', 'D2', 'D3', 'D4']
  return []
}

/** C1–C4 write files. The C coordinator plans; it does not get a worktree. */
export function roleWritesFiles(role: SwarmRoleId): boolean {
  return role.startsWith('C') && role !== 'C'
}

/** Absolute local repo only. `.` is the Electron cwd — never a canvas folder. */
export function absoluteWorkspaceRoot(root?: string | null): string | undefined {
  if (!root) return undefined
  const t = root.trim()
  if (t.startsWith('/') || /^[A-Za-z]:[\\/]/.test(t)) return t
  return undefined
}

/** SSH / cwd-less missions have no local repo. Approve must not pretend a worktree exists. */
export function writerWorktreeBlock(
  mission: Pick<SwarmMission, 'workspaceRoot'> | null | undefined
): string | null {
  if (!absoluteWorkspaceRoot(mission?.workspaceRoot)) return 'no-workspace-root'
  return null
}

export function writerWorktreeBlockLabel(reason: string | null | undefined): string | null {
  if (!reason) return null
  if (reason === 'no-workspace-root') {
    return 'Sin carpeta local: C1–C4 no aíslan worktrees (SSH o canvas sin carpeta). Si el repo ya tiene .nodeterm/project.json usá Open folder…, no Set folder…'
  }
  if (reason === 'worktree-failed') return 'No se pudo crear el worktree.'
  if (reason === 'not-a-git-repo') {
    return 'No se pudo inicializar git en esta carpeta (¿permisos, o es HOME?).'
  }
  if (reason === 'empty-git-repo') {
    return 'No se pudo crear el commit inicial. Mesa necesita un commit para el worktree.'
  }
  if (reason === 'relative-path') return 'La carpeta del proyecto no es una ruta absoluta.'
  if (reason === 'dangerous-path') return 'La ruta del worktree no es segura.'
  if (reason === 'invalid-ref') return 'La rama del worktree no es válida.'
  if (reason === 'missing-path') return 'Falta la ruta del worktree.'
  if (reason === 'no-worktree-helper') {
    return 'Este host no puede crear worktrees. La tarea queda bloqueada.'
  }
  if (reason === 'unsupported-approval') {
    return 'Esa aprobación no está en el alcance permitido (solo crear worktree).'
  }
  return reason
}

function asId(value: unknown): string | null {
  return typeof value === 'string' && isSafeNodeId(value) ? value : null
}

function asText(value: unknown, max = 4000): string | null {
  if (typeof value !== 'string') return null
  const text = value.trim()
  return text && text.length <= max ? text : null
}

function asStringList(value: unknown, max = 32): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).slice(0, max)
}

function parseGoal(raw: unknown): MissionGoal | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const objective = asText(o.objective)
  if (!objective) return null
  const version = typeof o.version === 'number' && Number.isInteger(o.version) && o.version >= 1 ? o.version : 1
  return {
    version,
    objective,
    constraints: asStringList(o.constraints),
    acceptanceCriteria: asStringList(o.acceptanceCriteria),
    decisionRefs: asStringList(o.decisionRefs)
  }
}

function parseBudgetKind(value: unknown): BudgetKind {
  return value === 'measured' || value === 'estimated' ? value : 'unavailable'
}

function parseSpend(raw: unknown): { kind: BudgetKind; usd?: number } {
  if (!raw || typeof raw !== 'object') return { kind: 'unavailable' }
  const o = raw as Record<string, unknown>
  const kind = parseBudgetKind(o.kind)
  if (kind === 'unavailable') return { kind: 'unavailable' }
  if (typeof o.usd !== 'number' || !Number.isFinite(o.usd) || o.usd < 0) return { kind: 'unavailable' }
  return { kind, usd: o.usd }
}

function parseBudget(raw: unknown): SwarmBudget {
  if (!raw || typeof raw !== 'object') {
    return { hard: false, spent: { kind: 'unavailable' }, reserved: { kind: 'unavailable' } }
  }
  const o = raw as Record<string, unknown>
  const spent = parseSpend(o.spent)
  const reserved = parseSpend(o.reserved)
  const limitUsd =
    typeof o.limitUsd === 'number' && Number.isFinite(o.limitUsd) && o.limitUsd >= 0 ? o.limitUsd : undefined
  const blocked =
    o.blockedReason === 'budget-exhausted' || o.blockedReason === 'hard-limit needs an adapter that can enforce spend'
      ? o.blockedReason
      : undefined
  return {
    hard: o.hard === true,
    spent,
    reserved,
    ...(limitUsd != null ? { limitUsd } : {}),
    ...(blocked ? { blockedReason: blocked } : {})
  }
}

function parseTask(raw: unknown, missionId: string): SwarmTask | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const id = asId(o.id)
  if (!id || !isSwarmRoleId(o.roleId) || !isTaskStatus(o.status)) return null
  const instruction = asText(o.instruction, 16_000) ?? SWARM_ROLE_LABEL[o.roleId]
  const goalVersion =
    typeof o.goalVersion === 'number' && Number.isInteger(o.goalVersion) && o.goalVersion >= 1 ? o.goalVersion : 1
  const workspaceRaw = o.workspace
  let workspace: SwarmTask['workspace']
  if (workspaceRaw && typeof workspaceRaw === 'object') {
    const w = workspaceRaw as Record<string, unknown>
    const kind = w.kind === 'worktree' ? 'worktree' : w.kind === 'shared' ? 'shared' : null
    const pathHint = typeof w.pathHint === 'string' ? w.pathHint : ''
    if (kind) {
      workspace = {
        kind,
        pathHint,
        ...(typeof w.branch === 'string' ? { branch: w.branch } : {}),
        ...(typeof w.baseRef === 'string' ? { baseRef: w.baseRef } : {})
      }
    }
  }
  const nodeId = asId(o.nodeId) ?? undefined
  const executionId = asId(o.executionId) ?? undefined
  const agentId = asText(o.agentId, 128) ?? undefined
  const agentModel = asText(o.agentModel, 256) ?? undefined
  const agentSessionId = asId(o.agentSessionId) ?? undefined
  const parentTaskId = asId(o.parentTaskId) ?? undefined
  const dependsOn = asStringList(o.dependsOn).filter((dep) => isSafeNodeId(dep) || dep.startsWith(`${missionId}-`))
  return {
    id,
    missionId,
    roleId: o.roleId,
    dependsOn,
    goalVersion,
    instruction,
    acceptanceCriteria: asStringList(o.acceptanceCriteria),
    artifactRefs: asStringList(o.artifactRefs),
    status: o.status,
    ...(parentTaskId ? { parentTaskId } : {}),
    ...(executionId ? { executionId } : {}),
    ...(nodeId ? { nodeId } : {}),
    ...(agentId ? { agentId } : {}),
    ...(agentModel ? { agentModel } : {}),
    ...(agentSessionId ? { agentSessionId } : {}),
    ...(workspace ? { workspace } : {}),
    ...(asText(o.failReason, 240) ? { failReason: asText(o.failReason, 240)! } : {}),
    ...(o.observeState === 'unobservable' || o.observeState === 'starting' || o.observeState === 'turn-ended'
      ? { observeState: o.observeState as TaskObserveState }
      : {}),
    ...(typeof o.observeSince === 'number' && Number.isFinite(o.observeSince) ? { observeSince: o.observeSince } : {}),
    ...(asText(o.requestedAgent, 128) ? { requestedAgent: asText(o.requestedAgent, 128)! } : {}),
    ...(asText(o.requestedModel, 256) ? { requestedModel: asText(o.requestedModel, 256)! } : {}),
    ...(asText(o.observedPane, 128) ? { observedPane: asText(o.observedPane, 128)! } : {})
  }
}

/**
 * `userData/swarm-missions/*.json` is machine-local but hand-editable. A missing tasks array
 * must not reach the 2s host tick — that throw would stop every mission.
 */
export function parseSwarmMission(raw: unknown): SwarmMission | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const id = asId(o.id)
  const projectId = asId(o.projectId)
  const orchestratorNodeId = asId(o.orchestratorNodeId)
  const title = asText(o.title, 80) ?? 'Misión'
  const goal = parseGoal(o.goal)
  if (!id || !projectId || !orchestratorNodeId || !goal) return null
  if (!Array.isArray(o.tasks)) return null
  const tasks = o.tasks.map((task) => parseTask(task, id)).filter((task): task is SwarmTask => !!task)
  if (tasks.length === 0) return null
  const createdAt = typeof o.createdAt === 'number' && Number.isFinite(o.createdAt) ? o.createdAt : 0
  const workspaceRoot =
    typeof o.workspaceRoot === 'string' && (o.workspaceRoot.startsWith('/') || /^[A-Za-z]:[\\/]/.test(o.workspaceRoot))
      ? o.workspaceRoot
      : undefined
  const modelPolicy: ModelPolicy | undefined = o.modelPolicy === 'pinned' ? 'pinned' : o.modelPolicy === 'auto' ? 'auto' : undefined
  const approvals: SwarmApproval[] = Array.isArray(o.approvals)
    ? o.approvals.flatMap((item) => {
        if (!item || typeof item !== 'object') return []
        const a = item as Record<string, unknown>
        const approvalId = asId(a.id)
        const taskId = asId(a.taskId) ?? asText(a.taskId, 160)
        const action = a.action && typeof a.action === 'object' ? (a.action as Record<string, unknown>) : null
        if (!approvalId || !taskId || !action || typeof action.command !== 'string') return []
        const status = a.status === 'approved' || a.status === 'rejected' ? a.status : 'pending'
        const blockedReason = asText(a.blockedReason, 240) ?? undefined
        return [
          {
            id: approvalId,
            missionId: id,
            taskId,
            action: {
              command: action.command,
              args: asStringList(action.args, 8),
              cwd: typeof action.cwd === 'string' ? action.cwd : '',
              scope: typeof action.scope === 'string' ? action.scope : 'shared'
            },
            status,
            ...(blockedReason ? { blockedReason } : {})
          }
        ]
      })
    : []
  const executions: SwarmExecution[] = Array.isArray(o.executions)
    ? o.executions.flatMap((item) => {
        if (!item || typeof item !== 'object') return []
        const e = item as Record<string, unknown>
        const execId = asId(e.id)
        const taskId = asId(e.taskId) ?? asText(e.taskId, 160)
        if (!execId || !taskId || typeof e.attempt !== 'number' || typeof e.startedAt !== 'number') return []
        return [
          {
            id: execId,
            missionId: id,
            taskId,
            attempt: e.attempt,
            startedAt: e.startedAt,
            ...(typeof e.finishedAt === 'number' ? { finishedAt: e.finishedAt } : {}),
            ...(asId(e.nodeId) ? { nodeId: asId(e.nodeId)! } : {}),
            ...(typeof e.sessionName === 'string' ? { sessionName: e.sessionName } : {})
          }
        ]
      })
    : []
  const artifacts: SwarmArtifact[] = Array.isArray(o.artifacts)
    ? o.artifacts.flatMap((item) => {
        if (!item || typeof item !== 'object') return []
        const a = item as Record<string, unknown>
        const artId = asId(a.id) ?? asText(a.id, 160)
        const taskId = asId(a.taskId) ?? asText(a.taskId, 160)
        if (!artId || !taskId || typeof a.kind !== 'string') return []
        return [{ id: artId, missionId: id, taskId, kind: a.kind, payload: a.payload }]
      })
    : []
  return {
    id,
    projectId,
    orchestratorNodeId,
    title,
    goal,
    paused: o.paused === true,
    cancelled: o.cancelled === true,
    createdAt,
    tasks,
    executions,
    artifacts,
    approvals,
    budget: parseBudget(o.budget),
    ...(workspaceRoot ? { workspaceRoot } : {}),
    ...(modelPolicy ? { modelPolicy } : {}),
    ...(asText(o.preferredAgent, 128) ? { preferredAgent: asText(o.preferredAgent, 128)! } : {}),
    ...(asText(o.pinnedModel, 256) ? { pinnedModel: asText(o.pinnedModel, 256)! } : {}),
    ...(isPermissionMode(o.permissionMode) ? { permissionMode: o.permissionMode } : {}),
    ...(asText(o.launchCmdOverride, 400) ? { launchCmdOverride: asText(o.launchCmdOverride, 400)! } : {}),
    ...(o.sharedIdentity === true ? { sharedIdentity: true } : {})
  }
}

/** Full 1→4→16 tree. Missing tasks stay dormido — registering a role is not spawning a PTY. */
export function formatRolePlan(
  tasks: Array<{ roleId: SwarmRoleId; status: string; instruction?: string }>
): string {
  const byRole = new Map(tasks.map((t) => [t.roleId, t]))
  const lines: string[] = []
  const walk = (role: SwarmRoleId, depth: number) => {
    const t = byRole.get(role)
    const status = t?.status ?? 'dormido'
    const label = SWARM_ROLE_LABEL[role]
    lines.push(`${'  '.repeat(depth)}${role} ${status} · ${label}`)
    for (const child of childRolesOf(role)) walk(child, depth + 1)
  }
  walk('O', 0)
  return lines.join('\n')
}
