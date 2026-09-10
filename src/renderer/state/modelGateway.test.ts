// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  sameModelGatewayDiscoveryConfig,
  useModelGateway
} from './modelGateway'

describe('model gateway catalogue provenance', () => {
  beforeEach(() => {
    ;(window as unknown as { nodeTerminal: any }).nodeTerminal = {
      agent: { discoverModels: vi.fn() }
    }
    useModelGateway.getState().clear()
  })

  it('treats conventional discovery-path spellings as the same configuration', () => {
    expect(
      sameModelGatewayDiscoveryConfig(
        { baseUrl: 'https://gateway.test/', apiKey: ' key ' },
        { baseUrl: 'https://gateway.test', apiKey: 'key', discoveryPath: '/v1/models' }
      )
    ).toBe(true)
  })

  it('drops a deferred response after synchronous invalidation', async () => {
    let resolve!: (value: { models: Array<{ id: string; contextWindow: number }> }) => void
    vi.mocked(window.nodeTerminal.agent.discoverModels).mockReturnValue(
      new Promise((done) => { resolve = done })
    )
    const pending = useModelGateway.getState().discover({
      baseUrl: 'https://old.test',
      apiKey: 'old'
    })

    useModelGateway.getState().clear()
    resolve({ models: [{ id: 'old', contextWindow: 1_000_000 }] })
    await pending

    expect(useModelGateway.getState()).toMatchObject({
      models: [],
      status: 'idle',
      discoveryAt: undefined
    })
  })

  it('does not advance completion when an older request lands after the current one', async () => {
    const resolves: Array<(value: { models: Array<{ id: string }> }) => void> = []
    vi.mocked(window.nodeTerminal.agent.discoverModels).mockImplementation(
      () => new Promise((resolve) => resolves.push(resolve))
    )
    const older = useModelGateway.getState().discover({ baseUrl: 'https://old.test', apiKey: 'old' })
    const current = useModelGateway.getState().discover({ baseUrl: 'https://new.test', apiKey: 'new' })

    resolves[1]({ models: [{ id: 'current' }] })
    await current
    const completion = useModelGateway.getState().discoveryAt
    resolves[0]({ models: [{ id: 'stale' }] })
    await older

    expect(useModelGateway.getState()).toMatchObject({
      models: [{ id: 'current' }],
      status: 'ready',
      discoveryAt: completion
    })
  })

  it('advances only the current completion, including ready-empty and error results', async () => {
    vi.mocked(window.nodeTerminal.agent.discoverModels)
      .mockResolvedValueOnce({ models: [] })
      .mockResolvedValueOnce({ models: [], error: 'unavailable' })

    await useModelGateway.getState().discover({ baseUrl: 'https://gateway.test', apiKey: 'key' })
    expect(useModelGateway.getState()).toMatchObject({
      models: [],
      status: 'ready',
      discoveryAt: expect.any(Number)
    })
    const firstCompletion = useModelGateway.getState().discoveryAt

    await useModelGateway.getState().discover({ baseUrl: 'https://gateway.test', apiKey: 'key' })
    expect(useModelGateway.getState()).toMatchObject({
      models: [],
      status: 'error',
      discoveryAt: expect.any(Number)
    })
    expect(useModelGateway.getState().discoveryAt).toBeGreaterThan(firstCompletion ?? 0)
  })
})
