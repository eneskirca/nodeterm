import type { ClaudeUsage } from '@shared/types'
import { SYSTEM_COLORS } from './palette'
// Pure formatting helpers for the usage indicator.

/** "just now" / "5m ago" / "2h ago". */
export function formatTimeAgo(ts: number, now: number = Date.now()): string {
  const diff = now - ts
  if (diff < 60_000) return 'just now'
  const mins = Math.floor(diff / 60_000)
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  return `${hours}h ago`
}

/** "Resets now" / "Resets in 1h 2m" / "Resets in 2d 4h". */
export function formatResetCountdown(resetsAt: number | null): string {
  if (resetsAt == null) return ''
  const ms = resetsAt - Date.now()
  if (ms <= 0) return 'Resets now'
  const totalMins = Math.floor(ms / 60_000)
  if (totalMins < 60) return `Resets in ${totalMins}m`
  const hours = Math.floor(totalMins / 60)
  const mins = totalMins % 60
  if (hours >= 24) {
    const days = Math.floor(hours / 24)
    const remHours = hours % 24
    return remHours > 0 ? `Resets in ${days}d ${remHours}h` : `Resets in ${days}d`
  }
  return mins > 0 ? `Resets in ${hours}h ${mins}m` : `Resets in ${hours}h`
}

/**
 * Short display label for a Claude model id: "claude-opus-4-8" → "Opus 4.8",
 * "claude-haiku-4-5-20251001" → "Haiku 4.5" (date segments dropped), "claude-3-5-sonnet-…"
 * → "Sonnet 3.5". An id with no known family is returned as-is; null stays null.
 */
export function formatModelLabel(model: string | null): string | null {
  if (!model) return null
  const fam = /(opus|sonnet|haiku|fable|mythos)/i.exec(model)
  if (!fam) return model
  const family = fam[1][0].toUpperCase() + fam[1].slice(1).toLowerCase()
  const version = model
    .split(/[^a-zA-Z0-9]+/)
    .filter((p) => /^\d{1,3}$/.test(p))
    .join('.')
  return version ? `${family} ${version}` : family
}

// Literals, not tokens: the notch HUD draws these too and does not load styles.css.
const { red: RED, yellow: YELLOW, green: GREEN } = SYSTEM_COLORS.dark

/**
 * Fill color for a CONTEXT-WINDOW meter: green while low, yellow from 60% used, red past 85%.
 * Keyed to USED percent — the inverse scale of `barColor`/`severityColor`, which are keyed to
 * REMAINING provider quota. The two measure different things and must not share thresholds.
 * One definition for every context surface (ContextMeter, session rows, the notch HUD) — each
 * used to carry its own copy of these numbers (issue #78).
 */
export function contextFillColor(usedPercent: number): string {
  if (usedPercent > 85) return RED
  if (usedPercent >= 60) return YELLOW
  return GREEN
}

/** Bar color by remaining quota: green > 40%, yellow 20–40%, red < 20%. */
export function barColor(leftPercent: number): string {
  if (leftPercent > 40) return GREEN
  if (leftPercent >= 20) return YELLOW
  return RED
}

/**
 * Bar color for a usage limit. A provider that ships its own `severity` verdict knows the
 * account's plan and how close the window really is to biting — prefer it, and fall back to
 * our own percentage thresholds when it is null (most providers report none) or a value we
 * don't recognize.
 */
export function severityColor(severity: string | null, leftPercent: number): string {
  switch (severity) {
    case 'normal':
      return GREEN
    case 'warning':
      return YELLOW
    case 'critical':
    case 'exceeded':
      return RED
    default:
      return barColor(leftPercent)
  }
}

/**
 * The percentage a limit renders as, honouring the used/remaining/tokens display setting.
 * 'tokens' has no meaning for a percent-only surface (provider quota limits carry no raw token
 * count), so it folds to the 'used' wording there — never silently treated as 'remaining'.
 */
export function percentText(usedPercent: number, mode: 'used' | 'remaining' | 'tokens'): string {
  return mode === 'remaining'
    ? `${Math.round(100 - usedPercent)}% left`
    : `${Math.round(usedPercent)}% used`
}

/** Compact form for the pill: the bare number, no suffix (the segment label follows it). */
export function percentNumber(usedPercent: number, mode: 'used' | 'remaining' | 'tokens'): number {
  return Math.round(mode === 'remaining' ? 100 - usedPercent : usedPercent)
}

/**
 * Bar fill, honouring the used/remaining/tokens display setting — the fill tracks the same
 * quantity as the adjacent number, so "92% used" shows a nearly-full bar instead of a
 * barely-visible sliver. 'tokens' fills the same as 'used' (it just relabels the number).
 * Color is a separate call (`severityColor`/`barColor`) keyed to the true remaining percentage,
 * never to this value, so severity red/yellow/green doesn't flip meaning with the mode.
 */
export function barFillPercent(usedPercent: number, mode: 'used' | 'remaining' | 'tokens'): number {
  return mode === 'remaining' ? 100 - usedPercent : usedPercent
}

/** Humanize a token count: 48000 → "48k", 1_000_000 → "1M", 850 → "850". */
export function formatTokensShort(n: number): string {
  if (n >= 1_000_000) return `${Number((n / 1_000_000).toFixed(1)).toString()}M`
  if (n >= 1000) return `${Math.round(n / 1000)}k`
  return String(n)
}

/**
 * Context-window pill text: token fraction in 'tokens' mode ("48k/200k"), else the percent
 * number with no suffix (caller appends "%"). Only context-window surfaces (ContextMeter,
 * SessionRow) have usedTokens/windowTokens to show; nothing else should call this.
 */
export function contextPillText(usedTokens: number, windowTokens: number, usedPercent: number, mode: 'used' | 'remaining' | 'tokens'): string {
  return mode === 'tokens'
    ? `${formatTokensShort(usedTokens)}/${formatTokensShort(windowTokens)}`
    : `${percentNumber(usedPercent, mode)}%`
}

/** Whole minutes until `at`, rounded UP and never below 1 — "try again in 0m" reads as now. */
function minutesUntil(at: number, now: number): number {
  return Math.max(1, Math.ceil((at - now) / 60_000))
}

/**
 * The line under Claude bars that were KEPT across a failed read (usage-service `keepLastGood`),
 * or null when the numbers are current. "Rate limited — showing values from 14m ago, next try in
 * 2m": the age is the numbers' own (`updatedAt`), not the failed request's.
 */
export function claudeStaleNotice(u: ClaudeUsage | null | undefined, now: number = Date.now()): string | null {
  if (!u?.failure || u.status !== 'error' || u.limits.length === 0) return null
  const lead = u.failure.reason === 'rate-limited' ? 'Rate limited' : 'Could not refresh'
  const line = `${lead} — showing values from ${formatTimeAgo(u.updatedAt, now)}`
  const retryAt = u.failure.retryAt
  return retryAt !== undefined && retryAt > now ? `${line}, next try in ${minutesUntil(retryAt, now)}m` : line
}

/** The empty-state line for a Claude snapshot with no limits to draw. */
export function claudeEmptyText(u: ClaudeUsage, now: number = Date.now()): string {
  if (u.status !== 'error') return 'No usage data.'
  if (u.failure?.reason !== 'rate-limited') return 'Could not read usage.'
  const retryAt = u.failure.retryAt
  return retryAt !== undefined && retryAt > now
    ? `Rate limited — try again in ${minutesUntil(retryAt, now)}m.`
    : 'Rate limited — try again shortly.'
}
