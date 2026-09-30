// Convergence: two clients, interleaved local edits, one ordering reflector → identical node sets.
//
// No CRDT: per-node last-write-wins IN THE REFLECTOR'S TOTAL ORDER is the whole contract. That
// property is what makes persistence safe — whichever client calls workspace.save writes the same
// bytes, so a peer's delete can never be written back to disk by someone whose canvas still held
// the node, and two people dragging one node cannot leave it at two different places forever.
//
// THE BUS IS ASYNCHRONOUS, deliberately. The first version of this suite delivered each mutation
// into the peer inside the sender's own cast() call, so two edits could never be in flight at once
// — which is the ONLY condition under which last-write-wins can diverge. It therefore "passed" a
// design that diverged permanently on the very first concurrent drag. A synchronous bus cannot
// catch this class of bug. Here, casts and deliveries are QUEUED (FIFO per link, exactly as IPC and
// a WebSocket deliver), so a test can hold several edits in flight and choose the interleaving.
//
// Everything else runs against the REAL pieces: the real reflector (initCanvasSync — `seq` stamping
// + fan-out to every client, sender included), the real publisher (createCanvasPublisher: diff,
// `src` stamping, adopt loop guard, ephemeral filter), the real ordering state (createCanvasOrder)
// and the real apply vocabulary (applyCanvasMutation). Only the transport is simulated.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { initPlatform, resetPlatformForTests, type CorePlatform } from './platform'
import { makeFakeUserDataDir } from './platform-fake'
import { initCanvasSync, MUTATION_MAX_BYTES, setReflectedListener } from './canvas-sync'
import { createCanvasAuthority } from './canvas-authority'
import {
  applyCanvasMutation,
  applyEdgeMutationToScene,
  isCanvasMutation,
  type CanvasScene
} from '../shared/canvas-mutations'
import {
  createCanvasOrder,
  createReconnectWatch,
  isRemoveOp,
  mutationKey,
  PENDING_TTL_MS
} from '../shared/canvas-order'
import { createCanvasPublisher, publishableScene, shouldPublishCanvas } from '../shared/canvas-publish'
import { applyCanvasOp, type CanvasContent } from '../shared/canvas-content'
import { defaultKanbanFor } from '../shared/kanban-default-board'
import { applyKanbanOp, diffKanbanOps, isKanbanOp, sanitizeKanbanOp } from '../shared/kanban-ops'
import { IPC } from '../shared/ipc'
import type { BridgeLink, CanvasMutation, CanvasNodeState, ProjectKanban } from '../shared/types'

const node = (id: string, x: number, title = 't', color = '#fff'): CanvasNodeState =>
  ({
    id,
    kind: 'terminal',
    title,
    color,
    group: null,
    position: { x, y: 0 },
    size: { width: 10, height: 10 }
  }) as CanvasNodeState

/** A sticky whose body someone pasted a document into: its serialized form is over
 *  MUTATION_MAX_BYTES, so the reflector REFUSES it at ingest — silently, with no negative ack. */
const fat = (id: string): CanvasNodeState =>
  ({
    ...node(id, 0),
    kind: 'sticky',
    data: { text: 'x'.repeat(MUTATION_MAX_BYTES) }
  }) as CanvasNodeState

const PROJECT = 'p1'

/**
 * The transport, ASYNC. Two FIFO queues — the two orderings a real deployment guarantees:
 *   - `casts`: client → reflector. The order the reflector pops them in IS the total order.
 *   - `inbox[clientId]`: reflector → that client. Per-connection FIFO (IPC and WS both give this,
 *     and canvas-order's rule 2 depends on it).
 * Nothing moves until the test says so, so several clients can hold edits in flight at once.
 */
class Bus {
  private readonly senderListeners = new Map<string, (senderId: number, ...args: any[]) => void>()
  private readonly casts: Array<{ sender: number; projectId: string; m: CanvasMutation }> = []
  private readonly inbox = new Map<number, Array<{ projectId: string; m: CanvasMutation }>>()
  readonly deliver = new Map<number, (projectId: string, m: CanvasMutation) => void>()
  clients: number[] = []
  /** Total casts made BY clients (publisher → reflector). One per real local edit; never more. */
  castCount = 0
  /** Clients whose INBOX is stalled — their socket is backed up (Stage 2 tolerates an 8 MB pty
   *  backlog on the very same socket), so their acks and their peers' mutations arrive late.
   *  Their casts still reach the reflector: only the return path is blocked. */
  private readonly stalled = new Set<number>()

  platform: CorePlatform = {
    // Never a fixed literal: a predictable '/tmp/...' registered through initPlatform is the
    // js/insecure-temporary-file shape (see canvas-sync.test.ts). Under the run root, removed with it.
    userDataDir: makeFakeUserDataDir(),
    appVersion: '0.0.0-test',
    isPackaged: false,
    handle: () => {},
    on: () => {},
    handleWithSender: () => {},
    onWithSender: (ch, fn) => void this.senderListeners.set(ch, fn),
    clientIds: () => this.clients,
    sendTo: (to, channel, ...args) => {
      if (channel !== IPC.canvasMut) return
      const q = this.inbox.get(to) ?? []
      q.push({ projectId: args[0] as string, m: args[1] as CanvasMutation })
      this.inbox.set(to, q)
    },
    broadcast: () => {},
    openExternal: async () => {}
  }

  /** A client casts: the mutation is QUEUED, not reflected. It reaches the reflector on settle(). */
  cast(senderId: number, projectId: string, m: CanvasMutation): void {
    this.castCount++
    this.casts.push({ sender: senderId, projectId, m })
  }

  /** Pop one cast into the reflector — this is where a mutation gets its place in the total order. */
  private stepCast(): boolean {
    const c = this.casts.shift()
    if (!c) return false
    this.senderListeners.get(IPC.canvasMut)?.(c.sender, c.projectId, c.m)
    return true
  }

  /** Stall / unstall one client's inbox (a backed-up socket). */
  stall(id: number): void {
    this.stalled.add(id)
  }

  unstall(id: number): void {
    this.stalled.delete(id)
  }

  /** Pop one queued delivery into its addressed client (FIFO within that client's inbox). */
  private stepDelivery(): boolean {
    for (const id of this.clients) {
      if (this.stalled.has(id)) continue
      const q = this.inbox.get(id)
      if (!q?.length) continue
      const d = q.shift() as { projectId: string; m: CanvasMutation }
      this.deliver.get(id)?.(d.projectId, d.m)
      return true
    }
    return false
  }

  /** Run the network to quiescence: every queued cast reflected, every delivery delivered. */
  settle(): void {
    for (let i = 0; i < 10_000; i++) {
      if (this.stepCast()) continue
      if (this.stepDelivery()) continue
      return
    }
    throw new Error('bus did not settle — mutation loop?')
  }
}

/** A simulated client: its own node list, publisher and ordering state, wired by ClientId.
 *  Mirrors the two Canvas effects — publish the diff of the settled snapshot; on an incoming
 *  mutation ask the ordering state whether to apply it, then adopt (never re-publish) the result. */
