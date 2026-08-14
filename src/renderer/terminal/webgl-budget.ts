/**
 * Module-level WebGL context BUDGET coordinator.
 *
 * Chromium caps live WebGL contexts per process at ~16. When a page tries to exceed that cap the
 * browser force-EVICTS an existing context to make room — and that victim is sometimes a context
 * belonging to a terminal the user is currently looking at, which then paints as Chromium's
 * "lost context" dead-canvas placeholder (a white box with a sad-face icon) until our own
 * `onContextLoss` → dispose → DOM-fallback lands a beat later.
 *
 * The per-node IntersectionObserver decisions (acquire when visible, release after a delay when
 * hidden) are each individually correct but globally UN-coordinated: a fast pan across a
 * 30-terminal canvas, or zooming out past ~16 visible terminals, momentarily OVERSHOOTS the cap —
 * nodes panned away from keep their context for the release delay while newly visible nodes each
 * acquire immediately — so the browser force-evicts, and the dead placeholder flashes.
 *
 * This coordinator keeps the number of contexts WE hold at or under `WEBGL_BUDGET`, which sits
 * comfortably below the browser cap. If we never exceed it ourselves, the browser never has to
 * force-evict anyone, so the dead placeholder cannot appear. The coordinator owns ALL timing and
 * the grant decision; the per-node `acquire`/`release` callbacks stay dumb and idempotent.
 *
 * Grant rules:
 *  - A client that becomes visible is granted only after a short ACQUIRE DEBOUNCE
 *    (`WEBGL_ACQUIRE_DEBOUNCE_MS`), so a fast pan sweeping a node across the viewport for a couple
 *    of frames never acquires. (`rootMargin` on the observer already pre-announces approach.)
 *  - If granting would exceed the budget, the coordinator immediately RECLAIMS from the
 *    least-recently-visible HIDDEN holder. If every holder is currently visible, the newcomer
 *    is NOT granted and stays on the DOM renderer. Either way we never push past the budget,
 *    so the browser never force-evicts.
 *  - A client that becomes hidden KEEPS its context — warm for a pan-back of any length, so
 *    re-entering the viewport costs no renderer swap. Reclaim is strictly ON DEMAND: the LRU
 *    hidden holder gives its slot to a visible newcomer when the budget is full, and
 *    `releaseAllHiddenGrants` gives every hidden context back under memory pressure. (A
 *    proactive time-based release used to exist; it bought nothing those two levers don't,
 *    and its DOM→WebGL re-upgrade was a visible rendering flicker on every pan-back. Same
 *    story for the old zoom-out suspend gate: measured A/B under load, the gate COST
 *    main-thread time — half-second swap-wave stalls at its band plus 2.4× the work for
 *    streaming terminals forced onto the DOM renderer at far zoom — while the budget already
 *    bounds the context count at any zoom.)
 *  - `acquire()` returning false (WebGL2 unavailable / threw) does not count against the budget.
 *  - A context lost from outside (the addon's own `onContextLoss`) is reported via
 *    `handle.contextLost()`: the grant is dropped from the accounting, and for a STILL-VISIBLE
 *    client ONE budget-gated re-grant attempt is scheduled (`WEBGL_REACQUIRE_AFTER_LOSS_MS`).
 *    Sleep/wake GPU resets lose EVERY context at once while nothing changes visibility — without
 *    the re-grant, a woken machine's terminals sat on the DOM renderer indefinitely (the
 *    "fallback feel": different cursor/scroll rendering) until the user happened to pan them out
 *    and back. This is NOT the per-node self-re-acquire loop the old "never re-grant" rule
 *    feared: the attempt goes through `tryGrant`, which never exceeds the budget and never
 *    reclaims a visible holder, so re-granting clients cannot evict each other; and repeated
 *    losses (`WEBGL_LOSS_STREAK_MAX`) stop the attempts until the next visibility transition —
 *    a genuinely unstable GPU degrades to the DOM renderer exactly as before.
 */

/**
 * DEFAULT ceiling on WebGL contexts we hold at once. Comfortably under Chromium's default
 * ~16-per-page cap — which is what a BROWSER tab (Server Edition) gets. The desktop shell raises
 * the browser cap itself (`--max-active-webgl-contexts` in src/main/index.ts), and the renderer
 * raises the matching budget via `setWebglBudget` at boot (main.tsx). The invariant is the same
 * everywhere: our budget stays comfortably under whatever the platform cap actually is.
 */
