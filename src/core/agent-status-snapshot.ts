// `agent:status-snapshot` — the host's agent states as they stand, read off the agent-status mirror
// for a relay tab that joins after the host already saw events (bug D). Registered by BOTH shells;
// the response is narrowed for a non-editor by `narrowResponseForRole` (relay/access-policy.ts).
import { AGENT_STATUS_SNAPSHOT_MAX, type AgentStatusSnapshotEntry } from '../shared/agent-status-snapshot'
import { IPC } from '../shared/ipc'
import { mirrorEntries, type MirrorEntry } from './agent-status-mirror'
import type { CorePlatform } from './platform'

/**
 * The snapshot of `entries`: the newest `AGENT_STATUS_SNAPSHOT_MAX` by `updatedAt`, each reduced to
 * the fields a joiner's store takes. Pure.
 *
 * `state` is left out for an identity-only entry (`stateExpired`) and for one restored from disk
 * (`restored`): neither is an observation made this run, and a joiner shown a 6-hour-old `working`
 * would read it as live. Their identity (agent, session, account) still travels — that is what lets
 * the joiner's chat view and account chip find the node's session.
 */
export function buildAgentStatusSnapshot(
  entries: Iterable<readonly [string, Readonly<MirrorEntry>]>
): AgentStatusSnapshotEntry[] {
  const sorted = [...entries].sort((a, b) => b[1].updatedAt - a[1].updatedAt).slice(0, AGENT_STATUS_SNAPSHOT_MAX)
  return sorted.map(([nodeId, e]) => {
    const out: AgentStatusSnapshotEntry = { nodeId }
    if (e.state !== undefined && !e.stateExpired && !e.restored) out.state = e.state
    if (e.agentId !== undefined) out.agentId = e.agentId
    if (e.sessionId !== undefined) out.sessionId = e.sessionId
    if (e.account !== undefined) out.account = e.account
    return out
  })
}

/** Serve `agent:status-snapshot` on `platform`; `read` defaults to the live mirror. */
export function registerAgentStatusSnapshotIpc(
  platform: CorePlatform,
  read: () => AgentStatusSnapshotEntry[] = () => buildAgentStatusSnapshot(mirrorEntries())
): void {
  // No arguments: a peer's are ignored rather than handed to `read`.
  platform.handle(IPC.agentStatusSnapshot, () => read())
}
