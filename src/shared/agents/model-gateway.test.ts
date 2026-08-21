import { describe, expect, it } from 'vitest'
import {
  MODEL_GATEWAY_ENV_KEYS,
  MODEL_GATEWAY_SECRET_REF,
  modelGatewayEnv,
  modelGatewayCredentialKind,
  modelGatewayRoutes,
  modelsForAgent,
  parseGatewayModels,
  parseModelGatewayEnvReference,
  resolveModelGatewayApiKey,
  withAgentModel
} from './model-gateway'
import {
  setCustomAgentBaseResolver,
  type AgentId,
  type BuiltinAgentId
} from './config'

describe('modelGatewayRoutes', () => {
  it('derives Bifrost discovery and protocol routes from one root', () => {
    expect(modelGatewayRoutes('https://bifrost.example.test/root///')).toEqual({
      discovery: 'https://bifrost.example.test/root/v1/models',
      openai: 'https://bifrost.example.test/root/openai/v1',
      anthropic: 'https://bifrost.example.test/root/anthropic'
    })
  })

  it('refuses non-http, credential-bearing, and ambiguous URLs', () => {
    expect(modelGatewayRoutes('file:///tmp/gateway')).toBeNull()
    expect(modelGatewayRoutes('https://key@example.test')).toBeNull()
    expect(modelGatewayRoutes('https://example.test?route=other')).toBeNull()
    expect(modelGatewayRoutes('https://example.test/#fragment')).toBeNull()
    expect(modelGatewayRoutes('not a URL')).toBeNull()
  })
})

describe('parseGatewayModels', () => {
  it('normalizes, sorts, and deduplicates an OpenAI-compatible model list', () => {
    expect(
      parseGatewayModels({
        data: [
          { id: 'openai/gpt-5', owned_by: 'openai' },
          { id: 'anthropic/claude-sonnet-4', name: 'Sonnet' },
          { id: 'openai/gpt-5', name: 'Latest wins' },
          { id: '' },
          null
        ]
      })
    ).toEqual([
      { id: 'anthropic/claude-sonnet-4', name: 'Sonnet', provider: 'anthropic' },
      { id: 'openai/gpt-5', name: 'Latest wins', provider: 'openai' }
    ])
  })

  it('fails closed on an unexpected response shape', () => {
    expect(parseGatewayModels({ models: [{ id: 'gpt-5' }] })).toEqual([])
    expect(parseGatewayModels(null)).toEqual([])
  })

  it('reads context/output token limits under the common field names, tolerating strings and garbage', () => {
    expect(
      parseGatewayModels({
        data: [
          // OpenAI convention: context_length + max_output_tokens
          { id: 'openai/gpt-5', context_length: 400000, max_output_tokens: 16384 },
          // context_window alias + max_completion_tokens
          { id: 'anthropic/claude-sonnet-4', context_window: 200000, max_completion_tokens: 8192 },
          // max_context_length variant
          { id: 'misc/variant', max_context_length: 128000 },
          // string-encoded limit
          { id: 'misc/str', context_length: '32000' },
          // garbage / non-positive → omitted, model still listed
          { id: 'misc/bad', context_length: 'nope', max_output_tokens: 0 },
          // nothing reported → no limit fields
          { id: 'misc/none' }
        ]
      })
    ).toEqual([
      { id: 'anthropic/claude-sonnet-4', provider: 'anthropic', contextWindow: 200000, maxOutputTokens: 8192 },
      { id: 'misc/bad', provider: 'misc' },
      { id: 'misc/none', provider: 'misc' },
      { id: 'misc/str', provider: 'misc', contextWindow: 32000 },
      { id: 'misc/variant', provider: 'misc', contextWindow: 128000 },
      { id: 'openai/gpt-5', provider: 'openai', contextWindow: 400000, maxOutputTokens: 16384 }
    ])
  })
})

