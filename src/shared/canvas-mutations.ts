// The canvas mutation vocabulary — ONE implementation, imported by every surface:
// the relay host (src/main/remote), the renderer (Canvas), and the canvas-sync reflector
// (src/core). Pure: no electron, no sockets, no disk.

import { isKanbanOp, sanitizeKanbanOp } from './kanban-ops'
import { carryLocalNodeExec, mutationTrustsLaunch, sanitizeInboundMutation, sanitizeInboundNode } from './node-exec'
import { groupsFirst } from './node-order'
import { REF_MAX_LEN } from './presence'
import type { BridgeLink, CanvasEdgeKind, CanvasMutation, CanvasNodeState, SceneMutation } from './types'

/**
 * A canvas as the publisher sees it: the nodes React Flow manages, plus the two PERSISTED edge
 * lists (`bridges` = context links, `ropes` = display-only "spawned by" lineage).
 *
 * The edges are in here for one reason, and it is a data-loss reason rather than a cosmetic one.
 * They ride the same whole-file `workspace.save` as the nodes but were NOT in the mutation
 * vocabulary, so an edge you drew never reached your teammate — and their next save, of a canvas
 * that never had it, DELETED it. (Same in reverse.) Syncing them is what makes the file the two
 * clients converge on the file they both agree with.
 */
export interface CanvasScene {
  nodes: CanvasNodeState[]
  bridges: BridgeLink[]
  ropes: BridgeLink[]
}

/** A bare node array read as a scene with no edges — the shape every pre-edge caller passes. */
export function asScene(s: CanvasScene | CanvasNodeState[]): CanvasScene {
  return Array.isArray(s) ? { nodes: s, bridges: [], ropes: [] } : s
}

/** Does this mutation address an edge (rather than a node)? */
export function isEdgeMutation(
  m: CanvasMutation
): m is Extract<CanvasMutation, { op: 'edge-upsert' | 'edge-remove' }> {
  return m.op === 'edge-upsert' || m.op === 'edge-remove'
}

function isEdgeKind(value: unknown): value is CanvasEdgeKind {
  return value === 'bridge' || value === 'rope'
}

/**
 * Ceiling on one mutation's serialized size. A node carries free text (a sticky's body, an
 * editor's path), and the whole object is reflected verbatim to every peer — so an unbounded one
 * is an N-way amplifier straight into everyone's WS send buffer (the same sink pty output rides).
 * 256 KB is orders of magnitude past any real node and cannot refuse a legitimate edit.
 */
export const MUTATION_MAX_BYTES = 256_000

/** An id off the wire: non-empty and bounded by the shared ref cap (node ids and project ids are
 *  short and generated — `term-ab12`, `project-1` — so this can never refuse a real one). Ids are
 *  REJECTED, never truncated: a truncated id would address the WRONG node on every peer. */
export function isRefId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= REF_MAX_LEN
}

/**
 * Shape + size guard: a client cast is untrusted input, and it is reflected to every peer as-is.
 * A malformed payload would wedge a peer's React Flow (applyCanvasMutation would upsert a node with
 * no id, or a NaN position, which React Flow cannot lay out); an oversized one would flood their
 * sockets.
 *
 * IT LIVES IN `shared`, NOT IN THE REFLECTOR, because BOTH ends need the same verdict. The reflector
 * drops what it refuses — silently, with no negative ack — so a publisher that cast it anyway would
 * advance its baseline (never retrying) and record a pending entry (deafening that node to its peers
 * for the whole pending TTL: a peer's `remove` landing in that window would be dropped, and the next
 * whole-file save would resurrect the node they deleted). The publisher therefore asks THIS function
 * first and, on a refusal, casts nothing, records nothing, and keeps the node in its baseline so the
 * next edit retries it. One predicate, one verdict, both ends.
 *
 * A kanban op (`kb-*`) is accepted iff `sanitizeKanbanOp` would keep it — its shape rules live in
 * ONE place (@shared/kanban-ops) — and it fits the same byte cap. Accepted is not the same as
 * clean: a repairable field (a label colour off the palette, an invalid rank) passes here and is
 * repaired by `sanitizeCanvasMutation` before anyone applies or reflects it.
 */
