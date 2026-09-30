// Pure decisions that guard the renderer's whole-file workspace save. Canvas owns the refs and the
// timers; the RULES live here so they are unit-testable without React Flow, and so the reasoning
// behind them survives the next edit of an 8k-line component.

/**
 * May the live React Flow canvas be committed into the store under `activeProjectId`?
 *
 * Field bug 2026-08-10 (two projects + rapid tab switching wiped both canvases): the active id
 * comes from the zustand store, which updates SYNCHRONOUSLY on a tab switch, while the nodes array
 * React Flow holds is installed by a passive effect one render later. So the 800ms autosave timer
 * armed under project A can fire with the store already saying B and A's nodes still in hand — and
 * the commit then writes A's nodes (or the initial empty `useNodesState([])`) under B's id.
 *
 * `nodesProjectId` is the epoch tag: WHICH project's nodes React Flow currently holds — null before
 * the first load, and whenever the load effect bailed out without installing anything (unknown /
 * no active project), so a stale array can never be mistaken for the new project's truth.
 *
 * A mismatch is a transient the next render resolves, so it is skipped SILENTLY: never written, and
 * never written under the wrong id.
 */
export function canCommitCanvas(nodesProjectId: string | null, activeProjectId: string): boolean {
  if (!activeProjectId) return false
  return nodesProjectId === activeProjectId
}

/**
 * May a node be created on the canvas right now, charged to `activeProjectId`?
 *
 * Same epoch pairing as `canCommitCanvas`, opposite direction (issue #443): node creation resolves
 * cwd / account default / launch-command project from the ACTIVE project record, and inserts the
 * node into whatever React Flow is showing. If the two disagree — the store already says B while
 * A's nodes are still (or permanently: a bailed load effect) on screen — the node would come up on
 * A's canvas but RUN in B's folder under B's account and launch command. For an agent session that
 * is silent wrong-repo write access, so unlike the commit guard the caller must refuse LOUDLY
 * (notice + console), never skip silently: a create is a user gesture, and a dead click with no
 * message is how #443 stayed undiagnosable.
 */
export function canCreateOnCanvas(nodesProjectId: string | null, activeProjectId: string): boolean {
  return canCommitCanvas(nodesProjectId, activeProjectId)
}

/**
 * Does React Flow hold `projectId`'s canvas, so a peer's `canvas:mut` for it is applied LIVE? Else it
 * goes to the project's serialized copy in the store.
 *
 * Same epoch pairing, third direction (Task 2 review, risk E). The receive path used to ask only
 * "is `projectId` the active project?" — but during a switch the store already says B while React
 * Flow still holds A (or nothing, after a bail-out), and B's op was then applied to A's array: the
 * canvas ended on A's nodes plus the op, tagged B, and the next commit wrote them into B's file.
 * Live only when BOTH hold: the tag says React Flow has `projectId`'s nodes, and `projectId` is the
 * active one (a project we just switched away from was committed before the switch, and the load
 * that follows replaces its nodes — the store is the copy that survives). The tag must be the
 * LATEST installed epoch (`nodesProjectIdRef`, see useNodesEpoch): a tag that rewound to the
 * previous project in a render would send the op to the store AFTER the load had already read it.
 */
export function liveCanvasHolds(
  nodesProjectId: string | null,
  activeProjectId: string | null,
  projectId: string
): boolean {
  return projectId === activeProjectId && canCommitCanvas(nodesProjectId, projectId)
}

/**
 * May `dirty` be cleared now that a save has finished?
 *
 * Field bug 2026-08-10: `writeDisk` awaited the save and then cleared dirty unconditionally. A save
 * is not instant (an SSH mirror write takes seconds), and every edit made DURING that await is
 * absent from the snapshot that was handed over — yet it was marked clean. The watcher's
 * not-dirty branch then treated the next external change as safe to adopt and clobbered those
 * edits with a replaceProject + reload.
 *
 * `markDirty` bumps a generation counter. Capture it BEFORE building the snapshot and compare it
 * after the await: unchanged means the snapshot is still the whole truth. Otherwise dirty stays
 * set and the debounce re-saves.
 */
export function canClearDirty(capturedGeneration: number, currentGeneration: number): boolean {
  return capturedGeneration === currentGeneration
}
