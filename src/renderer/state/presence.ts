import { create, type StoreApi, type UseBoundStore } from 'zustand'
import type { NodeTerminalApi } from '@shared/types'
import { isPopoutWindow } from './windows'
import {
  nextFreeColor,
  peersOnProject,
  type ClientId,
  type DinoSnapshot,
  type PeerDiff,
  type PeerIdentity,
  type PeerState
} from '@shared/presence'
import {
  dropTyping,
  markTyping,
  nextTypingSweepDelay,
  pruneTyping,
  typingClientIds,
  type TypingMarks
} from '../lib/typingPeers'

/**
 * Transient team-presence store (docs/team-presence.md). Holds the peer table for one
 * connection: cursors, focus, chat. NONE of it is persisted — the only thing that survives a
 * reload is the local user's own {name, color} (ME_KEY below).
 *
 * ONE STORE PER CORE (stage 4): `createPresenceSession(api)` builds an isolated instance
 * around one core's api — every stateful piece (the store, the typing-sweep timer, the face
 * cache, the connect guard, the focus/project dedup, the hello-warned latch) is closed over
 * the instance, because peer ids from two different cores live in two different id spaces and
 * must never share a table or a cache. The factory is MEMOIZED BY API IDENTITY (a WeakMap): a
 * repeat call with the same api object returns the existing instance, never a second one. That
 * is what makes the invariant structural rather than a caller convention — the browser bridge
 * drains its pre-subscribe event buffer into the FIRST subscriber only (see SOLE SUBSCRIBER),
 * so a second store on the same api would miss the join-time sync and silently diverge. The
 * module keeps a DEFAULT instance bound to `window.nodeTerminal` (the local core) and
 * re-exports its members under the historical names, so the existing single-session consumers
 * are untouched; the memo means any path that asks for a store for `window.nodeTerminal` — the
 * session registry included — gets that same instance back.
 *
 * SOLE SUBSCRIBER: a session's presence store is the ONLY place that may call its api's
 * presence.onSync / presence.onPeer, and connect() subscribes AT MOST ONCE (the per-instance
 * `live` handle below makes that structural, not a convention — a second call is inert). The
 * browser bridge buffers the events that arrive before the first subscriber and drains that
 * buffer into it — a SECOND subscriber on the same channel would get nothing, so components
 * must read this store and never subscribe themselves.
 *
 * NEVER MY OWN PEER: the hub's table includes us, so every selector filters on `myId` — and while
 * `myId` is null (hello in flight, or a failed handshake) they return NOTHING at all. That null
 * window is real: the browser bridge drains its buffer — the join-time `presence:sync`, which
 * contains our own peer, and our own join diff — into the first subscriber synchronously, i.e.
 * before hello can possibly have resolved. Without the gate we would list ourselves in the
 * facepile and chase our own ghost cursor.
 *
 * PERF CONTRACT: only the presence components (PresenceLayer / Facepile / PresenceChips) may
 * subscribe to this store REACTIVELY. Canvas.tsx is ~4000 lines — if a cursor at 20 Hz re-rendered
 * it, every mouse move would redraw the whole canvas. Canvas mounts the components and calls
 * connectPresence(); it never uses the `usePresence(selector)` hook. It does read the peer table
 * IMPERATIVELY — `getState()` + a plain `subscribe()` into a ref — for the canvas-sync solo gate
 * ("is anyone else attached?"). That is not a subscription React can re-render on: no hook, no
 * selector, no component state. Keep it that way.
 */

export const ME_KEY = 'nodeterm.presence.me'

/** The local user's saved identity, or null on first run / corrupt storage.
 *  DELIBERATELY SHARED ACROSS SESSIONS: {name, color} is who the HUMAN is, not per-core state —
 *  connecting to a teammate's core does not make you a different person, and a per-session key
 *  would force a re-prompt (and allow a diverging color) on every remote host. */
