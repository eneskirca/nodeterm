import type { NodeKind, Project } from '@shared/types'
import type { AgentId, AgentPermissionMode } from '@shared/agents/config'
import {
  type CanvasNode,
  type NodeData,
  createTerminalNode,
  createAgentNode,
  createEditorNode,
  createVideoNode,
  createWebNode,
  createBrowserNode,
  createDiffNode,
  createStickyNode,
  createDinoNode,
  isAccountLoginNode
} from '@renderer/state/workspace'
import { absolutePosition, type FocusableNode } from './nodeFocus'

export type RestorableNodeKind = Exclude<NodeKind, 'group' | 'subagent' | 'loop'>

export interface ReopenNodeSnapshot {
  type: RestorableNodeKind
  /** Raw position as stored on the node — relative to `parentId` when one is set. */
  position: { x: number; y: number }
  /** Precomputed via `absolutePosition` at snapshot time, for when the parent is gone by
   *  restore time (its own raw position would then be meaningless on its own). */
  absolutePosition: { x: number; y: number }
  parentId?: string
  extent?: 'parent'
  size?: { width: number; height: number }
  data: NodeData
  /**
   * The id of the matching entry this same delete also recorded in the persisted
   * `Project.closedSessions` history, when one was recorded — set only by `deleteNodes` (Canvas),
   * never by `stateToReopenSnapshot`'s reverse direction. Lets the two ledgers consume each
   * other: reopening this ⇧⌘T snapshot drops the persisted twin (`reopenLastClosedCommand`), and
   * reopening the persisted twin from the sidebar drops this snapshot out of the ⇧⌘T stack
   * (`reopenClosedSessionCommand` → `useReopenHistory.dropByClosedSessionId`) — so a single delete
   * can never be reopened twice into two duplicate nodes.
   */
  closedSessionId?: string
}

type SnapshotSource = {
  type?: string
  position: { x: number; y: number }
  parentId?: string
  /** @xyflow/react's `Node.extent` is `'parent' | CoordinateExtent | undefined` — only the
   *  `'parent'` literal matters here, so this stays loosely typed rather than importing that
   *  union just to narrow it. */
  extent?: unknown
  width?: number | null
  height?: number | null
  data: NodeData
}

// 'trigger' has no matching case in recreateNodeFromSnapshot's buildBase below (it always
// recreates to null) — excluded here so a deleted trigger node never becomes a dead, clickable
// closed-session/reopen-history entry.
const UNRESTORABLE: ReadonlySet<string> = new Set(['group', 'subagent', 'loop', 'trigger'])

/** Captures a node right before deletion. `all` must be the FULL live tree (before any
 *  mutation), so the parent chain is still walkable. Returns null for kinds this feature
 *  doesn't cover: group/subagent/loop nodes, and the account-login node (deleting it is a
 *  distinct "remove this account's node" action, not a close a user wants back). */
export function snapshotNode(
  node: SnapshotSource,
  all: readonly FocusableNode[]
): ReopenNodeSnapshot | null {
  const type = node.type ?? 'terminal'
  if (UNRESTORABLE.has(type)) return null
  if (isAccountLoginNode(node.data)) return null
  const size =
    typeof node.width === 'number' && typeof node.height === 'number'
      ? { width: node.width, height: node.height }
      : undefined
  return {
    type: type as RestorableNodeKind,
    position: node.position,
    absolutePosition: absolutePosition({ id: '__snapshot__', position: node.position, parentId: node.parentId }, all),
    ...(node.parentId ? { parentId: node.parentId } : {}),
    ...(node.extent === 'parent' ? { extent: 'parent' as const } : {}),
    ...(size ? { size } : {}),
    data: node.data
  }
}

export interface RecreateContext {
  /** ids present in the tree right now — decides whether the original parent group is still
   *  around to reattach to. Groups are never recreated by this feature, so this only ever
   *  needs to reflect nodes that were never deleted. */
  liveNodeIds: ReadonlySet<string>
  project: { ssh?: Project['ssh'] } | undefined
  /** Validates/redirects an account id against the accounts that exist right now (a removed
   *  account must not be stamped onto a new node). */
  resolveAccountId: (accountId: string | undefined) => string | undefined
  permissionModeFor: (agentId: AgentId) => AgentPermissionMode | undefined
}

const COSMETIC_KEYS = [
  'title', 'titleAuto', 'color', 'group', 'tags', 'collapsed', 'expandedHeight', 'shell', 'agentModel'
] as const

function withCosmetics(node: CanvasNode, data: NodeData): CanvasNode {
  const cosmetics: Partial<NodeData> = {}
  for (const key of COSMETIC_KEYS) {
    const value = data[key]
    if (value !== undefined) (cosmetics as Record<string, unknown>)[key] = value
  }
  return { ...node, data: { ...node.data, ...cosmetics } }
}

