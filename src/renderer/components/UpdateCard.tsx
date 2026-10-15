import { useEffect, useReducer, useState } from 'react'
import { IconClose } from './icons'
import { noSelfInstallCopy } from '@shared/update-platform'
import type { UpdateProgress } from '@shared/types'
import { RELEASES_URL, checkForUpdatesNow, usePendingUpdate } from '../state/pendingUpdate'
import {
  INITIAL_CARD_STATE,
  cardVisible,
  nextCardState,
  statusVersion,
  type CardStatus
} from '../lib/updateCardState'
import { noteVersionSeen, releaseHighlights, releaseNotesUrl } from '../lib/releaseNotes'

// The updater lifecycle as one state machine (lib/updateCardState.ts — every transition rule and
// why lives there), driving a fixed bottom-right card. The contract, in short: automatic checks are
// SILENT until an update is downloaded (the card's single prompt — the title-bar button keeps the
// install path once the card is closed); a user-initiated check shows progress and its answer; a
// staged update is never downgraded or re-opened by a repeat; a restart click shows
// Preparing…/Restarting… until the app goes away.

/** Re-read the mandatory-update policy this often (main's /v1/check cache refreshes on the same
 *  cadence), and once sooner after an empty/failed first read (an offline launch). */
export const POLICY_REFRESH_MS = 6 * 60 * 60 * 1000
export const POLICY_RETRY_MS = 60 * 1000
/** A restart click main never acknowledged gives the button back after this long. */
const RESTART_ACK_MS = 10_000
const UP_TO_DATE_MS = 4000
const UPDATED_NOTE_MS = 15_000

