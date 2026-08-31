import { IPC } from '@shared/ipc'
import type { CorePlatform } from './platform'
import {
  agentStatusSnapshot,
  applyRecoveredAgentStatus
} from './agent-status-mirror'
import { recoverAgentStatusSnapshot, type RecoverSnapshotOptions } from './agent-status-recovery'

/** Shared Desktop/Server registration for restart-safe, display-only status hydration. */
export function registerAgentStatusHandlers(
  platform: CorePlatform,
  recovery: RecoverSnapshotOptions = {}
): void {
  platform.handle(IPC.agentStatusSnapshot, async () => {
    const baseline = agentStatusSnapshot()
    const recovered = await recoverAgentStatusSnapshot(baseline, recovery)
    for (const [nodeId, evidence] of Object.entries(recovered)) {
      applyRecoveredAgentStatus(nodeId, evidence)
    }
    return agentStatusSnapshot()
  })
}
