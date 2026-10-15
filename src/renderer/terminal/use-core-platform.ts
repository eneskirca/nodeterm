import { useContext, useEffect, useState } from 'react'
import { SessionContext } from '../session/session'
import { hostPlatformFor } from './host-platform'

/**
 * Whether the core that owns the current session runs on Windows — the core's `process.platform`
 * (via `hostPlatformFor`), never the viewer's: a browser on a Mac can be driving a Windows Server
 * Edition, and a relay tab's core is another machine. Unknown (no session, read failed, not answered
 * yet) reads `false`, so a gate built on it never hides anything on a guess.
 */
export function useCoreIsWindows(): boolean {
  const api = useContext(SessionContext)?.api
  const [win, setWin] = useState(false)
  useEffect(() => {
    if (!api) {
      setWin(false)
      return
    }
    let live = true
    void hostPlatformFor(api).then((p) => {
      if (live) setWin(p === 'win32')
    })
    return () => {
      live = false
    }
  }, [api])
  return win
}