export function UpdateCard(): JSX.Element | null {
  const [state, dispatch] = useReducer(nextCardState, INITIAL_CARD_STATE)
  const status = state.status
  // Highlights the /v1/check feed carries for one version (the update feed itself carries none
  // today). Shown only on a card for that exact version.
  const [feedNotes, setFeedNotes] = useState<{ version: string; notes: string } | null>(null)

  // Windows session host (issue #829): the installer refuses to run while the host is up, so the
  // card offers the in-app "Prepare for update" flow. Main answers `unsupported` everywhere else.
  const [canPrepare, setCanPrepare] = useState(false)
  useEffect(() => {
    let live = true
    void window.nodeTerminal.updates
      .prepareInspect()
      .then((r) => {
        if (live) setCanPrepare(r.kind !== 'unsupported')
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [])

  useEffect(() => {
    const u = window.nodeTerminal.updates
    const offs = [
      u.onAvailable((info) =>
        dispatch({ type: 'available', version: info.version, notes: info.notes, manual: !!info.manual })
      ),
      u.onProgress((p: UpdateProgress) => dispatch({ type: 'progress', percent: p.percent })),
      u.onDownloaded((info) => dispatch({ type: 'downloaded', version: info.version, notes: info.notes })),
      u.onNotAvailable(() => dispatch({ type: 'notAvailable' })),
      u.onNoChannel(() => dispatch({ type: 'noChannel' })),
      u.onError((message) => dispatch({ type: 'error', message })),
      u.onInstalling((s) => dispatch({ type: 'installing', phase: s.phase, version: s.version }))
    ]
    // Already staged before this renderer loaded (⌘R, a recreated window): main announced it once
    // and will not repeat it, so ask. A repeat of what the card shows is a no-op in the reducer.
    let live = true
    Promise.resolve()
      .then(() => u.getStaged?.())
      .then((s) => {
        if (live && s && typeof s.version === 'string')
          dispatch({ type: 'downloaded', version: s.version, notes: s.notes || undefined })
      })
      .catch(() => {})
    return () => {
      live = false
      offs.forEach((off) => off())
    }
  }, [])

  // "You're up to date" is a toast, not a card that stays.
  useEffect(() => {
    if (status.kind !== 'upToDate') return
    const t = window.setTimeout(() => dispatch({ type: 'upToDateExpired' }), UP_TO_DATE_MS)
    return () => window.clearTimeout(t)
  }, [status.kind])

  useEffect(() => {
    if (status.kind !== 'updated') return
    const t = window.setTimeout(() => dispatch({ type: 'updatedExpired' }), UPDATED_NOTE_MS)
    return () => window.clearTimeout(t)
  }, [status.kind])

  // A restart click main never acknowledged (it refused, or a stale card) must not leave a
  // permanently disabled button.
  useEffect(() => {
    if (status.kind !== 'preparing' || state.installAck) return
    const t = window.setTimeout(() => dispatch({ type: 'restartStalled' }), RESTART_ACK_MS)
    return () => window.clearTimeout(t)
  }, [status.kind, state.installAck])

  // A user-initiated check (Settings, the required card, the title-bar button).
  useEffect(() => {
    const onChecking = (): void => dispatch({ type: 'checking' })
    window.addEventListener('nodeterm:update-checking', onChecking)
    return () => window.removeEventListener('nodeterm:update-checking', onChecking)
  }, [])

  // Mandatory-update policy (from /v1/check via main). Re-read on a 6h cadence — a dock app runs
  // for weeks, and a minimum raised meanwhile used to wait for a relaunch — with one quick retry
  // when the first read failed or came back empty (an offline launch).
  useEffect(() => {
    let live = true
    let first = true
    let timer: number | undefined
    const schedule = (empty: boolean): void => {
      timer = window.setTimeout(read, first && empty ? POLICY_RETRY_MS : POLICY_REFRESH_MS)
      first = false
    }
    function read(): void {
      window.nodeTerminal.updates.getPolicy().then(
        (p) => {
          if (!live) return
          dispatch({ type: 'policy', policy: p })
          if (p.notes && p.latestVersion) setFeedNotes({ version: p.latestVersion, notes: p.notes })
          schedule(p.minSupported === null && !p.mandatory)
        },
        () => {
          if (live) schedule(true)
        }
      )
    }
    read()
    return () => {
      live = false
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [])

  // First launch of a newer version: a one-time "Updated to vX". Silent on a fresh install; the
  // Server Edition has no version to report (getVersion rejects) and so never shows it.
  useEffect(() => {
    let live = true
    Promise.resolve()
      .then(() => window.nodeTerminal.updates.getVersion())
      .then((v) => {
        if (live && typeof v === 'string' && noteVersionSeen(v, () => window.localStorage))
          dispatch({ type: 'updated', version: v })
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [])

  // Dev-only: drive the card through its states from the console without packaging, e.g.
  //   __simulateUpdate({ kind: 'available', version: '0.3.0', percent: 42 })
  useEffect(() => {
    ;(window as unknown as { __simulateUpdate?: (s: CardStatus) => void }).__simulateUpdate = (s) =>
      dispatch({ type: 'simulate', status: s })
    return () => {
      delete (window as unknown as { __simulateUpdate?: unknown }).__simulateUpdate
    }
  }, [])

  // Mirror an owed update into the title-bar button. Deliberately never cleared from here: the
  // card's ✕ sets `idle`, and dismissing the card must not take the install path away with it.
  const setPending = usePendingUpdate((s) => s.setPending)
  useEffect(() => {
    if (status.kind === 'downloaded' || status.kind === 'preparing' || status.kind === 'restarting') {
      setPending({ kind: 'downloaded', version: status.version })
    } else if (status.kind === 'manual') {
      setPending({ kind: 'manual', version: status.version })
    } else if (status.kind === 'required') {
      setPending({ kind: 'required', minSupported: status.minSupported })
    }
  }, [status, setPending])

  if (!cardVisible(state)) return null

  const version = statusVersion(status)
  const notesUrl = releaseNotesUrl(version)
  const openReleases = () => window.open(RELEASES_URL, '_blank', 'noopener')
  const openNotes = () => window.open(notesUrl, '_blank', 'noopener')
  const notes =
    ('notes' in status && status.notes) ||
    (feedNotes && version && feedNotes.version === version ? feedNotes.notes : undefined)
  const highlights = releaseHighlights(notes)
  const highlightList =
    highlights.length > 0 ? (
      <ul className="update-card__notes">
        {highlights.map((h, i) => (
          <li key={i}>{h}</li>
        ))}
      </ul>
    ) : null
  const prepareButton = canPrepare ? (
    <button
      className="update-card__link"
      onClick={() => window.dispatchEvent(new Event('nodeterm:prepare-update'))}
    >
      Prepare for update…
    </button>
  ) : null
  const dismiss = () => dispatch({ type: 'dismiss' })
  const minimize = () => dispatch({ type: 'minimize' })
  const restartNow = () => {
    dispatch({ type: 'restartClicked' })
    window.nodeTerminal.updates.restart()
  }

  if (state.minimized) {
    const label =
      status.kind === 'available'
        ? `${Math.round(status.percent)}%`
        : status.kind === 'downloaded'
          ? 'Ready'
          : status.kind === 'error'
            ? '!'
            : '…'
    return (
      <button
        className="update-card update-card--pill"
        title="Show update"
        onClick={() => dispatch({ type: 'restore' })}
      >
        <span className="update-card__dot" />
        {label}
      </button>
    )
  }

  const title =
    status.kind === 'checking'
      ? 'Checking for updates…'
      : status.kind === 'available'
        ? 'Downloading Update'
        : status.kind === 'manual'
          ? noSelfInstallCopy('manual-install', status.version).title
          : status.kind === 'noChannel'
            ? noSelfInstallCopy('no-channel').title
            : status.kind === 'downloaded'
              ? 'Update ready'
              : status.kind === 'preparing'
                ? 'Preparing update…'
                : status.kind === 'restarting'
                  ? 'Restarting nodeterm…'
                  : status.kind === 'upToDate'
                    ? "You're up to date"
                    : status.kind === 'required'
                      ? 'Update required'
                      : status.kind === 'updated'
                        ? `Updated to v${status.version}`
                        : 'Update failed'

  const canMinimize = status.kind === 'available' || status.kind === 'downloaded'
  const canDismiss =
    status.kind === 'available' ||
    status.kind === 'manual' ||
    status.kind === 'noChannel' ||
    status.kind === 'downloaded' ||
    status.kind === 'upToDate' ||
    status.kind === 'error' ||
    status.kind === 'updated'

  return (
    <div className="update-card">
      <div className="update-card__head">
        <span className="update-card__title">{title}</span>
        {canMinimize && (
          <button className="update-card__icon" title="Minimize" onClick={minimize}>
            —
          </button>
        )}
        {canDismiss && (
          <button className="update-card__icon" title="Dismiss" aria-label="Dismiss" onClick={dismiss}>
            <IconClose />
          </button>
        )}
      </div>

      {status.kind === 'checking' && (
        <p className="update-card__body">Looking for a newer version…</p>
      )}

      {status.kind === 'available' && (
        <>
          <p className="update-card__body">nodeterm v{status.version} is downloading.</p>
          {highlightList}
          <button className="update-card__link" onClick={openNotes}>
            Release notes
          </button>
          <div className="update-card__bar">
            <div className="update-card__bar-fill" style={{ width: `${status.percent}%` }} />
          </div>
          <p className="update-card__pct">Downloading… {Math.round(status.percent)}%</p>
        </>
      )}

      {status.kind === 'manual' && (
        <>
          <p className="update-card__body">
            {noSelfInstallCopy('manual-install', status.version).body}
          </p>
          {highlightList}
          <button className="update-card__btn" onClick={openReleases}>
            {noSelfInstallCopy('manual-install', status.version).action}
          </button>
          {prepareButton}
        </>
      )}

      {status.kind === 'noChannel' && (
        <>
          <p className="update-card__body">{noSelfInstallCopy('no-channel').body}</p>
          <button className="update-card__btn" onClick={openReleases}>
            {noSelfInstallCopy('no-channel').action}
          </button>
          {prepareButton}
        </>
      )}

      {status.kind === 'downloaded' && (
        <>
          {/* `downloaded` is only reached on self-install delivery, where install-on-quit is on. */}
          <p className="update-card__body">
            nodeterm v{status.version} is ready. It installs automatically the next time you quit.
          </p>
          {highlightList}
          {status.installError && <p className="update-card__hint">{status.installError}</p>}
          <button className="update-card__link" onClick={openNotes}>
            Release notes
          </button>
          <div className="update-card__actions">
            <button className="update-card__btn" onClick={restartNow}>
              Restart to update
            </button>
            <button className="update-card__link" onClick={minimize}>
              Later
            </button>
          </div>
        </>
      )}

      {(status.kind === 'preparing' || status.kind === 'restarting') && (
        <>
          <p className="update-card__body">
            {status.kind === 'preparing'
              ? `Getting nodeterm v${status.version} ready to install. This can take a moment.`
              : 'nodeterm will close and reopen on the new version. Your terminals keep running.'}
          </p>
          <button className="update-card__btn" disabled>
            <span className="update-card__spinner" aria-hidden="true" />
            {status.kind === 'preparing' ? 'Preparing…' : 'Restarting…'}
          </button>
        </>
      )}

      {status.kind === 'upToDate' && (
        <p className="update-card__body">nodeterm is on the latest version.</p>
      )}

      {status.kind === 'updated' && (
        <>
          {highlightList ?? <p className="update-card__body">See what changed in this release.</p>}
          <button className="update-card__link" onClick={openNotes}>
            What&apos;s new
          </button>
        </>
      )}

      {status.kind === 'required' && (
        <>
          <p className="update-card__body">
            This version is no longer supported
            {status.minSupported ? ` (minimum ${status.minSupported})` : ''}. Please update to
            continue.
          </p>
          {status.percent !== null ? (
            <>
              <div className="update-card__bar">
                <div className="update-card__bar-fill" style={{ width: `${status.percent}%` }} />
              </div>
              <p className="update-card__pct">Downloading… {Math.round(status.percent)}%</p>
            </>
          ) : (
            <button className="update-card__btn" onClick={checkForUpdatesNow}>
              Update now
            </button>
          )}
        </>
      )}

      {status.kind === 'error' && (
        <>
          <p className="update-card__body">{status.message}</p>
          <button className="update-card__link" onClick={openReleases}>
            Download manually
          </button>
          {prepareButton}
        </>
      )}
    </div>
  )
}