class Client {
  states: CanvasNodeState[] = []
  /** The two PERSISTED edge lists, alongside the nodes — they ride the same whole-file save, so
   *  they are part of what has to converge (see the edge tests at the bottom). */
  bridges: BridgeLink[] = []
  ropes: BridgeLink[] = []
  /** Ephemeral cards (subagent / loop) this client renders — derived locally, never published. */
  ephemeral = new Set<string>()
  /** The project's board. Absent = the deterministic lazy default, exactly as a project whose file
   *  has no `kanban` block — so it is part of what converges, like the edge lists. */
  board: ProjectKanban | undefined = undefined
  /** Every mutation this client CAST, in order (after its own gates) — what a test reads to prove a
   *  rule held on the SENDING side, e.g. that a prune removal never left this client. */
  readonly cast: CanvasMutation[] = []
  /** Mutations APPLIED from the wire (an own echo, or one the order supersedes, is not applied). */
  applied = 0
  /** Local mutations the publisher tried to cast and this client refused (oversized / malformed). */
  refused = 0
  private readonly order: ReturnType<typeof createCanvasOrder>
  private readonly pub: ReturnType<typeof createCanvasPublisher>
  private readonly src: string
  /** Mirrors Canvas's presence subscription: reset the order state only on a GENUINE reconnect. */
  private readonly reconnected = createReconnectWatch(null)

  constructor(
    readonly id: number,
    private readonly bus: Bus,
    /** Canvas's publish gate. Absent = always publish (every other test here has a peer attached). */
    gate?: () => boolean
  ) {
    // Built here, not as field initializers: a field initializer runs BEFORE the parameter
    // properties are assigned, so `this.id` would still be undefined and both clients would stamp
    // the same `src` — every peer mutation would then look like their own echo.
    const src = `src-${id}`
    this.src = src
    // A FAKE clock: the pending TTL is the one time-dependent rule in canvas-order, and the tests
    // below need to cross it deliberately (`clock += ...`) rather than by sleeping.
    this.order = createCanvasOrder(src, { now: () => clock })
    // Mirrors Canvas: the node/edge publisher and the board publisher cast through ONE send
    // (`castFor`), so both families are stamped, gated and recorded by the same order.
    this.pub = createCanvasPublisher((m) => this.send(m), { src, ...(gate ? { shouldPublish: gate } : {}) })
    bus.deliver.set(id, (projectId, m) => {
      if (projectId !== PROJECT) return
      // Mirrors Canvas: our own remove coming back RELEASES a re-creation the gate held — cast it now,
      // after this mutation is handled (a repaired remove is applied first), or it waits for an edit.
      const key = mutationKey(m, projectId)
      const held = this.order.hasPendingRemove(key)
      const apply = this.order.accept(m, projectId)
      const released = held && !this.order.hasPendingRemove(key)
      if (apply && isKanbanOp(m)) {
        // Mirrors Canvas: a board op lands in the projects STORE through the one reducer — never
        // through the board funnel, whose publish hook would cast it again — and touches no node.
        this.applied++
        this.board = applyCanvasOp(this.content(), m, PROJECT).kanban
      } else if (apply) {
        this.applied++
        this.states = applyCanvasMutation(this.states, m)
        // One id is one edge across both lists — what Canvas and the projects store apply.
        const edges = applyEdgeMutationToScene({ bridges: this.bridges, ropes: this.ropes }, m)
        this.bridges = edges.bridges
        this.ropes = edges.ropes
        this.pub.adopt(this.publishable()) // loop guard — never re-publish someone else's change
      }
      if (released && this.pub.hasOwed()) this.pub.publish(this.publishable())
    })
  }

  /** THE ONE CAST — Canvas's `castFor`, for the one project this harness has: stamp `src` + `seen`,
   *  the re-creation gate, the reflector's own predicate, then record it as pending and cast. */
  private send(m: CanvasMutation): boolean {
    // Mirrors Canvas: ask the SAME predicate the reflector's ingest asks, BEFORE recording a
    // pending entry or casting. A refusal means nothing was cast — so nothing is pending (the
    // node stays open to its peers) and the publisher keeps the node in its baseline and
    // retries it on the next publish. Canvas also surfaces the refusal to the user.
    // Stamp our causal position FIRST, so the guard judges the exact payload that is cast
    // (canvas-order rule 4 — `seen` is what lets a delete beat a concurrent drag frame).
    const stamped = this.order.stamp({ ...m, src: this.src })
    // The re-creation gate, as Canvas has it: a re-creation of a key whose remove of ours is
    // still unacked would carry a `seen` below that remove — held (owed) until the echo lands.
    // The project rides every key the order builds (ruling R4: a board's order ops are
    // per-project singletons) — the same PROJECT the cast goes out on.
    if (!isRemoveOp(stamped) && this.order.hasPendingRemove(mutationKey(stamped, PROJECT))) return false
    if (!isCanvasMutation(stamped)) {
      this.refused++
      return false
    }
    this.order.onLocal(stamped, PROJECT)
    this.cast.push(stamped)
    this.bus.cast(this.id, PROJECT, stamped)
    return true
  }

  private content(): CanvasContent {
    return { nodes: this.states, bridges: this.bridges, ropes: this.ropes, ...(this.board ? { kanban: this.board } : {}) }
  }

  private publishable(): CanvasScene {
    return publishableScene(
      { nodes: this.states, bridges: this.bridges, ropes: this.ropes },
      this.ephemeral
    )
  }

  /** A local edit: take the new node list, then publish the diff (what the Canvas effect does). */
  edit(next: CanvasNodeState[]): void {
    this.states = next
    this.pub.publish(this.publishable())
  }

  /** A local EDGE edit — drawing or deleting a context link / rope. Same effect, same publisher:
   *  the Canvas publish effect has the edge arrays in its deps for exactly this. */
  editEdges(next: { bridges?: BridgeLink[]; ropes?: BridgeLink[] }): void {
    if (next.bridges) this.bridges = next.bridges
    if (next.ropes) this.ropes = next.ropes
    this.pub.publish(this.publishable())
  }

  /** A local BOARD edit — what `useProjects.setProjectKanban` + the kanban publisher do
   *  (renderer/canvas/kanban-sync.ts): diff the board item by item against this client's OWN nodes
   *  (a card whose node is not live here is pruned locally and its removal is never cast), cast the
   *  clean form of each op through the same send, and keep that clean form locally when the board
   *  held something else (ruling R2: the reflector repairs what it relays and our own echo is only
   *  an ack, so an unrepaired local value would be ours alone, for good). */
  editBoard(next: ProjectKanban): void {
    const prev = this.board
    this.board = next
    const live = new Set(this.states.map((n) => n.id))
    for (const op of diffKanbanOps(prev, next, PROJECT, live)) {
      const clean = sanitizeKanbanOp(op)
      if (!clean) continue
      if (this.send(clean) && stableJson(clean) !== stableJson(op))
        this.board = applyCanvasOp(this.content(), clean, PROJECT).kanban
    }
  }

  /** Our presence clientId resolved (or changed). What Canvas's presence subscription does: the
   *  ordering state is forgotten ONLY when a NEW clientId replaces an OLD one — a fresh connection
   *  to a core whose `seq` may have restarted at 0. The first `null → myId` hello is not that. */
  presence(id: string | null): void {
    if (this.reconnected(id)) this.order.reset()
  }

