// Display + selection helpers for usage limits, shared by every surface (the renderer picks
// what the pill leads with; the shells label rows the same way). Pure and dependency-free.
//
// The parsing that produces `UsageLimit[]` from a raw provider payload is service-side and
// lives in core/usage — only the vocabulary lives here.
import type { UsageLimit } from './types'

/**
 * Human label for a limit. A scoped limit is named by its model ("Fable"); everything else
 * falls back to its `kind`, prettified, so an unrecognized future kind still renders as
 * something readable instead of vanishing from the UI.
 */
export function limitLabel(kind: string, scopeLabel: string | null): string {
  if (scopeLabel) return scopeLabel
  switch (kind) {
    case 'session':
      return 'Session'
    case 'weekly_all':
      return 'Weekly'
    case 'weekly_scoped':
      return 'Weekly (scoped)'
    default:
      return kind.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
  }
}

/** Compact label for the collapsed pill, where horizontal space is scarce. */
export function limitShortLabel(kind: string, scopeLabel: string | null): string {
  if (scopeLabel) return scopeLabel
  if (kind === 'session') return '5h'
  if (kind === 'weekly_all') return 'wk'
  return limitLabel(kind, scopeLabel)
}

/**
 * The one limit the collapsed pill leads with: whatever is closest to biting. The server's
 * `is_active` flag wins over raw percentage — it knows which window is actually gating the
 * account right now — and percentage only breaks ties.
 */
export function primaryLimit(limits: UsageLimit[]): UsageLimit | null {
  if (limits.length === 0) return null
  return limits.reduce((best, l) => {
    if (l.isActive !== best.isActive) return l.isActive ? l : best
    return l.usedPercent > best.usedPercent ? l : best
  })
}

/** Find a limit by `kind`, for the back-compat `session`/`weekly` fields. */
export function findLimit(limits: UsageLimit[], kind: string): UsageLimit | null {
  return limits.find((l) => l.kind === kind) ?? null
}

/** Stable React key / dedupe key for a limit (kind alone repeats across scoped models). */
export function limitKey(limit: UsageLimit): string {
  return `${limit.kind}:${limit.scopeLabel ?? ''}`
}
