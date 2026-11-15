// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import {
  FONT_ZOOM_NODE_ATTR,
  TERMINAL_FONT_SIZE_MAX,
  TERMINAL_FONT_SIZE_MIN,
  TERMINAL_FONT_ZOOM_EVENT,
  effectiveTerminalFontSize,
  fontZoomNoticeText,
  fontZoomTargetNodeId,
  forwardedResetMatches,
  leavesSharedGlyphAtlas,
  nextTerminalFontSizeOverride,
  normalizeTerminalFontSize,
  patchStoredFontSize,
  patchProjectFontSize,
  requestTerminalFontZoom,
  terminalFontZoomAction,
  terminalFontZoomChord,
  withTerminalFontSize,
  type TerminalFontZoomEvent
} from './terminal-font-zoom'

const key = (over: Partial<TerminalFontZoomEvent>): TerminalFontZoomEvent => ({
  type: 'keydown',
  key: '',
  code: '',
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...over
})

describe('terminalFontZoomChord (issue #915)', () => {
  it('maps ⌘= / ⌘+ / ⌘- / ⌘0 on macOS', () => {
    expect(terminalFontZoomChord(key({ metaKey: true, key: '=', code: 'Equal' }), true)).toBe('increase')
    // US layout: ⌘+ is ⌘⇧= and reports key '+'.
    expect(
      terminalFontZoomChord(key({ metaKey: true, shiftKey: true, key: '+', code: 'Equal' }), true)
    ).toBe('increase')
    expect(terminalFontZoomChord(key({ metaKey: true, key: '-', code: 'Minus' }), true)).toBe('decrease')
    expect(terminalFontZoomChord(key({ metaKey: true, key: '0', code: 'Digit0' }), true)).toBe('reset')
  })

  it('maps the numpad keys', () => {
    expect(terminalFontZoomChord(key({ metaKey: true, key: '+', code: 'NumpadAdd' }), true)).toBe('increase')
    expect(terminalFontZoomChord(key({ metaKey: true, key: '-', code: 'NumpadSubtract' }), true)).toBe(
      'decrease'
    )
    expect(terminalFontZoomChord(key({ metaKey: true, key: '0', code: 'Numpad0' }), true)).toBe('reset')
  })

  it('matches + and - on the CHARACTER, so a German "+" key (BracketRight) still zooms', () => {
    expect(terminalFontZoomChord(key({ ctrlKey: true, key: '+', code: 'BracketRight' }), false)).toBe(
      'increase'
    )
    expect(terminalFontZoomChord(key({ ctrlKey: true, key: '-', code: 'Slash' }), false)).toBe('decrease')
  })

  it('uses Ctrl off-mac', () => {
    expect(terminalFontZoomChord(key({ ctrlKey: true, key: '=', code: 'Equal' }), false)).toBe('increase')
    expect(terminalFontZoomChord(key({ ctrlKey: true, key: '-', code: 'Minus' }), false)).toBe('decrease')
    expect(terminalFontZoomChord(key({ ctrlKey: true, key: '0', code: 'Digit0' }), false)).toBe('reset')
  })

  it('leaves Ctrl+-/= to the shell on macOS (readline undo), and ⌘ alone off-mac', () => {
    expect(terminalFontZoomChord(key({ ctrlKey: true, key: '-', code: 'Minus' }), true)).toBeNull()
    expect(terminalFontZoomChord(key({ ctrlKey: true, key: '=', code: 'Equal' }), true)).toBeNull()
    expect(terminalFontZoomChord(key({ metaKey: true, key: '-', code: 'Minus' }), false)).toBeNull()
    // Both primaries held is a different chord.
    expect(
      terminalFontZoomChord(key({ metaKey: true, ctrlKey: true, key: '-', code: 'Minus' }), true)
    ).toBeNull()
  })

  it('refuses bare keys, Alt/AltGr chords, ⌘⇧0 and keyup', () => {
    expect(terminalFontZoomChord(key({ key: '-', code: 'Minus' }), true)).toBeNull()
    expect(terminalFontZoomChord(key({ key: '=', code: 'Equal' }), false)).toBeNull()
    expect(terminalFontZoomChord(key({ metaKey: true, altKey: true, key: '-', code: 'Minus' }), true)).toBeNull()
    // AltGr reports as ctrl+alt off-mac and must keep typing its character.
    expect(terminalFontZoomChord(key({ ctrlKey: true, altKey: true, key: '+', code: 'Equal' }), false)).toBeNull()
    expect(
      terminalFontZoomChord(key({ metaKey: true, shiftKey: true, key: ')', code: 'Digit0' }), true)
    ).toBeNull()
    expect(terminalFontZoomChord(key({ type: 'keyup', metaKey: true, key: '-', code: 'Minus' }), true)).toBeNull()
  })

  it('accepts auto-repeat: holding ⌘+ keeps growing (no animation to stutter)', () => {
    expect(
      terminalFontZoomChord(key({ metaKey: true, key: '=', code: 'Equal', repeat: true }), true)
    ).toBe('increase')
  })
})

