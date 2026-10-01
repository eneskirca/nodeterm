import { describe, expect, it } from 'vitest'
import { shouldReleasePaneFocus } from './paneFocus'

const el = (tagName: string, contentEditable = false): Element =>
  ({ tagName, isContentEditable: contentEditable }) as unknown as Element

/**
 * Issue #86: a click on empty canvas left a sticky note's textarea focused, so everything typed
 * afterwards went into the note — noticed as spaces (a Figma space-to-pan reflex) landing in a note
 * the user had not touched, but it applies to every key, and it also kept the canvas shortcuts
 * suppressed the whole time.
 */
describe('shouldReleasePaneFocus', () => {
  it('releases a text-entry surface — the one that swallows typing', () => {
    expect(shouldReleasePaneFocus(el('TEXTAREA'))).toBe(true)
    expect(shouldReleasePaneFocus(el('INPUT'))).toBe(true)
    expect(shouldReleasePaneFocus(el('DIV', true))).toBe(true)
  })

  it('releases a Monaco editor too — its input is an EditContext div, not a textarea (#930)', () => {
    const monacoInput = {
      tagName: 'DIV',
      isContentEditable: false,
      editContext: {}
    } as unknown as Element
    expect(shouldReleasePaneFocus(monacoInput)).toBe(true)
  })

  it("releases a focused terminal's xterm textarea, which click to focus relies on (#757)", () => {
    // With focus-follows-pointer off, a terminal keeps the keyboard until the user clicks
    // elsewhere; a click on the empty canvas is one of those "elsewhere"s, and xterm's input is a
    // hidden <textarea class="xterm-helper-textarea">. If this ever stopped answering true for it,
    // the canvas could no longer take the keyboard back from a terminal in that mode.
    const xtermInput = { tagName: 'TEXTAREA', isContentEditable: false, className: 'xterm-helper-textarea' }
    expect(shouldReleasePaneFocus(xtermInput as unknown as Element)).toBe(true)
  })

  it('leaves anything else alone', () => {
    // Blurring a focused button or node div would fight the browser's own focus handling for no
    // gain: neither of them eats a keystroke.
    expect(shouldReleasePaneFocus(el('BUTTON'))).toBe(false)
    expect(shouldReleasePaneFocus(el('DIV'))).toBe(false)
    expect(shouldReleasePaneFocus(el('BODY'))).toBe(false)
  })

  it('answers false when nothing is focused, so the common click costs nothing', () => {
    expect(shouldReleasePaneFocus(null)).toBe(false)
  })
})
