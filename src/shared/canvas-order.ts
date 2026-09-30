// Canvas sync — the ordering state. This is what makes two people editing the SAME node converge.
//
// THE PROBLEM. Stage 3's first cut was pure optimistic last-write-wins with no order: each client
// applied its own edit immediately, cast it, and applied whatever arrived from a peer. That is only
// safe if two edits are never in flight at once — and on a real (asynchronous) bus, two people
// dragging one node cross on EVERY frame:
//
//   A drags n1 to x=200 ─┐                    ┌─ B drags n1 to x=100
//                        ├─ both in flight ───┤
//   A applies B's 100 ───┘                    └─ B applies A's 200
//   → A shows 100, B shows 200. FOREVER. And both publishers have `adopt`ed, so neither
//     re-publishes — the divergence is permanent, and the next whole-file workspace.save from
//     either side overwrites the other's canvas on disk. Worse with a delete: A deletes a node,
//     B (mid-drag) sends the next frame, A applies it and RESURRECTS the node it just deleted —
//     the exact "a client writes back a node someone else deleted" bug Stage 3 exists to kill.
//
// THE FIX (no CRDT). The reflector stamps every mutation with a monotone `seq` — one total order,
// the same for everyone — and echoes it to EVERY client, the sender included. Per node, the highest
// `seq` wins. Two rules, and they are the whole algorithm:
//
//   1. OUR OWN ECHO IS AN ACK, NOT AN EDIT. We already applied it optimistically; re-applying it
//      would rubber-band a node we are still dragging (the echo carries the position from ~50 ms
//      ago). So we consume it for its `seq` and drop it. (One exception, a board's ORDER op once it
//      is our last in flight for that list: see `accept`.)
//   2. WHILE ONE OF OUR OWN MUTATIONS FOR A NODE IS UNACKED, WE IGNORE PEERS' MUTATIONS FOR THAT
//      NODE. Not a heuristic — a consequence of FIFO delivery, which IPC and WebSocket both
//      guarantee: if the reflector had ordered our mutation BEFORE the peer's, our ack would
//      already have arrived (the reflector sent it to us first). So an unacked local mutation is
//      necessarily LATER in the total order than anything we are hearing now — it will win on every
//      other client, and keeping it here is what agrees with them.
//
//   3. …AND RULE 1 IS ONLY SOUND WHILE OUR OPTIMISTIC VALUE IS STILL ON OUR CANVAS. Rule 2's
//      suppression is bounded by a TTL (an ack can be late — our socket carries pty output too), and
//      once it lapses a peer's mutation can overwrite the value we are still waiting to have acked.
//      From that moment our echo is not "something we already show", it is the ONLY copy of a value
//      that won on every other client — so it is APPLIED, not dropped (`superseded` below). Without
//      this, a late ack left the client permanently on the losing value and its whole-file save
//      wrote those bytes over everyone else's canvas.
//
//   4. A DELETE IS NOT AN EDIT, AND `seq` ALONE CANNOT TELL THEM APART. Rules 1-3 order mutations
//      but say nothing about INTENT, and for one pair that gap was a real defect: A deletes a node
//      while B is mid-drag, B's next frame is ordered after A's remove, so the upsert wins — the
//      node SURVIVES on every canvas as a shell around a terminal `tmux kill-session` already
//      killed. Consistent, and wrong: nobody asked for that node back.
//
//      The missing fact is CAUSALITY. B's frame is not a decision to re-create the node; it was
//      produced in ignorance of the delete. So every mutation carries `seen` — the highest `seq`
//      its sender had applied when it cast — and the rule is exact, with no timer and no heuristic:
//
//          an upsert for a removed node is DROPPED iff `seen < the seq the remove was ordered at`.
//
//      A stale drag frame carries `seen` from before the remove and dies; a deliberate re-creation
//      (⌘Z on the delete, a node re-added later) necessarily carries `seen` at or past it and is
//      applied, which is what keeps this from becoming a blunt "delete always wins" — the tiebreak
//      docs/team-presence.md rejected precisely because it would let one stale frame from a
//      disconnected peer erase a node that was legitimately re-created.
//
//      Its mirror on the receiving side: a `remove` is never held off by rule 2. Rule 2 rests on
//      "our unacked mutation is later in the total order, so it wins everywhere" — and under this
//      rule it no longer does, because every other client is about to drop it for the same reason
//      we would be dropping the remove. Suppressing the remove here would be the one way to
//      diverge from them.
//
//      An UNSTAMPED mutation (no `seen`: an older peer, or a path with no reflector) is judged
//      exactly as it was before this rule existed — applied. Degrade, never break.
//
// Together those give: every client ends on the mutation with the highest `seq` for that node.
// Convergence, on any interleaving. What it deliberately does NOT give is intent preservation for
// two people dragging the SAME node — they still fight, and last-write-wins decides.
//
// Pure: no React, no DOM, no timers (the pending TTL below is a lazy clock read, not a timer).

