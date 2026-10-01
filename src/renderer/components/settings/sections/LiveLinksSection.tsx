import { useEffect, useState } from 'react'
import { SettingsSection } from '../SettingsSection'
import { SearchableRow } from '../SearchableRow'
import { Button } from '@renderer/ui/Button'
import { CopyButton } from '@renderer/ui/CopyButton'
import { isBrowserRuntime } from '@renderer/bridge/runtime'
import { ConfirmDialog } from '../../ConfirmDialog'
import { projectSessionSource, showsLiveLinks } from '../../LiveLinkChip'
import { useEntitlement } from '../../../state/entitlement'
import { useProjects } from '../../../state/projects'
import { useWatchLinks } from '../../../state/watchLinks'
import {
  formatRemaining,
  NOT_IN_OPEN_PROJECT,
  ROLE_LABEL,
  SERVER_EDITION_UNSUPPORTED,
  showsStopAll,
  statusLine,
  STOP_ALL_BUTTON,
  stopAllElsewhereNote
} from '../../../lib/liveLink'
import { stopAllConfirm, stopAllLiveLinks, stopLiveLinks } from '../../../lib/liveLinkEntry'
import { stripBidiControls, type WatchLinkView } from '@shared/watch-link-types'
import type { Project } from '@shared/types'

const ROWS = {
  links: {
    title: 'Active live links',
    keywords: ['live', 'link', 'share', 'watch', 'broadcast', 'viewer', 'stop']
  }
}
const ENTRIES = Object.values(ROWS)

/**
 * Which project a link's node is in, as the row names it (H11): an open project on THIS machine
 * first, else a closed one (a closed project keeps its sessions running, so its links run too),
 * else "not in an open project". A project bound to a relay session is another machine's canvas —
 * a node there with the same id is not the node this machine's link broadcasts (R57). A CLOSED relay
 * tab no longer has a session (closing it unbinds the project, so its source reads as the local one),
 * which is why `remote` — the relay tab's own mark — is checked too (D2/M2).
 */
export function liveLinkProjectLabel(projects: readonly Project[], nodeId: string): string {
  const holders = projects.filter(
    (p) =>
      !p.remote &&
      Array.isArray(p.nodes) &&
      p.nodes.some((n) => n?.id === nodeId) &&
      showsLiveLinks(projectSessionSource(p.id))
  )
  const open = holders.find((p) => !p.closed)
  if (open) return open.name
  const closed = holders[0]
  return closed ? `${closed.name} (closed)` : NOT_IN_OPEN_PROJECT
}

function LinkRow({ link, now, projects }: { link: WatchLinkView; now: number; projects: readonly Project[] }): React.JSX.Element {
  const [error, setError] = useState<string | null>(null)
  const [stopping, setStopping] = useState(false)
  const status = statusLine(link)
  return (
    <div className="live-settings__row flex items-center justify-between gap-3">
      <div className="min-w-0">
        {/* Titles and names are other people's text: rendered as TEXT, bidi controls stripped. The
            URL is NOT shown here — it carries the link's secret; Copy is how it leaves. */}
        <div className="truncate text-sm text-text">
          <strong>{stripBidiControls(link.title)}</strong>
          <span className="text-muted"> · {liveLinkProjectLabel(projects, link.nodeId)}</span>
        </div>
        <div className="text-xs text-muted">
          {ROLE_LABEL[link.role]} · {link.viewers.length} watching · {formatRemaining(link.expiresAt, now)}
        </div>
        {status && <div className="text-xs text-muted">{status}</div>}
        {error && (
          <div className="text-xs" role="alert" style={{ color: 'var(--danger)' }}>
            {error}
          </div>
        )}
      </div>
      <div className="flex shrink-0 gap-2">
        <CopyButton text={link.url} variant="default" />
        <Button
          disabled={stopping}
          onClick={() => {
            setError(null)
            setStopping(true)
            void stopLiveLinks(() => window.nodeTerminal.watchLink.revoke(link.linkId), setError).then(() =>
              setStopping(false)
            )
          }}
        >
          Stop
        </Button>
      </div>
    </div>
  )
}