export const WEBGL_BUDGET = 12

/** Live ceiling — `WEBGL_BUDGET` unless the shell raised it (see `setWebglBudget`). */
let budget = WEBGL_BUDGET

/** Master switch (Settings → the GPU-terminal-rendering toggle). When false, the coordinator
 *  grants NOTHING and every terminal stays on xterm's DOM renderer — an escape hatch for machines
 *  where many live WebGL contexts destabilize the OS compositor (observed as whole-window flicker
 *  on some macOS GPUs). Default on; `setWebglEnabled` reclaims/re-grants live when it flips. */
let enabled = true

/**
 * Raise (or lower) the live budget. Called once at boot by the shell that knows its platform cap
 * (desktop raises the Chromium cap to `WEBGL_CONTEXT_CAP_DESKTOP`, so it can afford a higher
 * budget). Non-finite or < 1 values are ignored — a bad caller must not zero the ceiling.
 */
export function setWebglBudget(n: number): void {
  if (!Number.isFinite(n) || n < 1) return
  budget = Math.floor(n)
}

/**
 * Turn GPU (WebGL) terminal rendering on or off globally. OFF reclaims every currently-held
 * context immediately (each client falls back to xterm's DOM renderer) and blocks all future
 * grants; ON re-attempts a grant for every visible client, budget-gated as usual. Idempotent, and
 * safe to call before any client registers (boot). This is the user-facing escape hatch for the
 * macOS compositor-flicker case — see `enabled`.
 */
export function setWebglEnabled(on: boolean): void {
  if (enabled === on) return
  enabled = on
  if (!on) {
    // Drop every live context now (bypassing release delays) so the flicker stops on this frame.
    for (const c of clients.values()) {
      cancelAcquire(c)
      reclaim(c)
    }
    return
  }
  // Back on: give every visible client a chance to re-acquire, oldest-visible first is irrelevant
  // (tryGrant is budget-gated and never evicts a visible holder), so a simple sweep suffices.
  for (const c of clients.values()) if (c.visible) tryGrant(c)
}

/** The live budget (test/introspection seam). */
export function getWebglBudget(): number {
  return budget
}

/**
 * THE GESTURE LATCH — the load-bearing rule of this coordinator: renderer swaps NEVER run
 * while the user is panning/zooming.
 *
 * A WebGL grant/release is a heavyweight, NON-ATOMIC renderer swap (shader compile + atlas
 * build + full repaint on grant; renderer teardown/rebuild on release). The old design executed
 * them the moment visibility flipped — which is precisely MID-GESTURE, in bursts (a zoom-out
 * makes dozens of nodes visible in one frame; the since-removed zoom gate used to mass-release in one
 * frame). Those bursts both janked the gesture (main thread stalls while compositing is already
 * under load) and created the GPU-pressure window in which swaps die midway and strand
 * terminals black (see TerminalNode's swap safety net).
 *
 * While the latch is on, every would-be swap is parked in `owed`; when the canvas comes to
 * REST the drain executes them a few per tick (`WEBGL_SWAPS_PER_DRAIN` / `WEBGL_DRAIN_MS`), so
 * even a huge rebalance is a calm trickle. Contexts a gesture would have taken away keep
 * painting until rest — nothing visible is ever swapped out from under the user mid-motion.
 */
let gestureActive = false

/** Deferred swap work: clients whose grant attempt or owed release waits for rest. */
const owed = new Set<Client>()
let drainTimer: ReturnType<typeof setTimeout> | null = null

/** Max renderer swaps executed per drain tick — a rebalance is a trickle, never a burst. */
export const WEBGL_SWAPS_PER_DRAIN = 2
/** Gap between drain ticks while deferred work remains. */
export const WEBGL_DRAIN_MS = 100
/** How long after the last pan/zoom event the canvas counts as at rest (caller-side). */
export const WEBGL_GESTURE_SETTLE_MS = 250

