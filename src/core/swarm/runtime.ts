import { randomUUID } from 'crypto'
import path from 'path'
import { isPermissionMode } from '../../shared/agents/config'
import {
  absoluteWorkspaceRoot,
  MESA_FULL_ACCESS_MODE,
  parseStructuredTaskResult,
  resultMatchesTask,
  roleWritesFiles,
  writerWorktreeBlock,
  type StructuredTaskResult
} from '../../shared/swarm/schemas'
import {
  SWARM_ROLE_LABEL,
  type CreateMissionInput,
  type MissionGoal,
  type SwarmApproval,
  type SwarmMission,
  type SwarmRoleId,
  type SwarmTask
} from '../../shared/swarm/types'
import { createMockAdapter } from './adapters/mock'
import type { AgentAdapter, ExecutionObservation } from './adapters/types'
import { applySpend, canDispatch, emptyBudget } from './budget'
import { taskBrief } from './context'
import { listMissions, loadMission, saveMission } from './persistence'
import { countActive, dependenciesSatisfied, tasksReadyToRun } from './scheduler'
import { canMaterializeWorktree, planWorkspace, worktreeFailureReason } from './workspaces'

/** After this, an unreadable pane goes to review. Never retype the CLI. */
export const UNOBSERVABLE_REVIEW_MS = 10 * 60 * 1000

function applyRecoverObservation(task: SwarmTask, obs: ExecutionObservation, now: number): void {
  if (obs.state === 'starting') {
    task.observeState = 'starting'
    task.observeSince = undefined
    if (obs.paneCommand) task.observedPane = obs.paneCommand
    return
  }
  if (obs.state === 'running') {
    task.observeState = undefined
    task.observeSince = undefined
    if (obs.paneCommand) task.observedPane = obs.paneCommand
    return
  }
  if (obs.state === 'turn-ended') {
    task.observeState = 'turn-ended'
    task.observeSince = undefined
    return
  }
  if (obs.state === 'unobservable') {
    task.observeState = 'unobservable'
    task.observeSince = obs.since ?? task.observeSince ?? now
  }
}

function roleWork(roleId: SwarmRoleId): string {
  if (roleId === 'O') return 'Hold the goal and present a plan. Do not edit files.'
  return SWARM_ROLE_LABEL[roleId]
}

function coordinatorOf(roleId: SwarmRoleId): SwarmRoleId | undefined {
  if (roleId === 'O') return undefined
  if (roleId.length === 2) return roleId[0] as SwarmRoleId
  return 'O'
}

function briefFor(goal: MissionGoal, task: SwarmTask): string {
  const coordinatorRole = coordinatorOf(task.roleId)
  return taskBrief(
    goal,
    { ...task, instruction: roleWork(task.roleId) },
    coordinatorRole ? SWARM_ROLE_LABEL[coordinatorRole] : undefined
  )
}

export interface SwarmRuntime {
  createMission(input: CreateMissionInput): Promise<SwarmMission>
  getMission(id: string): SwarmMission | null
  list(projectId?: string): SwarmMission[]
  setGoal(missionId: string, objective: string, criteria?: string[]): Promise<SwarmMission | null>
  setWorkspaceRoot(missionId: string, workspaceRoot: string): Promise<SwarmMission | null>
  activateRole(missionId: string, roleId: SwarmTask['roleId']): Promise<SwarmMission | null>
  bindRole(
    missionId: string,
    roleId: SwarmTask['roleId'],
    nodeId: string,
    launch?: { agentId?: string; agentModel?: string; agentSessionId?: string }
  ): Promise<SwarmMission | null>
  tick(missionId: string): Promise<SwarmMission | null>
  approve(missionId: string, approvalId: string): Promise<SwarmMission | null>
  pause(missionId: string): Promise<SwarmMission | null>
  resume(missionId: string): Promise<SwarmMission | null>
  cancel(missionId: string): Promise<SwarmMission | null>
}

function missionRepoRoot(root?: string): string {
  return root && path.isAbsolute(root) ? root : ''
}

