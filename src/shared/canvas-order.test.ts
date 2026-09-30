// The ordering state — the client half of the convergence contract (the other half is the
// reflector's `seq`). The end-to-end proof lives in src/core/canvas-sync.convergence.test.ts
// (two clients, async bus); this pins the rules one at a time.

import { describe, it, expect } from 'vitest'
import {
  createCanvasOrder,
  createReconnectWatch,
  isRemoveOp,
  LOCAL_CASTS_MAX,
  mutationKey,
  mutationNodeId,
  PENDING_TTL_MS,
  REMOVED_MAX
} from './canvas-order'
import type { CanvasMutation, CanvasNodeState, SceneMutation } from './types'

const node = (id: string, x = 0): CanvasNodeState =>
  ({
    id,
    kind: 'terminal',
    title: 't',
    color: '#fff',
    group: null,
    position: { x, y: 0 },
    size: { width: 10, height: 10 }
  }) as CanvasNodeState

const up = (id: string, x: number, src: string | undefined, seq: number): SceneMutation => ({
  op: 'upsert',
  node: node(id, x),
  ...(src ? { src } : {}),
  seq
})
const rm = (id: string, src: string | undefined, seq: number): SceneMutation => ({
  op: 'remove',
  id,
  ...(src ? { src } : {}),
  seq
})

describe('mutationNodeId', () => {
  it('is the node a mutation addresses, whichever op', () => {
    expect(mutationNodeId(up('n1', 0, 'x', 1))).toBe('n1')
    expect(mutationNodeId(rm('n2', 'x', 1))).toBe('n2')
  })

  it('is null for an edge op (an edge addresses no node)', () => {
    expect(mutationNodeId({ op: 'edge-remove', kind: 'bridge', id: 'e1' })).toBeNull()
    expect(mutationNodeId({ op: 'edge-upsert', kind: 'rope', edge: { id: 'e1', source: 'a', target: 'b' } })).toBeNull()
  })
})

// One key space for nodes and edges, with a prefix: a node id and an edge id are generated
// independently and could be equal. The kind is NOT in the key — one id is one edge.
describe('mutationKey', () => {
  const edgeUp = (id: string, kind: 'bridge' | 'rope'): SceneMutation => ({
    op: 'edge-upsert',
    kind,
    edge: { id, source: 'a', target: 'b' }
  })

  it('prefixes nodes with n: and edges with e:, so equal ids do not collide', () => {
    expect(mutationKey(up('x', 0, 'a', 1))).toBe('n:x')
    expect(mutationKey(rm('x', 'a', 1))).toBe('n:x')
    expect(mutationKey(edgeUp('x', 'bridge'))).toBe('e:x')
    expect(mutationKey({ op: 'edge-remove', kind: 'bridge', id: 'x' })).toBe('e:x')
  })

  it('leaves the kind out of the key', () => {
    expect(mutationKey(edgeUp('x', 'bridge'))).toBe(mutationKey(edgeUp('x', 'rope')))
  })

  it('an edge op and a node op with the same id are ordered independently', () => {
    const o = createCanvasOrder('me')
    o.onLocal(o.stamp(up('x', 1, 'me', 0))) // our own unacked NODE edit suppresses peers' n:x…
    expect(o.accept(up('x', 5, 'peer', 7))).toBe(false)
    expect(o.accept({ ...edgeUp('x', 'bridge'), src: 'peer', seq: 8 })).toBe(true) // …not e:x
  })

  it('rule 4 covers an edge key: a stale edge-upsert cannot resurrect a removed edge', () => {
    const o = createCanvasOrder('me')
    expect(o.accept({ op: 'edge-remove', kind: 'bridge', id: 'e1', src: 'a', seq: 10 })).toBe(true)
    expect(o.accept({ ...edgeUp('e1', 'bridge'), src: 'b', seq: 11, seen: 9 })).toBe(false)
    expect(o.accept({ ...edgeUp('e1', 'bridge'), src: 'b', seq: 12, seen: 11 })).toBe(true)
  })
})