/** Report whether a pan/zoom gesture is in progress. Idempotent; rest triggers the drain. */
export function setWebglGesture(active: boolean): void {
  if (gestureActive === active) return
  gestureActive = active
  if (!active) drain()
}

/** Execute deferred swaps, a few per tick, self-rescheduling while work remains. */
function drain(): void {
  if (drainTimer) {
    clearTimeout(drainTimer)
    drainTimer = null
  }
  if (gestureActive) return
  let ops = 0
  for (const c of Array.from(owed)) {
    if (ops >= WEBGL_SWAPS_PER_DRAIN) break
    owed.delete(c)
    if (!clients.has(c.id)) continue
    if (c.releaseOwed) {
      c.releaseOwed = false
      // Only release if the reason still holds — a client that came back (visible again, zoom
      // resumed) keeps its warm context instead of paying a release+re-grant round trip.
      if (c.granted && (!c.visible || !enabled)) {
        reclaim(c)
        ops++
      }
      continue
    }
    if (!c.granted && c.visible) {
      tryGrant(c)
      if (c.granted) ops++
    }
  }
  if (owed.size && !drainTimer) drainTimer = setTimeout(drain, WEBGL_DRAIN_MS)
}

/**
 * Explicitly lose the WebGL context of every canvas under `root` (a terminal's element), via
 * `WEBGL_lose_context`. Chromium counts a context against its per-page cap until it is GC'd OR
 * explicitly lost — and `@xterm/addon-webgl`'s dispose() does neither (verified on 0.18.0: zero
 * `loseContext` calls). Without this, every release leaves a zombie context that still occupies
 * a cap slot until some later GC, so real context count = granted + zombies could exceed the cap
 * under churn (fast pan) even though the coordinator never exceeded its budget — surfacing as
 * Chromium's "Too many active WebGL contexts" warning and force-evictions.
 *
 * Takes the CANVAS ELEMENTS, captured before the addon is disposed — dispose detaches them from
 * the DOM, so a root query afterwards would find nothing, while held element references (and
 * their contexts) stay valid. Safe on non-WebGL canvases: `getContext('webgl2')` on a canvas
 * that already holds a 2d context returns null without creating anything. Returns how many
 * contexts were lost.
 */
export function loseWebglContexts(canvases: ArrayLike<HTMLCanvasElement> | null): number {
  if (!canvases) return 0
  let lost = 0
  for (const canvas of Array.from(canvases)) {
    try {
      const gl = canvas.getContext('webgl2') as WebGL2RenderingContext | null
      const ext = gl?.getExtension('WEBGL_lose_context')
      if (ext) {
        ext.loseContext()
        lost++
      }
    } catch {
      // fail open — losing a context is an optimization, never worth breaking release for.
    }
  }
  return lost
}

/**
 * How long a client must stay continuously visible before it is granted a context. Absorbs fast
 * pans that sweep a node across the viewport for only a frame or two (which must not acquire).
 */
export const WEBGL_ACQUIRE_DEBOUNCE_MS = 150

/** Delay before a visible client whose context was lost EXTERNALLY (sleep/wake GPU reset) retries
 *  through the normal budget-gated grant path. Longer than the acquire debounce on purpose: right
 *  after a wake the GPU is still settling, and an immediate retry tends to lose again. */
export const WEBGL_REACQUIRE_AFTER_LOSS_MS = 1000

/** External losses in a row (without a visibility transition) after which the coordinator stops
 *  retrying and leaves the client on the DOM renderer — an unstable GPU must not be hammered. */
export const WEBGL_LOSS_STREAK_MAX = 3

export interface WebglClientCallbacks {
  /** Acquire the GPU context. Returns true on success, false if WebGL2 is unavailable / threw. */
  acquire(): boolean
  /** Release the GPU context. Must be idempotent (a no-op when nothing is held). */
  release(): void
}

export interface WebglClientHandle {
  /** Report this node's viewport visibility (driven by its IntersectionObserver). */
  setVisible(visible: boolean): void
  /** Report that the addon's own `onContextLoss` fired: drop this grant from the accounting. */
  contextLost(): void
  /** Node unmount: release any held context, cancel timers, and forget this client. */
  dispose(): void
}