export function isCanvasMutation(value: unknown): value is CanvasMutation {
  return checkMutation(value, true)
}

/**
 * `isCanvasMutation` WITHOUT the byte cap — the guard of the one reducer (`applyCanvasOp`,
 * @shared/canvas-content). Same shape verdict, field for field (one implementation, so the two
 * cannot drift); only `MUTATION_MAX_BYTES` is skipped.
 *
 * The cap is a TRANSPORT rule: it bounds what one cast pushes into every peer's socket, and both
 * ends of the wire already apply it (the reflector refuses, the publisher never casts). An op that
 * reaches a reducer either passed it or never travelled at all — the projects store takes this
 * client's OWN writes to a background project through the same reducer (cold open, a canvas-control
 * sticky write, a pending-launch patch), and silently dropping one of those because its node is big
 * would lose the user's edit while the caller reports success. The shape half is what keeps a
 * malformed op from wedging a canvas, and that half stays.
 */
export function isWellFormedMutation(value: unknown): value is CanvasMutation {
  return checkMutation(value, false)
}

function checkMutation(value: unknown, sized: boolean): value is CanvasMutation {
  if (!value || typeof value !== 'object') return false
  const fits = (x: unknown): boolean => !sized || withinSizeLimit(x)
  const m = value as { op?: unknown; id?: unknown; node?: unknown; kind?: unknown; edge?: unknown }
  if (isKanbanOp(m)) return sanitizeKanbanOp(value) !== null && fits(value)
  // Removes are held to the byte cap too: the reflector rebuilds them from their known fields
  // (`sanitizeCanvasMutation`), but an 8 MiB frame must not reach even that far, nor the authority's
  // op log.
  if (m.op === 'remove') return isRefId(m.id) && fits(value)
  if (m.op === 'edge-remove') return isEdgeKind(m.kind) && isRefId(m.id) && fits(value)
  if (m.op === 'edge-upsert') {
    if (!isEdgeKind(m.kind)) return false
    const edge = m.edge as { id?: unknown; source?: unknown; target?: unknown } | undefined
    if (!edge || typeof edge !== 'object') return false
    // All three ids are ADDRESSES — an edge with a truncated endpoint would attach to the wrong
    // node on every peer — so they are rejected rather than capped, exactly like a node id.
    if (!isRefId(edge.id) || !isRefId(edge.source) || !isRefId(edge.target)) return false
    return fits(m)
  }
  if (m.op !== 'upsert') return false
  const node = m.node as { id?: unknown; position?: { x?: unknown; y?: unknown } } | undefined
  if (!node || typeof node !== 'object') return false
  if (!isRefId(node.id)) return false
  const pos = node.position
  if (!pos || typeof pos !== 'object') return false
  if (!Number.isFinite(pos.x) || !Number.isFinite(pos.y)) return false
  return fits(m)
}

/**
 * The CLEAN form of an accepted mutation — what a reflector reflects and an authority applies, so
 * every peer receives the repaired op rather than each repairing the raw one on its own:
 *  - a node `upsert` loses the exec-enabling fields (`sanitizeInboundMutation`, @shared/node-exec).
 *    `keepLaunch` keeps its held launch (`pendingLaunch`), and is for the reflector alone, for an
 *    OWNER sender: it then forwards that launch to owner clients only (core/canvas-sync.ts
 *    `fanOutMutation`);
 *  - a kanban op is rebuilt by `sanitizeKanbanOp` (unknown fields dropped, colour / rank / priority /
 *    dueAt / category repaired or dropped), KEEPING the stamp fields `src` / `seq` / `seen` — the
 *    order still has to judge it;
 *  - a `remove`, `edge-remove` or `edge-upsert` is rebuilt from the fields its op defines (an edge is
 *    its three ids), with the same stamp fields: whatever else a cast carries would otherwise be
 *    forwarded to every client and kept in the authority's op log (D1).
 * `null` = refused (a kanban op `sanitizeKanbanOp` refuses). The caller still runs
 * `isCanvasMutation` first for the shape and the size cap; this adds no check of its own.
 */
