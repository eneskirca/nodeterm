import { useEffect, useRef, useState } from 'react'
import { IconClose } from './icons'
import type { UpdateProgress } from '@shared/types'

// The full updater lifecycle as one status union, driving a fixed bottom-right card.
// `checking` is only ever shown for a user-initiated manual check; automatic checks stay
// silent until they produce an `available` (or, for a manual check, `upToDate`/`error`).
type Status =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'available'; version: string; percent: number }
  // A .deb/.rpm Linux install can't self-install — show a manual download link, no progress/restart.
  | { kind: 'manual'; version: string }
  | { kind: 'downloaded'; version: string }
  | { kind: 'upToDate' }
  | { kind: 'required'; minSupported: string | null }
  | { kind: 'error'; message: string }

const RELEASES_URL = 'https://nodeterm.dev/releases'

export function UpdateCard(): JSX.Element | null {
  const [status, setStatus] = useState<Status>({ kind: 'idle' })
  const [minimized, setMinimized] = useState(false)
  const upToDateTimer = useRef<number | null>(null)

  useEffect(() => {
    const offAvailable = window.nodeTerminal.updates.onAvailable((info) => {
      setStatus(
        info.manual
          ? { kind: 'manual', version: info.version }
          : { kind: 'available', version: info.version, percent: 0 }
      )
      setMinimized(false)
    })
    const offProgress = window.nodeTerminal.updates.onProgress((p: UpdateProgress) => {
      setStatus((s) => (s.kind === 'available' ? { ...s, percent: p.percent } : s))
    })
    const offDownloaded = window.nodeTerminal.updates.onDownloaded((info) => {
      setStatus({ kind: 'downloaded', version: info.version })
      setMinimized(false)
    })
    const offNotAvailable = window.nodeTerminal.updates.onNotAvailable(() => {
      setStatus((s) => (s.kind === 'required' ? s : { kind: 'upToDate' }))
      setMinimized(false)
      if (upToDateTimer.current) window.clearTimeout(upToDateTimer.current)
      upToDateTimer.current = window.setTimeout(
        () => setStatus((s) => (s.kind === 'required' ? s : { kind: 'idle' })),
        4000
      )
    })
    const offError = window.nodeTerminal.updates.onError((message) => {
      setStatus({ kind: 'error', message })
      setMinimized(false)
    })
    return () => {
      offAvailable()
      offProgress()
      offDownloaded()
      offNotAvailable()
      offError()
      if (upToDateTimer.current) window.clearTimeout(upToDateTimer.current)
    }
  }, [])

  // A manual check was triggered from Settings → show the checking state (unless an update
  // is already downloading or staged, which must not be overwritten).
  useEffect(() => {
    const onChecking = () => {
      setStatus((s) =>
        s.kind === 'available' ||
        s.kind === 'manual' ||
        s.kind === 'downloaded' ||
        s.kind === 'required'
          ? s
          : { kind: 'checking' }
      )
      setMinimized(false)
    }
    window.addEventListener('nodeterm:update-checking', onChecking)
    return () => window.removeEventListener('nodeterm:update-checking', onChecking)
  }, [])

  // Mandatory-update policy (from /v1/check via main). If the running version is below the
  // channel minimum, show a non-dismissible "required" card. Don't override an in-progress
  // download/ready state.
  useEffect(() => {
    void window.nodeTerminal.updates.getPolicy().then((p) => {
      if (!p.mandatory) return
      setStatus((s) =>
        s.kind === 'available' || s.kind === 'manual' || s.kind === 'downloaded'
          ? s
          : { kind: 'required', minSupported: p.minSupported }
      )
    })
  }, [])

  // Dev-only: drive the card through its states from the console without packaging, e.g.
  //   __simulateUpdate({ kind: 'available', version: '0.3.0', percent: 42 })
  useEffect(() => {
    ;(window as unknown as { __simulateUpdate?: (s: Status) => void }).__simulateUpdate = (s) =>
      setStatus(s)
    return () => {
      delete (window as unknown as { __simulateUpdate?: unknown }).__simulateUpdate
    }
  }, [])

  if (status.kind === 'idle') return null

  const openReleases = () => window.open(RELEASES_URL, '_blank', 'noopener')
  const dismiss = () => setStatus({ kind: 'idle' })

  if (minimized) {
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
        onClick={() => setMinimized(false)}
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
          ? 'Update available'
          : status.kind === 'downloaded'
          ? 'Update ready'
          : status.kind === 'upToDate'
            ? "You're up to date"
            : status.kind === 'required'
              ? 'Update required'
              : 'Update failed'

  const canMinimize = status.kind === 'available' || status.kind === 'downloaded'
  const canDismiss =
    status.kind === 'manual' ||
    status.kind === 'downloaded' ||
    status.kind === 'upToDate' ||
    status.kind === 'error'

  return (
    <div className="update-card">
      <div className="update-card__head">
        <span className="update-card__title">{title}</span>
        {canMinimize && (
          <button className="update-card__icon" title="Minimize" onClick={() => setMinimized(true)}>
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
          <button className="update-card__link" onClick={openReleases}>
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
            nodeterm v{status.version} is available. Download it to update.
          </p>
          <button className="update-card__btn" onClick={openReleases}>
            Download
          </button>
        </>
      )}

      {status.kind === 'downloaded' && (
        <>
          <p className="update-card__body">nodeterm v{status.version} is ready to install.</p>
          <button className="update-card__link" onClick={openReleases}>
            Release notes
          </button>
          <button
            className="update-card__btn"
            onClick={() => window.nodeTerminal.updates.restart()}
          >
            Restart to update
          </button>
        </>
      )}

      {status.kind === 'upToDate' && (
        <p className="update-card__body">nodeterm is on the latest version.</p>
      )}

      {status.kind === 'required' && (
        <>
          <p className="update-card__body">
            This version is no longer supported
            {status.minSupported ? ` (minimum ${status.minSupported})` : ''}. Please update to
            continue.
          </p>
          <button className="update-card__btn" onClick={() => window.nodeTerminal.updates.check()}>
            Update now
          </button>
        </>
      )}

      {status.kind === 'error' && (
        <>
          <p className="update-card__body">{status.message}</p>
          <button className="update-card__link" onClick={openReleases}>
            Download manually
          </button>
        </>
      )}
    </div>
  )
}
