// Pure mapping of Anthropic's OAuth usage payload into our normalized limit list.
// Lives in core (no electron, no fs, no fetch) so both shells share it and it stays unit-tested;
// the impure token/keychain/HTTP work stays in the shell (main/claude-usage.ts).
//
// The payload carries the same facts twice. The legacy shape is a set of fixed top-level
// windows (`five_hour`, `seven_day`, and the now-always-null `seven_day_opus` /
// `seven_day_sonnet` / …). The current shape is a generic `limits[]` array where a per-model
// quota is an ordinary entry carrying `scope.model.display_name`. We prefer `limits[]` and
// treat the model name as DATA, never as a field name — that is the whole point of the new
// contract: when the next model ships, its limit arrives as another array entry and this file
// does not change. Binding a `fableWeekly` slot (or a `seven_day_fable` field) would recreate
// the exact rigidity Anthropic just moved away from.
import type { UsageLimit } from '../../shared/types'

/** `percent`/`utilization` are portions USED, 0–100. Clamp — the server is not our validator. */
function clampPercent(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null
  return Math.min(100, Math.max(0, v))
}

/**
 * Reset stamps arrive as ISO strings today, but the same field has been seen as Unix seconds
 * and Unix ms elsewhere in this API family, so tolerate all three rather than silently
 * producing "Resets now" on a shape change. The 1e10 cut-off separates seconds from ms
 * (1e10 s ≈ year 2286, 1e10 ms ≈ 1970) — anything larger is already ms.
 */
export function parseResetTimestamp(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return raw > 10_000_000_000 ? raw : raw * 1000
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim()
    if (!trimmed) return null
    return Date.parse(trimmed) || null
  }
  return null
}

function mapLimit(raw: unknown): UsageLimit | null {
  if (!raw || typeof raw !== 'object') return null
  const l = raw as Record<string, any>
  const kind = typeof l.kind === 'string' && l.kind ? l.kind : null
  const usedPercent = clampPercent(l.percent)
  if (!kind || usedPercent === null) return null

  const model = l.scope?.model
  const displayName = typeof model?.display_name === 'string' ? model.display_name.trim() : ''

  return {
    kind,
    group: typeof l.group === 'string' && l.group ? l.group : null,
    usedPercent,
    // Severity is the server's own call — deriving it from percent thresholds locally would
    // desync from the plan the account is actually on. Absent means "not reported", NOT
    // 'normal': defaulting it green would hide an exhausted window on any payload that omits it.
    severity: typeof l.severity === 'string' && l.severity ? l.severity : null,
    resetsAt: parseResetTimestamp(l.resets_at),
    // Claude does not report bucket durations; `kind` is the only window hint it gives.
    windowMinutes: null,
    scopeLabel: displayName || null,
    // Absent `is_active` means "unknown", not "inactive" — an older payload that omits the
    // field must not have every limit silently treated as dormant.
    isActive: l.is_active === true
  }
}

/**
 * Fall back to the legacy fixed windows when `limits[]` is absent (older CLI/plan payloads).
 * Only the two windows that were ever populated are reconstructed; the per-model top-level
 * fields are dead in current responses and are deliberately not resurrected here.
 */
function legacyLimits(data: Record<string, any>): UsageLimit[] {
  const out: UsageLimit[] = []
  const add = (raw: unknown, kind: string, group: string): void => {
    if (!raw || typeof raw !== 'object') return
    const w = raw as Record<string, any>
    const usedPercent = clampPercent(w.utilization ?? w.used_percentage)
    if (usedPercent === null) return
    out.push({
      kind,
      group,
      usedPercent,
      // Legacy payloads carry no severity — leave it to the local percentage thresholds.
      severity: null,
      resetsAt: parseResetTimestamp(w.resets_at),
      windowMinutes: null,
      scopeLabel: null,
      isActive: false
    })
  }
  add(data.five_hour, 'session', 'session')
  add(data.seven_day, 'weekly_all', 'weekly')
  return out
}

/** Normalize a raw `/api/oauth/usage` body into the limit list the UI renders. */
export function mapUsageLimits(data: unknown): UsageLimit[] {
  if (!data || typeof data !== 'object') return []
  const body = data as Record<string, any>
  if (Array.isArray(body.limits)) {
    const mapped = body.limits.map(mapLimit).filter((l): l is UsageLimit => l !== null)
    if (mapped.length > 0) return mapped
  }
  return legacyLimits(body)
}
