// The ONE reducer for canvas content (spec §2 "One reducer"). Every client applies a peer's
// mutation through this, and so does the Server Edition canvas authority — two implementations of
// "apply" is how an authority and its clients would silently diverge. Pure: no DOM, no fs.

import {
  applyCanvasMutation,
  applyEdgeMutationToScene,
  diffToMutations,
  isEdgeMutation,
  isWellFormedMutation
} from './canvas-mutations'
import { defaultKanbanFor } from './kanban-default-board'
import { applyKanbanOp, boardNodeIds, diffKanbanOps, isKanbanOp, sanitizeKanbanOp } from './kanban-ops'
import type { BridgeLink, CanvasMutation, CanvasNodeState, Project, ProjectKanban } from './types'

/**
 * The part of a project that `canvas:mut` addresses: the nodes, the two persisted edge lists and
 * the board. Everything else on a `Project` (name, colour, viewport, the machine-local half) is
 * outside the vocabulary and never touched by `applyCanvasOp`.
 */
export interface CanvasContent {
  nodes: CanvasNodeState[]
  bridges: BridgeLink[]
  ropes: BridgeLink[]
  /** Absent = the project's deterministic lazy default board (@shared/kanban-default-board). */
  kanban?: ProjectKanban
}

/** A project's content, with absent edge lists read as empty. The board stays absent when absent:
 *  "no board yet" and "the default board" read the same everywhere, and materializing one here
 *  would put a `kanban` block into a file nobody edited a board in. */
export function contentOf(p: Pick<Project, 'nodes' | 'bridges' | 'ropes' | 'kanban'>): CanvasContent {
  return {
    nodes: p.nodes ?? [],
    bridges: p.bridges ?? [],
    ropes: p.ropes ?? [],
    ...(p.kanban ? { kanban: p.kanban } : {})
  }
}

/**
 * Apply ONE mutation to canvas content. Returns the SAME object when the op changes nothing — a
 * duplicate cast, a remove of something already gone, a board op that leaves the board as it was —
 * so a caller can skip a flush (the authority) or a setState and the save it would schedule (the
 * projects store). Duplicates are the common case, not a corner: every Server Edition tab re-casts
 * what it receives, the authority's own published diff echoes back to it, and a reconnect replays.
 * "The same" is decided BY VALUE, because an upsert always arrives as a fresh object.
 *
 * Each family goes to its one applier:
 *  - node ops → `applyCanvasMutation`, which strips the exec-enabling fields a peer may not set and
 *    carries OUR values across the replace (@shared/node-exec);
 *  - edge ops → `applyEdgeMutationToScene` (one id is one edge, across both lists);
 *  - board ops → `sanitizeKanbanOp` then `applyKanbanOp`, against the lazy default when the project
 *    has no board yet.
 *
 * The guard is `isWellFormedMutation` — the reflector's shape verdict without its byte cap (see its
 * header for why a reducer must not re-apply a transport limit). A malformed op is a no-op.
 */
export function applyCanvasOp(c: CanvasContent, m: CanvasMutation, projectId: string): CanvasContent {
  if (!m || typeof m !== 'object') return c
  // A board op is sanitized ONCE: `sanitizeKanbanOp` is its whole shape verdict (what
  // `isWellFormedMutation` would have asked for it), and its result is the op applied.
  if (isKanbanOp(m)) {
    const op = sanitizeKanbanOp(m)
    if (!op) return c
    const before = c.kanban ?? defaultKanbanFor(projectId)
    const after = applyKanbanOp(c.kanban, op, projectId)
    return sameBoard(before, after) ? c : { ...c, kanban: after }
  }
  if (!isWellFormedMutation(m)) return c
  if (isEdgeMutation(m)) {
    const s = applyEdgeMutationToScene({ bridges: c.bridges, ropes: c.ropes }, m)
    return s.bridges === c.bridges && s.ropes === c.ropes ? c : { ...c, bridges: s.bridges, ropes: s.ropes }
  }
  const nodes = applyCanvasMutation(c.nodes, m)
  return sameNodes(c.nodes, nodes) ? c : { ...c, nodes }
}

