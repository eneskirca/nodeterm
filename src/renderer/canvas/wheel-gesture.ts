type WheelGesture = Pick<WheelEvent, 'ctrlKey' | 'metaKey' | 'deltaMode' | 'deltaX' | 'deltaY'> & {
  wheelDeltaY?: number
}

export type MacWheelDestination = 'flow-pan' | 'native'

/**
 * Whether the trackpad override is live at all — the `mac` argument every method below takes.
 *
 * Two reasons it must be one named expression rather than an `isMac &&` at each call site: the
 * router and React Flow's own `panOnScroll` have to agree exactly (disagreeing means a gesture
 * that neither of them pans), and `trackpadPan` is the user's ESCAPE HATCH. Turning it off
 * restores the pre-router behavior on macOS — `wheelZoom` alone decides, and a plain wheel zooms.
 * On the desktop the hatch is rarely needed anymore: main-process gesture reporting (the
 * `gestureReporting` constructor flag below) identifies the device as a fact, so a precise-pixel
 * MOUSE (Magic Mouse, MX Master) reaches wheel zoom while the trackpad keeps panning. It remains
 * the recourse where reporting does not exist — the Server Edition's browser tab — whose
 * heuristics still classify such a mouse as a trackpad.
 */
export const trackpadRoutingEnabled = (mac: boolean, trackpadPan: boolean): boolean =>
  mac && trackpadPan

/**
 * Which viewers get the router at all (the first argument to `trackpadRoutingEnabled` — still
 * named `mac` throughout this file for history). macOS and Windows: Chromium on Windows reports a
 * precision touchpad as small/fractional pixel deltas whose `wheelDeltaY` is not a multiple of
 * 120, and a notched mouse as `wheelDeltaY` = ±120·n — the same split the heuristics below already
 * draw. Linux stays off (libinput/X11 deltas were never measured), so its row is hidden.
 */
export const trackpadRoutingSupported = (viewer: { mac: boolean; windows: boolean }): boolean =>
  viewer.mac || viewer.windows

/**
 * Main-process gesture REPORTING is macOS-desktop only: it rides the gestureScrollBegin/End events
 * macOS wraps every trackpad scroll in (main/trackpad-gesture.ts). Windows — desktop included —
 * and every browser tab keep the delta-shape heuristics.
 */
export const wheelGestureReporting = (viewer: { mac: boolean; browser: boolean }): boolean =>
  viewer.mac && !viewer.browser

const TRACKPAD_SEQUENCE_MS = 500
const MOUSE_WHEEL_NOTCH = 120
const LARGE_PIXEL_DELTA = 40

/** Pixel mode alone is not a device identity: Chromium uses it for trackpads and many mice. */
export class MacWheelGestureRouter {
  private trackpadUntil = 0
  private gestureActive = false
  private gestureEndedAt = Number.NEGATIVE_INFINITY

  /**
   * `gestureReporting` — the desktop shell watches the raw input stream in the main process
   * (main/trackpad-gesture.ts) and feeds `noteGesture` below, which makes device identity a FACT:
   * macOS wraps every trackpad scroll/pinch in gestureScrollBegin/End events a wheel mouse never
   * produces. With reporting on, the delta-shape heuristics below are bypassed entirely — silence
   * from the ledger positively means "wheel mouse", which is what finally lets a precise-pixel
   * mouse (MX Master) zoom while the trackpad pans, both settings on. The flag is decided by the
   * SHELL (Electron preload present = true), never inferred from traffic: the Server Edition's
   * browser tab has no raw input stream, stays at `false`, and keeps the heuristics.
   */
  constructor(private readonly gestureReporting = false) {}

  /** Desktop only: the main-process ledger's edge transitions (trackpad gesture opened/closed). */
  noteGesture(active: boolean, now = performance.now()): void {
    this.gestureActive = active
    if (!active) this.gestureEndedAt = now
  }

  shouldPan(event: WheelGesture, mac: boolean, now = performance.now()): boolean {
    if (!mac || event.ctrlKey || event.metaKey || event.deltaMode !== 0) return false
    if (this.gestureReporting) {
      // Linger after a close: a few mouseWheel packets sit in the touch→momentum gap of the same
      // physical gesture, and one precedes the next phase's Begin (measured; see
      // main/trackpad-gesture.ts). The race the linger cannot cover — the FIRST packet of a
      // brand-new gesture reaching this handler before the Begin's IPC message lands — is
      // accepted: wheel dispatch is rAF-aligned while IPC is a plain task, so the flag almost
      // always wins, and the loser is one small leading delta misrouted to zoom.
      if (this.gestureActive || now - this.gestureEndedAt < TRACKPAD_SEQUENCE_MS) return true
      // Reported silence is a positive fact: no trackpad gesture is open, so this packet is a
      // wheel mouse — even when its deltas look trackpad-smooth.
      return false
    }
    // Device identity is sticky for one physical gesture. Chromium can quantize a later
    // trackpad/momentum event to wheelDeltaY=120; treating that single packet as a mouse notch
    // hands it to wheelZoom and creates the observed one-frame zoom inside an otherwise pure pan.
    if (now <= this.trackpadUntil) {
      this.trackpadUntil = now + TRACKPAD_SEQUENCE_MS
      return true
    }
    const legacyDelta = Math.abs(event.wheelDeltaY ?? 0)
    const mouseNotch = legacyDelta >= MOUSE_WHEEL_NOTCH && legacyDelta % MOUSE_WHEEL_NOTCH === 0
    if (mouseNotch) {
      this.trackpadUntil = 0
      return false
    }
    const smooth =
      event.deltaX !== 0 ||
      !Number.isInteger(event.deltaX) ||
      !Number.isInteger(event.deltaY) ||
      Math.abs(event.deltaY) < LARGE_PIXEL_DELTA
    if (smooth) {
      this.trackpadUntil = now + TRACKPAD_SEQUENCE_MS
      return true
    }
    return false
  }

  /**
   * `overNativeScrollable` is a THUNK, not a boolean: the caller answers it with a DOM ancestor
   * walk and this runs on every wheel packet (~120 Hz through a trackpad pan), so it must not be
   * paid for the packets that never reach the question — a non-trackpad wheel is answered by
   * `shouldPan` alone.
   */
  destination(
    event: WheelGesture,
    mac: boolean,
    overNativeScrollable: () => boolean,
    now = performance.now()
  ): MacWheelDestination {
    if (!this.shouldPan(event, mac, now)) return 'native'
    return overNativeScrollable() ? 'native' : 'flow-pan'
  }
}
