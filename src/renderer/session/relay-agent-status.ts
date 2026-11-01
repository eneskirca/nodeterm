// wireRelayAgentStatus — a relay session's own subscription to its host's agent status (bug D).
//
// A team tab (a desktop joined to a Server Edition team, or a Team Access relay tab) never showed
// RUNNING / NEEDS YOU / unread: the only `agent:status` subscriber was Canvas's listener on the LOCAL
// api, writing the DEFAULT store. Each relay session now subscribes ITS OWN api's `onAgentStatus`
// for the session's lifetime and feeds the same reducer Canvas uses (`applyAgentEvent`) into the
// session's own keyless store (`getSessionStores(id).agentStatus`). Routing is by api, never by a
// project lookup: two relay sessions may serve the same project id.
//
// What the relay path deliberately does NOT do, compared with Canvas's listener:
//  • no ack — reading a remote session's finish clears unread on this desktop only; nothing is sent
//    back to the host (no `ackDone`, no `agent:unread-clear` subscription);
//  • no sound and no OS notification — the badge and the unread dot are the whole signal;
//  • no subagent cards (`nodes = null`) and no `onSubagentActivity` subscription.
// What it keeps: the unread mark for BOTH alert kinds unless this window is focused on that node
// (Canvas's `watching` rule), and the 60 s stale-working sweep, run on this session's store.
//
// A tab that joins after the host already saw events would start blank, since state events are
// not replayed. So right AFTER subscribing it asks the host for `agent:status-snapshot` (the host's
// mirror, narrowed to the shared nodes for a non-editor) and writes the entries no live event has
// touched in the meantime (`applyAgentStatusSnapshot`). A host without the channel rejects; the tab
// then simply starts from the live events, as before.

import type { StoreApi } from 'zustand'
import type { AgentStatusSnapshotEntry } from '@shared/agent-status-snapshot'
import type { NodeTerminalApi } from '@shared/types'
import { isSafeNodeId } from '@shared/safe-id'
import type { AgentNodeStatus, AgentStatusSession, AgentStatusStore } from '../state/agentStatus'
import { applyAgentEvent } from '../state/applyAgentEvent'

/** The Canvas sweep interval for the default store's stale-working decay. */
const SWEEP_MS = 60_000

/**
 * Is this host-sent node id one this tab may use as a key of its `byId` table? Every relay write
 * (a live event and a snapshot entry alike) passes through this first, and anything it refuses is
 * dropped whole.
 *
 * `isSafeNodeId` alone is not enough here: its charset admits `__proto__` and `constructor`, and so
 * does every other name `Object.prototype` owns (`toString`, `hasOwnProperty`, …). Looked up on a
 * plain object, such a name answers the PROTOTYPE's value when the table has no own entry, and the
 * store's same-state fast path then writes into that value in place: one host frame
 * `{kind:'session', nodeId:'__proto__', sessionPhase:'end'}` defined `stateAt`, `lastSeen` and
 * `stateVerified` on `Object.prototype` for the whole renderer (every status entry then inherited a
 * `lastSeen`, which the default store's clock save writes to disk), and `constructor` did the same
 * to `Object`. No id the app mints is one of those names, so refusing them costs a real node
 * nothing. The host is another machine, so its ids are input, never trusted.
 */
export function isHostNodeId(nodeId: unknown): nodeId is string {
  return typeof nodeId === 'string' && isSafeNodeId(nodeId) && !Object.hasOwn(Object.prototype, nodeId)
}

export interface RelayAgentStatusDeps {
  /** Whether this window has focus. Default: `document.hasFocus()` (false without a document). */
  hasFocus?: () => boolean
  /** How often the stale-working sweep runs. Default 60 s, the Canvas interval. */
  sweepMs?: number
}

/**
 * Write the entries no live event has touched; never stamps a TRANSITION clock. Returns how many it
 * wrote. `now` is this machine's clock. An entry whose node id `isHostNodeId` refuses is skipped.
 *
 * One `setState` for the whole snapshot. Each entry merges only the fields it carries (`state`,
 * `agentId`, `sessionId`, `account`) onto whatever the node already has, so an identity-only entry
 * (no `state`) leaves the state alone and `unread` is kept (default `false`). The account is
 * recorded as another machine's (`remote: true`), exactly as the live relay events record it.
 *
 * The clocks, which are not alike:
 *  • `stateAt` (freshness: when the state was last ASSERTED, which the stale-working sweep reads) is
 *    set for an entry that carries a `state`, to `now - ageMs`. The age is the host's measurement of
 *    its own mirror entry, so no host clock value is involved, and a negative or missing age counts
 *    as 0, never as a time ahead of this one. Without it the sweep reads a missing `stateAt` as 0
 *    and decays a served `working` on its first tick, although the host still holds it live (its
 *    mirror expires stale states itself).
 *  • `lastEventAt` (the transition clock, the sidebar's sort key and the Eco idle clock) and
 *    `lastSeen` (the persisted last-hook record) are NEVER set: the joiner saw no transition, and a
 *    fabricated one would claim it did. The sidebar sorts a missing clock last.
 * An entry without a `state` sets no `stateAt`: it describes no state to be fresh about.
 */
