import { describe, expect, it } from 'vitest'
import { micDeniedMessage, micErrorMessage } from './micPermission'

describe('micDeniedMessage', () => {
  it('names the setting that actually gates the mic on each platform', () => {
    expect(micDeniedMessage('win32')).toContain('Let desktop apps access your microphone')
    expect(micDeniedMessage('win32')).not.toContain('System Settings')
    expect(micDeniedMessage('darwin')).toContain('System Settings')
    expect(micDeniedMessage('browser')).toContain('browser settings')
    expect(micDeniedMessage('other')).toContain('system settings')
  })
})

describe('micErrorMessage', () => {
  const named = (name: string): Error => Object.assign(new Error('raw'), { name })

  it('maps the permission, busy and missing-device DOMException names', () => {
    expect(micErrorMessage(named('NotAllowedError'), 'win32')).toBe(micDeniedMessage('win32'))
    expect(micErrorMessage(named('SecurityError'), 'browser')).toBe(micDeniedMessage('browser'))
    expect(micErrorMessage(named('NotReadableError'), 'win32')).toMatch(/in use by another app/)
    expect(micErrorMessage(named('NotFoundError'), 'darwin')).toMatch(/No microphone/)
    // A DOMException-shaped object that is not an Error instance still maps.
    expect(micErrorMessage({ name: 'NotFoundError' }, 'win32')).toMatch(/No microphone/)
  })

  it('returns null for anything else so the caller keeps the original error', () => {
    expect(micErrorMessage(named('AbortError'), 'win32')).toBeNull()
    expect(micErrorMessage('boom', 'win32')).toBeNull()
    expect(micErrorMessage(null, 'win32')).toBeNull()
  })
})
