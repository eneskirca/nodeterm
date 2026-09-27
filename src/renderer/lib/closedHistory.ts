import type { CanvasNodeState, ClosedSessionEntry, Project } from '@shared/types'
import { canChat, createdAgentId } from '@shared/agents/config'
import { flowToNodeStates, type CanvasNode } from '@renderer/state/workspace'
import { snapshotNode, type ReopenNodeSnapshot, type RestorableNodeKind } from './reopenNode'
import { absolutePosition, type FocusableNode } from './nodeFocus'
import { normalizeNodeIcon } from '@shared/node-icon'

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
  makeId: (nodeId: string) => string,
  /**
   * The LIVE agent session id for a node, from the transient `agentStatus` store. Optional so
   * every pre-#531 caller is unchanged, but `deleteNodes` passes it: the store entry is dropped
   * with the node, so this is the last moment the id exists anywhere (see
   * `ClosedSessionEntry.sessionId`).
   */
  liveSessionId?: (nodeId: string) => string | undefined
): ClosedSessionEntry[] {
  return allNodes
    .filter((n) => deletedIds.has(n.id))
    .filter((n) => snapshotNode(n, allNodes as readonly FocusableNode[]) !== null)
    .map((n) => {
      const node = flowToNodeStates([n])[0]
      // Live id first (it is the session the node was actually running — a resume replaces the
      // minted one), then the minted id as the durable fallback.
      const sessionId = liveSessionId?.(n.id) || node.agentSessionId
      return {
        id: makeId(n.id),
        closedAt: now,
        node,
        absolutePosition: absolutePosition(
          { id: n.id, position: n.position, parentId: n.parentId },
          allNodes as readonly FocusableNode[]
        ),
        ...(sessionId ? { sessionId } : {})
      }
    })
}

/**
 * Whether a closed session's transcript can still be read, and through what.
 *
 * `ok` carries exactly the arguments `chat.readTranscript` takes, so the recovery path is the
 * EXISTING ⌘M reader rather than a second one — including its `{found}` discipline, which is what
 * keeps "the agent pruned this transcript" from rendering as an empty conversation.
 *
 * Every refusal names its reason, because a silently missing affordance teaches nothing: the two
 * that exist are a session whose id was never recorded (closed by a build older than #531, or a
 * node that never ran an agent) and a REMOTE one, whose transcript lives on the host — the local
 * resolvers would search this machine and, via `resolveTranscript`'s cwd fallback, could answer
 * with an unrelated local session. Reading a closed remote station is real work (locate-by-session
 * over the ControlMaster, for a project that may not even be connected) and deliberately not held
 * hostage to the local fix.
 */
export type ClosedTranscriptTarget =
  | { ok: true; sessionId: string; agentId: string; cwd?: string; accountId?: string; nodeId: string }
  | { ok: false; kind: 'no-agent' | 'remote' | 'no-session-id'; reason: string }

export function closedTranscriptTarget(entry: ClosedSessionEntry): ClosedTranscriptTarget {
  const n = entry.node
  const agentId = createdAgentId(n)
  // `no-agent` is the one refusal a surface may render as NOTHING: a plain terminal or a sticky
  // note never had a conversation, so a disabled "read transcript" control on it would be noise.
  // The other two are losses worth naming.
  if (!agentId || !canChat(agentId)) {
    return { ok: false, kind: 'no-agent', reason: 'This session has no readable transcript.' }
  }
  if (n.ssh || n.sshRemoteTmux) {
    return {
      ok: false,
      kind: 'remote',
      reason: 'This session ran on a remote host; its transcript is not readable after close yet.'
    }
  }
  if (!entry.sessionId) {
    return {
      ok: false,
      kind: 'no-session-id',
      reason: 'No session id was recorded for this session, so its transcript cannot be found.'
    }
  }
  return {
    ok: true,
    sessionId: entry.sessionId,
    agentId,
    cwd: n.cwd,
    accountId: n.accountId,
    nodeId: n.id
  }
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
      // Re-validated, not copied: this entry was read from hand-editable workspace.json.
      icon: normalizeNodeIcon(n.icon),
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
/**
 * The start screen's "Recently closed" list: closed, AVAILABLE projects, newest-closed first
 * (issue #506).
 *
 * The heading promises recency and the list did not deliver it — it was
 * `projects.filter(p => p.closed && !p.unavailable)`, i.e. TAB order, so the project shut ten
 * minutes ago sat wherever its tab happened to be. With the list capped to about six visible
 * rows, that turned scanning into hunting.
 *
 * `unavailable` is excluded for the same reason the Canvas selector always excluded it: reopening
 * a ref whose folder is missing activates an empty placeholder. Sort rule and `-1` sentinel are
 * `mergeClosedHistory`'s, deliberately — the two lists describe the same event and must not order
 * it differently; `closedAt` is absent only on projects closed before that field existed, and
 * those sort last rather than becoming `NaN`.
 */
export function recentlyClosedProjects<
  T extends { closed?: boolean; unavailable?: boolean; closedAt?: number }
>(projects: readonly T[]): T[] {
  return projects
    .filter((p) => p.closed && !p.unavailable)
    .sort((a, b) => (b.closedAt ?? -1) - (a.closedAt ?? -1))
}

/**
 * Narrows the "Recently closed" list by name or folder — both already rendered on the row, and
 * `cwd` is the row's `title`. Empty/whitespace query = everything, unchanged.
 */
export function filterClosedProjects<T extends { name: string; cwd?: string }>(
  rows: readonly T[],
  query: string
): T[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return rows as T[]
  return rows.filter((r) => `${r.name} ${r.cwd ?? ''}`.toLowerCase().includes(needle))
}

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
