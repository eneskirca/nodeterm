import { integrationRetainedFiles } from './integration-status'
import { cleanIntegrationHooks } from './integration-cleanup'
import { buildManagedHookCommand, managedHookScriptPath } from './agents/hooks/install-helper'
import { grokHookConfigPath } from './agents/hooks/grok'
import { copilotHomeDir, copilotHookConfigPath } from './agents/hooks/copilot'
import { opencodeConfigDir } from './agents/hooks/opencode'
import os from 'os'
import path from 'path'
import type { SettingsStore } from './settings-store'
import type { Settings } from '../shared/types'
import { INTEGRATION_AGENTS } from '../shared/agent-integrations'
import { agentIntegrationAllowed, agentIntegrationChoice, setIntegrationConsent } from './integration-policy'
import { installManagedAgentHooks, MANAGED_HOOK_REMOVERS } from './agents/hooks'
import { platform } from './platform'
import { buildCanvasSkillBody, buildCanvasControlInstructions, mergeCanvasControlBlock } from './canvas-control-core'
import { buildContextLinkSkillBody, buildLinkedContextInstructions, mergeInstructionsBlock } from './context-link-core'
import { IntegrationFiles } from './integration-files'
import { claudeConfigDirFor } from './claude-config-dir'
import { installHooksIntoLocalAccounts } from './claude-accounts-service'
import { IPC } from '../shared/ipc'

let retained: string[] = []

export function initAgentIntegrations(store: SettingsStore, enabled = true): () => void {
  let previous = ''
  const reconcile = (settings: Settings): void => {
    // A server/test hard veto overrides saved consent. Existing files never imply a grant.
    setIntegrationConsent(enabled ? settings.agentIntegrations : undefined)
    if (!enabled) return
    const signature = JSON.stringify([settings.agentIntegrations, settings.claudeAccounts])
    if (signature === previous) return
    previous = signature
    const files = new IntegrationFiles(path.join(platform().userDataDir, 'integration-receipts.json'))
    installManagedAgentHooks(agentIntegrationAllowed)
    for (const [agent, remove] of MANAGED_HOOK_REMOVERS) {
      if (agentIntegrationChoice(agent) !== false) continue
      if (agent === 'claude' || agent === 'gemini' || agent === 'grok' || agent === 'copilot') {
        const file = agent === 'grok' ? grokHookConfigPath() : agent === 'copilot' ? copilotHookConfigPath()
          : path.join(os.homedir(), `.${agent}`, 'settings.json')
        files.retained.push(...cleanIntegrationHooks(file, [buildManagedHookCommand(managedHookScriptPath(`${agent}.sh`))]))
      } else remove()
    }
    const claudeDirs = [path.join(os.homedir(), '.claude'), ...(settings.claudeAccounts ?? [])
      .filter((a) => !a.host).map((a) => claudeConfigDirFor(a.id))]
    installHooksIntoLocalAccounts(settings.claudeAccounts ?? [])
    if (agentIntegrationChoice('claude') === false) {
      for (const dir of claudeDirs.slice(1)) files.retained.push(...cleanIntegrationHooks(
        path.join(dir, 'settings.json'), [buildManagedHookCommand(managedHookScriptPath('claude.sh'))]))
    }
    // Codex's documented USER skill directory; full references are loaded only on demand.
    // Other harnesses still get hooks, but no always-loaded documentation injection.
    for (const agent of INTEGRATION_AGENTS) {
      const choice = agentIntegrationChoice(agent)
      if (choice === undefined) continue // even cleanup is a user decision
      const instructionFile = agent === 'codex' ? path.join(os.homedir(), '.codex', 'AGENTS.md')
        : agent === 'gemini' ? path.join(os.homedir(), '.gemini', 'GEMINI.md')
        : agent === 'copilot' ? path.join(copilotHomeDir(), 'copilot-instructions.md')
        : agent === 'opencode' ? path.join(opencodeConfigDir(), 'AGENTS.md') : null
      if (instructionFile) files.removeBlocks(instructionFile, [
        mergeCanvasControlBlock('', buildCanvasControlInstructions(path.join(platform().userDataDir, 'canvas-control', 'nodeterm.sh'))).trim(),
        mergeInstructionsBlock('', buildLinkedContextInstructions(path.join(platform().userDataDir, 'context-links', 'context.sh'))).trim(),
        mergeCanvasControlBlock('', buildCanvasControlInstructions(path.join(os.homedir(), '.nodeterm', 'nodeterm.sh'))).trim(),
        mergeInstructionsBlock('', buildLinkedContextInstructions(path.join(os.homedir(), '.nodeterm', 'context.sh'))).trim()
      ])
      const dirs = agent === 'claude' ? claudeDirs : agent === 'codex' ? [path.join(os.homedir(), '.agents')] : []
      for (const dir of dirs) {
        for (const [name, body] of [
          ['manage-nodeterm-canvas', buildCanvasSkillBody(path.join(platform().userDataDir, 'canvas-control', 'nodeterm.sh'))],
          ['get-linked-context', buildContextLinkSkillBody(path.join(platform().userDataDir, 'context-links', 'context.sh'))]
        ]) files.reconcile(path.join(dir, 'skills', name, 'SKILL.md'), choice ? body : null, [body])
      }
    }
    retained = files.retained
    if (retained.length) console.warn('[integrations] Preserved edited/unowned files:', retained)
  }
  platform().handle(IPC.integrationStatus, () => ({ retained: [...new Set([...retained, ...integrationRetainedFiles()])] }))
  reconcile(store.get())
  return store.onChange(reconcile)
}

/** Account creation can happen after startup; use the same receipt checks as the lifecycle. */
export function installAccountDiscovery(configDir: string): void {
  if (!agentIntegrationAllowed('claude')) return
  const files = new IntegrationFiles(path.join(platform().userDataDir, 'integration-receipts.json'))
  files.reconcile(path.join(configDir, 'skills', 'manage-nodeterm-canvas', 'SKILL.md'),
    buildCanvasSkillBody(path.join(platform().userDataDir, 'canvas-control', 'nodeterm.sh')))
  retained.push(...files.retained)
}
