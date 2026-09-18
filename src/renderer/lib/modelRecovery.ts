import type { GatewayModel, ModelGatewaySettings } from '@shared/agents/model-gateway'
import type { ModelDiscoveryStatus } from '../state/modelGateway'

export interface ModelRecoveryCatalogueSnapshot {
  models: readonly GatewayModel[]
  status: ModelDiscoveryStatus
}

/** A recovery decision needs a successful, non-empty catalogue. Empty/error/loading is no proof. */
export function catalogueForModelRecovery(
  snapshot: ModelRecoveryCatalogueSnapshot
): readonly GatewayModel[] | null {
  return snapshot.status === 'ready' && snapshot.models.length > 0 ? snapshot.models : null
}

/** Refresh once using the gateway configuration that is current when the refresh is invoked. */
export async function refreshModelRecoveryCatalogue(
  readSettings: () => ModelGatewaySettings,
  discover: (settings: ModelGatewaySettings) => Promise<void>
): Promise<void> {
  await discover({ ...readSettings() })
}