  /** Adopt the freshly loaded canvas as the publisher baseline without publishing it — what Canvas
   *  does while `loadingRef` is set (a project load is not an edit). */
  pubAdopt(): void {
    this.pub.adopt(this.publishable())
  }

  /** The node set that would be written by this client's workspace.save (ephemeral cards excluded,
   *  as flowToNodeStates already excludes them). */
  persisted(): CanvasScene {
    return this.publishable()
  }

  ids(): string[] {
    return this.states.map((n) => n.id).sort()
  }

  x(id: string): number | undefined {
    return this.states.find((n) => n.id === id)?.position.x
  }
}

/**
 * The convergence contract, canonically: the same NODE SET, and the same VALUE for every node.
 *
 * Array ORDER is deliberately NOT part of it. When a delete loses the order race, the client that
 * issued it removed the node and then re-appended it (applyCanvasMutation appends an upsert of an
 * absent node), so its array can end up carrying that node in a different SLOT than a client that
 * never removed it. Array order drives only the sidebar listing — positions, sizes, data and the
 * node set all agree, so either client's save writes a canvas the other agrees with. Documented as
 * such in docs/team-presence.md; use this helper wherever a resurrection can happen.
 */
/** JSON with sorted keys — "the same op" as the kanban publisher judges it (key order is not a change). */
function stableJson(v: unknown): string {
  return JSON.stringify(v, (_k, val: unknown) =>
    val && typeof val === 'object' && !Array.isArray(val)
      ? Object.fromEntries(Object.keys(val).sort().map((k) => [k, (val as Record<string, unknown>)[k]]))
      : val
  )
}

const canon = (c: Client): CanvasNodeState[] =>
  [...c.persisted().nodes].sort((x, y) => x.id.localeCompare(y.id))

let bus: Bus
let a: Client
let b: Client
/** The clients' shared fake clock (ms), read by every canvas-order pending TTL. */
let clock = 0

function boot(): void {
  clock = 1_000
  bus = new Bus()
  initPlatform(bus.platform)
  initCanvasSync()
  a = new Client(1, bus)
  b = new Client(2, bus)
  bus.clients = [1, 2]
}

beforeEach(boot)
afterEach(() => resetPlatformForTests())

