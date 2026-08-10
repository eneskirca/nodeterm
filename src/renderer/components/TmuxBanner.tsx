import { useEffect, useRef, useState } from 'react'
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
// terminals tmux-backed without a restart. Hidden on any fetch error (fail-open).
//
// It used to be hidden on win32 outright, because there was nothing to say: Windows has no tmux
// and `tmuxInstall` had no command for it. That made Windows the ONE platform where the silent
// degrade this banner exists to expose was itself invisible. psmux (a tmux-compatible multiplexer,
// installable via winget) gives win32 both an answer and a button, so the platform gate is gone —
// `status.available` already hides the banner wherever a multiplexer is present.

export const INSTALL_POLL_MS = 3000
export const INSTALL_CAP_MS = 5 * 60_000
export const READY_HIDE_MS = 6000

export type InstallPhase = 'missing' | 'installing' | 'ready' | 'failed'

/** Poll verdict while installing: available wins outright; past the cap → failed. */
export function pollOutcome(available: boolean, elapsedMs: number): InstallPhase {
  if (available) return 'ready'
  return elapsedMs >= INSTALL_CAP_MS ? 'failed' : 'installing'
}

/** What the multiplexer is CALLED on this host. `tmux` is the reference implementation and its own
 *  name wherever it ships; it ships no Windows build, and the thing this banner offers there is
 *  psmux — so naming it tmux on win32 would send the user looking for a package they cannot get.
 *  Only the NAME differs: every behaviour described below is the same on both. */
export function multiplexerName(platform: string): string {
  return platform === 'win32' ? 'psmux' : 'tmux'
}

/**
 * Title + body for a phase. Pure, and split out of the component for exactly one reason: the
 * strings are now platform-dependent and the no-installer fallback is the branch that used to be
 * WRONG on Windows. It advised `brew install tmux` — a package manager macOS-only by construction,
 * naming a package with no Windows build — and it became reachable there the moment the win32 gate
 * above was removed. That branch means "no one-click install exists here", which on Windows is
 * specifically "winget was not found", not "use your package manager".
 */
export function bannerCopy(
  phase: InstallPhase,
  platform: string,
  hasInstallCommand: boolean
): { title: string; body: string } {
  const name = multiplexerName(platform)
  const win = platform === 'win32'
  if (phase === 'installing')
    return {
      title: `Installing ${name}`,
      body: 'Running the install in a terminal node — watch it for progress (it may ask for your password).'
    }
  if (phase === 'ready')
    return {
      title: `${name} ready`,
      body: 'New terminals will survive restarts from now on. Terminals opened before the install stay on the plain shell.'
    }
  const title = `${name} not found`
  if (phase === 'failed')
    return {
      title,
      body: win
        ? 'The install hasn’t completed. Check the terminal node for errors, or install psmux manually and restart nodeterm.'
        : 'The install hasn’t completed. Check the terminal node for errors, or install tmux with your package manager and restart nodeterm.'
    }
  if (hasInstallCommand)
    return {
      title,
      body: `Terminals won’t survive restarts and the mobile app can’t attach until ${name} is installed.`
    }
  return {
    title,
    body: win
      ? // No winget, so there is no command to offer — and no honest one-liner to print either.
        // Say what is missing and stop, rather than inventing an install path we did not verify.
        'Terminals won’t survive restarts and the mobile app can’t attach. winget wasn’t found, so there is no one-click install — install psmux (a tmux-compatible multiplexer for Windows) and restart nodeterm.'
      : 'Terminals won’t survive restarts and the mobile app can’t attach. Install tmux with your package manager (e.g. brew install tmux), then restart nodeterm.'
  }
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

  if (!status || dismissed) return null
  if (status.available && phase === 'missing') return null

  const { title, body } = bannerCopy(phase, status.platform, !!status.installCommand)

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
      <button className="announce-banner__close" title="Dismiss" onClick={() => setDismissed(true)}>
        ✕
      </button>
    </div>
  )
}
