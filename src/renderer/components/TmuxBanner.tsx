import { useEffect, useRef, useState } from 'react'
import { IconClose } from './icons'
import type { TmuxStatus } from '@shared/types'
import { localSession } from '../session/localSession'

// "tmux not found" strip: without tmux the app silently degrades to a plain shell — terminals
// don't survive restarts and the mobile companion can't attach — and nothing used to say so
// (one field report ran degraded for months without anyone noticing). Shown every launch until
// tmux is installed; the ✕ hides it for this session only. The install button runs the suggested
// package-manager command in a new terminal node (the gh-sign-in pattern) and — unlike the first
// version, which dismissed the banner optimistically and left the user guessing (second field
// report) — keeps the banner up as a status strip: installing → ready | failed. tmuxStatus()
// re-probes on every call (ensureTmux), so `available` flipping true is also what makes NEW
// terminals tmux-backed without a restart. Hidden on win32 and on any fetch error (fail-open).

export const INSTALL_POLL_MS = 3000
export const INSTALL_CAP_MS = 5 * 60_000
export const READY_HIDE_MS = 6000

export type InstallPhase = 'missing' | 'installing' | 'ready' | 'failed'

/** Poll verdict while installing: available wins outright; past the cap → failed. */
export function pollOutcome(available: boolean, elapsedMs: number): InstallPhase {
  if (available) return 'ready'
  return elapsedMs >= INSTALL_CAP_MS ? 'failed' : 'installing'
}

export function TmuxBanner({ onInstall }: { onInstall: (command: string) => void }): JSX.Element | null {
  const [status, setStatus] = useState<TmuxStatus | null>(null)
  const [dismissed, setDismissed] = useState(false)
  const [phase, setPhase] = useState<InstallPhase>('missing')
  const startedAtRef = useRef(0)

  useEffect(() => {
    let cancelled = false
    // Deliberately the LOCAL session, not useSession(): this banner is about THIS machine's tmux
    // (the host whose terminals lose continuity), never a relay tab's remote host.
    localSession.api.pty
      .tmuxStatus()
      .then((s) => {
        if (!cancelled) setStatus(s)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

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
        .catch(() => {})
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

  if (!status || dismissed || status.platform === 'win32') return null
  if (status.available && phase === 'missing') return null

  const title =
    phase === 'installing' ? 'Installing tmux' : phase === 'ready' ? 'tmux ready' : 'tmux not found'
  const body =
    phase === 'installing'
      ? 'Running the install in a terminal node — watch it for progress (it may ask for your password).'
      : phase === 'ready'
        ? 'New terminals will survive restarts from now on. Terminals opened before the install stay on the plain shell.'
        : phase === 'failed'
          ? 'The install hasn’t completed. Check the terminal node for errors, or install tmux with your package manager and restart nodeterm.'
          : status.installCommand
            ? 'Terminals won’t survive restarts and the mobile app can’t attach until tmux is installed.'
            : 'Terminals won’t survive restarts and the mobile app can’t attach. Install tmux with your package manager (e.g. brew install tmux), then restart nodeterm.'

  const showInstall = (phase === 'missing' || phase === 'failed') && !!status.installCommand
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
          title={status.installCommand!}
          onClick={() => {
            onInstall(status.installCommand!)
            startedAtRef.current = Date.now()
            setPhase('installing')
          }}
        >
          {phase === 'failed' ? 'Retry' : (status.installLabel ?? 'Install tmux')}
        </button>
      )}
      <button className="announce-banner__close" title="Dismiss" aria-label="Dismiss" onClick={() => setDismissed(true)}>
        <IconClose />
      </button>
    </div>
  )
}
