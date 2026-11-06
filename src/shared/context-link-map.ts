// How a canvas becomes a context-link map: node id → the nodes it may READ.
//
// Lives in shared because both shells need it and neither owns it. The desktop renderer builds
// the ACTIVE project's map from live React Flow edges and the rest from the projects store
// (Canvas.tsx). The Server Edition has no renderer holding a canvas — it derives the whole map
// from persisted project files instead (src/server/context-link.ts). Same rules either way, so
// they belong in one place rather than two that drift.
import type { BridgeLink, CanvasNodeState, ContextLinkInfo, ContextLinkMap, ContextLinkPull } from './types'
import { linkReadPairs, type LinkEdge } from './canvas-link'

export interface LinkNodeInfo {
  id: string
  title: string
  cwd?: string
  note?: string
  sticky: boolean
  agentId?: string
  sessionId?: string
  accountId?: string
  /** A pull request node. Like a sticky it cannot read; the other end reads its Overview. */
  pull?: ContextLinkPull
}

/**
 * Build the node → linked-nodes map pushed to main (which writes the per-node link files).
 * Context edges map both directions unless the edge names a one-way `reader` (issue #852), in
 * which case only the reader gets an entry — and since main serves a node nothing outside its own
 * entry list, that is what stops the other side reading. Note edges map one direction only — the
 * terminal side gets a { id, title, note } entry, the sticky side gets nothing (a sticky cannot read).
 */
export function buildLinkMap(
  edges: LinkEdge[],
  infoOf: (id: string) => LinkNodeInfo
): ContextLinkMap {
  const map: ContextLinkMap = {}
  const entryOf = (n: LinkNodeInfo): ContextLinkInfo => {
    if (n.sticky) return { id: n.id, title: n.title, note: n.note ?? '' }
    if (n.pull) return { id: n.id, title: n.title, pull: n.pull }
    const e: ContextLinkInfo = { id: n.id, title: n.title, cwd: n.cwd ?? '' }
    if (n.agentId) e.agentId = n.agentId
    if (n.sessionId) e.sessionId = n.sessionId
    if (n.accountId) e.accountId = n.accountId
    return e
  }
  for (const e of edges) {
    const s = infoOf(e.source)
    const t = infoOf(e.target)
    if ((s.sticky || s.pull) && (t.sticky || t.pull)) continue
    if (s.sticky || s.pull) {
      ;(map[t.id] ??= []).push(entryOf(s))
    } else if (t.sticky || t.pull) {
      ;(map[s.id] ??= []).push(entryOf(t))
    } else {
      for (const { reader } of linkReadPairs(e)) {
        ;(map[reader] ??= []).push(entryOf(reader === s.id ? t : s))
      }
    }
  }
  return map
}

/**
 * Link maps built from serialized nodes + bridges, for every project EXCEPT `activeProjectId`.
 *
 * On the desktop the active project's map is built live from React Flow and this covers the rest,
 * because writeLinkFiles clears ALL link files before writing the pushed map — pushing only the
 * active project's map deleted the link files of background projects whose tmux sessions (and
 * agents mid-task) were still running. Node ids are globally unique across projects, so the maps
 * merge without collisions.
 *
 * A shell with no focused canvas (the Server Edition) passes `activeProjectId: null` and gets
 * every project, which is the whole map.
 *
 * `agentIdOf` is the hook-status fallback for plain terminals where the user launched an
 * agent CLI by hand: the serialized node carries no agentId, but the status store (fed by
 * the managed hooks, node ids are per-core so background projects share it) knows who's
 * running inside.
 */
export function buildBackgroundLinkMaps(
  projects: Array<{ id: string; nodes: CanvasNodeState[]; bridges?: BridgeLink[] }>,
  activeProjectId: string | null,
  sessionIdOf: (nodeId: string) => string | undefined,
  agentIdOf?: (nodeId: string) => string | undefined
): ContextLinkMap {
  const map: ContextLinkMap = {}
  for (const p of projects) {
    if (p.id === activeProjectId || !p.bridges?.length) continue
    const byId = new Map(p.nodes.map((n) => [n.id, n]))
    const edges = p.bridges.filter((e) => byId.has(e.source) && byId.has(e.target))
    const infoOf = (id: string): LinkNodeInfo => {
      const n = byId.get(id)!
      const sticky = n.kind === 'sticky'
      const agentId = sticky ? undefined : (n.agentId ?? agentIdOf?.(id))
      if (n.kind === 'pull' && n.pull) {
        return { id, title: n.title || id, sticky: false, pull: { projectId: p.id, repository: n.pull.repository, pullNumber: n.pull.pullNumber } }
      }
      return {
        id,
        title: n.title || id,
        cwd: n.cwd ?? '',
        note: sticky ? (n.text ?? '') : undefined,
        sticky,
        agentId,
        sessionId: agentId ? sessionIdOf(id) : undefined,
        accountId: sticky ? undefined : n.accountId
      }
    }
    Object.assign(map, buildLinkMap(edges, infoOf))
  }
  return map
}
