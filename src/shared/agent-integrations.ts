import type { SshConnection } from './ssh'

export const INTEGRATION_AGENTS = ['claude', 'codex', 'gemini', 'grok', 'copilot', 'opencode'] as const
export type IntegrationAgent = typeof INTEGRATION_AGENTS[number]
export type IntegrationChoices = Partial<Record<IntegrationAgent, boolean>>
export interface AgentIntegrationConsent {
  local?: IntegrationChoices
  remote?: Record<string, IntegrationChoices>
}

// Machine-local only. Never take consent from project.json, a CLI-presence probe or old files.
export function integrationChoice(consent: AgentIntegrationConsent | undefined, agent: string, conn?: SshConnection): boolean | undefined {
  const choices = conn ? consent?.remote?.[integrationHostKey(conn)] : consent?.local
  const value = choices?.[agent as IntegrationAgent]
  return value === true ? true : value === false ? false : undefined
}

export function integrationHostKey(conn: SshConnection): string {
  return JSON.stringify([conn.user, conn.host, conn.port ?? 22, conn.identityFile ?? '', conn.extraArgs ?? ''])
}

export const INTEGRATION_FILES: Record<IntegrationAgent, string> = {
  claude: '~/.claude/settings.json (hooks), ~/.claude/skills; linked and managed Claude account directories',
  codex: '~/.codex/hooks.json, ~/.codex/config.toml (hook trust), ~/.agents/skills',
  gemini: '~/.gemini/settings.json (hooks)',
  grok: '$GROK_HOME/hooks/nodeterm-status.json (default ~/.grok)',
  copilot: '$COPILOT_HOME/hooks/nodeterm-status.json (default ~/.copilot)',
  opencode: '$XDG_CONFIG_HOME/opencode/plugins/nodeterm-status.js (default ~/.config)'
}
