import { useEffect, useMemo, useRef, useState } from 'react'
import type { ClaudeUsage, ProviderUsage, UsageLimit } from '@shared/types'
import { AGENT_CONFIG } from '@shared/agents/config'
import { useSettings } from '../state/settings'
import { formatResetCountdown, formatTimeAgo, percentNumber, percentText, severityColor } from '../lib/usageFormat'
import {
  enabledProviders,
  hasAnyUsage,
  limitKey,
  limitLabel,
  limitShortLabel,
  primaryLimit,
  providerLabel
} from '@shared/usage-limits'
import { systemAccountDisplay } from '../state/workspace'

/**
 * A single limit row in the popover: bar, "% left", reset countdown. Bars render REMAINING
 * quota (the limit carries percent USED), which is the convention this pill has always used.
 */
function LimitRow({ limit, mode }: { limit: UsageLimit; mode: 'used' | 'remaining' }) {
  const left = 100 - limit.usedPercent
  return (
    <div className="usage-row">
      <div className="usage-row__title">
        {limitLabel(limit.kind, limit.scopeLabel)}
        {/* The server flags which window is actually gating the account right now. */}
        {limit.isActive && <span className="usage-row__active" title="Currently limiting">●</span>}
      </div>
      <div className="usage-bar">
        <div
          className="usage-bar__fill"
          style={{ width: `${left}%`, background: severityColor(limit.severity, left) }}
        />
      </div>
      <div className="usage-row__meta">
        <span>{percentText(limit.usedPercent, mode)}</span>
        <span>{formatResetCountdown(limit.resetsAt)}</span>
      </div>
    </div>
  )
}

/**
 * One account's limit bars under a label, for the multi-account popover. Reuses LimitRow's
 * markup — `u` is null while its on-demand fetch is in flight.
 */
function AccountUsageBlock({
  label,
  email,
  u,
  mode
}: {
  label: string
  email?: string
  u: ClaudeUsage | null
  mode: 'used' | 'remaining'
}) {
  return (
    <div className="usage-account">
      <div className="usage-account__label">{label}</div>
      {(email ?? u?.email) && <div className="usage-account__email">{email ?? u?.email}</div>}
      {u?.limits.map((l) => (
        <LimitRow key={limitKey(l)} limit={l} mode={mode} />
      ))}
      {u && u.limits.length === 0 && <div className="usage-popover__empty">No usage data.</div>}
      {!u && <div className="usage-popover__empty usage-pill__pulse">···</div>}
    </div>
  )
}

/**
 * One non-Claude provider's section in the popover. Providers that aren't signed in report
 * 'unavailable' and are skipped entirely — showing an empty Codex row to someone who has never
 * run Codex is noise, not information. An 'error' provider IS shown, because that is a
 * configured provider failing and hiding it would make the popover flap between refreshes.
 */
/** AGENT_CONFIG is keyed by builtin ids; billing-only providers fall through to the shared table. */
function labelFor(provider: string): string {
  const agentLabel = (AGENT_CONFIG as Record<string, { label?: string } | undefined>)[provider]?.label
  return providerLabel(provider, agentLabel)
}

function ProviderBlock({ u, mode }: { u: ProviderUsage; mode: 'used' | 'remaining' }) {
  if (u.status === 'unavailable') return null
  const label = labelFor(u.provider)
  return (
    <div className="usage-account">
      <div className="usage-account__label">{label}</div>
      {u.account && <div className="usage-account__email">{u.account}</div>}
      {u.limits.map((l) => (
        <LimitRow key={limitKey(l)} limit={l} mode={mode} />
      ))}
      {u.limits.length === 0 && (
        <div className="usage-popover__empty">
          {u.status === 'error' ? 'Could not read usage.' : 'No usage data.'}
        </div>
      )}
    </div>
  )
}