describe('canvas convergence (async bus)', () => {
  // THE case a synchronous bus cannot express: both clients edit the SAME node before either has
  // heard from the other. Two people dragging one node cross like this on every single frame.
  it('concurrent move of the same node converges (both land on the ordered winner)', () => {
    a.edit([node('n1', 0)])
    bus.settle()

    // In flight at the same time: A drags n1 to 200, B drags the same node to 100.
    a.edit([node('n1', 200)])
    b.edit([node('n1', 100)])
    bus.settle()

    expect(a.states).toEqual(b.states)
    expect(a.x('n1')).toBe(b.x('n1'))
    // The reflector popped A's cast first, so B's is the LATER write in the total order — B wins,
    // on both canvases. (Before the ordering fix: A showed 200 and B showed 100, forever.)
    expect(a.x('n1')).toBe(100)
    expect(a.persisted()).toEqual(b.persisted())
  })

  it('converges whichever way the reflector orders the two concurrent writes', () => {
    b.edit([node('n1', 100)]) // B's cast is queued first this time
    a.edit([node('n1', 200)])
    bus.settle()
    expect(a.states).toEqual(b.states)
    expect(a.x('n1')).toBe(200) // A's cast was popped last → A wins, on both
  })

  // The bug Stage 3 exists to kill, in its sharpest form: A deletes a node while B is dragging it.
  // Divergence here is not cosmetic — A's next whole-file workspace.save would write the node
  // straight back over B's canvas (or vice versa).
  //
  // RULE 4 also decides WHICH way it converges. Plain last-write-wins let B's next drag frame — a
  // frame produced in ignorance of the delete — win the order and keep the node ALIVE on every
  // canvas, as a shell around a tmux session A's `kill-session` had already killed. `seen` says B
  // had not yet applied the remove, so the frame is dropped everywhere and the delete stands.
  it('concurrent delete vs move of the same node converges — on DELETED', () => {
    a.edit([node('n1', 0), node('n2', 0)])
    bus.settle()

    a.edit(a.states.filter((n) => n.id !== 'n1')) // A deletes n1…
    b.edit(b.states.map((n) => (n.id === 'n1' ? node('n1', 50) : n))) // …while B drags it
    bus.settle()

    expect(a.ids()).toEqual(b.ids()) // the save-safety property, unchanged
    expect(a.ids()).toEqual(['n2']) // …and the node nobody asked back stays gone
    expect(canon(a)).toEqual(canon(b))
    expect(a.persisted()).toEqual(b.persisted())
  })

  // The other half of rule 4, and the reason it is not a blunt "delete always wins": an upsert cast
  // AFTER the client applied the delete is a deliberate re-creation (⌘Z on the delete, or the node
  // being added again) and must land. Without the causal test, a bounded "delete wins" window would
  // silently eat it.
  it('a node re-created AFTER the delete landed is not eaten by the delete', () => {
    a.edit([node('n1', 0), node('n2', 0)])
    bus.settle()

    a.edit(a.states.filter((n) => n.id !== 'n1')) // A deletes n1
    bus.settle() // …and everyone has applied it
    b.edit([...b.states, node('n1', 7)]) // B adds it back, knowing it was deleted
    bus.settle()

    expect(a.ids()).toEqual(b.ids())
    expect(a.ids()).toContain('n1')
    expect(a.x('n1')).toBe(7)
    expect(a.persisted()).toEqual(b.persisted())
  })

  // ── Edges ──────────────────────────────────────────────────────────────────────────────────────
  // The sharpest data-loss shape this stage had left open, and it was WORSE than a cosmetic gap:
  // edges were not in the mutation vocabulary but they ARE in the whole-file save, so an edge you
  // drew never reached your teammate — and their next save, of a canvas that never had it, deleted
  // it for everyone. (Same in reverse.)
  describe('edges converge like nodes', () => {
    it("a link A draws reaches B — and B's save no longer deletes it", () => {
      a.edit([node('n1', 0), node('n2', 0)])
      bus.settle()

      a.editEdges({ bridges: [{ id: 'b1', source: 'n1', target: 'n2' }] })
      bus.settle()

      expect(b.bridges).toEqual([{ id: 'b1', source: 'n1', target: 'n2' }])
      // THE assertion: B's whole-file save now writes A's edge, instead of erasing it.
      expect(b.persisted().bridges).toEqual(a.persisted().bridges)

      // …and an unrelated edit by B does not lose it either (the publisher's baseline carries it).
      b.edit([...b.states, node('n3', 0)])
      bus.settle()
      expect(b.persisted().bridges).toEqual(a.persisted().bridges)
    })

    it('a deleted link stays deleted on both', () => {
      a.edit([node('n1', 0), node('n2', 0)])
      a.editEdges({ bridges: [{ id: 'b1', source: 'n1', target: 'n2' }] })
      bus.settle()

      b.editEdges({ bridges: [] })
      bus.settle()

      expect(a.bridges).toEqual([])
      expect(a.persisted()).toEqual(b.persisted())
    })

    it('bridges and ropes are two lists, and a mutation only touches its own kind', () => {
      a.edit([node('n1', 0), node('n2', 0)])
      a.editEdges({ ropes: [{ id: 'ctrl-1', source: 'n1', target: 'n2' }] })
      bus.settle()

      expect(b.ropes).toEqual([{ id: 'ctrl-1', source: 'n1', target: 'n2' }])
      expect(b.bridges).toEqual([])
    })

    it('a peer edge is applied once and re-published NEVER (the adopt loop guard covers edges)', () => {
      a.edit([node('n1', 0), node('n2', 0)])
      bus.settle()
      const before = bus.castCount

      a.editEdges({ bridges: [{ id: 'b1', source: 'n1', target: 'n2' }] })
      bus.settle()

      expect(bus.castCount - before).toBe(1) // one local edit, one cast, no counter-cast from B
    })

    // Both edges survive on both clients. Compared as a SET, not as an array: each client appended
    // the peer's edge to its own, so the two arrays hold the same edges in different SLOTS — the
    // same array-order caveat docs/team-presence.md already names for nodes, and it matters even
    // less here (edges are rendered as a set; nothing lists them in order).
    it('two clients drawing edges at the same time keep BOTH', () => {
      a.edit([node('n1', 0), node('n2', 0), node('n3', 0)])
      bus.settle()

      a.editEdges({ bridges: [{ id: 'b1', source: 'n1', target: 'n2' }] })
      b.editEdges({ bridges: [{ id: 'b2', source: 'n2', target: 'n3' }] })
      bus.settle()

      const byId = (es: BridgeLink[]) => [...es].sort((x, y) => x.id.localeCompare(y.id))
      expect(byId(a.persisted().bridges)).toEqual(byId(b.persisted().bridges))
      expect(a.bridges.map((e) => e.id).sort()).toEqual(['b1', 'b2'])
    })

    // Rule 4 is keyed on `mutationKey`, so it covers an edge exactly as it covers a node: a client
    // re-pointing an edge in ignorance of its delete must not bring it back.
    it('a stale edge frame cannot resurrect a deleted edge', () => {
      a.edit([node('n1', 0), node('n2', 0)])
      a.editEdges({ bridges: [{ id: 'b1', source: 'n1', target: 'n2' }] })
      bus.settle()

      b.editEdges({ bridges: [{ id: 'b1', source: 'n1', target: 'n1' }] }) // B re-points it…
      a.editEdges({ bridges: [] }) // …while A deletes it
      bus.settle()

      expect(a.bridges).toEqual([])
      expect(b.bridges).toEqual([])
    })

    // An edge whose endpoint is an ephemeral card (a subagent / loop node) must not go on the wire
    // for the same reason the card itself must not: the peer derives that node independently.
    it('an edge to an ephemeral card is never published', () => {
      a.ephemeral.add('sub-1')
      a.edit([node('n1', 0), node('sub-1', 0)])
      bus.settle()
      const before = bus.castCount

      a.editEdges({ bridges: [{ id: 'b1', source: 'n1', target: 'sub-1' }] })
      bus.settle()

      expect(bus.castCount - before).toBe(0)
      expect(b.bridges).toEqual([])
    })
  })

  // THE RE-CREATION GATE (port map §6.5). Our own remove enters `seen` only when its echo comes back,
  // so a re-creation of the same id cast before that — a link deleted and redrawn, a node deleted and
  // ⌘Z'd, inside one round trip — carries a `seen` below the remove, and every PEER drops it as a
  // stale frame (rule 4) while we keep showing it. Held back until the echo lands, then cast, it
  // carries the remove in its `seen` and is a re-creation everywhere.
  describe('a re-creation waits for our own pending remove of the same id', () => {
    const bridge = { id: 'bridge-n1-n2', source: 'n1', target: 'n2' }
    const byId = (es: BridgeLink[]) => [...es].sort((x, y) => x.id.localeCompare(y.id))

    it('a link deleted and redrawn before our echo returns reaches the peer', () => {
      a.edit([node('n1', 0), node('n2', 0)])
      a.editEdges({ bridges: [bridge] })
      bus.settle()

      bus.stall(a.id) // our socket is backed up: our acks are late
      a.editEdges({ bridges: [] }) // A removes the link…
      a.editEdges({ bridges: [bridge] }) // …and draws it again before the remove's echo is back
      bus.unstall(a.id)
      bus.settle()

      expect(canon(a)).toEqual(canon(b))
      expect(byId(a.persisted().bridges)).toEqual(byId(b.persisted().bridges))
      expect(a.bridges).toEqual([bridge])
      expect(b.bridges).toEqual([bridge]) // was: [] — B dropped the redraw as a stale frame
    })

    // The echo is rarely the only thing in flight: a teammate's op for ANOTHER node is ordered first
    // and adopted while the redraw is still held. The adopt must not take the held link into the
    // baseline, or the release finds nothing to cast.
    it('…even when a teammate’s op is adopted while the redraw is held', () => {
      a.edit([node('n1', 0), node('n2', 0), node('n3', 0)])
      a.editEdges({ bridges: [bridge] })
      bus.settle()

      bus.stall(a.id)
      b.edit(b.states.map((n) => (n.id === 'n3' ? node('n3', 30) : n))) // B's move is ordered first
      a.editEdges({ bridges: [] })
      a.editEdges({ bridges: [bridge] })
      bus.unstall(a.id)
      bus.settle()

      expect(a.x('n3')).toBe(30)
      expect(b.bridges).toEqual([bridge])
      expect(a.persisted()).toEqual(b.persisted())
    })

    it('a node deleted and ⌘Z’d before our echo returns comes back on the peer too', () => {
      a.edit([node('n1', 0), node('n2', 0)])
      bus.settle()

      bus.stall(a.id)
      const before = a.states
      a.edit(a.states.filter((n) => n.id !== 'n1')) // delete…
      a.edit(before) // …undo
      bus.unstall(a.id)
      bus.settle()

      expect(b.ids()).toEqual(['n1', 'n2']) // was: ['n2'] — B dropped the undo as a stale frame
      expect(canon(a)).toEqual(canon(b))
    })

    it('the release casts the held re-creation once, and nothing after it', () => {
      a.edit([node('n1', 0), node('n2', 0)])
      a.editEdges({ bridges: [bridge] })
      bus.settle()

      bus.stall(a.id)
      a.editEdges({ bridges: [] })
      a.editEdges({ bridges: [bridge] })
      const beforeRelease = bus.castCount
      bus.unstall(a.id)
      bus.settle()
      expect(bus.castCount - beforeRelease).toBe(1) // the held redraw, cast on the echo

      const settled = bus.castCount
      a.edit([...a.states]) // an unrelated publish
      bus.settle()
      expect(bus.castCount - settled).toBe(0)
    })
  })

  // A stale frame from a client whose socket was stalled must not resurrect the node either — this
  // is the "disconnected peer erases / revives what everyone else settled" hazard, and it is the one
  // a TIME-based delete-wins window would get wrong (the frame arrives long after any window).
  it('a very late drag frame from a stalled client cannot revive the deleted node', () => {
    a.edit([node('n1', 0), node('n2', 0)])
    bus.settle()

    b.edit(b.states.map((n) => (n.id === 'n1' ? node('n1', 50) : n))) // B's frame is cast…
    a.edit(a.states.filter((n) => n.id !== 'n1')) // …A deletes n1
    clock += 60_000 // …and B's cast sits on a stalled link for a minute
    bus.settle()

    expect(a.ids()).toEqual(b.ids())
    expect(a.ids()).toEqual(['n2'])
  })

  it('delete wins when it is the later write, and stays deleted on both', () => {
    a.edit([node('n1', 0), node('n2', 0)])
    bus.settle()

    b.edit(b.states.map((n) => (n.id === 'n1' ? node('n1', 50) : n))) // B's move is cast first…
    a.edit(a.states.filter((n) => n.id !== 'n1')) // …A's delete is ordered after it
    bus.settle()

    expect(a.ids()).toEqual(['n2'])
    expect(b.ids()).toEqual(['n2'])
    expect(a.persisted()).toEqual(b.persisted())
  })

  // A drag is a STREAM of concurrent writes: 20 Hz of frames from each side, all in flight at once.
  it('two clients dragging the same node for many frames still converge', () => {
    a.edit([node('n1', 0)])
    bus.settle()
    for (let i = 1; i <= 20; i++) {
      a.edit([node('n1', i * 10)])
      b.edit([node('n1', 1000 - i * 10)])
      if (i % 3 === 0) bus.settle() // …with the network catching up only sometimes
    }
    bus.settle()

    expect(a.states).toEqual(b.states)
    expect(a.persisted()).toEqual(b.persisted())
  })

  it('interleaved mutations from two clients leave identical node sets', () => {
    a.edit([node('n1', 0)]) // A adds n1
    bus.settle()
    b.edit([...b.states, node('n2', 0)]) // B adds n2
    bus.settle()
    a.edit(a.states.map((n) => (n.id === 'n1' ? node('n1', 40) : n))) // A drags n1
    b.edit(b.states.map((n) => (n.id === 'n2' ? node('n2', 0, 'B') : n))) // B renames n2
    bus.settle()
    a.edit(a.states.filter((n) => n.id !== 'n2')) // A deletes B's node
    bus.settle()

    expect(a.ids()).toEqual(b.ids())
    expect(a.ids()).toEqual(['n1'])
    expect(a.states).toEqual(b.states)
    expect(a.x('n1')).toBe(40)
    // The whole point: whichever client saves, it writes the same bytes.
    expect(a.persisted()).toEqual(b.persisted())
  })

  it('converges under every interleaving AND every settle point of the same edit set', () => {
    // Six edits, replayed in different orders AND with the network settling at different points —
    // `settleEvery: 6` means all six are cast before a single one is delivered, i.e. maximum
    // concurrency. Both clients must land on one node set every time.
    const orders = [
      [0, 1, 2, 3, 4, 5],
      [5, 4, 3, 2, 1, 0],
      [0, 3, 1, 4, 2, 5],
      [2, 0, 5, 1, 3, 4],
      [4, 2, 0, 3, 5, 1]
    ]
    for (const order of orders) {
      for (const settleEvery of [1, 2, 6]) {
        resetPlatformForTests()
        boot()

        const edits: Array<() => void> = [
          () => a.edit([...a.states.filter((n) => n.id !== 'n1'), node('n1', 10)]),
          () => b.edit([...b.states.filter((n) => n.id !== 'n2'), node('n2', 20)]),
          () => a.edit(a.states.map((n) => (n.id === 'n2' ? node('n2', 99) : n))),
          () => b.edit(b.states.map((n) => (n.id === 'n1' ? node('n1', 10, 'renamed') : n))),
          () => a.edit([...a.states.filter((n) => n.id !== 'n3'), node('n3', 30)]),
          () => b.edit(b.states.filter((n) => n.id !== 'n3'))
        ]
        let n = 0
        for (const i of order) {
          edits[i]()
          if (++n % settleEvery === 0) bus.settle()
        }
        bus.settle()

        const tag = `order ${order.join('')} settle/${settleEvery}`
        // `canon`, not raw array equality: this set contains a delete that can lose the order race,
        // and the client that issued it re-appends the node in a different slot (see `canon`).
        expect(a.ids(), tag).toEqual(b.ids())
        expect(canon(a), tag).toEqual(canon(b))
      }
    }
  })

  it('three clients editing the same node concurrently converge on one value', () => {
    const c = new Client(3, bus)
    bus.clients = [1, 2, 3]
    a.edit([node('n1', 0)])
    bus.settle()

    a.edit([node('n1', 1)])
    b.edit([node('n1', 2)])
    c.edit([node('n1', 3)])
    bus.settle()

    expect(a.states).toEqual(b.states)
    expect(b.states).toEqual(c.states)
    expect(a.x('n1')).toBe(3) // C's cast was ordered last
  })

  it('last write wins on a concurrent edit to the same node (no CRDT, no merge, no duplicate)', () => {
    a.edit([node('n1', 0)])
    a.edit([node('n1', 10)])
    b.edit(b.states.map((n) => (n.id === 'n1' ? node('n1', 20) : n)))
    bus.settle()

    expect(a.states).toEqual(b.states)
    expect(a.states).toHaveLength(1) // one node, not two — upsert replaces by id
  })

  it('no infinite loop: an applied mutation is never re-published', () => {
    a.edit([node('n1', 0)])
    bus.settle()
    expect(b.applied).toBe(1)
    expect(a.applied).toBe(0) // A's own echo is an ACK, not an edit — applied optimistically already
    expect(bus.castCount).toBe(1) // one local edit → exactly one cast; B did not re-emit it

    b.edit(b.states.map((n) => (n.id === 'n1' ? node('n1', 5) : n)))
    bus.settle()
    expect(a.applied).toBe(1)
    expect(b.applied).toBe(1) // B did not apply its own echo, and A did not re-emit it
    expect(bus.castCount).toBe(2) // still one cast per local edit — the adopt() guard holds
    expect(a.states).toEqual(b.states)
  })

  it('a burst of peer mutations still produces no counter-cast (3 clients, bulk delete)', () => {
    const c = new Client(3, bus)
    bus.clients = [1, 2, 3]
    a.edit([node('n1', 0), node('n2', 0), node('n3', 0)])
    bus.settle()
    expect(bus.castCount).toBe(3) // three upserts, from A only
    a.edit([]) // bulk delete — three removes in one tick
    bus.settle()
    expect(bus.castCount).toBe(6) // three removes, from A only: B and C reflected nothing back
    expect(b.states).toEqual([])
    expect(c.states).toEqual([])
    expect(b.applied + c.applied).toBe(12) // 6 mutations × 2 peers each
  })

  it('ephemeral subagent / loop cards are never published', () => {
    a.ephemeral.add('subagent-abc')
    a.edit([node('n1', 0), node('subagent-abc', 5), node('loop-n1', 9)])
    bus.settle()

    expect(a.ids()).toEqual(['loop-n1', 'n1', 'subagent-abc']) // A still renders its own cards
    expect(b.ids()).toEqual(['n1']) // …and the peer got only the real node
    expect(b.applied).toBe(1)

    // Moving an ephemeral card emits nothing at all (it is not in the published baseline).
    const casts = bus.castCount
    a.edit(a.states.map((n) => (n.id === 'subagent-abc' ? node('subagent-abc', 77) : n)))
    bus.settle()
    expect(bus.castCount).toBe(casts)
    expect(b.ids()).toEqual(['n1'])
    // …and the real nodes still converge.
    expect(a.persisted()).toEqual(b.persisted())
  })

  it('a third client that joins late converges with the other two', () => {
    a.edit([node('n1', 0)])
    a.edit([...a.states, node('n2', 0)])
    a.edit(a.states.filter((n) => n.id !== 'n1')) // n1 deleted before C ever connects
    bus.settle()

    const c = new Client(3, bus)
    bus.clients = [1, 2, 3]
    c.states = [...a.states] // a fresh client loads the canvas from disk/store on mount
    c.pubAdopt() // …and adopts it as the baseline, without republishing it
    expect(bus.castCount).toBe(3) // the join itself cast nothing

    a.edit(a.states.map((n) => (n.id === 'n2' ? node('n2', 7) : n)))
    b.edit([...b.states, node('n4', 1)])
    c.edit(c.states.map((n) => (n.id === 'n2' ? node('n2', 7, 'from C') : n)))
    bus.settle()

    expect(c.states).toEqual(a.states)
    expect(b.states).toEqual(a.states)
    expect(a.ids()).toEqual(['n2', 'n4'])
    expect(a.persisted()).toEqual(c.persisted())
  })

  // A LATE ACK. Rule 1 (never re-apply our own echo) is only sound while our optimistic value is
  // still on our canvas. Once rule 2's suppression lapses on the TTL and a peer's OLDER mutation
  // overwrites it, our echo is the only thing that can restore the value that won everywhere else —
  // and rule 1 used to throw it away. Realistic trigger: our socket is backed up with pty output
  // (Stage 2 tolerates an 8 MB backlog on that same socket), so our ack takes longer than the TTL.
  it('a peer edit applied after the TTL is repaired by our own late ack (no permanent split-brain)', () => {
    a.edit([node('n1', 0)])
    bus.settle()

    bus.stall(a.id) // A's socket backs up: nothing reaches A, but its casts still leave.
    b.edit([node('n1', 50)]) // B's edit is cast (and ordered) FIRST…
    a.edit([node('n1', 100)]) // …A's is ordered AFTER it, so A's value wins on every other client.
    bus.settle()
    expect(b.x('n1')).toBe(100) // …and it does: B (and every other client) shows A's 100.

    clock += PENDING_TTL_MS + 1 // A's pending entry expires while its inbox is still stalled.
    bus.unstall(a.id)
    bus.settle() // A now receives B's older mutation, then its OWN echo.

    // A must not be left holding the value that lost the total order — its next whole-file
    // workspace.save would write those losing bytes over everyone else's canvas.
    expect(a.x('n1')).toBe(100)
    expect(a.x('n1')).toBe(b.x('n1'))
    expect(a.persisted()).toEqual(b.persisted())
  })

  // THE FIRST HELLO IS NOT A RECONNECT. Canvas resets the ordering state whenever its presence
  // clientId changes — including the very first `null → myId`, which lands a few ms after mount.
  // A peer's mutation can arrive before that (it is proof of a peer, so we publish), which means one
  // of OUR casts can already be in flight when the reset fires. The reset drops `pending` — so the
  // peer's mutation is no longer suppressed, and our own echo is no longer recognizable as the
  // repair of a value that already won everywhere else. It was dropped, and this client stayed on
  // the LOSING value forever (its whole-file save then wrote those bytes over everyone's canvas):
  // the permanent split-brain the ordering state exists to prevent, reopened by a lifecycle event.
  it('our first presence hello does not lose a cast in flight (the late echo still repairs)', () => {
    a.edit([node('n1', 0)])
    bus.settle()

    b.edit([node('n1', 50)]) // B's edit is cast (and ordered) first…
    a.edit([node('n1', 100)]) // …ours is ordered AFTER it, so 100 wins on every other client.
    a.presence('cl-a') // …and NOW our own presence hello resolves, with that cast still unacked.
    bus.settle()

    expect(b.x('n1')).toBe(100) // B lands on the ordered winner…
    expect(a.x('n1')).toBe(100) // …and so must we (was: 50 — our echo was thrown away).
    expect(a.persisted()).toEqual(b.persisted()) // whoever saves writes the same bytes
  })

  // …but a GENUINE reconnect must still reset. The core restarting puts its `seq` counter back at 0
  // while our `seen` map still holds the old (high) values — every mutation that follows would look
  // like a straggler and be silently dropped, and this client would drift away from its peers with
  // no way back. (Here: a new clientId, and a peer mutation stamped with a LOW seq from the restarted
  // reflector.)
  it('a genuine reconnect forgets the stale seq floor (a restarted core starts at seq 1 again)', () => {
    a.presence('cl-a')
    a.edit([node('n1', 0)])
    b.edit([node('n1', 1)])
    b.edit([node('n1', 2)])
    bus.settle()
    expect(a.x('n1')).toBe(2) // a few mutations in: A's `seen` floor for n1 is now high

    a.presence('cl-a2') // the core restarted → new connection, new clientId, `seq` back at 0
    // The restarted reflector stamps from 1 again. Without the reset this is a straggler and is
    // dropped — A would sit on the old value for the rest of the session.
    bus.deliver.get(a.id)?.(PROJECT, { op: 'upsert', node: node('n1', 9), src: 'src-2', seq: 1 })
    expect(a.x('n1')).toBe(9)
  })

  // …and a reconnect to the SAME core must not throw away our causal position. The reset fires on
  // any new clientId, and the core's `seq` carries on; a first cast stamped `seen: 0` — ⌘Z on a node
  // deleted before the drop — is a stale frame to every peer holding the tombstone, and our own echo
  // of it is no repair. A persistent split, until the next edit of that node.
  it('a re-creation after a same-core reconnect reaches the peer (reset keeps our `seen`)', () => {
    a.presence('cl-a')
    a.edit([node('n1', 0), node('n2', 0)])
    bus.settle()
    const before = a.states
    a.edit(a.states.filter((n) => n.id !== 'n1')) // A deletes n1…
    bus.settle() // …and everyone has applied it

    a.presence('cl-a2') // the socket dropped and came back: new clientId, same core, `seq` goes on
    a.edit(before) // ⌘Z
    bus.settle()

    expect(b.ids()).toEqual(['n1', 'n2']) // was: ['n2'] — dropped as a stale frame
    expect(canon(a)).toEqual(canon(b))
  })

  // A REFUSED CAST. The reflector drops a malformed / oversized mutation at ingest (silently — there
  // is no negative ack). If the publisher has already advanced its baseline it never retries, and if
  // the ordering state has already recorded a pending entry the node goes DEAF to its peers for the
  // whole TTL. A peer's `remove` landing in that window was dropped and never recovered → the next
  // save resurrected the node they deleted. Trigger: a sticky whose body a user pasted a document
  // into (sticky text is unbounded in the UI) is over MUTATION_MAX_BYTES.
  it('an oversized node the reflector refuses does not deafen it to a peer delete', () => {
    a.edit([node('n1', 0), node('n2', 0)])
    bus.settle()

    a.edit([fat('n1'), node('n2', 0)]) // A pastes a document into n1 → the cast is refused at ingest
    b.edit(b.states.filter((n) => n.id !== 'n1')) // …and B deletes n1 in the same window
    bus.settle()

    expect(a.ids()).toEqual(b.ids()) // was: A ['n1','n2'] vs B ['n2'] — forever
    expect(a.ids()).toEqual(['n2'])
    expect(a.persisted()).toEqual(b.persisted())
  })

  it('a refused cast is retried on the next publish (once the node is within the size limit)', () => {
    a.edit([node('n1', 0)])
    bus.settle()

    a.edit([fat('n1')]) // refused: never reaches B
    bus.settle()
    expect(b.x('n1')).toBe(0) // B still shows the last mutation that WAS reflected

    a.edit([node('n1', 7)]) // the user trims the sticky → the edit is within the limit again
    bus.settle()
    expect(b.x('n1')).toBe(7)
    expect(a.persisted()).toEqual(b.persisted())
  })

  it('a refused cast does not block the OTHER nodes in the same snapshot', () => {
    a.edit([node('n1', 0), node('n2', 0)])
    bus.settle()
    a.edit([fat('n1'), node('n2', 42)]) // one refused upsert, one legitimate one
    bus.settle()
    expect(b.x('n2')).toBe(42)
  })

  it('a peer delete is not resurrected by the surviving client (the save-safety property)', () => {
    a.edit([node('n1', 0), node('n2', 0)])
    bus.settle()
    b.edit(b.states.filter((n) => n.id !== 'n1')) // B deletes n1
    bus.settle()

    // A's canvas — the one that would be written by ITS next whole-file workspace.save — no longer
    // carries n1. Before Stage 3, A's save would have written the deleted node straight back.
    expect(a.persisted().nodes.map((n) => n.id)).toEqual(['n2'])
    expect(a.persisted()).toEqual(b.persisted())

    // And A's subsequent edit does not reintroduce it either.
    a.edit(a.states.map((n) => (n.id === 'n2' ? node('n2', 3) : n)))
    bus.settle()
    expect(b.ids()).toEqual(['n2'])
  })
})

