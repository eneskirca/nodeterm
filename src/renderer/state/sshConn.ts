import { create } from 'zustand'
import type { SshConnection } from '@shared/ssh'

/** Live connection coordinates for one connection scope, returned by `sshProject.connect`.
 *  A scope is an SSH PROJECT's id, or a host ATTACHMENT id — see `sshConnectionIdForProject`. */
export interface SshConnInfo {
  /** ControlMaster socket path the project's terminals run their PTYs over. */
  controlPath: string
  /** Remote endpoint file the managed hook script sources (reverse-tunnel hook transport).
   *  Optional: absent when forwarding/remote install failed (fail-open → Phase-1 status). */
  hookEndpointPath?: string
  /** Remote path of the injected tmux config (`-f`), written + sourced on connect.
   *  Optional: absent when the conf write failed (fail-open → remote tmux defaults). */
  tmuxConfPath?: string
  /** The connection's resolved remote `$HOME`. Used to build an ABSOLUTE remote
   *  `CLAUDE_CONFIG_DIR` for a managed remote account. Optional: absent if it couldn't resolve. */
  remoteHome?: string
  /** Does the REMOTE host's claude CLI accept `--permission-mode auto` (>= 2.1.71)? The local
   *  CLI's answer says nothing about the remote one, so the host is probed on its own — AFTER
   *  connect (the probe's login shell is slow and must not delay the project's terminals), so this
   *  is usually absent here and arrives later on a `connected` status event. Absent/false ⇒ this
   *  project's Claude nodes launch with the bare command (no `auto` flag). */
  claudeAutoPermissionMode?: boolean
  /** The probed remote `claude --version` output (`null` = probe ran, claude not found). Feeds
   *  the tab menu's Auto hint; only present on a reused (already probed) connection. */
  remoteClaudeVersion?: string | null
}

/**
 * Routing facts for a HOST ATTACHMENT — a remote node living in a project that is not that
 * endpoint's own SSH project. An SSH project can re-derive all of this from `getProject(id)`; an
 * attachment has no project row of its own, so this is the only record of it.
 *
 * Kept in its OWN map, not on `SshConnInfo`, because it must exist BEFORE the connection does and
 * must SURVIVE its failure: the reconnect coordinator reads the endpoint back out of here to
 * redial, and the respawn reads the owning canvas out of here to know where the nodes are. Both
 * of those run precisely when there is no live connection to hang the facts off. Renderer-only:
 * never persisted.
 */
export interface SshAttachment {
  /** The endpoint, snapshotted — the saved server may be edited or deleted underneath us. */
  conn: SshConnection
  /** `user@host` (`sshHostKey`) — for "am I already connected to this machine?" lookups. */
  hostKey: string
  /** The folder the CONNECTION is opened at (the scp/Explorer base); nodes spawn in their own. */
  remoteCwd?: string
  /** The LOCAL canvas project the attached nodes live on. */
  ownerProjectId: string
}

/** What the remote probe has said so far — the tab menu's Auto hint reads differently for "not
 *  probed yet" vs "probed and unsupported". The LAUNCH gate stays `supportsAutoPermissionMode`
 *  (boolean, conservative: unknown = no flag). */
export type SshAutoPermAnswer = 'yes' | 'no' | 'unknown'

/**
 * Transient map of CONNECTION SCOPE → its live connection info (ControlMaster `controlPath` +
 * optional remote `hookEndpointPath`) returned by `sshProject.connect`. Not persisted: it's
 * re-established on every launch by Canvas's active-project effect. A remote terminal node reads
 * its scope's entry here to pass `sshRemote` into `transport.create`, so the PTY runs over that
 * master and (when present) the remote hook env is injected.
 *
 * A scope is USUALLY an SSH project's id. It is a host ATTACHMENT id (`sshAttachmentId`) when the
 * node's endpoint is not its project's own — a remote node inside a LOCAL canvas. Both kinds live
 * in this one map because everything downstream (connect, resolve, reconnect, disconnect) treats
 * them identically; `attachment` is what distinguishes them.
 */
