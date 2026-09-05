// Resolves an agent id to its EFFECTIVE launch config — the one place that knows how a custom
// agent with a `baseAgent` inherits a builtin's prompt convention, color, separator, and
// expected-process name, while letting the custom agent's own fields override.
//
// `agentConfig(id)` (in ./config) still returns `undefined` for custom ids on purpose — many call
// sites rely on "undefined = this is a custom agent" to switch off a feature. THIS function is the
// positive complement: it always returns a usable config for any id, so the command-assembly layer
// and the UI can treat builtins and custom agents uniformly.

import type { CustomAgent } from '../types'
import {
  AGENT_CONFIG,
  FALLBACK_AGENT_COLOR,
  agentConfig,
  baseAgentOf,
  type AgentId,
  type BuiltinAgentId,
  type PromptInjectionMode
} from './config'

/**
 * The launch config an agent actually runs with. Shape mirrors `AgentConfig` but `expectedProcess`
 * and `argvPromptSeparator` are optional (a vanilla custom agent has neither), and `custom` tells
 * the caller whether this came from a `CustomAgent` record.
 */
export interface EffectiveAgentConfig {
  label: string
  color: string
  launchCmd: string
  launchArgs?: readonly string[]
  promptLaunchArgs?: readonly string[]
  promptInjectionMode: PromptInjectionMode
  promptFlag?: string
  argvPromptSeparator?: string
  expectedProcess?: string
  /** `true` for a custom agent (`CustomAgent`), `false` for a builtin. */
  custom: boolean
  /** The builtin harness this agent inherits from, if any. */
  baseAgent?: BuiltinAgentId
}

/**
 * Resolve `id` to its effective config. For a builtin, returns its `AGENT_CONFIG` entry. For a
 * custom agent, `customAgent` is the matching `CustomAgent` record (the caller looks it up by id
 * from settings); fields inherit from `baseAgent` and the custom record overrides:
 *  - `launchCmd`: custom value, else the base harness's command (so a claude-compatible proxy with
 *    a blank command runs `claude`), else the id itself (today's fallback for vanilla customs).
 *  - `promptInjectionMode`: from the BASE harness when `baseAgent` is set (the prompt grammar is
 *    a property of the harness — a claude wrapper takes a positional, never `--prompt`), else the
 *    custom value, else `argv`.
 *  - `color`: custom value, else the base's, else the fallback grey.
 *  - `argvPromptSeparator` / `expectedProcess`: from the base only (a custom record does not set
 *    these — inheriting them is the whole point of declaring a base).
 */
export function resolveAgentConfig(
  id: AgentId,
  customAgent?: CustomAgent
): EffectiveAgentConfig {
  const builtin = agentConfig(id)
  if (builtin) {
    return { ...builtin, custom: false }
  }
  const base = customAgent?.baseAgent ? AGENT_CONFIG[customAgent.baseAgent] : undefined
  const launchCmd = customAgent?.launchCmd?.trim() || base?.launchCmd || id
  // The prompt grammar is a property of the HARNESS, not a user preference: `flag-prompt`
  // (emitting `--prompt <p>`) is opencode-specific — claude/codex/grok take a POSITIONAL (`argv`)
  // and gemini uses `stdin-after-start`. A custom agent wrapping claude (e.g. claude-wopr) speaks
  // claude's positional grammar, so a stale `flag-prompt` on its record would emit `--prompt`,
  // which claude rejects (`unknown option '--prompt'`). When a `baseAgent` is declared, the base's
  // promptInjectionMode is AUTHORITATIVE and the custom record's value is ignored — exactly like
  // `argvPromptSeparator`/`expectedProcess`, which also inherit from the base only. A baseless
  // custom agent has no harness to inherit from, so its own value (default `argv`) stands.
  const promptInjectionMode: PromptInjectionMode =
    base?.promptInjectionMode ?? customAgent?.promptInjectionMode ?? 'argv'
  const color = customAgent?.color || base?.color || FALLBACK_AGENT_COLOR
  return {
    label: customAgent?.label || id,
    color,
    launchCmd,
    launchArgs: base?.launchArgs,
    promptLaunchArgs: base?.promptLaunchArgs,
    promptInjectionMode,
    promptFlag: base?.promptFlag,
    argvPromptSeparator: base?.argvPromptSeparator,
    expectedProcess: base?.expectedProcess,
    custom: true,
    baseAgent: customAgent?.baseAgent
  }
}

/** Find a custom agent by id in a settings list. Returns `undefined` for builtins / unknowns. */
export function findCustomAgent(
  customAgents: readonly CustomAgent[],
  id: AgentId
): CustomAgent | undefined {
  if ((AGENT_CONFIG as Record<string, unknown>)[id]) return undefined
  return customAgents.find((c) => c.id === id)
}

/** The baseAgent declared on a custom agent record (the static field), without the resolver
 *  registry — handy where the record is already in hand. */
export function declaredBaseAgent(customAgent: CustomAgent | undefined): BuiltinAgentId | undefined {
  return customAgent?.baseAgent
}

// Re-export so the launcher can reach the registry through one import.
export { baseAgentOf }
