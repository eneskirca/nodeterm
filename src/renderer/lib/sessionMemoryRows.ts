// Turn core's session-memory rows into rows the panel can render: whose node is this, which
// project does it belong to, and is there a node at all?
//
// Pure and store-free (the caller passes the projects and the agent states), so the whole
// orphan/closed-project policy is unit-testable without mounting anything.

import type { AgentState } from '@shared/agents/normalize'
import type { Project, SessionMemoryRow } from '@shared/types'

export interface SessionMemoryView {
  row: SessionMemoryRow
  /** The node's title, or the session name when there is no node to name it. */
  title: string
  projectId: string | null
  projectName: string | null
  orphan: boolean
  /** Agent state for the dot. Always null for an orphan — see below. */
  state: AgentState | null
}

/**
 * Resolve each row against EVERY project, not just the active one.
 *
 * A CLOSED project is deliberately included: `closeProject` only sets `closed = true` and keeps
 * the project and its nodes on disk, so its sessions resolve to a real title. Treating them as
 * orphans would invite the user to kill sessions they deliberately parked.
 *
 * Order is preserved — core already sorted by `totalMb` descending, and re-sorting here would let
 * the panel and the report disagree.
 */
export function resolveSessionRows(
  rows: readonly SessionMemoryRow[],
  projects: readonly Project[],
  states: Readonly<Record<string, AgentState | undefined>>
): SessionMemoryView[] {
  const index = new Map<string, { projectId: string; projectName: string; title: string }>()
  for (const p of projects) {
    for (const n of p.nodes ?? []) {
      if (index.has(n.id)) continue
      index.set(n.id, {
        projectId: p.id,
        projectName: p.name,
        title: n.title?.trim() || n.id
      })
    }
  }

  return rows.map((row) => {
    const hit = index.get(row.nodeId)
    if (!hit) {
      // No node on any canvas. A state without a node is meaningless — the panel could not
      // explain a "working" dot on a row it cannot travel to — so it is dropped, not passed on.
      return {
        row,
        title: row.session,
        projectId: null,
        projectName: null,
        orphan: true,
        state: null
      }
    }
    return {
      row,
      title: hit.title,
      projectId: hit.projectId,
      projectName: hit.projectName,
      orphan: false,
      state: states[row.nodeId] ?? null
    }
  })
}

/** Grand total across the resolved rows — the panel header's number. */
export function totalMb(views: readonly SessionMemoryView[]): number {
  return views.reduce((sum, v) => sum + v.row.totalMb, 0)
}
