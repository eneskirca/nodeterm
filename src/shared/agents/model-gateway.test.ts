import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import path from 'path'
import {
  grokModelsFrom,
  normalizedAgentModel,
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
    const seen = new Set<string>()
    for (const id of ['claude', 'codex', 'gemini', 'grok', 'copilot'] as const) {
      for (const k of Object.keys(
        modelGatewayEnv(gateway, id, 'openai/gpt-5.5-codex')
      ))
        seen.add(k)
      // The gpt-5 responses-API marker only appears for a gpt-5-family OpenAI model.
      for (const k of Object.keys(modelGatewayEnv(gateway, id, 'openai/gpt-5')))
        seen.add(k)
      for (const k of Object.keys(
        modelGatewayEnv(gateway, id, 'anthropic/claude-sonnet-5')
      ))
        seen.add(k)
    }
    expect(seen.size).toBeGreaterThan(0)
    for (const k of seen) expect(MODEL_GATEWAY_ENV_KEYS).toContain(k)
  })
})


describe('grokModelsFrom — discovery without an allowlist', () => {
  // Captured verbatim from `grok models` on 1.0.13 (2026-09-02). The CLI lists its own models, so
  // there is no allowlist to maintain and a model shipped tomorrow appears with no code change.
  const REAL = readFileSync(path.join(__dirname, '__fixtures__/grok-models.txt'), 'utf8')

  it('reads the ids out of the real output', () => {
    expect(grokModelsFrom(REAL)).toEqual([{ id: 'grok-4.6' }, { id: 'grok-4.5' }])
  })

  it('does not mistake the "Default model:" line for an entry', () => {
    // That line repeats an id the bullet list already carries. Treating prose as data is how a login
    // banner or a future footer becomes a fake model id on the menu.
    const out = grokModelsFrom(REAL)
    expect(out.filter((m) => m.id === 'grok-4.6')).toHaveLength(1)
    expect(out.map((m) => m.id)).not.toContain('model:')
  })

  it('stops at the first unindented line', () => {
    const withFooter = REAL + 'Run `grok --help` for more.\n  - not-a-model\n'
    expect(grokModelsFrom(withFooter).map((m) => m.id)).toEqual(['grok-4.6', 'grok-4.5'])
  })

  it('rejects an id that could not safely reach a command line', () => {
    const hostile = 'Available models:\n  - ok-model\n  - $(rm -rf /)\n  - --flag-shaped\n'
    expect(grokModelsFrom(hostile).map((m) => m.id)).toEqual(['ok-model'])
  })

  it('is EMPTY for anything it cannot parse — never a partial list', () => {
    // A failed probe must read as "no model switching", i.e. the pre-feature behaviour.
    expect(grokModelsFrom('')).toEqual([])
    expect(grokModelsFrom(null)).toEqual([])
    expect(grokModelsFrom('command not found: grok')).toEqual([])
    expect(grokModelsFrom('You are logged in with grok.com.')).toEqual([])
  })
})

describe('modelsForAgent — grok is offered its OWN models, never the gateway catalogue', () => {
  const GATEWAY = [{ id: 'anthropic/claude-x' }, { id: 'openai/gpt-x' }]
  const GROK = [{ id: 'grok-4.6' }]

  it("returns grok's list for a grok node", () => {
    // Correctness, not preference: grok cannot be routed through the gateway at all (its custom
    // models live in config.toml, not in env). Offering the gateway catalogue would put ids on the
    // menu that grok rejects at launch — a picker that looks like it worked and kills the node.
    expect(modelsForAgent(GATEWAY, 'grok', GROK)).toEqual(GROK)
  })

  it('gives grok nothing when its own probe found nothing', () => {
    expect(modelsForAgent(GATEWAY, 'grok')).toEqual([])
  })

  it('leaves every other agent on the gateway catalogue', () => {
    expect(modelsForAgent(GATEWAY, 'claude', GROK)).toEqual(GATEWAY)
    expect(modelsForAgent(GATEWAY, 'codex', GROK)).toEqual(GATEWAY)
  })
})

describe('grok takes its model as a FLAG, and needs no gateway environment', () => {
  it('appends --model before anything else touches the line', () => {
    expect(withAgentModel('grok', 'grok', 'grok-4.5')).toBe("grok --model 'grok-4.5'")
  })

  it('emits no environment at all', () => {
    // grok's custom models are declared in ~/.grok/config.toml with their own base_url/api_key, and
    // that file explicitly cannot be defaulted from the environment. Emitting the OpenAI pair anyway
    // would point grok's built-in models at a gateway they were never configured for.
    const settings = { baseUrl: 'https://gw.example', apiKey: 'k' }
    expect(modelGatewayEnv(settings as never, 'grok', 'grok-4.6', {}, 'secret')).toEqual({})
  })

  it('refuses a hand-edited id at the point it would reach the command line', () => {
    expect(normalizedAgentModel('grok', 'grok-4.6 && rm -rf /')).toBe('grok-4.6 && rm -rf /')
    expect(withAgentModel('grok', 'grok', 'grok-4.6 && rm -rf /')).toBe(
      "grok --model 'grok-4.6 && rm -rf /'"
    )
  })
})