/**
 * Bottom-left Claude usage pill + popover. Renders to the right of the React Flow Controls.
 * States: hidden when 'unavailable'; '···' while first-fetching; '⚠' on error w/o data;
 * last-known data shown on stale/error. Compact pill = mini-bar + one "N% label" per limit,
 * e.g. "93% 5h · 39% wk · 13% Fable" — the bar tracks whichever limit is closest to biting.
 */
export function UsageIndicator(): JSX.Element | null {
  const [usage, setUsage] = useState<ClaudeUsage | null>(null)
  const [open, setOpen] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [acctUsage, setAcctUsage] = useState<Record<string, ClaudeUsage | null>>({})
  const [providers, setProviders] = useState<ProviderUsage[]>([])
  const popRef = useRef<HTMLDivElement>(null)

  const claudeAccounts = useSettings((s) => s.settings.claudeAccounts)
  const systemLabelSetting = useSettings((s) => s.settings.systemAccountLabel)
  const hiddenProviders = useSettings((s) => s.settings.hiddenUsageProviders)
  const percentMode = useSettings((s) => s.settings.usagePercentMode)
  // Local logged-in accounts get their own popover row; skip pending logins + remote (host) ones.
  const accounts = useMemo(
    () => claudeAccounts.filter((a) => !a.pending && !a.host),
    [claudeAccounts]
  )

  useEffect(() => {
    void window.nodeTerminal.usage.fetch().then(setUsage)
    return window.nodeTerminal.usage.onUpdate(setUsage)
  }, [])

  // Fetched once on mount and again whenever the popover opens (the service caches, so the
  // second call is usually free). On mount rather than popover-only because the pill itself
  // surfaces enabled providers now — and a provider the user has never signed into costs no
  // network call at all: every fetcher short-circuits to 'unavailable' on a missing credentials
  // file. So the price of asking is one failed read per unused provider, not five round-trips.
  useEffect(() => {
    let cancelled = false
    void window.nodeTerminal.usage.providers().then((ps) => {
      if (!cancelled) setProviders(ps)
    })
    return () => {
      cancelled = true
    }
  }, [open])

  // Fetch each account's usage on demand when the popover opens (system row uses `usage`).
  useEffect(() => {
    if (!open || accounts.length === 0) return
    let cancelled = false
    for (const a of accounts) {
      void window.nodeTerminal.usage.fetch(a.id).then((u) => {
        if (!cancelled) setAcctUsage((m) => ({ ...m, [a.id]: u }))
      })
    }
    return () => {
      cancelled = true
    }
  }, [open, accounts])

  // Close the popover on an outside click.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (popRef.current && !popRef.current.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [open])

  // Settings → Usage toggles are a display choice, applied before any other rule — a hidden
  // provider is invisible here even when signed in and mid-limit.
  const hidden = new Set(hiddenProviders)
  const visibleProviders = providers.filter((p) => !hidden.has(p.provider))
  const claudeUsage = hidden.has('claude') ? null : usage

  // Only providers the user has actually enabled reach the pill; render whenever ANY of them
  // (Claude included) has something to say. Both rules are pure and pinned by tests — gating on
  // Claude alone, which is what this did, left a Codex-only user with no pill at all.
  const enabled = enabledProviders(visibleProviders)
  if (!hasAnyUsage(claudeUsage, visibleProviders)) return null

  const limits = claudeUsage?.limits ?? []
  const status = claudeUsage?.status ?? 'unavailable'
  const hasData = limits.length > 0 || enabled.length > 0
  const fetching = refreshing
  const isError = status === 'error'
  // The pill leads with whatever is closest to biting, so a scoped model cap that is nearly
  // exhausted can't hide behind a comfortable 5h window. Considers every enabled provider, not
  // just Claude, so an exhausted Codex window drives the bar too.
  const primary = primaryLimit([...limits, ...enabled.flatMap((p) => p.limits)])

  const refresh = async (e: React.MouseEvent): Promise<void> => {
    e.stopPropagation()
    if (refreshing) return
    setRefreshing(true)
    try {
      setUsage(await window.nodeTerminal.usage.refresh())
    } finally {
      setRefreshing(false)
    }
  }

  let pillBody: JSX.Element
  if (!hasData && fetching) {
    pillBody = <span className="usage-pill__dim usage-pill__pulse">···</span>
  } else if (!hasData && isError) {
    pillBody = <span className="usage-pill__dim">⚠</span>
  } else {
    pillBody = (
      <>
        {primary && (
          <span className="usage-pill__minibar" aria-hidden>
            <span
              className="usage-pill__minibar-fill"
              style={{
                width: `${100 - primary.usedPercent}%`,
                background: severityColor(primary.severity, 100 - primary.usedPercent)
              }}
            />
          </span>
        )}
        {limits.map((l, i) => (
          <span key={limitKey(l)}>
            {i > 0 && <span className="usage-pill__sep">·</span>}
            <span className="usage-pill__num">
              {percentNumber(l.usedPercent, percentMode)}% {limitShortLabel(l.kind, l.scopeLabel)}
            </span>
          </span>
        ))}
        {/* One segment per enabled provider, carrying only its worst limit — a provider's full
            breakdown belongs in the popover, not in a pill that has to fit beside the canvas. */}
        {enabled.map((p, i) => {
          const worst = primaryLimit(p.limits)
          if (!worst) return null
          return (
            <span key={p.provider} className="usage-pill__provider">
              {(limits.length > 0 || i > 0) && <span className="usage-pill__sep">·</span>}
              <span className="usage-pill__num">
                {percentNumber(worst.usedPercent, percentMode)}% {labelFor(p.provider)}
              </span>
            </span>
          )
        })}
        {isError && hasData && <span className="usage-pill__dim">⚠</span>}
      </>
    )
  }

  return (
    <div className="usage-indicator" ref={popRef}>
      {open && (
        <div className="usage-popover">
          <div className="usage-popover__head">
            <span className="usage-popover__title">✦ Usage</span>
            {/* Timestamp tracks the Claude snapshot, the only one that is polled. Absent when
                Claude is not signed in and the panel is showing other providers only. */}
            {usage && (
              <span className="usage-popover__ago">Updated {formatTimeAgo(usage.updatedAt)}</span>
            )}
          </div>
          {accounts.length > 0 && usage ? (
            <>
              <AccountUsageBlock
                mode={percentMode}
                label={systemAccountDisplay(systemLabelSetting, usage.email)}
                // Avoid printing the email twice when it's already the display label.
                email={systemLabelSetting.trim() ? (usage.email ?? undefined) : undefined}
                u={usage}
              />
              {accounts.map((a) => (
                <AccountUsageBlock key={a.id} mode={percentMode} label={a.label} email={a.email} u={acctUsage[a.id] ?? null} />
              ))}
            </>
          ) : (
            <>
              {/* Claude's rows are bare when it is the only provider; once others share the
                  panel they need a heading of their own to stay attributable. */}
              {enabled.length > 0 && limits.length > 0 && (
                <div className="usage-account__label">Claude</div>
              )}
              {limits.map((l) => (
                <LimitRow key={limitKey(l)} limit={l} mode={percentMode} />
              ))}
              {!hasData && <div className="usage-popover__empty">No usage data.</div>}
              {usage?.email && (
                <div className="usage-account">
                  <div className="usage-account__label">Claude Account</div>
                  <div className="usage-account__email">{usage.email}</div>
                </div>
              )}
            </>
          )}
          {visibleProviders.map((p) => (
            <ProviderBlock key={p.provider} u={p} mode={percentMode} />
          ))}
        </div>
      )}
      <button className="usage-pill" onClick={() => setOpen((v) => !v)} title="Agent usage">
        <span className="usage-pill__icon">✦</span>
        {pillBody}
      </button>
      <button
        className={`usage-refresh${fetching ? ' spin' : ''}`}
        onClick={refresh}
        disabled={refreshing}
        title="Refresh usage"
      >
        ⟳
      </button>
    </div>
  )
}
