// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { maximizeNodeToRect, restoreMaximizedNode, type CanvasNode } from '../state/workspace'
import { measureMaximizeInsets } from './maximizeInsets'
import { maximizeTargetRect } from './nodeMaximize'
import { nodeFitRect, viewportForNodeFocus } from './nodeFocus'

const box = { left: 100, right: 1300, top: 36, bottom: 836, width: 1200, height: 800 }
function addChrome() {
  for (const [className, left, top, right, bottom] of [
    ['sessions-sidebar--pinned', 114, 90, 422, 780],
    ['controls-cluster', 950, 50, 1286, 84],
    ['dock', 500, 770, 900, 822]
  ] as const) {
    const el = document.createElement('div')
    el.className = className
    el.getBoundingClientRect = () =>
      ({ left, top, right, bottom, width: right - left, height: bottom - top }) as DOMRect
    document.body.append(el)
  }
}
const ordinary = (): CanvasNode => ({
  id: 'term', type: 'terminal', position: { x: 40, y: 60 }, width: 660, height: 400,
  data: { title: 'Terminal', color: '#fff', group: null }
}) as CanvasNode

afterEach(() => {
  vi.restoreAllMocks()
  document.body.replaceChildren()
})

describe('Canvas focus policy (#743, #711)', () => {
  it.each([undefined, 0.7345, 2])('reserves chrome only while maximized (keepZoom=%s)', (zoom) => {
    addChrome()
    const node = ordinary()
    const originalRect = nodeFitRect(node, [node])!
    const camera = { x: -123, y: 87, zoom: zoom ?? 1 }
    const target = maximizeTargetRect(camera, box.width, box.height, 24, measureMaximizeInsets(box))!
    const maximized = maximizeNodeToRect([node], node.id, target)
    const restored = restoreMaximizedNode(maximized, node.id)[0]
    const readChrome = vi.spyOn(document, 'querySelectorAll')

    // Normal and restored nodes centre in the whole pane, regardless of visible chrome.
    for (const candidate of [node, restored]) {
      const rect = nodeFitRect(candidate, [candidate])!
      expect(rect).toEqual(originalRect)
      const focus = viewportForNodeFocus(candidate, rect, box, zoom)!
      expect((rect.x + rect.width / 2) * focus.zoom + focus.x).toBeCloseTo(600)
      expect((rect.y + rect.height / 2) * focus.zoom + focus.y).toBeCloseTo(400)
      if (zoom !== undefined) expect(focus.zoom).toBe(zoom)
    }
    expect(readChrome).not.toHaveBeenCalled()

    const rect = nodeFitRect(maximized[0], maximized)!
    const focus = viewportForNodeFocus(maximized[0], rect, box, zoom)!
    // Measured reservations: left=322, top=32, bottom=50. Test actual screen placement.
    expect((rect.x + rect.width / 2) * focus.zoom + focus.x).toBeCloseTo(761)
    expect((rect.y + rect.height / 2) * focus.zoom + focus.y).toBeCloseTo(391)
    expect(rect.y * focus.zoom + focus.y + box.top).toBeGreaterThanOrEqual(92 - 1e-8)
    expect((rect.y + rect.height) * focus.zoom + focus.y + box.top).toBeLessThanOrEqual(762 + 1e-8)
    if (zoom !== undefined) {
      expect(focus.zoom).toBe(zoom)
      expect(focus.x).toBeCloseTo(camera.x)
      expect(focus.y).toBeCloseTo(camera.y)
    }
  })
})
