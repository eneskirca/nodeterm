import { create } from 'zustand'
import type { GatewayModel, ModelGatewaySettings } from '@shared/agents/model-gateway'
import { gatewayCatalogueKey } from '../lib/modelRefusal'

export type ModelDiscoveryStatus = 'idle' | 'loading' | 'ready' | 'error'

interface ModelGatewayState {
  models: GatewayModel[]
  status: ModelDiscoveryStatus
  error: string
  /** `gatewayCatalogueKey` of the settings the current `models`/`status` answer belongs to — the
   *  open-time `--model` check (lib/modelRefusal.ts) trusts the list only for the settings it was
   *  read for, never across an edit. */
  forKey: string | null
  discover(settings: ModelGatewaySettings): Promise<void>
  clear(): void
}

// A later request supersedes an earlier one. Editing the gateway URL/key can otherwise let a slow
// response from the OLD endpoint land after the new catalogue and silently replace it.
let requestSeq = 0

export const useModelGateway = create<ModelGatewayState>((set) => ({
  models: [],
  status: 'idle',
  error: '',
  forKey: null,

  async discover(settings) {
    const seq = ++requestSeq
    set({ status: 'loading', error: '', forKey: gatewayCatalogueKey(settings) })
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
    set({ models: [], status: 'idle', error: '', forKey: null })
  }
}))
