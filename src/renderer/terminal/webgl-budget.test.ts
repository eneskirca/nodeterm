import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  registerWebglClient,
  __resetWebglBudgetForTests,
  getWebglBudget,
  loseWebglContexts,
  releaseAllHiddenGrants,
  setWebglBudget,
  setWebglEnabled,
  setWebglGesture,
  setWebglZoom,
  setWebglDevicePixelRatio,
  WEBGL_LOW_DPI_CRISP_ABOVE_ZOOM,
  WEBGL_LOW_DPI_GPU_RESUME_BELOW_ZOOM,
  WEBGL_ACQUIRE_DEBOUNCE_MS,
  WEBGL_CRISP_ABOVE_ZOOM,
  WEBGL_GPU_RESUME_BELOW_ZOOM,
  WEBGL_DRAIN_MS,
  WEBGL_SWAPS_PER_DRAIN,
  WEBGL_BUDGET,
  WEBGL_LOSS_STREAK_MAX,
  WEBGL_REACQUIRE_AFTER_LOSS_MS,
  type WebglClientHandle
} from './webgl-budget'
import { FIT_NODE_OPTIONS } from '../lib/nodeFocus'

/** A fake client that records acquire/release calls and reports a configurable acquire result. */
function fakeClient(id: string, opts: { acquireOk?: boolean } = {}) {
  const rec = { acquires: 0, releases: 0, held: false }
  const acquireOk = opts.acquireOk ?? true
  const handle: WebglClientHandle = registerWebglClient(id, {
    acquire() {
      rec.acquires++
      if (acquireOk) rec.held = true
      return acquireOk
    },
    release() {
      rec.releases++
      rec.held = false
    }
  })
  return { id, rec, handle }
}

/** Bring a client to a granted state: make it visible and let the debounce fire. */
function grant(c: ReturnType<typeof fakeClient>) {
  c.handle.setVisible(true)
  vi.advanceTimersByTime(WEBGL_ACQUIRE_DEBOUNCE_MS)
}

