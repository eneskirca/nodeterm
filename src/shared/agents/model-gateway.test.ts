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
  withAgentModel,
  claudeAutocompactFor,
  claudeSubagentEnvFor,
  claudeSubagentModelFor,
  AUTOCOMPACT_THRESHOLD,
  AUTOCOMPACT_PCT_OVERRIDE,
  tmuxUpdateEnvironmentLine
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

  it('appends a supplied discovery path instead of the conventional /v1/models', () => {
    expect(modelGatewayRoutes('https://bifrost.example.test', '/openai/v1/models')).toEqual({
      discovery: 'https://bifrost.example.test/openai/v1/models',
      openai: 'https://bifrost.example.test/openai/v1',
      anthropic: 'https://bifrost.example.test/anthropic'
    })
  })

  it('falls back to /v1/models when the discovery path is absent, empty, or unsafe', () => {
    // Absent/empty = the conventional suffix. Unsafe values (full URLs — a caller-chosen host
    // would be a credential-exfiltration oracle — query, fragment, traversal) degrade to the
    // derived default, never to a fetch somewhere unvetted.
    expect(modelGatewayRoutes('https://bifrost.example.test', undefined)?.discovery).toBe(
      'https://bifrost.example.test/v1/models'
    )
    expect(modelGatewayRoutes('https://bifrost.example.test', '')?.discovery).toBe(
      'https://bifrost.example.test/v1/models'
    )
    expect(modelGatewayRoutes('https://bifrost.example.test', 'https://evil.test/x')?.discovery).toBe(
      'https://bifrost.example.test/v1/models'
    )
    expect(modelGatewayRoutes('https://bifrost.example.test', '/../etc')?.discovery).toBe(
      'https://bifrost.example.test/v1/models'
    )
    expect(modelGatewayRoutes('https://bifrost.example.test', '/x?y=1')?.discovery).toBe(
      'https://bifrost.example.test/v1/models'
    )
    expect(modelGatewayRoutes('https://bifrost.example.test', '/x#f')?.discovery).toBe(
      'https://bifrost.example.test/v1/models'
    )
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

describe('claudeAutocompactFor', () => {
  // A model above the threshold, one at exactly the threshold, and one below — sourced from
  // discovery the way the spawn site resolves them.
  const models = parseGatewayModels({
    data: [
      { id: 'anthropic/claude-opus-5', context_length: 1_000_000 },
      { id: 'anthropic/claude-sonnet-5', context_length: 200_000 },
      { id: 'anthropic/claude-haiku-5', context_length: 100_000 }
    ]
  })

  it('appends [1m] + sets the autocompact env for a claude model whose window is above the threshold', () => {
    const r = claudeAutocompactFor('claude', 'anthropic/claude-opus-5', models)
    expect(r.modelId).toBe('anthropic/claude-opus-5[1m]')
    expect(r.env).toEqual({
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: '1000000',
      CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: AUTOCOMPACT_PCT_OVERRIDE
    })
  })

  it('a window BETWEEN the threshold and 1M gets the env AND the suffix', () => {
    // The env var does NOT drive the CLI's own meter (measured: Misc Bugs, 5.3 plain, env
    // 400000, status line still 200k) — the [1m] suffix is the only lever Claude Code honors
    // for the meter, so every above-threshold window carries it, mid-band included.
    const mid = parseGatewayModels({
      data: [{ id: 'vllm/GLM-5.3-Flash-NVFP4', context_length: 400_000 }]
    })
    const r = claudeAutocompactFor('claude', 'vllm/GLM-5.3-Flash-NVFP4', mid)
    expect(r.modelId).toBe('vllm/GLM-5.3-Flash-NVFP4[1m]')
    expect(r.env).toEqual({
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: '400000',
      CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: AUTOCOMPACT_PCT_OVERRIDE
    })
  })

  it('a suffixed mid-band record stays suffixed — the suffix is not re-stripped on re-launch', () => {
    const mid = parseGatewayModels({
      data: [{ id: 'vllm/GLM-5.2-NVFP4-MTP', context_length: 400_000 }]
    })
    const r = claudeAutocompactFor('claude', 'vllm/GLM-5.2-NVFP4-MTP[1m]', mid)
    expect(r.modelId).toBe('vllm/GLM-5.2-NVFP4-MTP[1m]')
    expect(r.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('400000')
  })

  it('does not double-append [1m] when the id already carries it', () => {
    const withSuffix = parseGatewayModels({
      data: [{ id: 'vllm/GLM-5.2-NVFP4-MTP[1m]', context_length: 1_000_000 }]
    })
    const r = claudeAutocompactFor('claude', 'vllm/GLM-5.2-NVFP4-MTP[1m]', withSuffix)
    expect(r.modelId).toBe('vllm/GLM-5.2-NVFP4-MTP[1m]')
    expect(r.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('1000000')
  })

  it('sets neither env nor suffix at or below the threshold — never guesses a large window', () => {
    // Exactly the threshold: not above it, so no autocompact.
    expect(claudeAutocompactFor('claude', 'anthropic/claude-sonnet-5', models).env).toEqual({})
    expect(claudeAutocompactFor('claude', 'anthropic/claude-sonnet-5', models).modelId).toBe(
      'anthropic/claude-sonnet-5'
    )
    // Below the threshold.
    expect(claudeAutocompactFor('claude', 'anthropic/claude-haiku-5', models).env).toEqual({})
    expect(claudeAutocompactFor('claude', 'anthropic/claude-haiku-5', models).modelId).toBe(
      'anthropic/claude-haiku-5'
    )
  })

  it('strips a stale [1m] suffix when the discovered window is no longer large', () => {
    expect(
      claudeAutocompactFor('claude', 'anthropic/claude-sonnet-5[1m]', models)
    ).toEqual({ modelId: 'anthropic/claude-sonnet-5', env: {} })
  })

  it('fails open for an unknown model or one with no reported window — no guess, no suffix', () => {
    expect(claudeAutocompactFor('claude', 'anthropic/claude-future', models).env).toEqual({})
    expect(claudeAutocompactFor('claude', 'anthropic/claude-future', models).modelId).toBe(
      'anthropic/claude-future'
    )
    // A discovered model that reported no context_length.
    const noWindow = parseGatewayModels({ data: [{ id: 'anthropic/claude-x' }] })
    expect(claudeAutocompactFor('claude', 'anthropic/claude-x', noWindow).env).toEqual({})
  })

  it('PAIRING INVARIANT: every suffixed branch emits the env with it; the env never rides alone', () => {
    // The two halves of the autocompact mechanism are ONE mechanism: the [1m] suffix lifts the
    // CLI's own window ceiling; CLAUDE_CODE_AUTO_COMPACT_WINDOW pulls the compaction point back
    // to the discovered size. A suffix without the env grows the context past the headroom the
    // gateway can serve (the Misc Bugs report); an env without the suffix meters 200k while
    // compaction fires at the bigger window. One call emits both — this pins that no branch can
    // emit one without the other.
    const above = parseGatewayModels({
      data: [
        { id: 'a', context_length: 400_000 },
        { id: 'b', context_length: 1_000_000 }
      ]
    })
    for (const m of above) {
      const r = claudeAutocompactFor('claude', m.id, above)
      expect(r.modelId?.endsWith('[1m]')).toBe(true)
      expect(r.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBeTruthy()
    }
    // Inverse: the env implies the suffix — every branch emitting env is a suffixed branch.
    for (const m of above) {
      const r = claudeAutocompactFor('claude', m.id, above)
      expect(!!r.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW && r.modelId?.endsWith('[1m]')).toBe(true)
    }
    // At and below the threshold: NEITHER half — never one alone.
    const at = parseGatewayModels({ data: [{ id: 'c', context_length: 200_000 }] })
    expect(claudeAutocompactFor('claude', 'c', at)).toEqual({ modelId: 'c', env: {} })
  })

  it('is a no-op for a non-claude agent — the env vars and [1m] convention are Claude Code own', () => {
    for (const id of ['codex', 'copilot', 'gemini', 'grok', 'opencode'] as const) {
      const r = claudeAutocompactFor(id, 'anthropic/claude-opus-5', models)
      expect(r.env).toEqual({})
      expect(r.modelId).toBe('anthropic/claude-opus-5')
    }
  })

  it('returns the unchanged id (no --model) when there is no model at all', () => {
    expect(claudeAutocompactFor('claude', undefined, models)).toEqual({ modelId: undefined, env: {} })
  })

  it('threshold is above the 200k default so an ordinary 200k model does NOT trigger it', () => {
    expect(AUTOCOMPACT_THRESHOLD).toBe(200_000)
  })
})

describe('autocompact env keys lockstep', () => {
  it('the autocompact keys are in the tmux update-environment line so a re-attached client inherits them', () => {
    const line = tmuxUpdateEnvironmentLine()
    expect(line).toContain('CLAUDE_CODE_AUTO_COMPACT_WINDOW')
    expect(line).toContain('CLAUDE_AUTOCOMPACT_PCT_OVERRIDE')
    // And a large-context claude model actually emits those keys through the helper.
    const models = parseGatewayModels({ data: [{ id: 'anthropic/claude-opus-5', context_length: 1_000_000 }] })
    for (const k of Object.keys(claudeAutocompactFor('claude', 'anthropic/claude-opus-5', models).env)) {
      expect(line).toContain(k)
    }
  })
})

describe('Claude gateway subagent routing', () => {
  const models = [
    { id: 'vllm/zeta', contextWindow: 200_000 },
    { id: 'anthropic/alpha' }
  ]

  it('prefers the configured default when the gateway lists it', () => {
    expect(claudeSubagentModelFor(models, 'vllm/zeta')).toBe('vllm/zeta')
  })

  it('falls back deterministically when the default is absent or unlisted', () => {
    expect(claudeSubagentModelFor(models, 'missing')).toBe('anthropic/alpha')
    expect(claudeSubagentModelFor([...models].reverse())).toBe('anthropic/alpha')
  })

  it('routes independently of context metadata and only for a Claude-base agent', () => {
    expect(claudeSubagentEnvFor('claude', models)).toEqual({
      CLAUDE_CODE_SUBAGENT_MODEL: 'anthropic/alpha'
    })
    expect(claudeSubagentEnvFor('codex', models)).toEqual({})
    expect(claudeSubagentModelFor([], 'vllm/zeta')).toBeUndefined()
    expect(tmuxUpdateEnvironmentLine()).toContain('CLAUDE_CODE_SUBAGENT_MODEL')
  })
})
