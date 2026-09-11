import { useEffect, useMemo, useRef, useState } from 'react'
import { IconReload } from './icons'
import type { ClaudeUsage, ProviderUsage, RemoteAccountUsage, UsageLimit } from '@shared/types'
import { AGENT_CONFIG } from '@shared/agents/config'
import { useSettings } from '../state/settings'
import { useProjects } from '../state/projects'
import { useSshConn } from '../state/sshConn'
import {
  accountRowAction,
  dedupeProviderRows,
  providerRowKey,
  scopeFromKey,
  scopeUsage,
  usageScopeKey
} from '../lib/usageScope'
import {
  barFillPercent,
  formatResetCountdown,
  formatTimeAgo,
  percentNumber,
  percentText,
  severityColor
} from '../lib/usageFormat'
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

/** Grace period before a hover-opened popover closes, so the pointer can cross the pill's own
 *  gap (or clip a corner en route elsewhere) without the panel flickering shut. */
const USAGE_HOVER_CLOSE_MS = 220

/**
 * A single limit row in the popover: bar, "% left"/"% used", reset countdown. The bar's fill
 * honours the display mode (`barFillPercent`) so it tracks the same quantity as the number
 * beside it; its color stays keyed to the TRUE remaining percentage via `severityColor`, so
 * severity red/yellow/green never flips meaning when the mode does.
 */
