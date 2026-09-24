// @vitest-environment jsdom
import { act, useLayoutEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { applyNodeChanges, MiniMap, ReactFlowProvider, useStoreApi, type Node } from '@xyflow/react'
import { afterEach, expect, it, vi } from 'vitest'
import { VisibleMiniMap } from './VisibleMiniMap'
import { mergeWithKeepAlive, retireIntoPool } from '../lib/webviewKeepAlive'
import type { CanvasNode } from '../state/workspace'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root
let host: HTMLDivElement
let store: ReturnType<typeof useStoreApi>
function Capture() {
  const api = useStoreApi()
  useLayoutEffect(() => { store = api }, [api])
  return null
}
function mount() {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  act(() => root.render(
    <ReactFlowProvider>
      <Capture />
      <div id="raw"><MiniMap /></div>
      <div id="filtered"><VisibleMiniMap pannable zoomable onClick={mapClicked} onNodeClick={clicked} nodeClassName={(n) => `node-${n.id}`} /></div>
    </ReactFlowProvider>
  ))
  act(() => store.setState({ width: 800, height: 600, transform: [-2000, -2000, 1] }))
}
const clicked = vi.fn()
const mapClicked = vi.fn()
const node = (id: string, type = 'terminal', x = 2100): CanvasNode => ({
  id, type, position: { x, y: 2100 }, width: 200, height: 100,
  data: { title: id, color: '#123456', group: null, ...(type === 'browser' ? { url: 'https://example.test' } : {}) }
}) as CanvasNode
const setNodes = (nodes: Node[]) => act(() => store.getState().setNodes(nodes))
const rects = (which = 'filtered') => host.querySelectorAll(`#${which} .react-flow__minimap-node`)
const bounds = (which = 'filtered') => host.querySelector(`#${which} svg`)!.getAttribute('viewBox')
afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  clicked.mockClear()
  mapClicked.mockClear()
  vi.useRealTimers()
})

it('excludes keep-alive ghosts from both rectangles and bounds without hiding the real guest', () => {
  mount()
  const browser = node('browser', 'browser')
  const terminal = node('terminal')
  setNodes([terminal])
  const expectedBounds = bounds()
  const pool = retireIntoPool([], 'other', [browser], 1)
  setNodes(mergeWithKeepAlive([terminal], [], pool, 'active'))
  // The unmodified upstream minimap reproduces the bug with our real keep-alive output.
  expect(rects('raw')).toHaveLength(2)
  expect(bounds('raw')).not.toBe(expectedBounds)
  expect(rects()).toHaveLength(1)
  expect(bounds()).toBe(expectedBounds)
  const guest = store.getState().nodeLookup.get('browser')!
  expect(guest.hidden).not.toBe(true)
  expect(guest.style?.display).toBe('none')
  expect(guest.data.ghost).toBe(true)

  // Same id returns live and then becomes a ghost again; map subscribes without remounting.
  setNodes(mergeWithKeepAlive([browser], [], pool, 'other'))
  expect(rects()).toHaveLength(1)
  expect(rects()[0].classList.contains('node-browser')).toBe(true)
  act(() => rects()[0].dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 2 })))
  expect(clicked.mock.calls[0][1]).toBe(browser)
  setNodes(mergeWithKeepAlive([], [], pool, 'active'))
  expect(rects()).toHaveLength(0)
  setNodes([])
  expect(bounds()).toBe(bounds('raw')) // ghosts alone cannot pull an empty map toward origin
})

it('tracks remove changes, direct replacements, hidden nodes, group geometry and camera updates', () => {
  mount()
  const parent = node('group', 'group', 3000)
  const child = { ...node('child'), parentId: 'group', position: { x: 50, y: 30 } }
  const hidden = { ...node('hidden', 'terminal', -9000), hidden: true }
  setNodes([parent, child, hidden])
  expect(rects()).toHaveLength(2)
  expect(host.querySelector('.node-child')!.getAttribute('x')).toBe('3050')
  expect(bounds()).toBe(bounds('raw'))
  setNodes(applyNodeChanges([{ type: 'remove', id: 'child' }], store.getState().nodes))
  expect(rects()).toHaveLength(1)
  expect(host.querySelector('.node-child')).toBeNull()
  // deleteNodes, peer removes and server reconciliation replace the controlled array directly.
  setNodes([node('replacement')])
  expect(rects()).toHaveLength(1)
  expect(host.querySelector('.node-group')).toBeNull()
  act(() => store.setState({ transform: [-5000, -4000, 2], width: 1000, height: 500 }))
  expect(bounds()).toBe(bounds('raw'))
  setNodes([])
  expect(rects()).toHaveLength(0)
  expect(bounds()).toBe(bounds('raw'))
})

it('routes wheel zoom, drag and map clicks through the original camera', () => {
  vi.useFakeTimers()
  mount()
  setNodes([node('terminal')])
  const scaleTo = vi.fn()
  const setViewportConstrained = vi.fn()
  const panZoom = { scaleTo, setViewportConstrained } as unknown as NonNullable<ReturnType<typeof store.getState>['panZoom']>
  act(() => store.setState({ panZoom, width: 1000 }))
  const svg = host.querySelector('#filtered svg')!
  // jsdom has no SVG layout; d3 reads these real-browser animated length properties.
  Object.defineProperties(svg, {
    width: { value: { baseVal: { value: 200 } } },
    height: { value: { baseVal: { value: 150 } } }
  })
  act(() => svg.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true })))
  expect(scaleTo).toHaveBeenCalledWith(Math.pow(2, 0.2))
  act(() => vi.advanceTimersByTime(200))
  const mouse = (type: string, clientX = 0, clientY = 0) => {
    const event = new MouseEvent(type, { clientX, clientY, bubbles: true })
    Object.defineProperty(event, 'view', { value: window })
    return event
  }
  act(() => svg.dispatchEvent(mouse('mousedown', 10, 10)))
  act(() => window.dispatchEvent(mouse('mousemove', 30, 20)))
  expect(setViewportConstrained).toHaveBeenCalledWith(
    { x: -2100, y: -2050, zoom: 1 }, [[0, 0], [1000, 600]], store.getState().translateExtent
  )
  act(() => window.dispatchEvent(mouse('mouseup')))
  act(() => vi.runAllTimers())
  act(() => svg.dispatchEvent(new MouseEvent('click', { clientX: 50, clientY: 60, bubbles: true })))
  expect(mapClicked).toHaveBeenCalledTimes(1)
})
