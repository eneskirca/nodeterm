import { integrationChoice, type AgentIntegrationConsent } from '../shared/agent-integrations'
import type { SshConnection } from '../shared/ssh'

// Published ONLY from a successfully persisted SettingsStore snapshot. Default is no consent,
// including during early startup and in headless shells. Tests may inject a fixture snapshot.
let consent: AgentIntegrationConsent | undefined
export function setIntegrationConsent(value: AgentIntegrationConsent | undefined): void { consent = value }
export function agentIntegrationChoice(agent: string, conn?: SshConnection): boolean | undefined {
  return integrationChoice(consent, agent, conn)
}
export function agentIntegrationAllowed(agent: string, conn?: SshConnection): boolean {
  return agentIntegrationChoice(agent, conn) === true
}
