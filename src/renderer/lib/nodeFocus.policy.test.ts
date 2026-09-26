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
    // Normal and restored nodes centre in the whole pane, and are kept clear of the PINNED
    // sessions sidebar (inset 322 here) when that is possible (#854). Vertically: centred.
    for (const candidate of [node, restored]) {
      const rect = nodeFitRect(candidate, [candidate])!
      expect(rect).toEqual(originalRect)
      const focus = viewportForNodeFocus(candidate, rect, box, zoom)!
      expect((rect.y + rect.height / 2) * focus.zoom + focus.y).toBeCloseTo(400)
      const left = rect.x * focus.zoom + focus.x
      const right = (rect.x + rect.width) * focus.zoom + focus.x
      if (zoom === 2) {
        // Wider than the free area at the user's zoom: stays centred (a shift only swaps edges).
        expect(focus.zoom).toBe(2)
        expect((rect.x + rect.width / 2) * focus.zoom + focus.x).toBeCloseTo(600)
      } else if (zoom === 0.7345) {
        // Already clear of the panel when centred: untouched.
        expect(left).toBeGreaterThan(322)
        expect((rect.x + rect.width / 2) * focus.zoom + focus.x).toBeCloseTo(600)
      } else {
        // Our zoom: the node ends up entirely beside the pinned panel.
        expect(left).toBeGreaterThanOrEqual(322 - 1e-8)
        expect(right).toBeLessThanOrEqual(1200 + 1e-8)
      }
      if (zoom !== undefined) expect(focus.zoom).toBe(zoom)
    }

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

describe('ordinary focus without a pinned panel (#854)', () => {
  it.each([undefined, 0.7345, 2])('centres in the whole pane (keepZoom=%s)', (zoom) => {
    // Only the controls cluster and the dock: nothing pinned at the sides.
    for (const [className, left, top, right, bottom] of [
      ['controls-cluster', 950, 50, 1286, 84],
      ['dock', 500, 770, 900, 822]
    ] as const) {
      const el = document.createElement('div')
      el.className = className
      el.getBoundingClientRect = () =>
        ({ left, top, right, bottom, width: right - left, height: bottom - top }) as DOMRect
      document.body.append(el)
    }
    const node = ordinary()
    const rect = nodeFitRect(node, [node])!
    const focus = viewportForNodeFocus(node, rect, box, zoom)!
    expect((rect.x + rect.width / 2) * focus.zoom + focus.x).toBeCloseTo(600)
    expect((rect.y + rect.height / 2) * focus.zoom + focus.y).toBeCloseTo(400)
  })
})
