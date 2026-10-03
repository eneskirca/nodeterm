// Test helper: a consent plan that enables every agent on every host — the pre-#744 behaviour the
// older remote-hooks suites were written against. Production never uses it.
import { INTEGRATION_AGENT_IDS } from '../../shared/agent-integrations'
import type { RemoteIntegrationPlan } from './remote-hooks'

export const ALL_REMOTE_INTEGRATION: RemoteIntegrationPlan = {
  install: new Set(INTEGRATION_AGENT_IDS),
  remove: new Set(),
  decided: true
}
export const allRemote = (): RemoteIntegrationPlan => ALL_REMOTE_INTEGRATION