// ---- boards (kanban) ----
// The board is canvas content too: `.nodeterm/project.json` carries it beside the nodes, so a peer's
// next whole-file save writes whatever board THAT peer holds. Item-level ops ride the same bus, the
// same reflector `seq` and the same order as nodes, under their own `k:` keys (@shared/kanban-ops).
describe('boards converge like nodes (kanban ops)', () => {
  const COLS = defaultKanbanFor(PROJECT).columns
  const TODO = COLS[0].id
  const DOING = COLS[1].id
  const DONE = COLS[2].id

  /** `board` with `nodeId` filed into `columnId` — a person's drag, as the board computes it. */
  const file = (board: ProjectKanban | undefined, nodeId: string, columnId: string): ProjectKanban =>
    applyKanbanOp(board, { op: 'kb-card', assignment: { nodeId, columnId } }, PROJECT)

  /** What the board UI does to every commit (renderer lib/kanban `pruneAssignments`): drop the cards
   *  and meta of nodes this client does not hold. A LOCAL, lazy cleanup — never an edit. */
  const prune = (board: ProjectKanban, live: string[]): ProjectKanban => ({
    ...board,
    assignments: board.assignments.filter((a) => live.includes(a.nodeId)),
    ...(board.meta ? { meta: board.meta.filter((m) => live.includes(m.nodeId)) } : {})
  })

  /** The column a card SHOWS in: its assignment's column when that column exists, else null — the
   *  virtual Ungrouped column, which holds unassigned AND dangling cards alike. */
  const where = (c: Client, nodeId: string): string | null => {
    const board = c.board ?? defaultKanbanFor(PROJECT)
    const a = board.assignments.find((x) => x.nodeId === nodeId)
    return a && board.columns.some((col) => col.id === a.columnId) ? a.columnId : null
  }

  /** The board as a person sees it: the columns in order, and each column's cards in order. */
  const shown = (c: Client) => {
    const board = c.board ?? defaultKanbanFor(PROJECT)
    return board.columns.map((col) => ({
      id: col.id,
      title: col.title,
      cards: board.assignments.filter((a) => a.columnId === col.id).map((a) => a.nodeId)
    }))
  }

  const kbCast = (c: Client, op: string) => c.cast.filter((m) => m.op === op)

  it('1. A and B each move a DIFFERENT card at the same time → both moves land on both', () => {
    a.edit([node('n1', 0), node('n2', 0)])
    bus.settle()
    a.editBoard(file(file(undefined, 'n1', TODO), 'n2', TODO))
    bus.settle()
    expect(b.board).toEqual(a.board)
    expect(b.cast).toEqual([]) // B applied A's board ops and cast nothing back (never re-published)

    // Neither hears the other before it commits: both inboxes stalled, both casts in flight.
    bus.stall(1)
    bus.stall(2)
    a.editBoard(file(a.board, 'n1', DOING))
    b.editBoard(file(b.board, 'n2', DONE))
    bus.settle()
    bus.unstall(1)
    bus.unstall(2)
    bus.settle()

    for (const c of [a, b]) {
      expect(where(c, 'n1')).toBe(DOING)
      expect(where(c, 'n2')).toBe(DONE)
    }
    expect(shown(a)).toEqual(shown(b))
  })

  it('2. A and B move the SAME card concurrently → both end on the higher-seq column', () => {
    a.edit([node('n1', 0)])
    bus.settle()
    a.editBoard(file(undefined, 'n1', TODO))
    bus.settle()

    a.editBoard(file(a.board, 'n1', DOING)) // cast first → the lower seq
    b.editBoard(file(b.board, 'n1', DONE)) //  cast second → the higher seq, wins everywhere
    bus.settle()
    expect(where(a, 'n1')).toBe(DONE)
    expect(where(b, 'n1')).toBe(DONE)
    expect(shown(a)).toEqual(shown(b))

    // …and the other way round.
    b.editBoard(file(b.board, 'n1', TODO))
    a.editBoard(file(a.board, 'n1', DOING))
    bus.settle()
    expect(where(a, 'n1')).toBe(DOING)
    expect(where(b, 'n1')).toBe(DOING)
  })

  it('3. a first-ever board edit made by both at once → three columns on both (deterministic ids)', () => {
    a.edit([node('n1', 0), node('n2', 0)])
    bus.settle()
    expect(a.board).toBeUndefined()
    expect(b.board).toBeUndefined()

    a.editBoard(file(undefined, 'n1', TODO))
    b.editBoard(file(undefined, 'n2', DOING))
    bus.settle()

    for (const c of [a, b]) {
      expect(c.board?.columns.map((col) => col.id)).toEqual(COLS.map((col) => col.id))
      expect(where(c, 'n1')).toBe(TODO)
      expect(where(c, 'n2')).toBe(DOING)
    }
    // The lazy default is the same board on both, so materializing it casts no column at all — a
    // random id per client would have cast three columns each and left six on every board.
    expect([...kbCast(a, 'kb-column'), ...kbCast(b, 'kb-column'), ...kbCast(a, 'kb-column-order'), ...kbCast(b, 'kb-column-order')]).toEqual([])
    expect(shown(a)).toEqual(shown(b))
  })

  it('4. B commits a board edit while A’s card for a new node is still in flight → no kb-card-remove, the card placed on both', () => {
    a.edit([node('m', 0)])
    bus.settle()
    a.editBoard(file(undefined, 'm', TODO))
    bus.settle()

    // A creates n and files its card (the node op leaves first, as the spec's batch order has it);
    // neither has reached B.
    bus.stall(2)
    a.edit([...a.states, node('n', 0)])
    a.editBoard(file(a.board, 'n', DOING))
    // B, meanwhile, moves m — and prunes, as every board commit does, against its OWN nodes.
    b.editBoard(prune(file(b.board, 'm', DONE), b.ids()))
    expect(kbCast(b, 'kb-card-remove')).toEqual([])
    bus.settle()
    bus.unstall(2)
    bus.settle()

    for (const c of [a, b]) {
      expect(where(c, 'n')).toBe(DOING)
      expect(where(c, 'm')).toBe(DONE)
    }
    expect(shown(a)).toEqual(shown(b))
  })

  // The same rule on the arrival order the live canvas produces: a board write is published the
  // moment the store funnel runs, a new node only after React renders it — so a peer can hold the
  // CARD of a node it has not received yet. Its commit prunes that card locally (the board UI prunes
  // every commit), and the removal is never cast: every replica that did not prune keeps the card.
  // The pruning client's own copy is the local, lazy cleanup spec amendment 6 accepts.
  it('4b. a card that arrives before its node survives a peer that prunes it (the removal is never cast)', () => {
    const c = new Client(3, bus)
    bus.clients = [1, 2, 3]
    a.edit([node('m', 0)])
    bus.settle()
    a.editBoard(file(undefined, 'm', TODO))
    bus.settle()

    a.editBoard(file(a.board, 'n', DOING)) // the card, before the node op has left A
    bus.settle()
    expect(b.board?.assignments.some((x) => x.nodeId === 'n')).toBe(true) // B holds it, without n
    bus.stall(2)
    a.edit([...a.states, node('n', 0)]) // the node op, held in B's inbox
    b.editBoard(prune(file(b.board, 'm', DONE), b.ids()))
    expect(kbCast(b, 'kb-card-remove')).toEqual([]) // the prune stayed local
    bus.settle()
    bus.unstall(2)
    bus.settle()

    expect(where(a, 'n')).toBe(DOING)
    expect(where(c, 'n')).toBe(DOING)
    for (const x of [a, b, c]) expect(where(x, 'm')).toBe(DONE)
  })

  it('5. A deletes a column while B moves a card into it → the column is gone, the card Ungrouped on both', () => {
    for (const bFirst of [false, true]) {
      boot()
      a.edit([node('n', 0)])
      bus.settle()
      a.editBoard(file(undefined, 'n', TODO))
      bus.settle()

      const drop = (board: ProjectKanban): ProjectKanban => ({
        ...board,
        columns: board.columns.filter((col) => col.id !== DONE),
        assignments: board.assignments.filter((x) => x.columnId !== DONE)
      })
      const tag = bFirst ? 'B ordered first' : 'A ordered first'
      if (bFirst) b.editBoard(file(b.board, 'n', DONE)) // B had not seen the delete
      a.editBoard(drop(a.board!))
      if (!bFirst) b.editBoard(file(b.board, 'n', DONE))
      bus.settle()

      for (const x of [a, b]) {
        expect(x.board?.columns.map((col) => col.id), tag).toEqual([TODO, DOING])
        expect(where(x, 'n'), tag).toBeNull()
      }
      expect(shown(a), tag).toEqual(shown(b))
    }
  })

  // Ruling R2: the reflector relays the REPAIRED op and the sender drops its own echo as an ack, so
  // the sender must hold the repaired value too — or its board shows a name no peer has.
  it('6. an over-long label name lands cut on every board, the sender’s included', () => {
    a.editBoard({ ...defaultKanbanFor(PROJECT), labels: [{ id: 'lab-1', name: 'x'.repeat(90), color: 'red' }] })
    bus.settle()
    expect(a.board?.labels).toEqual([{ id: 'lab-1', name: 'x'.repeat(60), color: 'red' }])
    expect(b.board?.labels).toEqual(a.board?.labels)
    expect(a.cast.filter((m) => m.op === 'kb-label')).toHaveLength(1) // repaired locally, not re-cast
  })
})

