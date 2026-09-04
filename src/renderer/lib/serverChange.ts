/** What to do with a project THIS core wrote itself (`workspace:server-change`).
 *
 *  Server Edition canvas control runs a headless factory: an agent asks for `open-agent`, the
 *  factory appends the node and its `ctrl-…` rope to `project.ropes`, saves the file, and tells the
 *  browser what it wrote. Those writes used to ride `workspace:external-change` — the OUTSIDE-edit
 *  channel — where `decideExternalChange` compares the whole project shell, `ropes` included. So a
 *  spawn that landed while the canvas was dirty was classified `conflict` and raised the bar; the
 *  canvas is dirty almost every time (the paired `canvas:mut` marks it, agents spawn in bursts
 *  inside the 800 ms autosave debounce, and the bar itself SUSPENDS autosave, so once up it stayed
 *  up). "Keep my version" then serialized the browser's own edges over the file and dropped the
 *  ropes the server had just persisted, resurrecting cards the server had removed.
 *
 *  There is nothing to choose between here: both sides are this application. The disk copy is
 *  authoritative for what the server touched, the live canvas is authoritative for edits the user
 *  has made and not yet saved, and the two are disjoint in practice. So this is a three-way merge
 *  against `base` (the projects-store copy = our last-known DISK state, exactly what
 *  `decideExternalChange` uses it for), not a question.
 *
 *  Pure — no React, no store — so the whole decision is unit-testable without a canvas.
 */
import type { CanvasNodeState, Project } from '@shared/types'

/** The only part of a React Flow edge this merge reasons about. Ropes carry no stored colour or
 *  "waiting" flag (both are derived per render from the endpoints — see lib/edgeModel.ts), so an
 *  id and its two endpoints ARE the edge as far as persistence is concerned. */
export interface EdgeRef {
  id: string
  source: string
  target: string
}

export interface ServerChangeInput {
  /** Our last-known DISK state for this project: the projects-store copy. `undefined` = a project
   *  we have never loaded, in which case there is no baseline and everything incoming is new. */
  base: Project | undefined
  /** What the server just wrote and persisted. */
  incoming: Project
  /** Node ids React Flow currently holds — including ones created locally and not yet saved. */
  liveNodeIds: Iterable<string>
  /** The live rope set (`controlEdgesRef`), id/source/target only. */
  liveRopes: readonly EdgeRef[]
  /** The live context-bridge set (`linkEdgesRef`). */
  liveBridges: readonly EdgeRef[]
}

export interface ServerChangePlan {
  /** Nodes to adopt onto the live canvas — silently: the user's own agent asked for these. */
  added: CanvasNodeState[]
  /** The merged rope set to install. */
  ropes: EdgeRef[]
  /** The merged bridge set to install. */
  bridges: EdgeRef[]
  /** `false` ⇒ the merge changed nothing, so do NOT call `setControlEdges`: a fresh array of
   *  structurally identical edges is a re-render (and a new `displayEdges` pass) for nothing. */
  ropesChanged: boolean
  bridgesChanged: boolean
}

const edgeRef = (e: EdgeRef): EdgeRef => ({ id: e.id, source: e.source, target: e.target })

/** One merge, applied to ropes and to bridges alike — they are the same problem with two names,
 *  and a second copy of these five rules is a second place for them to drift. */
function mergeEdges(
  base: readonly EdgeRef[],
  incoming: readonly EdgeRef[],
  live: readonly EdgeRef[],
  nodeIds: ReadonlySet<string>
): { edges: EdgeRef[]; changed: boolean } {
  const baseIds = new Set(base.map((e) => e.id))
  const incomingIds = new Set(incoming.map((e) => e.id))
  const liveIds = new Set(live.map((e) => e.id))

  // In base but NOT in the file the server just wrote ⇒ the server removed it (it closed a node,
  // or dropped a rope). Everything else the canvas holds stays: an edge live but not in base is a
  // local addition nobody else has seen yet, and an edge in both base and incoming that the canvas
  // no longer holds is a local DELETION — re-adding it would undo the user's edit.
  const kept = live.filter((e) => !(baseIds.has(e.id) && !incomingIds.has(e.id)))
  // In the file but not in base ⇒ the server added it. Skip any id the canvas somehow already
  // holds: a duplicate React Flow edge id renders as one edge and breaks the next removal.
  const additions = incoming.filter((e) => !baseIds.has(e.id) && !liveIds.has(e.id))

  // An edge to a node that is not on the canvas is a dangling edge: React Flow drops it silently
  // at render, but it would be SAVED by the next autosave, so prune it here where the pruning is
  // visible. (The server's own removals arrive with their edges already gone; this catches the
  // cross case — a node deleted locally while the server added a rope to it.)
  const edges = [...kept, ...additions]
    .filter((e) => nodeIds.has(e.source) && nodeIds.has(e.target))
    .map(edgeRef)

  const changed =
    edges.length !== live.length || edges.some((e, i) => e.id !== live[i]!.id)
  return { edges, changed }
}

export function planServerChange(input: ServerChangeInput): ServerChangePlan {
  const { base, incoming } = input
  const live = new Set(input.liveNodeIds)
  const baseNodeIds = new Set((base?.nodes ?? []).map((n) => n.id))
  // Same rule as `decideExternalChange`: a node counts as added only when NEITHER the canvas nor
  // our last-known disk state has its id. The base check is what stops a node the user deleted
  // locally (and has not saved yet) from being resurrected by the file that still lists it.
  const added = incoming.nodes.filter((n) => !live.has(n.id) && !baseNodeIds.has(n.id))

  // Edges are pruned against the canvas as it will be AFTER the adoption, not as it is now —
  // otherwise the rope the server wrote with the node it just opened would be pruned as dangling
  // on the very payload that introduced both.
  const nodeIds = new Set(live)
  for (const n of added) nodeIds.add(n.id)

  const ropes = mergeEdges(base?.ropes ?? [], incoming.ropes ?? [], input.liveRopes, nodeIds)
  const bridges = mergeEdges(
    base?.bridges ?? [],
    incoming.bridges ?? [],
    input.liveBridges,
    nodeIds
  )

  return {
    added,
    ropes: ropes.edges,
    bridges: bridges.edges,
    ropesChanged: ropes.changed,
    bridgesChanged: bridges.changed
  }
}