interface Client {
  id: string
  acquire: () => boolean
  release: () => void
  visible: boolean
  /** Whether we believe this client currently holds a live context (counts against the budget). */
  granted: boolean
  acquireTimer: ReturnType<typeof setTimeout> | null
  /**
   * Monotonic tick recorded each time the client becomes hidden. Among hidden holders, the
   * SMALLEST value became hidden earliest (was visible least recently) → reclaimed first.
   */
  hiddenAt: number
  /** Consecutive EXTERNAL context losses without a visibility transition (see contextLost). */
  lossStreak: number
  /** A release is owed but deferred (gesture in progress / staggered drain). Cancelled if the
   *  reason lapses before the drain reaches it — the context is then simply kept warm. */
  releaseOwed: boolean
}

const clients = new Map<string, Client>()

/** Monotonic clock for LRU ordering — independent of wall-clock / fake timers. */
let visibilityClock = 0

function grantCount(): number {
  let n = 0
  for (const c of clients.values()) if (c.granted) n++
  return n
}

function cancelAcquire(c: Client): void {
  if (c.acquireTimer) {
    clearTimeout(c.acquireTimer)
    c.acquireTimer = null
  }
}

/** Release a client's context now, bypassing any pending release delay. */
function reclaim(c: Client): void {
  if (!c.granted) return
  try {
    c.release()
  } catch {
    // release is best-effort; drop the grant regardless.
  }
  c.granted = false
}

/**
 * Memory-pressure lever: give back EVERY hidden holder's context — the one PROACTIVE release
 * in the lifecycle (hidden contexts otherwise stay warm until a visible newcomer needs the
 * slot). Visible holders are untouched — the same invariant `lruHiddenHolder`
 * applies, and for the same reason: taking a context off a terminal the user is looking at trades
 * memory for a visible downgrade.
 *
 * The releases are QUEUED (`owed` + `drain`), not executed here — pressure wants the memory back
 * SOON, not this frame. Releasing ~24 contexts in one synchronous loop is a swap storm: exactly
 * what the removed zoom gate's one-frame mass release turned out to be, and mid-gesture it lands in
 * the GPU-pressure window where a swap dies midway and strands a terminal black. The drain path
 * is what keeps "soon" honest: it no-ops while a gesture runs, re-checks `!c.visible` before each
 * release (a client that came back keeps its warm context), and trickles at
 * `WEBGL_SWAPS_PER_DRAIN` per `WEBGL_DRAIN_MS`.
 *
 * Idempotent: a client already queued with `releaseOwed` is simply re-added to a Set — the flag is
 * never cleared here, so a second call cannot cancel a pending release.
 */
export function releaseAllHiddenGrants(): void {
  for (const c of clients.values()) {
    if (!c.granted || c.visible) continue
    c.releaseOwed = true
    owed.add(c)
  }
  drain()
}

/** The least-recently-visible HIDDEN holder, or null if every holder is currently visible. */
function lruHiddenHolder(): Client | null {
  let best: Client | null = null
  for (const c of clients.values()) {
    if (!c.granted || c.visible) continue
    if (!best || c.hiddenAt < best.hiddenAt) best = c
  }
  return best
}

function doGrant(c: Client): void {
  let ok = false
  try {
    ok = c.acquire()
  } catch {
    // acquire threw — treat as unavailable; do not count against the budget.
    ok = false
  }
  // A false / thrown acquire (WebGL2 unavailable) must NOT burn a slot: leave `granted` false.
  if (ok) c.granted = true
}

/** Attempt to grant `c` a context, reclaiming a hidden holder's slot if the budget is full. */
function tryGrant(c: Client): void {
  cancelAcquire(c)
  // Guard: the client may have gone hidden or been disposed between debounce start and fire.
  if (!clients.has(c.id) || !c.visible || c.granted) return
  // Master switch off → never grant; every terminal stays on the DOM renderer.
  if (!enabled) return
  // Mid-gesture → park the attempt; the rest-time drain re-runs it (see the gesture latch).
  if (gestureActive) {
    c.releaseOwed = false
    owed.add(c)
    return
  }
  if (grantCount() < budget) {
    doGrant(c)
    return
  }
  // Full: reclaim the least-recently-visible hidden holder to free exactly one slot.
  const victim = lruHiddenHolder()
  if (!victim) {
    // Every holder is currently visible (zoomed way out): do not push past the budget. The
    // newcomer stays on the DOM renderer until a later visibility transition frees a slot.
    return
  }
  reclaim(victim)
  doGrant(c)
}

