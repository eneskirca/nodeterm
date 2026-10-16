import { describe, expect, it } from 'vitest'
import { sanitizeCheckForTest as sanitize } from './check'

describe('/v1/check sanitize — update notes', () => {
  it('carries notes only together with the version they describe', () => {
    expect(sanitize({ update: { mandatory: false, notes: '- a', latestVersion: '1.2.0' } }).update).toEqual({
      minSupported: null,
      mandatory: false,
      notes: '- a',
      latestVersion: '1.2.0'
    })
    expect(sanitize({ update: { notes: '- a' } }).update).toEqual({ minSupported: null, mandatory: false })
    expect(sanitize({ update: { notes: 3, latestVersion: '1.2.0' } }).update).toEqual({
      minSupported: null,
      mandatory: false
    })
  })

  it('keeps the policy shape when the feed sends nothing', () => {
    expect(sanitize(null).update).toEqual({ minSupported: null, mandatory: false })
    expect(sanitize({ update: { minSupported: '0.5.0', mandatory: true } }).update).toEqual({
      minSupported: '0.5.0',
      mandatory: true
    })
  })

  it('caps the notes', () => {
    expect(sanitize({ update: { notes: 'x'.repeat(50_000), latestVersion: '1' } }).update.notes!.length).toBe(16 * 1024)
  })
})
