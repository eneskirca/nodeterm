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
  modelContextWindow,
  modelsForAgent,
  parseGatewayModels,
  parseModelGatewayEnvReference,
  resolveModelGatewayApiKey,
  withAgentModel,
  claudeAutocompactFor,
  claudeEffortFor,
  claudeSubagentEnvFor,
  claudeSubagentModelFor,
  CLAUDE_SUBAGENT_EFFORT_FALLBACK,
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
    expect(withAgentModel('copilot --resume=abc', 'copilot', undefined)).toBe(
      'copilot --resume=abc'
    )
  })

  it('selects the Copilot internal model explicitly without changing its gateway wire id', () => {
    expect(withAgentModel('copilot --resume=abc', 'copilot', 'openai/gpt-5.5')).toBe(
      "copilot --resume=abc --model 'gpt-5.5'"
    )
    expect(withAgentModel('copilot', 'copilot', 'claude-sonnet-4.6')).toBe(
      "copilot --model 'claude-sonnet-4.6'"
    )
    expect(withAgentModel('copilot', 'copilot', 'bad\nmodel')).toBe('copilot')
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
      ).toBe("copilot-wrapper --model 'gpt-5.5'")
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

  it('prefers the reasoning alias when no default is configured', () => {
    const catalog = [...models, { id: 'reasoning' }]
    expect(claudeSubagentModelFor(catalog)).toBe('reasoning')
    // The configured default still beats the alias; a catalogue without it stays deterministic.
    expect(claudeSubagentModelFor(catalog, 'vllm/zeta')).toBe('vllm/zeta')
    expect(claudeSubagentModelFor(models)).toBe('anthropic/alpha')
  })

  it('falls back deterministically when the default is absent or unlisted', () => {
    expect(claudeSubagentModelFor(models, 'missing')).toBe('anthropic/alpha')
    expect(claudeSubagentModelFor([...models].reverse())).toBe('anthropic/alpha')
  })

  it('routes independently of context metadata and only for a Claude-base agent', () => {
    expect(claudeSubagentEnvFor('claude', models)).toEqual({
      CLAUDE_CODE_SUBAGENT_MODEL: 'anthropic/alpha',
      CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '1',
      CLAUDE_CODE_EFFORT_LEVEL: CLAUDE_SUBAGENT_EFFORT_FALLBACK
    })
    for (const id of ['codex', 'copilot', 'custom:plain'] as const) {
      expect(claudeSubagentEnvFor(id, models)).toEqual({})
    }
    expect(claudeSubagentModelFor([], 'vllm/zeta')).toBeUndefined()
    expect(claudeSubagentEnvFor('claude', [], 'vllm/zeta')).toEqual({})
  })

  it('forces the served route for custom Claude agents too', () => {
    setCustomAgentBaseResolver((id) => id === 'custom:proxy' ? 'claude' : undefined)
    try {
      expect(claudeSubagentEnvFor('custom:proxy', models, 'vllm/zeta')).toEqual({
        CLAUDE_CODE_SUBAGENT_MODEL: 'vllm/zeta',
        CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '1',
        CLAUDE_CODE_EFFORT_LEVEL: CLAUDE_SUBAGENT_EFFORT_FALLBACK
      })
    } finally {
      setCustomAgentBaseResolver(null)
    }
  })

  it('delivers every subagent control through the local and remote tmux environment', () => {
    const keys = Object.keys(claudeSubagentEnvFor('claude', models))
    const updateNames = tmuxUpdateEnvironmentLine().split('"')[1].split(' ')
    for (const key of keys) expect(updateNames).toContain(key)
  })
})

describe('gateway reasoning metadata', () => {
  const parsed = parseGatewayModels({
    data: [
      { id: 'vllm/Qwen3.8-27B-FP8', reasoning: { supported_efforts: ['low', 'medium', 'xhigh'], default_effort: 'xhigh' } },
      { id: 'vllm/chat-fast', reasoning: { supported_efforts: ['low', 'medium', 'xhigh'] } },
      { id: 'vllm/GLM-5.3-Flash-FP8' },
      { id: 'vllm/broken', reasoning: { supported_efforts: ['no spaces allowed', 42, null], default_effort: '' } },
      { id: 'vllm/empty-efforts', reasoning: { supported_efforts: [] } },
      { id: 'vllm/wrong-shape', reasoning: 'xhigh' }
    ]
  })
  const byId = (id: string) => parsed.find((m) => m.id === id)

  it('parses the Bifrost reasoning block into supported/default efforts', () => {
    expect(byId('vllm/Qwen3.8-27B-FP8')?.reasoning).toEqual({
      supportedEfforts: ['low', 'medium', 'xhigh'],
      defaultEffort: 'xhigh'
    })
    expect(byId('vllm/chat-fast')?.reasoning).toEqual({ supportedEfforts: ['low', 'medium', 'xhigh'] })
  })

  it('keeps models without usable reasoning metadata plain', () => {
    for (const id of ['vllm/GLM-5.3-Flash-FP8', 'vllm/broken', 'vllm/empty-efforts', 'vllm/wrong-shape']) {
      expect(byId(id)?.reasoning).toBeUndefined()
    }
  })

  it('derives the effort from the selected model, preferring its own default', () => {
    expect(claudeEffortFor(parsed, 'vllm/Qwen3.8-27B-FP8')).toBe('xhigh')
    // No default reported ⇒ the highest supported level.
    expect(claudeEffortFor(parsed, 'vllm/chat-fast')).toBe('xhigh')
  })

  it('falls back to the static default when the model is unknown or carries no metadata', () => {
    for (const id of ['vllm/GLM-5.3-Flash-FP8', 'vllm/broken', 'vllm/empty-efforts', 'vllm/wrong-shape', 'vllm/missing']) {
      expect(claudeEffortFor(parsed, id)).toBe(CLAUDE_SUBAGENT_EFFORT_FALLBACK)
    }
    expect(claudeEffortFor(parsed, undefined)).toBe(CLAUDE_SUBAGENT_EFFORT_FALLBACK)
  })

  it('matches the autocompact `[1m]` spelling', () => {
    const with1m = parseGatewayModels({
      data: [{ id: 'vllm/long', reasoning: { supported_efforts: ['low'], default_effort: 'low' } }]
    })
    expect(claudeEffortFor(with1m, 'vllm/long[1m]')).toBe('low')
  })
})

describe('modelContextWindow', () => {
  const models = [{ id: 'vllm/GLM-5.3', contextWindow: 400_000 }]

  it('matches either plain or [1m]-suffixed spelling', () => {
    expect(modelContextWindow('vllm/GLM-5.3', models)).toBe(400_000)
    expect(modelContextWindow('vllm/GLM-5.3[1m]', models)).toBe(400_000)
  })

  it('returns undefined for an absent model or invalid window', () => {
    expect(modelContextWindow(undefined, models)).toBeUndefined()
    expect(modelContextWindow('other', models)).toBeUndefined()
    expect(modelContextWindow('bad', [{ id: 'bad', contextWindow: Number.NaN }])).toBeUndefined()
  })
})
