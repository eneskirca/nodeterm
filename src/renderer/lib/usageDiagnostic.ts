import type { UsageDiagnostic } from '@shared/types'

/** Static copy only: diagnostics never carry provider response text or credential details. */
export function usageDiagnosticText(provider: string, diagnostic: UsageDiagnostic): string {
  const view = diagnostic.view === 'credits' ? 'Credits view' : 'Default view'
  let message: string
  switch (diagnostic.reason) {
    case 'timeout': message = 'Usage request timed out. Try again later.'; break
    case 'network': message = `Could not reach ${provider}. Check the connection and try again.`; break
    case 'invalid-response': message = 'Usage response could not be read. Try again later.'; break
    case 'http': {
      const status = diagnostic.httpStatus
      message = status === 401 || status === 403
        ? `${provider} authentication failed (HTTP ${status}). Check the CLI authentication on the machine running this project.`
        : status === 429
          ? 'Usage request rate limited (HTTP 429). Try again later.'
          : status >= 500
            ? `${provider} returned HTTP ${status}. Try again later.`
            : `Usage request failed (HTTP ${status}). Check the provider service and CLI configuration.`
      break
    }
  }
  return `${view}: ${message}`
}
