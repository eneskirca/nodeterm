import type { Settings } from '@shared/types'
import { agentConfig, BUILTIN_AGENT_IDS, type AgentId } from '@shared/agents/config'

type Avail = Pick<Settings, 'disabledAgents' | 'defaultAgent' | 'customAgents'>

export function isAgentEnabled(settings: Pick<Settings, 'disabledAgents'>, id: AgentId): boolean {
  return !settings.disabledAgents.includes(id)
}

export function controlAgentRefusal(
  verb: string,
  id: AgentId,
  settings: Pick<Settings, 'disabledAgents' | 'customAgents'>
): string | null {
  const known = !!agentConfig(id) || settings.customAgents.some((c) => c.id === id)
  if (!known) {
    return `${verb}: unknown agent "${id}" — pass a builtin id or a custom agent id from Settings`
  }
  if (!isAgentEnabled(settings, id)) {
    return `${verb}: agent "${id}" is disabled in Settings`
  }
  return null
}

/**
 * First enabled agent in claude → codex → gemini → … order, then the user's custom agents in
 * their own order; 'claude' only when literally everything is disabled. Custom agents are real
 * candidates here — a user who disables every builtin to live on their own CLI aliases must not
 * have the default snap back to a claude they just switched off (reported 2026-08-15: "disable
 * claude and it still seems to take claude as default").
 */
export function firstEnabledAgent(settings: Pick<Settings, 'disabledAgents' | 'customAgents'>): AgentId {
  const builtin = BUILTIN_AGENT_IDS.find((id) => !settings.disabledAgents.includes(id))
  if (builtin) return builtin
  const custom = settings.customAgents.find((c) => !settings.disabledAgents.includes(c.id))
  return custom?.id ?? 'claude'
}

// Enable/disable an agent; if the current default gets disabled, reassign it.
export function setAgentEnabled(settings: Avail, id: AgentId, enabled: boolean): Avail {
  const disabled = enabled
    ? settings.disabledAgents.filter((a) => a !== id)
    : settings.disabledAgents.includes(id)
      ? settings.disabledAgents
      : [...settings.disabledAgents, id]
  const defaultAgent =
    !enabled && settings.defaultAgent === id
      ? firstEnabledAgent({ disabledAgents: disabled, customAgents: settings.customAgents })
      : settings.defaultAgent
  return { disabledAgents: disabled, defaultAgent, customAgents: settings.customAgents }
}

// Make an agent the default; re-enable it if it was disabled. Custom agents are eligible.
export function setDefaultAgent(settings: Avail, id: AgentId): Avail {
  return {
    disabledAgents: settings.disabledAgents.filter((a) => a !== id),
    defaultAgent: id,
    customAgents: settings.customAgents
  }
}

/**
 * Remove a custom agent WITHOUT leaving dangling references: its id is dropped from
 * `disabledAgents` (a dead id there is inert but would resurrect oddly if a same-id agent ever
 * reappeared), and a default pointing at it is reassigned — otherwise ⌘⇧C would type the raw
 * `custom:<uuid>` into a shell (resolveAgent's unknown-id fallback launches the id itself).
 */
export function removeCustomAgent(settings: Avail, id: AgentId): Avail {
  const customAgents = settings.customAgents.filter((c) => c.id !== id)
  const disabledAgents = settings.disabledAgents.filter((a) => a !== id)
  const defaultAgent =
    settings.defaultAgent === id
      ? firstEnabledAgent({ disabledAgents, customAgents })
      : settings.defaultAgent
  return { customAgents, disabledAgents, defaultAgent }
}

/**
 * The default agent as something that can actually LAUNCH: the setting itself when it names a
 * builtin or an existing custom agent, else the first enabled agent. Guards the launch sites
 * (⌘⇧C, the Add menu's default) against a persisted default whose custom agent was since
 * removed — settings.json is hand-editable and older builds deleted custom agents without
 * reassigning the default, so the stale-id case exists in the wild, not only in theory.
 */
export function launchableDefaultAgent(settings: Avail): AgentId {
  const id = settings.defaultAgent
  if (agentConfig(id)) return id
  if (settings.customAgents.some((c) => c.id === id)) return id
  return firstEnabledAgent(settings)
}