export function sanitizeCanvasMutation(m: CanvasMutation, keepLaunch = false): CanvasMutation | null {
  if (isKanbanOp(m)) {
    const clean = sanitizeKanbanOp(m)
    if (!clean) return null
    return withStamp({ ...clean }, m)
  }
  if (m.op === 'remove') return withStamp({ op: 'remove', id: m.id }, m)
  if (m.op === 'edge-remove') return withStamp({ op: 'edge-remove', kind: m.kind, id: m.id }, m)
  if (m.op === 'edge-upsert') {
    const { id, source, target } = m.edge
    return withStamp({ op: 'edge-upsert', kind: m.kind, edge: { id, source, target } }, m)
  }
  return sanitizeInboundMutation(m, keepLaunch)
}

/** Copy the order's stamp fields (`src`, `seq`, `seen`) from `from` onto a rebuilt op; an absent one
 *  stays absent. `origin` is deliberately not among them: only the core adds it, per recipient. */
function withStamp(out: CanvasMutation, from: CanvasMutation): CanvasMutation {
  if (from.src !== undefined) out.src = from.src
  if (from.seq !== undefined) out.seq = from.seq
  if (from.seen !== undefined) out.seen = from.seen
  return out
}

function withinSizeLimit(m: unknown): boolean {
  try {
    // The wire form is JSON on the server and a structured clone on the desktop; either way this
    // is a faithful measure of what would be pushed to every peer. A value that cannot even be
    // stringified (BigInt, a cycle) is not something we should be reflecting.
    return JSON.stringify(m).length <= MUTATION_MAX_BYTES
  } catch {
    return false
  }
}

/**
 * Same top-level VALUE? A shallow compare, deliberately: it never reads the CONTENT of a string
 * field, which is the whole point (the free text is what makes an oversized node expensive).
 *
 * Sound because of how the snapshot is built: `flowToNodeStates` rebuilds the node object on every
 * publish but passes each field through BY REFERENCE (`text: n.data.text`, `tags: n.data.tags`, …),
 * so an untouched field is the SAME reference and `Object.is` settles it in O(1). `position` and
 * `size` are freshly built objects of numbers, so they are compared field-wise.
 *
 * Conservative in the only direction that matters: equal references ⇒ equal content, so it can never
 * report "unchanged" for a node that changed (which would strand an edit). The reverse (an equal
 * value rebuilt as a new reference) merely costs one honest re-validation — what happens today.
 */
function sameNodeValue(a: CanvasNodeState, b: CanvasNodeState): boolean {
  if (a === b) return true
  const ka = Object.keys(a)
  if (ka.length !== Object.keys(b).length) return false
  const ra = a as unknown as Record<string, unknown>
  const rb = b as unknown as Record<string, unknown>
  for (const k of ka) {
    const va = ra[k]
    const vb = rb[k]
    if (Object.is(va, vb)) continue
    if (k !== 'position' && k !== 'size') return false
    // The two geometry objects: plain records of numbers, rebuilt on every snapshot.
    const oa = va as Record<string, number> | undefined
    const ob = vb as Record<string, number> | undefined
    if (!oa || !ob) return false
    const gk = Object.keys(oa)
    if (gk.length !== Object.keys(ob).length) return false
    for (const g of gk) if (!Object.is(oa[g], ob[g])) return false
  }
  return true
}

/**
 * The PUBLISHER's guard: `isCanvasMutation`'s verdict, with a refusal REMEMBERED per node.
 *
 * `isCanvasMutation` answers the size question by serializing the whole node, and a refused node is
 * deliberately re-emitted on every publish (that is what makes the sticky sync the instant the user
 * trims it — see `rebaseRefused` in canvas-publish). A drag publishes at ~20 Hz. So the ONE node that
 * is already pathological — a sticky someone pasted a document into — was being stringified 20 times
 * a second, at a cost proportional to its size, for as long as it stayed oversized. The pathological
 * case must not also be the expensive one.
 *
 * The memo holds the refused node itself and re-checks only when that node's value actually changes
 * (`sameNodeValue`: reference-shallow, so it never touches the big string). Behaviour is unchanged:
 * the same verdict for every input, the refusal is re-paid the moment the node is edited, and the
 * trimmed sticky casts immediately (its entry is dropped as soon as it passes). Bounded by the number
 * of oversized nodes on the canvas — in practice zero or one, and their memory is the node the canvas
 * already holds.
 *
 * The REFLECTOR keeps calling the plain `isCanvasMutation`: its input is untrusted, freshly decoded
 * off the wire for every client, so nothing there would ever hit a memo and the map would grow with
 * whatever ids a client cared to invent. One predicate, one verdict, both ends — this only caches the
 * one end that asks the same question about the same node over and over.
 */