/**
 * The ops that turn `prev` into `next`, for an OUTSIDE edit (a git pull, a hand edit) that the
 * authority must publish to every client as if someone had cast it. Every removal in it is real:
 * the board part is diffed with EVERY node id of both sides as live — the nodes, and every node a
 * card of the old board names — so a card whose node is gone from the new file has its removal cast,
 * a dead card the file carried included, unlike a client's publisher, which must not cast the lazy
 * prune of a card whose node op may simply not have arrived yet.
 *
 * A `next` with no board while `prev` had one diffs to the LAZY DEFAULT, not to nothing: a file with
 * no `kanban` block renders as the default board on every client, so an outside edit that removed
 * the block (a checkout from before the board was first edited) must turn every replica's board
 * back into that default — casting nothing would leave each client's old board in place over a file
 * that no longer has one.
 *
 * Batch order: node upserts, then edges (upserts before removes) and the board, then node removes —
 * a receiver applies one op at a time, so an edge or a card must never name a node that has not
 * arrived yet, and an edge-remove must land while its node still exists.
 */
export function diffContent(prev: CanvasContent, next: CanvasContent, projectId: string): CanvasMutation[] {
  const scene = diffToMutations(
    { nodes: prev.nodes, bridges: prev.bridges, ropes: prev.ropes },
    { nodes: next.nodes, bridges: next.bridges, ropes: next.ropes }
  )
  const all = new Set([...[...prev.nodes, ...next.nodes].map((n) => n.id), ...boardNodeIds(prev.kanban)])
  const nextBoard = next.kanban ?? (prev.kanban ? defaultKanbanFor(projectId) : undefined)
  const board = diffKanbanOps(prev.kanban, nextBoard, projectId, all)
  const nodeAdds = scene.filter((m) => m.op === 'upsert')
  const nodeRemoves = scene.filter((m) => m.op === 'remove')
  const edges = scene.filter((m) => m.op === 'edge-upsert' || m.op === 'edge-remove')
  return [...nodeAdds, ...edges, ...board, ...nodeRemoves]
}

/** Same node list, by value? Unchanged entries are compared by reference (O(1)); only a replaced
 *  entry — at most one per op — is compared structurally. */
function sameNodes(a: CanvasNodeState[], b: CanvasNodeState[]): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i] && !sameJson(a[i], b[i])) return false
  return true
}

/**
 * Same board, as every reader sees it? Keys the op left alone are the same reference (the applier
 * spreads the board), so only the one or two lists it rebuilt are compared structurally. One rule
 * beyond plain JSON equality: an ABSENT list and an EMPTY one are the same board — every reader
 * treats a missing `meta` / `labels` / `views` as empty (they are "tolerated as absent" by type),
 * and writing `"meta": []` into a file for the removal of something that was never there is not a
 * change anyone made.
 */
function sameBoard(a: ProjectKanban, b: ProjectKanban): boolean {
  if (a === b) return true
  const ra = a as unknown as Record<string, unknown>
  const rb = b as unknown as Record<string, unknown>
  for (const k of new Set([...Object.keys(ra), ...Object.keys(rb)])) {
    const va = ra[k]
    const vb = rb[k]
    if (Object.is(va, vb)) continue
    if (emptyOrAbsent(va) && emptyOrAbsent(vb)) continue
    if (!sameJson(va, vb)) return false
  }
  return true
}

const emptyOrAbsent = (v: unknown): boolean => v === undefined || (Array.isArray(v) && v.length === 0)

const isPlainObject = (v: unknown): v is Record<string, unknown> => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false
  const proto = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}

/**
 * Structural equality as JSON sees it: key order is irrelevant and a key whose value is `undefined`
 * is absent (`JSON.stringify` drops it — `carryLocalNodeExec` writes `execTrusted: undefined`).
 * Conservative in the only direction that matters: anything it cannot compare by value (a non-plain
 * object) compares by reference, so it can report "changed" for equal content — costing one
 * pointless write — but never "unchanged" for different content, which would strand an edit.
 */
function sameJson(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) if (!sameJson(a[i], b[i])) return false
    return true
  }
  if (!isPlainObject(a) || !isPlainObject(b)) return false
  const ka = Object.keys(a).filter((k) => a[k] !== undefined)
  const kb = Object.keys(b).filter((k) => b[k] !== undefined)
  if (ka.length !== kb.length) return false
  for (const k of ka) if (!Object.prototype.hasOwnProperty.call(b, k) || !sameJson(a[k], b[k])) return false
  return true
}
