import { afterEach, describe, expect, it, vi } from 'vitest'
import { modelRespawnErrorKind, modelRespawnTrace } from './model-respawn-trace'

afterEach(() => vi.restoreAllMocks())

describe('modelRespawnTrace', () => {
  it('emits one searchable line and omits undefined fields', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    modelRespawnTrace('restart.begin', { nodeId: 'node-1', attempt: 2, detail: undefined })
    expect(info).toHaveBeenCalledOnce()
    expect(info).toHaveBeenCalledWith(
      '[model-respawn] restart.begin {"nodeId":"node-1","attempt":2}'
    )
  })
})

describe('modelRespawnErrorKind', () => {
  it('reports only the error class', () => {
    expect(modelRespawnErrorKind(new TypeError('secret provider response'))).toBe('TypeError')
    expect(modelRespawnErrorKind('secret provider response')).toBe('string')
  })
})
