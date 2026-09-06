import type { CanvasNodeState, ClosedSessionEntry, Project } from '@shared/types'
import { flowToNodeStates, type CanvasNode } from '@renderer/state/workspace'
import { snapshotNode, type ReopenNodeSnapshot, type RestorableNodeKind } from './reopenNode'
import { absolutePosition, type FocusableNode } from './nodeFocus'

/**
 * Builds one `ClosedSessionEntry` per node in `deletedIds` that `snapshotNode` would also accept
 * for the in-memory `Cmd+Shift+T` history — the two histories must agree on what's restorable
 * (group/subagent/loop/account-login nodes are excluded from both). `allNodes` must be the FULL
 * live tree from BEFORE the deletion, so parent-chain absolute positions are still resolvable.
 * `now`/`makeId` are injected so this stays a pure, deterministically testable function; call
 * sites pass `Date.now()` and a `uuid` (`lib/uuid.ts`)-backed minter — NEVER `crypto.randomUUID`,
 * which is absent outside a secure context and so throws in the Server Edition served over plain
 * HTTP on a LAN.
 *
 * `makeId` is handed the SOURCE node's id (not called bare) so the caller (`deleteNodes`) can
 * record which minted entry id belongs to which node — that correlation is what lets a ⇧⌘T
 * snapshot and its persisted twin consume each other on reopen (see
 * `ReopenNodeSnapshot.closedSessionId`). Correlating by node id rather than by array position
 * keeps the two histories' independent filtering passes from ever silently misaligning.
 */
export function buildClosedSessionEntries(
  deletedIds: ReadonlySet<string>,
  allNodes: readonly CanvasNode[],
  now: number,
  makeId: (nodeId: string) => string
): ClosedSessionEntry[] {
  return allNodes
    .filter((n) => deletedIds.has(n.id))
    .filter((n) => snapshotNode(n, allNodes as readonly FocusableNode[]) !== null)
    .map((n) => ({
      id: makeId(n.id),
      closedAt: now,
      node: flowToNodeStates([n])[0],
      absolutePosition: absolutePosition(
        { id: n.id, position: n.position, parentId: n.parentId },
        allNodes as readonly FocusableNode[]
      )
    }))
}

/**
 * Converts a persisted `ClosedSessionEntry` back into the shape `recreateNodeFromSnapshot`
 * already accepts. `CanvasNodeState` and `NodeData` share field names for everything both
 * track (by construction of `nodeStatesToFlow`/`flowToNodeStates`), so this is a direct field
 * copy, not a lossy remap.
 *
 * The position fallbacks are belt-and-braces behind `validClosedSessions`, which is what actually
 * rejects a positionless entry at the file boundary. They exist because
 * `recreateNodeFromSnapshot` assigns `node.position` from one of these two UNGUARDED, and React
 * Flow dereferences `position.x` — so any path that ever reaches here with an entry the validator
 * did not see (an inline index project, a future caller) lands the node at the origin instead of
 * white-screening the renderer.
 */
export function stateToReopenSnapshot(entry: ClosedSessionEntry): ReopenNodeSnapshot {
  const n = entry.node
  const origin = { x: 0, y: 0 }
  return {
    type: n.kind as RestorableNodeKind,
    position: n.position ?? entry.absolutePosition ?? origin,
    absolutePosition: entry.absolutePosition ?? n.position ?? origin,
    ...(n.parentId ? { parentId: n.parentId, extent: 'parent' as const } : {}),
    size: n.size,
    data: {
      title: n.title,
      titleAuto: n.titleAuto,
      color: n.color,
      group: n.group,
      tags: n.tags,
      collapsed: n.collapsed,
      hideFanout: n.hideFanout,
      shell: n.shell,
      cwd: n.cwd,
      text: n.text,
      textUpdatedAt: n.textUpdatedAt,
      textUpdatedBy: n.textUpdatedBy,
      filePath: n.filePath,
      fileMissing: n.fileMissing,
      url: n.url,
      partition: n.partition,
      diffStaged: n.diffStaged,
      commitOid: n.commitOid,
      highScore: n.highScore,
      agentId: n.agentId,
      agentModel: n.agentModel,
      accountId: n.accountId,
      agentSessionId: n.agentSessionId,
      ssh: n.ssh,
      sshRemoteTmux: n.sshRemoteTmux,
      sshFs: n.sshFs
    }
  }
}

export type ClosedHistoryRow =
  | { kind: 'project'; projectId: string; closedAt: number; project: Project }
  | { kind: 'session'; projectId: string; closedAt: number; entry: ClosedSessionEntry }

/**
 * Merges every project's closed-session entries with every closed, AVAILABLE project into one
 * list, sorted newest-first. `unavailable` (a ref whose folder is missing / server unreachable —
 * same check Canvas's own `closedProjects` selector already applies) is excluded: reopening it
 * would activate an empty placeholder, and it has no history worth showing. An entry/project with
 * no known `closedAt` (pre-existing data from before that field existed) sorts last via the `-1`
 * sentinel — never `NaN` from subtracting `undefined`.
 */
export function mergeClosedHistory(projects: readonly Project[]): ClosedHistoryRow[] {
  const rows: ClosedHistoryRow[] = []
  for (const p of projects) {
    if (p.closed && !p.unavailable) {
      rows.push({ kind: 'project', projectId: p.id, closedAt: p.closedAt ?? -1, project: p })
    }
    for (const entry of p.closedSessions ?? []) {
      rows.push({ kind: 'session', projectId: p.id, closedAt: entry.closedAt, entry })
    }
  }
  return rows.sort((a, b) => b.closedAt - a.closedAt)
}
