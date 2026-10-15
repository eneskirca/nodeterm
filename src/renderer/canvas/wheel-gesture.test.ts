import { describe, expect, it } from 'vitest'
import {
  MacWheelGestureRouter,
  trackpadRoutingEnabled,
  trackpadRoutingSupported,
  wheelGestureReporting
} from './wheel-gesture'

const gesture = (
  deltaY: number,
  o: Partial<{
    deltaX: number
    deltaMode: number
    ctrlKey: boolean
    metaKey: boolean
    wheelDeltaY: number
  }> = {}
) => ({
  deltaY,
  deltaX: o.deltaX ?? 0,
  deltaMode: o.deltaMode ?? 0,
  ctrlKey: o.ctrlKey ?? false,
  metaKey: o.metaKey ?? false,
  wheelDeltaY: o.wheelDeltaY
})

const yes = () => true
const no = () => false

describe('MacWheelGestureRouter', () => {
  it('keeps a notched macOS mouse wheel on the user-configured zoom path', () => {
    const router = new MacWheelGestureRouter()
    expect(router.shouldPan(gesture(100, { wheelDeltaY: -120 }), true, 1000)).toBe(false)
    expect(router.shouldPan(gesture(-100, { wheelDeltaY: 120 }), true, 1100)).toBe(false)
  })

  it('routes smooth two-finger trackpad scroll and its momentum to panning', () => {
    const router = new MacWheelGestureRouter()
    expect(router.shouldPan(gesture(6.25), true, 1000)).toBe(true)
    expect(router.shouldPan(gesture(75), true, 1080)).toBe(true)
    expect(router.shouldPan(gesture(75), true, 1700)).toBe(false)
  })

  it('does not reclassify a quantized packet in an active trackpad gesture as mouse zoom', () => {
    const router = new MacWheelGestureRouter()
    expect(router.shouldPan(gesture(4.5), true, 1000)).toBe(true)
    expect(router.shouldPan(gesture(100, { wheelDeltaY: -120 }), true, 1150)).toBe(true)
    expect(router.shouldPan(gesture(70), true, 1500)).toBe(true)
  })

  it('keeps trackpad scrolling native over terminal and other native scroll surfaces', () => {
    const router = new MacWheelGestureRouter()
    expect(router.destination(gesture(6.25), true, yes, 1000)).toBe('native')
    expect(router.destination(gesture(6.25), true, no, 1400)).toBe('flow-pan')
    expect(router.destination(gesture(100, { wheelDeltaY: -120 }), true, yes, 1800)).toBe('native')
  })

  it('does not pan over a non-terminal native scroller, and still knows the gesture is a trackpad', () => {
    const router = new MacWheelGestureRouter()
    // A trackpad gesture that begins over Monaco / a markdown pane scrolls THAT surface...
    expect(router.destination(gesture(6.25), true, yes, 1000)).toBe('native')
    // ...but the packet still classified the device, so continuing the same gesture off the
    // scroller pans the canvas instead of falling back to the mouse-notch (zoom) path.
    expect(router.destination(gesture(75), true, no, 1100)).toBe('flow-pan')
  })

  it('hands every gesture back to the zoom path once the escape hatch is engaged', () => {
    // trackpadPan off: `mac` is false for the router whatever machine this is, so nothing is
    // ever routed to flow-pan and settings.wheelZoom alone decides — the pre-router behavior.
    expect(trackpadRoutingEnabled(true, true)).toBe(true)
    expect(trackpadRoutingEnabled(true, false)).toBe(false)
    expect(trackpadRoutingEnabled(false, true)).toBe(false)

    const hatch = trackpadRoutingEnabled(true, false)
    const router = new MacWheelGestureRouter()
    // A precise-pixel MOUSE (Magic Mouse, MX Master) emits exactly what a trackpad emits, so it
    // classifies as one — this is the user's only way back to wheel zoom, and it must hold for a
    // whole gesture, not just its first packet.
    expect(router.destination(gesture(6.25), hatch, no, 1000)).toBe('native')
    expect(router.destination(gesture(4.5), hatch, no, 1050)).toBe('native')
    expect(router.destination(gesture(75), hatch, yes, 1100)).toBe('native')
    expect(router.shouldPan(gesture(6.25), hatch, 1150)).toBe(false)
  })

  it('keeps pinch, Cmd-wheel, line-mode wheel and other platforms off the override', () => {
    const router = new MacWheelGestureRouter()
    expect(router.shouldPan(gesture(5, { ctrlKey: true }), true, 1000)).toBe(false)
    expect(router.shouldPan(gesture(5, { metaKey: true }), true, 1000)).toBe(false)
    expect(router.shouldPan(gesture(3, { deltaMode: 1 }), true, 1000)).toBe(false)
    expect(router.shouldPan(gesture(5), false, 1000)).toBe(false)
  })
})

