import { isBrowserRuntime } from '../bridge/runtime'
import { isMacPlatform, isWindowsPlatform } from '@shared/platform-utils'

/**
 * Whose rules govern the microphone for this renderer. The Server Edition is `browser` whatever
 * the viewer's OS — its permission lives in the browser's site settings, not the OS's.
 */
export type MicPlatform = 'darwin' | 'win32' | 'browser' | 'other'

export function micPlatform(): MicPlatform {
  if (isBrowserRuntime()) return 'browser'
  if (isMacPlatform()) return 'darwin'
  if (isWindowsPlatform()) return 'win32'
  return 'other'
}

/** The denial copy, naming the one setting that actually blocks the mic on that platform. */
export function micDeniedMessage(platform: MicPlatform): string {
  switch (platform) {
    case 'win32':
      return 'Microphone access is blocked by Windows — turn on "Microphone access" and "Let desktop apps access your microphone" in Settings → Privacy & security → Microphone, then try again.'
    case 'darwin':
      return 'Microphone access was denied — allow nodeterm in System Settings → Privacy & Security → Microphone and try again.'
    case 'browser':
      return "Microphone access was denied — allow it in this site's browser settings and try again."
    default:
      return 'Microphone access was denied — allow it in your system settings and try again.'
  }
}

/**
 * Map a `getUserMedia` rejection to readable copy. Unknown errors keep their own message — only
 * the three names whose raw DOMException text says nothing useful are rewritten.
 */
export function micErrorMessage(err: unknown, platform: MicPlatform): string | null {
  const name = err instanceof Error || (typeof err === 'object' && err !== null && 'name' in err)
    ? String((err as { name?: unknown }).name)
    : ''
  if (name === 'NotAllowedError' || name === 'SecurityError') return micDeniedMessage(platform)
  if (name === 'NotReadableError' || name === 'TrackStartError') {
    return 'The microphone could not be opened — it may be in use by another app.'
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
    return 'No microphone was found — connect one and try again.'
  }
  return null
}
