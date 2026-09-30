import type { UsageDiagnostic } from '@shared/types'

function viewLabel(view: UsageDiagnostic['view']): string {
  return view === 'credits' ? 'Credits view' : 'Default view'
}

/** The reason sentence alone, without the view it was read from. */
function usageDiagnosticMessage(provider: string, diagnostic: UsageDiagnostic): string {
  switch (diagnostic.reason) {
    case 'timeout': return 'Usage request timed out. Try again later.'
    case 'network': return `Could not reach ${provider}. Check the connection and try again.`
    case 'invalid-response': return 'Usage response could not be read. Try again later.'
    case 'http': {
      const status = diagnostic.httpStatus
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
export function usageDiagnosticText(provider: string, diagnostic: UsageDiagnostic): string {
  return `${viewLabel(diagnostic.view)}: ${usageDiagnosticMessage(provider, diagnostic)}`
}

/**
 * The lines a provider's failed views print (issue #912). Views stay distinct — they are different
 * reads — but an IDENTICAL reason is printed once, naming every view it came from, instead of the
 * same sentence verbatim per view (which made a provider with no data the tallest block).
 */
export function usageDiagnosticLines(
  provider: string,
  diagnostics: readonly UsageDiagnostic[] | undefined
): string[] {
  const groups = new Map<string, string[]>()
  for (const d of diagnostics ?? []) {
    const message = usageDiagnosticMessage(provider, d)
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
