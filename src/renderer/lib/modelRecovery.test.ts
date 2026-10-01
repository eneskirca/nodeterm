import { describe, expect, it, vi } from 'vitest'
import {
  catalogueForModelRecovery,
  refreshModelRecoveryCatalogue
} from './modelRecovery'

describe('catalogueForModelRecovery', () => {
  it('returns only a successful non-empty catalogue', () => {
    const models = [{ id: 'served/model' }]
    expect(catalogueForModelRecovery({ status: 'ready', models })).toBe(models)
    expect(catalogueForModelRecovery({ status: 'ready', models: [] })).toBeNull()
    expect(catalogueForModelRecovery({ status: 'loading', models })).toBeNull()
    expect(catalogueForModelRecovery({ status: 'error', models })).toBeNull()
  })
})

describe('refreshModelRecoveryCatalogue', () => {
  it('reads the latest settings at invocation time and starts exactly one request', async () => {
    let settings = { baseUrl: 'https://old.test', apiKey: 'old' }
    const discover = vi.fn(async () => {})
    const readSettings = (): typeof settings => settings

    settings = { baseUrl: 'https://current.test', apiKey: 'current' }
    await refreshModelRecoveryCatalogue(readSettings, discover)

    expect(discover).toHaveBeenCalledOnce()
    expect(discover).toHaveBeenCalledWith(settings)
  })
})
