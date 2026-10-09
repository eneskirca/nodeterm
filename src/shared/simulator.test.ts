import { describe, expect, it } from 'vitest'
import {
  normalizeInlineSimulatorConfig,
  touchEdge,
  TOUCH_EDGE_MARGIN,
  normalizeDeviceId,
  simulatorPlatformOf,
  afterTouch,
  UNANSWERED_TOUCHES_FOR_HINT,
  ORIENTATION_DEGREES,
  ORIENTATION_PURPLE,
  displayLabel,
  displayToFramebuffer,
  draggedSide,
  fitNodeToScreen,
  hidUsageForCode,
  rotateOrientation,
  type SimulatorOrientation,
  normalizeSimulatorAction,
  normalizeSimulatorConfig,
  normalizeSimulatorInput,
  pointerToScreenRatio
} from './simulator'

const UDID = '29AC4878-5509-4AAE-B3D1-AB72177B4549'

describe('normalizeSimulatorConfig', () => {
  it('keeps a valid udid (upper-cased) and its name', () => {
    expect(normalizeSimulatorConfig({ udid: UDID.toLowerCase(), name: 'iPhone Duo' })).toEqual({ udid: UDID, name: 'iPhone Duo' })
  })
  it('turns anything else into an unconfigured node', () => {
    expect(normalizeSimulatorConfig({ udid: 'x; rm -rf ~' })).toEqual({})
    expect(normalizeSimulatorConfig(null)).toEqual({})
    expect(normalizeSimulatorConfig({ udid: UDID, name: 'a\nb' })).toEqual({ udid: UDID })
  })
})

describe('normalizeSimulatorInput', () => {
  it('rebuilds touches, clamping to the screen', () => {
    expect(normalizeSimulatorInput({ t: 'down', x: 0.5, y: 1.4, extra: 'x' })).toEqual({ t: 'down', x: 0.5, y: 1 })
    expect(normalizeSimulatorInput({ t: 'move', x: 'NaN', y: 0 })).toBeNull()
  })
  it('accepts only HID usages, known buttons and display indexes', () => {
    expect(normalizeSimulatorInput({ t: 'key', usage: 4, down: true })).toEqual({ t: 'key', usage: 4, down: true })
    expect(normalizeSimulatorInput({ t: 'key', usage: 999, down: true })).toBeNull()
    expect(normalizeSimulatorInput({ t: 'button', name: 'home' })).toEqual({ t: 'button', name: 'home' })
    expect(normalizeSimulatorInput({ t: 'button', name: 'reboot' })).toBeNull()
    expect(normalizeSimulatorInput({ t: 'display', index: -1 })).toEqual({ t: 'display', index: -1 })
    expect(normalizeSimulatorInput({ t: 'shell', cmd: 'x' })).toBeNull()
  })
})

describe('pointerToScreenRatio', () => {
  // A 1000×2000 frame contained in a 400×400 box is drawn 200×400, with 100 px bars left and right.
  it('maps through the letterbox', () => {
    expect(pointerToScreenRatio(200, 200, 400, 400, 1000, 2000)).toEqual({ x: 0.5, y: 0.5 })
    expect(pointerToScreenRatio(100, 0, 400, 400, 1000, 2000)).toEqual({ x: 0, y: 0 })
    expect(pointerToScreenRatio(300, 400, 400, 400, 1000, 2000)).toEqual({ x: 1, y: 1 })
  })
  it('is null in the bars and for an unknown frame', () => {
    expect(pointerToScreenRatio(50, 200, 400, 400, 1000, 2000)).toBeNull()
    expect(pointerToScreenRatio(10, 10, 400, 400, 0, 0)).toBeNull()
  })
  it('is unit-free, so a zoomed canvas (client pixels on both sides) maps the same', () => {
    expect(pointerToScreenRatio(400, 400, 800, 800, 1000, 2000)).toEqual({ x: 0.5, y: 0.5 })
  })
})

