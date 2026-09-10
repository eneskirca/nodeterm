import type { NormalizedAgentEvent } from '../../shared/agents/normalize'
import { hasSharedIdentity, isPermissionMode, type BuiltinAgentId } from '../../shared/agents/config'
import { IPC } from '../../shared/ipc'
import { isSafeNodeId } from '../../shared/safe-id'
import { isSwarmRoleId } from '../../shared/swarm/schemas'
import type { Settings } from '../../shared/types'
import type { CreateMissionInput, SwarmMission } from '../../shared/swarm/types'
import { handleCliLine, type MesaCliRuntime } from '../../tui/mesa-cli'
import { createSwarmAdapter, swarmAdapterMode } from './adapters/select'
import { resolveTaskRoute } from './router'
import { startSwarmRuntime, type SwarmRuntime } from './runtime'
import { startTuiChannel, tuiLaunchDecision, type TuiChannel } from './tui-channel'
import { isSwarmTurnEndedEvent, swarmHookKind } from './turn-ended'

export interface SwarmService {
  runtime: SwarmRuntime
  tui?: TuiChannel
  /** Host-owned. Mesa UI must not be the completion authority. */
  onAgentEvent: (event: NormalizedAgentEvent) => void
  stop: () => void
}

function asString(v: unknown): string | null {
  return typeof v === 'string' && v.trim() && v.length <= 4000 ? v : null
}

function runtimeFor(
  runtime: SwarmRuntime,
  missionId: string,
  publish: (m: SwarmMission | null) => SwarmMission | null
): MesaCliRuntime {
  return {
    load: () => runtime.getMission(missionId),
    setGoal: async (objective) => publish(await runtime.setGoal(missionId, objective)),
    pause: async () => publish(await runtime.pause(missionId)),
    resume: async () => {
      const m = await runtime.resume(missionId)
      if (!m) return publish(null)
      return publish(await runtime.tick(missionId))
    },
    cancel: async () => publish(await runtime.cancel(missionId)),
    approve: async (id) => {
      const m = await runtime.approve(missionId, id)
      if (!m) return publish(null)
      return publish(await runtime.tick(missionId))
    },
    activate: async (roleId) => {
      if (!isSwarmRoleId(roleId)) return publish(null)
      const activated = await runtime.activateRole(missionId, roleId)
      if (!activated) return publish(null)
      return publish(await runtime.tick(missionId))
    }
  }
}

