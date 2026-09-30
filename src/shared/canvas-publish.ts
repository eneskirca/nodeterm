// Canvas sync — the emitting side.
//
// The renderer holds its nodes in React Flow (the single live source of truth). This publisher turns
// successive serialized snapshots of that list into the minimal CanvasMutation stream for the peers:
//
//   publish(states)                  → diff vs the last published snapshot, send each mutation
//   publish(states, {throttle:true}) → a drag frame: at most one send per PUBLISH_INTERVAL_MS
//   adopt(states)                    → LOOP GUARD: take the snapshot as baseline, send NOTHING
//
// Snapshots, NOT React Flow change-lists: a rename, a color pick, a collapse and an add all reach the
// nodes array through direct setNodes(...) calls that never pass through onNodesChange, so a
// change-list-driven publisher would silently fail to sync half the edits. Diffing the serialized
// snapshot catches every one of them, whatever path produced it.
//
// `adopt` is what stops an infinite echo: when a mutation arrives FROM a peer, Canvas applies it and
// adopts the result, so the React effect that fires for the resulting `nodes` change diffs to nothing.
// (Same shape as the existing `loadingRef` suppression that keeps a programmatic project load from
// marking the project dirty.) Without it, A's mutation applied on B would be re-published by B to C
// (and back at A) forever. The other half of the anti-loop is canvas-order, which never *applies* a
// client's own echoed-back mutation in the first place.
//
// Pure + DOM-free (vitest runs in the node environment): only setTimeout, no React, no window.

import { stripCastNodeExec } from './node-exec'
import { asScene, diffToMutations, type CanvasScene } from './canvas-mutations'
import { mutationKey, mutationNodeId } from './canvas-order'
import type { BridgeLink, CanvasMutation, CanvasNodeState } from './types'

/** ~20 Hz while dragging — the same budget the presence cursor stream uses. */
export const PUBLISH_INTERVAL_MS = 50

/**
 * A snapshot, or a thunk that produces one.
 *
 * The thunk is what makes the solo gate below actually free. Serializing the canvas is the
 * expensive half of publishing (`flowToNodeStates` + `stableStringify` per node), and the caller
 * runs inside a React effect keyed on the nodes array — i.e. once per DRAG FRAME. Passing an array
 * meant that cost was paid before the publisher could decide it had nothing to do with it; passing
 * a thunk lets it be paid only when a snapshot is actually going to be diffed or sent.
 *
 * A thunk MUST be pure and must close over the state as of the call (React Flow hands us a fresh
 * immutable array per change, so `() => serialize(nodes)` satisfies this): the publisher may
 * resolve it later — at the trailing edge of a throttle window, or when the first peer arrives.
 */
export type CanvasSnapshot =
  | CanvasScene
  | CanvasNodeState[]
  | (() => CanvasScene | CanvasNodeState[])

export interface CanvasPublisher {
  /** Diff `next` against the last published snapshot and send the mutations.
   *  `throttle` (drag frames) coalesces to at most one send per PUBLISH_INTERVAL_MS.
   *  With no peer attached (`shouldPublish` false) this DEGRADES TO adopt(): the snapshot becomes
   *  the baseline and nothing is diffed or sent — a solo user pays nothing for team sync. */
  publish(next: CanvasSnapshot, opts?: { throttle?: boolean }): void
  /** Take `next` as the new baseline WITHOUT sending — the loop guard (a peer's mutation, or a
   *  programmatic project load). The next diff against it is empty, except for what is still owed
   *  and still on the adopted scene (a refused node and the edges held for it), which stays owed —
   *  see `adoptBaseline`. */
  adopt(next: CanvasSnapshot): void
  /** Send any coalesced drag frame immediately (drag settle / unmount). */
  flush(): void
  dispose(): void
  /** The node ids whose most recent cast was REFUSED (`send` → false: the size guard, no active
   *  project) and is still owed — the node half of the refusal rebase. An `edge-upsert` naming one
   *  of them is held back (see `emit`), because the peer does not have that node. A copy. */
  refusedNodeIds(): ReadonlySet<string>
  /** Is anything REFUSED still owed — a node (`refusedNodeIds`) or an edge whose own cast was
   *  refused? A caller that just removed the reason for a refusal (the re-creation gate's remove was
   *  acked) re-publishes only when this says there is something to cast. */
  hasOwed(): boolean
}

