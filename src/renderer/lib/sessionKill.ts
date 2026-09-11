// Where a session picked from the SESSION-MEMORY PANEL has to be killed.
//
// The panel is the first surface in the app that lists sessions on a machine other than the one
// the renderer runs on: an SSH project's rows come from `ps` on the HOST. That makes the ordinary
// kill path a lie in exactly the cases the panel adds.
//
// `transport.destroy(nodeId)` reaches a REMOTE tmux session only through a LIVE local client that
// carries `sshRemote` (see `PtyManager.endSession`) — i.e. only for a node that is currently
// mounted. An ORPHAN row has no node at all, and a row owned by a non-active project has no live
// client either, so for both of those `destroy` touches only the local socket while the remote
// `nt-<id>` keeps running. The confirm would promise a kill it cannot perform, and the row would
// come back on the next refresh with no explanation.
//
// So the plan is decided by the SCOPE, not by the row: **the panel kills on the machine it is
// showing you.** On an SSH scope every row is a session on that host, so the kill additionally runs
// `tmux kill-session` over that project's own ControlMaster (`sshProject.killSessions`), which
// needs no live session. It is idempotent — a session already ended by `destroy` (the mounted case)
// is a best-effort miss on the host — so no case analysis is needed at the call site.

// That gap is CLOSED, and not here: `PtyManager.runEndSession` no longer decides remoteness from
// the live `Session` alone. A resolver wired from the persisted index (`setRemoteNodeOwner` →
// `workspaceStore.sshProjectIdForNode` + that project's ControlMaster — see core/remote-end.ts)
// answers for a node with no live client at all, so every `transport.destroy` — the sessions
// sidebar's `closeSession`, the node `×`, Delete, a delete after an app restart — now reaches the
// host by itself, and a kill it could not deliver is written down rather than swallowed.
//
// This file therefore stays for what it always was: the panel's ORPHAN rows, which carry no node
// id any project claims, so no resolver can find an owner for them. Do not add a third kill path.

import type { Project } from '@shared/types'

export interface SessionKillPlan {
  /**
   * The project whose canvas node must go too, or `null` when no project owns this session (an
   * orphan). Resolved against EVERY project, closed ones included — `closeProject` keeps its nodes.
   */
  ownerProjectId: string | null
  /**
   * The project whose ControlMaster must run the remote `tmux kill-session`, or `null` when the
   * scope is this machine. This is the ACTIVE project, never the owner: the panel shows one
   * machine at a time, and that machine is the active project's.
   */
  remoteProjectId: string | null
}

export function planSessionKill(
  nodeId: string,
  projects: readonly Project[],
  activeProjectId: string
): SessionKillPlan {
  const owner = projects.find((p) => (p.nodes ?? []).some((n) => n.id === nodeId))
  const active = projects.find((p) => p.id === activeProjectId)
  return {
    ownerProjectId: owner?.id ?? null,
    // `active.ssh`, not `owner.ssh`: a local scope lists LOCAL sessions, and a local `nt-<id>`
    // whose node belongs to an SSH project is precisely the stranded local fallback that
    // `requireRemote` exists to prevent — killing it on the host would leave it running here.
    remoteProjectId: active?.ssh ? active.id : null
  }
}
