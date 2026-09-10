import { capabilityAgentId, type AgentId } from '../../../shared/agents/config'
import { resolveAgentConfig } from '../../../shared/agents/custom-agent'
import { promptFilePathError } from '../../../shared/agents/launch'
import type { CustomAgent } from '../../../shared/types'

export const MESA_PROMPT_MAX_BYTES = 64 * 1024
export const MESA_TYPED_LINE_MAX_CHARS = 32_000

export type MesaPromptTransport = 'file-argv' | 'file-flag' | 'stdin-after-start'

export interface MesaHarnessContract {
  invocationMode: 'interactive'
  promptTransport: MesaPromptTransport
  /** Mesa never grants extra flags beyond the mission permission mode. Not --yolo. */
  permissionPolicy: 'workspace-scoped'
  expectedProcess: string
}

export function mesaHarnessContract(
  agentId: AgentId,
  customAgent?: CustomAgent
): MesaHarnessContract | { error: string } {
  const cap = capabilityAgentId(agentId)
  const eff = resolveAgentConfig(agentId, customAgent)
  if (!eff.launchCmd.trim()) return { error: 'unsupported-harness' }
  const mode = eff.promptInjectionMode
  const promptTransport: MesaPromptTransport =
    mode === 'stdin-after-start'
      ? 'stdin-after-start'
      : mode === 'flag-prompt' || mode === 'flag-interactive'
        ? 'file-flag'
        : 'file-argv'
  return {
    invocationMode: 'interactive',
    promptTransport,
    permissionPolicy: 'workspace-scoped',
    expectedProcess: eff.expectedProcess || String(cap)
  }
}

export function mesaPromptFileError(promptFile: string, bytes: number): string | null {
  const pathErr = promptFilePathError(promptFile)
  if (pathErr) return 'bad-prompt-path'
  if (bytes > MESA_PROMPT_MAX_BYTES) return 'prompt-too-large'
  return null
}

export function mesaTypedLineError(line: string): string | null {
  if (line.length > MESA_TYPED_LINE_MAX_CHARS) return 'launch-line-too-long'
  return null
}