export function createMutationGuard(): (m: CanvasMutation) => boolean {
  const refused = new Map<string, CanvasNodeState>()
  return (m) => {
    // A `remove` and both edge ops are a couple of dozen bytes (ids only): nothing to amortize,
    // and nothing that can grow. Only a node `upsert` carries free text.
    if (!m || typeof m !== 'object' || (m as { op?: unknown }).op !== 'upsert')
      return isCanvasMutation(m)
    const node = (m as { node?: CanvasNodeState }).node
    if (!node || typeof node !== 'object' || typeof node.id !== 'string') return isCanvasMutation(m)

    const last = refused.get(node.id)
    if (last && sameNodeValue(last, node)) return false // already refused, and nothing has changed

    const ok = isCanvasMutation(m)
    if (ok) refused.delete(node.id)
    else refused.set(node.id, node)
    return ok
  }
}

/**
 * Apply a single mutation to a node list, returning a NEW array (the input is never mutated).
 * `upsert` replaces the node with the matching id, or appends it if absent; `remove` filters
 * out the node with the given id. An upsert that appends, or that changes the node's `parentId`,
 * re-sorts the list parent-first (`groupsFirst`, @shared/node-order); any other upsert keeps the
 * order it found.
 *
 * Every caller of this is applying a mutation that came from SOMEONE ELSE (a canvas-sync peer, a
 * relay client), so the node goes through `sanitizeInboundNode` first: the exec-enabling fields
 * (`shell`, `ssh.extraArgs`) are per-machine settings that nobody else gets to write, and letting
 * them into the live node array is how a peer laundered them into the machine-local — "trusted" —
 * workspace.json on the next save (@shared/node-exec).
 */
export function applyCanvasMutation(
  states: CanvasNodeState[],
  m: CanvasMutation
): CanvasNodeState[] {
  // An edge mutation addresses neither of these nodes. Returned UNCHANGED (by reference, so a
  // caller's `next === prev` short-circuit still fires) rather than trusted to be pre-filtered:
  // every caller here is applying something that came off the wire, and a silent no-op is the only
  // safe reading of "this list is not what that mutation is about".
  if (isEdgeMutation(m)) return states
  if (m.op === 'remove') return states.filter((n) => n.id !== m.id)
  // A kanban op addresses the board, not the node list (its `nodeId` names a CARD) — same no-op.
  if (m.op !== 'upsert') return states
  // A held launch (`pendingLaunch`) is machine-local too; only a core-vouched owner copy
  // (`origin: 'core'`) may set or clear it (@shared/node-exec).
  const trust = mutationTrustsLaunch(m)
  const node = sanitizeInboundNode(m.node, trust)
  const idx = states.findIndex((n) => n.id === node.id)
  // Append, then re-sort parent-first (@shared/node-order) — exactly where the live React Flow
  // apply (`applyMutationToFlow`) re-sorts: on an append and on a `parentId` change, and nowhere
  // else, so an upsert that does neither keeps the order it found. This is the array the Server
  // Edition canvas authority WRITES for a governed project, so without it grouping would persist
  // a frame after its children and break the downgrade contract a normal save keeps.
  if (idx === -1) return groupsFirst([...states, node])
  const next = states.slice()
  // …and OUR exec fields stay on the node the upsert replaces: they are per-machine, so a peer
  // dragging our ssh terminal must not hand it back stripped of the jump host we configured.
  next[idx] = carryLocalNodeExec(states[idx], node, trust)
  return states[idx].parentId === next[idx].parentId ? next : groupsFirst(next)
}

