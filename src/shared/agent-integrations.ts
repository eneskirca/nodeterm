// Agent-integration consent (issue #744): which agents nodeterm may integrate with by writing into
// their user-owned global configuration (status hooks, skills), here and on each SSH host.
//
// Pure and shared by every side: core decides what to install from it, the renderer renders the
// choice from it, and settings.json is hand-editable, so every reader goes through `sanitize…`.
//
// THE RULE: nothing global is written for an agent unless its choice is `'enabled'`. `undefined`
// (never asked) is NOT consent — it writes nothing and removes nothing. `'declined'` writes nothing
// AND removes what we wrote. See docs/agent-integration-consent.md for the product decision.
import { AGENT_HOOK_TARGETS } from './agents/config'

/** Every agent nodeterm can integrate with = every agent it has a status hook for. */
export const INTEGRATION_AGENT_IDS = AGENT_HOOK_TARGETS
export type IntegrationAgentId = (typeof INTEGRATION_AGENT_IDS)[number]

export type IntegrationChoice = 'enabled' | 'declined'

export interface AgentIntegrationsSettings {
  /** Per-agent choice for THIS machine. Absent key = never asked. */
  agents?: Partial<Record<IntegrationAgentId, IntegrationChoice>>
  /** Per-SSH-host choice, keyed by `sshHostKey` (`user@host`) — the HOST identity only, never the
   *  identity file / port / extra args, so editing how we reach a host does not drop its consent.
   *  A host installs an agent only when BOTH the host and that agent are enabled. */
  hosts?: Record<string, IntegrationChoice>
  /** The choice for a host with no entry in `hosts`. Absent = ask. Set to `'enabled'` only by
   *  grandfathering, so SSH hosts an existing install already integrated keep working. */
  hostDefault?: IntegrationChoice
  /** How the record came to exist: `'grandfathered'` = an install from before this feature (we
   *  found our own integrations already on disk), `'asked'` = the user answered the first-run
   *  question. Absent = a new install that has not answered yet. */
  origin?: 'grandfathered' | 'asked'
  /** The grandfathered install's one-time notice was dismissed. */
  noticeDismissed?: boolean
}

const isAgent = (v: string): v is IntegrationAgentId => (INTEGRATION_AGENT_IDS as readonly string[]).includes(v)
const isChoice = (v: unknown): v is IntegrationChoice => v === 'enabled' || v === 'declined'
// Same shape the rest of the app accepts for a host key (`user@host`); anything else is dropped
// rather than carried into a log line or a UI row.
const HOST_KEY = /^[^\s@]{1,128}@[^\s@]{1,253}$/
/** Bounded: settings.json is hand-editable and every entry is a row in Settings. */
export const MAX_HOST_CHOICES = 200

/** Normalize a hand-editable value. Unknown agents, bad choices and malformed host keys are dropped. */
export function sanitizeAgentIntegrations(raw: unknown): AgentIntegrationsSettings {
  if (!raw || typeof raw !== 'object') return {}
  const r = raw as Record<string, unknown>
  const out: AgentIntegrationsSettings = {}
  if (r.agents && typeof r.agents === 'object') {
    const agents: Partial<Record<IntegrationAgentId, IntegrationChoice>> = {}
    for (const [k, v] of Object.entries(r.agents as Record<string, unknown>)) {
      if (isAgent(k) && isChoice(v)) agents[k] = v
    }
    out.agents = agents
  }
  if (r.hosts && typeof r.hosts === 'object') {
    const hosts: Record<string, IntegrationChoice> = {}
    let n = 0
    for (const [k, v] of Object.entries(r.hosts as Record<string, unknown>)) {
      if (n >= MAX_HOST_CHOICES) break
      if (HOST_KEY.test(k) && isChoice(v)) {
        hosts[k] = v
        n++
      }
    }
    out.hosts = hosts
  }
  if (isChoice(r.hostDefault)) out.hostDefault = r.hostDefault
  if (r.origin === 'grandfathered' || r.origin === 'asked') out.origin = r.origin
  if (r.noticeDismissed === true) out.noticeDismissed = true
  return out
}

type WithIntegrations = { agentIntegrations?: unknown }

export function integrationsOf(settings: WithIntegrations): AgentIntegrationsSettings {
  return sanitizeAgentIntegrations(settings.agentIntegrations)
}

/** This machine's choice for one agent. `undefined` = never asked. */
export function agentChoice(settings: WithIntegrations, agent: string): IntegrationChoice | undefined {
  return isAgent(agent) ? integrationsOf(settings).agents?.[agent] : undefined
}

export function isAgentIntegrationEnabled(settings: WithIntegrations, agent: string): boolean {
  return agentChoice(settings, agent) === 'enabled'
}

/** A host's choice: its own entry, else the default, else `undefined` (= ask). */
export function hostChoice(settings: WithIntegrations, hostKey: string): IntegrationChoice | undefined {
  const s = integrationsOf(settings)
  return s.hosts?.[hostKey] ?? s.hostDefault
}

