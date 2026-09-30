/**
 * The renderer's two jobs for station-failure notices (src/core/agents/station-notice.ts):
 *
 *  1. MIRROR core's notice list into `useStationNotices` — the initial pull (a push that fired
 *     before this renderer loaded is otherwise lost) and every later push.
 *  2. REPORT the DROPPED verdict to core. It is the one trigger fact core cannot measure: telling a
 *     killed CLI from our own Eco exit or a Pause needs `hibernated`/`paused`, which live only in
 *     this renderer's agent-status store. Only the EDGES are sent (a verdict raised, a verdict
 *     withdrawn), so a store that re-renders on every hook event costs one map walk, not a message.
 *
 * Installed once, on the app's own api (`window.nodeTerminal`): the default agent-status store is
 * this machine's, and so are the stations core reports on.
 */
import type { NodeTerminalApi } from '@shared/types'
import { sanitizeStationNotices } from '@shared/station-notice'
import { useAgentStatus } from '../state/agentStatus'
import { useStationNotices } from '../state/stationNotices'

/** The DROPPED edges between two snapshots: ids whose verdict changed, with the new value. Pure,
 *  so the edge rule is testable without a store. */
export function droppedEdges(
  sent: ReadonlyMap<string, boolean>,
  byId: Readonly<Record<string, { dropped?: boolean } | undefined>>
): [string, boolean][] {
  const out: [string, boolean][] = []
  for (const [id, st] of Object.entries(byId)) {
    const now = st?.dropped === true
    if ((sent.get(id) ?? false) !== now) out.push([id, now])
  }
  // A node that left the store entirely while flagged: withdraw, so core does not hold a verdict
  // about a node nobody can see any more.
  for (const [id, was] of sent) if (was && !(id in byId)) out.push([id, false])
  return out
}

export function installStationNoticeWiring(
  api: Pick<NodeTerminalApi, 'stationNotice'>
): () => void {
  const setViews = (raw: unknown): void =>
    useStationNotices.getState().setViews(sanitizeStationNotices(raw))
  let live = true
  void api.stationNotice
    .list()
    .then((views) => {
      if (live) setViews(views)
    })
    .catch(() => undefined)
  const offChanged = api.stationNotice.onChanged((views) => setViews(views))

  const sent = new Map<string, boolean>()
  const report = (byId: Record<string, { dropped?: boolean } | undefined>): void => {
    for (const [id, dropped] of droppedEdges(sent, byId)) {
      if (dropped) sent.set(id, true)
      else sent.delete(id)
      api.stationNotice.reportDropped(id, dropped)
    }
  }
  report(useAgentStatus.getState().byId)
  const offStatus = useAgentStatus.subscribe((s, prev) => {
    if (s.byId !== prev.byId) report(s.byId)
  })
  return () => {
    live = false
    offChanged()
    offStatus()
  }
}
