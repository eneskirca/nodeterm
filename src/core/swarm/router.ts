import {
  capabilityAgentId,
  canSwitchModel,
  canUseModelFlag,
  hasSharedIdentity,
  type AgentId
} from '../../shared/agents/config'
import type { CustomAgent } from '../../shared/types'
import type { SwarmMission, SwarmTask } from '../../shared/swarm/types'
import { MESA_FULL_ACCESS_MODE } from '../../shared/swarm/schemas'
import type { AdapterCapabilities } from './adapters/types'

export interface RouteChoice {
  adapterId: string
  agentId: AgentId
  model?: string
  policy: 'auto' | 'pinned'
  sessionId?: string
  permissionMode?: import('../../shared/agents/config').AgentPermissionMode
  launchCmdOverride?: string
  customAgent?: CustomAgent
  sharedIdentity?: boolean
}

export function routeForRole(opts: {
  roleId: string
  preferredAgent?: AgentId
  pinnedModel?: string
  policy?: 'auto' | 'pinned'
  adapterId?: string
  adapterCaps: AdapterCapabilities
}): RouteChoice {
  const agentId = opts.preferredAgent ?? 'claude'
  const policy = opts.policy ?? 'auto'
  const model =
    policy === 'pinned' && opts.pinnedModel
      ? opts.pinnedModel
      : canSwitchModel(agentId) || canUseModelFlag(agentId)
        ? opts.pinnedModel
        : undefined
  return {
    adapterId: opts.adapterId ?? (opts.adapterCaps.structuredResults ? 'structured' : 'manual'),
    agentId,
    model,
    policy
  }
}

export function harnessOf(agentId: AgentId): AgentId {
  return capabilityAgentId(agentId)
}

export function resolveTaskRoute(
  task: SwarmTask,
  extras: {
    node?: { agentId?: string; agentModel?: string; agentSessionId?: string } | null
    mission?: Pick<
      SwarmMission,
      | 'modelPolicy'
      | 'preferredAgent'
      | 'pinnedModel'
      | 'permissionMode'
      | 'launchCmdOverride'
      | 'sharedIdentity'
    > | null
  },
  adapterCaps: AdapterCapabilities,
  adapterId = 'cli-launch'
): RouteChoice {
  const preferred = (task.agentId || extras.node?.agentId || extras.mission?.preferredAgent || 'grok') as AgentId
  const policy = extras.mission?.modelPolicy === 'pinned' ? 'pinned' : 'auto'
  const pinned = task.agentModel || extras.node?.agentModel || extras.mission?.pinnedModel
  const routed = routeForRole({
    roleId: task.roleId,
    preferredAgent: preferred,
    pinnedModel: pinned,
    policy,
    adapterId,
    adapterCaps
  })
  const sessionId = task.agentSessionId || extras.node?.agentSessionId
  const permissionMode = extras.mission?.permissionMode ?? MESA_FULL_ACCESS_MODE
  const launchCmdOverride =
    extras.mission?.launchCmdOverride && preferred === extras.mission.preferredAgent
      ? extras.mission.launchCmdOverride
      : undefined
  const sharedIdentity = extras.mission?.sharedIdentity === true && hasSharedIdentity(preferred)
  return {
    ...routed,
    ...(sessionId ? { sessionId } : {}),
    ...(permissionMode ? { permissionMode } : {}),
    ...(launchCmdOverride ? { launchCmdOverride } : {}),
    ...(sharedIdentity ? { sharedIdentity: true } : {})
  }
}