/**
 * The baseline after a cast was REFUSED (`send` returned false: an oversized sticky the reflector
 * would drop at ingest, or no active project to cast into). The refused nodes keep their PREVIOUS
 * baseline entry — as if the edit had never been published — so the very next diff emits them again
 * and the edit syncs the moment it becomes castable (the user trims the sticky, a project opens).
 * Advancing the baseline over them, which is what the publisher used to do, meant the edit was
 * dropped SILENTLY AND FOREVER: the peers never saw it and nothing ever retried it.
 *
 * Per NODE, not per snapshot: everything else in the same snapshot was cast and must not be re-sent.
 * A refused node that had no previous entry is simply left OUT of the baseline (so it re-diffs as an
 * add); a refused `remove` keeps its node in the baseline (so the remove is re-emitted).
 */
function rebaseList<T extends { id: string }>(
  prev: T[],
  next: T[],
  refused: Set<string>,
  prefix: string
): T[] {
  const prevById = new Map(prev.map((n) => [n.id, n]))
  const nextIds = new Set(next.map((n) => n.id))
  const out: T[] = []
  for (const n of next) {
    if (!refused.has(prefix + n.id)) {
      out.push(n)
      continue
    }
    const before = prevById.get(n.id)
    if (before) out.push(before)
  }
  for (const n of prev) {
    if (refused.has(prefix + n.id) && !nextIds.has(n.id)) out.push(n) // a refused remove: still owed
  }
  return out
}

/** The refusal rebase, over the whole scene. `refused` holds `mutationKey`s, so the two edge lists
 *  share the `e:` prefix — an edge id is one edge whichever list it is in (see mutationKey). */
function rebaseRefused(prev: CanvasScene, next: CanvasScene, refused: Set<string>): CanvasScene {
  return {
    nodes: rebaseList(prev.nodes, next.nodes, refused, 'n:'),
    bridges: rebaseList(prev.bridges, next.bridges, refused, 'e:'),
    ropes: rebaseList(prev.ropes, next.ropes, refused, 'e:')
  }
}

/** The empty baseline — a scene, so the first diff after mount is against a real shape. */
const EMPTY_SCENE: CanvasScene = { nodes: [], bridges: [], ropes: [] }

/**
 * @param send        casts one mutation (already stamped with `src`). Returning `false` means the
 *                    cast did NOT happen (refused / no project): the mutation is then owed — its
 *                    node keeps its old baseline entry and the next publish retries it. Any other
 *                    return value (including `undefined`) means it was cast.
 * @param opts.src    this client's publisher tag, stamped onto every mutation it sends, so it can
 *                    recognize its own echo coming back (see canvas-order). Omitted in tests that
 *                    only care about the diff.
 * @param opts.shouldPublish
 *   THE SOLO GATE. When it returns false — nobody else is attached — publish() takes the snapshot
 *   as the baseline and returns: no stableStringify of every node (~1.4 ms at 100 nodes, and the
 *   `nodes` array changes at 60 Hz during a drag), no IPC cast, no work in the main process. A solo
 *   user must not pay for a feature they cannot use. The baseline still tracks the canvas, so the
 *   instant a peer joins the very next edit diffs correctly against what is actually on screen —
 *   there is no resync step and no missed mutation. Default: always publish.
 *
 *   With a thunk snapshot the gate covers the SERIALIZATION too, which is where the cost actually
 *   was: a solo baseline is kept UNRESOLVED (just the thunk), and the first publish that has a peer
 *   resolves it to diff against. Same baseline, same mutations — the work is merely deferred to the
 *   moment something reads it, which for a solo user is never.
 */
