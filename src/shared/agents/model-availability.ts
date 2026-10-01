import type { AgentId } from './config'
import {
  claudeAutocompactFor,
  modelContextWindow,
  type GatewayModel
} from './model-gateway'

export type ModelRecoveryReason = 'gone' | 'win' | 'shape'

export interface ModelAvailability {
  unavailable: boolean
  modelId: string
}

/** Presence check tolerant of the launch-only `[1m]` suffix. Empty discovery cannot judge. */
export function modelAvailability(
  nodeModel: string | undefined,
  models: readonly GatewayModel[]
): ModelAvailability {
  const modelId = nodeModel?.trim() ?? ''
  if (!modelId || models.length === 0) return { unavailable: false, modelId }
  const base = modelId.replace(/\[1m\]$/, '')
  const listed = models.some((model) => model.id.replace(/\[1m\]$/, '') === base)
  return { unavailable: !listed, modelId }
}

export interface ModelWindowChange {
  changed: boolean
  contextWindow: number | ''
  fresh: boolean
}

/** Compare a reported window with a persisted launch value or a legacy observation ledger. */
export function modelWindowChange(
  nodeModel: string | undefined,
  models: readonly GatewayModel[],
  lastSeen: number | undefined
): ModelWindowChange {
  const modelId = nodeModel?.trim() ?? ''
  if (!modelId) return { changed: false, contextWindow: '', fresh: false }
  const current = modelContextWindow(modelId, models)
  if (current === undefined) return { changed: false, contextWindow: '', fresh: false }
  if (lastSeen === undefined) return { changed: false, contextWindow: current, fresh: true }
  return {
    changed: Number.isFinite(lastSeen) && current !== lastSeen,
    contextWindow: current,
    fresh: false
  }
}

export function modelWindowKey(nodeModel: string): string {
  return nodeModel.trim().replace(/\[1m\]$/, '')
}

export function modelWindowSessionKey(nodeId: string, nodeModel: string): string {
  return `${nodeId}:${modelWindowKey(nodeModel)}`
}

/** Whether today's assembler would emit a different exact id for this launch record. */
export function modelLaunchShapeMismatch(
  agentId: AgentId,
  launchModel: string | undefined,
  models: readonly GatewayModel[]
): boolean {
  const modelId = launchModel?.trim()
  if (!modelId || models.length === 0 || modelAvailability(modelId, models).unavailable) {
    return false
  }
  const today = claudeAutocompactFor(agentId, modelId, models).modelId
  return today != null && today !== modelId
}

/**
 * Decide whether one actual launch record needs recovery. Every trigger fails closed when the
 * record it needs is absent: requested-only legacy nodes cannot prove what their process runs.
 */
export function modelRecoveryTrigger(
  agentId: AgentId,
  launchModel: string | undefined,
  launchContextWindow: number | undefined,
  models: readonly GatewayModel[]
): ModelRecoveryReason | null {
  const modelId = launchModel?.trim()
  if (!modelId || models.length === 0) return null
  if (modelAvailability(modelId, models).unavailable) return 'gone'

  const currentWindow = modelContextWindow(modelId, models)
  if (
    typeof launchContextWindow === 'number' &&
    Number.isFinite(launchContextWindow) &&
    launchContextWindow > 0 &&
    currentWindow !== undefined &&
    currentWindow !== launchContextWindow
  ) {
    return 'win'
  }
  return modelLaunchShapeMismatch(agentId, modelId, models) ? 'shape' : null
}

export interface ModelRecoveryCure {
  cured: boolean
  detail?: string
}

/** Verify a completed restart from the actual record written by the accepted launch path. */
export function modelRecoveryCure(
  reason: ModelRecoveryReason,
  agentId: AgentId,
  launchModel: string | undefined,
  launchContextWindow: number | undefined,
  models: readonly GatewayModel[]
): ModelRecoveryCure {
  if (models.length === 0) {
    return { cured: false, detail: 'the current gateway catalogue is unavailable' }
  }
  const modelId = launchModel?.trim()
  if (!modelId) return { cured: false, detail: 'the restarted session reported no launch model' }

  if (modelAvailability(modelId, models).unavailable) {
    return { cured: false, detail: `the restarted model ${modelId} is not in the current catalogue` }
  }
  if (reason === 'gone') return { cured: true }

  if (reason === 'win') {
    const currentWindow = modelContextWindow(modelId, models)
    if (currentWindow === undefined) {
      return { cured: false, detail: `the gateway reported no context window for ${modelId}` }
    }
    if (
      typeof launchContextWindow !== 'number' ||
      !Number.isFinite(launchContextWindow) ||
      launchContextWindow <= 0
    ) {
      return { cured: false, detail: 'the restarted session reported no launch context window' }
    }
    return launchContextWindow === currentWindow
      ? { cured: true }
      : {
          cured: false,
          detail: `the restarted session still records ${launchContextWindow} tokens; the catalogue reports ${currentWindow}`
        }
  }

  return modelLaunchShapeMismatch(agentId, modelId, models)
    ? { cured: false, detail: `the restarted session still records the stale launch id ${modelId}` }
    : { cured: true }
}

/** Per-session, per-record key so one node never spends a sibling's prompt. */
export function modelRecoverySessionKey(
  nodeId: string,
  modelId: string,
  reason: ModelRecoveryReason,
  version: string | number
): string {
  return `model-recovery:${nodeId}:${modelId.trim()}:${reason}:${version}`
}

export { modelContextWindow } from './model-gateway'