/**
 * Apply a mutation THIS renderer authored itself (a cold open into a background project, the
 * headless start's outcome patch, an off-canvas display node). Nothing is stripped or carried: the
 * write is ours, so its `pendingLaunch` is the one to keep — and an upsert without one CLEARS it,
 * which the inbound path above can never do (it carries the old one across). Never call this with a
 * mutation that arrived from anywhere else; that is what `applyCanvasMutation` is for.
 */
export function applyOwnCanvasMutation(
  states: CanvasNodeState[],
  m: CanvasMutation
): CanvasNodeState[] {
  if (m.op === 'remove') return states.filter((n) => n.id !== m.id)
  // An edge or board op addresses no node in this list: the same no-op as `applyCanvasMutation`.
  if (m.op !== 'upsert') return states
  const idx = states.findIndex((n) => n.id === m.node.id)
  if (idx === -1) return [...states, m.node]
  const next = states.slice()
  next[idx] = m.node
  return next
}

/**
 * Apply one EDGE mutation to one of a project's edge lists, returning a NEW array when it changes
 * anything (the input is never mutated). A mutation for the other kind — or for a node — and one
 * that changes nothing (a remove of an edge we lack, an upsert of the edge we hold) leave the list
 * untouched, by reference, so the caller's `next === prev` check still short-circuits. For the
 * whole scene (one id is one edge, across both lists) use `applyEdgeMutationToScene`.
 *
 * There is nothing to sanitize here the way `sanitizeInboundNode` sanitizes a node: an edge is
 * three ids and carries no exec-enabling field, and `isCanvasMutation` has already bounded all
 * three. What it CAN carry is a dangling endpoint (the peer deleted that node a moment ago) —
 * deliberately not filtered here, because this function does not know the node list. Canvas's
 * existing prune effects drop a dangling edge on the next node change, which is the same treatment
 * a locally-drawn edge gets.
 */
export function applyEdgeMutation(
  edges: BridgeLink[],
  kind: CanvasEdgeKind,
  m: CanvasMutation
): BridgeLink[] {
  if (!isEdgeMutation(m) || m.kind !== kind) return edges
  if (m.op === 'edge-remove') {
    const next = edges.filter((e) => e.id !== m.id)
    return next.length === edges.length ? edges : next
  }
  const edge: BridgeLink = { id: m.edge.id, source: m.edge.source, target: m.edge.target }
  const idx = edges.findIndex((e) => e.id === edge.id)
  if (idx === -1) return [...edges, edge]
  // The edge we already hold, unchanged: same reference, so a duplicate cast (every Server Edition
  // tab re-casts a server-written edge) costs a receiver no setState, no markDirty, no save.
  const held = edges[idx]
  if (held.source === edge.source && held.target === edge.target) return edges
  const next = edges.slice()
  next[idx] = edge
  return next
}

/** Apply an edge op to BOTH lists: one id is one edge, so an upsert of kind K removes that id from
 *  the other kind's list, and a remove drops it from both.
 *
 *  `mutationKey` leaves `kind` out of the key for the same reason, so the ordering already treats a
 *  bridge and a rope with one id as one thing; applying per kind (`applyEdgeMutation` alone) would
 *  let the two lists each hold that id. A list the op does not change is returned BY REFERENCE, so
 *  a caller can tell a no-op (`out.bridges === scene.bridges && out.ropes === scene.ropes`). */
export function applyEdgeMutationToScene(
  scene: { bridges: BridgeLink[]; ropes: BridgeLink[] },
  m: CanvasMutation
): { bridges: BridgeLink[]; ropes: BridgeLink[] } {
  if (!isEdgeMutation(m)) return scene
  const id = m.op === 'edge-remove' ? m.id : m.edge.id
  const drop = (list: BridgeLink[]) => {
    const next = list.filter((e) => e.id !== id)
    return next.length === list.length ? list : next
  }
  if (m.op === 'edge-remove') return { bridges: drop(scene.bridges), ropes: drop(scene.ropes) }
  return m.kind === 'bridge'
    ? { bridges: applyEdgeMutation(scene.bridges, 'bridge', m), ropes: drop(scene.ropes) }
    : { bridges: drop(scene.bridges), ropes: applyEdgeMutation(scene.ropes, 'rope', m) }
}