describe('webgl-budget coordinator', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    __resetWebglBudgetForTests()
  })
  afterEach(() => {
    __resetWebglBudgetForTests()
    vi.useRealTimers()
  })

  it('grants a visible client (after debounce) when under budget', () => {
    const a = fakeClient('a')
    a.handle.setVisible(true)
    // Not yet: still inside the debounce window.
    vi.advanceTimersByTime(WEBGL_ACQUIRE_DEBOUNCE_MS - 1)
    expect(a.rec.acquires).toBe(0)
    vi.advanceTimersByTime(1)
    expect(a.rec.acquires).toBe(1)
    expect(a.rec.held).toBe(true)
  })

  it('does not acquire for a client visible for less than the debounce', () => {
    const a = fakeClient('a')
    a.handle.setVisible(true)
    vi.advanceTimersByTime(WEBGL_ACQUIRE_DEBOUNCE_MS - 1)
    a.handle.setVisible(false)
    vi.advanceTimersByTime(WEBGL_ACQUIRE_DEBOUNCE_MS * 5)
    expect(a.rec.acquires).toBe(0)
  })

  it('reclaims the least-recently-visible hidden holder when the budget is full', () => {
    const clients = Array.from({ length: WEBGL_BUDGET }, (_, i) => fakeClient(`c${i}`))
    clients.forEach(grant)
    expect(clients.every((c) => c.rec.held)).toBe(true)

    // Hide c0 first, then c1 — c0 is now the least-recently-visible hidden holder. Both keep their
    // (warm) context for the release delay.
    clients[0].handle.setVisible(false)
    clients[1].handle.setVisible(false)
    expect(clients[0].rec.held).toBe(true)
    expect(clients[1].rec.held).toBe(true)

    // A newcomer becomes visible while the budget is still full → reclaim c0 (the LRU hidden
    // holder), bypassing its release delay, and grant the newcomer.
    const nc = fakeClient('newcomer')
    grant(nc)
    expect(clients[0].rec.releases).toBe(1) // reclaimed on demand
    expect(clients[1].rec.releases).toBe(0) // more recently visible → spared
    expect(nc.rec.held).toBe(true)
  })

  it('refuses to grant when every holder is currently visible (never exceeds budget)', () => {
    const clients = Array.from({ length: WEBGL_BUDGET }, (_, i) => fakeClient(`c${i}`))
    clients.forEach(grant)
    // All BUDGET holders are visible; a further visible client must NOT be granted (no eviction).
    const extra = fakeClient('extra')
    grant(extra)
    expect(extra.rec.acquires).toBe(0)
    expect(extra.rec.held).toBe(false)
    expect(clients.every((c) => c.rec.held)).toBe(true)
  })

  // ── The GPU-rendering master switch (Settings toggle → macOS flicker escape hatch) ──────────
  it('setWebglEnabled(false) reclaims every live context and blocks new grants', () => {
    const a = fakeClient('a')
    const b = fakeClient('b')
    grant(a)
    grant(b)
    expect(a.rec.held && b.rec.held).toBe(true)

    setWebglEnabled(false)
    // Every held context is reclaimed immediately (no release-delay wait) → all on DOM renderer.
    expect(a.rec.held).toBe(false)
    expect(b.rec.held).toBe(false)
    expect(a.rec.releases).toBe(1)

    // A newly-visible client is NOT granted while disabled, even under budget.
    const c = fakeClient('c')
    grant(c)
    expect(c.rec.acquires).toBe(0)
    expect(c.rec.held).toBe(false)
  })

  it('setWebglEnabled(true) re-grants the visible clients', () => {
    const a = fakeClient('a')
    grant(a)
    setWebglEnabled(false)
    expect(a.rec.held).toBe(false)

    setWebglEnabled(true)
    // `a` is still visible → it re-acquires immediately (no debounce; it never went hidden).
    expect(a.rec.held).toBe(true)
    expect(a.rec.acquires).toBe(2)
  })

  it('setWebglEnabled is idempotent (no reclaim on a redundant off→off)', () => {
    const a = fakeClient('a')
    grant(a)
    setWebglEnabled(false)
    expect(a.rec.releases).toBe(1)
    setWebglEnabled(false) // no-op
    expect(a.rec.releases).toBe(1)
  })

  it('a hidden holder keeps its context indefinitely (reclaim is on-demand, never timed)', () => {
    const a = fakeClient('a')
    grant(a)
    a.handle.setVisible(false)
    vi.advanceTimersByTime(60 * 60 * 1000) // an hour off-screen
    expect(a.rec.releases).toBe(0)
    expect(a.rec.held).toBe(true)
  })

  it('a pan-back of any length costs no renderer swap (no release, no re-acquire)', () => {
    const a = fakeClient('a')
    grant(a)
    a.handle.setVisible(false)
    vi.advanceTimersByTime(10 * 60 * 1000)
    a.handle.setVisible(true)
    vi.advanceTimersByTime(WEBGL_ACQUIRE_DEBOUNCE_MS * 2)
    expect(a.rec.releases).toBe(0)
    expect(a.rec.acquires).toBe(1) // the original grant, still live
    expect(a.rec.held).toBe(true)
  })

  it('frees a slot when a context is lost from outside (waiting newcomers are not auto-served)', () => {
    const clients = Array.from({ length: WEBGL_BUDGET }, (_, i) => fakeClient(`c${i}`))
    clients.forEach(grant)

    // A visible newcomer cannot be granted while full and all holders visible.
    const nc = fakeClient('nc')
    grant(nc)
    expect(nc.rec.held).toBe(false)

    // One holder's context is lost (browser eviction / our own dispose reported it).
    clients[0].handle.contextLost()

    // The freed slot is NOT auto-handed to the waiting NEWCOMER — a transition must drive it.
    // (The loser itself schedules a delayed retry; that is the next test's subject.)
    expect(nc.rec.acquires).toBe(0)

    // On the newcomer's next visibility transition it is now granted (a slot is free).
    nc.handle.setVisible(false)
    nc.handle.setVisible(true)
    vi.advanceTimersByTime(WEBGL_ACQUIRE_DEBOUNCE_MS)
    expect(nc.rec.held).toBe(true)

    // The loser's own delayed retry then finds the budget full with every holder visible and
    // declines — no second acquire, and nobody is evicted for it.
    vi.advanceTimersByTime(WEBGL_REACQUIRE_AFTER_LOSS_MS)
    expect(clients[0].rec.acquires).toBe(1)
    expect(nc.rec.held).toBe(true)
  })

  it('a visible client whose context is lost externally re-acquires after the loss delay', () => {
    // The sleep/wake shape: contexts die with NO visibility change; the client must come back
    // on its own instead of sitting on the DOM renderer until the user pans away and back.
    const a = fakeClient('a')
    grant(a)
    expect(a.rec.acquires).toBe(1)

    a.handle.contextLost()
    expect(a.rec.acquires).toBe(1) // not immediate — the GPU may still be settling
    vi.advanceTimersByTime(WEBGL_REACQUIRE_AFTER_LOSS_MS)
    expect(a.rec.acquires).toBe(2)
    expect(a.rec.held).toBe(true)
  })

  it('a page-wide loss re-grants as a TRICKLE, not a burst (the GPU-reset shape)', () => {
    // A GPU process reset loses every context at once, so every visible client reports the loss
    // and their retries all come due together. The re-grants go through the drain, so the
    // rebuilds spread out at WEBGL_SWAPS_PER_DRAIN per tick instead of landing in one frame.
    // (`contextLost` drops the accounting only — the caller has already disposed the dead addon,
    // which is why the acquire COUNT, not `held`, is what says a rebuild happened.)
    const clients = ['a', 'b', 'c', 'd', 'e'].map((id) => fakeClient(id))
    clients.forEach(grant)
    expect(clients.every((c) => c.rec.acquires === 1)).toBe(true)

    clients.forEach((c) => c.handle.contextLost())
    const rebuilt = () => clients.filter((c) => c.rec.acquires === 2).length

    // Every retry comes due in the same frame; the queue caps what that frame may execute.
    vi.advanceTimersByTime(WEBGL_REACQUIRE_AFTER_LOSS_MS)
    const firstFrame = rebuilt()
    expect(firstFrame).toBeGreaterThan(0)
    expect(firstFrame).toBeLessThanOrEqual(WEBGL_SWAPS_PER_DRAIN)
    expect(firstFrame).toBeLessThan(clients.length) // the burst is what this prevents

    // …and each tick after it moves at most a batch further.
    const secondFrame = (vi.advanceTimersByTime(WEBGL_DRAIN_MS), rebuilt())
    expect(secondFrame).toBeGreaterThan(firstFrame)
    expect(secondFrame - firstFrame).toBeLessThanOrEqual(WEBGL_SWAPS_PER_DRAIN)

    // …until every terminal is back on the GPU.
    vi.advanceTimersByTime(WEBGL_DRAIN_MS * 5)
    expect(rebuilt()).toBe(clients.length)
  })

  it('a post-loss re-grant waits for the canvas to come to rest (no rebuild mid-gesture)', () => {
    const a = fakeClient('a')
    grant(a)
    a.handle.contextLost()
    setWebglGesture(true)
    vi.advanceTimersByTime(WEBGL_REACQUIRE_AFTER_LOSS_MS + WEBGL_DRAIN_MS * 5)
    expect(a.rec.acquires).toBe(1) // parked, not rebuilt under the user's hand
    setWebglGesture(false)
    expect(a.rec.acquires).toBe(2)
  })

  it('a hidden client whose context is lost schedules no retry', () => {
    const a = fakeClient('a')
    grant(a)
    a.handle.setVisible(false)
    a.handle.contextLost()
    vi.advanceTimersByTime(WEBGL_REACQUIRE_AFTER_LOSS_MS * 2)
    expect(a.rec.acquires).toBe(1)
  })

  it('stops retrying after WEBGL_LOSS_STREAK_MAX consecutive losses; a visibility transition resets', () => {
    const a = fakeClient('a')
    grant(a)
    // Each loss within the streak retries once…
    for (let i = 0; i < WEBGL_LOSS_STREAK_MAX; i++) {
      a.handle.contextLost()
      vi.advanceTimersByTime(WEBGL_REACQUIRE_AFTER_LOSS_MS)
    }
    expect(a.rec.acquires).toBe(1 + WEBGL_LOSS_STREAK_MAX)
    // …but the loss beyond the cap gives up (unstable GPU → stay on the DOM renderer).
    a.handle.contextLost()
    vi.advanceTimersByTime(WEBGL_REACQUIRE_AFTER_LOSS_MS * 2)
    expect(a.rec.acquires).toBe(1 + WEBGL_LOSS_STREAK_MAX)

    // Panning away and back (the pre-existing recovery) resets the streak and re-grants.
    a.handle.setVisible(false)
    a.handle.setVisible(true)
    vi.advanceTimersByTime(WEBGL_ACQUIRE_DEBOUNCE_MS)
    expect(a.rec.held).toBe(true)
  })

  it('dispose releases a granted context and cancels timers', () => {
    const a = fakeClient('a')
    grant(a)
    expect(a.rec.held).toBe(true)
    a.handle.dispose()
    expect(a.rec.releases).toBe(1)
    expect(a.rec.held).toBe(false)

    // A disposed client frees its slot for others.
    const others = Array.from({ length: WEBGL_BUDGET }, (_, i) => fakeClient(`o${i}`))
    others.forEach(grant)
    expect(others.every((c) => c.rec.held)).toBe(true)
  })

  it('dispose cancels a pending acquire debounce (no acquire after unmount)', () => {
    const a = fakeClient('a')
    a.handle.setVisible(true)
    a.handle.dispose()
    vi.advanceTimersByTime(WEBGL_ACQUIRE_DEBOUNCE_MS * 5)
    expect(a.rec.acquires).toBe(0)
  })

  it('an acquire that returns false does not burn a budget slot', () => {
    // A client whose WebGL2 is unavailable: acquire returns false.
    const bad = fakeClient('bad', { acquireOk: false })
    grant(bad)
    expect(bad.rec.acquires).toBe(1)
    expect(bad.rec.held).toBe(false)

    // The full budget is still available to real clients.
    const clients = Array.from({ length: WEBGL_BUDGET }, (_, i) => fakeClient(`c${i}`))
    clients.forEach(grant)
    expect(clients.every((c) => c.rec.held)).toBe(true)
  })

  it('re-registering an id releases the superseded grant (no leaked context, no phantom slot)', () => {
    const a = fakeClient('dup')
    grant(a)
    expect(a.rec.acquires).toBe(1)
    // Remount races teardown: a second registration under the same id supersedes the first. The
    // predecessor's grant must be reclaimed here — its own dispose() will short-circuit (stale
    // handle), so skipping this leaks a real browser context the coordinator no longer counts.
    const b = fakeClient('dup')
    expect(a.rec.releases).toBe(1)
    a.handle.dispose() // stale handle: inert
    grant(b)
    expect(b.rec.acquires).toBe(1)
    b.handle.dispose()
  })

  it('setWebglBudget raises the grant ceiling (desktop, where the browser cap is raised too)', () => {
    setWebglBudget(WEBGL_BUDGET + 4)
    expect(getWebglBudget()).toBe(WEBGL_BUDGET + 4)
    const clients = Array.from({ length: WEBGL_BUDGET + 4 }, (_, i) => fakeClient(`c${i}`))
    clients.forEach(grant)
    expect(clients.every((c) => c.rec.held)).toBe(true)
    // The raised ceiling is still a ceiling: one more all-visible client is not granted.
    const extra = fakeClient('extra')
    grant(extra)
    expect(extra.rec.held).toBe(false)
  })

  it('setWebglBudget ignores nonsense values and reset restores the default', () => {
    setWebglBudget(0)
    expect(getWebglBudget()).toBe(WEBGL_BUDGET)
    setWebglBudget(NaN)
    expect(getWebglBudget()).toBe(WEBGL_BUDGET)
    setWebglBudget(20)
    expect(getWebglBudget()).toBe(20)
    __resetWebglBudgetForTests()
    expect(getWebglBudget()).toBe(WEBGL_BUDGET)
  })

  describe('crisp gate (GPU text is a magnified bitmap when zoomed in)', () => {
    /** Zoom past the threshold and let the rest-time drain run. */
    const zoomTo = (zoom: number): void => {
      setWebglZoom(zoom)
      vi.advanceTimersByTime(WEBGL_DRAIN_MS * 10)
    }

    it('crossing above the threshold gives every on-screen context back — VISIBLE holders too', () => {
      const a = fakeClient('a')
      const b = fakeClient('b')
      grant(a)
      grant(b)
      expect(a.rec.held && b.rec.held).toBe(true)
      zoomTo(WEBGL_CRISP_ABOVE_ZOOM + 0.01)
      // The visible-holder exemption every other release path honours is deliberately waived
      // here: the terminal the user zoomed into is exactly the one that must go crisp.
      expect(a.rec.held).toBe(false)
      expect(b.rec.held).toBe(false)
    })

    it('blocks grants while zoomed in, and re-grants visible clients on the way back', () => {
      const a = fakeClient('a')
      zoomTo(WEBGL_CRISP_ABOVE_ZOOM + 0.01)
      grant(a)
      expect(a.rec.acquires).toBe(0)
      zoomTo(WEBGL_GPU_RESUME_BELOW_ZOOM - 0.01)
      expect(a.rec.held).toBe(true)
    })

    it('hysteresis: hovering between the two thresholds never churns a context', () => {
      const a = fakeClient('a')
      grant(a)
      zoomTo(WEBGL_CRISP_ABOVE_ZOOM + 0.01)
      expect(a.rec.releases).toBe(1)
      // Back into the band, but not under the resume threshold: still crisp, no re-grant…
      zoomTo(WEBGL_CRISP_ABOVE_ZOOM - 0.05)
      expect(a.rec.acquires).toBe(1)
      // …and back up again costs nothing either.
      zoomTo(WEBGL_CRISP_ABOVE_ZOOM + 0.05)
      expect(a.rec.releases).toBe(1)
    })

    it('swaps NOTHING mid-gesture, then trickles once the canvas is at rest', () => {
      const clients = ['a', 'b', 'c'].map((id) => fakeClient(id))
      clients.forEach(grant)
      setWebglGesture(true)
      setWebglZoom(WEBGL_CRISP_ABOVE_ZOOM + 0.01)
      vi.advanceTimersByTime(WEBGL_DRAIN_MS * 5)
      expect(clients.every((c) => c.rec.held)).toBe(true) // a zoom gesture is still running
      setWebglGesture(false)
      vi.advanceTimersByTime(WEBGL_DRAIN_MS * 5)
      expect(clients.every((c) => !c.rec.held)).toBe(true)
    })

    it('a dip below the threshold before the drain runs keeps the context warm', () => {
      const a = fakeClient('a')
      grant(a)
      setWebglGesture(true) // parks the release
      setWebglZoom(WEBGL_CRISP_ABOVE_ZOOM + 0.01)
      setWebglZoom(WEBGL_GPU_RESUME_BELOW_ZOOM - 0.01) // zoomed back out before rest
      setWebglGesture(false)
      vi.advanceTimersByTime(WEBGL_DRAIN_MS * 5)
      expect(a.rec.releases).toBe(0)
      expect(a.rec.acquires).toBe(1)
    })

    it('the way back respects the master switch: disabled stays DOM-only', () => {
      const a = fakeClient('a')
      grant(a)
      zoomTo(WEBGL_CRISP_ABOVE_ZOOM + 0.01)
      setWebglEnabled(false)
      zoomTo(WEBGL_GPU_RESUME_BELOW_ZOOM - 0.01)
      expect(a.rec.acquires).toBe(1)
    })

    it('ignores non-finite zoom values', () => {
      const a = fakeClient('a')
      grant(a)
      zoomTo(Number.NaN)
      expect(a.rec.held).toBe(true)
    })

    it('a hidden holder keeps its warm context through the gate, and the way back re-grants nothing for it', () => {
      const a = fakeClient('a')
      const h = fakeClient('h')
      grant(a)
      grant(h)
      h.handle.setVisible(false)
      zoomTo(WEBGL_CRISP_ABOVE_ZOOM + 0.01)
      expect(a.rec.held).toBe(false) // on screen: goes crisp
      expect(h.rec.releases).toBe(0) // off screen: the blur shows nowhere
      zoomTo(WEBGL_GPU_RESUME_BELOW_ZOOM - 0.01)
      h.handle.setVisible(true)
      vi.advanceTimersByTime(WEBGL_ACQUIRE_DEBOUNCE_MS + WEBGL_DRAIN_MS * 5)
      expect(h.rec.held).toBe(true)
      expect(h.rec.acquires).toBe(1) // never let go, so never re-granted
      expect(a.rec.acquires).toBe(2)
    })

    it('a warm holder panned into view while zoomed in goes crisp — at rest, not mid-gesture', () => {
      const h = fakeClient('h')
      grant(h)
      h.handle.setVisible(false)
      zoomTo(WEBGL_CRISP_ABOVE_ZOOM + 0.01)
      setWebglGesture(true)
      h.handle.setVisible(true)
      vi.advanceTimersByTime(WEBGL_DRAIN_MS * 5)
      expect(h.rec.held).toBe(true)
      setWebglGesture(false)
      vi.advanceTimersByTime(WEBGL_DRAIN_MS * 5)
      expect(h.rec.held).toBe(false)
    })

    it('a zoomed-in pan that only crosses a warm holder leaves it warm', () => {
      const h = fakeClient('h')
      grant(h)
      h.handle.setVisible(false)
      zoomTo(WEBGL_CRISP_ABOVE_ZOOM + 0.01)
      setWebglGesture(true)
      h.handle.setVisible(true)
      h.handle.setVisible(false)
      setWebglGesture(false)
      vi.advanceTimersByTime(WEBGL_DRAIN_MS * 5)
      expect(h.rec.releases).toBe(0)
      expect(h.rec.held).toBe(true)
    })

    it('zooming back out does not cancel a pressure release a hidden holder still owes', () => {
      const a = fakeClient('a')
      const h = fakeClient('h')
      grant(a)
      grant(h)
      h.handle.setVisible(false)
      setWebglGesture(true)
      setWebglZoom(WEBGL_CRISP_ABOVE_ZOOM + 0.01)
      releaseAllHiddenGrants()
      setWebglZoom(WEBGL_GPU_RESUME_BELOW_ZOOM - 0.01)
      setWebglGesture(false)
      vi.advanceTimersByTime(WEBGL_DRAIN_MS * 5)
      expect(h.rec.held).toBe(false) // the pressure sweep's release stands
      expect(a.rec.releases).toBe(0) // the brief overshoot is still forgiven
    })
  })

  describe('crisp gate on a low-DPI display (issue #986)', () => {
    // At devicePixelRatio 1 there is no spare resolution: ANY non-integer magnification of the GPU
    // bitmap smears glyph edges. Measured at DPR 1 (mid-ramp share of ink, higher = blurrier):
    // webgl 35.6% at 100% but ~62% from 110% up to 175%, while dom stays at or under ~40%.
    const zoomTo = (zoom: number): void => {
      setWebglZoom(zoom)
      vi.advanceTimersByTime(WEBGL_DRAIN_MS * 10)
    }

    it('at DPR 1 a zoom just past 100% already goes crisp, and 100% itself stays on the GPU', () => {
      setWebglDevicePixelRatio(1)
      const a = fakeClient('a')
      zoomTo(1)
      grant(a)
      expect(a.rec.held).toBe(true)
      zoomTo(1.1)
      expect(a.rec.held).toBe(false)
      zoomTo(1)
      expect(a.rec.held).toBe(true)
    })

    it('keeps its own hysteresis band just above 100%', () => {
      setWebglDevicePixelRatio(1)
      const a = fakeClient('a')
      grant(a)
      zoomTo(WEBGL_LOW_DPI_CRISP_ABOVE_ZOOM + 0.001)
      expect(a.rec.releases).toBe(1)
      zoomTo(WEBGL_LOW_DPI_GPU_RESUME_BELOW_ZOOM + 0.001) // in the band: still crisp
      expect(a.rec.acquires).toBe(1)
      zoomTo(WEBGL_LOW_DPI_GPU_RESUME_BELOW_ZOOM - 0.001)
      expect(a.rec.acquires).toBe(2)
    })

    it('a high-DPI display keeps the original 175% threshold', () => {
      setWebglDevicePixelRatio(2)
      const a = fakeClient('a')
      grant(a)
      zoomTo(1.5)
      expect(a.rec.held).toBe(true)
      zoomTo(WEBGL_CRISP_ABOVE_ZOOM + 0.01)
      expect(a.rec.held).toBe(false)
    })

    it('moving the window between displays re-evaluates the current zoom', () => {
      const a = fakeClient('a')
      setWebglDevicePixelRatio(2)
      grant(a)
      zoomTo(1.25)
      expect(a.rec.held).toBe(true)
      setWebglDevicePixelRatio(1) // dragged onto the low-DPI monitor
      vi.advanceTimersByTime(WEBGL_DRAIN_MS * 10)
      expect(a.rec.held).toBe(false)
      setWebglDevicePixelRatio(2) // and back onto the retina display
      vi.advanceTimersByTime(WEBGL_DRAIN_MS * 10)
      expect(a.rec.held).toBe(true)
    })

    it('a display change decides on the entry threshold of the NEW display, not the hysteresis band', () => {
      // Crisp at 170% on the 1x display; 170% is inside the retina band (160–175%) but never
      // crossed the retina entry line, so on the retina display it must go back to the GPU.
      setWebglDevicePixelRatio(1)
      const a = fakeClient('a')
      grant(a)
      zoomTo(1.7)
      expect(a.rec.held).toBe(false)
      setWebglDevicePixelRatio(2)
      vi.advanceTimersByTime(WEBGL_DRAIN_MS * 10)
      expect(a.rec.held).toBe(true)
    })

    it('a ratio change that keeps the same thresholds keeps the hysteresis band', () => {
      // 2 → 3 (a move between two retina-class displays, or browser zoom) does not change the
      // thresholds, so a terminal crisp at 170% (inside the 160–175% band) must stay crisp.
      setWebglDevicePixelRatio(2)
      const a = fakeClient('a')
      grant(a)
      zoomTo(1.8)
      zoomTo(1.7)
      expect(a.rec.held).toBe(false)
      setWebglDevicePixelRatio(3)
      vi.advanceTimersByTime(WEBGL_DRAIN_MS * 10)
      expect(a.rec.held).toBe(false)
    })

    it('a node focus round trip swaps only what is on screen (goToNode frames past this line)', () => {
      // On a 1x display every focus crosses the low-DPI line: goToNode frames at up to
      // FIT_NODE_OPTIONS.maxZoom. Releasing the whole pool there put the focused node behind every
      // off-screen release and re-granted all of them on the way back out.
      expect(FIT_NODE_OPTIONS.maxZoom).toBeGreaterThan(WEBGL_LOW_DPI_CRISP_ABOVE_ZOOM)
      setWebglDevicePixelRatio(1)
      setWebglBudget(24)
      const cs = Array.from({ length: 24 }, (_, i) => fakeClient(`c${i}`))
      cs.forEach(grant)
      expect(cs.every((c) => c.rec.held)).toBe(true)
      const focused = cs[23] // registered last: the worst place in the drain's queue
      const others = cs.slice(0, 23)

      setWebglGesture(true)
      others.forEach((c) => c.handle.setVisible(false))
      setWebglZoom(FIT_NODE_OPTIONS.maxZoom)
      setWebglGesture(false) // at rest: the drain's FIRST batch
      expect(focused.rec.held).toBe(false)
      vi.advanceTimersByTime(WEBGL_DRAIN_MS * 20)
      expect(others.every((c) => c.rec.held)).toBe(true)

      // Back out to the overview: everything on screen again (reported while the gate is still
      // closed — the order an IntersectionObserver can deliver it in).
      setWebglGesture(true)
      cs.forEach((c) => c.handle.setVisible(true))
      setWebglZoom(0.6)
      setWebglGesture(false)
      vi.advanceTimersByTime(WEBGL_ACQUIRE_DEBOUNCE_MS + WEBGL_DRAIN_MS * 20)
      expect(cs.every((c) => c.rec.held)).toBe(true)
      expect(others.every((c) => c.rec.acquires === 1 && c.rec.releases === 0)).toBe(true)
      expect(focused.rec.acquires).toBe(2)
    })

    it('ignores a non-finite or non-positive ratio', () => {
      const a = fakeClient('a')
      grant(a)
      zoomTo(1.25)
      setWebglDevicePixelRatio(Number.NaN)
      setWebglDevicePixelRatio(0)
      vi.advanceTimersByTime(WEBGL_DRAIN_MS * 10)
      expect(a.rec.held).toBe(true)
    })
  })

  describe('gesture latch (no swaps mid-gesture, staggered drain at rest)', () => {
    it('defers grants while a gesture runs and executes them at rest', () => {
      setWebglGesture(true)
      const a = fakeClient('a')
      a.handle.setVisible(true)
      vi.advanceTimersByTime(WEBGL_ACQUIRE_DEBOUNCE_MS * 3)
      expect(a.rec.acquires).toBe(0) // parked, not granted mid-gesture
      setWebglGesture(false)
      expect(a.rec.held).toBe(true) // drained at rest
    })

    it('defers a pressure-queued release while a gesture runs; a re-visible client keeps it', () => {
      const a = fakeClient('a')
      grant(a)
      a.handle.setVisible(false)
      setWebglGesture(true)
      releaseAllHiddenGrants()
      expect(a.rec.held).toBe(true) // release parked, not executed mid-gesture
      // Pans back before the gesture ends: the owed release is forgiven, context stays warm.
      a.handle.setVisible(true)
      setWebglGesture(false)
      vi.advanceTimersByTime(WEBGL_DRAIN_MS * 3)
      expect(a.rec.held).toBe(true)
      expect(a.rec.releases).toBe(0)
    })

    it('executes a deferred pressure release at rest when the client stayed hidden', () => {
      const a = fakeClient('a')
      grant(a)
      a.handle.setVisible(false)
      setWebglGesture(true)
      releaseAllHiddenGrants()
      expect(a.rec.held).toBe(true)
      setWebglGesture(false)
      expect(a.rec.held).toBe(false)
    })

    it('drains a mass release as a trickle, WEBGL_SWAPS_PER_DRAIN per tick', () => {
      const clients = ['a', 'b', 'c', 'd', 'e'].map((id) => fakeClient(id))
      clients.forEach(grant)
      clients.forEach((c) => c.handle.setVisible(false))
      expect(clients.every((c) => c.rec.held)).toBe(true)
      // Pressure sweep mid-gesture: nothing releases until rest…
      setWebglGesture(true)
      releaseAllHiddenGrants()
      expect(clients.every((c) => c.rec.held)).toBe(true)
      // …then the drain releases them a batch per tick, never all in one frame.
      setWebglGesture(false)
      const heldAfterFirstBatch = clients.filter((c) => c.rec.held).length
      expect(heldAfterFirstBatch).toBe(clients.length - WEBGL_SWAPS_PER_DRAIN)
      vi.advanceTimersByTime(WEBGL_DRAIN_MS)
      expect(clients.filter((c) => c.rec.held).length).toBe(
        Math.max(0, clients.length - 2 * WEBGL_SWAPS_PER_DRAIN)
      )
      vi.advanceTimersByTime(WEBGL_DRAIN_MS * 3)
      expect(clients.every((c) => !c.rec.held)).toBe(true)
    })

    it('a gesture starting mid-drain pauses the trickle until the next rest', () => {
      const clients = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => fakeClient(id))
      clients.forEach(grant)
      clients.forEach((c) => c.handle.setVisible(false))
      setWebglGesture(true)
      releaseAllHiddenGrants()
      setWebglGesture(false) // first batch drains
      const afterFirst = clients.filter((c) => c.rec.held).length
      setWebglGesture(true) // user grabs the canvas again
      vi.advanceTimersByTime(WEBGL_DRAIN_MS * 5)
      expect(clients.filter((c) => c.rec.held).length).toBe(afterFirst) // paused
      setWebglGesture(false)
      vi.advanceTimersByTime(WEBGL_DRAIN_MS * 5)
      expect(clients.every((c) => !c.rec.held)).toBe(true)
    })
  })

  describe('releaseAllHiddenGrants (memory-pressure lever)', () => {
    it('gives back a hidden holder immediately at rest (the one proactive release)', () => {
      const a = fakeClient('a')
      grant(a)
      a.handle.setVisible(false)
      // Well inside the warm window — the lever is what ends it, not the timer.
      expect(a.rec.held).toBe(true)
      releaseAllHiddenGrants()
      vi.advanceTimersByTime(WEBGL_DRAIN_MS * 3)
      expect(a.rec.held).toBe(false)
      expect(a.rec.releases).toBe(1)
    })

    it('never touches a VISIBLE holder', () => {
      const visible = fakeClient('visible')
      const hidden = fakeClient('hidden')
      grant(visible)
      grant(hidden)
      hidden.handle.setVisible(false)
      releaseAllHiddenGrants()
      vi.advanceTimersByTime(WEBGL_DRAIN_MS * 5)
      expect(hidden.rec.held).toBe(false)
      expect(visible.rec.held).toBe(true)
      expect(visible.rec.releases).toBe(0)
    })

    it('is idempotent — a second call releases nothing extra', () => {
      const a = fakeClient('a')
      grant(a)
      a.handle.setVisible(false)
      releaseAllHiddenGrants()
      releaseAllHiddenGrants()
      vi.advanceTimersByTime(WEBGL_DRAIN_MS * 5)
      expect(a.rec.releases).toBe(1)
      releaseAllHiddenGrants() // nothing granted left to give back
      vi.advanceTimersByTime(WEBGL_DRAIN_MS * 5)
      expect(a.rec.releases).toBe(1)
    })

    it('queues the releases through the drain instead of swapping in one frame', () => {
      const clients = ['a', 'b', 'c', 'd', 'e'].map((id) => fakeClient(id))
      clients.forEach(grant)
      clients.forEach((c) => c.handle.setVisible(false))
      releaseAllHiddenGrants()
      // A synchronous reclaim loop would have released all five here — that is the swap storm.
      expect(clients.filter((c) => c.rec.held).length).toBe(clients.length - WEBGL_SWAPS_PER_DRAIN)
      vi.advanceTimersByTime(WEBGL_DRAIN_MS * 5)
      expect(clients.every((c) => !c.rec.held)).toBe(true)
    })

    it('releases NOTHING mid-gesture, then trickles once the canvas is at rest', () => {
      const clients = ['a', 'b', 'c', 'd'].map((id) => fakeClient(id))
      clients.forEach(grant)
      setWebglGesture(true)
      clients.forEach((c) => c.handle.setVisible(false))
      releaseAllHiddenGrants()
      vi.advanceTimersByTime(WEBGL_DRAIN_MS * 10)
      // The load-bearing rule: no renderer swap while the user pans/zooms, pressure or not.
      expect(clients.every((c) => c.rec.held)).toBe(true)
      setWebglGesture(false)
      expect(clients.filter((c) => c.rec.held).length).toBe(clients.length - WEBGL_SWAPS_PER_DRAIN)
      vi.advanceTimersByTime(WEBGL_DRAIN_MS * 5)
      expect(clients.every((c) => !c.rec.held)).toBe(true)
    })

    it('forgives a queued release for a client that became visible again', () => {
      const a = fakeClient('a')
      grant(a)
      a.handle.setVisible(false)
      setWebglGesture(true)
      releaseAllHiddenGrants()
      a.handle.setVisible(true) // pans back before the drain ran
      setWebglGesture(false)
      vi.advanceTimersByTime(WEBGL_DRAIN_MS * 5)
      expect(a.rec.held).toBe(true)
      expect(a.rec.releases).toBe(0)
    })
  })
})