export function LiveLinksSection({ isActive }: { isActive: boolean }): React.JSX.Element {
  const premium = useEntitlement((s) => s.isPremium)
  const links = useWatchLinks((s) => s.links)
  const projects = useProjects((s) => s.projects)
  const serverEdition = isBrowserRuntime()
  const [now, setNow] = useState(() => Date.now())
  const [confirmStopAll, setConfirmStopAll] = useState(false)
  /** What the last Stop all reached (R62) — said for a success too: with no link listed on this
   *  machine, nothing else on this page changes. */
  const [stopAllResult, setStopAllResult] = useState<{ ok: boolean; text: string } | null>(null)
  const [stoppingAll, setStoppingAll] = useState(false)
  const stopAllShown = showsStopAll({ serverEdition, entitled: premium, activeLinks: links.length })
  useEffect(() => {
    if (!isActive) return
    setNow(Date.now())
    const t = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(t)
  }, [isActive])
  const confirm = stopAllConfirm({
    close: () => setConfirmStopAll(false),
    stop: () => {
      setStopAllResult(null)
      setStoppingAll(true)
      void stopAllLiveLinks(() => window.nodeTerminal.watchLink.revokeAll()).then((r) => {
        setStoppingAll(false)
        setStopAllResult(r)
      })
    }
  })
  return (
    <SettingsSection
      id="live-links"
      title="Live links"
      description="A read-only browser link to one terminal. Viewers need nothing installed; links end on their own."
      isActive={isActive}
      searchEntries={ENTRIES}
    >
      <SearchableRow {...ROWS.links}>
        {links.length > 0 ? (
          // Shown whether or not Pro is active right now: a link keeps running out its term after
          // a lapse, and Stop must stay reachable (H10).
          <div className="space-y-3">
            <h4 className="text-[13px] font-medium text-text">Active live links</h4>
            <div className="live-settings space-y-3">
              {links.map((l) => (
                <LinkRow key={l.linkId} link={l} now={now} projects={projects} />
              ))}
            </div>
          </div>
        ) : serverEdition ? (
          // R43: no license layer in the Server Edition yet — say so, never offer an Upgrade.
          <p className="text-sm text-muted">{SERVER_EDITION_UNSUPPORTED}</p>
        ) : premium ? (
          <div className="space-y-1">
            <p className="text-sm text-muted">
              No active live links. Right-click a terminal and choose "Share live link…".
            </p>
            {/* Links shared from OTHER machines are invisible here, and Stop all is the one control
                that reaches them (R62): say so, beside the button. */}
            <p className="text-xs text-muted">{stopAllElsewhereNote()}</p>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-muted">
              Share a terminal live with anyone — a teammate, a customer, a reviewer — as a link that ends
              by itself.
            </p>
            <Button variant="primary" onClick={() => void useEntitlement.getState().upgrade('pro')}>
              Upgrade to Pro
            </Button>
          </div>
        )}
        {stopAllShown && (
          <div className="mt-3 flex items-center gap-3">
            <Button disabled={stoppingAll} onClick={() => setConfirmStopAll(true)}>
              {STOP_ALL_BUTTON}
            </Button>
            {stopAllResult && (
              <span
                className="text-xs"
                role={stopAllResult.ok ? 'status' : 'alert'}
                style={stopAllResult.ok ? undefined : { color: 'var(--danger)' }}
              >
                {stopAllResult.text}
              </span>
            )}
          </div>
        )}
      </SearchableRow>
      {confirmStopAll && (
        <ConfirmDialog
          message={confirm.message}
          confirmLabel={confirm.confirmLabel}
          danger={confirm.danger}
          onConfirm={confirm.onConfirm}
          onCancel={() => setConfirmStopAll(false)}
        />
      )}
    </SettingsSection>
  )
}
