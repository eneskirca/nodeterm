import type { SshConnection } from '../shared/ssh'
import { sshHostKey } from '../shared/ssh'

/**
 * WHERE a node's session lives, answered WITHOUT a live client.
 *
 * The whole point of this module. `PtyManager` used to decide "is this node remote?" from the
 * in-memory `Session` object alone, and a delete arrives precisely when there may be no session:
 * after an app restart, after the offscreen release disposed the client, after the park timer ran
 * out, or for a node whose project is not even open. The answer was then `undefined` — read as
 * "local" — so the remote kill was skipped in silence and the one kill that went out went to the
 * LOCAL tmux socket, where a `requireRemote` node has nothing at all. The node left the canvas and
 * its `nt-<id>` kept running on the host, with nothing anywhere saying so.
 *
 * The durable answer is the machine-local project index (`workspaceStore.sshProjectIdForNode`),
 * which knows a node's owning SSH project whether or not anything is attached to it. The shell
 * wires that in as `RemoteNodeOwnerResolver`; the Server Edition wires none (it has no SSH-project
 * manager) and therefore keeps the local-only behaviour it already had.
 */
export interface RemoteNodeOwner {
  /** The SSH project this node belongs to, per the persisted index. */
  projectId: string
  /**
   * `user@host` for that project. Keyed on separately from `projectId` because the DEBT below is
   * settled per host, not per project: several projects share one host's `$HOME` and one tmux
   * server, and a host reached again through any of them can pay off every session owed on it.
   */
  hostKey: string
  /** The live ControlMaster, when the project is currently connected. Absent ⇒ nothing to send on. */
  remote?: { conn: SshConnection; controlPath: string }
}

/** Sync on purpose: `runEndSession` captures its remote answer BEFORE its first await, exactly as
 *  it always captured `dying.sshRemote`, so a connect/disconnect mid-teardown cannot change it
 *  underneath the branch that already committed to it. */
export type RemoteNodeOwnerResolver = (nodeId: string) => RemoteNodeOwner | null

/** Why a remote kill could not be sent. Recorded verbatim so the debt says what happened. */
export type RemoteEndDeferReason =
  /** The owning project has no ControlMaster right now (host down, network gone, never connected). */
  | 'not-connected'
  /** No `ssh` on this machine. Nothing can reach the host from here, now or later. */
  | 'no-ssh'

export type RemoteEndPlan =
  /** Not a remote node: the local path runs exactly as it always did. */
  | { kind: 'none' }
  | {
      kind: 'deliver'
      ssh: string
      conn: SshConnection
      controlPath: string
      hostKey: string
      projectId?: string
    }
  | { kind: 'defer'; reason: RemoteEndDeferReason; hostKey: string; projectId?: string }

/**
 * Decide what ending a node owes the remote host.
 *
 * Pure so the matrix — and specifically the four ways a node can be remote with nothing live — is
 * provable without a tmux server, an ssh binary or a socket.
 *
 * `live` (the dying `Session.sshRemote`) still wins when it is there: it is the exact handle the
 * session was actually spawned over, so it can never disagree with itself. The resolver is the
 * FALLBACK, not a replacement — a node created seconds ago may not be in the index cache yet, and
 * for that node the live handle is the only truth there is.
 */
export function planRemoteEnd(args: {
  live: { conn: SshConnection; controlPath: string } | undefined
  owner: RemoteNodeOwner | null
  ssh: string | null
}): RemoteEndPlan {
  const { live, owner, ssh } = args
  const target = live ?? owner?.remote
  const hostKey = live ? sshHostKey(live.conn) : owner?.hostKey
  // Neither a live remote session nor a persisted remote owner: a local node, and this module has
  // no opinion about it. Byte-identical to the pre-fix path.
  if (!target && !owner) return { kind: 'none' }
  // `hostKey` is only unknown when there is no owner AND no live conn, which the line above
  // already returned on. The fallback keeps the type honest without inventing a host name.
  const host = hostKey ?? ''
  if (!ssh) return { kind: 'defer', reason: 'no-ssh', hostKey: host, projectId: owner?.projectId }
  if (!target)
    return { kind: 'defer', reason: 'not-connected', hostKey: host, projectId: owner?.projectId }
  return {
    kind: 'deliver',
    ssh,
    conn: target.conn,
    controlPath: target.controlPath,
    hostKey: host,
    projectId: owner?.projectId
  }
}
