import { useEffect, useState } from 'react'
import type { TmuxStatus } from '@shared/types'
import { localSession } from '../session/localSession'
import { useSettings } from '../state/settings'

/** Always the local core (the server in a browser), never the selected relay host. */
export function usePersistenceStatus(): TmuxStatus | null | undefined {
  const enabled = useSettings((s) => s.settings.tmuxEnabled)
  // The backend choice changes what the core reports; re-read at once rather than in up to 15 s.
  const backend = useSettings((s) => s.settings.sessionBackend)
  const [status, setStatus] = useState<TmuxStatus | null>()
  useEffect(() => {
    let cancelled = false
    const refresh = async (): Promise<void> => {
      try {
        const next = await localSession.api.pty.tmuxStatus()
        if (!cancelled) setStatus(next)
      } catch {
        if (!cancelled) setStatus(null)
      }
    }
    void refresh()
    // Settings saves are coalesced for 300 ms; re-read after that write as well.
    const settled = setTimeout(() => void refresh(), 1000)
    const timer = setInterval(() => void refresh(), 15_000)
    return () => {
      cancelled = true
      clearInterval(timer)
      clearTimeout(settled)
    }
  }, [enabled, backend])
  return status
}

export function persistenceDescription(status: TmuxStatus | null | undefined): string {
  if (status === undefined) return 'Checking session protection…'
  const p = status?.persistence
  if (!p) return 'Session protection could not be checked. Continuity is not confirmed.'
  if (!p.enabled) return 'Session protection is off for new local terminals. They will not survive an app or server restart.'
  if (!p.backend) return 'No session protection backend was found. New local terminals will not survive an app or server restart.'
  const name = p.backend === 'tmux' ? 'tmux' : p.backend === 'zellij' ? 'Zellij' : 'Session host'
  return `${name} is available for new local terminals. Existing plain-shell terminals are not upgraded; runtime startup can still fail.`
}

/**
 * The Session backend row's sentence. The setting only decides where a NEW local terminal is
 * created, so each branch says what actually happens next — including the fallback when Zellij is
 * selected but no binary was found, which must not read as applied.
 */
export function sessionBackendNote(z: {
  available: boolean
  selected: boolean
  socketTooLong?: boolean
}): string {
  if (z.selected && z.available && z.socketTooLong)
    return 'Zellij is selected, but its socket path on this machine is longer than the system allows (Zellij refuses to start there) — new local terminals use tmux. Setting a short XDG_RUNTIME_DIR or ZELLIJ_SOCKET_DIR for the app fixes it.'
  if (z.selected && !z.available)
    return 'Zellij is selected but was not found on this machine — new local terminals use tmux until it is installed.'
  if (z.selected)
    return 'New local terminals open in a Zellij session (attach from any terminal with `zellij attach nt-<node id>`). Terminals already running keep their current backend.'
  return z.available
    ? 'New local terminals open in tmux. Zellij is also available here. Terminals already running keep their current backend.'
    : 'New local terminals open in tmux. Install Zellij to choose it instead.'
}
