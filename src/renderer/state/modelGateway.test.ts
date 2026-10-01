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

    expect(useModelGateway.getState()).toMatchObject({ models: [], status: 'idle' })
  })
})
