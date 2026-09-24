import { useEffect, useRef } from 'react'
import { buildBackgroundLinkMaps, buildLinkMap } from '@shared/context-link-map'
import type { ContextLinkMap } from '@shared/types'
import { useProjects } from '../state/projects'
import { useAgentStatus } from '../state/agentStatus'
import { sessionForProject } from '../session/session'

export interface LiveContextLinks {
  // Capture the epoch DURING render, before the project-load effect changes its ref.
  projectId: string | null
  nodes: Array<{ id: string; type?: string; data: Record<string, unknown> }>
  edges: Array<{ source: string; target: string }>
}

/** Publish semantic changes, independent of drag/status render frequency. Subscriptions also
 * cover off-screen edits and sessions which start in a background project. Relay projects belong
 * to another core: never include their ids or transcript identities in the local authorization map.
 */
export function useContextLinkSync(live: LiveContextLinks): void {
  const latest = useRef(live)
  latest.current = live
  const publish = useRef<() => void>(() => {})

  useEffect(() => {
    let last = ''
    let pending: ReturnType<typeof setTimeout> | undefined
    const update = () => {
      const { projects, activeProjectId } = useProjects.getState()
      const local = projects.filter((p) => sessionForProject(p.id).api === window.nodeTerminal)
      const snapshot = latest.current
      const liveId = snapshot.projectId === activeProjectId &&
        local.some((p) => p.id === snapshot.projectId) ? snapshot.projectId : null
      const statuses = useAgentStatus.getState().byId
      const map: ContextLinkMap = buildBackgroundLinkMaps(
        local, liveId, (id) => statuses[id]?.sessionId, (id) => statuses[id]?.agentId
      )
      if (liveId) {
        const byId = new Map(snapshot.nodes.map((n) => [n.id, n]))
        const edges = snapshot.edges.filter((e) => byId.has(e.source) && byId.has(e.target))
        Object.assign(map, buildLinkMap(edges, (id) => {
          const n = byId.get(id)!
          const sticky = n.type === 'sticky'
          const agentId = n.type !== 'terminal' ? undefined : (
            n.data.agentId as string | undefined ??
            ((n.data.tags as string[] | undefined)?.includes('claude') ? 'claude' : undefined) ??
            statuses[id]?.agentId
          )
          return {
            id, title: n.data.title as string || id, cwd: n.data.cwd as string || '', sticky,
            note: sticky ? (n.data.text as string ?? '') : undefined,
            agentId, sessionId: agentId ? statuses[id]?.sessionId : undefined,
            accountId: sticky ? undefined : n.data.accountId as string | undefined
          }
        }))
      }
      const sig = JSON.stringify(map)
      if (sig === last) return
      last = sig
      void window.nodeTerminal.contextLink.setLinks(map).catch((error: unknown) => {
        // Permit the next update to retry this snapshot, without rolling back a newer one.
        if (last === sig) last = ''
        console.warn('[context-link] publish failed', error)
      })
    }
    // A fixed task boundary coalesces renders and hook bursts BEFORE rebuilding the workspace.
    // Never reset the timer: continuous drag/status traffic must not starve publication.
    const schedule = () => {
      if (pending !== undefined) return
      pending = setTimeout(() => { pending = undefined; update() }, 0)
    }
    publish.current = schedule
    const offProjects = useProjects.subscribe(schedule)
    const offStatus = useAgentStatus.subscribe(schedule)
    schedule()
    return () => {
      clearTimeout(pending)
      offProjects()
      offStatus()
      publish.current = () => {}
    }
  }, [])

  // No debounce tied to `nodes`: continuous node measurements used to cancel every write.
  useEffect(() => publish.current())
}