describe('loseWebglContexts', () => {
  /** Canvas-like fake: getContext('webgl2') returns `gl` (or throws), anything else null. */
  function fakeCanvas(gl: unknown, opts: { throws?: boolean } = {}) {
    return {
      getContext(type: string) {
        if (opts.throws) throw new Error('boom')
        return type === 'webgl2' ? gl : null
      }
    }
  }

  it('explicitly loses the webgl2 context of every captured canvas', () => {
    const lose = vi.fn()
    const webglCanvas = fakeCanvas({ getExtension: (n: string) => (n === 'WEBGL_lose_context' ? { loseContext: lose } : null) })
    const linkCanvas = fakeCanvas(null) // 2d-only layer: getContext('webgl2') → null
    expect(loseWebglContexts([webglCanvas, linkCanvas] as never)).toBe(1)
    expect(lose).toHaveBeenCalledTimes(1)
  })

  it('loses the original context through a retained canvas after addon detachment', () => {
    const lose = vi.fn()
    let attached = true
    const originalContext = { getExtension: () => ({ loseContext: lose }) }
    const canvas = {
      get isConnected() { return attached },
      getContext(type: string) { return type === 'webgl2' ? originalContext : null }
    }
    // An addon detach changes DOM membership, not the context held by the captured element.
    attached = false
    expect(canvas.isConnected).toBe(false)
    expect(loseWebglContexts([canvas] as never)).toBe(1)
    expect(lose).toHaveBeenCalledTimes(1)
  })

  it('continues retiring captured contexts when an earlier canvas throws', () => {
    const lose = vi.fn()
    const broken = fakeCanvas(null, { throws: true })
    const live = fakeCanvas({ getExtension: () => ({ loseContext: lose }) })
    expect(loseWebglContexts([broken, live] as never)).toBe(1)
    expect(lose).toHaveBeenCalledTimes(1)
  })

  it('fails open on a throwing canvas and a missing extension', () => {
    const bad = fakeCanvas(null, { throws: true })
    const noExt = fakeCanvas({ getExtension: () => null })
    expect(loseWebglContexts([bad, noExt] as never)).toBe(0)
  })

  it('returns 0 for a null canvas list', () => {
    expect(loseWebglContexts(null)).toBe(0)
  })
})