/**
 * THE publish rule, one definition (Canvas's one gate calls it, as collab-sync's `shouldPublish`):
 * publish when a teammate is attached, OR when the project is governed by a canvas authority. A
 * governed project's content is written only from the ops the authority hears
 * (docs/hosted-team-relay.md), so a solo edit there that is not published is never saved.
 * Positional and allocation-free, the peer check first: the gate is asked at ~20 Hz during a drag.
 */
export function shouldPublishCanvas(
  hasPeers: boolean,
  governed: { has(projectId: string): boolean },
  projectId: string
): boolean {
  return hasPeers || governed.has(projectId)
}

export function createCanvasPublisher(
  send: (m: CanvasMutation) => void | boolean,
  opts: { intervalMs?: number; src?: string; shouldPublish?: () => boolean } = {}
): CanvasPublisher {
  const intervalMs = opts.intervalMs ?? PUBLISH_INTERVAL_MS
  const shouldPublish = opts.shouldPublish ?? (() => true)
  /** The baseline, held EITHER resolved (`last`) or unresolved (`lastLazy`) — never both. */
  let last: CanvasScene = EMPTY_SCENE
  let lastLazy: (() => CanvasScene) | null = null
  let pending: CanvasSnapshot | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  /** Node ids whose latest cast was refused and not yet made good (`refusedNodeIds`). Kept ACROSS
   *  emits and adopts: the peer still does not have the node, so an edge to it must keep waiting,
   *  and an adopt keeps both owed in the baseline (`adoptBaseline`). */
  const owedNodes = new Set<string>()
  /** Edge ids whose OWN cast was refused (not held for an owed endpoint — those ride `owedNodes`)
   *  and not yet made good. Kept across adopts for the same reason: the refusal is transient (the
   *  re-creation gate holds a redrawn link for one round trip — exactly when a teammate's op is
   *  adopted), and an adopt that took the link into the baseline would never cast it. */
  const owedEdges = new Set<string>()

  const resolve = (s: CanvasSnapshot): CanvasScene =>
    asScene(typeof s === 'function' ? s() : s)

  /** The baseline to diff against, resolving a deferred one exactly once. */
  const baseline = (): CanvasScene => {
    if (lastLazy) {
      last = lastLazy()
      lastLazy = null
    }
    return last
  }

  /** Take a snapshot as the baseline. A thunk is stored unresolved — nothing has asked for it yet
   *  and, for a solo user, nothing ever will. */
  const setBaseline = (s: CanvasSnapshot): void => {
    if (typeof s === 'function') {
      lastLazy = () => asScene(s())
    } else {
      last = asScene(s)
      lastLazy = null
    }
  }

  /**
   * Take an ADOPTED snapshot as the baseline without letting it swallow what is still owed.
   *
   * An adopt (a peer's op applied locally, a project load) takes the scene on screen, and that scene
   * already holds every refused node and every edge held for one. Taken as-is, the baseline would
   * claim the peer has them: the node re-diffs only if it changes again, and once it finally casts,
   * a held edge no longer differs from the baseline, so it is never cast at all — the peer's next save
   * then drops it. So for the owed nodes, and every edge touching one, the adopted baseline keeps the
   * PREVIOUS baseline's entry (the refusal rebase, reused): absent where the peer never had it, the
   * older version where it did. Dropping them outright instead would lose that older version, and a
   * later local delete of the node would diff to nothing.
   *
   * The same for an edge whose OWN cast was refused (`owedEdges` — the re-creation gate holds a
   * redrawn link for one round trip, and a teammate's op adopted in that window must not swallow it).
   *
   * Only for what the ADOPTED scene still holds: an owed node present in it, edges in it that touch
   * one, and owed edges present in it. An owed node the scene no longer holds is not ours to re-emit — a project switch
   * adopts ANOTHER project's scene (one publisher serves every local project), where keeping the old
   * entry would cast a `remove` of the previous project's node under the new project's id; and a
   * peer's delete arrives here as an adopt, where it would echo their remove back. The same goes for
   * an edge the adopted scene dropped. The cost: a REMOVE that was itself refused (no active project)
   * and then adopted over is not retried — which the publisher never did before this rule either.
   *
   * Only while something is owed — and then the previous baseline is resolved now, one serialize per
   * adopt, because the adopted thunk must be rebased against the baseline AS OF this adopt. With
   * nothing owed an adopt is exactly what it was: a thunk stored unresolved.
   */
  const adoptBaseline = (s: CanvasSnapshot): void => {
    if (!owedNodes.size && !owedEdges.size) {
      setBaseline(s)
      return
    }
    const owed = new Set(owedNodes)
    const owedE = new Set(owedEdges)
    const prev = baseline()
    const keepOwed = (next: CanvasScene): CanvasScene => {
      const here = new Set(next.nodes.filter((n) => owed.has(n.id)).map((n) => n.id))
      const keys = new Set<string>()
      for (const id of here) keys.add('n:' + id)
      for (const e of [...next.bridges, ...next.ropes]) {
        if (here.has(e.source) || here.has(e.target) || owedE.has(e.id)) keys.add('e:' + e.id)
      }
      if (!keys.size) return next
      return rebaseRefused(prev, next, keys)
    }
    if (typeof s === 'function') {
      lastLazy = () => keepOwed(asScene(s()))
    } else {
      last = keepOwed(asScene(s))
      lastLazy = null
    }
  }

  const emit = (snapshot: CanvasSnapshot): void => {
    if (!shouldPublish()) {
      setBaseline(snapshot) // solo: adopt as baseline, diff nothing, send nothing
      return
    }
    const prev = baseline()
    const next = resolve(snapshot)
    const mutations = diffToMutations(prev, next)
    const refused = new Set<string>()
    const refusedNow = new Set<string>()
    const refusedEdgesNow = new Set<string>()
    for (const m of mutations) {
      // An edge whose endpoint the peer does not have is HELD, not cast: the peer's link prune would
      // drop it and cast an `edge-remove`, deleting the link on our canvas too. Held = refused, so
      // the rebase keeps it owed and it re-diffs until its endpoint casts. The batch order (node
      // upserts first — diffToMutations) means this emit's node verdicts are already in, so an
      // endpoint that finally casts takes its edges with it in the SAME batch, after it.
      if (m.op === 'edge-upsert' && (owedNodes.has(m.edge.source) || owedNodes.has(m.edge.target))) {
        refused.add(mutationKey(m))
        continue
      }
      const cast = send(opts.src ? { ...m, src: opts.src } : m) !== false
      if (!cast) refused.add(mutationKey(m))
      const nodeId = mutationNodeId(m)
      if (nodeId === null) {
        const edgeId = m.op === 'edge-remove' ? m.id : m.op === 'edge-upsert' ? m.edge.id : null
        if (edgeId === null) continue
        if (cast) owedEdges.delete(edgeId)
        else {
          owedEdges.add(edgeId)
          refusedEdgesNow.add(edgeId)
        }
        continue
      }
      if (cast) owedNodes.delete(nodeId)
      else {
        owedNodes.add(nodeId)
        refusedNow.add(nodeId)
      }
    }
    // A refused node that has since left the canvas owes nothing — unless it is its REMOVE that was
    // just refused (that one is still owed, and the rebase keeps it).
    if (owedNodes.size) {
      const live = new Set(next.nodes.map((n) => n.id))
      for (const id of owedNodes) if (!live.has(id) && !refusedNow.has(id)) owedNodes.delete(id)
    }
    // Same for an owed edge (the scene no longer draws it, and its remove was not the refusal).
    if (owedEdges.size) {
      const live = new Set([...next.bridges, ...next.ropes].map((e) => e.id))
      for (const id of owedEdges) if (!live.has(id) && !refusedEdgesNow.has(id)) owedEdges.delete(id)
    }
    last = refused.size ? rebaseRefused(prev, next, refused) : next
    lastLazy = null
  }

  const onTimer = (): void => {
    timer = null
    if (!pending) return
    const next = pending
    pending = null
    emit(next)
  }

  return {
    publish(next, o) {
      if (!shouldPublish()) {
        // Solo: not even a throttle timer. Just keep the baseline current for the peer who joins.
        if (timer) clearTimeout(timer)
        timer = null
        pending = null
        setBaseline(next)
        return
      }
      if (o?.throttle) {
        // Leading edge sends at once; further frames inside the window coalesce into one trailing send.
        if (timer) {
          pending = next
          return
        }
        emit(next)
        timer = setTimeout(onTimer, intervalMs)
        return
      }
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      pending = null
      emit(next)
    },
    adopt(next) {
      adoptBaseline(next)
      pending = null
    },
    flush() {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      if (pending) {
        const next = pending
        pending = null
        emit(next)
      }
    },
    dispose() {
      if (timer) clearTimeout(timer)
      timer = null
      pending = null
    },
    refusedNodeIds() {
      return new Set(owedNodes)
    },
    hasOwed() {
      return owedNodes.size > 0 || owedEdges.size > 0
    }
  }
}