describe('agent mappings', () => {
  const gateway = { baseUrl: 'https://bifrost.example.test', apiKey: 'vk-secret' }

  it('maps the shared gateway to Claude and Codex environment variables', () => {
    expect(modelGatewayEnv(gateway, 'claude')).toEqual({
      ANTHROPIC_BASE_URL: 'https://bifrost.example.test/anthropic',
      ANTHROPIC_AUTH_TOKEN: 'vk-secret'
    })
    expect(modelGatewayEnv(gateway, 'codex')).toEqual({
      OPENAI_BASE_URL: 'https://bifrost.example.test/openai/v1',
      OPENAI_API_KEY: 'vk-secret'
    })
    expect(modelGatewayEnv(gateway, 'gemini')).toEqual({})
  })

  it('expands the API key from the host environment for every mapped harness', () => {
    const envGateway = {
      baseUrl: gateway.baseUrl,
      apiKey: '${env:BIFROST_API_KEY}'
    }
    expect(resolveModelGatewayApiKey(envGateway.apiKey, { BIFROST_API_KEY: 'vk-env' })).toEqual({
      value: 'vk-env',
      missing: [],
      storedSecretMissing: false
    })
    expect(modelGatewayEnv(envGateway, 'claude', undefined, { BIFROST_API_KEY: 'vk-env' })).toEqual({
      ANTHROPIC_BASE_URL: 'https://bifrost.example.test/anthropic',
      ANTHROPIC_AUTH_TOKEN: 'vk-env'
    })
  })

  it('fails closed when a referenced key is unset', () => {
    expect(
      modelGatewayEnv(
        { baseUrl: gateway.baseUrl, apiKey: '${env:BIFROST_API_KEY}' },
        'codex'
      )
    ).toEqual({})
  })

  it('resolves a stored-key sentinel without exposing the secret in settings', () => {
    const storedGateway = { baseUrl: gateway.baseUrl, apiKey: MODEL_GATEWAY_SECRET_REF }
    expect(resolveModelGatewayApiKey(storedGateway.apiKey, {}, 'stored-key')).toEqual({
      value: 'stored-key',
      missing: [],
      storedSecretMissing: false
    })
    expect(resolveModelGatewayApiKey(storedGateway.apiKey, {})).toEqual({
      value: '',
      missing: [],
      storedSecretMissing: true
    })
    expect(modelGatewayEnv(storedGateway, 'codex', undefined, {}, 'stored-key')).toEqual({
      OPENAI_BASE_URL: 'https://bifrost.example.test/openai/v1',
      OPENAI_API_KEY: 'stored-key'
    })
    expect(modelGatewayEnv(storedGateway, 'codex')).toEqual({})
  })

  it('classifies the persisted credential forms for the settings UI and migration', () => {
    expect(parseModelGatewayEnvReference('${env:BIFROST_VK}')).toEqual({
      name: 'BIFROST_VK'
    })
    expect(parseModelGatewayEnvReference('${env:BIFROST_VK:fallback}')).toBeNull()
    expect(modelGatewayCredentialKind('')).toBe('empty')
    expect(modelGatewayCredentialKind('${env:BIFROST_VK}')).toBe('environment')
    expect(modelGatewayCredentialKind(MODEL_GATEWAY_SECRET_REF)).toBe('stored')
    expect(modelGatewayCredentialKind('legacy-key')).toBe('legacy-literal')
  })

  it('maps Copilot BYOK through the protocol route and separates model id from wire id', () => {
    expect(modelGatewayEnv(gateway, 'copilot', 'anthropic/claude-sonnet-4.6')).toEqual({
      COPILOT_PROVIDER_BASE_URL: 'https://bifrost.example.test/anthropic',
      COPILOT_PROVIDER_TYPE: 'anthropic',
      COPILOT_PROVIDER_API_KEY: 'vk-secret',
      COPILOT_PROVIDER_MODEL_ID: 'claude-sonnet-4.6',
      COPILOT_PROVIDER_WIRE_MODEL: 'anthropic/claude-sonnet-4.6'
    })
    expect(modelGatewayEnv(gateway, 'copilot', 'openai/gpt-5.5')).toEqual({
      COPILOT_PROVIDER_BASE_URL: 'https://bifrost.example.test/openai/v1',
      COPILOT_PROVIDER_TYPE: 'openai',
      COPILOT_PROVIDER_API_KEY: 'vk-secret',
      COPILOT_PROVIDER_MODEL_ID: 'gpt-5.5',
      COPILOT_PROVIDER_WIRE_MODEL: 'openai/gpt-5.5',
      COPILOT_PROVIDER_WIRE_API: 'responses'
    })
  })

  it('does not activate Copilot BYOK until a model is selected', () => {
    expect(modelGatewayEnv(gateway, 'copilot')).toEqual({})
    expect(withAgentModel('copilot --resume=abc', 'copilot', 'openai/gpt-5.5')).toBe(
      'copilot --resume=abc'
    )
  })

  it('injects Copilot max-context env vars from discovery, and omits them when limits are unknown', () => {
    const models = parseGatewayModels({
      data: [
        { id: 'openai/gpt-5', context_length: 400000, max_output_tokens: 16384 },
        { id: 'anthropic/claude-sonnet-4', context_window: 200000 },
        { id: 'openai/gpt-5.5' }
      ]
    })
    // Both limits known → both env vars emitted.
    expect(modelGatewayEnv(gateway, 'copilot', 'openai/gpt-5', {}, null, models)).toEqual({
      COPILOT_PROVIDER_BASE_URL: 'https://bifrost.example.test/openai/v1',
      COPILOT_PROVIDER_TYPE: 'openai',
      COPILOT_PROVIDER_API_KEY: 'vk-secret',
      COPILOT_PROVIDER_MODEL_ID: 'gpt-5',
      COPILOT_PROVIDER_WIRE_MODEL: 'openai/gpt-5',
      COPILOT_PROVIDER_WIRE_API: 'responses',
      COPILOT_PROVIDER_MAX_PROMPT_TOKENS: '400000',
      COPILOT_PROVIDER_MAX_OUTPUT_TOKENS: '16384'
    })
    // Output limit unknown → only the prompt cap is emitted (never guessed).
    expect(modelGatewayEnv(gateway, 'copilot', 'anthropic/claude-sonnet-4', {}, null, models)).toEqual({
      COPILOT_PROVIDER_BASE_URL: 'https://bifrost.example.test/anthropic',
      COPILOT_PROVIDER_TYPE: 'anthropic',
      COPILOT_PROVIDER_API_KEY: 'vk-secret',
      COPILOT_PROVIDER_MODEL_ID: 'claude-sonnet-4',
      COPILOT_PROVIDER_WIRE_MODEL: 'anthropic/claude-sonnet-4',
      COPILOT_PROVIDER_MAX_PROMPT_TOKENS: '200000'
    })
    // Model present in the catalogue but with NO reported limits → no max-token env vars.
    expect(modelGatewayEnv(gateway, 'copilot', 'openai/gpt-5.5', {}, null, models)).toEqual({
      COPILOT_PROVIDER_BASE_URL: 'https://bifrost.example.test/openai/v1',
      COPILOT_PROVIDER_TYPE: 'openai',
      COPILOT_PROVIDER_API_KEY: 'vk-secret',
      COPILOT_PROVIDER_MODEL_ID: 'gpt-5.5',
      COPILOT_PROVIDER_WIRE_MODEL: 'openai/gpt-5.5',
      COPILOT_PROVIDER_WIRE_API: 'responses'
    })
    // Model not in the discovered list at all → no max-token env vars (no cache hit, no guess).
    expect(
      modelGatewayEnv(gateway, 'copilot', 'openai/gpt-5.5', {}, null, [])
    ).not.toHaveProperty('COPILOT_PROVIDER_MAX_PROMPT_TOKENS')
  })

  it('quotes model ids and refuses unsupported/control-bearing values', () => {
    expect(withAgentModel('codex resume abc', 'codex', "openai/o'model")).toBe(
      "codex resume abc --model 'openai/o'\\''model'"
    )
    expect(withAgentModel('gemini --resume abc', 'gemini', 'gemini/pro')).toBe(
      'gemini --resume abc'
    )
    expect(withAgentModel('claude', 'claude', 'bad\nmodel')).toBe('claude')
  })

  it('offers every Bifrost model to each capable harness', () => {
    const models = parseGatewayModels({
      data: [
        { id: 'openai/gpt-5' },
        { id: 'anthropic/claude-sonnet-4' },
        { id: 'claude-alias' }
      ]
    })
    const all = [
      'anthropic/claude-sonnet-4',
      'claude-alias',
      'openai/gpt-5'
    ]
    expect(modelsForAgent(models, 'claude').map((m) => m.id)).toEqual(all)
    expect(modelsForAgent(models, 'codex').map((m) => m.id)).toEqual(all)
    expect(modelsForAgent(models, 'copilot').map((m) => m.id)).toEqual(all)
    expect(modelsForAgent(models, 'gemini')).toEqual([])
  })

  it('inherits mappings and filtering through a custom base agent', () => {
    setCustomAgentBaseResolver((id: AgentId): BuiltinAgentId | undefined =>
      id === 'custom:proxy' ? 'claude' : undefined
    )
    try {
      expect(modelGatewayEnv(gateway, 'custom:proxy')).toEqual({
        ANTHROPIC_BASE_URL: 'https://bifrost.example.test/anthropic',
        ANTHROPIC_AUTH_TOKEN: 'vk-secret'
      })
      expect(withAgentModel('proxy', 'custom:proxy', 'anthropic/claude-opus')).toBe(
        "proxy --model 'anthropic/claude-opus'"
      )
    } finally {
      setCustomAgentBaseResolver(null)
    }
  })

  it('inherits Copilot BYOK grammar through a custom base agent without a frontend exception', () => {
    setCustomAgentBaseResolver((id: AgentId): BuiltinAgentId | undefined =>
      id === 'custom:copilot-proxy' ? 'copilot' : undefined
    )
    try {
      expect(
        modelGatewayEnv(gateway, 'custom:copilot-proxy', 'openai/gpt-5.5')
      ).toMatchObject({
        COPILOT_PROVIDER_TYPE: 'openai',
        COPILOT_PROVIDER_MODEL_ID: 'gpt-5.5',
        COPILOT_PROVIDER_WIRE_MODEL: 'openai/gpt-5.5'
      })
      expect(
        withAgentModel('copilot-wrapper', 'custom:copilot-proxy', 'openai/gpt-5.5')
      ).toBe('copilot-wrapper')
    } finally {
      setCustomAgentBaseResolver(null)
    }
  })
})

