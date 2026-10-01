import { create } from 'zustand'
import {
  modelGatewayRoutes,
  type GatewayModel,
  type ModelGatewaySettings
} from '@shared/agents/model-gateway'

export type ModelDiscoveryStatus = 'idle' | 'loading' | 'ready' | 'error'

interface ModelGatewayState {
  models: GatewayModel[]
  status: ModelDiscoveryStatus
  error: string
  discover(settings: ModelGatewaySettings): Promise<void>
  clear(): void
}

// A later request supersedes an earlier one. Editing the gateway URL/key can otherwise let a slow
// response from the OLD endpoint land after the new catalogue and silently replace it.
let requestSeq = 0

/** Renderer-visible equality for catalogue provenance; resolved credentials stay in core. */
export function sameModelGatewayDiscoveryConfig(
  left: ModelGatewaySettings,
  right: ModelGatewaySettings
): boolean {
  const leftRoute = modelGatewayRoutes(left.baseUrl, left.discoveryPath)?.discovery ?? null
  const rightRoute = modelGatewayRoutes(right.baseUrl, right.discoveryPath)?.discovery ?? null
  return leftRoute === rightRoute && left.apiKey.trim() === right.apiKey.trim()
}

export const useModelGateway = create<ModelGatewayState>((set) => ({
  models: [],
  status: 'idle',
  error: '',

  async discover(settings) {
    const seq = ++requestSeq
    set({ status: 'loading', error: '' })
    const result = await window.nodeTerminal.agent
      .discoverModels(settings)
      .catch((err: unknown) => ({
        models: [],
        error: err instanceof Error ? err.message : 'Model discovery failed.'
      }))
    if (seq !== requestSeq) return
    set({
      models: result.models,
      status: result.error ? 'error' : 'ready',
      error: result.error ?? ''
    })
  },

  clear() {
    requestSeq++
    set({ models: [], status: 'idle', error: '' })
  }
}))