/** The agents nodeterm may integrate with on one SSH host: host enabled AND agent enabled. */
export function remoteIntegrationAgents(settings: WithIntegrations, hostKey: string): IntegrationAgentId[] {
  if (hostChoice(settings, hostKey) !== 'enabled') return []
  return INTEGRATION_AGENT_IDS.filter((a) => isAgentIntegrationEnabled(settings, a))
}

/** What nodeterm may do on one SSH host: install for the agents enabled both here and for that
 *  host; remove what it wrote for the rest once the host has an answer. An unanswered host gets
 *  neither — nothing is written AND nothing is removed until the user says. */
export function remoteIntegrationPlan(
  settings: WithIntegrations,
  hostKey: string
): { install: IntegrationAgentId[]; remove: IntegrationAgentId[]; decided: boolean } {
  const choice = hostChoice(settings, hostKey)
  if (choice === undefined) return { install: [], remove: [], decided: false }
  if (choice === 'declined') return { install: [], remove: [...INTEGRATION_AGENT_IDS], decided: true }
  const s = integrationsOf(settings)
  return {
    install: INTEGRATION_AGENT_IDS.filter((a) => s.agents?.[a] === 'enabled'),
    remove: INTEGRATION_AGENT_IDS.filter((a) => s.agents?.[a] === 'declined'),
    decided: true
  }
}

/** A new install that has not answered the first-run question: ask before writing anything. */
export function needsIntegrationPrompt(settings: WithIntegrations): boolean {
  const s = integrationsOf(settings)
  return !s.origin && Object.keys(s.agents ?? {}).length === 0
}

/** A grandfathered install that has not dismissed the one-time notice. */
export function needsGrandfatherNotice(settings: WithIntegrations): boolean {
  const s = integrationsOf(settings)
  return s.origin === 'grandfathered' && !s.noticeDismissed
}

/** The record an install from before this feature gets: everything it already had stays on, so
 *  nobody's badges or canvas control silently stop on upgrade. */
export function grandfatheredIntegrations(): AgentIntegrationsSettings {
  const agents: Partial<Record<IntegrationAgentId, IntegrationChoice>> = {}
  for (const a of INTEGRATION_AGENT_IDS) agents[a] = 'enabled'
  return { agents, hostDefault: 'enabled', origin: 'grandfathered' }
}

/** The first-run answer: the listed agents enabled, every other one declined. */
export function answerIntegrationPrompt(enabled: readonly string[]): AgentIntegrationsSettings {
  const agents: Partial<Record<IntegrationAgentId, IntegrationChoice>> = {}
  for (const a of INTEGRATION_AGENT_IDS) agents[a] = enabled.includes(a) ? 'enabled' : 'declined'
  return { agents, origin: 'asked' }
}

export function withAgentChoice<S extends WithIntegrations>(settings: S, agent: IntegrationAgentId, choice: IntegrationChoice): S {
  const s = integrationsOf(settings)
  return { ...settings, agentIntegrations: { ...s, origin: s.origin ?? 'asked', agents: { ...s.agents, [agent]: choice } } }
}

export function withHostChoice<S extends WithIntegrations>(settings: S, hostKey: string, choice: IntegrationChoice): S {
  const s = integrationsOf(settings)
  return { ...settings, agentIntegrations: { ...s, hosts: { ...s.hosts, [hostKey]: choice } } }
}

export function withNoticeDismissed<S extends WithIntegrations>(settings: S): S {
  return { ...settings, agentIntegrations: { ...integrationsOf(settings), noticeDismissed: true } }
}

/** Stable key of everything that changes what is installed locally — the lifecycle reconciles
 *  only when this moves, because the renderer saves full settings snapshots constantly. */
export function localIntegrationSignature(settings: WithIntegrations): string {
  const s = integrationsOf(settings)
  return INTEGRATION_AGENT_IDS.map((a) => `${a}=${s.agents?.[a] ?? '-'}`).join(',')
}

/** Same, for one SSH host. */
export function remoteIntegrationSignature(settings: WithIntegrations, hostKey: string): string {
  return `${hostChoice(settings, hostKey) ?? '-'}|${localIntegrationSignature(settings)}`
}

/** What a declined (or not-yet-answered) agent loses, in the user's words. One list so the
 *  first-run prompt and Settings cannot describe two different products. Terminals themselves
 *  always work. */
export const FEATURES_NEEDING_INTEGRATION: readonly string[] = [
  'running / needs-you status badges, unread dots and completion notifications',
  'session names, the context meter and subagent cards',
  'canvas control (agents opening and organizing nodes) and reading linked nodes'
]

/** What the host's last reconcile did (Settings → Agents). */
export interface AgentIntegrationsStatus {
  enabled: string[]
  declined: string[]
  /** User-edited files we kept rather than overwrite or delete (bounded). */
  retained: string[]
  /** Server Edition started with `installHooks: false`: nothing global is written. */
  vetoed: boolean
}