function LimitRow({ limit, mode }: { limit: UsageLimit; mode: 'used' | 'remaining' | 'tokens' }) {
  const left = 100 - limit.usedPercent
  const fill = barFillPercent(limit.usedPercent, mode)
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
          style={{ width: `${fill}%`, background: severityColor(limit.severity, left) }}
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
 * The account-row affordance for issue #142 — the switch lives where the decision is made.
 * It writes `project.defaultAccountId` and nothing else: `data.accountId` is resolved once at
 * node creation and is immutable after, so the copy says "new sessions" and running sessions
 * never move. `isDefault` marks the row the project currently resolves to; `onUse` is absent
 * when there is nothing honest to offer (no active project, or a row whose account this
 * project cannot launch).
 */
function DefaultAccountMark({
  isDefault,
  onUse
}: {
  isDefault: boolean
  onUse?: () => void
}) {
  if (isDefault)
    return (
      <span
        className="usage-account__default"
        title="New Claude nodes in this project open under this account."
      >
        ✓ new sessions
      </span>
    )
  if (!onUse) return null
  return (
    <button
      type="button"
      className="usage-account__use"
      title="New Claude nodes in this project will open under this account. Running sessions keep theirs."
      onClick={onUse}
    >
      Use for new sessions
    </button>
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
  mode,
  isDefault = false,
  onUse
}: {
  label: string
  email?: string
  u: ClaudeUsage | null
  mode: 'used' | 'remaining' | 'tokens'
  isDefault?: boolean
  onUse?: () => void
}) {
  return (
    <div className="usage-account">
      <div className="usage-account__label">
        {label}
        <DefaultAccountMark isDefault={isDefault} onUse={onUse} />
      </div>
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
 * One SSH host's Claude identity. Carries the host explicitly: the same subscription can be
 * logged in on the desktop and on two servers, and a row that only said "Claude" would be
 * indistinguishable from the local one sitting right above it.
 *
 * An 'unavailable' row is dropped exactly like an unused provider — a host where nobody has run
 * `claude` has nothing to report, and listing it would turn "connect an SSH project" into "grow
 * a permanent empty section".
 */
function RemoteUsageBlock({
  row,
  mode,
  isDefault = false,
  onUse
}: {
  row: RemoteAccountUsage
  mode: 'used' | 'remaining' | 'tokens'
  isDefault?: boolean
  onUse?: () => void
}) {
  if (row.usage.status === 'unavailable') return null
  const showHost = row.label !== row.hostKey
  return (
    <div className="usage-account">
      <div className="usage-account__label">
        {row.label}
        <span className="usage-account__host" title={`Read on ${row.hostKey} over SSH`}>
          {showHost ? row.hostKey : 'SSH'}
        </span>
        <DefaultAccountMark isDefault={isDefault} onUse={onUse} />
      </div>
      {row.usage.email && <div className="usage-account__email">{row.usage.email}</div>}
      {row.usage.limits.map((l) => (
        <LimitRow key={limitKey(l)} limit={l} mode={mode} />
      ))}
      {row.usage.limits.length === 0 && (
        <div className="usage-popover__empty">
          {row.usage.status === 'error' ? 'Could not read usage on this host.' : 'No usage data.'}
        </div>
      )}
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

function ProviderBlock({ u, mode }: { u: ProviderUsage; mode: 'used' | 'remaining' | 'tokens' }) {
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
export function UsageIndicator({
  overBoard = false,
  onSetDefaultAccount
}: {
  overBoard?: boolean
  /** Writes `project.defaultAccountId` + persists (Canvas's own TabBar handler). When absent the
   *  popover is a pure readout, exactly as before issue #142. */
  onSetDefaultAccount?: (projectId: string, accountId: string | undefined) => void
}): JSX.Element | null {
  const [usage, setUsage] = useState<ClaudeUsage | null>(null)
  const [open, setOpen] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [acctUsage, setAcctUsage] = useState<Record<string, ClaudeUsage | null>>({})
  const [providers, setProviders] = useState<ProviderUsage[]>([])
  const [remote, setRemote] = useState<RemoteAccountUsage[]>([])
  const popRef = useRef<HTMLDivElement>(null)
  const closeTimerRef = useRef<number | null>(null)

  const claudeAccounts = useSettings((s) => s.settings.claudeAccounts)
  const systemLabelSetting = useSettings((s) => s.settings.systemAccountLabel)
  const hiddenProviders = useSettings((s) => s.settings.hiddenUsageProviders)
  const percentMode = useSettings((s) => s.settings.usagePercentMode)
  // Local logged-in accounts get their own popover row; skip pending logins + remote (host) ones.
  const accounts = useMemo(
    () => claudeAccounts.filter((a) => !a.pending && !a.host),
    [claudeAccounts]
  )

  // The indicator follows the ACTIVE project: on a local project it is this machine, on an SSH
  // project it is that host and nothing else. Showing every source at once is what made the panel
  // unreadable once remote hosts joined it.
  const activeProjectId = useProjects((s) => s.activeProjectId)
  const scopeHostKey = useProjects((s) =>
    usageScopeKey(s.projects.find((p) => p.id === s.activeProjectId))
  )
  const scope = useMemo(() => scopeFromKey(scopeHostKey), [scopeHostKey])

  // Issue #142 — "Use for new sessions" on the account rows. A PRIMITIVE selector on purpose
  // (see scopeHostKey above): selecting the project object would re-render the pill on every
  // canvas edit.
  const projectDefaultId = useProjects(
    (s) => s.projects.find((p) => p.id === s.activeProjectId)?.defaultAccountId
  )
  // The accounts THIS project can actually launch — the same host rule the whole panel follows
  // (local project: local accounts; SSH project: that host's). The persisted default is validated
  // against them, exactly as resolveNewNodeAccount does at node creation: a stale id (account
  // since removed) marks the System row, never a ghost.
  const eligibleAccounts = useMemo(
    () =>
      claudeAccounts.filter(
        (a) => !a.pending && (scopeHostKey ? a.host === scopeHostKey : !a.host)
      ),
    [claudeAccounts, scopeHostKey]
  )
  // One rule for every row, local and remote alike — `accountRowAction` (pure, tested) decides
  // default/offer/none; this pair just turns its answer into props. Absent handler / no project =
  // pure readout, exactly as before. null = the System row (clears the override).
  const rowMark = (accountId: string | null): { isDefault: boolean; onUse?: () => void } => {
    const action = accountRowAction(accountId, eligibleAccounts, projectDefaultId)
    return {
      isDefault: action === 'default',
      onUse:
        action === 'offer' && onSetDefaultAccount && activeProjectId
          ? () => onSetDefaultAccount(activeProjectId, accountId ?? undefined)
          : undefined
    }
  }

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

  // Remote (SSH host) Claude accounts, for THIS project's host only. Same cadence as
  // `providers` — mount, popover open — plus the moment the project's connection comes up
  // (`sshUp`: an SSH project is usually opened before its master is ready, and without this the
  // pill stays empty until you click it). Never polled: each row is an ssh exec plus an HTTPS
  // request made on the host, which is not a price to pay every 15 minutes for a pill nobody may
  // be looking at.
  const sshUp = useSshConn((s) => !!s.byProject[activeProjectId])
  useEffect(() => {
    if (!scopeHostKey || !sshUp) {
      // Leaving the rows up after a switch would attribute one machine's numbers to another.
      setRemote((prev) => (prev.length ? [] : prev))
      return
    }
    let cancelled = false
    void window.nodeTerminal.usage.remote({ hostKey: scopeHostKey }).then((rows) => {
      if (!cancelled) setRemote(rows)
    })
    return () => {
      cancelled = true
    }
  }, [open, scopeHostKey, sshUp])

  // Fetch each account's usage on demand when the popover opens (system row uses `usage`).
  // Skipped entirely on an SSH project: those identities are not what this project spends.
  useEffect(() => {
    if (scope.kind !== 'local' || !open || accounts.length === 0) return
    let cancelled = false
    for (const a of accounts) {
      void window.nodeTerminal.usage.fetch(a.id).then((u) => {
        if (!cancelled) setAcctUsage((m) => ({ ...m, [a.id]: u }))
      })
    }
    return () => {
      cancelled = true
    }
  }, [open, accounts, scope.kind])

  // Close the popover on an outside click.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (popRef.current && !popRef.current.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [open])

  useEffect(() => () => { if (closeTimerRef.current) window.clearTimeout(closeTimerRef.current) }, [])

  // Hover opens it — the panel is a readout, so making the user click to see numbers they were
  // already looking at is a step for nothing. The popover renders INSIDE this container, so
  // travelling from the pill into it never leaves; only leaving the whole thing closes, and that
  // is delayed so a pointer clipping the corner on its way elsewhere doesn't snap it shut.
  const openNow = (): void => {
    if (closeTimerRef.current) window.clearTimeout(closeTimerRef.current)
    closeTimerRef.current = null
    setOpen(true)
  }
  const closeSoon = (): void => {
    if (closeTimerRef.current) window.clearTimeout(closeTimerRef.current)
    closeTimerRef.current = window.setTimeout(() => setOpen(false), USAGE_HOVER_CLOSE_MS)
  }

  // Settings → Usage toggles are a display choice, applied before any other rule — a hidden
  // provider is invisible here even when signed in and mid-limit. Scoping runs after them: the
  // toggles say what you never want to see, the scope says what belongs to where you are.
  const hidden = new Set(hiddenProviders)
  const scoped = scopeUsage({
    scope,
    claude: hidden.has('claude') ? null : usage,
    accounts,
    providers: providers.filter((p) => !hidden.has(p.provider)),
    // Its own switch, not Claude's: hiding the local rows must not silently take the SSH hosts
    // down with them, and vice versa.
    remote: hidden.has('claude-remote') ? [] : remote
  })
  const claudeUsage = scoped.claude
  const visibleProviders = scoped.providers
  const visibleRemote = scoped.remote

  // Only providers the user has actually enabled reach the pill; render whenever ANY of them
  // (Claude included) has something to say. Both rules are pure and pinned by tests — gating on
  // Claude alone, which is what this did, left a Codex-only user with no pill at all.
  const enabled = enabledProviders(visibleProviders)
  if (!hasAnyUsage(claudeUsage, visibleProviders, visibleRemote)) return null

  // On an SSH project these are the HOST's limits — same shape, same labels, read somewhere else.
  const limits = scoped.pillLimits
  const status = claudeUsage?.status ?? visibleRemote[0]?.usage.status ?? 'unavailable'
  const hasData = limits.length > 0 || enabled.length > 0
  const fetching = refreshing
  const isError = status === 'error'
  // The pill leads with whatever is closest to biting, so a scoped model cap that is nearly
  // exhausted can't hide behind a comfortable 5h window. Considers every enabled provider, not
  // just Claude, so an exhausted Codex window drives the bar too.
  const primary = primaryLimit([...limits, ...enabled.flatMap((p) => p.limits)])
  const updatedAt = claudeUsage?.updatedAt ?? visibleRemote[0]?.usage.updatedAt ?? null

  const refresh = async (e: React.MouseEvent): Promise<void> => {
    e.stopPropagation()
    if (refreshing) return
    setRefreshing(true)
    try {
      // ⟳ refreshes what is actually on screen. On an SSH project that is the host — forced past
      // its debounce, since this is the only way to make it re-read before the cache expires —
      // and the local snapshot is left alone rather than spending a request on rows nobody can see.
      if (scope.kind === 'ssh') {
        setRemote(
          await window.nodeTerminal.usage
            .remote({ hostKey: scope.hostKey, force: true })
            .catch((): RemoteAccountUsage[] => [])
        )
      } else {
        setUsage(await window.nodeTerminal.usage.refresh())
      }
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
                width: `${barFillPercent(primary.usedPercent, percentMode)}%`,
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
    <div
      className={`usage-indicator${overBoard ? ' usage-indicator--board' : ''}`}
      ref={popRef}
      onMouseEnter={openNow}
      onMouseLeave={closeSoon}
    >
      {open && (
        <div className="usage-popover">
          <div className="usage-popover__head">
            <span className="usage-popover__title">✦ Usage</span>
            {/* Tracks whichever snapshot the panel is actually showing — the local poll's, or
                the host read's on an SSH project. Absent when neither has answered yet. */}
            {updatedAt !== null && (
              <span className="usage-popover__ago">Updated {formatTimeAgo(updatedAt)}</span>
            )}
          </div>
          {/* Issue #503: the account blocks SCROLL, the heading and the footer action do not.
              Each account is a tall block (name + Session/Weekly/Opus meters), so past about
              four accounts the popover grew off the top of the window — the first account's
              header and meter were clipped with no way to reach them. Same rule as the session
              memory panel's row list: every row is rendered, the list scrolls. */}
          <div className="usage-popover__body">
            {/* The local Claude section belongs to a LOCAL project only. On an SSH project the
                remote blocks below carry the same limits, and rendering both would print the
                host's numbers twice under two different headings. */}
            {scope.kind === 'local' &&
              (scoped.accounts.length > 0 && claudeUsage ? (
                <>
                  <AccountUsageBlock
                    mode={percentMode}
                    label={systemAccountDisplay(systemLabelSetting, claudeUsage.email)}
                    // Avoid printing the email twice when it's already the display label.
                    email={systemLabelSetting.trim() ? (claudeUsage.email ?? undefined) : undefined}
                    u={claudeUsage}
                    {...rowMark(null)}
                  />
                  {scoped.accounts.map((a) => (
                    <AccountUsageBlock
                      key={a.id}
                      mode={percentMode}
                      label={a.label}
                      email={a.email}
                      u={acctUsage[a.id] ?? null}
                      {...rowMark(a.id)}
                    />
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
                  {claudeUsage?.email && (
                    <div className="usage-account">
                      <div className="usage-account__label">Claude Account</div>
                      <div className="usage-account__email">{claudeUsage.email}</div>
                    </div>
                  )}
                </>
              ))}
            {/* On an SSH project these are the whole panel; the host badge is what says the numbers
                were read somewhere other than this machine. */}
            {/* The same offer on an SSH project's rows — scoped as ever: only the host's system
                identity and THIS host's managed accounts are actionable (accountRowAction). */}
            {visibleRemote.map((r) => (
              <RemoteUsageBlock
                key={`${r.hostKey}#${r.accountId ?? ''}`}
                row={r}
                mode={percentMode}
                {...rowMark(r.accountId)}
              />
            ))}
            {scope.kind === 'ssh' && visibleRemote.length === 0 && (
              <div className="usage-popover__empty">
                No usage from this host yet — it is read once the project connects.
              </div>
            )}
            {/* U8 (owed from PR 7): Codex emits one row per account, all `provider: 'codex'`.
                Key on provider+accountId so each account renders distinctly, and reduce true
                duplicates (two settings entries → the same underlying account) to one row. */}
            {dedupeProviderRows(visibleProviders).map((p) => (
              <ProviderBlock key={providerRowKey(p)} u={p} mode={percentMode} />
            ))}
          </div>
          {/* Issue #420 — "Switch account" where the limit is displayed: opens a terminal
              running the SYSTEM-scoped `claude /login` (createSystemLoginNode), so picking the
              other org is one click from the panel that said you need to. Nothing changes until
              the user completes the login IN that terminal — the CLI's own org picker + OAuth —
              which is why there is no confirm dialog in front of it: the terminal is the
              confirmation surface, and the tooltip names what completing it changes. LOCAL scope
              only: on an SSH project a system login would rewrite the HOST's ~/.claude, and
              saying "switch account" while meaning another machine's identity is the kind of
              ambiguity this popover exists to avoid. Hidden with the Claude provider — a switch
              button for numbers the user chose not to see would be an orphan. */}
          {scope.kind === 'local' && !hidden.has('claude') && (
            <button
              type="button"
              className="usage-popover__switch"
              title={
                'Opens a terminal running `claude /login` for the system account (~/.claude). ' +
                'Completing it switches the org/account all system sessions use — running ' +
                'sessions carry on under the new one. Managed accounts keep their own logins.'
              }
              onClick={() => {
                setOpen(false)
                window.dispatchEvent(new CustomEvent('nodeterm:switch-system-account'))
              }}
            >
              ⇄ Switch account…
            </button>
          )}
        </div>
      )}
      {/* The SSH pill is visually identical to the local one — same labels, same bar — so the
          title is what answers "whose numbers are these?" without opening the popover. */}
      <button
        className="usage-pill"
        // Hover already opens it; the click stays for the pointer-less paths (keyboard focus,
        // touch) and as the way to dismiss it without moving the pointer away.
        onClick={() => setOpen((v) => !v)}
        onFocus={openNow}
        title={scope.kind === 'ssh' ? `Agent usage on ${scope.hostKey}` : 'Agent usage'}
      >
        <span className="usage-pill__icon">✦</span>
        {pillBody}
      </button>
      <button
        className={`usage-refresh${fetching ? ' spin' : ''}`}
        onClick={refresh}
        disabled={refreshing}
        title="Refresh usage"
      >
        <IconReload />
      </button>
    </div>
  )
}
