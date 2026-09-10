import { canSwitchModel, capabilityAgentId, type AgentId } from './config'
import { shellSingleQuote } from '../shell-quote'
import { expandEnvVars } from './expansion'

/** One model gateway configured once for every supported agent harness. */
export interface ModelGatewaySettings {
  /** Gateway root, before the OpenAI-compatible `/v1/models` discovery route. */
  baseUrl: string
  /** Literal legacy key, `${env:VAR}` reference, or `MODEL_GATEWAY_SECRET_REF`. */
  apiKey: string
  /** Path the discovery (Models API) request is sent to, appended to `baseUrl` — e.g.
   *  `/openai/v1/models` for a gateway that serves its model catalogue under a protocol prefix.
   *  Deliberately a PATH SUFFIX and never a full URL: discovery sends the resolved API key to the
   *  target, and a caller-chosen host would turn the pre-save/relay flow into a credential-exfil-
   *  tration oracle (the same reason `${env:VAR}` references resolve only for the saved baseUrl).
   *  Empty/absent = the conventional derived `/v1/models` (see `modelGatewayRoutes`). */
  discoveryPath?: string
}

/** Characters a discovery path may contain, minus URL structure that could change WHERE the
 *  request goes: no query (`?`), fragment (`#`), dot-dot traversal, or second scheme. The value is
 *  hand-editable settings.json AND caller-supplied over IPC, so it is re-validated at the point it
 *  is appended to the root (the same rule as permission modes / model ids on a command line) — an
 *  unrecognized value yields the derived default path, never a guessed one. */