import { isKanbanDeletion, isKanbanOp, kanbanOpKey } from './kanban-ops'
import type { CanvasMutation, KanbanOp, MutationStamp, SceneMutation } from './types'

/**
 * How long an unacked local mutation keeps suppressing peers' mutations for that node.
 *
 * Rule 2 above assumes the ack ALWAYS comes back, and normally it does — but an ack can be LATE
 * (our socket carries pty output too, and Stage 2 tolerates an 8 MB backlog on it before it gives
 * up), so the suppression cannot be unbounded: one slow ack would deafen that node to its peers for
 * the rest of the session. Hence the expiry — a TIME bound on a CORRECTNESS rule, which is only
 * sound because of RULE 3 below: expiring the suppression is reversible, and the late ack repairs
 * whatever it cost us. Generous next to a round trip (sub-millisecond in-process, single-digit ms
 * over a LAN WS) and short next to a human noticing.
 *
 * A cast the reflector REFUSES (oversized / malformed) is not this case and must never reach here:
 * the publisher validates with the same predicate the reflector uses (`isCanvasMutation`) BEFORE
 * calling `onLocal`, so a refused cast records no pending entry at all.
 */
export const PENDING_TTL_MS = 5000

/**
 * How many removed node ids stay judgeable (rule 4). An entry is dropped the moment the node is
 * legitimately re-created, so this only bounds nodes that were deleted and never came back — i.e.
 * a session's whole delete history. Far past any real canvas, and the eviction is a plain LRU:
 * losing the OLDEST entry degrades exactly to the pre-rule-4 behaviour for that node (a stale
 * upsert could resurrect it), never to something worse.
 */
export const REMOVED_MAX = 512

/**
 * How many of our own casts the FIFO record behind the re-creation gate's release keeps (see
 * `hasPendingRemove`). A cast leaves it the moment its echo, or a later one, comes back, so it only
 * grows while the core answers nothing at all — and then the oldest entry is forgotten. A forgotten
 * REMOVE is released as it is forgotten: nothing can match it any more, so kept it would hold its
 * key's gate until a reset. That opens the gate before the echo, which is the degrade the gate
 * exists to prevent (a re-creation cast now can be a stale frame to a peer) — bounded to a client
 * that already has 4096 casts unanswered. A forgotten cast's own echo, when it does come back,
 * releases nothing: matched to a LATER cast of the same key, it would release every remove cast
 * between the two while their echoes are still in flight.
 */
export const LOCAL_CASTS_MAX = 4096