function setVisible(c: Client, visible: boolean): void {
  if (c.visible === visible) return
  c.visible = visible
  // A real visibility transition resets the loss streak: the give-up state after repeated
  // external losses lasts only until the user pans away and back (the pre-existing recovery).
  c.lossStreak = 0
  if (visible) {
    // Re-visible: keep the warm context, and forgive a release parked in the deferred-drain
    // queue (a pressure sweep that queued this client before it came back).
    c.releaseOwed = false
    if (c.granted) return
    // Debounce the acquire so a fast pan-through never grabs a context for a two-frame flash.
    if (!c.acquireTimer) {
      c.acquireTimer = setTimeout(() => {
        c.acquireTimer = null
        tryGrant(c)
      }, WEBGL_ACQUIRE_DEBOUNCE_MS)
    }
    return
  }
  // Became hidden. The context is deliberately KEPT (see the header): warm for a pan-back of
  // any length, and the LRU reclaim candidate the moment a visible newcomer needs the slot.
  c.hiddenAt = ++visibilityClock
  cancelAcquire(c)
}

/**
 * Register a terminal node as a WebGL client. The coordinator calls `acquire`/`release` to grant
 * or reclaim the GPU context; the node drives `handle.setVisible` from its IntersectionObserver,
 * reports external context loss via `handle.contextLost`, and calls `handle.dispose` on unmount.
 */
export function registerWebglClient(id: string, callbacks: WebglClientCallbacks): WebglClientHandle {
  // A re-register under the same id (e.g. a remount that raced teardown) supersedes the old entry.
  // Release a still-granted predecessor: its handle's dispose() will short-circuit (stale-handle
  // guard), so without this the old WebglAddon would leak a real browser context while the
  // coordinator forgets it held a slot — exactly the overshoot this module exists to prevent.
  const existing = clients.get(id)
  if (existing) {
    cancelAcquire(existing)
    if (existing.granted) {
      try {
        existing.release()
      } catch {
        // fail-open: a throwing release must not block the new registration
      }
      existing.granted = false
    }
  }
  const client: Client = {
    id,
    acquire: callbacks.acquire,
    release: callbacks.release,
    visible: false,
    granted: false,
    acquireTimer: null,
    hiddenAt: 0,
    lossStreak: 0,
    releaseOwed: false
  }
  clients.set(id, client)

  return {
    setVisible(visible: boolean) {
      const c = clients.get(id)
      if (c === client) setVisible(c, visible)
    },
    contextLost() {
      const c = clients.get(id)
      if (c !== client) return
      // The browser (or our own dispose) already tore the context down; drop the accounting.
      c.granted = false
      // Sleep/wake GPU resets lose every context at once with no visibility change, so a
      // still-visible client schedules ONE delayed, budget-gated re-grant attempt (see the
      // header). A streak of losses means the GPU is unstable → stop until the user pans the
      // node out and back (setVisible resets the streak).
      c.lossStreak += 1
      if (c.visible && c.lossStreak <= WEBGL_LOSS_STREAK_MAX && !c.acquireTimer) {
        c.acquireTimer = setTimeout(() => {
          c.acquireTimer = null
          tryGrant(c)
        }, WEBGL_REACQUIRE_AFTER_LOSS_MS)
      }
    },
    dispose() {
      const c = clients.get(id)
      if (c !== client) return
      cancelAcquire(c)
      owed.delete(c)
      if (c.granted) {
        try {
          c.release()
        } catch {
          // best-effort
        }
        c.granted = false
      }
      clients.delete(id)
    }
  }
}

/** Test-only: clear all coordinator state between cases. */
export function __resetWebglBudgetForTests(): void {
  for (const c of clients.values()) cancelAcquire(c)
  clients.clear()
  visibilityClock = 0
  budget = WEBGL_BUDGET
  enabled = true
  gestureActive = false
  owed.clear()
  if (drainTimer) {
    clearTimeout(drainTimer)
    drainTimer = null
  }
}
