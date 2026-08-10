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