/**
 * The THING a mutation addresses — the key everything below orders by.
 *
 * Nodes and edges live in ONE key space with a prefix, not two maps: a node id and an edge id are
 * generated independently and could collide, and the rules here (highest `seq` wins, our unacked
 * cast suppresses peers, a remove tombstones the key) are the same for both. The prefix is what
 * keeps them from being confused for one another.
 *
 * Edges key on the id ALONE — the `kind` is deliberately not in the key. One id is one edge; a
 * bridge and a rope claiming the same id must fight in the total order and be resolved to one
 * thing, not held as two independent entities on different clients. The apply side enforces the
 * same identity (`applyEdgeMutationToScene` in canvas-mutations).
 *
 * Kanban ops take the third prefix, `k:`, with a sub-prefix per board item (`k:col:<id>`,
 * `k:card:<nodeId>`, `k:colorder:<projectId>`, … — `kanbanOpKey`). A card's placement and meta are
 * keyed by the node id they describe, under their own sub-prefixes, so they never share an order
 * with the node itself: deleting a node does not tombstone its card, and a card move is not a node
 * edit.
 *
 * THE PROJECT. One `CanvasOrder` orders every loaded project (Canvas applies mutations for
 * loaded-but-inactive projects too), and a board's two order ops are per-project SINGLETONS — so
 * their keys carry the project (ruling R4), and every caller that may hold a board op must pass it.
 * The overloads make that a type error rather than a convention: a SceneMutation (node / edge) keys
 * the same in every project and may omit it; anything typed `CanvasMutation` may not.
 */
export function mutationKey(m: SceneMutation, projectId?: string): string
export function mutationKey(m: CanvasMutation, projectId: string): string
export function mutationKey(m: CanvasMutation, projectId?: string): string {
  // `?? ''` is unreachable through the types (a board op has no overload without a project); it
  // keeps an untyped caller keying on the empty scope rather than throwing on the order's hot path.
  if (isKanbanOp(m)) return kanbanOpKey(m as KanbanOp, projectId ?? '')
  if (m.op === 'edge-remove') return `e:${m.id}`
  if (m.op === 'edge-upsert') return `e:${m.edge.id}`
  if (m.op === 'remove') return `n:${m.id}`
  if (m.op === 'upsert') return `n:${m.node.id}`
  // Unreachable for a typed mutation; an op this build does not know keys on its own name, so it
  // can never be confused with (or tombstone) a real node, edge or board item.
  return `?:${(m as { op: string }).op}`
}

/** The node a mutation addresses. Node ops only — an edge mutation addresses no node, and neither
 *  does a kanban op (a card's `nodeId` names the card, not a node this op creates or deletes). */
export function mutationNodeId(m: CanvasMutation): string | null {
  if (m.op === 'remove') return m.id
  if (m.op === 'upsert') return m.node.id
  return null
}

/** Does this mutation ADD-OR-REPLACE its subject (as opposed to dropping it)? Nodes, edges and
 *  board items are ordered by the same rules, so every rule below asks this rather than
 *  `op === 'upsert'`. Every kanban op that is not a rule-4 deletion is a value here — including
 *  `kb-card-remove` / `kb-meta-remove`, which set a card's placement / meta to "none" (an ordinary
 *  last-writer-wins value, never a tombstone), and the two order ops. */
function isUpsert(m: CanvasMutation): boolean {
  if (isKanbanOp(m)) return !isKanbanDeletion(m as KanbanOp)
  return m.op === 'upsert' || m.op === 'edge-upsert'
}

/** Does this mutation DROP its subject — a rule-4 deletion? The mirror of `isUpsert`: `remove`,
 *  `edge-remove`, and the three board removals that mean "this item is gone" (`kb-column-remove`,
 *  `kb-label-remove`, `kb-view-remove`). NOT `kb-card-remove` / `kb-meta-remove`: a card moved back
 *  to Ungrouped and then filed again is not a resurrection, and tombstoning it would drop a
 *  teammate's concurrent move as a "stale frame". */
function isRemove(m: CanvasMutation): boolean {
  if (isKanbanOp(m)) return isKanbanDeletion(m as KanbanOp)
  return m.op === 'remove' || m.op === 'edge-remove'
}

/** A board's two ORDER ops: whole-list values (`kb-column-order`, `kb-label-order`) whose listed ids
 *  are only what their sender knew — see the own-echo exception in `accept`. */
function isBoardOrderOp(m: CanvasMutation): boolean {
  return m.op === 'kb-column-order' || m.op === 'kb-label-order'
}

/** The order's own "drops its subject" predicate, for a caller that has to ask the same question —
 *  the re-creation gate (`hasPendingRemove`) holds back everything EXCEPT a remove. */
