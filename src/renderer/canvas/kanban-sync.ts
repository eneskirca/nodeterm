// Publishes board changes as item-level ops (spec §5). It hangs off the ONE store funnel,
// useProjects.setProjectKanban, so every board writer — the board, the card modal, the Omni board,
// node labels, the GitHub settings section — publishes without a call site of its own. The send is
// Canvas's canvas:mut send (`castFor`): it stamps src/seen, records the pending entry (canvas-order
// rules 1-3) and casts through the PROJECT's session (a relay tab's board edits go to its host, not
// the local core).
//
// Two rules live here rather than in Canvas, so they are tested without a canvas:
//  - PRUNE REMOVALS ARE NEVER CAST (spec §11.6). `diffKanbanOps` drops the removal of a card or meta
//    whose node is not live in that project: every board commit prunes dead cards against the LOCAL
//    node list, and a peer whose node op has not arrived yet would otherwise delete a fresh card for
//    everyone. `liveNodeIds` must therefore be that project's nodes and nothing else.
//  - THE CLEAN FORM IS CAST, AND KEPT (ruling R2). The reflector repairs what it relays (a label name
//    cut to its bound, an invalid rank dropped) and the sender drops its own echo as an ack, so a
//    board still holding the unrepaired value would show something no peer has, for good. The
//    publisher casts `sanitizeKanbanOp(op)` and, when that differs from what the board holds, applies
//    the clean form to the local store too — through the store REDUCER (`applyLocal`), never through
//    `setProjectKanban`, whose publish hook would cast it a second time.
import { diffKanbanOps, sanitizeKanbanOp } from '@shared/kanban-ops'
import type { CanvasMutation, KanbanOp, ProjectKanban } from '@shared/types'

export interface KanbanPublisherDeps {
  /** Cast one op for `projectId`. `false` = not cast (the op is dropped, and nothing is repaired). */
  send(projectId: string, m: CanvasMutation): boolean
  /** The node ids live in `projectId` — one project's, never a mix (see the prune rule above). */
  liveNodeIds(projectId: string): ReadonlySet<string>
  /** The publish gate for `projectId` — the SAME one the node publisher asks. */
  shouldPublish(projectId: string): boolean
  /** Apply a repaired op to the local store WITHOUT publishing it (the store reducer). */
  applyLocal(projectId: string, m: CanvasMutation): void
}

export function createKanbanPublisher(deps: KanbanPublisherDeps): {
  publish(projectId: string, prev: ProjectKanban | undefined, next: ProjectKanban | undefined): void
} {
  return {
    publish(projectId, prev, next) {
      if (!deps.shouldPublish(projectId)) return
      for (const op of diffKanbanOps(prev, next, projectId, deps.liveNodeIds(projectId))) {
        const clean = sanitizeKanbanOp(op)
        // Refused (an unaddressable id): the reflector refuses it too, so casting it would only cost
        // a pending entry for an echo that never comes. Nothing the UI produces is refused.
        if (!clean) continue
        if (deps.send(projectId, clean) && !sameOp(op, clean)) deps.applyLocal(projectId, clean)
      }
    }
  }
}

/** The same op as JSON sees it: key order does not matter and an `undefined`-valued key is absent. */
function sameOp(a: KanbanOp, b: KanbanOp): boolean {
  return stable(a) === stable(b)
}

function stable(v: unknown): string {
  return JSON.stringify(v, (_k, val: unknown) =>
    val && typeof val === 'object' && !Array.isArray(val)
      ? Object.fromEntries(Object.keys(val).sort().map((k) => [k, (val as Record<string, unknown>)[k]]))
      : val
  )
}

/**
 * The node ids a board write may treat as LIVE in one project — what the prune rule asks
 * (`liveNodeIds` above). One project's ids, never a mix:
 *  - a project React Flow does not hold (`rendered` null) answers from its stored nodes;
 *  - the project React Flow holds answers from React Flow, whose array is ahead of the stored copy.
 * The Omni board needs no case of its own: its active lane is fed from React Flow as well
 * (`globalKanbanLive`), so it prunes against the same set. (An earlier answer, React Flow ∩ store
 * while the Omni board was open, dated from when its lanes read the store; it left an explicit
 * Ungroup of a card whose node was not stored yet uncast, so peers kept the card and a governed
 * project's next overlaid save wrote it back.)
 */
export function boardLiveNodeIds(src: {
  rendered: readonly string[] | null
  stored: readonly string[]
}): ReadonlySet<string> {
  return new Set(src.rendered ?? src.stored)
}
