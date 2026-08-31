import type { AgentId } from './config'
import type { AgentState } from './normalize'

/**
 * Display-only status remembered by the core across app restarts.
 *
 * This is deliberately weaker than a live hook event: it carries no verification, approval
 * ticket, unread transition, or liveness claim. Consumers may use it to restore workflow context
 * in the UI, but never to authorize delivery, notify, or decide that a process is safe to stop.
 */
export interface AgentStatusSnapshotEntry {
  state?: AgentState
  agentId?: AgentId
  sessionId?: string
  name?: string
  /** When this node entered `state` (not when that state was most recently re-asserted). */
  changedAt: number
}

export type AgentStatusSnapshot = Record<string, AgentStatusSnapshotEntry>
