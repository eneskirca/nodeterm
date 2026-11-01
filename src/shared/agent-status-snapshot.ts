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
}

/** At most this many entries, the newest by the mirror's `updatedAt`. */
export const AGENT_STATUS_SNAPSHOT_MAX = 2000
