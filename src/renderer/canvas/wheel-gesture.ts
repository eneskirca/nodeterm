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
 * That is the recourse for a precise-pixel MOUSE (Magic Mouse, MX Master), whose deltas are
 * indistinguishable from a trackpad's here: it classifies as a trackpad and would otherwise have
 * no way back to wheel zoom.
 */
export const trackpadRoutingEnabled = (mac: boolean, trackpadPan: boolean): boolean =>
  mac && trackpadPan

const TRACKPAD_SEQUENCE_MS = 500
const MOUSE_WHEEL_NOTCH = 120
const LARGE_PIXEL_DELTA = 40

/** Pixel mode alone is not a device identity: Chromium uses it for trackpads and many mice. */
export class MacWheelGestureRouter {
  private trackpadUntil = 0

  shouldPan(event: WheelGesture, mac: boolean, now = performance.now()): boolean {
    if (!mac || event.ctrlKey || event.metaKey || event.deltaMode !== 0) return false
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