const GATEWAY_DISCOVERY_PATH = /^\/[A-Za-z0-9\-._~!$&'()*+,;=:@/]*$/

/** A validated discovery path, or null when absent/unsafe (null ⇒ use the derived default). */
export function sanitizedGatewayDiscoveryPath(path: string | undefined): string | null {
  const value = path?.trim() ?? ''
  if (!value) return null
  if (value.length > 500 || value.includes('..') || !GATEWAY_DISCOVERY_PATH.test(value)) return null
  return value.replace(/\/+$/, '') || null
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
  /** Maximum prompt context window in tokens, when the gateway reports one. The autocompact helper sizes
   *  `CLAUDE_CODE_AUTO_COMPACT_WINDOW` off it for a claude-base agent. Absent ⇒ the env var is
   *  omitted and the CLI falls back to its own default — never guessed (a percentage over a guessed
   *  window is a wrong number presented as a fact). */
  contextWindow?: number
  /** Maximum output/completion tokens the model may produce, when reported. Retained as catalogue
   *  metadata for consumers; absent stays absent, never guessed. */
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
 *
 * `discoveryPath` (optional, from the same `ModelGatewaySettings`) replaces the conventional
 * `/v1/models` suffix when it is present and passes `sanitizedGatewayDiscoveryPath`. It changes
 * only WHICH path on the saved root the catalogue is read from — never the host — so the
 * credential trust gate upstream (references resolve only for the saved baseUrl) is unaffected.
 * An unsafe value falls back to the derived default rather than sending a fetch somewhere the
 * user did not vet.
 */
export function modelGatewayRoutes(
  baseUrl: string,
  discoveryPath?: string
): ModelGatewayRoutes | null {
  const raw = baseUrl.trim().replace(/\/+$/, '')
  if (!raw) return null
  try {
    const parsed = new URL(raw)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    // Credentials in the URL would be copied into every derived endpoint and surfaced in the UI.
    // The separate API-key field exists precisely so a secret never has to live there.
    if (parsed.username || parsed.password || parsed.search || parsed.hash) return null
    const root = parsed.toString().replace(/\/+$/, '')
    const discoverySuffix = sanitizedGatewayDiscoveryPath(discoveryPath) ?? '/v1/models'
    return {
      discovery: `${root}${discoverySuffix}`,
      openai: `${root}/openai/v1`,
      anthropic: `${root}/anthropic`
    }
  } catch {
    return null
  }
}

/** Accept only positive integer token limits; invalid or absent metadata stays unknown. */
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
export function modelsForAgent(models: readonly GatewayModel[], agentId: AgentId): GatewayModel[] {
  if (!canSwitchModel(agentId)) return []
  return [...models]
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

/** Claude Code autocompact env vars, injected for a claude-base agent whose resolved gateway model
 *  reports a context window above `AUTOCOMPACT_THRESHOLD`. These are Claude Code's OWN conventions:
 *  `CLAUDE_CODE_AUTO_COMPACT_WINDOW` sizes the compaction window, `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`
 *  sets the % threshold at which it fires. Listed alongside `MODEL_GATEWAY_ENV_KEYS` in the tmux
 *  `update-environment` conf so a re-attached client inherits them (unset on a non-claude session ⇒
 *  no effect, so including them in the shared conf is harmless). Sourced ONLY from discovery — never
 *  guessed — by `claudeAutocompactFor` below. */
export const AUTOCOMPACT_THRESHOLD = 200_000
export const AUTOCOMPACT_PCT_OVERRIDE = '80'
export const AUTOCOMPACT_ENV_KEYS = [
  'CLAUDE_CODE_AUTO_COMPACT_WINDOW',
  'CLAUDE_AUTOCOMPACT_PCT_OVERRIDE'
] as const

/** Claude Code routes its own subagents through this model. Keeping the key separate from the
 *  autocompact keys makes routing independent of context-window metadata. */
export const CLAUDE_CODE_SUBAGENT_MODEL_KEY = 'CLAUDE_CODE_SUBAGENT_MODEL'
export const CLAUDE_SUBAGENT_ENV_KEYS = [CLAUDE_CODE_SUBAGENT_MODEL_KEY] as const

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
  const names = [
    ...new Set([
      ...TMUX_STOCK_UPDATE_ENV,
      ...MODEL_GATEWAY_ENV_KEYS,
      ...AUTOCOMPACT_ENV_KEYS,
      ...CLAUDE_SUBAGENT_ENV_KEYS,
      ...extraNames
    ])
  ]
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

/**
 * For a claude-base agent and its resolved model, return the `[1m]`-suffixed model id and the
 * Claude Code autocompact env, sourced ONLY from the gateway's discovered model list.
 *
 * Claude Code sizes its autocompact window off the model id and fires compaction at a default %
 * of that window. A gateway model whose real context window is large (e.g. a 1M model surfaced
 * through a proxy as `vllm/GLM-5.2-NVFP4-MTP[1m]`) would otherwise still use the 200k default and
 * compact a long session early. Two levers fix it, both Claude-Code-specific:
 *
 *  1. A `[1m]` suffix on the model id marks a LARGE window. Appended when the discovered window
 *     is above `AUTOCOMPACT_THRESHOLD` (see the comment at the suffix below for what each lever
 *     actually moves — the env var sizes compaction, the suffix is what the CLI's own meter
 *     honors).
 *  2. `CLAUDE_CODE_AUTO_COMPACT_WINDOW` (the window size) and `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`
 *     (the % threshold) env vars, set to the discovered window and `AUTOCOMPACT_PCT_OVERRIDE`.
 *
 * Everything is sourced from discovery — never guessed. An unknown model, or one the gateway did
 * not report a `contextWindow` for, yields NO env and NO suffix (fail open to the CLI's own
 * behavior). A percentage over a guessed window is a wrong number presented as a fact, the same
 * rule used throughout gateway model metadata. Non-claude agents get neither: the env
 * var names and the `[1m]` convention are Claude Code's own and mean nothing to codex/copilot.
 *
 * `modelId` is the (possibly suffixed) id a caller should pass to `withAgentModel`; `env` is the
 * map a spawn site merges into the session environment. The two come from ONE call so the suffix
 * and the env can never disagree about whether this is a large-context session.
 */
export function claudeAutocompactFor(
  agentId: AgentId,
  model: string | undefined,
  models: readonly GatewayModel[]
): { modelId: string | undefined; env: Record<string, string> } {
  // Only a claude-base harness. The env var names are Claude Code's; a codex/copilot node would
  // silently ignore them, and appending [1m] to its --model would send an unknown id to that CLI.
  if (capabilityAgentId(agentId) !== 'claude') return { modelId: model, env: {} }
  const id = normalizedAgentModel(agentId, model)
  if (!id) return { modelId: model, env: {} }
  // The discovered model is the ONLY source of the window. A model not in the catalogue tells us
  // nothing — ship no env and no suffix rather than a guess. Exact ids first; then the
  // `[1m]`-stripped pair, because the SAME model is listed plain and suffixed depending on who
  // stored it (`modelAvailability` already treats either spelling as available — judging the
  // window exact-only here would let a suffixed catalogue spelling silently skip both the env
  // and the shape-mismatch ask for a session launched plain).
  const discovered = models.find((m) => m.id === id) ??
    models.find((m) => m.id.replace(/\[1m\]$/, '') === id.replace(/\[1m\]$/, ''))
  const window = discovered?.contextWindow
  if (!window) return { modelId: id, env: {} }
  if (window <= AUTOCOMPACT_THRESHOLD) {
    return { modelId: id.replace(/\[1m\]$/, ''), env: {} }
  }
  // Append the [1m] marker for EVERY above-threshold window — restored 2026-08-31 after the
  // mid-band "env only" rule measured as a regression: Misc Bugs (5.3 plain, env 400000) still
  // metered 200k in its status line, so `CLAUDE_CODE_AUTO_COMPACT_WINDOW` does NOT drive the
  // CLI's own meter, and the suffix is the only lever that resizes it. The env rides alongside
  // to size the compaction point; the suffix carries the window to the meter. (A suffixed 5.2 in
  // the field metered ~400k, so the suffix claims the window per model — it is not a fixed 1M
  // escalation — which also means a mid-band identifier is safe to suffix.)
  // Symmetric strip: a record whose window dropped below the threshold must NOT keep an old
  // suffix — re-launching it would re-claim the large window.
  //
  // PAIRING INVARIANT (belt-and-suspenders, pinned by model-gateway.test.ts): every branch that
  // emits a suffixed modelId MUST also emit the autocompact env, and the env is emitted ONLY on
  // a suffixed branch. The two halves of the mechanism are one mechanism: the `[1m]` suffix lifts
  // Claude Code's OWN window ceiling (it is what the CLI's status meter honors) and
  // `CLAUDE_CODE_AUTO_COMPACT_WINDOW` pulls the compaction point back DOWN to the discovered
  // size. A suffix without the env lets the context grow toward the ceiling with no autocompact
  // headroom — past what the gateway can serve; an env without the suffix meters 200k while
  // compaction reads the larger window — two windows disagreeing in one session. `pty-manager`
  // asserts the invariant at the composed-env site (refuses the spawn loud) so a future caller
  // that half-applies the pair is caught the day it ships.
  const modelId = window > AUTOCOMPACT_THRESHOLD
    ? (id.endsWith('[1m]') ? id : `${id}[1m]`)
    : id.replace(/\[1m\]$/, '')
  return {
    modelId,
    env: {
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(window),
      CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: AUTOCOMPACT_PCT_OVERRIDE
    }
  }
}

/** Choose only a model the current gateway catalogue says it serves. A configured default wins
 *  when present; otherwise sort here so callers need not know how the catalogue was produced. */
export function claudeSubagentModelFor(
  models: readonly GatewayModel[],
  defaultModel?: string
): string | undefined {
  const ids = [...new Set(modelsForAgent(models, 'claude').map((model) => model.id.trim()).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right))
  const preferred = defaultModel?.trim()
  return preferred && ids.includes(preferred) ? preferred : ids[0]
}

/** Build Claude's gateway subagent routing independently from large-context launch handling. */
export function claudeSubagentEnvFor(
  agentId: AgentId,
  models: readonly GatewayModel[],
  defaultModel?: string
): Record<string, string> {
  if (capabilityAgentId(agentId) !== 'claude') return {}
  const model = claudeSubagentModelFor(models, defaultModel)
  return model ? { [CLAUDE_CODE_SUBAGENT_MODEL_KEY]: model } : {}
}

/** Current reported window for either plain or `[1m]` spelling of one model id. */
export function modelContextWindow(
  modelId: string | undefined,
  models: readonly GatewayModel[]
): number | undefined {
  const id = modelId?.trim()
  if (!id) return undefined
  const base = id.replace(/\[1m\]$/, '')
  const value = models.find((model) => model.id.replace(/\[1m\]$/, '') === base)?.contextWindow
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}
