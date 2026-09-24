// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { measureMaximizeInsets } from './maximizeInsets'
import { maximizeTargetRect } from './nodeMaximize'
import { viewportForRect } from './nodeFocus'

const wrap = { left: 100, right: 1300, top: 36, bottom: 836 }
function chrome(className: string, left: number, top: number, right: number, bottom: number) {
  const el = document.createElement('div')
  el.className = className
  el.getBoundingClientRect = () =>
    ({ left, top, right, bottom, width: right - left, height: bottom - top }) as DOMRect
  document.body.append(el)
  return el
}
afterEach(() => document.body.replaceChildren())

describe('maximize persistent chrome geometry (#711)', () => {
  it.each([0.7345, 1, 1.1704, 2])('clears controls and dock at zoom %s and refocuses without drift', (zoom) => {
    chrome('sessions-sidebar--pinned', 114, 90, 422, 780)
    chrome('controls-cluster', 950, 50, 1286, 84)
    chrome('dock', 500, 770, 900, 822)
    const insets = measureMaximizeInsets(wrap)
    const viewport = { x: -123, y: 87, zoom }
    const rect = maximizeTargetRect(viewport, 1200, 800, 24, insets)!
    expect(rect.x * zoom + viewport.x + wrap.left).toBeCloseTo(446)
    expect(rect.y * zoom + viewport.y + wrap.top).toBeCloseTo(92)
    expect((rect.y + rect.height) * zoom + viewport.y + wrap.top).toBeCloseTo(762)
    const focused = viewportForRect(rect, 1200, 800, zoom, insets)!
    expect(focused.x).toBeCloseTo(viewport.x)
    expect(focused.y).toBeCloseTo(viewport.y)
    expect(focused.zoom).toBe(zoom)
    const fit = viewportForRect(rect, 1200, 800, undefined, insets)!
    expect(rect.y * fit.zoom + fit.y + wrap.top).toBeGreaterThanOrEqual(84)
    expect((rect.y + rect.height) * fit.zoom + fit.y + wrap.top).toBeLessThanOrEqual(770)
  })

  it('does not spend a top band for controls already behind the pinned right band', () => {
    chrome('drawer--pinned', 920, 90, 1286, 780)
    chrome('controls-cluster', 950, 50, 1286, 84)
    expect(measureMaximizeInsets(wrap)).toEqual({ left: 0, right: 380, top: 0, bottom: 0 })
  })

  it('ignores hover panels, zero-size/hidden chrome, outside chrome and transient menus', () => {
    chrome('sessions-sidebar', 114, 90, 422, 780)
    chrome('controls-cluster', 950, 50, 950, 84)
    chrome('dock', 500, 850, 900, 890)
    chrome('dock-menu', 500, 300, 900, 822)
    expect(measureMaximizeInsets(wrap)).toEqual({ left: 0, right: 0, top: 0, bottom: 0 })
  })

  it('uses current scaled chrome dimensions and releases the space when it disappears', () => {
    const dock = chrome('dock', 300, 730, 1000, 822)
    expect(measureMaximizeInsets(wrap).bottom).toBe(90)
    dock.remove()
    expect(measureMaximizeInsets(wrap).bottom).toBe(0)
  })

  it('refuses an unusably short viewport instead of inventing available space', () => {
    chrome('controls-cluster', 110, 40, 390, 100)
    chrome('dock', 110, 140, 390, 200)
    const small = { left: 100, right: 400, top: 36, bottom: 210 }
    expect(maximizeTargetRect({ x: 0, y: 0, zoom: 1 }, 300, 174, 24, measureMaximizeInsets(small))).toBeNull()
  })
})
