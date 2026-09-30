// Drives the dev-port scans for the project on screen (CLAUDE.md → Dev-server ports). The cadence
// rules live in lib/devPorts.ts; this is only the wiring: mount, window focus, a debounced trailing
// scan after the project's agents report activity, and a slow poll while the window is focused.
import { useEffect } from 'react'
import { DEV_PORTS_HOOK_DEBOUNCE_MS, pollIntervalMs, scanWhileWatching } from '../lib/devPorts'
import { devPortsAvailable, scanDevPorts } from '../state/devPorts'
import { useAgentStatus } from '../state/agentStatus'
import { useProjects } from '../state/projects'
import { useSshConn } from '../state/sshConn'

/** Is someone looking? Read at FIRE time: a hook lull while the window is in the background must
 *  not become an exec on the host (the focus event re-scans when the person comes back). */
const watching = (): boolean =>
  scanWhileWatching(document.visibilityState === 'visible', document.hasFocus())

/**
 * @param terminalIdsSig the project's terminal node ids joined with `,` — a primitive, so a canvas
 *   edit that does not add or remove a terminal does not re-run the effects.
 */
export function useDevPortScanner(projectId: string, terminalIdsSig: string): void {
  const remote = useProjects((s) => !!s.getProject(projectId)?.ssh)
  const connected = useSshConn((s) => !!s.byProject[projectId])
  const eligible = !!terminalIdsSig && devPortsAvailable(projectId) && (!remote || connected)

  useEffect(() => {
    if (!eligible) return
    void scanDevPorts(projectId, remote, 'mount')
    const timer = setInterval(() => {
      if (watching()) void scanDevPorts(projectId, remote, 'poll')
    }, pollIntervalMs(remote))
    const onFocus = (): void => void scanDevPorts(projectId, remote, 'focus')
    window.addEventListener('focus', onFocus)
    return () => {
      clearInterval(timer)
      window.removeEventListener('focus', onFocus)
    }
  }, [eligible, projectId, remote])

  useEffect(() => {
    if (!eligible) return
    let debounce: ReturnType<typeof setTimeout> | null = null
    const onEvent = (): void => {
      if (debounce) clearTimeout(debounce)
      debounce = setTimeout(() => {
        debounce = null
        if (watching()) void scanDevPorts(projectId, remote, 'hook')
      }, DEV_PORTS_HOOK_DEBOUNCE_MS)
    }
    const subscribe = useAgentStatus.getState().onHookEvent
    const offs = terminalIdsSig.split(',').filter(Boolean).map((id) => subscribe(id, onEvent))
    return () => {
      if (debounce) clearTimeout(debounce)
      for (const off of offs) off()
    }
  }, [eligible, projectId, remote, terminalIdsSig])
}
