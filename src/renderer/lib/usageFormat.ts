// Pure formatting helpers for the usage indicator.

/** "just now" / "5m ago" / "2h ago". */
export function formatTimeAgo(ts: number): string {
  const diff = Date.now() - ts
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

/** Bar color by remaining quota: green > 40%, yellow 20–40%, red < 20%. */
export function barColor(leftPercent: number): string {
  if (leftPercent > 40) return '#30d158'
  if (leftPercent >= 20) return '#ffd60a'
  return '#ff453a'
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
      return '#30d158'
    case 'warning':
      return '#ffd60a'
    case 'critical':
    case 'exceeded':
      return '#ff453a'
    default:
      return barColor(leftPercent)
  }
}