// Kanban ops (@shared/kanban-ops) share the ONE order: a `k:` key space, highest seq wins per key,
// and rule 4 for the three removals that mean "this board item is gone". A card / meta removal is a
// VALUE — "no placement", "no meta" — and must never tombstone, or a teammate filing a card a moment
// after someone moved it to Ungrouped would be dropped everywhere as a stale frame.
describe('kanban ops in the order', () => {
  const P = 'project-1'
  const card = (nodeId: string, columnId: string, src: string, seq: number, seen?: number): CanvasMutation => ({
    op: 'kb-card',
    assignment: { nodeId, columnId },
    src,
    seq,
    ...(seen === undefined ? {} : { seen })
  })

  it('keys every kanban op in the k: space, apart from the node its card names', () => {
    expect(mutationKey(card('x', 'c', 'a', 1), P)).toBe('k:card:x')
    expect(mutationKey({ op: 'kb-card-remove', nodeId: 'x' }, P)).toBe('k:card:x')
    expect(mutationKey({ op: 'kb-column', column: { id: 'x', title: 'T', color: '#fff' } }, P)).toBe('k:col:x')
    expect(mutationKey({ op: 'kb-column-remove', id: 'x' }, P)).toBe('k:col:x')
    expect(mutationKey({ op: 'kb-meta-remove', nodeId: 'x' }, P)).toBe('k:meta:x')
    expect(mutationKey({ op: 'kb-label-order', ids: [] }, P)).toBe(`k:labelorder:${P}`)
    expect(mutationKey({ op: 'kb-view-remove', id: 'x' }, P)).toBe('k:view:x')
    // …never the node's key: a card move is not a node edit, a node delete does not tombstone its card
    expect(mutationKey(card('x', 'c', 'a', 1), P)).not.toBe(mutationKey(up('x', 0, 'a', 1)))
  })

  it('addresses no node (mutationNodeId is null for every kanban op)', () => {
    expect(mutationNodeId(card('n1', 'c', 'a', 1))).toBeNull()
    expect(mutationNodeId({ op: 'kb-card-remove', nodeId: 'n1' })).toBeNull()
    expect(mutationNodeId({ op: 'kb-meta', meta: { nodeId: 'n1' } })).toBeNull()
  })

  // D5: an order op lists only the ids its sender knew, so its sender — the one replica that dropped
  // it as an ack — kept its concurrent adds in arrival order while everyone else sorted them.
  it('the echo of our LAST order op for a board list is applied; any other echo of ours is an ack', () => {
    const o = createCanvasOrder('me')
    const order = (ids: string[]): CanvasMutation => ({ op: 'kb-column-order', ids, src: 'me' })
    o.onLocal(order(['a']), P)
    o.onLocal(order(['a', 'b']), P)
    // A later order op of ours is still in flight: this one loses anyway, and applying it would flicker.
    expect(o.accept({ ...order(['a']), seq: 3 }, P)).toBe(false)
    // Our last one: applied, so its unlisted ids are sorted here exactly as on every other replica.
    expect(o.accept({ ...order(['a', 'b']), seq: 4 }, P)).toBe(true)
    // The label list takes the same rule; an item op of ours stays a plain ack.
    const labels: CanvasMutation = { op: 'kb-label-order', ids: ['l1'], src: 'me' }
    o.onLocal(labels, P)
    expect(o.accept({ ...labels, seq: 5 }, P)).toBe(true)
    const colOp: CanvasMutation = { op: 'kb-column', column: { id: 'c1', title: 'T', color: '#fff' }, src: 'me' }
    o.onLocal(colOp, P)
    expect(o.accept({ ...colOp, seq: 6 }, P)).toBe(false)
  })

  it('two kb-card ops for the same card: the higher seq wins, the straggler is dropped', () => {
    const o = createCanvasOrder('me')
    expect(o.accept(card('n1', 'doing', 'a', 5), P)).toBe(true)
    expect(o.accept(card('n1', 'todo', 'b', 4), P)).toBe(false) // superseded by seq 5
    expect(o.accept(card('n1', 'done', 'b', 6), P)).toBe(true)
  })

  it('a kb-column-remove at seq 5 beats a kb-column cast before its sender saw it (seen 3, seq 6)', () => {
    const o = createCanvasOrder('me')
    expect(o.accept({ op: 'kb-column-remove', id: 'c1', src: 'a', seq: 5 }, P)).toBe(true)
    const stale: CanvasMutation = { op: 'kb-column', column: { id: 'c1', title: 'T', color: '#fff' }, src: 'b', seq: 6, seen: 3 }
    expect(o.accept(stale, P)).toBe(false)
    // a deliberate re-creation — cast knowing the removal — is applied
    expect(o.accept({ ...stale, seq: 7, seen: 6 }, P)).toBe(true)
  })

  it('label and view removals tombstone their keys the same way', () => {
    const o = createCanvasOrder('me')
    expect(o.accept({ op: 'kb-label-remove', id: 'l1', src: 'a', seq: 5 }, P)).toBe(true)
    expect(o.accept({ op: 'kb-label', label: { id: 'l1', name: 'Bug', color: 'red' }, src: 'b', seq: 6, seen: 3 }, P)).toBe(false)
    expect(o.accept({ op: 'kb-view-remove', id: 'v1', src: 'a', seq: 7 }, P)).toBe(true)
    expect(o.accept({ op: 'kb-view', view: { id: 'v1', name: 'Mine', query: {} }, src: 'b', seq: 8, seen: 3 }, P)).toBe(false)
  })

  it('a kb-card-remove does NOT tombstone: a kb-card with seen 3 at seq 6 after it (seq 5) is accepted', () => {
    const o = createCanvasOrder('me')
    expect(o.accept({ op: 'kb-card-remove', nodeId: 'n1', src: 'a', seq: 5 }, P)).toBe(true)
    expect(o.accept(card('n1', 'todo', 'b', 6, 3), P)).toBe(true)
  })

  it('a kb-meta-remove does NOT tombstone either', () => {
    const o = createCanvasOrder('me')
    expect(o.accept({ op: 'kb-meta-remove', nodeId: 'n1', src: 'a', seq: 5 }, P)).toBe(true)
    expect(o.accept({ op: 'kb-meta', meta: { nodeId: 'n1', priority: 'high' }, src: 'b', seq: 6, seen: 3 }, P)).toBe(true)
  })

  it('the rule-4 deletion classification is exactly the five removals', () => {
    const removes: CanvasMutation[] = [
      { op: 'remove', id: 'x' },
      { op: 'edge-remove', kind: 'bridge', id: 'x' },
      { op: 'kb-column-remove', id: 'x' },
      { op: 'kb-label-remove', id: 'x' },
      { op: 'kb-view-remove', id: 'x' }
    ]
    const values: CanvasMutation[] = [
      up('x', 0, 'a', 1),
      { op: 'edge-upsert', kind: 'rope', edge: { id: 'x', source: 'a', target: 'b' } },
      { op: 'kb-card-remove', nodeId: 'x' },
      { op: 'kb-meta-remove', nodeId: 'x' },
      { op: 'kb-column-order', ids: [] },
      { op: 'kb-label-order', ids: [] },
      card('x', 'c', 'a', 1)
    ]
    for (const m of removes) expect(isRemoveOp(m), m.op).toBe(true)
    for (const m of values) expect(isRemoveOp(m), m.op).toBe(false)
  })

  it('a rule-2 hold applies to a kb-card-remove (a value) but not to a kb-column-remove (a deletion)', () => {
    const o = createCanvasOrder('me')
    o.onLocal(o.stamp(card('n1', 'todo', 'me', 0)), P) // our own card move is unacked
    expect(o.accept({ op: 'kb-card-remove', nodeId: 'n1', src: 'peer', seq: 7 }, P)).toBe(false) // held off
    o.onLocal(o.stamp({ op: 'kb-column', column: { id: 'c1', title: 'T', color: '#fff' } }), P)
    expect(o.accept({ op: 'kb-column-remove', id: 'c1', src: 'peer', seq: 8 }, P)).toBe(true) // never held off
  })

  it('the re-creation gate covers a kanban deletion key, and ignores a card removal', () => {
    const o = createCanvasOrder('me')
    o.onLocal(o.stamp({ op: 'kb-column-remove', id: 'c1' }), P)
    expect(o.hasPendingRemove('k:col:c1')).toBe(true)
    o.onLocal(o.stamp({ op: 'kb-card-remove', nodeId: 'n1' }), P)
    expect(o.hasPendingRemove('k:card:n1')).toBe(false)
  })

  // RULING R4 — one CanvasOrder orders EVERY loaded project (Canvas keeps loaded-but-inactive
  // projects in step), so a board's two singleton keys must carry the project: otherwise our own
  // unacked reorder in project A holds off (rule 2) a peer's reorder in project B, and B diverges.
  it('a project-A pending order op does not suppress a peer\'s project-B order op', () => {
    const o = createCanvasOrder('me')
    o.onLocal(o.stamp({ op: 'kb-column-order', ids: ['a2', 'a1'] }), 'A') // ours, unacked
    expect(o.accept({ op: 'kb-column-order', ids: ['b3', 'b1'], src: 'peer', seq: 7, seen: 6 }, 'B')).toBe(true)
    o.onLocal(o.stamp({ op: 'kb-label-order', ids: ['la'] }), 'A')
    expect(o.accept({ op: 'kb-label-order', ids: ['lb'], src: 'peer', seq: 8 }, 'B')).toBe(true)
    // …while in project A itself rule 2 still holds
    expect(o.accept({ op: 'kb-column-order', ids: ['a1', 'a2'], src: 'peer', seq: 9 }, 'A')).toBe(false)
  })

  it('scopes only the two singleton keys: per-item kanban, node and edge keys ignore the project', () => {
    expect(mutationKey({ op: 'kb-column-order', ids: [] }, 'A')).toBe('k:colorder:A')
    expect(mutationKey({ op: 'kb-label-order', ids: [] }, 'B')).toBe('k:labelorder:B')
    expect(mutationKey(card('n1', 'c', 'a', 1), 'A')).toBe(mutationKey(card('n1', 'c', 'a', 1), 'B'))
    expect(mutationKey(up('n1', 0, 'a', 1), 'A')).toBe('n:n1')
    expect(mutationKey({ op: 'edge-remove', kind: 'rope', id: 'e1' }, 'A')).toBe('e:e1')
  })

  it('a straggler order op in one project is still a straggler; another project has its own order', () => {
    const o = createCanvasOrder('me')
    expect(o.accept({ op: 'kb-column-order', ids: ['x'], src: 'a', seq: 5 }, 'A')).toBe(true)
    expect(o.accept({ op: 'kb-column-order', ids: ['y'], src: 'b', seq: 4 }, 'A')).toBe(false)
    expect(o.accept({ op: 'kb-column-order', ids: ['z'], src: 'b', seq: 4 }, 'B')).toBe(true)
  })
})