export function loadIdentity(): PeerIdentity | null {
  try {
    const raw = localStorage.getItem(ME_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<PeerIdentity>
    if (typeof parsed?.name !== 'string' || typeof parsed?.color !== 'string') return null
    return { name: parsed.name, color: parsed.color }
  } catch {
    return null
  }
}

export function saveIdentity(id: PeerIdentity): void {
  try {
    localStorage.setItem(ME_KEY, JSON.stringify(id))
  } catch {
    // ignore quota / serialization errors — presence still works for this session
  }
}

/** A starting point for the name prompt: empty name, an unused-looking color.
 *  Reads the DEFAULT (local) session's peers — the prompt is a local-session surface. */
export function suggestIdentity(): PeerIdentity {
  const taken = Object.values(usePresence.getState().peers).map((p) => p.color)
  return { name: '', color: nextFreeColor(taken) }
}

export interface PresenceStore {
  /** This client's own id (from the hello response). Null until hello resolves. */
  myId: ClientId | null
  /** The local user's identity, or null until they pick one. */
  me: PeerIdentity | null
  /** Everyone connected, INCLUDING me (selectOthers filters me out). */
  peers: Record<ClientId, PeerState>
  /** Who is typing into which node, stamped on OUR clock. Built ONLY from live `presence:peer`
   *  update diffs — never from a snapshot (see THE TYPING MARKS below) — and swept by a timer that
   *  only exists while it is non-empty. Not `PeerState.typing`, and not a mirror of it. */
  typing: TypingMarks
  /** True when we are connected but the user has never chosen a name → show the prompt. */
  needsName: boolean
  setMe(id: PeerIdentity): void
  applySync(peers: PeerState[]): void
  applyDiff(diff: PeerDiff): void
  reset(): void
}

/** Everyone except me, on ANY project — the base of every other selector (the facepile shows who
 *  is working where, so it does NOT filter by project).
 *  While `myId` is null we cannot tell our own peer from a teammate's, so we return NOBODY: an
 *  empty facepile for one round-trip is right; listing yourself as your own teammate never is.
 *  PURE and state-agnostic (no per-session cache), so one function serves every session. */
export function selectOthers(s: PresenceStore): PeerState[] {
  if (s.myId === null) return []
  return Object.values(s.peers).filter((p) => p.clientId !== s.myId)
}

/** Everyone except me, on THIS project — the ONLY peers that may be drawn on the canvas. A peer
 *  on another project has coordinates in another canvas's space (see peersOnProject). */
export function selectVisible(s: PresenceStore, projectId: string | null): PeerState[] {
  return peersOnProject(selectOthers(s), projectId)
}

/** The peers (never me, never off-project) focused on one node — drives the node-header chips.
 *  Node ids are globally unique, so without the project filter a peer focused on a node in
 *  another project would silently chip a node here. */
export function selectFocused(
  s: PresenceStore,
  nodeId: string,
  projectId: string | null
): PeerState[] {
  return selectVisible(s, projectId).filter((p) => p.focus === nodeId)
}

/** The OTHER peer (never me — filtered on `myId`, like selectOthers) who is the live dino
 *  authority for `nodeId`: their `dino` is non-null and its `nodeId` matches. If several peers
 *  broadcast for the same node during a brief take-over race, the one with the LOWEST clientId
 *  wins (the authority tiebreak — same rule DinoNode applies), so every spectator converges on
 *  one authority. Returns null when nobody is broadcasting for this node.
 *  While `myId` is null (hello in flight) we cannot tell our own peer from a teammate's, so we
 *  return null — same gate as every other selector here. */
export function selectDino(s: PresenceStore, nodeId: string): PeerState | null {
  if (s.myId === null) return null
  let winner: PeerState | null = null
  for (const p of Object.values(s.peers)) {
    if (p.clientId === s.myId) continue
    if (!p.dino || p.dino.nodeId !== nodeId) continue
    if (winner === null || p.clientId < winner.clientId) winner = p
  }
  return winner
}

/** What the facepile draws — and NOTHING else. `applyDiff` replaces the whole PeerState object on
 *  every cursor patch (~20/s per peer), so a facepile subscribed to PeerState would re-render at
 *  cursor rate even under useShallow. selectFaces projects these five fields and reuses the
 *  previous object when they are unchanged, so cursor traffic is invisible to it. */
export interface PeerFace {
  clientId: ClientId
  name: string
  color: string
  projectId: string | null
  kind: PeerState['kind']
}

/** The one empty result every "nobody to draw" path returns — a shared, frozen constant, so the
 *  common case allocates NOTHING and its identity is stable across calls (useShallow bails out).
 *  Safe to share across sessions: it is immutable and carries no peer state. */
const NO_FACES: PeerFace[] = []

/** Is there anyone but me in the table? The literal question the chip fast path asks — not a proxy
 *  for it (`Object.keys(peers).length < 2` assumed my own row is always one of them: a client that
 *  dropped mid-handshake, or a hello answered before our join diff landed, leaves a table of ONE
 *  REAL peer — whom the Facepile happily draws while the chips stayed blank; the two surfaces must
 *  never disagree about who is here).
 *  ALLOCATION-FREE, and that is the point: this runs once per MOUNTED NODE on EVERY store write
 *  (~4k times/s on a busy canvas), so it may not build an array — `for…in` walks the keys in place,
 *  `Object.keys()` would materialize one every single time. */
function hasOtherPeers(s: PresenceStore): boolean {
  if (s.myId === null) return false // hello unresolved → we cannot tell our own row from a peer's
  for (const key in s.peers) {
    if (s.peers[key as unknown as ClientId].clientId !== s.myId) return true
  }
  return false
}

/** Sent when the user has not named themselves yet. It claims NOTHING — sanitizeIdentity falls
 *  back to the peer's current name on an empty string, and to its current color on an off-palette
 *  one — so the hub keeps the "Someone" + next-free color it assigned at join. Its only job is to
 *  hand us our own ClientId immediately (see NEVER MY OWN PEER above); the name prompt then just
 *  renames us with a second hello. */
const PROVISIONAL_IDENTITY: PeerIdentity = { name: '', color: '' }

/** One session's presence: its store, its connection lifecycle, and its face-projecting selectors
 *  (the pure selectors are on here too, so a session-scoped consumer needs only this object). */
export interface PresenceSession {
  store: UseBoundStore<StoreApi<PresenceStore>>
  connect(): () => void
  reportFocus(nodeId: string | null): void
  releaseFocus(nodeId: string): void
  reportProject(projectId: string | null): void
  /** Broadcast the live dino game we are the authority for (null = stopped/idle). A pure cast on
   *  the session's api — no dedup: the DinoNode already throttles to ~20 Hz and null-clears. */
  dino(payload: { nodeId: string; snap: DinoSnapshot } | null): void
  selectOthers(s: PresenceStore): PeerState[]
  selectVisible(s: PresenceStore, projectId: string | null): PeerState[]
  selectFocused(s: PresenceStore, nodeId: string, projectId: string | null): PeerState[]
  selectDino(s: PresenceStore, nodeId: string): PeerState | null
  selectFaces(s: PresenceStore): PeerFace[]
  selectFocusedFaces(s: PresenceStore, nodeId: string, projectId: string | null): PeerFace[]
  selectTypingFaces(s: PresenceStore, nodeId: string): PeerFace[]
}

/** One instance per api OBJECT — the one-store-per-core guarantee, keyed on identity (a WeakMap,
 *  so a dropped api never pins its store). Seeded implicitly: `defaultPresence` below is built
 *  through the memoizing factory, so `window.nodeTerminal` maps to it from module load on. */
const instanceByApi = new WeakMap<NodeTerminalApi, PresenceSession>()

/**
 * The presence store for ONE core (one api). MEMOIZED BY API IDENTITY: a repeat call with the
 * same api object returns the existing instance — building a second store on the same api would
 * subscribe to the same channel SECOND, and the bridge replays its pre-subscribe buffer to the
 * first subscriber only (see the module docblock). A nullish api (node-environment tests that
 * exercise only the pure helpers) is not memoizable and gets a fresh, inert instance.
 */
export function createPresenceSession(api: NodeTerminalApi): PresenceSession {
  const existing = api ? instanceByApi.get(api) : undefined
  if (existing) return existing
  const session = buildPresenceSession(api)
  if (api) instanceByApi.set(api, session)
  return session
}

/**
 * Build the presence store for ONE core's api. Everything stateful lives in this closure; `api`
 * is dereferenced only at call time (hello/connect/focus/project), never here — so constructing
 * an instance costs nothing and touches no wire. NEVER export this: every consumer must go
 * through the memoizing `createPresenceSession` above.
 */
function buildPresenceSession(api: NodeTerminalApi): PresenceSession {
  /**
   * THE TYPING MARKS — why the ring does not read `PeerState.typing` off the wire.
   *
   * CLOCK: `PeerState.typing.at` is stamped on the HOST's clock; the ~2 s decay runs on the VIEWER's
   * (a browser, a phone), which can be minutes off. Decaying against the wire stamp would pin a ring
   * on forever or suppress it entirely, so every typing patch is RE-STAMPED with the local time we
   * observed it (`markTyping(..., Date.now())`) and the decay runs against that. One clock, end to end.
   *
   * SNAPSHOTS: the hub keeps no timers and never clears `typing`, so a `presence:sync` (or the hello
   * response) can carry a peer's typing from ten minutes ago. We therefore mark ONLY on a live `update`
   * diff and NEVER seed from a snapshot — a stale stamp in a join snapshot can light nothing.
   *
   * A stale mark for a peer who has left is harmless: the selectors skip a clientId that is not in the
   * peer table, and the sweep (armed for as long as any mark exists) removes it within TYPING_DECAY_MS.
   */
  const store = create<PresenceStore>((set, get) => ({
    myId: null,
    me: loadIdentity(),
    peers: {},
    typing: {},
    needsName: false,

    setMe: (id) => {
      saveIdentity(id)
      set({ me: id, needsName: false })
      void sayHello(id)
    },

    applySync: (peers) =>
      set(() => {
        const table: Record<ClientId, PeerState> = {}
        for (const p of peers) table[p.clientId] = p
        return { peers: table } // `typing` untouched: a snapshot may not light a ring (see above)
      }),

    applyDiff: (diff) => {
      const marksBefore = get().typing
      set((s) => {
        if (diff.op === 'join') return { peers: { ...s.peers, [diff.peer.clientId]: diff.peer } }
        if (diff.op === 'leave') {
          if (!(diff.clientId in s.peers)) return s
          const peers = { ...s.peers }
          delete peers[diff.clientId]
          return { peers, typing: dropTyping(s.typing, diff.clientId) }
        }
        const prev = s.peers[diff.clientId]
        if (!prev) return s // an update for a peer we never saw join — ignore, never ghost a row
        const peers = { ...s.peers, [diff.clientId]: { ...prev, ...diff.patch } }
        const t = diff.patch.typing
        if (!t) return { peers }
        return { peers, typing: markTyping(s.typing, diff.clientId, t.nodeId, Date.now()) }
      })
      // Arm (or re-arm) the decay sweep AFTER the write, never inside the reducer — and ONLY when the
      // marks actually moved. A cursor patch (~20/s per peer) must not churn the timer, and a canvas
      // nobody else is typing on must not have one at all.
      const marksAfter = get().typing
      if (marksAfter !== marksBefore) armSweep(marksAfter)
    },

    reset: () => {
      cancelSweep()
      set({ myId: null, peers: {}, typing: {}, needsName: false })
    }
  }))

  /**
   * The decay sweep: the hub never sends a "stopped typing" event (it keeps no timers), so the ring
   * has to fade on OUR side. ONE timer for the whole session — not one per node — armed at the
   * earliest mark's expiry and re-armed after each sweep while any mark is left.
   *
   * A SOLO USER PAYS NOTHING: no peers → no typing diffs → no marks → nextTypingSweepDelay is null →
   * no timer is ever created. The timer exists only while someone is actually typing into a node.
   */
  let sweepTimer: ReturnType<typeof setTimeout> | null = null

  function cancelSweep(): void {
    if (sweepTimer !== null) clearTimeout(sweepTimer)
    sweepTimer = null
  }

  function armSweep(marks: TypingMarks): void {
    const delay = nextTypingSweepDelay(marks, Date.now())
    if (delay === null) return cancelSweep() // nobody is typing → no timer at all
    cancelSweep()
    sweepTimer = setTimeout(sweep, delay)
  }

  function sweep(): void {
    sweepTimer = null
    const s = store.getState()
    const next = pruneTyping(s.typing, Date.now())
    // pruneTyping returns the SAME map when nothing decayed, so a still-typing peer costs no write
    // (and so re-renders nobody) on the ticks in between.
    if (next !== s.typing) store.setState({ typing: next })
    armSweep(next)
  }

  /** clientId → the last face we handed out, so an unchanged face keeps its object identity.
   *  PER SESSION: client ids from two cores are two id spaces — one shared map would hand
   *  session B a face cached for a colliding id in session A. */
  const faceCache = new Map<ClientId, PeerFace>()

  /** The cached face for a peer: the SAME object as last time while none of the five projected fields
   *  changed — that identity is what makes every face-based selector cursor-immune. */
  function faceFor(p: PeerState): PeerFace {
    const prev = faceCache.get(p.clientId)
    if (
      prev &&
      prev.name === p.name &&
      prev.color === p.color &&
      prev.projectId === p.projectId &&
      prev.kind === p.kind
    ) {
      return prev
    }
    const face: PeerFace = {
      clientId: p.clientId,
      name: p.name,
      color: p.color,
      projectId: p.projectId,
      kind: p.kind
    }
    faceCache.set(p.clientId, face)
    return face
  }

  /** The facepile projection: everyone but me, cursor-immune (see PeerFace). Pair it with
   *  `useShallow` — the array is fresh each call, its ELEMENTS are not. */
  function selectFaces(s: PresenceStore): PeerFace[] {
    const others = selectOthers(s)
    const faces = others.map(faceFor)
    // Prune rather than accumulate: a peer that left must not linger in the cache. (This is the only
    // pruner — selectFocusedFaces sees a subset of the peers and must never evict the rest.)
    const alive = new Set(others.map((p) => p.clientId))
    for (const id of faceCache.keys()) if (!alive.has(id)) faceCache.delete(id)
    return faces
  }

  /** What ONE node's header chips draw: the peers (never me, never off-project) focused on that node,
   *  projected to the same cursor-immune face objects as the facepile.
   *
   *  PERF, and the reason this is not just `selectFocused`: there is one chip strip PER NODE, and
   *  `applyDiff` rebuilds a peer's whole PeerState object on every cursor patch (~20/s per peer). A
   *  selector returning PeerStates would therefore hand every node a fresh object 20×/s and re-render
   *  every terminal on the canvas — even under `useShallow`, which compares the ELEMENTS. Faces are
   *  reused objects, so a moving cursor changes nothing here and every strip bails out.
   *
   *  The early-out is the other half of that: this runs once per MOUNTED NODE on every store write
   *  (40 nodes × 5 peers × 20 Hz ≈ 4k runs/s), and each run would otherwise allocate a filtered array
   *  plus a mapped one — ~20k throwaway arrays/s — even on a canvas nobody else is on. When there is
   *  provably no one to chip (hello unresolved, or nobody else in the table), return NO_FACES. */
  function selectFocusedFaces(
    s: PresenceStore,
    nodeId: string,
    projectId: string | null
  ): PeerFace[] {
    // Nobody else here → nothing to compute, which is the overwhelmingly common case. The guard is
    // itself allocation-free (see hasOtherPeers), or it would defeat its own purpose.
    if (!hasOtherPeers(s)) return NO_FACES
    const focused = selectFocused(s, nodeId, projectId)
    if (focused.length === 0) return NO_FACES
    return focused.map(faceFor)
  }

  /**
   * The peers TYPING INTO this node right now — the pulsing ring in its header. Same cursor-immune
   * PeerFace projection as the chips (see selectFocusedFaces), so pair it with `useShallow`.
   *
   * DELIBERATELY NOT PROJECT-FILTERED, unlike every other node-scoped selector here. A phone has
   * `projectId: null` (it has no canvas), so `peersOnProject` excludes it — and "someone is typing
   * into this shell from their phone" is exactly the case this feature exists to surface. The filter
   * exists because cursors and focus are only meaningful in a project's own coordinate/node space;
   * `typing.nodeId` is neither: it is the session's persistKey, GLOBALLY unique, so keying the ring
   * off it against the FULL peer table cannot chip the wrong node. If the peer is not typing into a
   * node on our canvas, no mounted header asks about their nodeId and nothing is drawn.
   *
   * CURSOR IMMUNITY: a cursor patch touches `peers` only — never `typing` — and faces are the same
   * objects until a name/color/project/kind changes, so this returns a shallow-equal array (usually
   * the shared NO_FACES) on every cursor tick and re-renders nothing.
   */
  function selectTypingFaces(s: PresenceStore, nodeId: string): PeerFace[] {
    if (s.myId === null) return NO_FACES // hello unresolved → we cannot rule out our own keystrokes
    const ids = typingClientIds(s.typing, nodeId, Date.now())
    if (ids.length === 0) return NO_FACES // the common case, allocation-free (see typingClientIds)
    const faces: PeerFace[] = []
    for (const id of ids) {
      // Never me: my own writes are echoed back to me as a diff, and a ring on my own keystrokes
      // would be noise. A mark for a peer who has left has no face — skip it.
      if (id === s.myId) continue
      const peer = s.peers[id]
      if (peer) faces.push(faceFor(peer))
    }
    return faces.length > 0 ? faces : NO_FACES
  }

  /** A failed handshake logs once per session, not once per retry. */
  let helloWarned = false

  /**
   * Say hello and seed the peer table from the RESPONSE — not from the presence:sync push. On
   * desktop the hub joins the window at createWindow(), i.e. before the renderer has loaded, so
   * that join-time sync is always lost. The hello response is the only snapshot that is reliable
   * on BOTH surfaces, and it is also how we learn our OWN clientId (so we never draw our cursor).
   *
   * The seed REPLACES the table wholesale, and that is only safe because of two properties — do not
   * move this seed onto an unordered path (a fan-out event, a second channel, a retry queue):
   *   1. the hub snapshots peers() INSIDE the hello handler, so the response is a consistent table
   *      as of that moment, and
   *   2. hello's response and the presence:peer diffs share one FIFO transport (ipcRenderer /
   *      the single ws), so every diff we already applied is included in that snapshot and every
   *      diff we apply after it happened after it.
   * Break either one and a peer who joins mid-handshake gets silently overwritten out of the table.
   *
   * A rejection (ws dropped mid-handshake, a host without the channel) must never become an
   * unhandled rejection: we log once and leave myId null, which the selectors read as "presence is
   * off" — degraded, but never "I am my own peer".
   */
  async function sayHello(id: PeerIdentity): Promise<void> {
    try {
      const res = await api.presence.hello(id)
      const table: Record<ClientId, PeerState> = {}
      for (const p of res.peers) table[p.clientId] = p
      store.setState({ myId: res.clientId, peers: table })
    } catch (err) {
      if (!helloWarned) {
        helloWarned = true
        console.warn('[presence] hello failed — presence is off for this session', err)
      }
    }
  }

  /** The live connection, or null. Makes the single-subscriber invariant STRUCTURAL: a second
   *  connect (Fast Refresh, a stray double mount) is inert, and a teardown only tears down the
   *  connection IT created — otherwise the stale teardown would reset() the store (dropping myId
   *  and the whole table) while the live subscription, which will never re-seed, kept running. */
  let live: { stop: () => void } | null = null

  /**
   * Subscribe to the presence stream and announce ourselves; returns a teardown. Called from Canvas
   * in a []-effect — but calling it twice is safe (the second call is a no-op returning a no-op).
   * Subscribing BEFORE hello matters: any diff that lands while hello is in flight must be applied
   * on top of the snapshot, not dropped. We say hello even with no stored identity (see
   * PROVISIONAL_IDENTITY): the prompt (`needsName`) then only renames us.
   */
  function connect(): () => void {
    // FAIL OPEN on a missing api: the module-load capture of `window.nodeTerminal` is safe only
    // by boot order (see defaultPresence below), and the `as NodeTerminalApi` cast hides a future
    // violation from the compiler. If someone ever hoists a presence importer ahead of the bridge
    // install, the failure mode must be "presence is off" (the same degradation the sayHello
    // catch models) — not a TypeError inside Canvas's effect and a blank app.
    if (!api?.presence) {
      if (!helloWarned) {
        helloWarned = true
        console.warn('[presence] no presence api — presence is off for this session')
      }
      return () => {}
    }
    // A pop-out project window (docs/popout-windows.md) is the SAME person as the main window, not a
    // teammate: it never says hello, draws no cursor and sees no peers. Without this the hub answered
    // its hello with the main window's own entry and the "Someone else is on this canvas" prompt
    // came up in a window the user had just opened themselves (measured on the first sandbox run).
    if (isPopoutWindow()) return () => {}
    if (live) return () => {}

    const unSync = api.presence.onSync((peers) => store.getState().applySync(peers))
    const unPeer = api.presence.onPeer((diff) => store.getState().applyDiff(diff))
    const me = store.getState().me
    if (!me) store.setState({ needsName: true })
    void sayHello(me ?? PROVISIONAL_IDENTITY)

    const handle = {
      stop: () => {
        if (live !== handle) return // already torn down, or superseded — touch nothing
        live = null
        unSync()
        unPeer()
        store.getState().reset()
        faceCache.clear()
        // Forget what we published, so a reconnect re-announces focus + project from scratch.
        lastFocus = null
        lastProject = null
      }
    }
    live = handle
    return handle.stop
  }

  // The last focus/project we published — a terminal re-focusing the same node, or a tab switch
  // back to the project we are already on, must not spam the wire.
  //
  // THE DEDUP IS A CLAIM THAT THE CAST LANDED, so it is only sound for casts the hub cannot drop.
  // The hub rate-limits per (client, channel) and drops silently; there is no ack and no re-announce.
  // It is sound here because of two hub rules (src/core/presence/hub.ts — keep them in sync):
  //   - a CLEARING cast (focus null) is exempt from the bucket, so `lastFocus = null` can never be a
  //     lie. A dropped non-null focus is self-healing anyway: the hub keeps the previous node, and
  //     the very next focus change — or the exempt release — corrects it.
  //   - `presence:project` is bucketed, but with a budget no human input path can reach (only
  //     DISTINCT switches spend a token — this dedup is what makes key-repeat free), so an honest
  //     client cannot lose the switch it has already recorded here.
  // Do not tighten the project budget without revisiting this line: a dropped project cast that we
  // have already recorded is permanent — teammates keep drawing us on a canvas we left.
  let lastFocus: string | null = null
  let lastProject: string | null = null

  /**
   * Publish "I am working in this node" (null = nowhere). Deduped; safe to call before connect.
   *
   * ALONE, IT PUBLISHES NOTHING. A focus only exists to be drawn on somebody else's canvas, and every
   * terminal hover-dwell / leave calls this — so with no peers the cast is pure cost (an IPC
   * round-trip and a hub write per hover, on a path a solo user is on constantly). Same guard
   * PtyManager.write already uses for typing attribution: presence is FREE when you are by yourself.
   *
   * The CLEAR is deliberately not gated: `lastFocus` is only ever non-null because a publish went out
   * while peers existed, and if the last peer leaves while we sit in that node, the hub still holds
   * our focus — the next peer to join would receive it in its snapshot and chip a node we left long
   * ago. So a retraction always goes out (the dedup above makes it a no-op when we never published).
   */
  function reportFocus(nodeId: string | null): void {
    if (lastFocus === nodeId) return
    if (nodeId !== null && !hasPeers()) return
    lastFocus = nodeId
    api.presence.focus(nodeId)
  }

  /** Is anyone else connected? (The table includes me, so "somebody else" is > 1.) */
  function hasPeers(): boolean {
    return Object.keys(store.getState().peers).length > 1
  }

  /** "This node is no longer where I work" — the counterpart of reportFocus(nodeId), for a node that
   *  is losing focus (mouse left, unmounted). It clears the focus ONLY if this node is the one we
   *  actually published: a node's leave/unmount can land AFTER the next node's enter (the mouse moves
   *  on; a project switch unmounts the old canvas), and an unconditional reportFocus(null) would then
   *  blank the chips on the node the user just moved into. */
  function releaseFocus(nodeId: string): void {
    if (lastFocus !== nodeId) return
    reportFocus(null)
  }

  /** Publish "I am looking at this canvas" (null = no project open). Called from Canvas's
   *  active-project effect, so it fires on connect AND on every project switch. Deduped. */
  function reportProject(projectId: string | null): void {
    if (lastProject === projectId) return
    lastProject = projectId
    api.presence.project(projectId)
  }

  /** Broadcast the live dino game we are the authority for (null = stopped/idle). Unlike focus/
   *  project this is NOT deduped: the DinoNode throttles the snapshot rate itself, each frame is
   *  distinct. Presence is FREE when you are alone (like reportFocus): a solo player's ~20 Hz
   *  snapshot casts are skipped when there is no peer to watch — but a clearing `null` ALWAYS lands
   *  (a stop is an edge; and it costs nothing) so a spectator can never be left drawing a ghost. */
  function dino(payload: { nodeId: string; snap: DinoSnapshot } | null): void {
    if (payload !== null && !hasPeers()) return
    api.presence.dino(payload)
  }

  return {
    store,
    connect,
    reportFocus,
    releaseFocus,
    reportProject,
    dino,
    selectOthers,
    selectVisible,
    selectFocused,
    selectDino,
    selectFaces,
    selectFocusedFaces,
    selectTypingFaces
  }
}

/**
 * The DEFAULT instance — the local core's presence, bound to `window.nodeTerminal` BY IDENTITY
 * (the same capture localSession.ts makes, and safe for the same boot-order reason documented
 * there: preload/bridge define nodeTerminal before any importer of this module runs). Every
 * historical export below resolves to this exact object, so the ~40 existing single-session
 * consumers are untouched. Built through the MEMOIZING factory, so this line also seeds the
 * WeakMap with `window.nodeTerminal → defaultPresence`: any later `createPresenceSession(
 * window.nodeTerminal)` — the session registry's local session, a loopback debug session, an
 * adversarial test double — resolves to this same instance, never a parallel twin whose
 * connect() would race this one for the bridge's first-subscriber replay buffer.
 * The `typeof window` guard exists for node-environment unit tests that exercise only the pure
 * helpers: an undefined api is never memoized, and connect() fails open on it.
 */
const defaultPresence = createPresenceSession(
  (typeof window === 'undefined' ? undefined : window.nodeTerminal) as NodeTerminalApi
)
export { defaultPresence }

export const usePresence = defaultPresence.store
export const connectPresence = defaultPresence.connect
export const reportFocus = defaultPresence.reportFocus
export const releaseFocus = defaultPresence.releaseFocus
export const reportProject = defaultPresence.reportProject
export const selectFaces = defaultPresence.selectFaces
export const selectFocusedFaces = defaultPresence.selectFocusedFaces
export const selectTypingFaces = defaultPresence.selectTypingFaces
