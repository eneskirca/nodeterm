// @vitest-environment jsdom
//
// jsdom is here for ONE reason: `hasTextFocus` is the guard that decides whether Shift+1 zooms the
// canvas or types a `!`, and the only honest way to test it is against real elements.
import { afterEach, describe, expect, it } from 'vitest'
import { projectJumpDigit } from './projectJump'
import {
  hasTextFocus,
  zoomShortcutAction,
  zoomShortcutAllowed,
  zoomShortcutChord,
  type ZoomShortcutEvent
} from './zoomShortcut'

function ev(over: Partial<ZoomShortcutEvent> = {}): ZoomShortcutEvent {
  return {
    type: 'keydown',
    code: 'Digit0',
    metaKey: true,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    repeat: false,
    ...over
  }
}

const ZOOM_100 = ev()
const FIT_ALL = ev({ code: 'Digit1', metaKey: false, shiftKey: true })
const FREE = { boardOpen: false, textFocus: false }

describe('zoomShortcutChord', () => {
  it('reads ⌘/Ctrl+0 as "back to 100%", off the physical key code', () => {
    expect(zoomShortcutChord(ZOOM_100)).toBe('zoom-100')
    expect(zoomShortcutChord(ev({ metaKey: false, ctrlKey: true }))).toBe('zoom-100')
  })

  it('reads Shift+1 as "fit everything"', () => {
    expect(zoomShortcutChord(FIT_ALL)).toBe('fit-all')
  })

  it('is not the chord without its exact modifiers', () => {
    expect(zoomShortcutChord(ev({ metaKey: false }))).toBeNull() // bare 0
    expect(zoomShortcutChord(ev({ shiftKey: true }))).toBeNull() // ⌘⇧0
    expect(zoomShortcutChord(ev({ altKey: true }))).toBeNull() // ⌥⌘0 / AltGr
    expect(zoomShortcutChord(ev({ code: 'Digit1', shiftKey: true, altKey: true }))).toBeNull()
    expect(zoomShortcutChord(ev({ code: 'Digit1', metaKey: false, shiftKey: false }))).toBeNull()
    expect(zoomShortcutChord(ev({ code: 'Digit1', shiftKey: true }))).toBeNull() // ⌘⇧1
    expect(zoomShortcutChord(ev({ code: 'Digit2', metaKey: false, shiftKey: true }))).toBeNull()
  })

  it('only fires on a FRESH keydown', () => {
    expect(zoomShortcutChord(ev({ type: 'keyup' }))).toBeNull()
    // Both actions animate (200ms setViewport / 300ms fitView). Holding the chord must not
    // restart the tween tens of times a second — that reads as a stutter, not a zoom.
    expect(zoomShortcutChord(ev({ repeat: true }))).toBeNull()
    expect(zoomShortcutChord({ ...FIT_ALL, repeat: true })).toBeNull()
  })

  // REGRESSION GUARD: the ⌘/Ctrl+1-9 project jump lives one `else if` away in the same handler.
  // Neither matcher may ever claim a key the other one wants.
  it('never claims a key the project-jump chord claims, and vice versa', () => {
    for (let d = 0; d <= 9; d++) {
      const plain = ev({ code: `Digit${d}`, shiftKey: false })
      const shifted = ev({ code: `Digit${d}`, metaKey: false, shiftKey: true })
      for (const e of [plain, shifted]) {
        expect(zoomShortcutChord(e) !== null && projectJumpDigit(e) !== null).toBe(false)
      }
    }
    expect(projectJumpDigit(ZOOM_100)).toBeNull()
    expect(projectJumpDigit(FIT_ALL)).toBeNull()
  })
})

describe('zoomShortcutAllowed', () => {
  it('refuses while the kanban board is up', () => {
    // The board is an OPAQUE overlay over a still-mounted canvas: the move would be invisible,
    // yet `onMove` → `markDirty` still persists the viewport and casts it to the team session.
    expect(zoomShortcutAllowed({ boardOpen: true, textFocus: false })).toBe(false)
  })

  it('refuses while the user is typing', () => {
    expect(zoomShortcutAllowed({ boardOpen: false, textFocus: true })).toBe(false)
  })

  it('allows on a plain canvas', () => {
    expect(zoomShortcutAllowed(FREE)).toBe(true)
  })
})

describe('zoomShortcutAction', () => {
  it('resolves each chord when nothing refuses it', () => {
    expect(zoomShortcutAction(ZOOM_100, FREE)).toBe('zoom-100')
    expect(zoomShortcutAction(FIT_ALL, FREE)).toBe('fit-all')
  })

  it('is null for BOTH chords under every refusal', () => {
    for (const ctx of [
      { boardOpen: true, textFocus: false },
      { boardOpen: false, textFocus: true },
      { boardOpen: true, textFocus: true }
    ]) {
      expect(zoomShortcutAction(ZOOM_100, ctx)).toBeNull()
      expect(zoomShortcutAction(FIT_ALL, ctx)).toBeNull()
    }
  })

  it('is null for a non-chord even on a free canvas', () => {
    expect(zoomShortcutAction(ev({ code: 'KeyA' }), FREE)).toBeNull()
  })
})

describe('hasTextFocus', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  function focused(html: string, selector: string): Element {
    document.body.innerHTML = html
    return document.querySelector(selector)!
  }

  it('is true in the plain text inputs', () => {
    expect(hasTextFocus(focused('<input />', 'input'))).toBe(true)
    expect(hasTextFocus(focused('<textarea></textarea>', 'textarea'))).toBe(true)
    expect(
      hasTextFocus(focused('<div contenteditable="true">x</div>', 'div[contenteditable]'))
    ).toBe(true)
  })

  it('is true anywhere inside Monaco or a terminal', () => {
    // Shift+1 is a PRINTABLE chord: inside a terminal it is the `!` key, and a shell history
    // expansion or a `!` in a commit message must not double as a camera move.
    expect(
      hasTextFocus(focused('<div class="xterm"><div class="row"></div></div>', '.row'))
    ).toBe(true)
    expect(
      hasTextFocus(
        focused('<div class="monaco-editor"><span class="view-line"></span></div>', '.view-line')
      )
    ).toBe(true)
    // xterm's real focus target is its helper <textarea>; caught by the tag check too.
    expect(
      hasTextFocus(focused('<div class="xterm"><textarea></textarea></div>', 'textarea'))
    ).toBe(true)
  })

  it('is false on the canvas itself, and with nothing focused', () => {
    expect(hasTextFocus(focused('<div class="react-flow__pane"></div>', '.react-flow__pane'))).toBe(
      false
    )
    expect(hasTextFocus(focused('<div contenteditable="false"></div>', 'div'))).toBe(false)
    expect(hasTextFocus(null)).toBe(false)
  })
})
