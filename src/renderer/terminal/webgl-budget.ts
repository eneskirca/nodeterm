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
 * comfortably below the browser cap. It ALSO bounds their estimated raw backing-surface bytes:
 * context count alone is not a memory budget, because one large high-DPI terminal canvas can cost
 * tens of MiB and Metal/the compositor may keep several copies. React Flow zoom only transforms
 * the canvas visually; it does not shrink xterm's intrinsic backing canvas. If we obey both limits,
 * the browser never has to force-evict a context and a zoomed-out canvas cannot legally grant
 * gigabytes of terminal-sized surfaces. The coordinator owns ALL timing and the grant decision;
 * the per-node `acquire`/`release` callbacks stay dumb and idempotent.
 *
 * Grant rules:
 *  - A client that becomes visible is granted only after a short ACQUIRE DEBOUNCE
 *    (`WEBGL_ACQUIRE_DEBOUNCE_MS`), so a fast pan sweeping a node across the viewport for a couple
 *    of frames never acquires. (`rootMargin` on the observer already pre-announces approach.)
 *  - If granting would exceed either budget, the coordinator immediately RECLAIMS as many
 *    least-recently-visible HIDDEN holders as needed (bypassing their release delay). If every
 *    holder is currently visible (zoomed way out), the newcomer is NOT granted and stays on the
 *    DOM renderer. Either way we never push past a budget, so the browser never force-evicts and
 *    terminal backing surfaces cannot grow without an area bound.
 *  - A client that becomes hidden keeps its context for `WEBGL_RELEASE_DELAY_MS` (warm for a
 *    pan-back) but is the first reclaim candidate during that window.
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

/**
 * Aggregate estimate for ONE raw BGRA backing surface per granted terminal.
 *
 * This is deliberately not described as exact GPU memory: Chromium, Metal and the compositor may
 * retain several copies. 128 MiB still fits all 24 ordinary 640x440 terminals at DPR 2 (about
 * 103 MiB before subtracting node chrome), while large zoomed-out nodes consume their honest
 * intrinsic high-DPI cost instead of each counting as the same single slot.
 */
export const WEBGL_SURFACE_BUDGET_BYTES = 128 * 1024 * 1024

const BGRA_BYTES_PER_PIXEL = 4

/**
 * Estimate one terminal's raw backing-surface bytes from its UNTRANSFORMED CSS box. Callers must
 * use clientWidth/clientHeight, not getBoundingClientRect(): React Flow zoom scales the latter but
 * xterm's backing canvas remains intrinsic-size × DPR.
 *
 * Invalid/zero dimensions fail closed above the budget, so an unmeasured client stays on the DOM
 * renderer until a real size arrives and cannot make area accounting disappear.
 */
export function estimateWebglSurfaceBytes(
  cssWidth: number,
  cssHeight: number,
  devicePixelRatio: number
): number {
  if (
    !Number.isFinite(cssWidth) ||
    cssWidth <= 0 ||
    !Number.isFinite(cssHeight) ||
    cssHeight <= 0 ||
    !Number.isFinite(devicePixelRatio) ||
    devicePixelRatio <= 0
  ) {
    return Number.MAX_SAFE_INTEGER
  }
  const pixelWidth = Math.ceil(cssWidth * devicePixelRatio)
  const pixelHeight = Math.ceil(cssHeight * devicePixelRatio)
  const bytes = pixelWidth * pixelHeight * BGRA_BYTES_PER_PIXEL
  return Number.isSafeInteger(bytes) ? bytes : Number.MAX_SAFE_INTEGER
}

export const WEBGL_SURFACE_RESIZE_SETTLE_MS = 80

interface WebglSurfaceResizeControllerOptions {
  initialSurfaceBytes: number
  readSurfaceBytes(): number
  applyFit(): void
  reportSurfaceBytes(surfaceBytes: number): void
  settleMs?: number
}

export interface WebglSurfaceResizeController {
  measureAndScheduleFit(): void
  suspendAndScheduleFit(): void
  runGeometryChange(change: () => void): void
  dispose(): void
}

/**
 * Keep surface accounting conservative while terminal fitting is debounced.
 *
 * Growth is reported before xterm can enlarge its backing canvas. Shrink is reported only after
 * the delayed fit has synchronously adopted the smaller grid, because reporting it earlier can
 * immediately grant WebGL against an old, larger canvas.
 */