describe('createCanvasOrder', () => {
  it('applies a peer mutation', () => {
    const o = createCanvasOrder('me')
    expect(o.accept(up('n1', 5, 'peer', 1))).toBe(true)
  })

  // Rule 1. Our own mutation comes back stamped (the reflector echoes to the sender — that echo is
  // the ack). It must NOT be re-applied: we applied it optimistically, and by the time it returns
  // the user may already have dragged the node further — re-applying would rubber-band it.
  it('never re-applies our own echo (it is an ack, not an edit)', () => {
    const o = createCanvasOrder('me')
    const mine = up('n1', 10, 'me', 1)
    o.onLocal(mine)
    expect(o.accept(mine)).toBe(false)
  })

  // Rule 2. While one of OUR mutations for a node is unacked, a peer's mutation for that node is
  // necessarily EARLIER in the total order (FIFO: had the reflector ordered ours first, our ack
  // would already be here). Ours will therefore win on every other client — so we keep ours.
  it('a peer mutation loses to an unacked local edit of the same node', () => {
    const o = createCanvasOrder('me')
    o.onLocal(up('n1', 200, 'me', 0)) // cast, not yet acked
    expect(o.accept(up('n1', 100, 'peer', 7))).toBe(false) // peer's edit: dropped, ours wins
    expect(o.accept(up('n1', 100, 'me', 8))).toBe(false) // …our ack arrives
    expect(o.accept(up('n1', 300, 'peer', 9))).toBe(true) // …and now peers land again
  })

  it('does not let one node\'s pending edit suppress another node', () => {
    const o = createCanvasOrder('me')
    o.onLocal(up('n1', 1, 'me', 0))
    expect(o.accept(up('n2', 1, 'peer', 4))).toBe(true)
  })

  it('counts pending edits per node (a drag casts many frames before the first ack)', () => {
    const o = createCanvasOrder('me')
    o.onLocal(up('n1', 1, 'me', 0))
    o.onLocal(up('n1', 2, 'me', 0))
    expect(o.accept(up('n1', 9, 'peer', 5))).toBe(false)
    expect(o.accept(up('n1', 1, 'me', 6))).toBe(false) // ack 1 of 2 — still one frame in flight
    expect(o.accept(up('n1', 9, 'peer', 7))).toBe(false)
    expect(o.accept(up('n1', 2, 'me', 8))).toBe(false) // ack 2 of 2
    expect(o.accept(up('n1', 9, 'peer', 9))).toBe(true)
  })

  // Deliveries are FIFO per connection, but a client applies mutations from SEVERAL senders, so a
  // straggler can still arrive after a newer mutation for the same node has landed (e.g. it was
  // held while one of ours was pending). Applying it would drag the node backwards out of the order.
  it('drops a mutation the total order has already superseded', () => {
    const o = createCanvasOrder('me')
    expect(o.accept(up('n1', 10, 'peer', 5))).toBe(true)
    expect(o.accept(up('n1', 99, 'other', 3))).toBe(false) // older seq → superseded
    expect(o.accept(up('n1', 99, 'other', 5))).toBe(false) // same seq → duplicate
    expect(o.accept(up('n1', 99, 'other', 6))).toBe(true) // newer → wins
  })

  it('a remove and an upsert of one node share the order (a remove is not special-cased)', () => {
    const o = createCanvasOrder('me')
    expect(o.accept(rm('n1', 'peer', 4))).toBe(true)
    expect(o.accept(up('n1', 1, 'peer', 3))).toBe(false) // an older upsert cannot resurrect it
    expect(o.accept(up('n1', 1, 'other', 5))).toBe(true) // a NEWER one can (that is undo-of-delete)
  })

  // The pending gate assumes the ack always comes back. It usually does — but an ack can be LATE
  // (our socket carries pty output too), and unbounded suppression would deafen the node to its
  // peers for the rest of the session.
  it('an ack that never arrives expires — a lost cast cannot deafen a node forever', () => {
    let t = 1000
    const o = createCanvasOrder('me', { now: () => t })
    o.onLocal(up('n1', 1, 'me', 0)) // cast… and no ack comes back
    expect(o.accept(up('n1', 5, 'peer', 2))).toBe(false)
    t += PENDING_TTL_MS + 1
    expect(o.accept(up('n1', 6, 'peer', 3))).toBe(true)
  })

  // Rule 3. Expiring the suppression let a peer overwrite an optimistic value we are still waiting
  // to have acked. Our echo is then the only copy of a value that WON on every other client — so it
  // repairs the node instead of being dropped as an ack. Without this, this client sat on the
  // losing value forever and wrote it to disk over everyone else's canvas.
  it('a late ack REPAIRS a node a peer overwrote after the TTL lapsed', () => {
    let t = 1000
    const o = createCanvasOrder('me', { now: () => t })
    o.onLocal(up('n1', 100, 'me', 0)) // cast; the reflector ordered it 7th — it wins everywhere
    t += PENDING_TTL_MS + 1 // our ack is stuck behind a backed-up socket
    expect(o.accept(up('n1', 50, 'peer', 6))).toBe(true) // …so the peer's OLDER edit lands on us
    expect(o.accept(up('n1', 100, 'me', 7))).toBe(true) // …and our late ack puts our value back
    // Settled: the node listens to peers again, and later echoes are ordinary acks once more.
    expect(o.accept(up('n1', 20, 'peer', 8))).toBe(true)
  })

  it('a late ack that LOST the total order is still just an ack (no rubber-band)', () => {
    let t = 1000
    const o = createCanvasOrder('me', { now: () => t })
    o.onLocal(up('n1', 100, 'me', 0)) // ordered 6th — the peer's edit is ordered AFTER it
    t += PENDING_TTL_MS + 1
    expect(o.accept(up('n1', 50, 'peer', 7))).toBe(true) // the peer's edit wins everywhere…
    expect(o.accept(up('n1', 100, 'me', 6))).toBe(false) // …so our echo is superseded: dropped
  })

  it('a fresh local edit re-arms the node, so an older echo of ours cannot replay over it', () => {
    let t = 1000
    const o = createCanvasOrder('me', { now: () => t })
    o.onLocal(up('n1', 100, 'me', 0))
    t += PENDING_TTL_MS + 1
    expect(o.accept(up('n1', 50, 'peer', 6))).toBe(true) // peer overwrote our optimistic value…
    o.onLocal(up('n1', 300, 'me', 0)) // …but the user drags it again: 300 is on our canvas now
    expect(o.accept(up('n1', 100, 'me', 7))).toBe(false) // the old echo must not rubber-band it
    expect(o.accept(up('n1', 300, 'me', 8))).toBe(false) // our new cast's echo is a plain ack
  })

  // A drag emits a frame every 50 ms. Dating the pending entry from the OLDEST unacked cast expired
  // it mid-drag, and a peer's older frame then rubber-banded a node the user was still holding.
  it('a continuous drag keeps its own suppression alive past the TTL', () => {
    let t = 1000
    const o = createCanvasOrder('me', { now: () => t })
    for (let i = 0; i < 200; i++) {
      o.onLocal(up('n1', i, 'me', 0)) // 200 frames × 50 ms = 10 s of dragging, all acked promptly
      expect(o.accept(up('n1', i, 'me', i + 1))).toBe(false)
      t += 50
    }
    o.onLocal(up('n1', 999, 'me', 0)) // still dragging, this frame not yet acked
    expect(o.accept(up('n1', 5, 'peer', 500))).toBe(false) // …a peer's frame still loses to ours
  })

  it('an unstamped mutation (no reflector in the path) is never treated as stale', () => {
    const o = createCanvasOrder('me')
    const unstamped: SceneMutation = { op: 'upsert', node: node('n1', 1) }
    expect(o.accept(unstamped)).toBe(true)
    expect(o.accept(unstamped)).toBe(true)
  })

  // RULE 4 — a delete is not an edit, and `seq` alone cannot tell them apart. Before this, A's
  // delete losing the order race to B's next drag frame left the node ALIVE on every canvas as a
  // shell around a tmux session `kill-session` had already killed. `seen` (what the sender had
  // applied when it cast) separates "a stale frame" from "a deliberate re-creation".
  describe('rule 4 — a stale frame cannot resurrect a deleted node', () => {
    it('drops an upsert whose sender had not yet seen the delete', () => {
      const o = createCanvasOrder('me')
      expect(o.accept(rm('n1', 'a', 10))).toBe(true)
      // B's drag frame: ordered AFTER the remove, but produced when B knew only up to seq 9.
      expect(o.accept({ ...up('n1', 42, 'b', 11), seen: 9 })).toBe(false)
    })

    it('applies an upsert whose sender HAD seen the delete (a deliberate re-creation)', () => {
      const o = createCanvasOrder('me')
      expect(o.accept(rm('n1', 'a', 10))).toBe(true)
      // A's own ⌘Z, or anyone adding the node back: cast in full knowledge of the delete.
      expect(o.accept({ ...up('n1', 42, 'a', 11), seen: 10 })).toBe(true)
      // …and the node is alive again, so an ordinary later edit is not blocked by a dead entry.
      expect(o.accept({ ...up('n1', 43, 'b', 12), seen: 11 })).toBe(true)
    })

    it('does not judge an unstamped upsert (an older peer degrades, it does not break)', () => {
      const o = createCanvasOrder('me')
      expect(o.accept(rm('n1', 'a', 10))).toBe(true)
      expect(o.accept(up('n1', 42, 'b', 11))).toBe(true) // no `seen`: the pre-rule-4 verdict
    })

    // The mirror on the receiving side. Rule 2 rests on "our unacked mutation is later in the total
    // order, so it wins everywhere" — under rule 4 it does not, because every peer is about to drop
    // it as older than this delete. Suppressing the remove here is the one way to disagree with them.
    it('a remove is never held off by our own unacked drag (rule 2 does not apply to it)', () => {
      const o = createCanvasOrder('me')
      o.onLocal(o.stamp(up('n1', 1, 'me', 0))) // we are mid-drag, nothing acked yet
      expect(o.accept(up('n1', 5, 'peer', 7))).toBe(false) // a peer's EDIT still loses to ours
      expect(o.accept(rm('n1', 'peer', 8))).toBe(true) // …a peer's DELETE does not
    })

    // …and our own frames, echoed back after that delete, must not put the node back on OUR canvas
    // alone (every other client dropped them for being older than the remove).
    it('our own echo cannot resurrect a node a peer deleted mid-drag', () => {
      let t = 1000
      const o = createCanvasOrder('me', { now: () => t })
      o.onLocal(o.stamp(up('n1', 1, 'me', 0)))
      t += PENDING_TTL_MS + 1 // our ack is stuck; rule 3 would otherwise call the echo a repair
      expect(o.accept(rm('n1', 'peer', 20))).toBe(true)
      expect(o.accept({ ...up('n1', 1, 'me', 21), seen: 5 })).toBe(false)
    })

    it('stamps our casts with the highest seq we have processed, our own echo included', () => {
      const o = createCanvasOrder('me')
      expect(o.stamp(up('n1', 0, 'me', 0)).seen).toBe(0) // nothing applied yet
      o.accept(up('n2', 1, 'peer', 4))
      expect(o.stamp(up('n1', 0, 'me', 0)).seen).toBe(4)
      o.accept(up('n2', 2, 'me', 9)) // our own ack still advances our causal position
      expect(o.stamp(up('n1', 0, 'me', 0)).seen).toBe(9)
      o.accept(up('n2', 3, 'peer', 2)) // a straggler proves the order reached 2 — never lowers it
      expect(o.stamp(up('n1', 0, 'me', 0)).seen).toBe(9)
    })

    it('stamp is pure — it records no pending entry (a refused cast must cost nothing)', () => {
      const o = createCanvasOrder('me')
      o.stamp(up('n1', 1, 'me', 0)) // …the size guard then refuses it: onLocal is never called
      expect(o.accept(up('n1', 5, 'peer', 3))).toBe(true) // so the node is NOT deafened to peers
    })

    // The tombstone set is capped (a session's whole delete history), and the eviction is a plain
    // LRU whose cost is spelled out in REMOVED_MAX's comment: the OLDEST entry degrades to the
    // pre-rule-4 verdict (a stale upsert is applied again), and nothing else changes.
    it(`evicts the oldest tombstone past REMOVED_MAX (${REMOVED_MAX}): only that id degrades`, () => {
      const o = createCanvasOrder('me')
      for (let i = 0; i <= REMOVED_MAX; i++) expect(o.accept(rm(`d${i}`, 'a', i + 1))).toBe(true)
      // 513 removes: d0 (seq 1) is the one evicted, d1 (seq 2) the oldest retained.
      const next = REMOVED_MAX + 2
      // A stale frame for the evicted id is judged as before rule 4 existed — applied.
      expect(o.accept({ ...up('d0', 5, 'b', next), seen: 0 })).toBe(true)
      // …while one for a retained id is still dropped, the newest included.
      expect(o.accept({ ...up('d1', 5, 'b', next + 1), seen: 0 })).toBe(false)
      expect(o.accept({ ...up(`d${REMOVED_MAX}`, 5, 'b', next + 2), seen: REMOVED_MAX })).toBe(false)
    })

    it('reset clears the removed set (a fresh core restarts its seq at 0)', () => {
      const o = createCanvasOrder('me')
      expect(o.accept(rm('n1', 'a', 10))).toBe(true)
      o.reset()
      // Same low seq the new core would hand out: without the clear, the old entry (10) would
      // outrank every new mutation and blackhole this node for the rest of the session.
      expect(o.accept({ ...up('n1', 1, 'b', 1), seen: 0 })).toBe(true)
    })

    // …but NOT our causal position. A reset also fires on a reconnect to the SAME core (a new
    // clientId, `seq` carrying on), and a `seen` of 0 on our first cast after it — say, ⌘Z on a node
    // deleted before the drop — made every peer that still holds the tombstone drop the re-creation
    // as a stale frame, while our echo is no repair: a persistent split.
    it('reset keeps our causal position: a re-creation after a reconnect is applied by a peer', () => {
      const me = createCanvasOrder('me')
      const peer = createCanvasOrder('peer')
      expect(peer.accept(rm('n1', 'x', 10))).toBe(true) // the peer tombstones n1 at 10
      me.accept(rm('n1', 'x', 10)) // …and so did we
      me.reset() // a new connection to the same core
      const redo = me.stamp(up('n1', 1, 'me', 0))
      expect(redo.seen).toBe(10) // was: 0
      expect(peer.accept({ ...redo, seq: 11 })).toBe(true) // a re-creation, not a stale frame
    })
  })

  // D4: `reset()` keeps our causal position for a same-core reconnect, but after a REAL restart the
  // kept value sat above every seq the new core handed out until its counter caught up, so every
  // cast read as "never stale" for that whole stretch. The first seq heard after a reset says which
  // one it was.
  describe('the causal position after a reset (D4)', () => {
    it('a first seq at or below it means the core restarted: the position drops to that seq', () => {
      const me = createCanvasOrder('me')
      me.accept(up('n2', 0, 'x', 40)) // the old core had reached 40
      me.reset()
      me.accept(up('n3', 0, 'x', 2)) // the NEW core's first op
      const stale = me.stamp(up('n1', 1, 'me', 0)) // a drag frame, cast in ignorance of…
      expect(stale.seen).toBe(2)
      // …a teammate's delete the new core ordered at 3: every peer drops the frame, as it would have
      // before the restart. With the kept 40 it read as "never stale" and resurrected the node.
      const peer = createCanvasOrder('peer')
      expect(peer.accept(rm('n1', 'x', 3))).toBe(true)
      expect(peer.accept({ ...stale, seq: 4 })).toBe(false)
    })

    it('a first seq above it is the same core carrying on: the position is kept, then rises', () => {
      const me = createCanvasOrder('me')
      me.accept(up('n2', 0, 'x', 40))
      me.reset()
      expect(me.stamp(up('n1', 1, 'me', 0)).seen).toBe(40) // nothing heard yet: kept
      me.accept(up('n3', 0, 'x', 41))
      expect(me.stamp(up('n1', 1, 'me', 0)).seen).toBe(41)
    })

    it('only the FIRST stamped seq after a reset decides; an unstamped op does not', () => {
      const me = createCanvasOrder('me')
      me.accept(up('n2', 0, 'x', 40))
      me.reset()
      me.accept(up('n3', 0, 'x', 0)) // unstamped: says nothing about the counter
      me.accept(up('n4', 0, 'x', 5)) // the new core
      me.accept(up('n5', 0, 'x', 2)) // a straggler after it moves nothing back
      expect(me.stamp(up('n1', 1, 'me', 0)).seen).toBe(5)
    })
  })

  // THE RE-CREATION GATE (port map §6.5). Rule 4 judges an upsert by what its sender had applied
  // when it cast (`seen`). Our OWN remove is applied locally at once, but it enters `seen` only when
  // its echo comes back — so a re-creation of the same id cast before that echo (a link deleted and
  // redrawn, a node deleted and ⌘Z'd, inside one round trip) carries a `seen` below the remove and
  // every peer drops it as a stale frame, while we keep showing it: a split. The caller holds such a
  // re-creation back while our remove is unacked; this is the question it asks.
  describe('a pending local remove (the re-creation gate)', () => {
    it('reports a pending local remove until its echo returns', () => {
      const o = createCanvasOrder('a')
      const rm: SceneMutation = { op: 'edge-remove', kind: 'bridge', id: 'b1', src: 'a' }
      o.onLocal(rm)
      expect(o.hasPendingRemove('e:b1')).toBe(true)
      o.accept({ ...rm, seq: 7 })
      expect(o.hasPendingRemove('e:b1')).toBe(false)
    })

    it('covers a node key the same way', () => {
      const o = createCanvasOrder('me')
      o.onLocal(o.stamp(rm('n1', 'me', 0)))
      expect(o.hasPendingRemove('n:n1')).toBe(true)
      expect(o.hasPendingRemove('e:n1')).toBe(false) // one key space, two prefixes
      o.accept(rm('n1', 'me', 3))
      expect(o.hasPendingRemove('n:n1')).toBe(false)
    })

    it('counts removes: one ack does not release a key with a second remove still in flight', () => {
      const o = createCanvasOrder('me')
      o.onLocal(rm('n1', 'me', 0))
      o.onLocal(rm('n1', 'me', 0))
      o.accept(rm('n1', 'me', 4))
      expect(o.hasPendingRemove('n:n1')).toBe(true)
      o.accept(rm('n1', 'me', 5))
      expect(o.hasPendingRemove('n:n1')).toBe(false)
    })

    it('only a REMOVE counts: an unacked edit of the key is not a pending remove', () => {
      const o = createCanvasOrder('me')
      o.onLocal(up('n1', 1, 'me', 0))
      expect(o.hasPendingRemove('n:n1')).toBe(false)
    })

    it('a peer’s remove of the same key is not our ack', () => {
      const o = createCanvasOrder('me')
      o.onLocal(rm('n1', 'me', 0))
      o.accept(rm('n1', 'peer', 6))
      expect(o.hasPendingRemove('n:n1')).toBe(true)
    })

    it('an ack for a remove we no longer track (after a reset) releases nothing twice', () => {
      const o = createCanvasOrder('me')
      o.onLocal(rm('n1', 'me', 0))
      o.reset()
      expect(o.hasPendingRemove('n:n1')).toBe(false) // a reconnect forgets the in-flight casts
      o.accept(rm('n1', 'me', 2)) // the old echo straggling in
      o.onLocal(rm('n1', 'me', 0))
      expect(o.hasPendingRemove('n:n1')).toBe(true) // a later remove still counts from one
    })

    // D4: a single `canvas:mut` can be dropped on its way back with the connection kept (the ui
    // sink's SINK_FAILURE_LIMIT), so "a lost echo comes with a reconnect" was false and the gate
    // stuck for the session. Echoes come back in the order we cast (FIFO), so the echo of a LATER
    // cast of ours proves every earlier one that has not arrived was lost.
    it('the echo of a LATER cast of ours releases an earlier remove whose echo was lost (D4)', () => {
      const o = createCanvasOrder('me')
      o.onLocal(rm('n1', 'me', 0)) // its echo is dropped on the way back
      o.onLocal(up('n2', 1, 'me', 0))
      expect(o.hasPendingRemove('n:n1')).toBe(true)
      expect(o.pendingRemoveCount()).toBe(1)
      o.accept(up('n2', 1, 'me', 8)) // the next echo of ours arrives
      expect(o.hasPendingRemove('n:n1')).toBe(false)
      expect(o.pendingRemoveCount()).toBe(0)
    })

    it('an echo of an EARLIER cast never releases a later remove, and a peer’s op releases nothing (D4)', () => {
      const o = createCanvasOrder('me')
      o.onLocal(up('n2', 1, 'me', 0))
      o.onLocal(rm('n1', 'me', 0))
      o.accept(up('n2', 1, 'me', 8)) // the echo of the cast BEFORE the remove
      expect(o.hasPendingRemove('n:n1')).toBe(true)
      o.accept(up('n3', 1, 'peer', 9))
      o.accept(rm('n4', 'peer', 10))
      expect(o.hasPendingRemove('n:n1')).toBe(true)
      o.accept(rm('n1', 'me', 11)) // its own echo
      expect(o.hasPendingRemove('n:n1')).toBe(false)
    })

    it('counts per cast: a lost remove releases its own count only (D4)', () => {
      const o = createCanvasOrder('me')
      o.onLocal(rm('n1', 'me', 0)) // lost
      o.onLocal(rm('n1', 'me', 0)) // arrives
      o.onLocal(up('n9', 1, 'me', 0)) // arrives
      o.accept(rm('n1', 'me', 5)) // FIFO: the FIRST n1 cast's echo — the second n1 is still in flight
      expect(o.hasPendingRemove('n:n1')).toBe(true)
      o.accept(up('n9', 1, 'me', 6)) // …and this one proves the second n1 echo lost
      expect(o.hasPendingRemove('n:n1')).toBe(false)
    })

    // The FIFO record is capped (LOCAL_CASTS_MAX), and it only fills while the core answers nothing
    // at all — a long drag against a dead connection that never resets. Two things must hold when
    // it overflows: a remove shifted out is released THEN (it can never be matched again, so kept it
    // would stick until a reset), and an echo whose own record is gone matches nothing (matched to a
    // LATER cast of the same key, it released every remove cast in between, echoes still in flight).
    it('a remove shifted out of the record is released then, and its late echo is not a later remove’s', () => {
      const o = createCanvasOrder('me')
      o.onLocal(rm('n1', 'me', 0)) // its echo is on its way…
      for (let i = 0; i < LOCAL_CASTS_MAX; i++) o.onLocal(up('d', i, 'me', 0)) // …behind a long, unanswered drag
      expect(o.hasPendingRemove('n:n1')).toBe(false) // the pre-gate degrade, not a gate stuck for the session
      expect(o.pendingRemoveCount()).toBe(0)
      o.onLocal(rm('n1', 'me', 0)) // deleted again
      o.accept(rm('n1', 'me', 5)) // the FIRST remove's echo, at last
      expect(o.hasPendingRemove('n:n1')).toBe(true) // …is not the second one's ack
      o.accept(rm('n1', 'me', 6)) // the second one's own echo
      expect(o.hasPendingRemove('n:n1')).toBe(false)
    })

    it('an echo whose record was shifted out releases nothing — not a later remove still in flight', () => {
      const o = createCanvasOrder('me')
      o.onLocal(up('d', 0, 'me', 0)) // the oldest cast: its record is about to be forgotten
      for (let i = 1; i < LOCAL_CASTS_MAX; i++) o.onLocal(up('f', i, 'me', 0))
      o.onLocal(rm('n1', 'me', 0)) // the record is full: `d`'s entry is shifted out
      o.onLocal(up('d', 1, 'me', 0)) // a LATER cast of the same key
      o.accept(up('d', 0, 'me', 7)) // the echo of the forgotten one
      expect(o.hasPendingRemove('n:n1')).toBe(true) // n1's echo has not come back
      expect(o.pendingRemoveCount()).toBe(1)
      o.accept(rm('n1', 'me', 8)) // its own echo (the ones before it proven lost, FIFO)
      expect(o.hasPendingRemove('n:n1')).toBe(false)
    })

    it('an echo matched to a recorded cast proves every forgotten echo lost, so none is waited for', () => {
      const o = createCanvasOrder('me')
      o.onLocal(up('d', 0, 'me', 0)) // the oldest cast — and its echo is lost
      for (let i = 1; i < LOCAL_CASTS_MAX; i++) o.onLocal(up('f', i, 'me', 0))
      o.onLocal(up('x', 0, 'me', 0)) // `d`'s record is shifted out
      o.onLocal(rm('d', 'me', 0))
      o.accept(up('x', 0, 'me', 9)) // a recorded cast's echo: everything older is proven lost (FIFO)
      o.accept(rm('d', 'me', 10)) // so this is the remove's own echo, not the forgotten frame's
      expect(o.hasPendingRemove('n:d')).toBe(false)
    })

    it('isRemoveOp is the order’s own remove predicate, nodes and edges alike', () => {
      expect(isRemoveOp(rm('n1', 'me', 0))).toBe(true)
      expect(isRemoveOp({ op: 'edge-remove', kind: 'rope', id: 'r1' })).toBe(true)
      expect(isRemoveOp(up('n1', 0, 'me', 0))).toBe(false)
      expect(
        isRemoveOp({ op: 'edge-upsert', kind: 'bridge', edge: { id: 'b1', source: 'a', target: 'b' } })
      ).toBe(false)
    })

    // WHY the gate lives in the caller: the whole failure is visible on a PEER'S order. Cast before
    // our remove's echo, the re-creation is a stale frame there; cast after it, it is a re-creation.
    it('a re-creation cast before our remove’s echo is stale on a peer; cast after it, it applies', () => {
      const me = createCanvasOrder('me')
      const peer = createCanvasOrder('peer')
      me.accept(up('n2', 0, 'peer', 5)) // we have applied the order up to 5
      const remove = me.stamp(rm('n1', 'me', 0))
      me.onLocal(remove)
      expect(peer.accept({ ...remove, seq: 6 })).toBe(true) // the peer tombstones n1 at 6
      const early = me.stamp(up('n1', 1, 'me', 0)) // ⌘Z before our echo is back: seen 5
      expect(peer.accept({ ...early, seq: 7 })).toBe(false) // dropped as a stale frame
      me.accept({ ...remove, seq: 6 }) // our echo lands…
      const late = me.stamp(up('n1', 1, 'me', 0)) // …so the re-creation now carries seen 6
      expect(peer.accept({ ...late, seq: 8 })).toBe(true)
    })
  })

  it('reset forgets the order and the pending edits (project switch / reconnect)', () => {
    const o = createCanvasOrder('me')
    o.onLocal(up('n1', 1, 'me', 0))
    expect(o.accept(up('n1', 5, 'peer', 9))).toBe(false)
    o.reset()
    expect(o.accept(up('n1', 5, 'peer', 1))).toBe(true) // pending gone AND the seq floor gone
  })
})

