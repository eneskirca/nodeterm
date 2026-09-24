import { useEffect, useState } from 'react'
import type { TmuxStatus } from '@shared/types'
import { localSession } from '../session/localSession'
import { useSettings } from '../state/settings'

/** Always the local core (the server in a browser), never the selected relay host. */
export function usePersistenceStatus(): TmuxStatus | null | undefined {
  const enabled = useSettings((s) => s.settings.tmuxEnabled)
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
  }, [enabled])
  return status
}

export function persistenceDescription(status: TmuxStatus | null | undefined): string {
  if (status === undefined) return 'Checking session protection…'
  const p = status?.persistence
  if (!p) return 'Session protection could not be checked. Continuity is not confirmed.'
  if (!p.enabled) return 'Session protection is off for new local terminals. They will not survive an app or server restart.'
  if (!p.backend) return 'No session protection backend was found. New local terminals will not survive an app or server restart.'
  return `${p.backend === 'tmux' ? 'tmux' : 'Session host'} is available for new local terminals. Existing plain-shell terminals are not upgraded; runtime startup can still fail.`
}
