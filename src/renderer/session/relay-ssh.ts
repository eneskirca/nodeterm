import type { CanvasMutation, CanvasNodeState, Project } from '@shared/types'
import { withoutCoreOrigin } from '@shared/node-exec'

/**
 * A relay tab must never make THIS machine dial SSH.
 *
 * A relay tab shows another machine's project. When that project is an SSH project, its
 * `ssh.server` (host, user, port, identity file, extra args) is the HOST's connection, and every
 * guest-side consumer of it — the active-project connect, the host-attachment pre-warm, the
 * reconnect coordinator, a terminal's `resolveSshRemote` — dials through this machine's own
 * preload, i.e. with this machine's keys and agent, then runs the whole post-connect routine
 * (hook and shim installs, a reverse tunnel back into this machine's hook server) on whatever box
 * the host named. The host is not trusted with that: a malicious host names its own box and
 * harvests an authenticated session. Even an honest host's endpoint is wrong here — the guest has
 * no business logging into the host's SSH server with the guest's credentials.
 *
 * So the connection objects are removed at every relay ingest point (`sanitizeRelayProject`,
 * `sanitizeRelayMutation`) and each dial site ALSO refuses a relay project on its own
 * (`projectMayDialSsh`) — defence in depth: either half alone closes the hole.
 *
 * What survives:
 *  - `sshRemoteTmux` on a node — a plain boolean. It keeps `requireRemote` on the create the tab
 *    sends to the HOST's core, which then co-attaches when the host holds the session live and
 *    refuses otherwise; it never creates a local session on the host under the node's identity.
 *  - `relaySsh` on the project — display-only strings for the tab's `SSH user@host` chip. It is not
 *    an `SshConnection` and nothing that dials reads it.
 *  - A plain `ssh <host>` node (`ssh` without `sshRemoteTmux`) keeps its connection: its create runs
 *    `ssh` as a pty program on the HOST's core (the relay api), never on this machine.
 */

/** Display-only strings for a relay tab of the host's SSH project. */
export interface RelaySshDisplay {
  user: string
  host: string
  remoteCwd: string
}

/** Printable, single-line, bounded — this is text from another machine headed for the tab bar. */
function displayText(v: unknown): string {
  if (typeof v !== 'string') return ''
  // eslint-disable-next-line no-control-regex
  return v.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').slice(0, 256)
}

/** Drop the dial-capable connection from an SSH-project node (see the module header). */
export function sanitizeRelayNode(node: CanvasNodeState): CanvasNodeState {
  if (!node.sshRemoteTmux || node.ssh === undefined) return node
  const { ssh: _dropped, ...rest } = node
  return rest
}

/** The host's project as a relay tab may hold it: no `ssh`, display strings only. */
export function sanitizeRelayProject(project: Project): Project {
  const { ssh, ...rest } = project
  const out: Project = { ...rest, remote: true, nodes: (project.nodes ?? []).map(sanitizeRelayNode) }
  if (ssh && typeof ssh === 'object') {
    const server = (ssh as { server?: { user?: unknown; host?: unknown } }).server
    out.relaySsh = {
      user: displayText(server?.user),
      host: displayText(server?.host),
      remoteCwd: displayText((ssh as { remoteCwd?: unknown }).remoteCwd)
    }
  } else {
    delete out.relaySsh
  }
  return out
}

/** A canvas-sync mutation arriving on a relay session, with the same stripping applied. */
export function sanitizeRelayMutation(mutation: CanvasMutation): CanvasMutation {
  if (mutation.op !== 'upsert') return mutation
  const node = sanitizeRelayNode(mutation.node)
  return node === mutation.node ? mutation : { ...mutation, node }
}

/**
 * What a canvas-sync mutation received on a session may do here. A relay tab's mutations come from
 * ANOTHER machine's core, which can put anything on the wire, so its `origin: 'core'` vouches for
 * nothing: it is dropped (the node's held launch stays ours — @shared/node-exec) and the
 * dial-capable SSH connection is stripped. A local session's mutation is returned as received.
 */
export function receivedCanvasMutation(received: CanvasMutation, relay: boolean): CanvasMutation {
  return relay ? sanitizeRelayMutation(withoutCoreOrigin(received)) : received
}

/**
 * THE gate every guest-side SSH dial asks: a relay tab's project never dials, whatever it carries.
 * `undefined` (unknown project) is not a relay project — the caller's own "nothing to dial" check
 * decides that case, exactly as before.
 */
export function projectMayDialSsh(project: Pick<Project, 'remote'> | undefined): boolean {
  return !project?.remote
}