// WHEN to call reset(). It exists for ONE reason — a core restart puts `seq` back at 0 while our
// `seen` map still holds the old (high) values, and we would then drop every new mutation as a
// straggler — and it is EXPENSIVE to call when that reason does not hold: it drops `pending` and
// `superseded`, i.e. the in-flight casts whose late echo is the only thing that can repair a node a
// peer overwrote. So it must fire on a genuine reconnect and NOWHERE else.
describe('createReconnectWatch', () => {
  it('does not reset on the first hello (null → myId): there is no older connection to forget', () => {
    const w = createReconnectWatch(null)
    expect(w(null)).toBe(false) // still no id (presence has not answered yet)
    expect(w('cl-1')).toBe(false) // our FIRST clientId — nothing was ever seen from an older core
    expect(w('cl-1')).toBe(false) // idle presence updates (a peer's cursor) are not reconnects
  })

  it('resets when a NEW clientId replaces an old one (a genuine reconnect)', () => {
    const w = createReconnectWatch(null)
    expect(w('cl-1')).toBe(false)
    expect(w('cl-2')).toBe(true) // reconnected: the core may have restarted with seq back at 0
    expect(w('cl-2')).toBe(false)
  })

  it('survives the null in the middle of a reconnect (id → null → new id still resets)', () => {
    const w = createReconnectWatch('cl-1')
    expect(w(null)).toBe(false) // the socket dropped: keep the state, wait for the new id
    expect(w('cl-1')).toBe(false) // …the SAME connection came back: nothing to forget
    expect(w(null)).toBe(false)
    expect(w('cl-3')).toBe(true) // a different one: reset
  })

  it('an id already known at mount is not a reconnect', () => {
    const w = createReconnectWatch('cl-1')
    expect(w('cl-1')).toBe(false)
  })

  // The desktop presence hub's clientId is a NUMBER (the Electron sender id) — and 0 is a perfectly
  // real connection, so only `null` may mean "no id yet".
  it('treats a numeric clientId of 0 as a real connection, not as "not resolved yet"', () => {
    const w = createReconnectWatch(null)
    expect(w(0)).toBe(false) // the first hello…
    expect(w(0)).toBe(false)
    expect(w(1)).toBe(true) // …and a genuine reconnect after it
  })
})
