import { useEffect, useMemo, useRef, useState } from 'react'
import type { ClaudeUsage, ProviderUsage, UsageLimit } from '@shared/types'
import { AGENT_CONFIG } from '@shared/agents/config'
import { useSettings } from '../state/settings'
import { formatResetCountdown, formatTimeAgo, severityColor } from '../lib/usageFormat'
import { limitKey, limitLabel, limitShortLabel, primaryLimit } from '@shared/usage-limits'
import { systemAccountDisplay } from '../state/workspace'

/**
 * A single limit row in the popover: bar, "% left", reset countdown. Bars render REMAINING
 * quota (the limit carries percent USED), which is the convention this pill has always used.
 */
function LimitRow({ limit }: { limit: UsageLimit }) {
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
        <span>{Math.round(left)}% left</span>
        <span>{formatResetCountdown(limit.resetsAt)}</span>
      </div>
    </div>
  )
}

/**
 * One account's limit bars under a label, for the multi-account popover. Reuses LimitRow's
 * markup — `u` is null while its on-demand fetch is in flight.
 */
function AccountUsageBlock({ label, email, u }: { label: string; email?: string; u: ClaudeUsage | null }) {
  return (
    <div className="usage-account">
      <div className="usage-account__label">{label}</div>
      {(email ?? u?.email) && <div className="usage-account__email">{email ?? u?.email}</div>}
      {u?.limits.map((l) => (
        <LimitRow key={limitKey(l)} limit={l} />
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
function ProviderBlock({ u }: { u: ProviderUsage }) {
  if (u.status === 'unavailable') return null
  // AGENT_CONFIG is keyed by the builtin ids; `provider` is an open string, so a provider that
  // is not a builtin agent (a billing-only one) falls back to its own id rather than blanking.
  const label = (AGENT_CONFIG as Record<string, { label?: string } | undefined>)[u.provider]?.label ?? u.provider
  return (
    <div className="usage-account">
      <div className="usage-account__label">{label}</div>
      {u.account && <div className="usage-account__email">{u.account}</div>}
      {u.limits.map((l) => (
        <LimitRow key={limitKey(l)} limit={l} />
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
  // Local logged-in accounts get their own popover row; skip pending logins + remote (host) ones.
  const accounts = useMemo(
    () => claudeAccounts.filter((a) => !a.pending && !a.host),
    [claudeAccounts]
  )

  useEffect(() => {
    void window.nodeTerminal.usage.fetch().then(setUsage)
    return window.nodeTerminal.usage.onUpdate(setUsage)
  }, [])

  // Other providers are fetched only while the popover is open — each costs a network call (and
  // possibly a subprocess), so polling them for a collapsed pill would spend that for nothing.
  useEffect(() => {
    if (!open) return
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

  if (!usage || usage.status === 'unavailable') return null

  const { limits, status } = usage
  const hasData = limits.length > 0
  const fetching = refreshing
  const isError = status === 'error'
  // The pill leads with whatever is closest to biting, so a scoped model cap that is nearly
  // exhausted can't hide behind a comfortable 5h window.
  const primary = primaryLimit(limits)

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
              {Math.round(100 - l.usedPercent)}% {limitShortLabel(l.kind, l.scopeLabel)}
            </span>
          </span>
        ))}
        {isError && hasData && <span className="usage-pill__dim">⚠</span>}
      </>
    )
  }

  return (
    <div className="usage-indicator" ref={popRef}>
      {open && (
        <div className="usage-popover">
          <div className="usage-popover__head">
            <span className="usage-popover__title">✦ Claude</span>
            <span className="usage-popover__ago">Updated {formatTimeAgo(usage.updatedAt)}</span>
          </div>
          {accounts.length > 0 ? (
            <>
              <AccountUsageBlock
                label={systemAccountDisplay(systemLabelSetting, usage.email)}
                // Avoid printing the email twice when it's already the display label.
                email={systemLabelSetting.trim() ? (usage.email ?? undefined) : undefined}
                u={usage}
              />
              {accounts.map((a) => (
                <AccountUsageBlock key={a.id} label={a.label} email={a.email} u={acctUsage[a.id] ?? null} />
              ))}
            </>
          ) : (
            <>
              {limits.map((l) => (
                <LimitRow key={limitKey(l)} limit={l} />
              ))}
              {!hasData && <div className="usage-popover__empty">No usage data.</div>}
              {usage.email && (
                <div className="usage-account">
                  <div className="usage-account__label">Claude Account</div>
                  <div className="usage-account__email">{usage.email}</div>
                </div>
              )}
            </>
          )}
          {providers.map((p) => (
            <ProviderBlock key={p.provider} u={p} />
          ))}
        </div>
      )}
      <button className="usage-pill" onClick={() => setOpen((v) => !v)} title="Claude usage">
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
