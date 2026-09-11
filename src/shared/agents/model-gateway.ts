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

/** Parse OpenAI-compatible model-list responses, dropping unsafe/empty/duplicate ids. */
export function parseGatewayModels(payload: unknown): GatewayModel[] {
  if (!payload || typeof payload !== 'object') return []
  const data = (payload as { data?: unknown }).data
  if (!Array.isArray(data)) return []
  const byId = new Map<string, GatewayModel>()
  for (const raw of data) {
    if (!raw || typeof raw !== 'object') continue
    const row = raw as { id?: unknown; name?: unknown; provider?: unknown; owned_by?: unknown }
    const id = typeof row.id === 'string' ? row.id.trim() : ''
    if (!id || id.length > 500 || /[\u0000-\u001f\u007f]/.test(id)) continue
    const prefix = id.includes('/') ? id.slice(0, id.indexOf('/')) : ''
    const explicitProvider =
      typeof row.provider === 'string'
        ? row.provider.trim()
        : typeof row.owned_by === 'string'
          ? row.owned_by.trim()
          : ''
    byId.set(id, {
      id,
      ...(typeof row.name === 'string' && row.name.trim() ? { name: row.name.trim() } : {}),
      ...(explicitProvider || prefix ? { provider: explicitProvider || prefix } : {})
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
export function modelsForAgent(
  models: GatewayModel[],
  agentId: AgentId,
  grokModels: readonly GatewayModel[] = []
): GatewayModel[] {
  if (!canSwitchModel(agentId)) return []
  // grok is offered ITS OWN models, never the gateway's, and this is a correctness rule rather than
  // a preference: grok cannot be routed through the gateway at all (see `modelGatewayEnv` below —
  // its custom models live in `~/.grok/config.toml`, not in environment variables). Handing it the
  // gateway catalogue would put ids on the menu that its CLI rejects at launch: a picker that looks
  // like it worked and kills the node.
  if (capabilityAgentId(agentId) === 'grok') return [...grokModels]
  return models
}

/**
 * Parse `grok models` — the CLI's own list, so there is no allowlist to maintain and a model shipped
 * tomorrow appears without a code change.
 *
 * MEASURED output (1.0.13, 2026-09-02):
 *
 *   You are logged in with grok.com.
 *
 *   Default model: grok-4.6
 *
 *   Available models:
 *     * grok-4.6 (default)
 *     - grok-4.5
 *
 * Only the indented bullets under "Available models:" are read. The `Default model:` line is
 * deliberately NOT a source: it repeats an entry that the bullet list already carries, and treating
 * a prose line as data is how a login banner or a future footer becomes a fake model id.
 *
 * Anything unparseable yields an EMPTY list, which the UI reads as "no model switching" — the
 * pre-feature behaviour. Never a partial list built from whatever happened to match.
 */
export function grokModelsFrom(stdout: string | null | undefined): GatewayModel[] {
  const text = stdout ?? ''
  const start = text.indexOf('Available models:')
  if (start < 0) return []
  const byId = new Map<string, GatewayModel>()
  for (const raw of text.slice(start).split('\n').slice(1)) {
    // An unindented line ends the block: the list is indented, anything flush left is prose again.
    if (raw.trim() && !/^\s/.test(raw)) break
    const m = /^\s+[*-]\s+(\S+)/.exec(raw)
    if (!m) continue
    const id = m[1]
    // Same charset discipline as every other id that reaches a command line.
    if (!/^[A-Za-z0-9][A-Za-z0-9._:\/-]*$/.test(id)) continue
    if (!byId.has(id)) byId.set(id, { id })
  }
  return [...byId.values()]
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
  'COPILOT_PROVIDER_WIRE_API'
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
 *  session (no cross-session bleed into plain terminals), and re-sourcing the conf is idempotent.
 *
 *  `extraNames` lets the LOCAL conf append the account-scope names (`ACCOUNT_SCOPE_UPDATE_ENV` in
 *  pty-manager — issue #419): the REMOTE conf must NOT get them, because a remote session's
 *  account env arrives only via `-e` (the ssh-exec'd tmux client's own env is the login shell's,
 *  so listing the names there would have the copy/strip run against the WRONG environment).
 *  Deduped so an overlap (e.g. ANTHROPIC_AUTH_TOKEN, in both the gateway list and the claude
 *  auth strip) cannot double an entry. */
export function tmuxUpdateEnvironmentLine(extraNames: readonly string[] = []): string {
  const names = [...new Set([...TMUX_STOCK_UPDATE_ENV, ...MODEL_GATEWAY_ENV_KEYS, ...extraNames])]
  return `set -g update-environment "${names.join(' ')}"`
}

export function modelGatewayEnv(
  settings: ModelGatewaySettings,
  agentId: AgentId,
  model?: string,
  processEnv: Record<string, string | undefined> = {},
  storedSecret: string | null = null
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
          : {})
      }
    }
    case 'grok':
      // Deliberately EMPTY, and stated rather than omitted. grok's model gateway is not an
      // environment: custom models are declared in `~/.grok/config.toml` with their own `base_url`
      // and `api_key` (`~/.grok/docs/user-guide/11-custom-models.md`), and that file also says the
      // environment-wide knobs it does accept CANNOT carry `model`/`base_url`/`api_key`. So there is
      // no env for this function to emit, and emitting the OpenAI pair anyway would point grok's
      // built-in models at a gateway they were never configured for.
      //
      // Writing into the user's `config.toml` to route grok through the gateway is a real feature
      // and a separate decision — it edits a file the user owns, for a value they did not ask us to
      // change. Not this PR.
      return {}
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
