import type { AgentId, AgentPermissionMode } from '@shared/agents/config'
import { MESA_FULL_ACCESS_MODE } from '@shared/swarm/schemas'
import { AGENT_CONFIG, BUILTIN_AGENT_IDS, canSwitchModel, capabilityAgentId } from '@shared/agents/config'
import { DEFAULT_GROK_MODEL, GROK_MODELS } from '@shared/agents/grok-models'
import type { GatewayModel } from '@shared/agents/model-gateway'
import { modelsForAgent } from '@shared/agents/model-gateway'

export interface MesaModelOption {
  id: string
  label: string
}

export interface MesaAgentOption {
  id: AgentId
  label: string
}

/** Agents Mesa can mint as a bot: enabled builtins plus the user's custom CLIs. */
export function mesaAgentOptions(opts: {
  customAgents: ReadonlyArray<{ id: string; label: string }>
  disabledAgents: readonly string[]
}): MesaAgentOption[] {
  const off = new Set(opts.disabledAgents)
  const builtins = BUILTIN_AGENT_IDS.filter((id) => !off.has(id)).map((id) => ({
    id,
    label: AGENT_CONFIG[id].label
  }))
  const customs = opts.customAgents
    .filter((c) => !off.has(c.id))
    .map((c) => ({ id: c.id as AgentId, label: c.label }))
  return [...builtins, ...customs]
}

/**
 * Models a Mesa bot of this agent can pick. Grok uses its native CLI catalogue;
 * gateway-capable agents use discovered models; everyone else has none (CLI default).
 */
export function mesaModelsFor(agentId: AgentId, gatewayModels: readonly GatewayModel[]): MesaModelOption[] {
  if (capabilityAgentId(agentId) === 'grok') {
    return GROK_MODELS.map((m) => ({ id: m.id, label: m.label }))
  }
  if (canSwitchModel(agentId)) {
    return modelsForAgent(gatewayModels as GatewayModel[], agentId).map((m) => ({
      id: m.id,
      label: m.name ? `${m.name} (${m.id})` : m.id
    }))
  }
  return []
}

/** Pre-select a model when the agent has a catalogue; otherwise leave the CLI's own default. */
export function mesaDefaultModel(agentId: AgentId, gatewayModels: readonly GatewayModel[]): string {
  if (capabilityAgentId(agentId) === 'grok') return DEFAULT_GROK_MODEL
  return mesaModelsFor(agentId, gatewayModels)[0]?.id ?? ''
}

/**
 * Host-owned worker mint. Composer «Nuevo bot» must not change which CLI /activate materializes.
 * Auto policy leaves `model` unset so Canvas can still stamp grok's native default.
 */
export function workerLaunchSpec(opts: {
  preferredAgent?: string
  modelPolicy?: 'auto' | 'pinned'
  pinnedModel?: string
  fallbackAgent?: AgentId
}): { agentId: AgentId; model?: string; runtime: true; permissionMode: AgentPermissionMode } {
  const agentId = (opts.preferredAgent || opts.fallbackAgent || 'grok') as AgentId
  const model =
    opts.modelPolicy === 'pinned' && opts.pinnedModel ? opts.pinnedModel : undefined
  return { agentId, model, runtime: true, permissionMode: MESA_FULL_ACCESS_MODE }
}