describe('hidUsageForCode', () => {
  it('maps physical keys to HID keyboard usages', () => {
    expect(hidUsageForCode('KeyA')).toBe(0x04)
    expect(hidUsageForCode('KeyZ')).toBe(0x1d)
    expect(hidUsageForCode('Digit1')).toBe(0x1e)
    expect(hidUsageForCode('Digit0')).toBe(0x27)
    expect(hidUsageForCode('Enter')).toBe(0x28)
    expect(hidUsageForCode('Backspace')).toBe(0x2a)
    expect(hidUsageForCode('ArrowUp')).toBe(0x52)
    expect(hidUsageForCode('ShiftLeft')).toBe(0xe1)
  })
  it('knows nothing it was not given (including prototype names)', () => {
    expect(hidUsageForCode('MediaPlayPause')).toBeUndefined()
    expect(hidUsageForCode('toString')).toBeUndefined()
  })
})

describe('displayLabel', () => {
  const cover = { index: 1, width: 1398, height: 2034, name: 'LCD', screenID: 1 }
  const inner = { index: 0, width: 2007, height: 2853, name: 'LCD-1', screenID: 3 }
  it('names a foldable’s screens by size, and a single screen plainly', () => {
    expect(displayLabel(inner, [inner, cover])).toBe('Inner')
    expect(displayLabel(cover, [inner, cover])).toBe('Cover')
    expect(displayLabel(cover, [cover])).toBe('Screen')
  })
})

describe('orientation', () => {
  it('turns a quarter at a time and comes back round', () => {
    let o: SimulatorOrientation = 'portrait'
    const seen: SimulatorOrientation[] = []
    for (let i = 0; i < 4; i++) seen.push((o = rotateOrientation(o, 'left')))
    expect(seen).toEqual(['landscape-left', 'portrait-upside-down', 'landscape-right', 'portrait'])
    expect(rotateOrientation('portrait', 'right')).toBe('landscape-right')
    expect(rotateOrientation(rotateOrientation('landscape-left', 'right'), 'left')).toBe('landscape-left')
  })

  it('maps a click on the turned picture back to the same framebuffer point the picture was drawn from', () => {
    // The node draws framebuffer (x,y) at this canvas point (SimulatorNode.paint's transforms).
    const draw = (x: number, y: number, o: SimulatorOrientation) => {
      switch (ORIENTATION_DEGREES[o]) {
        case 90: return { u: 1 - y, v: x }
        case 180: return { u: 1 - x, v: 1 - y }
        case 270: return { u: y, v: 1 - x }
        default: return { u: x, v: y }
      }
    }
    for (const o of ['portrait', 'landscape-left', 'landscape-right', 'portrait-upside-down'] as SimulatorOrientation[]) {
      for (const [x, y] of [[0, 0], [1, 0], [0.25, 0.75], [0.9, 0.1]]) {
        const { u, v } = draw(x, y, o)
        const back = displayToFramebuffer(u, v, o)
        expect(back.x).toBeCloseTo(x)
        expect(back.y).toBeCloseTo(y)
      }
    }
  })

  it('turns the picture counter-clockwise for a device turned left (measured: Purple 3 = dock on the left edge)', () => {
    expect(ORIENTATION_PURPLE['landscape-left']).toBe(3)
    expect(ORIENTATION_DEGREES['landscape-left']).toBe(270)
    // The framebuffer's top-left corner ends up bottom-left on screen.
    expect(displayToFramebuffer(0, 1, 'landscape-left')).toEqual({ x: 0, y: 0 })
  })

  it('persists a non-portrait orientation and accepts only Purple values 1–4', () => {
    expect(normalizeSimulatorConfig({ udid: UDID, orientation: 'landscape-left' })).toEqual({ udid: UDID, orientation: 'landscape-left' })
    expect(normalizeSimulatorConfig({ udid: UDID, orientation: 'sideways' })).toEqual({ udid: UDID })
    expect(normalizeSimulatorInput({ t: 'orientation', value: 3 })).toEqual({ t: 'orientation', value: 3 })
    expect(normalizeSimulatorInput({ t: 'orientation', value: 7 })).toBeNull()
  })
})