export function applyAgentStatusSnapshot(
  status: Pick<StoreApi<AgentStatusStore>, 'getState' | 'setState'>,
  entries: readonly AgentStatusSnapshotEntry[],
  liveSeen: ReadonlySet<string>,
  now: number = Date.now()
): number {
  if (!Array.isArray(entries)) return 0
  const prev = status.getState().byId
  // Collected as pairs and built with `Object.fromEntries`, which defines own properties: a node id
  // is the host's string, and an assignment to `byId['__proto__']` would set a prototype instead.
  const writes = new Map<string, AgentNodeStatus>()
  for (const entry of entries) {
    const nodeId = entry?.nodeId
    if (!isHostNodeId(nodeId) || liveSeen.has(nodeId)) continue
    const existing = writes.get(nodeId) ?? (Object.hasOwn(prev, nodeId) ? prev[nodeId] : undefined)
    const merged: AgentNodeStatus = { ...existing, unread: existing?.unread ?? false }
    if (entry.state !== undefined) {
      merged.state = entry.state
      const age = entry.ageMs
      merged.stateAt = now - (typeof age === 'number' && Number.isFinite(age) && age > 0 ? age : 0)
    }
    if (entry.agentId !== undefined) merged.agentId = entry.agentId
    if (entry.sessionId !== undefined) merged.sessionId = entry.sessionId
    if (entry.account !== undefined) merged.account = { ...entry.account, remote: true }
    writes.set(nodeId, merged)
  }
  if (writes.size > 0) status.setState({ byId: Object.fromEntries([...Object.entries(prev), ...writes]) })
  return writes.size
}

/** Subscribe `api.onAgentStatus` into `status` until the returned teardown runs, then ask the host
 *  for the states it already holds (`agentStatusSnapshot`). */
export function wireRelayAgentStatus(
  api: Pick<NodeTerminalApi, 'onAgentStatus' | 'agentStatusSnapshot'>,
  status: AgentStatusSession,
  deps: RelayAgentStatusDeps = {}
): () => void {
  const hasFocus = deps.hasFocus ?? (() => typeof document !== 'undefined' && document.hasFocus())
  const store = status.store
  // Set by the teardown. A frame the RpcClient delivers after the session went offline or was
  // disposed must write nothing, and neither may a sweep tick that was already queued, nor a
  // snapshot answered after it.
  let disposed = false
  // Every node a live event touched before the snapshot landed: its live state is newer than (or
  // as new as) anything the snapshot says, so the snapshot leaves it alone. Subagent events are not
  // counted: they carry no state, and onAgentStatus replays the host's running subagents into this
  // same listener at subscribe time, which would otherwise hold exactly the busiest nodes blank.
  const liveSeen = new Set<string>()

  const unsubscribe = api.onAgentStatus((e) => {
    if (disposed) return
    // Before anything touches a table keyed by it (see `isHostNodeId`).
    if (!isHostNodeId(e?.nodeId)) return
    if (e.kind !== 'subagent-start' && e.kind !== 'subagent-end') liveSeen.add(e.nodeId)
    const { nodeId, alert } = applyAgentEvent(store, null, e, { observationRemote: true })
    if (!alert) return
    // Canvas's `watching` gate: unread unless the user is actively in this node's terminal.
    const watching = hasFocus() && store.getState().activeId === nodeId
    if (!watching) store.getState().markUnread(nodeId)
  })

  // After subscribing, so no event falls between the snapshot and the stream.
  api.agentStatusSnapshot().then(
    (entries) => {
      if (!disposed) applyAgentStatusSnapshot(store, entries, liveSeen)
    },
    (err: unknown) => {
      // An older host has no handler: start from the live events alone, as before. A rejection
      // after teardown (the carrier closed under the request) is the session ending, not news.
      if (!disposed) console.warn('[relay] agent:status-snapshot unavailable; starting from live events only', err)
    }
  )

  const sweep = setInterval(() => {
    if (!disposed) store.getState().sweepStaleWorking()
  }, deps.sweepMs ?? SWEEP_MS)

  return () => {
    if (disposed) return
    disposed = true
    unsubscribe()
    clearInterval(sweep)
    // An offline or disposed tab reads unknown: its status described a host it no longer hears.
    store.setState({ byId: {}, activeId: null })
  }
}
