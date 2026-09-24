import { describe, expect, it, vi } from 'vitest'
import {
  applyWebviewZoom,
  nextWebviewZoomLevel,
  WEBVIEW_ZOOM_MAX_LEVEL,
  WEBVIEW_ZOOM_MIN_LEVEL,
  webviewZoomShortcut,
  type WebviewZoomShortcutInput
} from './webview-zoom'

const input = (over: Partial<WebviewZoomShortcutInput> = {}): WebviewZoomShortcutInput => ({
  type: 'keyDown',
  code: 'Equal',
  meta: false,
  control: true,
  shift: false,
  alt: false,
  ...over
})

describe('webview page zoom', () => {
  it('steps by one Electron zoom level and clamps both ends', () => {
    expect(nextWebviewZoomLevel(0, 'in')).toBe(1)
    expect(nextWebviewZoomLevel(0, 'out')).toBe(-1)
    expect(nextWebviewZoomLevel(5, 'reset')).toBe(0)
    expect(nextWebviewZoomLevel(WEBVIEW_ZOOM_MAX_LEVEL, 'in')).toBe(WEBVIEW_ZOOM_MAX_LEVEL)
    expect(nextWebviewZoomLevel(WEBVIEW_ZOOM_MIN_LEVEL, 'out')).toBe(WEBVIEW_ZOOM_MIN_LEVEL)
  })

  it('falls back to 100 percent when the current level is invalid', () => {
    expect(nextWebviewZoomLevel(Number.NaN, 'in')).toBe(1)
  })

  it('writes only when the resulting level changes', () => {
    const setZoomLevel = vi.fn()
    expect(applyWebviewZoom({ getZoomLevel: () => 0, setZoomLevel }, 'in')).toBe(1)
    expect(setZoomLevel).toHaveBeenCalledWith(1)

    setZoomLevel.mockClear()
    applyWebviewZoom(
      { getZoomLevel: () => WEBVIEW_ZOOM_MAX_LEVEL, setZoomLevel },
      'in'
    )
    expect(setZoomLevel).not.toHaveBeenCalled()
  })

  it('maps the platform primary modifier plus +/-/0 and refuses unrelated chords', () => {
    expect(webviewZoomShortcut(input(), false)).toBe('in')
    expect(webviewZoomShortcut(input({ code: 'Minus' }), false)).toBe('out')
    expect(webviewZoomShortcut(input({ code: 'Digit0' }), false)).toBe('reset')
    expect(webviewZoomShortcut(input({ code: 'NumpadAdd' }), false)).toBe('in')
    expect(webviewZoomShortcut(input({ shift: true }), false)).toBe('in')
    expect(webviewZoomShortcut(input({ control: false, meta: true }), true)).toBe('in')
    expect(webviewZoomShortcut(input({ code: 'KeyA' }), false)).toBeNull()
    expect(webviewZoomShortcut(input({ alt: true }), false)).toBeNull()
    expect(webviewZoomShortcut(input({ type: 'keyUp' }), false)).toBeNull()
    expect(webviewZoomShortcut(input({ code: 'Digit0', shift: true }), false)).toBeNull()
  })

  it('does not treat the non-primary modifier as page zoom on either platform', () => {
    expect(webviewZoomShortcut(input({ control: false, meta: true }), false)).toBeNull()
    expect(webviewZoomShortcut(input({ control: true, meta: false }), true)).toBeNull()
    expect(webviewZoomShortcut(input({ control: true, meta: true }), true)).toBeNull()
  })
})
