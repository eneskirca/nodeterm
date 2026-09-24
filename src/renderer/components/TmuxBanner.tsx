import { useEffect, useRef, useState } from 'react'
import { IconClose } from './icons'
import { persistenceDescription, usePersistenceStatus } from './usePersistenceStatus'
import { localSession } from '../session/localSession'

// Backend discovery is shared with Settings. Availability does not assert runtime health.
export const INSTALL_POLL_MS = 3000
export const INSTALL_CAP_MS = 5 * 60_000
export const READY_HIDE_MS = 6000

export type InstallPhase = 'missing' | 'installing' | 'ready' | 'failed'

/** Poll verdict while installing: available wins outright; past the cap → failed. */
export function pollOutcome(available: boolean, elapsedMs: number): InstallPhase {
  if (available) return 'ready'
  return elapsedMs >= INSTALL_CAP_MS ? 'failed' : 'installing'
}

export function TmuxBanner({ onInstall }: { onInstall?: (command: string) => void }): JSX.Element | null {
  const status = usePersistenceStatus()
  const [dismissed, setDismissed] = useState(false)
  const [phase, setPhase] = useState<InstallPhase>('missing')
  const startedAtRef = useRef(0)

  // While installing, poll tmuxStatus. The raw install output is visible in the spawned
  // terminal node either way — the banner only reports the outcome.
  useEffect(() => {
    if (phase !== 'installing' || dismissed) return
    let cancelled = false
    const t = setInterval(() => {
      localSession.api.pty
        .tmuxStatus()
        .then((s) => {
          if (cancelled) return
          const next = pollOutcome(s.available, Date.now() - startedAtRef.current)
          if (next !== 'installing') setPhase(next)
        })
        .catch(() => {
          if (!cancelled && Date.now() - startedAtRef.current >= INSTALL_CAP_MS) setPhase('failed')
        })
    }, INSTALL_POLL_MS)
    return () => {
      cancelled = true
      clearInterval(t)
    }
  }, [phase, dismissed])

  // The success note has said what it needed to — take itself down.
  useEffect(() => {
    if (phase !== 'ready') return
    const t = setTimeout(() => setDismissed(true), READY_HIDE_MS)
    return () => clearTimeout(t)
  }, [phase])

  if (dismissed || status === undefined) return null
  if (status?.persistence?.enabled && status.persistence.backend && phase === 'missing') return null

  const title =
    phase === 'installing'
      ? 'Installing tmux'
      : phase === 'ready'
        ? 'tmux ready'
        : !status?.persistence
          ? 'Session protection unknown'
          : !status.persistence.enabled
            ? 'Session protection off'
            : 'Session protection unavailable'
  const body =
    phase === 'installing'
      ? 'Running the install in a terminal node — watch it for progress (it may ask for your password).'
      : phase === 'ready'
        ? 'tmux is now available for new local terminals. Existing plain-shell terminals are not upgraded.'
        : phase === 'failed'
          ? 'The install hasn’t completed. Check the terminal node for errors, or install tmux with your package manager and restart nodeterm.'
          : persistenceDescription(status)

  const showInstall =
    (phase === 'missing' || phase === 'failed') && !!onInstall &&
    status?.persistence?.enabled && !status.persistence.backend && !!status.installCommand
  return (
    <div className="announce-banner announce-banner--warning">
      <span className="announce-banner__dot" />
      <div className="announce-banner__content">
        <span className="announce-banner__title">{title}</span>
        <span className="announce-banner__body">{body}</span>
      </div>
      {showInstall && (
        <button
          className="announce-banner__btn"
          title={status!.installCommand!}
          onClick={() => {
            onInstall?.(status!.installCommand!)
            startedAtRef.current = Date.now()
            setPhase('installing')
          }}
        >
          {phase === 'failed' ? 'Retry' : (status!.installLabel ?? 'Install tmux')}
        </button>
      )}
      <button className="announce-banner__close" title="Dismiss" aria-label="Dismiss" onClick={() => setDismissed(true)}>
        <IconClose />
      </button>
    </div>
  )
}
