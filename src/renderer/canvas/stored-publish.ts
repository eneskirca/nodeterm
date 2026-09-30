// Casts the node and edge writes THIS renderer makes into a project's STORED copy — every own
// writer of the projects store (`applyOwnNodeMutation`, `appendCanvasLinks`, the sessions sidebar's
// rename / recolour / move / duplicate / close …), which call its publish hook
// (`setStoredCanvasPublishHook`). The node publisher cannot: it diffs React Flow, and a stored
// project's nodes enter React Flow only through a load, which it adopts as its baseline. So a ⌘⇧T
// reopen, a cold open, an off-canvas display node, a headless start's launch patch or a sidebar
// action on a project that is not on screen was never cast, and on a project a Server Edition
// canvas authority governs the next save overlay dropped it from disk (docs/hosted-team-relay.md).
//
// The rule lives here rather than in Canvas so it is tested without a canvas:
//  - ONLY A GOVERNED PROJECT. The authority is what drops an un-cast write; an ungoverned project's
//    stored write keeps riding the whole-file save exactly as before, so the desktop and every
//    unshared project cast nothing new, even with a teammate attached.
//  - NEVER THE PROJECT REACT FLOW HOLDS. That canvas is the node publisher's; a store write there is
//    a stale copy the next commit overwrites, and casting it would put a value on the wire this canvas
//    does not show. A project mid-switch (active, not yet installed) is still the store's, and its
//    load adopts what was cast here, so nothing is cast twice.
//  - THE SAME GATE AND THE SAME CAST as every other family (`shouldPublishFor`, `castFor`): the same
//    core, a role that may publish, the order's pending entry and the size guard. A held launch rides
//    the owner leg as usual.
import { useProjects, type StoredCanvasPublishHook } from '../state/projects'
import type { CanvasMutation } from '@shared/types'

export interface StoredCanvasPublisherDeps {
  /** The project React Flow holds right now (the epoch tag), or null. */
  renderedProjectId(): string | null
  /** Is `projectId` governed by a canvas authority (Canvas's followed governed set)? */
  isGoverned(projectId: string): boolean
  /** Canvas's one publish gate for `projectId`. */
  shouldPublish(projectId: string): boolean
  /** Canvas's one cast. `false` = not cast. */
  send(projectId: string, m: CanvasMutation): boolean
}

export function createStoredCanvasPublisher(deps: StoredCanvasPublisherDeps): StoredCanvasPublishHook {
  return (projectId, ops) => {
    if (deps.renderedProjectId() === projectId) return
    if (!deps.isGoverned(projectId) || !deps.shouldPublish(projectId)) return
    // Only now is the write diffed: a project that casts nothing never pays for it.
    for (const m of ops()) deps.send(projectId, m)
  }
}

/**
 * The RECEIVE side's write into a project's stored copy — Canvas's `applyToStored`, which calls this
 * with its `markDirty`. Applies ONE op through the store reducer (`applyCanvasOp`), which calls
 * neither publish hook (this module's, nor the board's `setProjectKanban` funnel), so an op that came
 * from someone else is never cast again as ours. It is the path for EVERY peer board op (the board
 * reads the store, not React Flow), for a peer's node or edge op on a project React Flow does not
 * hold, for the kanban publisher's local repair (ruling R2), and for the echo of our own last order
 * op (D5). `onChanged` runs only when the stored copy actually changed: the store writes nothing for
 * an op that changes nothing (a duplicate cast — every Server Edition tab re-casts what it receives —
 * or a remove of something already gone), so the project object's identity is the answer, and a
 * no-op schedules no save.
 */
export function applyToStoredCopy(projectId: string, mutation: CanvasMutation, onChanged: () => void): void {
  const store = useProjects.getState()
  const before = store.getProject(projectId)
  if (store.applyCanvasOp(projectId, mutation) && useProjects.getState().getProject(projectId) !== before) onChanged()
}
