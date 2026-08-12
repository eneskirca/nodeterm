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

// KNOWN GAP, recorded in docs/session-memory.md's "Known gaps": the SESSIONS SIDEBAR still calls
// `closeSession` with no remote leg, so ending an unmounted SSH node's session there leaves the
// host's `nt-<id>` running after a confirm that said otherwise — the two surfaces now disagree
// about the same session. Its correct fix is owner-routed per row (the row's OWNER project's
// master, not the active project's, which is only sound here because the panel shows one machine
// at a time); reuse this file rather than adding a third kill path.

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