function seedTasks(
  missionId: string,
  goal: MissionGoal,
  workspaceRoot: string,
  orchestratorNodeId: string
): SwarmTask[] {
  const workspace = planWorkspace('O', workspaceRoot)
  const task: SwarmTask = {
    id: `${missionId}-O`,
    missionId,
    roleId: 'O',
    dependsOn: [],
    goalVersion: goal.version,
    instruction: roleWork('O'),
    acceptanceCriteria: goal.acceptanceCriteria.length ? [...goal.acceptanceCriteria] : ['plan-presented'],
    artifactRefs: [],
    status: 'ready',
    nodeId: orchestratorNodeId,
    workspace: {
      kind: workspace.kind,
      pathHint: workspace.pathHint,
      branch: workspace.branch,
      baseRef: workspace.baseRef
    }
  }
  task.instruction = briefFor(goal, task)
  return [task]
}

function hasApproved(mission: SwarmMission, taskId: string): boolean {
  return mission.approvals.some((a) => a.taskId === taskId && a.status === 'approved')
}

function ensureWriteApproval(mission: SwarmMission, task: SwarmTask): void {
  if (!roleWritesFiles(task.roleId)) return
  if (mission.approvals.some((a) => a.taskId === task.id && a.status !== 'rejected')) return
  const cwd = task.workspace?.pathHint || mission.workspaceRoot || ''
  mission.approvals.push({
    id: randomUUID(),
    missionId: mission.id,
    taskId: task.id,
    action: {
      command: 'write-workspace',
      args: [task.roleId],
      cwd,
      scope: task.workspace?.kind ?? 'worktree'
    },
    status: 'pending'
  })
}

function gateOrReady(mission: SwarmMission, task: SwarmTask, byId: Map<string, SwarmTask>): void {
  if (!dependenciesSatisfied(task, byId)) {
    task.status = 'queued'
    return
  }
  if (roleWritesFiles(task.roleId) && !hasApproved(mission, task.id)) {
    task.status = 'waiting_approval'
    ensureWriteApproval(mission, task)
    return
  }
  task.status = 'ready'
}

function addRole(mission: SwarmMission, id: SwarmRoleId, retry = false): void {
  const existing = mission.tasks.find((t) => t.roleId === id)
  if (existing && existing.status !== 'cancelled') {
    if (
      retry &&
      (existing.status === 'failed' || existing.status === 'stale' || existing.status === 'needs_review')
    ) {
      existing.status = 'queued'
      existing.executionId = undefined
      existing.failReason = undefined
      existing.observeState = undefined
      existing.goalVersion = mission.goal.version
      existing.instruction = briefFor(mission.goal, {
        ...existing,
        instruction: roleWork(existing.roleId)
      })
      gateOrReady(mission, existing, new Map(mission.tasks.map((t) => [t.id, t])))
    }
    return
  }
  const parent = id === 'O' ? undefined : id.length === 1 ? `${mission.id}-O` : `${mission.id}-${id[0]}`
  const workspace = planWorkspace(id, missionRepoRoot(mission.workspaceRoot))
  const task: SwarmTask = {
    id: `${mission.id}-${id}`,
    missionId: mission.id,
    roleId: id,
    parentTaskId: parent,
    dependsOn: parent ? [parent] : [],
    goalVersion: mission.goal.version,
    instruction: roleWork(id),
    acceptanceCriteria: [`${id}-done`],
    artifactRefs: [],
    status: 'queued',
    workspace: {
      kind: workspace.kind,
      pathHint: workspace.pathHint,
      branch: workspace.branch,
      baseRef: workspace.baseRef
    }
  }
  task.instruction = briefFor(mission.goal, task)
  gateOrReady(mission, task, new Map(mission.tasks.map((t) => [t.id, t])))
  mission.tasks.push(task)
}

/** C1–C4 accepted is not “done”. Wake D so validation is a real step, not a missing one. */
function maybeAdvancePipeline(mission: SwarmMission): void {
  if (mission.cancelled || mission.paused) return
  const writers = mission.tasks.filter((t) => roleWritesFiles(t.roleId))
  if (!writers.length) return
  if (writers.some((t) => t.status !== 'accepted' && t.status !== 'cancelled')) return
  if (!writers.some((t) => t.status === 'accepted')) return
  const d = mission.tasks.find((t) => t.roleId === 'D')
  if (d && d.status !== 'cancelled') return
  addRole(mission, 'D')
}

