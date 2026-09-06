// The window forgot its size, position and maximized state on every launch. What is pinned here is
// mostly the REFUSALS, because each of them is a way the naive version of this feature makes things
// worse than the hard-coded 1400x900 it replaces: a window restored onto a monitor that is gone, a
// maximized session whose un-maximize gives back a screen-sized window, and a macOS fullscreen quit
// that erases the preference the user actually set.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  MIN_HEIGHT,
  MIN_WIDTH,
  WINDOW_STATE_FILE,
  captureWindowState,
  parseWindowState,
  readWindowState,
  resolveWindowBounds,
  trackWindowState,
  writeWindowState,
  type Rect,
  type TrackableWindow,
  type WindowState
} from './window-state'

/** A single 1920x1080 display whose work area starts below a 27px top bar. */
const ONE_SCREEN: Rect[] = [{ x: 0, y: 27, width: 1920, height: 1053 }]
/** A laptop with a second monitor to its left, the shape that produces negative coordinates. */
const TWO_SCREENS: Rect[] = [...ONE_SCREEN, { x: -2560, y: 0, width: 2560, height: 1440 }]
const DEFAULTS = { width: 1400, height: 900 }

function source(over: Partial<{ destroyed: boolean; minimized: boolean; fullScreen: boolean; maximized: boolean; bounds: Rect }> = {}) {
  return {
    isDestroyed: () => over.destroyed ?? false,
    isMinimized: () => over.minimized ?? false,
    isFullScreen: () => over.fullScreen ?? false,
    isMaximized: () => over.maximized ?? false,
    getNormalBounds: () => over.bounds ?? { x: 100, y: 200, width: 1000, height: 700 }
  }
}

describe('parseWindowState', () => {
  it('reads a full record', () => {
    expect(parseWindowState('{"x":1,"y":2,"width":800,"height":600,"maximized":true}')).toEqual({
      x: 1,
      y: 2,
      width: 800,
      height: 600,
      maximized: true
    })
  })

  it('refuses non-finite numbers rather than passing them to a BrowserWindow constructor', () => {
    // The file is hand-editable and these values reach Electron before there is a window in which
    // to report a failure, so they are re-validated here as numbers, not trusted from a type.
    expect(parseWindowState('{"width":null,"height":600}')).toBeNull()
    expect(parseWindowState('{"width":"800","height":600}')).toBeNull()
    expect(parseWindowState('{"width":0,"height":600}')).toBeNull()
    expect(parseWindowState('{"width":-10,"height":600}')).toBeNull()
    // JSON has no NaN/Infinity literal, so `typeof === 'number'` LOOKS sufficient — but an
    // overflowing exponent parses to Infinity, and `Number.isFinite` is the only thing between
    // that and the constructor. A mutation dropping it survived the first version of this suite.
    expect(parseWindowState('{"width":1e999,"height":600}')).toBeNull()
    expect(parseWindowState('{"width":800,"height":1e999}')).toBeNull()
    expect(parseWindowState('{"x":1e999,"y":0,"width":800,"height":600}')!.x).toBeUndefined()
  })

  it('refuses garbage and non-objects without throwing', () => {
    for (const raw of ['', 'not json', 'null', '[]', '42', '"x"']) {
      expect(parseWindowState(raw), raw).toBeNull()
    }
  })

  it('drops a half-known position — x without y is not a place', () => {
    const s = parseWindowState('{"x":5,"width":800,"height":600}')
    expect(s).not.toBeNull()
    expect(s!.x).toBeUndefined()
    expect(s!.y).toBeUndefined()
  })

  it('keeps a legitimate negative position (a monitor left of the primary)', () => {
    expect(parseWindowState('{"x":-2000,"y":100,"width":800,"height":600}')).toMatchObject({
      x: -2000,
      y: 100
    })
  })

  it('treats a missing or non-true `maximized` as false, never as truthy', () => {
    expect(parseWindowState('{"width":800,"height":600}')!.maximized).toBe(false)
    expect(parseWindowState('{"width":800,"height":600,"maximized":"yes"}')!.maximized).toBe(false)
  })
})