interface SshConnState {
  byProject: Record<string, SshConnInfo>
  /** Attachment scope id → how to reach it and whose canvas it serves. Written BEFORE the dial
   *  (see `registerAttachment`), so it outlives a failed connect. */
  attachments: Record<string, SshAttachment>
  /** project id → "the remote CLI accepts `--permission-mode auto`". Kept OUTSIDE `byProject`
   *  because the remote probe runs after connect and can land before OR after the connect promise
   *  writes the entry — a separate map makes the two orders equivalent. */
  autoPermByProject: Record<string, boolean>
  /** project id → the probed remote `claude --version` output (`null` = claude not found). Kept
   *  beside `autoPermByProject` (same lifecycle) so the tab-menu hint can name the version. */
  remoteClaudeVersionByProject: Record<string, string | null>
  setConn(projectId: string, info: SshConnInfo): void
  /** Record the remote CLI probe's answer (pushed on a `connected` status event once it lands).
   *  `version` rides the same event; undefined leaves the cached version untouched. */
  setClaudeAutoPermissionMode(projectId: string, supported: boolean, version?: string | null): void
  getControlPath(projectId: string): string | undefined
  getHookEndpointPath(projectId: string): string | undefined
  getTmuxConfPath(projectId: string): string | undefined
  getRemoteHome(projectId: string): string | undefined
  /**
   * Record how to reach an attachment scope. Call this BEFORE dialing, not after: a first connect
   * that FAILS is exactly the case the reconnect coordinator exists for, and it has nowhere else
   * to learn the endpoint from. Recording on success only made a cold load against a sleeping
   * host unrecoverable for the rest of the app run.
   */
  registerAttachment(scopeId: string, attachment: SshAttachment): void
  /** The routing facts of a HOST ATTACHMENT scope; undefined for an SSH project's own scope
   *  (which re-derives everything from its project row) and for a scope never registered. */
  getAttachment(scopeId: string): SshAttachment | undefined
  /** The canvas project a connection scope's nodes live on: the owner for an attachment, the
   *  scope itself for an SSH project. Never undefined — callers key React Flow off it. */
  ownerProjectId(scopeId: string): string
  /** Forget an attachment entirely (its canvas was deleted). Also drops any live connection info. */
  clearAttachment(scopeId: string): void
  /** True ONLY when the remote CLI was probed and is known to accept `--permission-mode auto`.
   *  Not connected / never probed / older CLI all answer false (conservative — omit the flag). */
  supportsAutoPermissionMode(projectId: string): boolean
  /** Tri-state view of the probe for UI hints: 'unknown' until an answer lands (or after
   *  invalidation), then 'yes'/'no'. The launch gate above stays boolean. */
  autoPermAnswer(projectId: string): SshAutoPermAnswer
  /** The probed remote version (`null` = probed, claude not found; undefined = never probed). */
  getRemoteClaudeVersion(projectId: string): string | null | undefined
  /** Drop the cached probe answer WITHOUT touching the rest of the conn info (unlike `clear()`,
   *  which is for project deletion). Call this on a `disconnected` / `reconnecting` status: if the
   *  project's SSH server gets repointed to a different host, the previous host's cached `true`
   *  must not survive to be served against the new (possibly older) remote CLI — the fail-open
   *  design means "unknown" should win until the next probe lands, never a stale "yes". */
  invalidateAutoPermissionMode(projectId: string): void
  clear(projectId: string): void
  /** Every attachment scope a project owns. Used to tear its masters down when the project is
   *  deleted — nothing else knows they exist (they have no project row). */
  attachmentScopesOf(ownerProjectId: string): string[]
}

export const useSshConn = create<SshConnState>((set, get) => ({
  byProject: {},
  attachments: {},
  autoPermByProject: {},
  remoteClaudeVersionByProject: {},
  setConn(projectId, info) {
    set((s) => ({
      byProject: { ...s.byProject, [projectId]: info },
      // A reused (already probed) connection returns the answer with the connect result.
      autoPermByProject:
        info.claudeAutoPermissionMode === undefined
          ? s.autoPermByProject
          : { ...s.autoPermByProject, [projectId]: info.claudeAutoPermissionMode },
      remoteClaudeVersionByProject:
        info.remoteClaudeVersion === undefined
          ? s.remoteClaudeVersionByProject
          : { ...s.remoteClaudeVersionByProject, [projectId]: info.remoteClaudeVersion }
    }))
  },
  setClaudeAutoPermissionMode(projectId, supported, version) {
    set((s) => ({
      autoPermByProject: { ...s.autoPermByProject, [projectId]: supported },
      remoteClaudeVersionByProject:
        version === undefined
          ? s.remoteClaudeVersionByProject
          : { ...s.remoteClaudeVersionByProject, [projectId]: version }
    }))
  },
  getControlPath(projectId) {
    return get().byProject[projectId]?.controlPath
  },
  getHookEndpointPath(projectId) {
    return get().byProject[projectId]?.hookEndpointPath
  },
  getTmuxConfPath(projectId) {
    return get().byProject[projectId]?.tmuxConfPath
  },
  getRemoteHome(projectId) {
    return get().byProject[projectId]?.remoteHome
  },
  registerAttachment(scopeId, attachment) {
    set((s) => ({ attachments: { ...s.attachments, [scopeId]: attachment } }))
  },
  getAttachment(scopeId) {
    return get().attachments[scopeId]
  },
  ownerProjectId(scopeId) {
    return get().attachments[scopeId]?.ownerProjectId ?? scopeId
  },
  clearAttachment(scopeId) {
    set((s) => {
      const next = { ...s.attachments }
      delete next[scopeId]
      const conns = { ...s.byProject }
      delete conns[scopeId]
      return { attachments: next, byProject: conns }
    })
  },
  supportsAutoPermissionMode(projectId) {
    return get().autoPermByProject[projectId] === true
  },
  autoPermAnswer(projectId) {
    const v = get().autoPermByProject[projectId]
    return v === undefined ? 'unknown' : v ? 'yes' : 'no'
  },
  getRemoteClaudeVersion(projectId) {
    return get().remoteClaudeVersionByProject[projectId]
  },
  invalidateAutoPermissionMode(projectId) {
    set((s) => {
      if (!(projectId in s.autoPermByProject) && !(projectId in s.remoteClaudeVersionByProject)) {
        return s
      }
      const next = { ...s.autoPermByProject }
      delete next[projectId]
      const nextVersion = { ...s.remoteClaudeVersionByProject }
      delete nextVersion[projectId]
      return { autoPermByProject: next, remoteClaudeVersionByProject: nextVersion }
    })
  },
  clear(projectId) {
    set((s) => {
      const next = { ...s.byProject }
      delete next[projectId]
      const nextAuto = { ...s.autoPermByProject }
      delete nextAuto[projectId]
      const nextVersion = { ...s.remoteClaudeVersionByProject }
      delete nextVersion[projectId]
      return { byProject: next, autoPermByProject: nextAuto, remoteClaudeVersionByProject: nextVersion }
    })
  },
  attachmentScopesOf(ownerProjectId) {
    return Object.entries(get().attachments)
      .filter(([, a]) => a.ownerProjectId === ownerProjectId)
      .map(([scopeId]) => scopeId)
  }
}))