describe('MacWheelGestureRouter with main-process gesture reporting', () => {
  const reporting = () => new MacWheelGestureRouter(true)

  it('zooms a smooth-looking packet when no trackpad gesture is in flight (the MX Master fix)', () => {
    // A precise-pixel mouse emits exactly what a trackpad emits at the DOM level. With the
    // main-process ledger reporting, silence is a POSITIVE fact — no gesture is open, so this
    // is a wheel mouse and it must reach the zoom path even though the heuristic reads it as
    // a trackpad.
    const router = reporting()
    expect(router.shouldPan(gesture(6.25), true, 1000)).toBe(false)
    expect(router.shouldPan(gesture(30), true, 1010)).toBe(false)
  })

  it('pans while a reported gesture is active, even for a notch-quantized packet', () => {
    const router = reporting()
    router.noteGesture(true, 995)
    expect(router.shouldPan(gesture(100, { wheelDeltaY: -120 }), true, 1000)).toBe(true)
  })

  it('keeps panning through the touch→momentum gap after the gesture ends', () => {
    // Measured: a few mouseWheel packets arrive between the touch phase's End and the momentum
    // phase's Begin. They belong to the same physical gesture and must not blip into zoom.
    const router = reporting()
    router.noteGesture(true, 1000)
    router.noteGesture(false, 1200)
    expect(router.shouldPan(gesture(40), true, 1230)).toBe(true)
    // Long after the gesture (and its linger) the mouse owns the wheel again.
    expect(router.shouldPan(gesture(40), true, 1900)).toBe(false)
  })

  it('still refuses non-mac, modified, and line-mode packets in reporting mode', () => {
    const router = reporting()
    router.noteGesture(true, 995)
    expect(router.shouldPan(gesture(10), false, 1000)).toBe(false)
    expect(router.shouldPan(gesture(10, { ctrlKey: true }), true, 1000)).toBe(false)
    expect(router.shouldPan(gesture(10, { metaKey: true }), true, 1000)).toBe(false)
    expect(router.shouldPan(gesture(10, { deltaMode: 1 }), true, 1000)).toBe(false)
  })

  it('without reporting (default constructor) the legacy heuristics are unchanged', () => {
    const router = new MacWheelGestureRouter()
    expect(router.shouldPan(gesture(6.25), true, 1000)).toBe(true)
    expect(router.shouldPan(gesture(100, { wheelDeltaY: -120 }), true, 2000)).toBe(false)
  })

  it('noteGesture on a non-reporting router does not flip it into reporting mode', () => {
    // The stub bridge never calls this, but a defensive caller might: reporting mode is decided
    // by the shell (constructor), never inferred from traffic.
    const router = new MacWheelGestureRouter()
    router.noteGesture(true, 995)
    router.noteGesture(false, 996)
    expect(router.shouldPan(gesture(6.25), true, 1000)).toBe(true)
  })
})

describe('Windows routing (heuristic, no gesture reporting)', () => {
  const win = { mac: false, windows: true }
  const routing = (trackpadPan: boolean): boolean =>
    trackpadRoutingEnabled(trackpadRoutingSupported(win), trackpadPan)

  it('is on for macOS and Windows viewers only, and the escape hatch still turns it off', () => {
    expect(routing(true)).toBe(true)
    expect(routing(false)).toBe(false)
    expect(trackpadRoutingSupported({ mac: true, windows: false })).toBe(true)
    expect(trackpadRoutingSupported({ mac: false, windows: false })).toBe(false)
  })

  it('never turns on main-process gesture reporting off the macOS desktop', () => {
    expect(wheelGestureReporting({ mac: false, browser: false })).toBe(false)
    expect(wheelGestureReporting({ mac: true, browser: true })).toBe(false)
    expect(wheelGestureReporting({ mac: true, browser: false })).toBe(true)
  })

  it('a notched Windows mouse wheel (deltaY 100, wheelDeltaY ±120) stays on the zoom path', () => {
    const router = new MacWheelGestureRouter()
    expect(router.destination(gesture(100, { wheelDeltaY: -120 }), routing(true), no, 1000)).toBe('native')
    // 125% display scaling: deltaY 125, still a 120 notch.
    expect(router.destination(gesture(-125, { wheelDeltaY: 120 }), routing(true), no, 1100)).toBe('native')
    // Two notches coalesced into one packet.
    expect(router.destination(gesture(200, { wheelDeltaY: -240 }), routing(true), no, 1200)).toBe('native')
  })

  it('precision-touchpad packets pan, and stay sticky across a quantized 120 packet', () => {
    const router = new MacWheelGestureRouter()
    expect(router.destination(gesture(13.5, { wheelDeltaY: -16 }), routing(true), no, 1000)).toBe('flow-pan')
    expect(router.destination(gesture(8, { deltaX: 3, wheelDeltaY: -9 }), routing(true), no, 1040)).toBe('flow-pan')
    expect(router.destination(gesture(100, { wheelDeltaY: -120 }), routing(true), no, 1080)).toBe('flow-pan')
    // Over a terminal/native scroller it scrolls that surface instead.
    expect(router.destination(gesture(7.5, { wheelDeltaY: -9 }), routing(true), yes, 1100)).toBe('native')
  })

  it('pinch (ctrl+wheel) never pans on Windows', () => {
    const router = new MacWheelGestureRouter()
    expect(router.destination(gesture(3.2, { ctrlKey: true }), routing(true), no, 1000)).toBe('native')
  })
})
