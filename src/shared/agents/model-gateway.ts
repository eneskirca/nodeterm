import { canSwitchModel, capabilityAgentId, type AgentId } from './config'
import { shellSingleQuote } from '../shell-quote'
import { expandEnvVars } from './expansion'

/** One model gateway configured once for every supported agent harness. */
export interface ModelGatewaySettings {
  /** Gateway root, before the OpenAI-compatible `/v1/models` discovery route. */
  baseUrl: string
  /** Literal legacy key, `${env:VAR}` reference, or `MODEL_GATEWAY_SECRET_REF`. */
  apiKey: string
}

/** Stored in settings.json when the literal credential lives in the shell's secret store. */
export const MODEL_GATEWAY_SECRET_REF = '${secret:model-gateway-api-key}'

export type ModelGatewayCredentialStorage = 'encrypted' | 'restricted-file' | 'unavailable'

export interface ModelGatewayCredentialStatus {
  hasStoredKey: boolean
  storage: ModelGatewayCredentialStorage
}

export interface ModelGatewayEnvReference {
  name: string
}

const EXACT_ENV_REFERENCE = /^\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/

/** Parse the JSON representation used by the environment-variable credential mode. */
export function parseModelGatewayEnvReference(apiKey: string): ModelGatewayEnvReference | null {
  const match = EXACT_ENV_REFERENCE.exec(apiKey.trim())
  if (!match) return null
  return { name: match[1] }
}

export type ModelGatewayCredentialKind = 'empty' | 'environment' | 'stored' | 'legacy-literal'

export function modelGatewayCredentialKind(apiKey: string): ModelGatewayCredentialKind {
  const value = apiKey.trim()
  if (!value) return 'empty'
  if (value === MODEL_GATEWAY_SECRET_REF) return 'stored'
  if (parseModelGatewayEnvReference(value)) return 'environment'
  return 'legacy-literal'
}

/** The intentionally small model shape shared across IPC and renderer state. */
export interface GatewayModel {
  id: string
  name?: string
  provider?: string
  /** Maximum prompt context window in tokens, when the gateway reports one. Copilot BYOK surfaces
   *  this to the CLI as `COPILOT_PROVIDER_MAX_PROMPT_TOKENS`. Absent ⇒ the env var is omitted and
   *  the CLI falls back to its own default — never guessed (a percentage over a guessed window is a
   *  wrong number presented as a fact). */
  contextWindow?: number
  /** Maximum output/completion tokens the model may produce, when reported. Surfaced to Copilot as
   *  `COPILOT_PROVIDER_MAX_OUTPUT_TOKENS`. Absent ⇒ omitted, never guessed. */
  maxOutputTokens?: number
}

export interface ModelDiscoveryResult {
  models: GatewayModel[]
  error?: string
}

export interface ModelGatewayRoutes {
  discovery: string
  openai: string
  anthropic: string
}

/**
 * Resolve the stored gateway credential against the host process environment. Keeping this next
 * to the route/env mapping gives model discovery and every supported harness the exact same
 * `${env:VAR}` parser as custom agents, without ever resolving a secret in the renderer. Gateway
 * credentials deliberately accept one exact reference rather than embedded/fallback expansion:
 * a fallback API key would put the very secret this mode avoids back into settings.json.
 *
 * Whitespace around either a literal or expanded key is ignored. A caller must treat `missing` as
 * a hard failure even when `value` is partly non-empty: sending a partial credential is both
 * surprising and unsafe.
 */
export interface ModelGatewayApiKeyResolution {
  value: string
  missing: string[]
  storedSecretMissing: boolean
}