export function createWebglSurfaceResizeController(
  options: WebglSurfaceResizeControllerOptions
): WebglSurfaceResizeController {
  let reportedSurfaceBytes = options.initialSurfaceBytes
  let timer: ReturnType<typeof setTimeout> | null = null
  const settleMs = options.settleMs ?? WEBGL_SURFACE_RESIZE_SETTLE_MS
  let disposed = false

  const scheduleFitAndReport = () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      options.applyFit()
      const fittedSurfaceBytes = options.readSurfaceBytes()
      if (fittedSurfaceBytes !== reportedSurfaceBytes) {
        reportedSurfaceBytes = fittedSurfaceBytes
        options.reportSurfaceBytes(reportedSurfaceBytes)
      }
    }, settleMs)
  }

  return {
    measureAndScheduleFit() {
      if (disposed) return
      const nextSurfaceBytes = options.readSurfaceBytes()
      if (nextSurfaceBytes > reportedSurfaceBytes) {
        reportedSurfaceBytes = nextSurfaceBytes
        options.reportSurfaceBytes(reportedSurfaceBytes)
      }
      scheduleFitAndReport()
    },
    suspendAndScheduleFit() {
      if (disposed) return
      reportedSurfaceBytes = Number.MAX_SAFE_INTEGER
      options.reportSurfaceBytes(reportedSurfaceBytes)
      scheduleFitAndReport()
    },
    runGeometryChange(change: () => void) {
      if (disposed) {
        change()
        return
      }
      if (timer) clearTimeout(timer)
      timer = null
      reportedSurfaceBytes = Number.MAX_SAFE_INTEGER
      options.reportSurfaceBytes(reportedSurfaceBytes)
      try {
        change()
      } finally {
        options.applyFit()
        reportedSurfaceBytes = options.readSurfaceBytes()
        options.reportSurfaceBytes(reportedSurfaceBytes)
      }
    },
    dispose() {
      disposed = true
      if (timer) clearTimeout(timer)
      timer = null
    }
  }
}

type DevicePixelRatioWindow = Pick<
  Window,
  'devicePixelRatio' | 'matchMedia' | 'addEventListener' | 'removeEventListener'
>

/**
 * Watch DPR independently of element resizing. Ordinary ResizeObserver fallback does not fire
 * when a fixed-size window moves between displays, while xterm still resizes its backing canvas.
 * Re-arm the resolution query after every change so later transitions are also observed.
 */
export function watchDevicePixelRatio(
  targetWindow: DevicePixelRatioWindow,
  onChange: () => void
): () => void {
  let currentDpr = targetWindow.devicePixelRatio
  let mediaQuery: MediaQueryList | null = null
  let usingModernListener = false
  let disposed = false

  const removeMediaListener = () => {
    if (!mediaQuery) return
    if (usingModernListener) mediaQuery.removeEventListener('change', checkForChange)
    else mediaQuery.removeListener(checkForChange)
    mediaQuery = null
  }

  const armMediaQuery = () => {
    removeMediaListener()
    if (disposed || typeof targetWindow.matchMedia !== 'function') return
    try {
      mediaQuery = targetWindow.matchMedia(
        `screen and (resolution: ${targetWindow.devicePixelRatio}dppx)`
      )
      usingModernListener = typeof mediaQuery.addEventListener === 'function'
      if (usingModernListener) mediaQuery.addEventListener('change', checkForChange)
      else mediaQuery.addListener(checkForChange)
    } catch {
      mediaQuery = null
    }
  }

  function checkForChange(): void {
    if (disposed || targetWindow.devicePixelRatio === currentDpr) return
    currentDpr = targetWindow.devicePixelRatio
    onChange()
    armMediaQuery()
  }

  targetWindow.addEventListener('resize', checkForChange)
  armMediaQuery()

  return () => {
    disposed = true
    targetWindow.removeEventListener('resize', checkForChange)
    removeMediaListener()
  }
}

interface SharedDevicePixelRatioWatch {
  subscribers: Set<() => void>
  stop: () => void
}

const sharedDevicePixelRatioWatches = new WeakMap<
  DevicePixelRatioWindow,
  SharedDevicePixelRatioWatch
>()

/**
 * Subscribe through one renderer-lifetime DPR watcher installed before xterm opens.
 *
 * The root watcher intentionally remains installed when the last node unsubscribes. Parked xterm
 * instances keep their own older listeners, so tearing down and recreating our root watcher would
 * let xterm enlarge a restored WebGL canvas before the budget can reclaim it.
 */
