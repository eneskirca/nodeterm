import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IPC } from '../shared/ipc'
import {
  type GatewayModel,
  MODEL_GATEWAY_SECRET_REF,
  type ModelGatewaySettings
} from '../shared/agents/model-gateway'
import { registerAgentEnvIpc } from './agent-env-ipc'
import { ModelGatewayCredentialService } from './model-gateway-credentials'
import type { ModelGatewayDiscoveryScope } from './model-gateway-scope'
import { fakePlatform, type FakePlatform } from './platform-fake'
import { initPlatform, resetPlatformForTests } from './platform'

describe('model gateway discovery API-key expansion', () => {
  let fake: FakePlatform
  let fetchMock: ReturnType<typeof vi.fn>
  let inheritedKey: string | undefined
  let credentials: ModelGatewayCredentialService
  let storedKey: string | null
  let savedGateway: ModelGatewaySettings | undefined
  let onDiscovered: ReturnType<
    typeof vi.fn<
      (scope: ModelGatewayDiscoveryScope, models: GatewayModel[]) => void
    >
  >

  beforeEach(async () => {
    inheritedKey = process.env.NODETERM_TEST_GATEWAY_KEY
    fake = fakePlatform()
    initPlatform(fake)
    fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: 'openai/gpt-5.5' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    )
    vi.stubGlobal('fetch', fetchMock)
    storedKey = null
    credentials = new ModelGatewayCredentialService({
      availability: 'encrypted',
      readForHost: async () => storedKey,
      save: async (value) => {
        storedKey = value
      },
      clear: async () => {
        storedKey = null
      }
    })
    await credentials.init()
    savedGateway = undefined
    onDiscovered = vi.fn<
      (scope: ModelGatewayDiscoveryScope, models: GatewayModel[]) => void
    >()
    registerAgentEnvIpc(() => savedGateway, credentials, onDiscovered)
  })

  afterEach(() => {
    if (inheritedKey === undefined) delete process.env.NODETERM_TEST_GATEWAY_KEY
    else process.env.NODETERM_TEST_GATEWAY_KEY = inheritedKey
    vi.unstubAllGlobals()
    resetPlatformForTests()
  })

  it('expands the key in core before authenticating model discovery', async () => {
    process.env.NODETERM_TEST_GATEWAY_KEY = 'vk-from-env'
    savedGateway = {
      baseUrl: 'https://bifrost.example.test',
      apiKey: '${env:NODETERM_TEST_GATEWAY_KEY}'
    }

    const result = await fake.handlers[IPC.agentDiscoverModels]({
      baseUrl: 'https://bifrost.example.test',
      apiKey: '${env:NODETERM_TEST_GATEWAY_KEY}'
    })

    expect(result).toEqual({
      models: [{ id: 'openai/gpt-5.5', provider: 'openai' }]
    })
    expect(fetchMock).toHaveBeenCalledWith(
      'https://bifrost.example.test/v1/models',
      expect.objectContaining({
        headers: {
          Authorization: 'Bearer vk-from-env',
          'x-bf-vk': 'vk-from-env',
          Accept: 'application/json'
        }
      })
    )
  })

  it('does not make a request when the referenced variable is unset', async () => {
    delete process.env.NODETERM_TEST_GATEWAY_KEY
    savedGateway = {
      baseUrl: 'https://bifrost.example.test',
      apiKey: '${env:NODETERM_TEST_GATEWAY_KEY}'
    }

    const result = await fake.handlers[IPC.agentDiscoverModels]({
      baseUrl: 'https://bifrost.example.test',
      apiKey: '${env:NODETERM_TEST_GATEWAY_KEY}'
    })

    expect(result).toEqual({
      models: [],
      error:
        'Gateway API key environment variable is unset: ${env:NODETERM_TEST_GATEWAY_KEY}.'
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('keeps a literal key write-only and uses it for discovery', async () => {
    await expect(
      fake.handlers[IPC.agentGatewayCredentialSave]('stored-gateway-key')
    ).resolves.toEqual({ hasStoredKey: true, storage: 'encrypted' })
    savedGateway = { baseUrl: 'https://gateway.example.test', apiKey: MODEL_GATEWAY_SECRET_REF }

    const result = await fake.handlers[IPC.agentDiscoverModels]({
      baseUrl: 'https://gateway.example.test',
      apiKey: MODEL_GATEWAY_SECRET_REF
    })

    expect(result).toEqual({
      models: [{ id: 'openai/gpt-5.5', provider: 'openai' }]
    })
    expect(fetchMock).toHaveBeenCalledWith(
      'https://gateway.example.test/v1/models',
      expect.objectContaining({
        headers: {
          Authorization: 'Bearer stored-gateway-key',
          'x-bf-vk': 'stored-gateway-key',
          Accept: 'application/json'
        }
      })
    )
    await expect(fake.handlers[IPC.agentGatewayCredentialClear]()).resolves.toEqual({
      hasStoredKey: false,
      storage: 'encrypted'
    })
  })

  // ── The exfiltration-oracle gate ─────────────────────────────────────────────────────────────
  // `platform().handle` answers relay peers and Server Edition WS clients, and the settings
  // payload — baseUrl included — is caller-supplied. Without the gate, discovery would resolve
  // the stored key (or ANY host env var) and send it as a bearer token to whatever URL the caller
  // named. These tests prove the refusal happens BEFORE any request is made.

  it('REFUSES to send the stored key to a caller-chosen URL', async () => {
    await fake.handlers[IPC.agentGatewayCredentialSave]('stored-gateway-key')
    savedGateway = { baseUrl: 'https://gateway.example.test', apiKey: MODEL_GATEWAY_SECRET_REF }

    const result = await fake.handlers[IPC.agentDiscoverModels]({
      baseUrl: 'https://attacker.example.test',
      apiKey: MODEL_GATEWAY_SECRET_REF
    })

    expect(result).toEqual({
      models: [],
      error:
        'Stored or environment API keys are only sent to the saved gateway URL — save the gateway settings first.'
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('REFUSES to resolve an env-var reference for a caller-chosen URL', async () => {
    process.env.NODETERM_TEST_GATEWAY_KEY = 'vk-from-env'
    savedGateway = { baseUrl: 'https://gateway.example.test', apiKey: MODEL_GATEWAY_SECRET_REF }

    const result = await fake.handlers[IPC.agentDiscoverModels]({
      baseUrl: 'https://attacker.example.test',
      apiKey: '${env:NODETERM_TEST_GATEWAY_KEY}'
    })

    expect(result).toMatchObject({ models: [] })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('REFUSES references when no gateway has been saved at all', async () => {
    process.env.NODETERM_TEST_GATEWAY_KEY = 'vk-from-env'
    savedGateway = undefined

    const result = await fake.handlers[IPC.agentDiscoverModels]({
      baseUrl: 'https://bifrost.example.test',
      apiKey: '${env:NODETERM_TEST_GATEWAY_KEY}'
    })

    expect(result).toMatchObject({ models: [] })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('still tests a LITERAL key against an unsaved URL (the pre-save Settings flow)', async () => {
    savedGateway = undefined

    const result = await fake.handlers[IPC.agentDiscoverModels]({
      baseUrl: 'https://new-gateway.example.test',
      apiKey: 'vk-typed-into-the-form'
    })

    expect(result).toEqual({ models: [{ id: 'openai/gpt-5.5', provider: 'openai' }] })
    expect(fetchMock).toHaveBeenCalledWith(
      'https://new-gateway.example.test/v1/models',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer vk-typed-into-the-form' })
      })
    )
    expect(onDiscovered).not.toHaveBeenCalled()
  })

  it('publishes a successful catalogue only for the still-current saved configuration', async () => {
    savedGateway = { baseUrl: 'https://gateway.example.test', apiKey: 'key' }

    await fake.handlers[IPC.agentDiscoverModels]({ ...savedGateway })

    expect(onDiscovered).toHaveBeenCalledTimes(1)
    expect(onDiscovered.mock.calls[0][1]).toEqual([
      { id: 'openai/gpt-5.5', provider: 'openai' }
    ])
  })

  it('drops a response when the effective discovery path changes while it is in flight', async () => {
    let resolve!: (response: Response) => void
    fetchMock.mockReturnValue(new Promise((done) => { resolve = done }))
    savedGateway = { baseUrl: 'https://gateway.example.test', apiKey: 'key' }
    const pending = fake.handlers[IPC.agentDiscoverModels]({ ...savedGateway })

    savedGateway = { ...savedGateway, discoveryPath: '/openai/v1/models' }
    resolve(new Response(JSON.stringify({ data: [{ id: 'old' }] }), { status: 200 }))
    await pending

    expect(onDiscovered).not.toHaveBeenCalled()
  })

  it('drops a response when an environment credential rotates while it is in flight', async () => {
    let resolve!: (response: Response) => void
    fetchMock.mockReturnValue(new Promise((done) => { resolve = done }))
    process.env.NODETERM_TEST_GATEWAY_KEY = 'old'
    savedGateway = {
      baseUrl: 'https://gateway.example.test',
      apiKey: '${env:NODETERM_TEST_GATEWAY_KEY}'
    }
    const pending = fake.handlers[IPC.agentDiscoverModels]({ ...savedGateway })

    process.env.NODETERM_TEST_GATEWAY_KEY = 'new'
    resolve(new Response(JSON.stringify({ data: [{ id: 'old' }] }), { status: 200 }))
    await pending

    expect(onDiscovered).not.toHaveBeenCalled()
  })

  it('drops a response when the stored credential rotates behind the sentinel', async () => {
    await fake.handlers[IPC.agentGatewayCredentialSave]('old')
    let resolve!: (response: Response) => void
    fetchMock.mockReturnValue(new Promise((done) => { resolve = done }))
    savedGateway = {
      baseUrl: 'https://gateway.example.test',
      apiKey: MODEL_GATEWAY_SECRET_REF
    }
    const pending = fake.handlers[IPC.agentDiscoverModels]({ ...savedGateway })

    await fake.handlers[IPC.agentGatewayCredentialSave]('new')
    resolve(new Response(JSON.stringify({ data: [{ id: 'old' }] }), { status: 200 }))
    await pending

    expect(onDiscovered).not.toHaveBeenCalled()
  })

  it('lets only the newest same-scope request publish when responses arrive out of order', async () => {
    const resolves: Array<(response: Response) => void> = []
    fetchMock.mockImplementation(() => new Promise<Response>((done) => resolves.push(done)))
    savedGateway = { baseUrl: 'https://gateway.example.test', apiKey: 'key' }
    const older = fake.handlers[IPC.agentDiscoverModels]({ ...savedGateway })
    const newer = fake.handlers[IPC.agentDiscoverModels]({ ...savedGateway })

    resolves[1](new Response(JSON.stringify({ data: [{ id: 'new' }] }), { status: 200 }))
    await newer
    resolves[0](new Response(JSON.stringify({ data: [{ id: 'old' }] }), { status: 200 }))
    await older

    expect(onDiscovered).toHaveBeenCalledTimes(1)
    expect(onDiscovered.mock.calls[0][1]).toEqual([{ id: 'new' }])
  })

  it('publishes an empty successful catalogue to clear the matching snapshot', async () => {
    savedGateway = { baseUrl: 'https://gateway.example.test', apiKey: 'key' }
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ data: [] }), { status: 200 }))

    await fake.handlers[IPC.agentDiscoverModels]({ ...savedGateway })

    expect(onDiscovered).toHaveBeenCalledTimes(1)
    expect(onDiscovered.mock.calls[0][1]).toEqual([])
  })
})