export function resolveModelGatewayApiKey(
  apiKey: string,
  env: Record<string, string | undefined>,
  storedSecret: string | null = null
): ModelGatewayApiKeyResolution {
  if (apiKey.trim() === MODEL_GATEWAY_SECRET_REF) {
    const value = storedSecret?.trim() ?? ''
    return { value, missing: [], storedSecretMissing: !value }
  }
  const reference = parseModelGatewayEnvReference(apiKey)
  if (!reference) {
    return { value: apiKey.trim(), missing: [], storedSecretMissing: false }
  }
  const result = expandEnvVars(apiKey.trim(), env)
  return { value: result.value.trim(), missing: result.missing, storedSecretMissing: false }
}

/**
 * Derive every route from one user-entered root. Discovery is the OpenAI Models API convention;
 * the provider-specific paths are the Bifrost layout requested by the launch mapping. Only http(s)
 * URLs are accepted: this value is later handed to `fetch` and agent CLIs, and settings.json is
 * hand-editable. Invalid input degrades to null, never to a guessed endpoint.
 */
export function modelGatewayRoutes(baseUrl: string): ModelGatewayRoutes | null {
  const raw = baseUrl.trim().replace(/\/+$/, '')
  if (!raw) return null
  try {
    const parsed = new URL(raw)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    // Credentials in the URL would be copied into every derived endpoint and surfaced in the UI.
    // The separate API-key field exists precisely so a secret never has to live there.
    if (parsed.username || parsed.password || parsed.search || parsed.hash) return null
    const root = parsed.toString().replace(/\/+$/, '')
    return {
      discovery: `${root}/v1/models`,
      openai: `${root}/openai/v1`,
      anthropic: `${root}/anthropic`
    }
  } catch {
    return null
  }
}

/** Coerce a gateway-reported token limit to a finite positive integer, or undefined. Gateways
 *  expose context/output caps under a variety of field names and sometimes as strings; a non-finite
 *  or non-positive value is treated as "not reported" so no env var is emitted for it. */
function coerceTokenLimit(value: unknown): number | undefined {
  const n = typeof value === 'string' ? Number(value.trim()) : typeof value === 'number' ? value : NaN
  if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) return undefined
  return n
}

/** Parse OpenAI-compatible model-list responses, dropping unsafe/empty/duplicate ids. */
export function parseGatewayModels(payload: unknown): GatewayModel[] {
  if (!payload || typeof payload !== 'object') return []
  const data = (payload as { data?: unknown }).data
  if (!Array.isArray(data)) return []
  const byId = new Map<string, GatewayModel>()
  for (const raw of data) {
    if (!raw || typeof raw !== 'object') continue
    const row = raw as {
      id?: unknown
      name?: unknown
      provider?: unknown
      owned_by?: unknown
      context_length?: unknown
      max_context_length?: unknown
      context_window?: unknown
      max_output_tokens?: unknown
      max_completion_tokens?: unknown
    }
    const id = typeof row.id === 'string' ? row.id.trim() : ''
    if (!id || id.length > 500 || /[\u0000-\u001f\u007f]/.test(id)) continue
    const prefix = id.includes('/') ? id.slice(0, id.indexOf('/')) : ''
    const explicitProvider =
      typeof row.provider === 'string'
        ? row.provider.trim()
        : typeof row.owned_by === 'string'
          ? row.owned_by.trim()
          : ''
    // Context window: gateways disagree on the field name. The OpenAI convention (`context_length`)
    // and the `context_window` alias cover the providers Copilot BYOK targets; `max_context_length`
    // is the max variant some report. The FIRST present, finite value wins (they are synonyms), and
    // an absent one stays undefined so the env var is omitted rather than guessed.
    const contextWindow =
      coerceTokenLimit(row.context_length) ??
      coerceTokenLimit(row.max_context_length) ??
      coerceTokenLimit(row.context_window)
    const maxOutputTokens =
      coerceTokenLimit(row.max_output_tokens) ?? coerceTokenLimit(row.max_completion_tokens)
    byId.set(id, {
      id,
      ...(typeof row.name === 'string' && row.name.trim() ? { name: row.name.trim() } : {}),
      ...(explicitProvider || prefix ? { provider: explicitProvider || prefix } : {}),
      ...(contextWindow ? { contextWindow } : {}),
      ...(maxOutputTokens ? { maxOutputTokens } : {})
    })
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id))
}

