import { describe, expect, it, vi } from 'vitest'
import { micConsentDecision, micSettingsUrl, type MicConsentDeps } from './mic-consent'

const deps = (status: string | (() => string) = 'granted', asked = true): MicConsentDeps => ({
  askForMediaAccess: vi.fn(async () => asked),
  getMediaAccessStatus: vi.fn(typeof status === 'function' ? status : () => status)
})

describe('micConsentDecision', () => {
  it('asks the macOS TCC prompt on darwin, exactly as before', async () => {
    const d = deps('denied', false)
    expect(await micConsentDecision('darwin', d)).toBe(false)
    expect(d.askForMediaAccess).toHaveBeenCalledWith('microphone')
    expect(d.getMediaAccessStatus).not.toHaveBeenCalled()
    expect(await micConsentDecision('darwin', deps('denied', true))).toBe(true)
  })

  it('refuses on win32 only for an explicit Windows privacy denial', async () => {
    expect(await micConsentDecision('win32', deps('denied'))).toBe(false)
    for (const status of ['granted', 'not-determined', 'restricted', 'unknown']) {
      expect(await micConsentDecision('win32', deps(status))).toBe(true)
    }
  })

  it('fails open when the Windows status read throws, and never prompts there', async () => {
    const d = deps(() => {
      throw new Error('unsupported')
    })
    expect(await micConsentDecision('win32', d)).toBe(true)
    expect(d.askForMediaAccess).not.toHaveBeenCalled()
  })

  it('stays true on linux without touching systemPreferences', async () => {
    const d = deps('denied', false)
    expect(await micConsentDecision('linux', d)).toBe(true)
    expect(d.askForMediaAccess).not.toHaveBeenCalled()
    expect(d.getMediaAccessStatus).not.toHaveBeenCalled()
  })
})

describe('micSettingsUrl', () => {
  it('is a fixed per-OS privacy page, or null', () => {
    expect(micSettingsUrl('win32')).toBe('ms-settings:privacy-microphone')
    expect(micSettingsUrl('darwin')).toMatch(/^x-apple\.systempreferences:.*Privacy_Microphone$/)
    expect(micSettingsUrl('linux')).toBeNull()
  })
})