describe('MODEL_GATEWAY_ENV_KEYS lockstep', () => {
  it('covers every var any capability base can emit — a missed key never reaches a shared tmux server', () => {
    const gateway = { baseUrl: 'https://gw.example.test', apiKey: 'vk-1' }
    // Models carrying context/output limits so the Copilot max-token keys are exercised too.
    const models = parseGatewayModels({
      data: [
        { id: 'openai/gpt-5.5-codex', context_length: 400000, max_output_tokens: 16384 },
        { id: 'openai/gpt-5', context_length: 400000, max_output_tokens: 16384 },
        { id: 'anthropic/claude-sonnet-5', context_length: 200000, max_output_tokens: 8192 }
      ]
    })
    const seen = new Set<string>()
    for (const id of ['claude', 'codex', 'gemini', 'grok', 'copilot'] as const) {
      for (const k of Object.keys(
        modelGatewayEnv(gateway, id, 'openai/gpt-5.5-codex', {}, null, models)
      ))
        seen.add(k)
      // The gpt-5 responses-API marker only appears for a gpt-5-family OpenAI model.
      for (const k of Object.keys(modelGatewayEnv(gateway, id, 'openai/gpt-5', {}, null, models)))
        seen.add(k)
      for (const k of Object.keys(
        modelGatewayEnv(gateway, id, 'anthropic/claude-sonnet-5', {}, null, models)
      ))
        seen.add(k)
    }
    expect(seen.size).toBeGreaterThan(0)
    for (const k of seen) expect(MODEL_GATEWAY_ENV_KEYS).toContain(k)
    // The two new keys must be reachable when limits are discovered, else the lockstep would
    // silently never cover them.
    expect(seen).toContain('COPILOT_PROVIDER_MAX_PROMPT_TOKENS')
    expect(seen).toContain('COPILOT_PROVIDER_MAX_OUTPUT_TOKENS')
  })
})