/**
 * Ephemeral canvas nodes — subagent cards (ids tracked in the agentNodes store) and /loop, /schedule
 * and /cron cards (`loop-<parentId>`). They are DERIVED on every client from the already-broadcast
 * `agent:status` stream, live outside React Flow's managed `nodes` array, and are never persisted.
 * Publishing them would render each card twice on a peer. They are never published — full stop.
 * This is the one definition of "ephemeral"; Canvas's own change-list filter uses it too.
 */
export function isEphemeralNodeId(id: string, ephemeralIds: ReadonlySet<string>): boolean {
  return ephemeralIds.has(id) || id.startsWith('loop-')
}

/**
 * The whole canvas as it may go on the wire: publishable nodes (above) plus the two PERSISTED edge
 * lists, with every edge whose endpoint is an ephemeral card dropped.
 *
 * That last filter is the edge half of the same rule. The ephemeral subagent / loop cards are
 * derived per client from the `agent:status` stream, so an edge pointing at one addresses a node id
 * that exists on the peer with a DIFFERENT lifetime (or not at all yet) — and unlike a node, an
 * edge is not visibly duplicated by the mistake, it just gets pruned on the peer at a moment we do
 * not control and then re-published back at us. The ephemeral edges Canvas draws to those cards are
 * built and merged at the `<ReactFlow>` prop and are not in these lists at all; this is the guard
 * for a PERSISTED edge that happens to name one.
 */
