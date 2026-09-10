import { describe, expect, it } from 'vitest'
import {
  currentModelGatewayDiscoveryScope,
  modelGatewayDiscoveryScope
} from './model-gateway-scope'
import { MODEL_GATEWAY_SECRET_REF } from '../shared/agents/model-gateway'

describe('model gateway discovery scope', () => {
  it('normalizes equivalent base URLs and conventional discovery paths', () => {
    const a = modelGatewayDiscoveryScope(
      { baseUrl: 'https://gateway.test/', apiKey: '${env:KEY}' },
      'secret'
    )
    const b = modelGatewayDiscoveryScope(
      {
        baseUrl: 'https://gateway.test',
        apiKey: '${env:KEY}',
        discoveryPath: '/v1/models/'
      },
      'secret'
    )
    expect(a).not.toBeNull()
    expect(a).toBe(b)
  })

  it('changes with the effective discovery path or resolved environment value', () => {
    const settings = { baseUrl: 'https://gateway.test', apiKey: '${env:KEY}' }
    const base = currentModelGatewayDiscoveryScope(settings, null, { KEY: 'one' })
    expect(base).not.toBe(
      currentModelGatewayDiscoveryScope(
        { ...settings, discoveryPath: '/openai/v1/models' },
        null,
        { KEY: 'one' }
      )
    )
    expect(base).not.toBe(currentModelGatewayDiscoveryScope(settings, null, { KEY: 'two' }))
  })

  it('changes when a stored secret rotates behind the unchanged sentinel', () => {
    const settings = { baseUrl: 'https://gateway.test', apiKey: MODEL_GATEWAY_SECRET_REF }
    expect(currentModelGatewayDiscoveryScope(settings, 'one')).not.toBe(
      currentModelGatewayDiscoveryScope(settings, 'two')
    )
  })

  it('distinguishes a literal probe from the saved sentinel even when values match', () => {
    expect(
      modelGatewayDiscoveryScope(
        { baseUrl: 'https://gateway.test', apiKey: 'same-secret' },
        'same-secret'
      )
    ).not.toBe(
      modelGatewayDiscoveryScope(
        { baseUrl: 'https://gateway.test', apiKey: MODEL_GATEWAY_SECRET_REF },
        'same-secret'
      )
    )
  })

  it('returns null for invalid routes and unresolved credentials', () => {
    expect(
      currentModelGatewayDiscoveryScope(
        { baseUrl: 'file:///tmp/gateway', apiKey: 'key' },
        null
      )
    ).toBeNull()
    expect(
      currentModelGatewayDiscoveryScope(
        { baseUrl: 'https://gateway.test', apiKey: '${env:MISSING}' },
        null,
        {}
      )
    ).toBeNull()
    expect(
      currentModelGatewayDiscoveryScope(
        { baseUrl: 'https://gateway.test', apiKey: MODEL_GATEWAY_SECRET_REF },
        null
      )
    ).toBeNull()
  })
})
