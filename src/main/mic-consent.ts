/**
 * Desktop microphone consent, decided per OS. Pure over an injected `systemPreferences` slice so
 * the Windows leg is testable on Linux.
 *
 * - darwin: `askForMediaAccess` — the TCC prompt (unchanged).
 * - win32: there is no prompt API; Windows answers through Settings → Privacy & security →
 *   Microphone. Only an explicit `'denied'` refuses (so the overlay can point at that setting
 *   instead of surfacing a raw DOMException). Every other answer — granted, not-determined,
 *   restricted, unknown — and a throw FAIL OPEN: `getUserMedia` is still the real gate, and a
 *   wrong "no" here would block a mic that works.
 * - elsewhere: true (the OS has no app-level gate we can read).
 */
export interface MicConsentDeps {
  askForMediaAccess(media: 'microphone'): Promise<boolean>
  getMediaAccessStatus(media: 'microphone'): string
}

export async function micConsentDecision(platform: string, deps: MicConsentDeps): Promise<boolean> {
  if (platform === 'darwin') return deps.askForMediaAccess('microphone')
  if (platform === 'win32') {
    try {
      return deps.getMediaAccessStatus('microphone') !== 'denied'
    } catch {
      return true
    }
  }
  return true
}

/**
 * The OS microphone-privacy page, from a FIXED allowlist (never a renderer-supplied URL — this is
 * handed to `shell.openExternal`). `null` = no such page on this platform.
 */
export function micSettingsUrl(platform: string): string | null {
  if (platform === 'win32') return 'ms-settings:privacy-microphone'
  if (platform === 'darwin') return 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone'
  return null
}