export const isRemoveOp = isRemove

export interface CanvasOrder {
  /**
   * Stamp a mutation we are ABOUT to cast with our causal position (`seen`) — rule 4.
   *
   * PURE, and separate from `onLocal` on purpose: the caller has to run the shared
   * `isCanvasMutation` size guard on the EXACT payload it will cast (a mutation the reflector
   * refuses is dropped silently, and one that recorded a pending entry would deafen that node to
   * its peers for a whole TTL). Stamping inside `onLocal` would mean guarding a payload a few
   * bytes smaller than the one that actually goes on the wire — the one difference that can put a
   * borderline mutation on the wrong side of the cap.
   */
  stamp<M extends CanvasMutation>(m: M): M & MutationStamp
  /** Record a mutation WE are casting (it becomes pending until its echo comes back). `projectId`
   *  is the canvas it is cast into — it scopes a board's singleton order keys (see `mutationKey`),
   *  and is required for anything that may be a board op. */
  onLocal(m: SceneMutation, projectId?: string): void
  onLocal(m: CanvasMutation, projectId: string): void
  /**
   * Decide an incoming mutation (a peer's, or our own echoed back) for the canvas `projectId`.
   * `true`  → apply it to the canvas.
   * `false` → drop it: our own echo (already applied), a straggler the total order has superseded,
   *           or a peer's edit to a node whose newer local edit of ours is still in flight.
   */
  accept(m: SceneMutation, projectId?: string): boolean
  accept(m: CanvasMutation, projectId: string): boolean
  /**
   * True while one of OUR remove-class casts (`remove` / `edge-remove`) for `key` (a `mutationKey`)
   * is unacked — THE RE-CREATION GATE.
   *
   * Rule 4 judges an upsert by the `seen` its sender stamped, and our own remove enters `seen` only
   * when its ECHO comes back. So a re-creation of that key cast before the echo — a link deleted and
   * redrawn, a node deleted and ⌘Z'd, inside one round trip — carries a `seen` below the remove, and
   * every peer drops it as a stale frame while this client keeps showing it: a split that the next
   * whole-file save turns into last-writer-wins on disk. The caller therefore refuses to cast a
   * non-remove op for a key this reports (the publisher keeps it owed) and casts it once the echo
   * lands, when `stamp` puts the remove in its `seen`.
   *
   * Counted per key, not a flag: two removes in flight (delete, undo, delete) release on the second
   * ack. Not TTL-bound, unlike rule 2's suppression: a late ack is exactly when the gate matters. A
   * LOST ack does not come with a reconnect: one `canvas:mut` can be dropped on its way back while
   * the connection stays up (the ui sink's per-message failure limit). So a remove is also released
   * when the echo of a LATER cast of ours arrives: echoes come back in the order we cast them (FIFO),
   * so that echo proves the earlier one is not coming. A reset still clears everything. (The record
   * of our casts is capped — LOCAL_CASTS_MAX says what happens to a remove it forgets.)
   *
   * The PROJECT rides in the key: callers build it with `mutationKey(m, projectId)` — the same
   * function `onLocal` keys with — so the gate is project-scoped wherever a key is. (Only a
   * remove-class op can open the gate, and none of those has a project-scoped key today.)
   */
  hasPendingRemove(key: string): boolean
  /** How many of our remove-class casts are unacked, over every key: a caller that holds re-creations
   *  compares it across an `accept`, because an echo can release a DIFFERENT key's gate (FIFO). */
  pendingRemoveCount(): number
  /** Forget the per-connection order state on a genuine reconnect (see `createReconnectWatch`) —
   *  everything except our causal position (`lastSeq`, what `stamp` puts in `seen`), which the first
   *  stamped `seq` heard after it re-bases if the core restarted. */
  reset(): void
}