describe('resolveWindowBounds', () => {
  it('falls back to the defaults, unpositioned and unmaximized, with no saved record', () => {
    expect(resolveWindowBounds(null, ONE_SCREEN, DEFAULTS)).toEqual({
      bounds: { width: 1400, height: 900 },
      maximize: false
    })
  })

  it('restores a position that is reachable on a live display', () => {
    const saved: WindowState = { x: 200, y: 100, width: 1000, height: 700, maximized: false }
    expect(resolveWindowBounds(saved, ONE_SCREEN, DEFAULTS).bounds).toEqual({
      x: 200,
      y: 100,
      width: 1000,
      height: 700
    })
  })

  it('carries the maximized flag through', () => {
    const saved: WindowState = { width: 1000, height: 700, maximized: true }
    expect(resolveWindowBounds(saved, ONE_SCREEN, DEFAULTS).maximize).toBe(true)
  })

  it('DROPS a position on a display that is gone, and keeps the size', () => {
    // The undocked-laptop case. Restoring this would open the app off-screen: running, focusable
    // from the dock, visible nowhere, with no gesture that brings it back.
    const saved: WindowState = { x: -2000, y: 300, width: 1000, height: 700, maximized: false }
    expect(resolveWindowBounds(saved, ONE_SCREEN, DEFAULTS).bounds).toEqual({
      width: 1000,
      height: 700
    })
    // Same record, monitor still attached: the position is honoured.
    expect(resolveWindowBounds(saved, TWO_SCREENS, DEFAULTS).bounds).toMatchObject({ x: -2000 })
  })

  it('drops a position that only clips the display by a sliver', () => {
    // Reachable is not the same as "touches": a few pixels of window on screen is not a title bar
    // the user can grab.
    const saved: WindowState = { x: 1900, y: 1040, width: 1000, height: 700, maximized: false }
    expect(resolveWindowBounds(saved, ONE_SCREEN, DEFAULTS).bounds).toEqual({
      width: 1000,
      height: 700
    })
  })

  it('never clamps a dropped position into a corner — the platform places it instead', () => {
    const saved: WindowState = { x: 99999, y: 99999, width: 1000, height: 700, maximized: false }
    const { bounds } = resolveWindowBounds(saved, ONE_SCREEN, DEFAULTS)
    expect(bounds.x).toBeUndefined()
    expect(bounds.y).toBeUndefined()
  })

  it('clamps a size saved on a bigger display down to what this one can show', () => {
    const saved: WindowState = { width: 5000, height: 2800, maximized: false }
    expect(resolveWindowBounds(saved, ONE_SCREEN, DEFAULTS).bounds).toEqual({
      width: 1920,
      height: 1053
    })
  })

  it('floors a degenerate saved size', () => {
    const saved: WindowState = { width: 1, height: 1, maximized: false }
    expect(resolveWindowBounds(saved, ONE_SCREEN, DEFAULTS).bounds).toEqual({
      width: MIN_WIDTH,
      height: MIN_HEIGHT
    })
  })

  it('applies only the floor when no display information is available', () => {
    // Inventing a ceiling out of nothing would be a guess; the floor is the half that still
    // protects against a degenerate stored value.
    expect(resolveWindowBounds({ width: 5000, height: 2800, maximized: false }, [], DEFAULTS).bounds)
      .toEqual({ width: 5000, height: 2800 })
    expect(resolveWindowBounds({ width: 1, height: 1, maximized: false }, [], DEFAULTS).bounds)
      .toEqual({ width: MIN_WIDTH, height: MIN_HEIGHT })
  })

  it('checks reachability against the CLAMPED size, not the saved one', () => {
    // A huge saved size shrinks to the screen, so the question "can the user reach this window?"
    // has to be asked of the rectangle that will actually be opened. The fixture has to be able to
    // TELL THE TWO APART: at x:-1850 the saved 5000px width still crosses the whole screen, while
    // the clamped 1920px one leaves 70px showing — under the threshold. Judged on the saved size
    // this position looks fine and the window opens almost entirely off the left edge.
    const saved: WindowState = { x: -1850, y: 100, width: 5000, height: 2800, maximized: false }
    expect(resolveWindowBounds(saved, ONE_SCREEN, DEFAULTS).bounds).toEqual({
      width: 1920,
      height: 1053
    })
    // Same clamped width, moved right far enough to leave a grabbable strip: now it is kept.
    const reachable: WindowState = { ...saved, x: -1700 }
    expect(resolveWindowBounds(reachable, ONE_SCREEN, DEFAULTS).bounds).toMatchObject({ x: -1700 })
  })
})