// A browser alone on a project the hosted team shares (docs/hosted-team-relay.md). The canvas
// authority is the one writer of that project's content and writes ONLY what it hears as ops, so a
// solo client that kept the old solo gate (publish only with a peer) would edit a canvas that is
// never saved: its whole-workspace save is overlaid with the authority's content.
describe('a solo client on a governed project (the canvas authority)', () => {
  afterEach(() => setReflectedListener(null))

  const soloWithAuthority = (gate: () => boolean) => {
    bus = new Bus()
    initPlatform(bus.platform)
    initCanvasSync()
    const solo = new Client(1, bus, gate)
    bus.clients = [1]
    const writes: CanvasContent[] = []
    const authority = createCanvasAuthority({
      sharedProjectIds: () => new Set([PROJECT]),
      readContent: async () => ({ nodes: [], bridges: [], ropes: [] }),
      writeContent: async (_id, c) => {
        writes.push(c)
        return true
      },
      publish: () => {},
      setTimer: () => null,
      clearTimer: () => {},
      log: () => {}
    })
    setReflectedListener((id, m) => authority.onReflected(id, m))
    return { solo, writes, authority }
  }

  it('with the project governed, the solo edit reaches the authority and is written', async () => {
    const { solo, writes, authority } = soloWithAuthority(() => shouldPublishCanvas(false, new Set([PROJECT]), PROJECT))
    solo.edit([node('n1', 42)])
    solo.editEdges({ bridges: [{ id: 'e1', source: 'n1', target: 'n1' }] })
    bus.settle()
    await authority.flushAll()
    expect(writes).toHaveLength(1)
    expect(writes[0].nodes.map((n) => [n.id, n.position.x])).toEqual([['n1', 42]])
    expect(writes[0].bridges.map((e) => e.id)).toEqual(['e1'])
    await authority.stop()
  })

  it('with the pre-authority gate (a peer only), nothing is cast and nothing is written', async () => {
    const { solo, writes, authority } = soloWithAuthority(() => shouldPublishCanvas(false, new Set<string>(), PROJECT))
    solo.edit([node('n1', 42)])
    bus.settle()
    await authority.flushAll()
    expect(bus.castCount).toBe(0)
    expect(writes).toEqual([])
    await authority.stop()
  })
})