/**
 * Models an agent can be offered. OpenAI-compatible gateways may expose provider-prefixed or
 * administrator-defined aliases and route them through either harness protocol, so filtering by
 * provider here would hide supported modes. The capability is the only UI gate; custom agents
 * inherit it from their declared base harness.
 */
export function modelsForAgent(models: GatewayModel[], agentId: AgentId): GatewayModel[] {
  if (!canSwitchModel(agentId)) return []
  return models
}

/**
 * Environment applied to a terminal session before custom-agent env (custom values still win).
 * Claude/Codex model selection stays a quoted CLI flag. Copilot's BYOK protocol instead carries
 * its internal + wire model ids in environment variables. Credentials never enter a restart
 * command, so none are exposed in the pane.
 */
/** Every env var name `modelGatewayEnv` can emit, in one place. The tmux confs bake this list
 *  into `update-environment`, which is HOW gateway credentials reach a pane without ever touching
 *  an argv: the values ride the tmux CLIENT's process environment (or a sourced 0600 file over
 *  SSH), and tmux copies the listed names into the session environment at create/attach. A key
 *  emitted here but missing from this list would silently fail to reach the agent on a shared
 *  tmux server — model-gateway.test.ts asserts the lockstep. */
export const MODEL_GATEWAY_ENV_KEYS = [
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'OPENAI_BASE_URL',
  'OPENAI_API_KEY',
  'COPILOT_PROVIDER_BASE_URL',
  'COPILOT_PROVIDER_TYPE',
  'COPILOT_PROVIDER_API_KEY',
  'COPILOT_PROVIDER_MODEL_ID',
  'COPILOT_PROVIDER_WIRE_MODEL',
  'COPILOT_PROVIDER_WIRE_API',
  'COPILOT_PROVIDER_MAX_PROMPT_TOKENS',
  'COPILOT_PROVIDER_MAX_OUTPUT_TOKENS'
] as const

/** tmux's own stock `update-environment` entries (tmux 3.4 defaults, measured via
 *  `show-options -g`). Assigning the option as a whole REPLACES the array, so the defaults must be
 *  restated or SSH agent forwarding et al. silently break. */
const TMUX_STOCK_UPDATE_ENV = [
  'DISPLAY',
  'KRB5CCNAME',
  'SSH_ASKPASS',
  'SSH_AUTH_SOCK',
  'SSH_AGENT_PID',
  'SSH_CONNECTION',
  'WINDOWID',
  'XAUTHORITY'
]

/** The `update-environment` conf line both tmux confs (local + remote) bake in. This is the
 *  argv-free credential path: gateway values sit in the tmux CLIENT's process environment (never
 *  on a command line), and tmux copies the listed names into the session env on create/attach —
 *  MEASURED on tmux 3.4: the pane sees the value, a client withOUT the var strips it from its own
 *  session (no cross-session bleed into plain terminals), and re-sourcing the conf is idempotent. */
export function tmuxUpdateEnvironmentLine(): string {
  return `set -g update-environment "${[...TMUX_STOCK_UPDATE_ENV, ...MODEL_GATEWAY_ENV_KEYS].join(' ')}"`
}