export function startSwarmService(deps: {
  userDataDir: string
  handle: (channel: string, handler: (...args: unknown[]) => unknown) => void
  sendText?: (nodeId: string, text: string, opts?: { enter?: boolean }) => Promise<boolean>
  paneCommand?: (nodeId: string) => Promise<string | null>
  getNode?: (nodeId: string) => { agentId?: string; agentModel?: string; agentSessionId?: string } | undefined
  getSettings?: () => Pick<Settings, 'agentLaunchCommands' | 'customAgents'>
  broadcast?: (channel: string, ...args: unknown[]) => void
  ensureWorktree?: (plan: {
    repoRoot: string
    path: string
    branch: string
    baseRef: string
  }) => Promise<{ ok: boolean }>
  env?: NodeJS.ProcessEnv
}): SwarmService {
  let runtime!: SwarmRuntime
  const env = deps.env ?? process.env
  const adapter = createSwarmAdapter({
    userDataDir: deps.userDataDir,
    sendText: deps.sendText,
    paneCommand: deps.paneCommand,
    env,
    resolveLaunch: (task) => {
      const route = resolveTaskRoute(
        task,
        {
          node: task.nodeId ? deps.getNode?.(task.nodeId) : undefined,
          mission: runtime?.getMission(task.missionId)
        },
        {
          structuredResults: true,
          usageReporting: 'none',
          cancellation: true,
          modelSelection: 'launch',
          hardBudgetEnforcement: false
        }
      )
      const settings = deps.getSettings?.()
      const launchCmdOverride =
        route.launchCmdOverride || settings?.agentLaunchCommands?.[route.agentId as BuiltinAgentId]
      const customAgent = settings?.customAgents?.find((c) => c.id === route.agentId)
      const sharedIdentity = route.sharedIdentity === true && hasSharedIdentity(route.agentId)
      return {
        ...route,
        ...(launchCmdOverride ? { launchCmdOverride } : {}),
        ...(customAgent ? { customAgent } : {}),
        ...(sharedIdentity ? { sharedIdentity: true } : {})
      }
    }
  })
  runtime = startSwarmRuntime({
    userDataDir: deps.userDataDir,
    adapter,
    ensureWorktree: deps.ensureWorktree,
    homeDir: process.env.HOME
  })
  const publish = (m: SwarmMission | null): SwarmMission | null => {
    if (m && deps.broadcast) deps.broadcast(IPC.swarmChanged, m)
    return m
  }
  let tui: TuiChannel | undefined
  const ready = startTuiChannel({
    userDataDir: deps.userDataDir,
    execPath: process.execPath,
    onLine: async (missionId, line) => {
      if (!missionId || !isSafeNodeId(missionId)) return { reply: 'Misión desconocida.' }
      const out = await handleCliLine(line, runtimeFor(runtime, missionId, publish))
      return { reply: out.reply }
    }
  }).then((ch) => {
    tui = ch
    return ch
  })

  const missionIdOf = (payload: unknown): string | null => {
    const id = (payload as { missionId?: unknown })?.missionId
    return typeof id === 'string' && isSafeNodeId(id) ? id : null
  }

  const pulseOf = (m: SwarmMission) =>
    m.tasks.map((t) => `${t.roleId}:${t.status}`).join(' ') +
    (m.budget.blockedReason ? ` budget:${m.budget.blockedReason}` : '') +
    ` appr:${m.approvals.filter((a) => a.status === 'pending').length}`

  const tickOpen = () => {
    for (const m of runtime.list()) {
      if (m.cancelled || m.paused) continue
      const before = pulseOf(m)
      void runtime.tick(m.id).then((after) => {
        if (!after) return
        publish(after)
        if (!tui) return
        const pulse = pulseOf(after)
        if (pulse === before) return
        tui.pushEvent(after.id, `mesa › ${pulse}`)
      })
    }
  }
  const timer = setInterval(tickOpen, 2000)

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

  const inflight = new Map<string, Promise<{ ok: boolean; running: boolean }>>()
  const launching = new Set<string>()
  const LAUNCH_SETTLE_MS = 8_000
  // Mesa is often the first spawner. create() races ModalTerminal/TerminalNode
  // by seconds, not 400 ms. A short wait plus no retry left the pane on zsh
  // ("Consola desconectada") until the human hit Reconectar.
  const PANE_WAIT_ATTEMPTS = 20

  const ensureTui = async (missionId: string, nodeId: string): Promise<{ ok: boolean; running: boolean }> => {
    const existing = inflight.get(nodeId)
    if (existing) return existing
    const run = (async () => {
      const ch = tui ?? (await ready)
      const launch = `NODETERM_SWARM_MISSION=${missionId} ${ch.launchCommand()}`
      for (let attempt = 0; attempt < PANE_WAIT_ATTEMPTS; attempt++) {
        const pane = deps.paneCommand ? await deps.paneCommand(nodeId) : null
        const decision = tuiLaunchDecision(pane)
        if (decision === 'running') {
          launching.delete(nodeId)
          return { ok: true, running: true }
        }
        if (decision === 'launch' && deps.sendText) {
          // create + TableView both call ensureTui while the pane is still a shell.
          // Two launch lines destroy the TUI. Coalesce until the pane is `node` or the settle lapses.
          if (launching.has(nodeId)) return { ok: true, running: false }
          launching.add(nodeId)
          const ok = await deps.sendText(nodeId, launch, { enter: true })
          if (!ok) {
            // Session exists as a name but paste missed (no client yet). Keep waiting.
            launching.delete(nodeId)
            await sleep(400)
            continue
          }
          setTimeout(() => launching.delete(nodeId), LAUNCH_SETTLE_MS)
          return { ok, running: false }
        }
        if (!deps.paneCommand) break
        await sleep(400)
      }
      return { ok: false, running: false }
    })()
    inflight.set(nodeId, run)
    void run.finally(() => {
      if (inflight.get(nodeId) === run) inflight.delete(nodeId)
    })
    return run
  }

  deps.handle(IPC.swarmCreate, async (payload) => {
    const p = (payload ?? {}) as Partial<CreateMissionInput>
    const projectId = asString(p.projectId)
    const orchestratorNodeId = asString(p.orchestratorNodeId)
    const objective = asString(p.objective)
    if (!projectId || !orchestratorNodeId || !objective) return null
    if (!isSafeNodeId(projectId) || !isSafeNodeId(orchestratorNodeId)) return null
    const mission = await runtime.createMission({
      projectId,
      orchestratorNodeId,
      objective,
      constraints: Array.isArray(p.constraints) ? p.constraints.filter((x): x is string => typeof x === 'string') : undefined,
      acceptanceCriteria: Array.isArray(p.acceptanceCriteria)
        ? p.acceptanceCriteria.filter((x): x is string => typeof x === 'string')
        : undefined,
      budgetLimitUsd: typeof p.budgetLimitUsd === 'number' ? p.budgetLimitUsd : undefined,
      hardBudget: p.hardBudget === true,
      workspaceRoot: asString(p.workspaceRoot) ?? undefined,
      modelPolicy: p.modelPolicy === 'pinned' ? 'pinned' : 'auto',
      preferredAgent: asString(p.preferredAgent) ?? undefined,
      pinnedModel: asString(p.pinnedModel) ?? undefined,
      permissionMode: isPermissionMode(p.permissionMode) ? p.permissionMode : undefined,
      launchCmdOverride: asString(p.launchCmdOverride) ?? undefined,
      sharedIdentity: p.sharedIdentity === true ? true : undefined
    })
    void ensureTui(mission.id, orchestratorNodeId)
    return publish(mission)
  })

  deps.handle(IPC.swarmGet, async (payload) => {
    const id = missionIdOf(payload)
    return id ? runtime.getMission(id) : null
  })

  deps.handle(IPC.swarmList, async (payload) => {
    const projectId = asString((payload as { projectId?: unknown })?.projectId)
    if (projectId && !isSafeNodeId(projectId)) return []
    return runtime.list(projectId ?? undefined)
  })

  deps.handle(IPC.swarmSetGoal, async (payload) => {
    const p = (payload ?? {}) as { missionId?: unknown; objective?: unknown; criteria?: unknown }
    const id = typeof p.missionId === 'string' && isSafeNodeId(p.missionId) ? p.missionId : null
    const objective = asString(p.objective)
    if (!id || !objective) return null
    const criteria = Array.isArray(p.criteria) ? p.criteria.filter((x): x is string => typeof x === 'string') : undefined
    return publish(await runtime.setGoal(id, objective, criteria))
  })

  deps.handle(IPC.swarmSetWorkspace, async (payload) => {
    const p = (payload ?? {}) as { missionId?: unknown; workspaceRoot?: unknown }
    const id = typeof p.missionId === 'string' && isSafeNodeId(p.missionId) ? p.missionId : null
    const root = asString(p.workspaceRoot)
    if (!id || !root) return null
    return publish(await runtime.setWorkspaceRoot(id, root))
  })

  deps.handle(IPC.swarmActivate, async (payload) => {
    const p = (payload ?? {}) as { missionId?: unknown; roleId?: unknown }
    const id = typeof p.missionId === 'string' && isSafeNodeId(p.missionId) ? p.missionId : null
    if (!id || !isSwarmRoleId(p.roleId)) return null
    const activated = await runtime.activateRole(id, p.roleId)
    if (!activated) return publish(null)
    return publish(await runtime.tick(id))
  })

  deps.handle(IPC.swarmBind, async (payload) => {
    const p = (payload ?? {}) as {
      missionId?: unknown
      roleId?: unknown
      nodeId?: unknown
      agentId?: unknown
      agentModel?: unknown
      agentSessionId?: unknown
    }
    const id = typeof p.missionId === 'string' && isSafeNodeId(p.missionId) ? p.missionId : null
    const nodeId = typeof p.nodeId === 'string' && isSafeNodeId(p.nodeId) ? p.nodeId : null
    if (!id || !nodeId || !isSwarmRoleId(p.roleId)) return null
    const fromNode = deps.getNode?.(nodeId)
    return publish(
      await runtime.bindRole(id, p.roleId, nodeId, {
        agentId: asString(p.agentId) ?? fromNode?.agentId,
        agentModel: asString(p.agentModel) ?? fromNode?.agentModel,
        agentSessionId: asString(p.agentSessionId) ?? fromNode?.agentSessionId
      })
    )
  })

  deps.handle(IPC.swarmTick, async (payload) => {
    const id = missionIdOf(payload)
    return id ? publish(await runtime.tick(id)) : null
  })

  deps.handle(IPC.swarmApprove, async (payload) => {
    const p = (payload ?? {}) as { missionId?: unknown; approvalId?: unknown }
    const id = typeof p.missionId === 'string' && isSafeNodeId(p.missionId) ? p.missionId : null
    const approvalId = asString(p.approvalId)
    if (!id || !approvalId || !isSafeNodeId(approvalId)) return null
    const approved = await runtime.approve(id, approvalId)
    if (!approved) return publish(null)
    return publish(await runtime.tick(id))
  })

  deps.handle(IPC.swarmPause, async (payload) => {
    const id = missionIdOf(payload)
    return id ? publish(await runtime.pause(id)) : null
  })

  deps.handle(IPC.swarmResume, async (payload) => {
    const id = missionIdOf(payload)
    if (!id) return null
    const resumed = await runtime.resume(id)
    if (!resumed) return publish(null)
    return publish(await runtime.tick(id))
  })

  deps.handle(IPC.swarmCancel, async (payload) => {
    const id = missionIdOf(payload)
    return id ? publish(await runtime.cancel(id)) : null
  })

  deps.handle(IPC.swarmEnsureTui, async (payload) => {
    const p = (payload ?? {}) as { missionId?: unknown; nodeId?: unknown }
    const id = typeof p.missionId === 'string' && isSafeNodeId(p.missionId) ? p.missionId : null
    const nodeId = typeof p.nodeId === 'string' && isSafeNodeId(p.nodeId) ? p.nodeId : null
    if (!id || !nodeId) return { ok: false, running: false }
    const mission = runtime.getMission(id)
    // Role O's pane is the TUI. Never type the launch line into a worker.
    if (!mission || mission.orchestratorNodeId !== nodeId) return { ok: false, running: false }
    return ensureTui(id, nodeId)
  })

  deps.handle(IPC.swarmCaps, async () => ({
    mode: swarmAdapterMode(env),
    adapterId: adapter.id
  }))

  deps.handle(IPC.swarmNoteIdle, async (payload) => {
    const p = (payload ?? {}) as { nodeId?: unknown; executionId?: unknown; launchGeneration?: unknown }
    const nodeId = asString(p.nodeId)
    const executionId = asString(p.executionId)
    if (!nodeId || !executionId || !isSafeNodeId(nodeId) || !isSafeNodeId(executionId) || !adapter.noteTurnEnded) {
      return { ok: false }
    }
    let matched: { missionId: string; taskId: string; attempt: number; sessionId?: string } | null = null
    for (const m of runtime.list()) {
      if (m.cancelled || m.paused) continue
      const task = m.tasks.find(
        (t) => t.executionId === executionId && t.nodeId === nodeId && t.status === 'running'
      )
      if (!task) continue
      const exec = m.executions.find((e) => e.id === executionId)
      matched = {
        missionId: m.id,
        taskId: task.id,
        attempt: exec?.attempt && exec.attempt >= 1 ? exec.attempt : 1,
        sessionId: task.agentSessionId
      }
      break
    }
    if (!matched) return { ok: false }
    const ok = await adapter.noteTurnEnded({
      eventId: `ipc:${executionId}:${Date.now()}`,
      missionId: matched.missionId,
      taskId: matched.taskId,
      executionId,
      nodeId,
      launchGeneration: matched.attempt,
      observedAt: Date.now(),
      source: 'hook',
      hookKind: 'stop',
      ...(matched.sessionId ? { sessionId: matched.sessionId } : {})
    })
    if (!ok) return { ok: false }
    for (const m of runtime.list()) {
      if (m.cancelled || m.paused) continue
      if (!m.tasks.some((t) => t.executionId === executionId && t.status === 'running')) continue
      publish(await runtime.tick(m.id))
    }
    return { ok: true }
  })

  const onAgentEvent = (event: NormalizedAgentEvent): void => {
    if (!isSwarmTurnEndedEvent(event) || !adapter.noteTurnEnded) return
    if (!event.nodeId || !isSafeNodeId(event.nodeId)) return
    void (async () => {
      for (const m of runtime.list()) {
        if (m.cancelled || m.paused) continue
        const task = m.tasks.find(
          (t) => t.nodeId === event.nodeId && t.status === 'running' && t.executionId
        )
        if (!task?.executionId) continue
        const exec = m.executions.find((e) => e.id === task.executionId)
        const ok = await adapter.noteTurnEnded!({
          eventId: `${event.nodeId}:${task.executionId}:${event.sessionId ?? 'nosession'}:${event.state ?? event.sessionPhase ?? 'done'}`,
          missionId: m.id,
          taskId: task.id,
          executionId: task.executionId,
          nodeId: event.nodeId,
          launchGeneration: exec?.attempt && exec.attempt >= 1 ? exec.attempt : 1,
          observedAt: Date.now(),
          source: 'hook',
          hookKind: swarmHookKind(event),
          ...(event.sessionId ? { sessionId: event.sessionId } : {})
        })
        if (ok) publish(await runtime.tick(m.id))
      }
    })()
  }

  return {
    runtime,
    get tui() {
      return tui
    },
    onAgentEvent,
    stop: () => {
      clearInterval(timer)
      void tui?.close()
    }
  }
}

export type { SwarmMission }
