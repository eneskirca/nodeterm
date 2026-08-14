import { sshConnectionIdForProject, sshHostKey, type SshConnection } from '@shared/ssh'
import { useSshConn, type SshAttachment, type SshConnInfo } from '../state/sshConn'

/** One host a project's canvas has REMOTE nodes on, other than the project's own endpoint. */
export interface HostAttachment {
  /** Connection scope: `sshAttachmentId(projectId, conn)`. Keys `useSshConn`, the ControlMaster,
   *  and the reconnect loop, exactly as an SSH project's id does for its own nodes. */
  scopeId: string
  /** `user@host` — the machine, ignoring port/identity (same remote `$HOME`). */
  hostKey: string
  conn: SshConnection
  /** The cwd the connection itself is opened with (the Explorer/scp base). The individual nodes
   *  still spawn in their OWN `cwd`; this is the first attached node's, as the representative. */
  remoteCwd?: string
  /** Node ids on this host — the connect banner and the reconnect flush work per scope. */
  nodeIds: string[]
}

/** The subset of a persisted canvas node this needs. Deliberately structural: the caller passes
 *  either persisted node states or live React Flow `data`, and both satisfy it. */
export interface AttachableNode {
  id: string
  ssh?: SshConnection
  sshRemoteTmux?: boolean
  cwd?: string
}

/**
 * Which host attachments a project's canvas needs opened.
 *
 * A remote node whose endpoint IS the project's own is served by the project's ControlMaster and
 * is not listed — that is main's whole model, and it stays untouched. Everything else is an
 * attachment: every remote node on a LOCAL project, and a node pointed at a second host inside an
 * SSH project. Grouped by scope, so one master serves every node on the same machine.
 *
 * `sshRemoteTmux` is required: a plain `ssh <host>` node (`createSshTerminalNode`) runs ssh as its
 * own local PTY program and needs no master at all — opening one for it would be a connection the
 * user never asked for.
 */
export function hostAttachmentsFor(
  projectId: string,
  nodes: readonly AttachableNode[],
  projectServer?: SshConnection
): HostAttachment[] {
  const byScope = new Map<string, HostAttachment>()
  for (const node of nodes) {
    const conn = node.ssh
    if (!conn || !node.sshRemoteTmux) continue
    const scopeId = sshConnectionIdForProject(projectId, conn, projectServer)
    if (scopeId === projectId) continue // the project's own master already serves this node
    const existing = byScope.get(scopeId)
    if (existing) existing.nodeIds.push(node.id)
    else
      byScope.set(scopeId, {
        scopeId,
        hostKey: sshHostKey(conn),
        conn,
        remoteCwd: node.cwd,
        nodeIds: [node.id]
      })
  }
  return [...byScope.values()]
}

/** `window.nodeTerminal.sshProject.connect`, injected so this is testable without Electron. */
export type SshConnectFn = (
  scopeId: string,
  conn: SshConnection,
  remoteCwd?: string
) => Promise<SshConnInfo>

/** Dials in flight, keyed by scope: several nodes on one machine must produce ONE connect. */
const dialing = new Map<string, Promise<boolean>>()

/**
 * Ensure an attachment's ControlMaster is up, and make sure the scope is REACHABLE either way.
 *
 * Three orderings this gets right, each of which was a live bug:
 *
 * 1. The attachment is registered BEFORE the dial. A first connect that fails is exactly what the
 *    reconnect coordinator is for, and its `connect` dep has nowhere else to learn the endpoint —
 *    recording on success only left a cold load against a sleeping host permanently offline, the
 *    offline overlay's Reconnect included.
 * 2. Also before the dial, because main emits `status:'connected'` from inside its connect — over
 *    the same IPC pipe, so it ARRIVES BEFORE the invoke reply. The reconnector's `onConnected`
 *    then maps scope → owning canvas through `ownerProjectId`, and a record written afterwards is
 *    written too late: the respawn takes the "switched away" branch and never bumps the nonce.
 * 3. Concurrent callers share one dial. Every node on a machine calls this at spawn; without the
 *    in-flight map they would each open a master.
 *
 * It ALWAYS dials — a cached `controlPath` is deliberately not treated as "already connected".
 * Nothing in the renderer clears that path when a connection drops, so a short-circuit on it made
 * the reconnect coordinator a permanent no-op for attachments: after one successful connect it
 * would answer `true` forever, and a sleep/wake respawn would run its pty against a dead socket
 * under `ControlMaster=auto`, which silently falls back to a DIRECT connection per node — the
 * ~72k-logins/day pattern documented on `SshProjectManager.startWatchdog`. Main is the thing that
 * knows whether the master is alive: its connect coalesces per scope and reuse costs one mux'd
 * `-O check`, which doubles as the keepalive that resets the ControlPersist counter. A redundant
 * dial through main is cheap and self-healing; a skipped one is the failure above.
 */
export function connectHostAttachment(
  scopeId: string,
  attachment: SshAttachment,
  connect: SshConnectFn,
  disconnect?: (scopeId: string) => Promise<unknown>
): Promise<boolean> {
  useSshConn.getState().registerAttachment(scopeId, attachment)
  const inFlight = dialing.get(scopeId)
  if (inFlight) return inFlight
  const attempt = connect(scopeId, attachment.conn, attachment.remoteCwd)
    .then((info) => {
      // The canvas was deleted while we were dialing: its teardown pass already ran, and writing
      // the connection back now would resurrect a scope nothing owns — a live master that no
      // delete path will ever visit again. Hand it straight back instead.
      if (!useSshConn.getState().getAttachment(scopeId)) {
        void disconnect?.(scopeId)
        return false
      }
      useSshConn.getState().setConn(scopeId, info)
      return true
    })
    .catch(() => false)
    // Cleared whatever happened: a failed dial must not poison the scope against the retry the
    // reconnect coordinator is about to make.
    .finally(() => {
      dialing.delete(scopeId)
    })
  dialing.set(scopeId, attempt)
  return attempt
}

/** Test seam only: forget in-flight dials between cases. */
export function resetHostAttachmentDials(): void {
  dialing.clear()
}
