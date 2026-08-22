// How a canvas becomes a context-link map: node id → the nodes it may READ.
//
// Lives in shared because both shells need it and neither owns it. The desktop renderer builds
// the ACTIVE project's map from live React Flow edges and the rest from the projects store
// (Canvas.tsx). The Server Edition has no renderer holding a canvas — it derives the whole map
// from persisted project files instead (src/server/context-link.ts). Same rules either way, so
// they belong in one place rather than two that drift.
import type { CanvasNodeState, ContextLinkInfo, ContextLinkMap, Link } from './types'

/**
 * The node↔node edge pairs a context-link map can read through. Both `node` and `xnode` endpoints
 * name real nodes (node ids are workspace-global); `xnode` merely records that the other node lives
 * in another project. Branch endpoints carry no transcript and are excluded.
 * `kind:'context'` covers both agent↔agent context links and sticky→terminal note links (a note
 * link persists as `context` with `meta.note`); `lineage` (display-only ropes) is excluded.
 */
export function contextNodeEdges(links: readonly Link[] | undefined): Array<{ source: string; target: string }> {
  if (!links?.length) return []
  const out: Array<{ source: string; target: string }> = []
  for (const l of links) {
    if (l.kind !== 'context') continue
    if (l.source.ref === 'branch' || l.target.ref === 'branch') continue
    out.push({ source: l.source.nodeId, target: l.target.nodeId })
  }
  return out
}

export interface LinkNodeInfo {
  id: string
  title: string
  cwd?: string
  note?: string
  sticky: boolean
  agentId?: string
  sessionId?: string
  accountId?: string
}

/**
 * Build the node → linked-nodes map pushed to main (which writes the per-node link files).
 * Context edges map both directions; note edges map one direction only — the terminal side
 * gets a { id, title, note } entry, the sticky side gets nothing (a sticky cannot read).
 */
export function buildLinkMap(
  edges: Array<{ source: string; target: string }>,
  infoOf: (id: string) => LinkNodeInfo
): ContextLinkMap {
  const map: ContextLinkMap = {}
  const entryOf = (n: LinkNodeInfo): ContextLinkInfo => {
    if (n.sticky) return { id: n.id, title: n.title, note: n.note ?? '' }
    const e: ContextLinkInfo = { id: n.id, title: n.title, cwd: n.cwd ?? '' }
    if (n.agentId) e.agentId = n.agentId
    if (n.sessionId) e.sessionId = n.sessionId
    if (n.accountId) e.accountId = n.accountId
    return e
  }
  for (const e of edges) {
    const s = infoOf(e.source)
    const t = infoOf(e.target)
    if (s.sticky && t.sticky) continue
    if (s.sticky) {
      ;(map[t.id] ??= []).push(entryOf(s))
    } else if (t.sticky) {
      ;(map[s.id] ??= []).push(entryOf(t))
    } else {
      ;(map[s.id] ??= []).push(entryOf(t))
      ;(map[t.id] ??= []).push(entryOf(s))
    }
  }
  return map
}

/** Merge independently-derived maps without letting a later project overwrite a node's earlier
 * links. A node may participate in both a same-project link and one or more cross-project links;
 * object spread/assign would silently keep only the last array. Duplicate target ids collapse
 * because the read surface is node-oriented (two authored edges to the same node are one context). */
export function mergeContextLinkMaps(...maps: readonly ContextLinkMap[]): ContextLinkMap {
  const out: ContextLinkMap = {}
  for (const map of maps) {
    for (const [nodeId, entries] of Object.entries(map)) {
      const target = (out[nodeId] ??= [])
      const seen = new Set(target.map((entry) => entry.id))
      for (const entry of entries) {
        if (seen.has(entry.id)) continue
        target.push(entry)
        seen.add(entry.id)
      }
    }
  }
  return out
}

/**
 * Link maps built from serialized nodes + links. Same-project links in `activeProjectId` are
 * skipped because React Flow supplies their live edge set; cross-project links owned by the active
 * project are still included because they are deliberately off-canvas and never enter React Flow.
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
  projects: Array<{ id: string; nodes: CanvasNodeState[]; links?: Link[] }>,
  activeProjectId: string | null,
  sessionIdOf: (nodeId: string) => string | undefined,
  agentIdOf?: (nodeId: string) => string | undefined
): ContextLinkMap {
  const map: ContextLinkMap = {}
  const byId = new Map<string, CanvasNodeState>()
  for (const project of projects) {
    for (const node of project.nodes) byId.set(node.id, node)
  }
  for (const p of projects) {
    if (!p.links?.length) continue
    const links = p.id === activeProjectId
      ? p.links.filter((link) => link.source.ref === 'xnode' || link.target.ref === 'xnode')
      : p.links
    const edges = contextNodeEdges(links).filter((e) => byId.has(e.source) && byId.has(e.target))
    const infoOf = (id: string): LinkNodeInfo => {
      const n = byId.get(id)!
      const sticky = n.kind === 'sticky'
      const agentId = sticky ? undefined : (n.agentId ?? agentIdOf?.(id))
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
    const next = buildLinkMap(edges, infoOf)
    const merged = mergeContextLinkMaps(map, next)
    for (const key of Object.keys(map)) delete map[key]
    Object.assign(map, merged)
  }
  return map
}