export function subscribeDevicePixelRatio(
  targetWindow: DevicePixelRatioWindow,
  onChange: () => void
): () => void {
  let shared = sharedDevicePixelRatioWatches.get(targetWindow)
  if (!shared) {
    const subscribers = new Set<() => void>()
    shared = {
      subscribers,
      stop: watchDevicePixelRatio(targetWindow, () => {
        for (const subscriber of Array.from(subscribers)) {
          try {
            subscriber()
          } catch {
            // One terminal must not prevent the remaining clients from charging the new DPR.
          }
        }
      })
    }
    sharedDevicePixelRatioWatches.set(targetWindow, shared)
  }
  shared.subscribers.add(onChange)
  return () => {
    shared?.subscribers.delete(onChange)
  }
}

/** Live ceiling — `WEBGL_BUDGET` unless the shell raised it (see `setWebglBudget`). */
let budget = WEBGL_BUDGET

/**
 * Raise (or lower) the live budget. Called once at boot by the shell that knows its platform cap
 * (desktop raises the Chromium cap to `WEBGL_CONTEXT_CAP_DESKTOP`, so it can afford a higher
 * budget). Non-finite or < 1 values are ignored — a bad caller must not zero the ceiling.
 */
export function setWebglBudget(n: number): void {
  if (!Number.isFinite(n) || n < 1) return
  budget = Math.floor(n)
}

/** The live budget (test/introspection seam). */
export function getWebglBudget(): number {
  return budget
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

/**
 * How long a client that scrolled out of the viewport keeps its context before the coordinator
 * releases it on its own. The context stays warm for a quick pan-back; a re-visible transition
 * within the window cancels the pending release. A hidden holder is also the first candidate to be
 * reclaimed on demand when a newly visible client needs a slot, bypassing this delay.
 */
export const WEBGL_RELEASE_DELAY_MS = 2000

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
  /** Report a changed intrinsic high-DPI backing-surface estimate. */
  setSurfaceBytes(surfaceBytes: number): void
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
  /** Estimated bytes for one raw BGRA backing surface at the intrinsic size and current DPR. */
  surfaceBytes: number
  acquireTimer: ReturnType<typeof setTimeout> | null
  releaseTimer: ReturnType<typeof setTimeout> | null
  /**
   * Monotonic tick recorded each time the client becomes hidden. Among hidden holders, the
   * SMALLEST value became hidden earliest (was visible least recently) → reclaimed first.
   */
  hiddenAt: number
  /** Consecutive EXTERNAL context losses without a visibility transition (see contextLost). */
  lossStreak: number
}

const clients = new Map<string, Client>()

/** Monotonic clock for LRU ordering — independent of wall-clock / fake timers. */
let visibilityClock = 0

function grantCount(): number {
  let n = 0
  for (const c of clients.values()) if (c.granted) n++
  return n
}

function normalizeSurfaceBytes(surfaceBytes: number): number {
  if (!Number.isFinite(surfaceBytes) || surfaceBytes <= 0) return Number.MAX_SAFE_INTEGER
  return Math.min(Number.MAX_SAFE_INTEGER, Math.ceil(surfaceBytes))
}

function grantedSurfaceBytes(): number {
  let bytes = 0
  for (const c of clients.values()) if (c.granted) bytes += c.surfaceBytes
  return bytes
}

function canGrant(c: Client): boolean {
  const count = grantCount()
  return (
    count < budget &&
    grantedSurfaceBytes() + c.surfaceBytes <= WEBGL_SURFACE_BUDGET_BYTES
  )
}

function grantsFitBudgets(): boolean {
  const count = grantCount()
  return count <= budget && grantedSurfaceBytes() <= WEBGL_SURFACE_BUDGET_BYTES
}

function cancelAcquire(c: Client): void {
  if (c.acquireTimer) {
    clearTimeout(c.acquireTimer)
    c.acquireTimer = null
  }
}

function cancelRelease(c: Client): void {
  if (c.releaseTimer) {
    clearTimeout(c.releaseTimer)
    c.releaseTimer = null
  }
}

