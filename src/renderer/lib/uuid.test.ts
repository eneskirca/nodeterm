import { describe, it, expect } from 'vitest'
import { uuid } from './uuid'

describe('uuid', () => {
  it('returns an RFC 4122 v4-shaped uuid', () => {
    const id = uuid()
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    )
  })

  it('returns unique ids', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => uuid()))
    expect(ids.size).toBe(1000)
  })

  it('works without crypto.randomUUID (plain-http / insecure contexts)', () => {
    // The Server Edition on a LAN is not a secure context: randomUUID is
    // secure-context-only, getRandomValues is not. Simulate that environment.
    const desc = Object.getOwnPropertyDescriptor(globalThis.crypto, 'randomUUID')
    Object.defineProperty(globalThis.crypto, 'randomUUID', {
      value: undefined,
      configurable: true
    })
    try {
      expect(() => uuid()).not.toThrow()
      expect(uuid()).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
      )
    } finally {
      if (desc) Object.defineProperty(globalThis.crypto, 'randomUUID', desc)
    }
  })
})