interface Pending {
  count: number
  /** When the MOST RECENT still-unacked mutation for this node was cast (for PENDING_TTL_MS).
   *  Refreshed on every local mutation: a continuous drag emits a frame every 50 ms, and dating the
   *  entry from the OLDEST one expired it mid-drag — after 5 s of dragging, a peer's older frame
   *  would land and rubber-band the node out from under the hand holding it. What the TTL is for is
   *  an ack that is not coming back soon; a drag we are still emitting is not that. */
  since: number
  /** The TTL lapsed: this node no longer suppresses its peers (rule 2 is off), but our casts are
   *  still unacked, so the entry stays — `count` still has to be drawn down by the acks, and rule 3
   *  needs to know they are ours. */
  stale?: boolean
}

/**
 * Ordering state for one client. `src` is this client's publisher tag — the mutations it stamps,
 * and therefore the echoes it must recognize as its own.
 */
export function createCanvasOrder(
  src: string,
  opts: { now?: () => number; ttlMs?: number } = {}
): CanvasOrder {
  const now = opts.now ?? (() => Date.now())
  const ttlMs = opts.ttlMs ?? PENDING_TTL_MS
  /** Highest `seq` this client has SEEN for a node (applied or deliberately dropped). */
  const seen = new Map<string, number>()
  /** Our own casts for a node that have not been echoed back yet. */
  const pending = new Map<string, Pending>()
  /**
   * RULE 3 — nodes where our optimistic value is NO LONGER on our canvas: the TTL lapsed on one of
   * our unacked casts and a peer's mutation overwrote it. Rule 1 (drop our own echo) is only sound
   * while our optimistic value is still showing; here it is not, so the echo — when it finally
   * arrives — is the ONLY thing that can put back a value that already won on every other client
   * (it has the higher `seq` there). Dropping it left this client permanently on the LOSING value,
   * and its whole-file workspace.save then wrote those losing bytes over everyone else's canvas —
   * the exact save-safety property this stage exists to guarantee. So: while a node is in here, a
   * late ack is APPLIED rather than dropped, if the total order still says it wins.
   */
  const superseded = new Set<string>()
  /**
   * RULE 4 — nodes a `remove` has taken off the canvas, and the `seq` that remove was ordered at.
   * An upsert whose sender had not yet applied that remove (`seen` below it) was produced in
   * ignorance of the delete and is dropped; anything at or past it is a deliberate re-creation and
   * is applied (which also clears the entry). Insertion-ordered, capped at REMOVED_MAX.
   */
  const removed = new Map<string, number>()
  /** The re-creation gate (`hasPendingRemove`): per key, how many of our remove-class casts are
   *  still unacked. Kept apart from `pending`, which counts EVERY cast of ours for the key. */
  const pendingRemoves = new Map<string, number>()
  /** The sum of `pendingRemoves`, for `pendingRemoveCount`. */
  let pendingRemoveTotal = 0
  /** Our own casts in the order we made them, `{ key, remove }` — what an echo is matched against
   *  (FIFO) to prove an earlier echo was lost. Capped at LOCAL_CASTS_MAX. */
  const casts: Array<{ key: string; remove: boolean }> = []
  /**
   * Per key, how many of our casts were shifted out of `casts` (the cap) with their echo still to
   * come. A key's forgotten casts are OLDER than any it still has recorded, and echoes return in cast
   * order, so the next echoes of that key are theirs: each is consumed here and matches nothing.
   * Cleared whenever an echo matches a RECORDED cast — every forgotten cast is older than that one,
   * so (FIFO) no echo of theirs can still arrive — and by `reset`.
   */
  const forgotten = new Map<string, number>()
  /** Set by `reset`: the next stamped `seq` says whether the core restarted (see `accept`). */
  let rebase = false
  /**
   * The highest `seq` we have applied or deliberately dropped, across ALL nodes — our causal
   * position in the total order, and what `stamp` puts on every mutation we cast. Global, not per
   * node: rule 4 compares a sender's knowledge of the ORDER against a remove's place in it, and
   * "what did this client know when it cast" has nothing to do with which node it addressed.
   * It survives `reset()` (see there): a same-core reconnect must not rewind it.
   */
  let lastSeq = 0

  /** Draw down one pending remove of `key` (an echo, or proof its echo was lost). */
  const releaseRemove = (key: string): void => {
    const r = pendingRemoves.get(key)
    if (r === undefined) return
    pendingRemoveTotal--
    if (r <= 1) pendingRemoves.delete(key)
    else pendingRemoves.set(key, r - 1)
  }

  const noteRemoved = (id: string, seq: number): void => {
    removed.delete(id) // re-insert so the Map's iteration order stays the LRU order
    removed.set(id, seq)
    while (removed.size > REMOVED_MAX) {
      const oldest = removed.keys().next().value as string | undefined
      if (oldest === undefined) break
      removed.delete(oldest)
    }
  }

  /**
   * Rule 4's verdict: is this upsert a stale frame from before the node was removed?
   *
   * An UNSTAMPED mutation (`seen` undefined — an older peer, the relay mirror, a test bus with no
   * reflector) is never blocked: we cannot judge its causality, and guessing "stale" would drop a
   * legitimate edit. Degrade to the pre-rule-4 behaviour rather than break.
   */
  const supersededByRemove = (m: CanvasMutation, id: string): boolean => {
    if (!isUpsert(m)) return false
    const at = removed.get(id)
    if (at === undefined) return false
    return typeof m.seen === 'number' && m.seen < at
  }

  /** Is rule 2's suppression live for this node? Lapses on the TTL (the entry stays: see Pending). */
  const suppressing = (id: string): boolean => {
    const p = pending.get(id)
    if (!p) return false
    if (p.stale) return false
    if (now() - p.since > ttlMs) {
      p.stale = true
      return false
    }
    return true
  }

  return {
    stamp<M extends CanvasMutation>(m: M): M & MutationStamp {
      // `lastSeq` 0 = we have applied nothing from the reflector yet, which is also the value an
      // unstamped mutation would carry. Stamp it anyway: 0 is a truthful causal position (we know
      // about nothing), and it is what makes a first-frame drag lose to a delete that precedes it.
      return { ...m, seen: lastSeq }
    },

    onLocal(m: CanvasMutation, projectId?: string) {
      const id = mutationKey(m, projectId ?? '')
      const p = pending.get(id)
      if (p) {
        p.count++
        p.since = now() // a live drag re-arms its own suppression (see Pending.since)
        p.stale = false
      } else {
        pending.set(id, { count: 1, since: now() })
      }
      const remove = isRemove(m)
      if (remove) {
        pendingRemoves.set(id, (pendingRemoves.get(id) ?? 0) + 1)
        pendingRemoveTotal++
      }
      casts.push({ key: id, remove })
      if (casts.length > LOCAL_CASTS_MAX) {
        // Forget the oldest (see LOCAL_CASTS_MAX): a remove is released now, since nothing can match
        // it later, and its echo is marked as one that must match nothing.
        const old = casts.shift() as { key: string; remove: boolean }
        if (old.remove) releaseRemove(old.key)
        forgotten.set(old.key, (forgotten.get(old.key) ?? 0) + 1)
      }
      // A fresh local edit IS an optimistic value on our canvas again, so rule 1 is sound for this
      // node once more and an older echo of ours must not be replayed over it. (This one's own echo
      // will be dropped as the ack it is; it carries what we already show.)
      superseded.delete(id)
    },

    accept(m: CanvasMutation, projectId?: string) {
      const id = mutationKey(m, projectId ?? '')
      const seq = m.seq ?? 0
      const highest = seen.get(id) ?? 0
      // `seq` 0 means an unstamped mutation (no reflector in the path) — never treat it as stale.
      const current = seq === 0 || seq > highest
      if (seq > highest) seen.set(id, seq)
      // After a reset, the first STAMPED seq says which reconnect it was: at or below our position,
      // the core restarted and its counter began again, so our position is that seq (kept, it would
      // make every cast read "never stale" until the new counter caught up); above it, the same core
      // carried on and the position simply rises below.
      if (rebase && seq > 0) {
        rebase = false
        if (seq <= lastSeq) lastSeq = seq
      }
      // Our causal position for the mutations WE cast next (rule 4). Advanced for EVERYTHING we
      // process — our own echo included, and a straggler too: both prove the order has reached at
      // least that far, and "what did this client know" says nothing about who sent it.
      if (seq > lastSeq) lastSeq = seq

      // Rule 4's bookkeeping, before any verdict below reads it. Only a CURRENT mutation may move
      // it: a straggler describes a state the total order has already left behind.
      const stale = supersededByRemove(m, id)
      if (current) {
        if (isRemove(m)) noteRemoved(id, seq)
        else if (!stale) removed.delete(id) // a deliberate re-creation: this node is alive again
      }

      if (m.src && m.src === src) {
        const p = pending.get(id)
        // Rule 3: our optimistic value was overwritten by a peer while this cast was in flight (the
        // TTL had lapsed, so rule 2 no longer held it off). If this echo still wins the total order,
        // it is a REPAIR, not a rubber-band — apply it and land where every other client already is.
        // Rule 4 forecloses that: a value the delete superseded lost on every OTHER client, so
        // replaying it here would resurrect — on this canvas alone — a node nobody else has.
        const repair = superseded.has(id) && current && !stale
        let settled = false
        // Rule 1: otherwise our own echo is just an ack — consume it, apply nothing.
        if (p && --p.count <= 0) {
          pending.delete(id)
          superseded.delete(id) // every cast of ours is accounted for; the node is settled
          settled = true
        }
        // The re-creation gate: this remove is now in our `seen` (above), so a re-creation of the
        // key stamped from here on carries it. Matched against our casts in the order we made them:
        // this echo is the one for the FIRST cast of this key still recorded, and every cast recorded
        // before it has had its echo lost (FIFO) — a remove among them will never be acked, so its
        // gate is released too. An echo we have no record of (straggling in after a reset) releases
        // nothing, so it cannot push a later remove's count below one; nor does the echo of a cast
        // the capped record forgot (`forgotten`), which would otherwise match a LATER cast of its key.
        const lost = forgotten.get(id)
        if (lost) {
          if (lost <= 1) forgotten.delete(id)
          else forgotten.set(id, lost - 1)
        } else {
          const at = casts.findIndex((c) => c.key === id)
          if (at !== -1) {
            for (const c of casts.splice(0, at + 1)) if (c.remove) releaseRemove(c.key)
            forgotten.clear()
          }
        }
        // …with one exception: the echo of our LAST order op for a board list (every cast of ours
        // for that list now acked) is APPLIED. An order op lists only the ids its sender knew, so
        // items teammates added concurrently sit unlisted, in each replica's arrival order, until the
        // winning order op sorts them (kanban-ops `reorder`). Every other replica applies that op;
        // its sender, dropping its own echo, was the one that kept its arrival order and diverged
        // (D5). It lists what this board already shows, so it moves nothing else. Not while a later
        // cast of ours is in flight: that one wins, and applying this one first would flicker.
        return repair || (settled && current && isBoardOrderOp(m))
      }
      // A straggler: a mutation the total order has already superseded on this client (applied, or
      // deliberately dropped). Applying it would move the node BACKWARDS out of the total order.
      if (!current) return false
      // Rule 4: cast in ignorance of the delete — a stale frame, not a decision to bring the node
      // back. (A re-creation carries `seen` at or past the remove and never reaches here.)
      if (stale) return false
      // Rule 2: an edit of ours for this node is still in flight, so it is later in the total order
      // than this one and will win everywhere. Keep ours; the peers will land on it.
      //
      // NEVER for a `remove`. Rule 2 rests on our unacked mutation winning everywhere, and under
      // rule 4 it does not: every other client is about to drop it for being older than this
      // delete. Holding the remove off here is the one way to end up disagreeing with them.
      if (!isRemove(m) && suppressing(id)) return false
      // Applying a peer's mutation over an unacked cast of ours (the TTL lapsed — `suppressing`
      // just said so, but the entry is still there): remember that our value is gone, so the late
      // ack can repair it (rule 3).
      if (pending.has(id)) superseded.add(id)
      return true
    },

    hasPendingRemove(key) {
      return (pendingRemoves.get(key) ?? 0) > 0
    },

    pendingRemoveCount() {
      return pendingRemoveTotal
    },

    reset() {
      seen.clear()
      pending.clear()
      superseded.clear()
      pendingRemoves.clear()
      pendingRemoveTotal = 0
      casts.length = 0
      forgotten.clear()
      // The core may have restarted at seq 0 — a `removed` entry stamped with the OLD counter would
      // then outrank every new mutation and blackhole that node.
      removed.clear()
      // `lastSeq` is deliberately KEPT. A reset also fires on a reconnect to the SAME core (a new
      // clientId, `seq` carrying on), and zeroing it stamped our first cast after it `seen: 0` — a
      // ⌘Z of a node deleted before the drop was then a stale frame to every peer holding the
      // tombstone, and our own echo of it is no repair: a persistent split. If the core REALLY
      // restarted, the kept value is above every `seq` it hands out, so until we hear from it our
      // casts read as "never stale" there (`supersededByRemove`: it is ≥ every new tombstone) — the
      // pre-rule-4 verdict, a degrade, never a split. It is BOUNDED: the first stamped `seq` we hear
      // after this re-bases the position (`rebase`, in `accept`). The reflector's clamp to `seq - 1`
      // (canvas-sync `stampMutation`) changes no verdict here; it is hygiene.
      rebase = true
    }
  }
}