describe('fitNodeToScreen', () => {
  // An iPhone 17 framebuffer is 1206×2622 (aspect ≈ 0.46); chrome = 2 px border, 70 px header + toolbar.
  const phone = 1206 / 2622
  const base = { chromeW: 2, chromeH: 70, minW: 200, minH: 260 }

  it('fits the first frame by the longer side: a default 360×760 node becomes a phone with no bars', () => {
    const r = fitNodeToScreen({ ...base, screenW: 358, screenH: 690, aspect: phone, by: 'long' })
    const screenW = r.width - base.chromeW
    const screenH = r.height - base.chromeH
    expect(Math.abs(screenH - 690)).toBeLessThanOrEqual(1) // width is rounded first; height follows it
    expect(Math.abs(screenW / screenH - phone)).toBeLessThan(0.01)
  })

  it('turns a tall phone into a wide one of the same size on rotation', () => {
    const r = fitNodeToScreen({ ...base, screenW: 317, screenH: 690, aspect: 1 / phone, by: 'long' })
    expect(r.width - base.chromeW).toBe(690)
    expect(Math.abs((r.width - base.chromeW) / (r.height - base.chromeH) - 1 / phone)).toBeLessThan(0.01)
  })

  it('follows the side that was dragged', () => {
    const wider = fitNodeToScreen({ ...base, screenW: 500, screenH: 690, aspect: phone, by: 'width' })
    expect(wider.width - base.chromeW).toBe(500)
    expect(wider.height - base.chromeH).toBe(Math.round(500 / phone))
    const taller = fitNodeToScreen({ ...base, screenW: 317, screenH: 900, aspect: phone, by: 'height' })
    expect(taller.height - base.chromeH).toBeCloseTo(900, -1)
  })

  it('keeps the screen’s shape when the minimum width clamps', () => {
    const r = fitNodeToScreen({ ...base, screenW: 50, screenH: 100, aspect: phone, by: 'long' })
    expect(r.width).toBe(200)
    expect(Math.abs((r.width - base.chromeW) / (r.height - base.chromeH) - phone)).toBeLessThan(0.01)
  })

  it('tells which side a hand resize was about', () => {
    expect(draggedSide({ w: 300, h: 600 }, { w: 450, h: 610 })).toBe('width')
    expect(draggedSide({ w: 300, h: 600 }, { w: 305, h: 800 })).toBe('height')
  })
})

describe('normalizeSimulatorAction', () => {
  it('accepts each action in its valid form', () => {
    expect(normalizeSimulatorAction({ a: 'appearance', value: 'dark' })).toEqual({ a: 'appearance', value: 'dark' })
    expect(normalizeSimulatorAction({ a: 'location-set', lat: 37.33, lon: -122.03 })).toEqual({ a: 'location-set', lat: 37.33, lon: -122.03 })
    expect(normalizeSimulatorAction({ a: 'status-bar', preset: 'battery', batteryLevel: 20, batteryState: 'discharging' })).toEqual({
      a: 'status-bar', preset: 'battery', batteryLevel: 20, batteryState: 'discharging'
    })
    expect(normalizeSimulatorAction({ a: 'open-url', url: 'myapp://deep/link' })).toEqual({ a: 'open-url', url: 'myapp://deep/link' })
    expect(normalizeSimulatorAction({ a: 'push', bundleId: 'com.example.app', payload: '{"aps":{"alert":"hi"}}' })).toMatchObject({ a: 'push' })
    expect(normalizeSimulatorAction({ a: 'privacy', op: 'reset', service: 'all' })).toEqual({ a: 'privacy', op: 'reset', service: 'all' })
  })

  it('refuses bad values instead of passing them to simctl', () => {
    expect(normalizeSimulatorAction({ a: 'location-set', lat: 91, lon: 0 })).toBeNull()
    expect(normalizeSimulatorAction({ a: 'status-bar', preset: 'battery', batteryLevel: 150, batteryState: 'charged' })).toBeNull()
    expect(normalizeSimulatorAction({ a: 'open-url', url: 'not a url' })).toBeNull()
    expect(normalizeSimulatorAction({ a: 'push', bundleId: 'com.example.app', payload: '[1,2]' })).toBeNull()
    expect(normalizeSimulatorAction({ a: 'push', bundleId: 'x; rm -rf ~', payload: '{}' })).toBeNull()
    expect(normalizeSimulatorAction({ a: 'push', bundleId: 'com.a.b', payload: JSON.stringify({ x: 'y'.repeat(5000) }) })).toBeNull()
    expect(normalizeSimulatorAction({ a: 'privacy', op: 'grant', service: 'all' })).toBeNull() // grant needs an app
    expect(normalizeSimulatorAction({ a: 'privacy', op: 'grant', service: 'keychain', bundleId: 'com.a.b' })).toBeNull()
    expect(normalizeSimulatorAction({ a: 'install', path: 'relative/My.app' })).toBeNull()
    expect(normalizeSimulatorAction({ a: 'add-media', paths: [] })).toBeNull()
    expect(normalizeSimulatorAction({ a: 'erase-everything' })).toBeNull()
  })
})

