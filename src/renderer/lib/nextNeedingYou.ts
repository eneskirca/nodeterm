// "Go to next agent needing you" (`node.nextNeedingYou`): one chord to reach a waiting agent in
// another project, instead of opening the sidebar, finding the project and the row, and clicking.
//
// Pure, so the ordering and the cycle are unit-tested here (vitest runs in the node environment,
// no jsdom). Canvas calls this ON DEMAND, once per keypress or palette open, with a per-project
// lookup that reads the stores' current state (`lookupFromStores`) — it must NEVER subscribe to a
// status store's `byId` for this: every working/waiting flip would re-render the whole canvas (see
// `StatusAwareMiniMap`'s header in Canvas.tsx). Per project, because a team tab's agents live in
// its relay session's store, and a node id can be in two projects (bug D).

import type { AgentStatusLookup } from '../session/agent-status-lookup'
import { buildStatusList, type ProjectInput, type SessionNodeInput } from './sessionList'
import { nodeTravel, type TravelProject } from './presenceTravel'

export type NeedsYouProject = ProjectInput & TravelProject

/**
 * The node ids that need the user (`waiting` / `blocked` — the sidebar's "Need attention" section),
 * across projects, OLDEST first: the agent that has been waiting longest is the one to answer next.
 *
 * Membership is exactly the status-mode sidebar's (`buildStatusList` over the non-closed projects,
 * the same filter `SessionsSidebar` applies), so the command never disagrees with the list the user
 * can see. Order is a re-sort of a COPY: the sidebar's own section stays newest-first.
 *  - key: `statusUpdatedAt` ascending (the transition clock); an absent stamp sorts last, then
 *    project store order, then title, then id — a deterministic order so the cycle is stable.
 *  - a row whose project `nodeTravel` reports `blocked` (unreadable `.nodeterm` folder) is dropped:
 *    `travelToNode` silently refuses it, and leaving it in would stall the cycle on a dead stop.
 */
export function needsYouQueue(
  projects: readonly NeedsYouProject[],
  liveActiveNodes: SessionNodeInput[] | null,
  activeProjectId: string,
  statusFor: AgentStatusLookup
): string[] {
  const open = projects.filter((p) => !p.closed)
  const pidx = new Map(open.map((p, i) => [p.id, i]))
  const attention =
    buildStatusList(open, liveActiveNodes, activeProjectId, statusFor, '').find(
      (s) => s.kind === 'attention'
    )?.rows ?? []
  return attention
    .filter((r) => nodeTravel(projects, activeProjectId, r.id).kind !== 'blocked')
    .sort((a, b) => {
      const at = a.statusUpdatedAt ?? Number.POSITIVE_INFINITY
      const bt = b.statusUpdatedAt ?? Number.POSITIVE_INFINITY
      if (at !== bt) return at < bt ? -1 : 1
      const ap = pidx.get(a.projectId ?? '') ?? Number.MAX_SAFE_INTEGER
      const bp = pidx.get(b.projectId ?? '') ?? Number.MAX_SAFE_INTEGER
      if (ap !== bp) return ap - bp
      const byTitle = a.title.toLowerCase().localeCompare(b.title.toLowerCase())
      if (byTitle !== 0) return byTitle
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
    })
    .map((r) => r.id)
}

/**
 * Agents the queue cannot claim but the user may expect to find in it: live state UNKNOWN (no hook
 * event since the app started) with a restored `lastSeen` clock that last said `waiting` or
 * `blocked`. Right after a restart that is every agent still sitting at its prompt — it sends no
 * new hook until answered — so the honest empty-queue answer counts them rather than saying no
 * agent is waiting. Same membership as `needsYouQueue` (non-closed projects, travelable rows).
 */
export function waitingBeforeRestart(
  projects: readonly NeedsYouProject[],
  liveActiveNodes: SessionNodeInput[] | null,
  activeProjectId: string,
  statusFor: AgentStatusLookup
): number {
  const open = projects.filter((p) => !p.closed)
  return buildStatusList(open, liveActiveNodes, activeProjectId, statusFor, '')
    .flatMap((s) => s.rows)
    .filter(
      (r) =>
        r.statusKind === 'unknown' &&
        r.statusClock === 'restored' &&
        (r.lastSeenState === 'waiting' || r.lastSeenState === 'blocked') &&
        nodeTravel(projects, activeProjectId, r.id).kind !== 'blocked'
    ).length
}

/** The notice for an empty queue; `beforeRestart` is `waitingBeforeRestart`'s count. */
export function noAgentWaitingNotice(beforeRestart: number): string {
  if (beforeRestart === 0) return 'No agent is waiting for you.'
  const verb = beforeRestart === 1 ? 'was' : 'were'
  return `No agent has reported waiting since the restart (${beforeRestart} ${verb} waiting before it).`
}

/**
 * The next stop in the cycle.
 *  - `cursor` is the node this command last travelled to (Canvas keeps it in memory only — a ref,
 *    never persisted). The pick is the entry AFTER it, wrapping to the oldest.
 *  - A cursor no longer in the queue (that agent was answered) restarts at the oldest: the queue
 *    is re-read on every press, so "oldest still waiting" is the right next stop.
 *  - `currentNodeId` (the terminal the user is focused in) is skipped when anything else waits:
 *    the first press from inside the oldest waiting agent must not be a visible no-op.
 *  - `null` when nothing needs the user.
 */
export function nextNeedingYou(
  queue: readonly string[],
  cursor: string | null,
  currentNodeId: string | null
): string | null {
  if (queue.length === 0) return null
  const at = cursor === null ? -1 : queue.indexOf(cursor)
  let next = (at + 1) % queue.length
  if (queue[next] === currentNodeId && queue.length > 1) next = (next + 1) % queue.length
  return queue[next]
}