describe('captureWindowState', () => {
  it('reads the restored bounds and the maximized flag', () => {
    expect(captureWindowState(source({ maximized: true }))).toEqual({
      x: 100,
      y: 200,
      width: 1000,
      height: 700,
      maximized: true
    })
  })

  it('uses getNormalBounds, so un-maximizing later restores the pre-maximize size', () => {
    // getBounds() on a maximized window returns the MAXIMIZED rect. Saving that would make the
    // next un-maximize hand back a screen-sized window — right-looking state, wrong behaviour,
    // and only for the users who maximize.
    const win = {
      ...source({ maximized: true, bounds: { x: 40, y: 60, width: 1024, height: 768 } }),
      getBounds: (): Rect => ({ x: 0, y: 27, width: 1920, height: 1053 })
    }
    expect(captureWindowState(win)).toMatchObject({ width: 1024, height: 768, x: 40, y: 60 })
  })

  it('refuses while minimized — the platform owns that geometry, not the user', () => {
    expect(captureWindowState(source({ minimized: true }))).toBeNull()
  })

  it('refuses while fullscreen, so a fullscreen quit cannot erase `maximized`', () => {
    // isMaximized() is false while a macOS window is fullscreen. Capturing here would record
    // maximized:false and forget exactly the preference this feature exists to remember.
    expect(captureWindowState(source({ fullScreen: true, maximized: false }))).toBeNull()
  })

  it('refuses a destroyed window', () => {
    expect(captureWindowState(source({ destroyed: true }))).toBeNull()
  })

  it('refuses a degenerate measurement instead of persisting it', () => {
    expect(captureWindowState(source({ bounds: { x: 0, y: 0, width: 0, height: 0 } }))).toBeNull()
    expect(
      captureWindowState(source({ bounds: { x: 0, y: 0, width: NaN, height: 700 } }))
    ).toBeNull()
  })

  it('keeps the size when the position is unknowable (Wayland reports no usable x/y)', () => {
    const s = captureWindowState(
      source({ bounds: { x: NaN, y: NaN, width: 1200, height: 800 }, maximized: true })
    )
    expect(s).toEqual({ width: 1200, height: 800, maximized: true })
  })

  it('rounds — a fractional device-pixel-ratio bound is not a window size', () => {
    const s = captureWindowState(source({ bounds: { x: 10.4, y: 20.6, width: 999.5, height: 700.2 } }))
    expect(s).toEqual({ x: 10, y: 21, width: 1000, height: 700, maximized: false })
  })
})

describe('read/write round trip', () => {
  let dir = ''
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nt-winstate-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('writes and reads back', () => {
    const state: WindowState = { x: 5, y: 6, width: 1200, height: 800, maximized: true }
    expect(writeWindowState(dir, state)).toBe(true)
    expect(readWindowState(dir)).toEqual(state)
  })

  it('leaves no temp litter behind', () => {
    writeWindowState(dir, { width: 800, height: 600, maximized: false })
    expect(readFileSync(join(dir, WINDOW_STATE_FILE), 'utf8')).toContain('"width":800')
    expect(readdirSync(dir)).toEqual([WINDOW_STATE_FILE])
  })

  it('reads null for a missing file rather than throwing', () => {
    expect(readWindowState(join(dir, 'nope'))).toBeNull()
  })

  it('reads null for a corrupt file, and the next write repairs it', () => {
    writeFileSync(join(dir, WINDOW_STATE_FILE), '{ this is not json')
    expect(readWindowState(dir)).toBeNull()
    expect(writeWindowState(dir, { width: 800, height: 600, maximized: false })).toBe(true)
    expect(readWindowState(dir)).toMatchObject({ width: 800 })
  })

  it('reports a failed write instead of throwing', () => {
    expect(writeWindowState(join(dir, 'no', 'such', 'dir'), { width: 1, height: 1, maximized: false })).toBe(false)
  })
})