describe('afterTouch', () => {
  it('shows the hint only after several unanswered touches in a row', () => {
    let s = { count: 0, hint: false }
    for (let i = 1; i < UNANSWERED_TOUCHES_FOR_HINT; i++) {
      s = afterTouch(s.count, false)
      expect(s.hint).toBe(false)
    }
    s = afterTouch(s.count, false)
    expect(s.hint).toBe(true)
  })
  it('an answered touch starts the count again and hides the hint', () => {
    const s = afterTouch(UNANSWERED_TOUCHES_FOR_HINT + 4, true)
    expect(s).toEqual({ count: 0, hint: false })
    expect(afterTouch(s.count, false).hint).toBe(false)
  })
})

describe('Android device ids', () => {
  it('tells the platforms apart and keeps an AVD name as written', () => {
    expect(simulatorPlatformOf('avd:Pixel_9')).toBe('android')
    expect(simulatorPlatformOf('0A1B2C3D-0000-4000-8000-00000000000A')).toBe('ios')
    expect(simulatorPlatformOf('avd:../x')).toBeNull()
    expect(normalizeDeviceId('avd:Pixel_9')).toBe('avd:Pixel_9')
    expect(normalizeSimulatorConfig({ udid: 'avd:Pixel_9', name: 'Pixel 9' })).toEqual({ udid: 'avd:Pixel_9', name: 'Pixel 9' })
  })

  it('validates the clipboard action', () => {
    expect(normalizeSimulatorAction({ a: 'clipboard-set', text: 'hi' })).toEqual({ a: 'clipboard-set', text: 'hi' })
    expect(normalizeSimulatorAction({ a: 'clipboard-set', text: 'a\u0000b' })).toBeNull()
    expect(normalizeSimulatorAction({ a: 'clipboard-set', text: 'x'.repeat(64_001) })).toBeNull()
  })
})

describe('touchEdge', () => {
  it('names the panel edge a touch starts on, by the measured values', () => {
    expect(touchEdge(0.5, 0.995)).toBe(3) // bottom: the home swipe
    expect(touchEdge(0.001, 0.5)).toBe(2) // left
    expect(touchEdge(0.999, 0.5)).toBe(4) // right
    expect(touchEdge(0.5, 0.001)).toBe(1) // top
    expect(touchEdge(0.5, 0.5)).toBe(0)
    expect(touchEdge(0.5, 1 - TOUCH_EDGE_MARGIN - 0.01)).toBe(0)
  })

  it('picks the nearer edge in a corner', () => {
    expect(touchEdge(0.02, 0.999)).toBe(3)
  })

  it('passes a valid edge through input validation and drops anything else', () => {
    expect(normalizeSimulatorInput({ t: 'down', x: 0.5, y: 1, edge: 3 })).toEqual({ t: 'down', x: 0.5, y: 1, edge: 3 })
    expect(normalizeSimulatorInput({ t: 'move', x: 0.5, y: 1, edge: 9 })).toEqual({ t: 'move', x: 0.5, y: 1 })
    expect(normalizeSimulatorInput({ t: 'up', x: 0.5, y: 1, edge: '3' })).toEqual({ t: 'up', x: 0.5, y: 1, edge: 3 })
  })
})

describe('inline simulator config', () => {
  it('keeps the device, and no size of its own (the run node is the size)', () => {
    expect(normalizeInlineSimulatorConfig({ udid: 'avd:Pixel_9', name: 'Pixel 9', height: 900 })).toEqual({ udid: 'avd:Pixel_9', name: 'Pixel 9' })
    expect(normalizeInlineSimulatorConfig(null)).toBeUndefined()
  })

  it('an open panel with no device is still open (an empty object), and never carries a dock link', () => {
    expect(normalizeInlineSimulatorConfig({})).toEqual({})
    expect(normalizeInlineSimulatorConfig({ dockTo: 'term-1' })).toEqual({})
  })

  it('a split-off node keeps a valid link back to its run node', () => {
    expect(normalizeSimulatorConfig({ dockTo: 'term-abc' })).toEqual({ dockTo: 'term-abc' })
    expect(normalizeSimulatorConfig({ dockTo: '../x y' })).toEqual({})
  })
})