describe('terminalFontZoomAction', () => {
  const plus = key({ metaKey: true, key: '=', code: 'Equal' })
  it('is inert while the setting is off (the default — today’s behaviour)', () => {
    expect(terminalFontZoomAction(plus, { enabled: false, isMac: true })).toBeNull()
  })
  it('answers the chord when the setting is on', () => {
    expect(terminalFontZoomAction(plus, { enabled: true, isMac: true })).toBe('increase')
    expect(terminalFontZoomAction(key({ key: 'a', code: 'KeyA' }), { enabled: true, isMac: true })).toBeNull()
  })
})

describe('normalizeTerminalFontSize / effectiveTerminalFontSize', () => {
  it('accepts finite in-range numbers only (project.json is hand-editable)', () => {
    expect(normalizeTerminalFontSize(14)).toBe(14)
    expect(normalizeTerminalFontSize(TERMINAL_FONT_SIZE_MIN)).toBe(TERMINAL_FONT_SIZE_MIN)
    expect(normalizeTerminalFontSize(TERMINAL_FONT_SIZE_MAX)).toBe(TERMINAL_FONT_SIZE_MAX)
    expect(normalizeTerminalFontSize(TERMINAL_FONT_SIZE_MIN - 1)).toBeUndefined()
    expect(normalizeTerminalFontSize(TERMINAL_FONT_SIZE_MAX + 1)).toBeUndefined()
    expect(normalizeTerminalFontSize('14')).toBeUndefined()
    expect(normalizeTerminalFontSize(NaN)).toBeUndefined()
    expect(normalizeTerminalFontSize(Infinity)).toBeUndefined()
    expect(normalizeTerminalFontSize(undefined)).toBeUndefined()
    expect(normalizeTerminalFontSize(null)).toBeUndefined()
  })

  it('is override ?? global', () => {
    expect(effectiveTerminalFontSize(13, undefined)).toBe(13)
    expect(effectiveTerminalFontSize(13, 16)).toBe(16)
    expect(effectiveTerminalFontSize(13, 'garbage')).toBe(13)
    expect(effectiveTerminalFontSize(13, 99)).toBe(13)
  })
})

describe('nextTerminalFontSizeOverride', () => {
  it('steps by one from the effective size', () => {
    expect(nextTerminalFontSizeOverride('increase', undefined, 13)).toBe(14)
    expect(nextTerminalFontSizeOverride('decrease', undefined, 13)).toBe(12)
    expect(nextTerminalFontSizeOverride('increase', 16, 13)).toBe(17)
    expect(nextTerminalFontSizeOverride('decrease', 16, 13)).toBe(15)
  })

  it('clears the override when stepping lands back on the global size', () => {
    expect(nextTerminalFontSizeOverride('decrease', 14, 13)).toBeUndefined()
    expect(nextTerminalFontSizeOverride('increase', 12, 13)).toBeUndefined()
  })

  it('reset always clears the override', () => {
    expect(nextTerminalFontSizeOverride('reset', 20, 13)).toBeUndefined()
    expect(nextTerminalFontSizeOverride('reset', undefined, 13)).toBeUndefined()
  })

  it('is a no-op at the Settings bounds (same 8–28 range as the global field)', () => {
    expect(nextTerminalFontSizeOverride('increase', TERMINAL_FONT_SIZE_MAX, 13)).toBe(TERMINAL_FONT_SIZE_MAX)
    expect(nextTerminalFontSizeOverride('decrease', TERMINAL_FONT_SIZE_MIN, 13)).toBe(TERMINAL_FONT_SIZE_MIN)
    // Global itself at the bound, no override: nothing to store.
    expect(nextTerminalFontSizeOverride('increase', undefined, TERMINAL_FONT_SIZE_MAX)).toBeUndefined()
  })

  it('does not shrink a hand-edited out-of-range global on ⌘+', () => {
    expect(nextTerminalFontSizeOverride('increase', undefined, 40)).toBeUndefined()
    expect(nextTerminalFontSizeOverride('decrease', undefined, 40)).toBe(TERMINAL_FONT_SIZE_MAX)
  })

  it('ignores a garbage stored override and steps from the global', () => {
    expect(nextTerminalFontSizeOverride('increase', 'x', 13)).toBe(14)
  })
})