export function publishableScene(
  scene: CanvasScene,
  ephemeralIds: ReadonlySet<string>
): CanvasScene {
  const nodes = publishableStates(scene.nodes, ephemeralIds)
  const live = new Set(nodes.map((n) => n.id))
  const keep = (e: BridgeLink): boolean => live.has(e.source) && live.has(e.target)
  return { nodes, bridges: scene.bridges.filter(keep), ropes: scene.ropes.filter(keep) }
}

/** The node states that may go on the wire: everything except the ephemeral cards. */
export function publishableStates(
  states: CanvasNodeState[],
  ephemeralIds: ReadonlySet<string>
): CanvasNodeState[] {
  // `stripSharedNodeExec`, for the same reason it runs on a project file: the exec-enabling fields
  // are MACHINE-LOCAL. A teammate cannot use our `shell` or our `-o ProxyCommand=…` (they name
  // programs and hosts on OUR box), and sending them would both leak our local setup and put a
  // value of foreign provenance into their live nodes. The publisher's baseline is built from this
  // same function, so nothing re-publishes in a loop.
  // A held launch (`pendingLaunch`) is the one exec field that DOES ride the cast: it goes to this
  // machine's own core, whose reflector forwards it only between owner clients (two Server Edition
  // tabs must agree on who claimed a launch) and strips it for every relay/peer recipient.
  return stripCastNodeExec(states.filter((n) => !isEphemeralNodeId(n.id, ephemeralIds)))
}