/** Stable JSON stringify (keys sorted) so deep-equality is order-independent. */
function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, val) => {
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      const sorted: Record<string, unknown> = {}
      for (const k of Object.keys(val as Record<string, unknown>).sort()) {
        sorted[k] = (val as Record<string, unknown>)[k]
      }
      return sorted
    }
    return val
  })
}

/** The edge half of `diffToMutations`, for one kind. Same shape: changed/added → upsert (in
 *  next-array order), dropped → remove (in prev-array order). An edge is three short ids, so the
 *  compare is a plain field compare rather than a stringify.
 *
 *  "Dropped" means gone from the WHOLE next scene (`liveIds` = both lists), not just from this
 *  kind's list: one id is one edge (applyEdgeMutationToScene), so an id that moved to the other list
 *  is covered by that list's upsert — and a remove cast after it would delete it from both. */
function diffEdges(
  prev: BridgeLink[],
  next: BridgeLink[],
  kind: CanvasEdgeKind,
  liveIds: ReadonlySet<string>,
  upserts: SceneMutation[],
  removes: SceneMutation[]
): void {
  const prevById = new Map(prev.map((e) => [e.id, e]))
  for (const edge of next) {
    const before = prevById.get(edge.id)
    if (!before || before.source !== edge.source || before.target !== edge.target) {
      upserts.push({ op: 'edge-upsert', kind, edge })
    }
  }
  for (const edge of prev) {
    if (!liveIds.has(edge.id)) removes.push({ op: 'edge-remove', kind, id: edge.id })
  }
}

/**
 * Diff two canvas snapshots into the minimal mutation list (deterministic): an `upsert` for every
 * node that was added or changed (deep-equal via stable stringify), a `remove` for every node that
 * was dropped, and the same for both edge lists. Never throws on normal input.
 *
 * A bare node array is accepted as a scene with no edges, so every caller that predates edge sync
 * keeps its exact behaviour.
 *
 * THE ORDER OF THE BATCH IS LOAD-BEARING: additions before removals, and within each half nodes
 * before edges. A peer applies these one at a time, so an `edge-upsert` naming a node that has not
 * arrived yet would draw an edge into nothing (React Flow drops it and warns) — and an
 * `edge-remove` for an edge whose node is removed in the SAME batch has to land while the edge is
 * still there. Adds: nodes, then edges. Removes: edges, then nodes.
 */
export function diffToMutations(
  prev: CanvasScene | CanvasNodeState[],
  next: CanvasScene | CanvasNodeState[]
): SceneMutation[] {
  const a = asScene(prev)
  const b = asScene(next)
  const upserts: SceneMutation[] = []
  const removes: SceneMutation[] = []
  const prevById = new Map(a.nodes.map((node) => [node.id, node]))
  const nextIds = new Set(b.nodes.map((node) => node.id))

  // upserts: added or changed nodes (in next-array order for determinism).
  for (const node of b.nodes) {
    const before = prevById.get(node.id)
    if (!before || stableStringify(before) !== stableStringify(node)) {
      upserts.push({ op: 'upsert', node })
    }
  }
  // removes: nodes present in prev but gone from next (in prev-array order).
  for (const node of a.nodes) {
    if (!nextIds.has(node.id)) removes.push({ op: 'remove', id: node.id })
  }

  const edgeUpserts: SceneMutation[] = []
  const edgeRemoves: SceneMutation[] = []
  const liveEdgeIds = new Set([...b.bridges, ...b.ropes].map((e) => e.id))
  diffEdges(a.bridges, b.bridges, 'bridge', liveEdgeIds, edgeUpserts, edgeRemoves)
  diffEdges(a.ropes, b.ropes, 'rope', liveEdgeIds, edgeUpserts, edgeRemoves)

  return [...upserts, ...edgeUpserts, ...edgeRemoves, ...removes]
}
