import type { UsageDiagnostic } from '@shared/types'

function viewLabel(view: UsageDiagnostic['view']): string {
  return view === 'credits' ? 'Credits view' : 'Default view'
}

/**
 * Grok's usage reader only ever READS the key the CLI saved in `$GROK_HOME/auth.json` and never
 * refreshes it (core/usage/grok-usage.ts). Reported in issue #983: the 401 showed while no Grok
 * session had run for a while, and starting one (which lets the CLI replace the key) fixed it. The
 * expiry is a hypothesis, not a measurement, so the copy names the remedy and claims no cause
 * (UsageIndicator.grok.test.tsx pins that no diagnostic says "expired").
 */
const GROK_401 = 'Grok authentication failed (HTTP 401). Starting a Grok session refreshes the saved credentials; then refresh usage. If that does not help, sign in to the Grok CLI again on the machine running this project.'

/** The reason sentence alone, without the view it was read from. `providerId` (the provider's
 *  stable id, not its label) selects a provider-specific variant where one exists. */
function usageDiagnosticMessage(provider: string, diagnostic: UsageDiagnostic, providerId?: string): string {
  switch (diagnostic.reason) {
    case 'timeout': return 'Usage request timed out. Try again later.'
    case 'network': return `Could not reach ${provider}. Check the connection and try again.`
    case 'invalid-response': return 'Usage response could not be read. Try again later.'
    case 'http': {
      const status = diagnostic.httpStatus
      if (status === 401 && providerId === 'grok') return GROK_401
      return status === 401 || status === 403
        ? `${provider} authentication failed (HTTP ${status}). Check the CLI authentication on the machine running this project.`
        : status === 429
          ? 'Usage request rate limited (HTTP 429). Try again later.'
          : status >= 500
            ? `${provider} returned HTTP ${status}. Try again later.`
            : `Usage request failed (HTTP ${status}). Check the provider service and CLI configuration.`
    }
  }
}

/** Static copy only: diagnostics never carry provider response text or credential details. */
export function usageDiagnosticText(provider: string, diagnostic: UsageDiagnostic, providerId?: string): string {
  return `${viewLabel(diagnostic.view)}: ${usageDiagnosticMessage(provider, diagnostic, providerId)}`
}

/**
 * The lines a provider's failed views print (issue #912). Views stay distinct — they are different
 * reads — but an IDENTICAL reason is printed once, naming every view it came from, instead of the
 * same sentence verbatim per view (which made a provider with no data the tallest block).
 */
export function usageDiagnosticLines(
  provider: string,
  diagnostics: readonly UsageDiagnostic[] | undefined,
  providerId?: string
): string[] {
  const groups = new Map<string, string[]>()
  for (const d of diagnostics ?? []) {
    const message = usageDiagnosticMessage(provider, d, providerId)
    const views = groups.get(message) ?? []
    const label = viewLabel(d.view)
    groups.set(message, views.includes(label) ? views : [...views, label])
  }
  return [...groups].map(([message, views]) => `${joinViews(views)}: ${message}`)
}

function joinViews(views: readonly string[]): string {
  if (views.length <= 1) return views[0] ?? ''
  return `${views.slice(0, -1).join(', ')} and ${views[views.length - 1]}`
}