describe('withTerminalFontSize', () => {
  const visual = { fontSize: 13, fontFamily: 'Menlo' }
  it('returns the SAME object when there is no effective override (memo identity)', () => {
    expect(withTerminalFontSize(visual, undefined)).toBe(visual)
    expect(withTerminalFontSize(visual, 13)).toBe(visual)
    expect(withTerminalFontSize(visual, 'bad')).toBe(visual)
  })
  it('replaces only fontSize', () => {
    expect(withTerminalFontSize(visual, 17)).toEqual({ fontSize: 17, fontFamily: 'Menlo' })
    expect(visual.fontSize).toBe(13)
  })
})

describe('fontZoomTargetNodeId', () => {
  it('finds the terminal the focused element sits in', () => {
    const host = document.createElement('div')
    host.setAttribute(FONT_ZOOM_NODE_ATTR, 'node-1')
    const ta = document.createElement('textarea')
    host.appendChild(ta)
    document.body.appendChild(host)
    expect(fontZoomTargetNodeId(ta)).toBe('node-1')
    host.remove()
  })
  it('is null outside a terminal and for null', () => {
    const input = document.createElement('input')
    document.body.appendChild(input)
    expect(fontZoomTargetNodeId(input)).toBeNull()
    expect(fontZoomTargetNodeId(null)).toBeNull()
    input.remove()
  })
})

describe('requestTerminalFontZoom', () => {
  it('dispatches the one event Canvas applies', () => {
    const seen = vi.fn()
    const onEvt = (e: Event): void => seen((e as CustomEvent).detail)
    window.addEventListener(TERMINAL_FONT_ZOOM_EVENT, onEvt)
    requestTerminalFontZoom('n1', 'decrease')
    window.removeEventListener(TERMINAL_FONT_ZOOM_EVENT, onEvt)
    expect(seen).toHaveBeenCalledWith({ nodeId: 'n1', action: 'decrease' })
  })
})

describe('forwardedResetMatches (review of #915: desktop ⌘0 arrives without an event)', () => {
  it('accepts exactly the platform primary', () => {
    expect(forwardedResetMatches({ meta: true, control: false }, true)).toBe(true)
    expect(forwardedResetMatches({ meta: false, control: true }, false)).toBe(true)
  })
  it('refuses mac Ctrl+0, off-mac ⌘0, both held, and a signal with no modifiers', () => {
    expect(forwardedResetMatches({ meta: false, control: true }, true)).toBe(false)
    expect(forwardedResetMatches({ meta: true, control: false }, false)).toBe(false)
    expect(forwardedResetMatches({ meta: true, control: true }, true)).toBe(false)
    expect(forwardedResetMatches({ meta: true, control: true }, false)).toBe(false)
    expect(forwardedResetMatches(undefined, true)).toBe(false)
  })
})

describe('leavesSharedGlyphAtlas (review of #915: the shared atlas is one global font)', () => {
  it('is true only while the effective size differs from the global one', () => {
    expect(leavesSharedGlyphAtlas(13, 13)).toBe(false)
    expect(leavesSharedGlyphAtlas(15, 13)).toBe(true)
    expect(leavesSharedGlyphAtlas(12, 13)).toBe(true)
  })
})