/**
 * WHEN the ordering state may be reset — the lifecycle half of the contract above.
 *
 * `reset()` exists for exactly ONE reason: if the core RESTARTS, its `seq` counter restarts at 0
 * while a surviving client's `seen` map still holds the old (high) values — that client would then
 * drop every mutation the new core stamps as a straggler and drift away from its peers for the rest
 * of the session, with no way back. A NEW presence clientId is the observable signal of exactly that:
 * a new connection, possibly to a new core.
 *
 * But reset() is far from free: it also drops `pending` and `superseded`, the record of our own casts
 * that are still in flight. Drop those and rule 1 (our own echo is an ack) is left with no way to
 * tell an ack from a REPAIR — so if a peer's edit has overwritten our optimistic value, our late echo
 * is thrown away and we stay on the LOSING value forever, and the next whole-file workspace.save
 * writes those bytes over everyone else's canvas. That is the permanent split-brain rule 3 exists to
 * prevent, and a mistimed reset reopens it.
 *
 * So it must fire on a GENUINE reconnect and nowhere else. The trap: presence resolves our clientId
 * ASYNCHRONOUSLY, so a naive `id !== previous` also fires on the very first `null → myId` at mount —
 * and by then we may already be publishing (a peer's mutation is itself proof of a peer), i.e. our
 * own casts can already be in flight. There is nothing to forget at the first hello: an empty `seen`
 * map cannot be stale. This watch therefore reports a reconnect only when a NEW non-null id REPLACES
 * a previously seen one, and ignores the `null`s in between (a dropped socket must not throw away
 * state the reconnect to the SAME core would still need).
 *
 * Returns a predicate to be fed every presence update: `true` ⇒ call `order.reset()`.
 *
 * The id is whatever the presence hub calls a connection (a numeric clientId on the desktop, a string
 * elsewhere) — it is only ever compared, never parsed.
 */
export type ConnectionId = string | number

export function createReconnectWatch(
  initialId: ConnectionId | null = null
): (id: ConnectionId | null) => boolean {
  let known = initialId
  return (id) => {
    // `null` (and nothing else — a clientId of 0 is a real connection): not resolved yet, or the
    // socket dropped. Keep the state: reconnecting to the SAME core still needs it.
    if (id === null || id === undefined) return false
    if (known === null) {
      known = id // the FIRST hello — there is no older connection whose `seq` could be stale
      return false
    }
    if (id === known) return false
    known = id
    return true // a new connection replaced the old one: the core may have restarted at seq 0
  }
}