function buildBase(snapshot: ReopenNodeSnapshot, ctx: RecreateContext): CanvasNode | null {
  const d = snapshot.data
  switch (snapshot.type) {
    case 'terminal': {
      if (d.sshRemoteTmux && d.ssh) {
        // `remoteCwd` is non-optional on `Project['ssh']` — a remote node always had a cwd, but
        // fall back to '' (server default `~`) rather than asserting the type away.
        const sshBinding: Project['ssh'] = { server: d.ssh, remoteCwd: d.cwd ?? '' }
        return d.agentId
          ? createAgentNode(
              d.agentId,
              0,
              d.cwd,
              undefined,
              undefined,
              sshBinding,
              ctx.resolveAccountId(d.accountId),
              ctx.permissionModeFor(d.agentId)
            )
          : createTerminalNode(0, d.cwd, undefined, undefined, sshBinding)
      }
      if (d.ssh) {
        // Standalone "SSH terminal" node (local `ssh …`, not a remote-tmux project node).
        // Deliberately NOT routed through `createSshTerminalNode(server, …)`: that factory
        // RECOMPUTES `execTrusted: server.extraArgs ? true : undefined` from whatever server
        // object it's handed, which would mint trust=true for `extraArgs` of unknown
        // provenance (e.g. hydrated some other way). `d.ssh` is the LIVE node's own data
        // object, captured at snapshot time — its `execTrusted` already reflects genuine
        // local provenance (see `SshConnection.execTrusted`'s doc in shared/ssh.ts), so it is
        // copied verbatim, never re-derived. Build off `createTerminalNode` for id/size/position
        // scaffolding, then stamp `data.ssh` directly (no `sshRemoteTmux` — that flag means the
        // OTHER, remote-tmux-project case above).
        const scaffold = createTerminalNode(0)
        return { ...scaffold, data: { ...scaffold.data, ssh: d.ssh } }
      }
      if (d.agentId) {
        return createAgentNode(
          d.agentId,
          0,
          d.cwd,
          undefined,
          undefined,
          ctx.project?.ssh,
          ctx.resolveAccountId(d.accountId),
          ctx.permissionModeFor(d.agentId)
        )
      }
      return createTerminalNode(0, d.cwd, undefined, undefined, ctx.project?.ssh)
    }
    case 'sticky': {
      const node = createStickyNode(0)
      return { ...node, data: { ...node.data, text: d.text ?? '' } }
    }
    case 'editor':
      return d.filePath ? createEditorNode(0, d.filePath, undefined, d.sshFs) : null
    case 'video':
      return d.filePath ? createVideoNode(0, d.filePath, undefined, d.sshFs) : null
    case 'diff':
      return d.cwd && d.filePath ? createDiffNode(0, d.cwd, d.filePath, !!d.diffStaged, undefined, d.commitOid) : null
    case 'web':
      return createWebNode(0, { url: d.url, filePath: d.filePath })
    case 'browser':
      return createBrowserNode(0, d.url ?? '', undefined, d.partition)
    case 'dino':
      return createDinoNode(0, undefined, d.highScore ?? 0)
    default:
      return null
  }
}

/** Rebuilds a fresh node from a snapshot: same kind, position, parent group (if it still
 *  exists), and cosmetic metadata — but a NEW id/session, assembled through the same factories
 *  "New terminal/agent/…" uses, so e.g. an agent node's launch command is computed correctly
 *  for the CURRENT permission mode rather than replaying a stale one. Returns null for a kind
 *  this feature doesn't cover, or when required data (e.g. an editor's filePath) is missing —
 *  never a silently wrong node. */
export function recreateNodeFromSnapshot(snapshot: ReopenNodeSnapshot, ctx: RecreateContext): CanvasNode | null {
  const base = buildBase(snapshot, ctx)
  if (!base) return null
  const node = withCosmetics(base, snapshot.data)
  const reattach = !!snapshot.parentId && ctx.liveNodeIds.has(snapshot.parentId)
  node.position = reattach ? snapshot.position : snapshot.absolutePosition
  node.parentId = reattach ? snapshot.parentId : undefined
  // `snapshot.extent` is loosely typed (see SnapshotSource) — narrow back to the one literal
  // this codebase ever sets on a child node.
  node.extent = reattach && snapshot.extent === 'parent' ? 'parent' : undefined
  if (snapshot.size) {
    node.width = snapshot.size.width
    node.height = snapshot.size.height
    node.style = { ...node.style, width: snapshot.size.width, height: snapshot.size.height }
  }
  return node
}
