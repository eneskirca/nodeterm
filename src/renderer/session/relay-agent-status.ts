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

import type { NodeTerminalApi } from '@shared/types'
import type { AgentStatusSession } from '../state/agentStatus'
import { applyAgentEvent } from '../state/applyAgentEvent'

/** The Canvas sweep interval for the default store's stale-working decay. */
const SWEEP_MS = 60_000

export interface RelayAgentStatusDeps {
  /** Whether this window has focus. Default: `document.hasFocus()` (false without a document). */
  hasFocus?: () => boolean
  /** How often the stale-working sweep runs. Default 60 s, the Canvas interval. */
  sweepMs?: number
}

/** Subscribe `api.onAgentStatus` into `status` until the returned teardown runs. */
export function wireRelayAgentStatus(
  api: Pick<NodeTerminalApi, 'onAgentStatus'>,
  status: AgentStatusSession,
  deps: RelayAgentStatusDeps = {}
): () => void {
  const hasFocus = deps.hasFocus ?? (() => typeof document !== 'undefined' && document.hasFocus())
  const store = status.store
  // Set by the teardown. A frame the RpcClient delivers after the session went offline or was
  // disposed must write nothing, and neither may a sweep tick that was already queued.
  let disposed = false

  const unsubscribe = api.onAgentStatus((e) => {
    if (disposed) return
    const { nodeId, alert } = applyAgentEvent(store, null, e, { observationRemote: true })
    if (!alert) return
    // Canvas's `watching` gate: unread unless the user is actively in this node's terminal.
    const watching = hasFocus() && store.getState().activeId === nodeId
    if (!watching) store.getState().markUnread(nodeId)
  })

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
