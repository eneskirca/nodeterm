import { useMemo } from 'react'
import { useAgentStatus } from './agentStatus'
import { usePendingPause } from './pendingPause'

export interface PauseCount {
  paused: number
  pending: number
}

/** Per-project PAUSED and pending-pause counts, for the tab badge and the "Cancel pending pauses"
 *  row. A project with neither is absent, so the caller's `?? 0` reads as "nothing to show". */
export function pauseCountsFor(
  projects: readonly { id: string; nodes: readonly { id: string }[] }[],
  pausedIds: ReadonlySet<string>,
  pendingIds: ReadonlySet<string>
): Record<string, PauseCount> {
  const out: Record<string, PauseCount> = {}
  if (pausedIds.size === 0 && pendingIds.size === 0) return out
  for (const p of projects) {
    let paused = 0
    let pending = 0
    for (const n of p.nodes) {
      if (pausedIds.has(n.id)) paused++
      if (pendingIds.has(n.id)) pending++
    }
    if (paused || pending) out[p.id] = { paused, pending }
  }
  return out
}

const split = (sig: string): Set<string> => new Set(sig.split('|').filter(Boolean))

/**
 * The counts, subscribed through two PRIMITIVE signatures (the paused id set, the pending id set)
 * rather than the whole status map: a hook event that changes nothing here re-renders nothing.
 * The caller supplies the projects it already holds.
 */
export function usePauseCounts(
  projects: readonly { id: string; nodes: readonly { id: string }[] }[]
): Record<string, PauseCount> {
  const pausedSig = useAgentStatus((s) => {
    let ids = ''
    for (const [id, st] of Object.entries(s.byId)) if (st?.paused) ids += `${id}|`
    return ids
  })
  const pendingSig = usePendingPause((s) => Object.keys(s.byId).join('|'))
  return useMemo(
    () => pauseCountsFor(projects, split(pausedSig), split(pendingSig)),
    [projects, pausedSig, pendingSig]
  )
}
