import { useCallback, useRef, useState, type MutableRefObject } from 'react'

/**
 * React Flow's live node array and the project it belongs to, mirrored into refs as ONE pair.
 *
 * `nodesProjectIdRef` is the epoch tag `canCommitCanvas` checks before any commit writes the
 * live canvas into a project. It used to be a plain ref written only by the load effect, while
 * `nodesRef` was re-mirrored from `nodes` STATE on every render. The load effect sets both refs
 * synchronously and calls `setNodes(flow)` — a DefaultLane update, because it is issued from a
 * passive effect — and then writes zustand stores Canvas subscribes to (worktrees reset, the
 * keep-alive pool, …). Each such write is a SyncLane re-render, and a SyncLane render SKIPS the
 * pending DefaultLane `setNodes`: it rendered the PREVIOUS project's nodes and mirrored them into
 * `nodesRef` while the tag already named the incoming project. Any commit in that window
 * (a switch/close handler, an autosave) passed the guard and wrote project A's nodes into project
 * B's `.nodeterm/project.json` — field report 2026-09-26: an SSH project's seven nodes replaced a
 * local project's eighteen.
 *
 * The first fix carried the tag in React STATE beside the nodes, so a render's pair could never be
 * split. But the mirror still copied that pair into the refs UNCONDITIONALLY, so the window render
 * put (A's nodes, A) back into the refs right after the load effect had installed (B's nodes, B).
 * Consistent — no commit took it — and still wrong for everything that ACTS in that window: a peer's
 * op for B (the active project) was applied to A's array and `setNodes`'d as a plain value queued
 * AFTER the load's, so the canvas ended on A's nodes plus the op, tagged B, and the next commit wrote
 * them into B's file (Task 2 review, risk E).
 *
 * So the refs are now the LATEST pair, not the last rendered one:
 *  - the tag ref is written ONLY by `installEpoch`, synchronously, and a render never rewinds it;
 *  - a render copies its `nodes` into `nodesRef` only when that state CHANGED (a render that skipped
 *    a pending update must not undo a synchronous write — the edge refs in Canvas.tsx follow the
 *    same rule) AND the render belongs to the latest epoch (`renderedProjectId` equals the tag ref).
 *    The second condition is what a higher-priority update in the window needs: a discrete event's
 *    `setNodes(fn)` renders fn(A's nodes) under A's tag state, a CHANGED array that must not land
 *    under B's tag.
 *
 * `renderedProjectId` is the other half: the project THIS render's `nodes` belong to. Code that
 * pairs the ref tag with the rendered `nodes` state (a render-time publish, an effect keyed on
 * `nodes`) reads it instead — in the window the ref already names the incoming project while the
 * render still shows the outgoing one.
 */
export interface NodesEpoch<N> {
  nodesRef: MutableRefObject<N[]>
  nodesProjectIdRef: MutableRefObject<string | null>
  /** The project whose nodes THIS render's `nodes` state holds (null: none). For render-time pairing. */
  renderedProjectId: string | null
  /**
   * Declare that `flow` — already handed to `setNodes` in the SAME tick — is `projectId`'s canvas,
   * or `null` for "no project's canvas is mounted" (a bail-out). Updates the refs synchronously, so
   * a commit before the next render already sees the new pair, and queues the tag state so every
   * later render agrees with it.
   */
  installEpoch: (projectId: string | null, flow?: N[]) => void
}

/**
 * The state updater for a change computed off `nodesRef`: `next` when the state it lands on is still
 * `base` (the array the change was built from — the common case, identity kept), else `apply` run
 * again on whatever the state has become by then. A plain `setNodes(next)` overwrote every update
 * queued in between: a local edit not yet rendered, and — in the switch window — the load's own
 * `setNodes(flow)`. A second guard behind the epoch refs, not a replacement for them: the adopt and
 * the next event still build on `nodesRef`, so the ref must already be right.
 */
export function rebaseOnLatest<N>(base: N[], next: N[], apply: (ns: N[]) => N[]): (ns: N[]) => N[] {
  return (ns) => (ns === base ? next : apply(ns))
}

/**
 * The render-time mirror of one more piece of canvas state into its LATEST ref, under the two
 * conditions `useNodesEpoch` applies to `nodesRef`: copy only when the state CHANGED (a render that
 * skipped a pending update must not undo a synchronous write), and only when this render belongs to
 * the latest epoch (`inLatestEpoch` = the render's `renderedProjectId` equals the tag ref), so a
 * discrete update rendered on top of the OUTGOING project's state never lands under the incoming
 * project's tag. Canvas's two edge lists use it.
 */
export function mirrorLatest<T>(
  state: T,
  mirrored: MutableRefObject<T>,
  latest: MutableRefObject<T>,
  inLatestEpoch: boolean
): void {
  if (state === mirrored.current || !inLatestEpoch) return
  mirrored.current = state
  latest.current = state
}

export function useNodesEpoch<N>(nodes: N[]): NodesEpoch<N> {
  const [renderedProjectId, setRenderedProjectId] = useState<string | null>(null)
  const nodesRef = useRef<N[]>(nodes)
  const nodesProjectIdRef = useRef<string | null>(null)
  /** The last `nodes` state copied into `nodesRef`. */
  const mirroredRef = useRef<N[]>(nodes)
  if (nodes !== mirroredRef.current && renderedProjectId === nodesProjectIdRef.current) {
    mirroredRef.current = nodes
    nodesRef.current = nodes
  }
  const installEpoch = useCallback((projectId: string | null, flow?: N[]) => {
    if (flow) nodesRef.current = flow
    nodesProjectIdRef.current = projectId
    setRenderedProjectId(projectId)
  }, [])
  return { nodesRef, nodesProjectIdRef, renderedProjectId, installEpoch }
}
