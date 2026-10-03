// IPC for the agent-integration consent lifecycle (issue #744). The choice itself rides
// settings.json (`settings:save`, then `SettingsStore.onChange` → `onSettingsChanged`); this only
// reports what the last reconcile did, for Settings → Agents. Registered by BOTH shells.
import { IPC } from '../shared/ipc'
import type { AgentIntegrationsStatus } from '../shared/agent-integrations'
import { platform } from './platform'
import type { IntegrationLifecycle } from './agent-integrations'

export function registerIntegrationIpc(lc: IntegrationLifecycle): void {
  platform().handle(IPC.integrationsStatus, (): AgentIntegrationsStatus => {
    const r = lc.lastReport()
    return r
      ? { enabled: r.enabled, declined: r.declined, retained: r.retained, vetoed: r.vetoed }
      : { enabled: [], declined: [], retained: [], vetoed: false }
  })
}