/** Release a client's context now, bypassing any pending release delay. */
function reclaim(c: Client): void {
  cancelRelease(c)
  if (!c.granted) return
  try {
    c.release()
  } catch {
    // release is best-effort; drop the grant regardless.
  }
  c.granted = false
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

/** Attempt to grant `c`, reclaiming hidden holders until both count and surface budgets fit. */
function tryGrant(c: Client): void {
  cancelAcquire(c)
  // Guard: the client may have gone hidden or been disposed between debounce start and fire.
  if (!clients.has(c.id) || !c.visible || c.granted) return
  // This client can never fit. Do not discard useful hidden warm contexts trying to make room.
  if (c.surfaceBytes > WEBGL_SURFACE_BUDGET_BYTES) return
  while (!canGrant(c)) {
    // Full by context count or surface bytes: reclaim the LRU hidden holder and re-check. An area
    // deficit can require more than one victim. If every holder is visible, preserve incumbents;
    // the newcomer stays on the DOM renderer until a later transition or smaller size retries.
    const victim = lruHiddenHolder()
    if (!victim) return
    reclaim(victim)
  }
  doGrant(c)
}

/**
 * Enforce both limits after a granted client's intrinsic size changes. Hidden warm holders remain
 * the first victims. If all remaining holders are visible, the client that grew bears the
 * downgrade instead of unexpectedly blanking another visible terminal.
 */
function enforceBudgetsAfterResize(c: Client): void {
  if (c.surfaceBytes > WEBGL_SURFACE_BUDGET_BYTES) {
    reclaim(c)
    return
  }
  while (!grantsFitBudgets()) {
    const victim = lruHiddenHolder()
    if (victim) {
      reclaim(victim)
      if (victim === c) return
      continue
    }
    reclaim(c)
    return
  }
}

function setVisible(c: Client, visible: boolean): void {
  if (c.visible === visible) return
  c.visible = visible
  // A real visibility transition resets the loss streak: the give-up state after repeated
  // external losses lasts only until the user pans away and back (the pre-existing recovery).
  c.lossStreak = 0
  if (visible) {
    // Re-visible before the release fired: keep the warm context, cancel the pending release.
    cancelRelease(c)
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
  // Became hidden.
  c.hiddenAt = ++visibilityClock
  cancelAcquire(c)
  if (c.granted && !c.releaseTimer) {
    c.releaseTimer = setTimeout(() => {
      c.releaseTimer = null
      if (c.granted) {
        try {
          c.release()
        } catch {
          // best-effort
        }
        c.granted = false
      }
    }, WEBGL_RELEASE_DELAY_MS)
  }
}

/**
 * Register a terminal node as a WebGL client. The coordinator calls `acquire`/`release` to grant
 * or reclaim the GPU context; the node drives `handle.setVisible` from its IntersectionObserver,
 * reports external context loss via `handle.contextLost`, and calls `handle.dispose` on unmount.
 */
export function registerWebglClient(
  id: string,
  callbacks: WebglClientCallbacks,
  surfaceBytes: number
): WebglClientHandle {
  // A re-register under the same id (e.g. a remount that raced teardown) supersedes the old entry.
  // Release a still-granted predecessor: its handle's dispose() will short-circuit (stale-handle
  // guard), so without this the old WebglAddon would leak a real browser context while the
  // coordinator forgets it held a slot — exactly the overshoot this module exists to prevent.
  const existing = clients.get(id)
  if (existing) {
    cancelAcquire(existing)
    cancelRelease(existing)
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
    surfaceBytes: normalizeSurfaceBytes(surfaceBytes),
    acquireTimer: null,
    releaseTimer: null,
    hiddenAt: 0,
    lossStreak: 0
  }
  clients.set(id, client)

  return {
    setVisible(visible: boolean) {
      const c = clients.get(id)
      if (c === client) setVisible(c, visible)
    },
    setSurfaceBytes(surfaceBytes: number) {
      const c = clients.get(id)
      if (c !== client) return
      const next = normalizeSurfaceBytes(surfaceBytes)
      if (next === c.surfaceBytes) return
      c.surfaceBytes = next
      if (c.granted) {
        enforceBudgetsAfterResize(c)
      } else if (c.visible && !c.acquireTimer) {
        // A continuously visible client may have been refused only because its old size did not
        // fit. It has already served the visibility debounce; a smaller measured size may retry.
        tryGrant(c)
      }
    },
    contextLost() {
      const c = clients.get(id)
      if (c !== client) return
      // The browser (or our own dispose) already tore the context down; drop the accounting.
      cancelRelease(c)
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
      cancelRelease(c)
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
  for (const c of clients.values()) {
    cancelAcquire(c)
    cancelRelease(c)
  }
  clients.clear()
  visibilityClock = 0
  budget = WEBGL_BUDGET
}
