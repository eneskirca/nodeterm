import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  cachedWindowFor,
  setGatewayModelWindowSource,
  staticWindowFor
} from './model-window'

describe('model-window — current discovered-window authority', () => {
  let models: Array<{ id: string; contextWindow?: number }>

  beforeEach(() => {
    models = []
    setGatewayModelWindowSource(() => models)
  })

  afterEach(() => setGatewayModelWindowSource(null))

  it('prefers a current discovered window over the unknown-family guess', () => {
    models = [{ id: 'vllm/GLM-5.3-Flash-NVFP4', contextWindow: 400_000 }]
    expect(cachedWindowFor('vllm/GLM-5.3-Flash-NVFP4')).toBe(400_000)
  })

  it('matches an omitted provider prefix and normalizes [1m] on both sides', () => {
    models = [{ id: 'vllm/GLM-5.2-NVFP4-MTP[1m]', contextWindow: 400_000 }]
    expect(cachedWindowFor('GLM-5.2-NVFP4-MTP')).toBe(400_000)
    expect(cachedWindowFor('vllm/GLM-5.2-NVFP4-MTP[1m]')).toBe(400_000)
  })

  it('never shrinks a family-inferred window', () => {
    models = [{ id: 'claude-sonnet-5', contextWindow: 200_000 }]
    expect(cachedWindowFor('claude-sonnet-5')).toBe(1_000_000)
  })

  it('falls back immediately when the live provider changes scope or delists the id', () => {
    models = [{ id: 'vllm/custom', contextWindow: 333_000 }]
    expect(cachedWindowFor('vllm/custom')).toBe(333_000)
    models = []
    expect(cachedWindowFor('vllm/custom')).toBe(200_000)
  })

  it('treats a missing or throwing provider as an empty catalogue', () => {
    setGatewayModelWindowSource(null)
    expect(cachedWindowFor('vllm/custom')).toBe(200_000)
    setGatewayModelWindowSource(() => {
      throw new Error('scope unavailable')
    })
    expect(cachedWindowFor('vllm/custom')).toBe(200_000)
  })

  it('ignores invalid reported windows and leaves static family rules unchanged', () => {
    models = [{ id: 'vllm/custom', contextWindow: Number.NaN }]
    expect(cachedWindowFor('vllm/custom')).toBe(200_000)
    expect(staticWindowFor('claude-haiku-4-5')).toBe(200_000)
    expect(staticWindowFor('claude-opus-5')).toBe(1_000_000)
    expect(staticWindowFor('unknown-thing')).toBe(200_000)
  })
})
