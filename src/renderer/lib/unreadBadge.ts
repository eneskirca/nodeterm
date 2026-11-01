/**
 * The app-level unread count (macOS Dock badge, Windows taskbar overlay, tray) and the boot-time
 * cleanup of status entries that belong to no node.
 *
 * The agent-status table is keyed by node id and persisted, and it is NOT pruned when a node goes
 * away by any path other than the few delete funnels that call `remove` (an outside edit or a sync
 * that drops nodes, an in-place reload, …). Counting every `unread` entry in it therefore counted
 * nodes that no longer exist anywhere — measured on one machine: 633 entries, 20 unread, 1 of them
 * a live node; the Dock said 20 while the only tab badge said 1. The count is now taken over the
 * nodes the projects actually hold, the same set the tab badges count from.
 *
 * Pure, so the rules test without a store.
 */

interface StatusLike {
  unread?: boolean
  lastSeen?: { at: number }
}

interface ProjectLike {
  nodes: ReadonlyArray<{ id: string }>
}

/** The unread node ids as one primitive string — the selector shape the tab bar and the canvas
 *  subscribe with, so a working/waiting flip of any agent does not re-render them. */
export function unreadIdsSig(byId: Readonly<Record<string, StatusLike | undefined>>): string {
  let ids = ''
  for (const [id, st] of Object.entries(byId)) if (st?.unread) ids += `${id}|`
  return ids
}

/** Parse `unreadIdsSig` back into a set. */
export function unreadIdSet(sig: string): Set<string> {
  return new Set(sig.split('|').filter(Boolean))
}

/**
 * Unread nodes that exist in a project. Every project counts, CLOSED ones included: a closed
 * project keeps its sessions running and "go to node" reopens it, so its unread finish is still
 * one the user has not seen (the count has always been "across all projects"). What it never
 * counts is an entry whose node is in no project at all.
 */
export function countUnreadInProjects(
  projects: ReadonlyArray<ProjectLike>,
  unread: ReadonlySet<string>
): number {
  if (unread.size === 0) return 0
  const seen = new Set<string>()
  for (const p of projects) for (const n of p.nodes) if (unread.has(n.id)) seen.add(n.id)
  return seen.size
}

/** A status entry whose node is in no project is kept this long after its last hook event before
 *  the boot sweep drops it. The node may come back: an SSH project's offline copy can lag the host
 *  until the next reconcile, a git checkout can restore an older canvas, and a folder dropped from a
 *  rebuilt index keeps its node ids when it is opened again — dropping its entry would cost it its
 *  resume id. Deliberately EQUAL to `LAST_SEEN_MAX_AGE_MS` (state/agentStatus.ts, pinned by the
 *  test): an orphan goes on the same boot its clock ages out, and never earlier. The count no longer
 *  reads orphans, so a long window costs only a little storage. */
export const ORPHAN_STATUS_GRACE_MS = 90 * 24 * 60 * 60_000

/**
 * The status ids the boot sweep may drop: their node is in no project, and their last hook event
 * (if any was recorded) is older than the grace window. Returns `[]` — sweep nothing — unless the
 * projects can be trusted to be COMPLETE: an empty list (a fresh, failed or corrupt index load) or
 * any project whose content could not be read (an `unavailable` placeholder carries no nodes)
 * would make every one of its live nodes look orphaned.
 */
/**
 * Every node id across every project (closed ones included — a closed project keeps its nodes), or
 * `null` when the list cannot be trusted to be COMPLETE: an empty list (a fresh, failed or corrupt
 * index load) or any project whose content could not be read (an `unavailable` placeholder carries
 * no nodes) would make every one of its live nodes look orphaned. Every boot sweep of a per-node
 * localStorage table (agent status, node prompts) asks this ONE question, so none can judge an
 * incomplete load more boldly than the others.
 */
export function liveNodeIds(
  projects: ReadonlyArray<ProjectLike & { unavailable?: boolean }>
): Set<string> | null {
  if (projects.length === 0 || projects.some((p) => p.unavailable)) return null
  const live = new Set<string>()
  for (const p of projects) for (const n of p.nodes) live.add(n.id)
  return live
}

export function orphanStatusIds(
  byId: Readonly<Record<string, StatusLike | undefined>>,
  projects: ReadonlyArray<ProjectLike & { unavailable?: boolean }>,
  nowMs: number,
  graceMs: number = ORPHAN_STATUS_GRACE_MS
): string[] {
  const live = liveNodeIds(projects)
  if (!live) return []
  const out: string[] = []
  for (const [id, st] of Object.entries(byId)) {
    if (live.has(id)) continue
    const at = st?.lastSeen?.at
    if (typeof at === 'number' && nowMs - at < graceMs) continue
    out.push(id)
  }
  return out
}
