/**
 * `agent:status-snapshot` — the host's agent states as they stand, for a relay tab that joins late.
 *
 * A team tab only hears `agent:status` events from the moment it subscribes, so a node that went
 * `working` before the tab joined stayed blank until its next hook event (bug D). The joiner now
 * subscribes FIRST, then asks for this snapshot, and writes only the nodes no live event has touched.
 *
 * Built from the host's agent-status mirror (`core/agent-status-snapshot.ts`) and view-filtered for a
 * Viewer, Commenter or scoped guest by `sharedNode`, exactly like `agent:status` itself.
 */
import type { AgentId } from './agents/config'
import type { AgentState } from './agents/normalize'
import type { ObservedClaudeAccount } from './types'

export interface AgentStatusSnapshotEntry {
  nodeId: string
  /** Absent = unknown: identity-only (stateExpired) or restored from disk. */
  state?: AgentState
  agentId?: AgentId
  sessionId?: string
  account?: ObservedClaudeAccount
  /**
   * How long ago, in ms, the host last asserted `state` (host `Date.now() - updatedAt`, never below
   * 0). Present only with a `state`. An AGE rather than a timestamp, so no host clock value crosses
   * the wire and the two machines' clock skew never enters: the joiner subtracts it from its own
   * clock to get the freshness clock (`stateAt`) its stale-working sweep reads.
   */
  ageMs?: number
}

/** At most this many entries, the newest by the mirror's `updatedAt`. */
export const AGENT_STATUS_SNAPSHOT_MAX = 2000
