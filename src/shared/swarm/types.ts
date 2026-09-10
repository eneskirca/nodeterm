export type SwarmRoleId =
  | 'O'
  | 'A'
  | 'B'
  | 'C'
  | 'D'
  | `${'A' | 'B' | 'C' | 'D'}${1 | 2 | 3 | 4}`

export const COORDINATOR_ROLES = ['A', 'B', 'C', 'D'] as const
export const WORKER_ROLES = [
  'A1',
  'A2',
  'A3',
  'A4',
  'B1',
  'B2',
  'B3',
  'B4',
  'C1',
  'C2',
  'C3',
  'C4',
  'D1',
  'D2',
  'D3',
  'D4'
] as const

export const ALL_SWARM_ROLES: readonly SwarmRoleId[] = [
  'O',
  ...COORDINATOR_ROLES,
  ...WORKER_ROLES
]

export const SWARM_ROLE_LABEL: Record<SwarmRoleId, string> = {
  O: 'Orquestador',
  A: 'Investigación',
  A1: 'Búsqueda',
  A2: 'Extracción',
  A3: 'Contraste',
  A4: 'Síntesis',
  B: 'Diseño',
  B1: 'Requisitos',
  B2: 'Alternativas',
  B3: 'Arquitectura',
  B4: 'Riesgos',
  C: 'Construcción',
  C1: 'Implementar',
  C2: 'Integrar herramientas',
  C3: 'Transformar datos',
  C4: 'Integrar cambios',
  D: 'Validación',
  D1: 'Pruebas',
  D2: 'Verificación factual',
  D3: 'Seguridad',
  D4: 'Cumplimiento global'
}

export type TaskStatus =
  | 'queued'
  | 'ready'
  | 'running'
  | 'waiting_approval'
  | 'validating'
  | 'needs_review'
  | 'accepted'
  | 'failed'
  | 'cancelled'
  | 'stale'

/** Pane observation while the task is still running. Never implies acceptance. */
export type TaskObserveState = 'starting' | 'unobservable' | 'turn-ended'

export type BudgetKind = 'measured' | 'estimated' | 'unavailable'

export type ModelPolicy = 'auto' | 'pinned'

export interface MissionGoal {
  version: number
  objective: string
  constraints: string[]
  acceptanceCriteria: string[]
  decisionRefs: string[]
}

export interface SwarmTask {
  id: string
  missionId: string
  roleId: SwarmRoleId
  parentTaskId?: string
  dependsOn: string[]
  goalVersion: number
  instruction: string
  acceptanceCriteria: string[]
  artifactRefs: string[]
  status: TaskStatus
  executionId?: string
  nodeId?: string
  agentId?: string
  agentModel?: string
  /** Minted at node create (`--session-id`). Host launch must reuse it. */
  agentSessionId?: string
  workspace?: { kind: 'shared' | 'worktree'; pathHint: string; branch?: string; baseRef?: string }
  /** Host-owned. Why this task failed — never invent success from silence. */
  failReason?: string
  /** Host-owned. Lost tmux/pane contact. Keep the execution; do not retype the CLI. */
  observeState?: TaskObserveState
  /** First unreadable pane at this clock. Host may move to review after the operational threshold. */
  observeSince?: number
  requestedAgent?: string
  requestedModel?: string
  /** Foreground pane command, if observed. Absent = not confirmed. */
  observedPane?: string
}

export interface SwarmExecution {
  id: string
  missionId: string
  taskId: string
  attempt: number
  nodeId?: string
  sessionName?: string
  startedAt: number
  finishedAt?: number
}

export interface SwarmArtifact {
  id: string
  missionId: string
  taskId: string
  kind: string
  payload: unknown
}

export interface SwarmApproval {
  id: string
  missionId: string
  taskId: string
  action: { command: string; args: string[]; cwd: string; scope: string }
  status: 'pending' | 'approved' | 'rejected'
  /** Host-owned: approve stayed pending because the worktree could not be created. */
  blockedReason?: string
}

export interface SwarmBudget {
  limitUsd?: number
  hard: boolean
  spent: { kind: BudgetKind; usd?: number }
  reserved: { kind: BudgetKind; usd?: number }
  /** Last canDispatch refusal. Host-owned; never invent spend to clear it. */
  blockedReason?: string
}

export interface SwarmMission {
  id: string
  projectId: string
  orchestratorNodeId: string
  title: string
  goal: MissionGoal
  paused: boolean
  cancelled: boolean
  createdAt: number
  tasks: SwarmTask[]
  executions: SwarmExecution[]
  artifacts: SwarmArtifact[]
  approvals: SwarmApproval[]
  budget: SwarmBudget
  workspaceRoot?: string
  modelPolicy?: ModelPolicy
  preferredAgent?: string
  pinnedModel?: string
  /** Snapshot of project/global permission mode at create. Host launch reuses it. */
  permissionMode?: import('../agents/config').AgentPermissionMode
  /** Project-layer launchCmd (trusted/local). Global Settings override is read live. */
  launchCmdOverride?: string
  /** Snapshot: managed Codex launcher is available on this machine. */
  sharedIdentity?: boolean
}

export interface SwarmNodeMeta {
  missionId: string
  roleId: SwarmRoleId
  executionId?: string
}

export type SwarmLaunchMode = 'viewer' | 'runtime'

export interface CreateMissionInput {
  projectId: string
  orchestratorNodeId: string
  objective: string
  constraints?: string[]
  acceptanceCriteria?: string[]
  budgetLimitUsd?: number
  hardBudget?: boolean
  workspaceRoot?: string
  modelPolicy?: ModelPolicy
  preferredAgent?: string
  pinnedModel?: string
  permissionMode?: import('../agents/config').AgentPermissionMode
  launchCmdOverride?: string
  sharedIdentity?: boolean
}

export interface SwarmSnapshot {
  mission: SwarmMission | null
}