describe('keypad Insert stays a copy chord (review round 2 of #915)', () => {
  it('Ctrl+keypad-0 with Num Lock OFF (key Insert) is not a reset', () => {
    expect(terminalFontZoomChord(key({ ctrlKey: true, key: 'Insert', code: 'Numpad0' }), false)).toBeNull()
    expect(terminalFontZoomChord(key({ metaKey: true, key: 'Insert', code: 'Numpad0' }), true)).toBeNull()
  })
  it('Ctrl+keypad-0 with Num Lock ON (key 0) still resets', () => {
    expect(terminalFontZoomChord(key({ ctrlKey: true, key: '0', code: 'Numpad0' }), false)).toBe('reset')
  })
  it('the digit-row 0 resets on its physical key whatever key it reports (AZERTY)', () => {
    expect(terminalFontZoomChord(key({ ctrlKey: true, key: 'à', code: 'Digit0' }), false)).toBe('reset')
  })
})

describe('patchStoredFontSize (review round 3: Omni Kanban reads the projects store)', () => {
  const nodes = [
    { id: 'a', terminalFontSize: 15 },
    { id: 'b' }
  ]
  it('sets and clears one node, leaving the rest untouched', () => {
    expect(patchStoredFontSize(nodes, 'b', 17)).toEqual([{ id: 'a', terminalFontSize: 15 }, { id: 'b', terminalFontSize: 17 }])
    expect(patchStoredFontSize(nodes, 'a', undefined)).toEqual([{ id: 'a', terminalFontSize: undefined }, { id: 'b' }])
    expect(nodes[1]).toEqual({ id: 'b' })
  })
  it('returns the SAME array when nothing changes (no store churn)', () => {
    expect(patchStoredFontSize(nodes, 'a', 15)).toBe(nodes)
    expect(patchStoredFontSize(nodes, 'missing', 20)).toBe(nodes)
  })
})

describe('patchProjectFontSize (the store-level patch the Omni mirror applies)', () => {
  const projects = [
    { id: 'p1', nodes: [{ id: 'a', terminalFontSize: 15 }] },
    { id: 'p2', nodes: [{ id: 'a' }] }
  ]
  it('patches only the named project, reusing every other project object', () => {
    const out = patchProjectFontSize(projects, 'p1', 'a', 16)
    expect(out).not.toBe(projects)
    expect(out[0].nodes).toEqual([{ id: 'a', terminalFontSize: 16 }])
    expect(out[1]).toBe(projects[1])
  })
  it('returns the SAME projects array for a no-op step, so the store does not notify', () => {
    expect(patchProjectFontSize(projects, 'p1', 'a', 15)).toBe(projects)
    expect(patchProjectFontSize(projects, 'p1', 'missing', 20)).toBe(projects)
    expect(patchProjectFontSize(projects, 'nope', 'a', 20)).toBe(projects)
  })
})

describe('fontZoomNoticeText', () => {
  it('names the new size on a step', () => {
    expect(fontZoomNoticeText('increase', undefined, 14, 13)).toBe('Terminal font size 14')
    expect(fontZoomNoticeText('decrease', 14, undefined, 13)).toBe('Terminal font size 13')
  })
  it('says so when the clamp refuses a step, instead of staying silent', () => {
    expect(fontZoomNoticeText('increase', TERMINAL_FONT_SIZE_MAX, TERMINAL_FONT_SIZE_MAX, 13)).toBe(
      `Terminal font size ${TERMINAL_FONT_SIZE_MAX} (maximum)`
    )
    expect(fontZoomNoticeText('decrease', TERMINAL_FONT_SIZE_MIN, TERMINAL_FONT_SIZE_MIN, 13)).toBe(
      `Terminal font size ${TERMINAL_FONT_SIZE_MIN} (minimum)`
    )
  })
  it('reports a reset to the default, and says nothing for a reset that changes nothing', () => {
    expect(fontZoomNoticeText('reset', 20, undefined, 13)).toBe('Terminal font size reset to default (13)')
    expect(fontZoomNoticeText('reset', undefined, undefined, 13)).toBeNull()
  })
})