function acceptParsed(mission: SwarmMission, task: SwarmTask, parsed: StructuredTaskResult): void {
  task.failReason = undefined
  task.observeState = undefined
  mission.artifacts.push({
    id: `${task.id}-art`,
    missionId: mission.id,
    taskId: task.id,
    kind: 'structured-result',
    payload: parsed
  })
  task.artifactRefs = [`${task.id}-art`]
  task.status = 'accepted'
  if (parsed.usage) mission.budget = applySpend(mission.budget, parsed.usage)
  const exec = mission.executions.find((e) => e.id === task.executionId)
  if (exec) exec.finishedAt = Date.now()
}

export type EnsureWorktree = (plan: {
  repoRoot: string
  path: string
  branch: string
  baseRef: string
}) => Promise<{ ok: boolean; message?: string; path?: string }>

export function startSwarmRuntime(opts: {
  userDataDir: string
  adapter?: AgentAdapter
  ensureWorktree?: EnsureWorktree
  homeDir?: string
}): SwarmRuntime {
  const adapter = opts.adapter ?? createMockAdapter()
  const dir = opts.userDataDir

  const persist = async (m: SwarmMission) => {
    await saveMission(dir, m)
    return m
  }

  const read = (id: string) => loadMission(dir, id)
  const tickLock = new Map<string, Promise<SwarmMission | null>>()

  const applyApproval = async (m: SwarmMission, a: SwarmApproval): Promise<void> => {
    if (a.status !== 'pending') return
    if (a.action.command !== 'write-workspace') {
      a.blockedReason = 'unsupported-approval'
      return
    }
    const task = m.tasks.find((t) => t.id === a.taskId)
    if (task?.workspace?.kind === 'worktree') {
      const repoRoot = m.workspaceRoot
      const blocked = writerWorktreeBlock(m)
      if (blocked || !repoRoot) {
        a.blockedReason = blocked ?? 'no-workspace-root'
        return
      }
      if (!opts.ensureWorktree) {
        a.blockedReason = 'no-worktree-helper'
        return
      }
      const gate = canMaterializeWorktree(
        { roleId: task.roleId, ...task.workspace },
        repoRoot,
        opts.homeDir ?? process.env.HOME ?? ''
      )
      if (!gate.ok) {
        a.blockedReason = gate.reason
        return
      }
      const made = await opts.ensureWorktree({
        repoRoot,
        path: gate.path,
        branch: gate.branch,
        baseRef: gate.baseRef
      })
      if (!made.ok) {
        a.blockedReason = worktreeFailureReason(made.message)
        return
      }
      if (made.path && task.workspace) {
        task.workspace = { ...task.workspace, pathHint: made.path }
      }
    }
    a.status = 'approved'
    a.blockedReason = undefined
    if (task && task.status === 'waiting_approval') task.status = 'ready'
  }

  const doTick = async (missionId: string): Promise<SwarmMission | null> => {
    const m = read(missionId)
    if (!m) return null

    for (const task of m.tasks.filter((t) => t.status === 'running' && t.executionId)) {
      const obs = await adapter.recoverExecution(task.executionId!)
      if (obs.state === 'lost' || obs.state === 'never-started') {
        const exec = m.executions.find((e) => e.id === task.executionId)
        if (exec) exec.finishedAt = Date.now()
        // Do not re-type the CLI. A second launch into the same pane is the
        // "I tried to run it and got an error" report.
        task.status = 'failed'
        task.failReason = obs.state === 'never-started' ? 'cli-never-started' : 'no-validated-result'
        task.observeState = undefined
        task.observeSince = undefined
        task.executionId = undefined
        continue
      }
      applyRecoverObservation(task, obs, Date.now())
      if (
        obs.state === 'unobservable' &&
        task.observeSince &&
        Date.now() - task.observeSince > UNOBSERVABLE_REVIEW_MS
      ) {
        task.status = 'needs_review'
        task.failReason = 'lost-observation'
      }
    }

    if (m.cancelled) return persist(m)

    const byId = new Map(m.tasks.map((t) => [t.id, t]))
    for (const task of m.tasks) {
      if (task.status === 'queued') gateOrReady(m, task, byId)
    }

    const gate = canDispatch(m.budget, adapter.capabilities)
    m.budget = { ...m.budget, blockedReason: gate.ok ? undefined : gate.reason }
    if (!m.paused) {
      for (const task of tasksReadyToRun(m)) {
        // Role O is the host-authored TUI. A live adapter cannot enforce spend, but
        // blocking O leaves the mission without a console. Workers stay gated.
        if (!gate.ok && task.roleId !== 'O') continue
        if (countActive(m) >= 4) break
        task.status = 'running'
        try {
          const attempt = m.executions.filter((e) => e.taskId === task.id).length + 1
          const started = await adapter.startTask({ ...task, launchGeneration: attempt })
          if (started.deferred) {
            task.status = 'ready'
            continue
          }
          if (started.refused) {
            task.status = 'failed'
            task.failReason = started.refuseReason ?? 'unsupported-harness'
            continue
          }
          task.executionId = started.executionId
          if (started.requestedAgent) task.requestedAgent = started.requestedAgent
          if (started.requestedModel) task.requestedModel = started.requestedModel
          m.executions.push({
            id: started.executionId,
            missionId,
            taskId: task.id,
            attempt,
            sessionName: started.sessionName,
            startedAt: Date.now()
          })
        } catch {
          task.status = 'failed'
          task.failReason = 'start-failed'
        }
      }
    }

    for (const task of m.tasks.filter((t) => t.status === 'running' && t.executionId)) {
      const obs = await adapter.recoverExecution(task.executionId!)
      applyRecoverObservation(task, obs, Date.now())
      if (
        obs.state === 'unobservable' &&
        task.observeSince &&
        Date.now() - task.observeSince > UNOBSERVABLE_REVIEW_MS
      ) {
        task.status = 'needs_review'
        task.failReason = 'lost-observation'
        continue
      }
      if (obs.state === 'unobservable' && task.observeState === 'unobservable') {
        const raw = await adapter.collectResult(task.executionId!)
        const parsed = parseStructuredTaskResult(raw)
        if (parsed && resultMatchesTask(parsed, task)) {
          acceptParsed(m, task, parsed)
        }
        continue
      }
      const raw = await adapter.collectResult(task.executionId!)
      const parsed = parseStructuredTaskResult(raw)
      if (parsed && resultMatchesTask(parsed, task)) {
        acceptParsed(m, task, parsed)
        continue
      }
      if (obs.state === 'turn-ended') {
        const exec = m.executions.find((e) => e.id === task.executionId)
        if (exec) exec.finishedAt = Date.now()
        task.observeState = 'turn-ended'
        task.status = 'needs_review'
        task.failReason =
          obs.exitCode != null && obs.exitCode !== 0 && !parsed
            ? 'cli-exit'
            : parsed && parsed.taskId === task.id
              ? 'criteria-mismatch'
              : 'unvalidated-turn'
      }
    }

    const unlocked = new Map(m.tasks.map((t) => [t.id, t]))
    for (const task of m.tasks) {
      if (task.status === 'queued') gateOrReady(m, task, unlocked)
    }
    maybeAdvancePipeline(m)
    return persist(m)
  }

  const cancelMission = async (missionId: string): Promise<SwarmMission | null> => {
    const m = read(missionId)
    if (!m) return null
    m.cancelled = true
    m.paused = true
    for (const t of m.tasks) {
      if (
        t.status === 'running' ||
        t.status === 'ready' ||
        t.status === 'queued' ||
        t.status === 'waiting_approval' ||
        t.status === 'needs_review'
      ) {
        t.status = 'cancelled'
      }
      if (t.executionId) await adapter.cancelTask(t.executionId)
    }
    return persist(m)
  }

  return {
    async createMission(input) {
      for (const existing of listMissions(dir, input.projectId)) {
        if (!existing.cancelled) await cancelMission(existing.id)
      }
      const id = randomUUID()
      const title = input.objective.trim().slice(0, 48) || 'Misión'
      const goal: MissionGoal = {
        version: 1,
        objective: input.objective.trim(),
        constraints: input.constraints ?? [
          'Writers stay in approved worktrees. Agent CLIs run with full access (no permission prompts).'
        ],
        acceptanceCriteria: input.acceptanceCriteria ?? ['plan-presented'],
        decisionRefs: []
      }
      const mission: SwarmMission = {
        id,
        projectId: input.projectId,
        orchestratorNodeId: input.orchestratorNodeId,
        title,
        goal,
        paused: false,
        cancelled: false,
        createdAt: Date.now(),
        workspaceRoot: absoluteWorkspaceRoot(input.workspaceRoot),
        tasks: seedTasks(
          id,
          goal,
          missionRepoRoot(absoluteWorkspaceRoot(input.workspaceRoot)),
          input.orchestratorNodeId
        ),
        executions: [],
        artifacts: [],
        approvals: [],
        budget: emptyBudget(input.budgetLimitUsd, input.hardBudget === true),
        modelPolicy: input.modelPolicy === 'pinned' ? 'pinned' : 'auto',
        preferredAgent: input.preferredAgent,
        pinnedModel: input.modelPolicy === 'pinned' ? input.pinnedModel : undefined,
        permissionMode: isPermissionMode(input.permissionMode)
          ? input.permissionMode
          : MESA_FULL_ACCESS_MODE,
        launchCmdOverride: input.launchCmdOverride?.trim() || undefined,
        sharedIdentity: input.sharedIdentity === true ? true : undefined
      }
      await persist(mission)
      return mission
    },

    getMission: read,
    list: (projectId) => listMissions(dir, projectId),

    async setGoal(missionId, objective, criteria) {
      const m = read(missionId)
      if (!m || m.cancelled) return null
      m.goal = {
        ...m.goal,
        version: m.goal.version + 1,
        objective: objective.trim() || m.goal.objective,
        acceptanceCriteria: criteria?.length ? criteria : m.goal.acceptanceCriteria
      }
      for (const t of m.tasks) {
        if (t.status === 'queued' || t.status === 'ready') {
          t.goalVersion = m.goal.version
          t.instruction = briefFor(m.goal, t)
        }
        if (t.status === 'running') t.status = 'stale'
      }
      return persist(m)
    },

    async setWorkspaceRoot(missionId, workspaceRoot) {
      const m = read(missionId)
      if (!m || m.cancelled) return null
      const root = absoluteWorkspaceRoot(workspaceRoot)
      if (!root) return persist(m)
      if (m.workspaceRoot && m.workspaceRoot !== root) return persist(m)
      const executed = m.tasks.some(
        (t) =>
          t.roleId !== 'O' &&
          (t.status === 'running' ||
            t.status === 'accepted' ||
            t.status === 'failed' ||
            t.status === 'needs_review' ||
            t.status === 'validating')
      )
      if (m.workspaceRoot && executed) return persist(m)
      m.workspaceRoot = root
      for (const t of m.tasks) {
        const planned = planWorkspace(t.roleId, root)
        t.workspace = {
          kind: planned.kind,
          pathHint: planned.pathHint,
          branch: planned.branch,
          baseRef: planned.baseRef
        }
      }
      for (const a of m.approvals) {
        if (a.status === 'pending' && a.blockedReason === 'no-workspace-root') {
          a.blockedReason = undefined
        }
      }
      return persist(m)
    },

    async activateRole(missionId, roleId) {
      const m = read(missionId)
      if (!m || m.cancelled || m.paused) return null
      const chain: SwarmRoleId[] = []
      if (roleId.length === 2) chain.push(roleId[0] as SwarmRoleId)
      chain.push(roleId)
      for (const id of chain) addRole(m, id, id === roleId)
      return persist(m)
    },

    async bindRole(missionId, roleId, nodeId, launch) {
      const m = read(missionId)
      if (!m || m.cancelled) return null
      const task = m.tasks.find((t) => t.roleId === roleId)
      if (!task) return null
      task.nodeId = nodeId
      if (launch?.agentId) task.agentId = launch.agentId
      if (launch?.agentModel) task.agentModel = launch.agentModel
      if (launch?.agentSessionId) task.agentSessionId = launch.agentSessionId
      return persist(m)
    },

    tick(missionId) {
      const existing = tickLock.get(missionId)
      if (existing) return existing
      const run = doTick(missionId).finally(() => {
        if (tickLock.get(missionId) === run) tickLock.delete(missionId)
      })
      tickLock.set(missionId, run)
      return run
    },

    async approve(missionId, approvalId) {
      const m = read(missionId)
      if (!m) return null
      const a = m.approvals.find((x) => x.id === approvalId)
      if (!a || a.status !== 'pending') return m
      await applyApproval(m, a)
      maybeAdvancePipeline(m)
      return persist(m)
    },

    async pause(missionId) {
      const m = read(missionId)
      if (!m) return null
      m.paused = true
      return persist(m)
    },

    async resume(missionId) {
      const m = read(missionId)
      if (!m || m.cancelled) return null
      m.paused = false
      return persist(m)
    },

    async cancel(missionId) {
      return cancelMission(missionId)
    }
  }
}