describe('trackWindowState', () => {
  function harness(over: Parameters<typeof source>[0] = {}) {
    const listeners = new Map<string, () => void>()
    const win: TrackableWindow = {
      ...source(over),
      on: (event: string, fn: () => void) => listeners.set(event, fn)
    }
    const saved: WindowState[] = []
    // Every timer is kept, not just the latest. A harness that overwrites a single slot cannot see
    // a MISSING cancel — the stale timers are still armed in production and each one fires its own
    // save, but the fake has already forgotten them. That mutation survived the first version.
    const timers = new Map<number, () => void>()
    let next = 1
    const stop = trackWindowState(win, (s) => saved.push(s), {
      debounceMs: 400,
      setTimer: (fn) => {
        const id = next++
        timers.set(id, fn)
        return id
      },
      clearTimer: (h) => {
        timers.delete(h as number)
      }
    })
    return {
      saved,
      stop,
      fire: (e: string) => listeners.get(e)?.(),
      /** Fire every timer still armed — exactly what the event loop would do. */
      tick: () => [...timers.values()].forEach((fn) => fn()),
      pending: () => timers.size > 0,
      armed: () => timers.size,
      events: () => [...listeners.keys()]
    }
  }

  it('subscribes to every geometry event plus close', () => {
    expect(harness().events()).toEqual(['resize', 'move', 'maximize', 'unmaximize', 'close'])
  })

  it('debounces a burst of resizes into ONE save, leaving ONE timer armed', () => {
    const h = harness()
    for (let i = 0; i < 20; i++) h.fire('resize')
    expect(h.saved).toHaveLength(0)
    // The count is the real assertion: 20 armed timers would still collapse to "one save" in a
    // harness that fires only the last one, and would be 20 disk writes in production.
    expect(h.armed()).toBe(1)
    h.tick()
    expect(h.saved).toHaveLength(1)
  })

  it('a move following a resize replaces its timer rather than adding one', () => {
    const h = harness()
    h.fire('resize')
    h.fire('move')
    h.fire('maximize')
    expect(h.armed()).toBe(1)
  })

  it('saves IMMEDIATELY on close — an awaited save would race the process exit', () => {
    const h = harness({ maximized: true })
    h.fire('close')
    expect(h.saved).toEqual([{ x: 100, y: 200, width: 1000, height: 700, maximized: true }])
  })

  it('close cancels a pending debounce rather than saving twice', () => {
    const h = harness()
    h.fire('resize')
    h.fire('close')
    expect(h.saved).toHaveLength(1)
    expect(h.pending()).toBe(false)
  })

  it('records the maximize gesture itself', () => {
    const h = harness({ maximized: true })
    h.fire('maximize')
    h.tick()
    expect(h.saved[0].maximized).toBe(true)
  })

  it('writes nothing when the window refuses to answer (minimized / fullscreen)', () => {
    for (const over of [{ minimized: true }, { fullScreen: true }]) {
      const h = harness(over)
      h.fire('resize')
      h.tick()
      h.fire('close')
      expect(h.saved).toEqual([])
    }
  })

  it('the disposer cancels a pending save', () => {
    const h = harness()
    h.fire('resize')
    expect(h.pending()).toBe(true)
    h.stop()
    expect(h.pending()).toBe(false)
    expect(h.saved).toEqual([])
  })
})