export function modelGatewayEnv(
  settings: ModelGatewaySettings,
  agentId: AgentId,
  model?: string,
  processEnv: Record<string, string | undefined> = {},
  storedSecret: string | null = null,
  /** The gateway's discovered model list — the ONLY source of the context/output token limits
   *  injected for Copilot BYOK. Absent (or a model not in it) ⇒ the max-token env vars are omitted
   *  and the CLI uses its own defaults. The caller resolves this from a cache populated by
   *  discovery; it is never guessed here. */
  models: GatewayModel[] = []
): Record<string, string> {
  const routes = modelGatewayRoutes(settings.baseUrl)
  const resolvedKey = resolveModelGatewayApiKey(settings.apiKey, processEnv, storedSecret)
  const key = resolvedKey.value
  if (
    !routes ||
    !key ||
    resolvedKey.missing.length ||
    resolvedKey.storedSecretMissing ||
    !canSwitchModel(agentId)
  )
    return {}
  switch (capabilityAgentId(agentId)) {
    case 'claude':
      return {
        ANTHROPIC_BASE_URL: routes.anthropic,
        ANTHROPIC_AUTH_TOKEN: key
      }
    case 'codex':
      return {
        OPENAI_BASE_URL: routes.openai,
        OPENAI_API_KEY: key
      }
    case 'copilot': {
      // Copilot's BYOK mode requires a model at startup. Keep an ordinary Copilot node on GitHub's
      // own routing until the user actually selects one; otherwise merely configuring a gateway
      // would activate an incomplete provider and make every new Copilot node fail to launch.
      const wireModel = normalizedAgentModel(agentId, model)
      if (!wireModel) return {}
      const slash = wireModel.indexOf('/')
      const provider = slash > 0 ? wireModel.slice(0, slash).toLowerCase() : ''
      const modelId = slash > 0 ? wireModel.slice(slash + 1) : wireModel
      const anthropic = provider === 'anthropic'
      // Resolve the chosen model's reported limits from discovery (the wire id, matching the
      // catalogue key). A model not present in the discovered list, or one the gateway did not
      // report limits for, yields NO max-token env var — Copilot falls back to its own defaults.
      // Shipping a guessed cap would be a wrong number presented as a fact.
      const discovered = models.find((m) => m.id === wireModel)
      const maxPrompt = discovered?.contextWindow
      const maxOutput = discovered?.maxOutputTokens
      return {
        COPILOT_PROVIDER_BASE_URL: anthropic ? routes.anthropic : routes.openai,
        COPILOT_PROVIDER_TYPE: anthropic ? 'anthropic' : 'openai',
        COPILOT_PROVIDER_API_KEY: key,
        // Bifrost needs the provider-prefixed wire id; Copilot's internal catalogue wants the
        // unprefixed well-known id for token limits/tool strategy. Its official BYOK grammar
        // explicitly supports separating these two values.
        COPILOT_PROVIDER_MODEL_ID: modelId,
        COPILOT_PROVIDER_WIRE_MODEL: wireModel,
        ...(!anthropic && /^gpt-5(?:[.-]|$)/i.test(modelId)
          ? { COPILOT_PROVIDER_WIRE_API: 'responses' }
          : {}),
        ...(maxPrompt ? { COPILOT_PROVIDER_MAX_PROMPT_TOKENS: String(maxPrompt) } : {}),
        ...(maxOutput ? { COPILOT_PROVIDER_MAX_OUTPUT_TOKENS: String(maxOutput) } : {})
      }
    }
    default:
      return {}
  }
}

/** Re-validate a hand-editable/discovered model id at the point it reaches a launch command. */
export function normalizedAgentModel(agentId: AgentId, model: string | undefined): string | null {
  const value = model?.trim()
  if (
    !value ||
    value.length > 500 ||
    /[\u0000-\u001f\u007f]/.test(value) ||
    !canSwitchModel(agentId)
  )
    return null
  return value
}

/** Append a safely quoted model flag only for harnesses whose CLI grammar supports it. */
export function withAgentModel(cmd: string, agentId: AgentId, model: string | undefined): string {
  const value = normalizedAgentModel(agentId, model)
  if (!value) return cmd
  // Copilot receives the model through COPILOT_PROVIDER_MODEL_ID/WIRE_MODEL. Appending --model
  // would collapse those two distinct values back together and send the unrecognized
  // provider-prefixed Bifrost id through Copilot's internal catalogue.
  if (capabilityAgentId(agentId) === 'copilot') return cmd
  return `${cmd} --model ${shellSingleQuote(value)}`
}
