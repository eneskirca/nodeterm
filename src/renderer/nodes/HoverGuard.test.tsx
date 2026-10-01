// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { drag } from 'd3-drag'
import { select } from 'd3-selection'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GUARD_CLICK_SLOP, HoverGuard } from './HoverGuard'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/**
 * The hover guard sits inside a React Flow node wrapper that carries a REAL d3-drag instance: a
 * terminal node has no `dragHandle` and the guard is not `.nodrag`, so React Flow's drag filter
 * (@xyflow/system `XYDrag`: `!event.button && !hasSelector(target, '.nodrag')`) accepts a left press
 * on it. d3-drag's `mousedowned` then calls `stopImmediatePropagation` on the WRAPPER, so the
 * mousedown never bubbles to React's root listener, and it consumes the `mouseup` with a
 * `stopImmediatePropagation` in a WINDOW capture listener, so React never sees that either. A guard
 * built on `onMouseDown`/`onMouseUp` therefore never ran for a left click — issue #87's
 * click-to-focus was dead, masked by the hover dwell (and with click to focus, #757, there is no
 * dwell to mask it).
 *
 * These tests mount the guard under the real d3-drag with React Flow's filter, and dispatch the
 * sequence a browser produces, so the event path is the production one rather than a simulation of
 * the handler.
 */
describe('HoverGuard under React Flow’s d3-drag (#87, #757)', () => {
  let container: HTMLDivElement
  let root: Root
  let wrapper: HTMLDivElement

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  /** Render `children` inside a wrapper with React Flow's drag behaviour on it. */
  function mount(children: React.ReactNode): void {
    act(() => {
      root.render(
        <div
          className="react-flow__node"
          ref={(el) => {
            if (el) wrapper = el
          }}
        >
          {children}
        </div>
      )
    })
    const filter = (event: MouseEvent) =>
      !event.button && !(event.target as Element).closest('.nodrag')
    select(wrapper).call(drag<HTMLDivElement, unknown>().filter(filter))
  }

  /** What a browser dispatches for a press and release of the given button at two points. */
  function press(target: Element, from: [number, number], to: [number, number], button = 0): void {
    const init = (type: string, [x, y]: [number, number]) => {
      const ev = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button })
      // d3-drag hangs its move/up listeners off `event.view`. jsdom's constructor refuses the test
      // global as a `view` under this setup, so it is attached after construction instead.
      Object.defineProperty(ev, 'view', { value: window })
      return ev
    }
    act(() => {
      target.dispatchEvent(init('pointerdown', from))
      target.dispatchEvent(init('mousedown', from))
      if (from[0] !== to[0] || from[1] !== to[1]) {
        target.dispatchEvent(init('pointermove', to))
        target.dispatchEvent(init('mousemove', to))
      }
      target.dispatchEvent(init('pointerup', to))
      target.dispatchEvent(init('mouseup', to))
      target.dispatchEvent(init('click', to))
    })
  }

  it('is the premise: React never sees a left mousedown/mouseup inside a draggable node', () => {
    const onMouseDown = vi.fn()
    const onMouseUp = vi.fn()
    mount(<div className="probe" onMouseDown={onMouseDown} onMouseUp={onMouseUp} />)
    press(wrapper.querySelector('.probe')!, [10, 10], [10, 10])
    expect(onMouseDown).not.toHaveBeenCalled()
    expect(onMouseUp).not.toHaveBeenCalled()
  })

  it('a click on the guard reaches onClick', () => {
    const onPress = vi.fn()
    const onClick = vi.fn()
    const onDragEnd = vi.fn()
    mount(<HoverGuard onPress={onPress} onClick={onClick} onDragEnd={onDragEnd} />)
    press(wrapper.querySelector('.term-hover-guard')!, [10, 10], [10, 10])
    expect(onPress).toHaveBeenCalledTimes(1)
    expect(onClick).toHaveBeenCalledTimes(1)
    expect(onDragEnd).not.toHaveBeenCalled()
  })

  it('a few pixels of hand travel is still a click', () => {
    const onClick = vi.fn()
    const onDragEnd = vi.fn()
    mount(<HoverGuard onPress={vi.fn()} onClick={onClick} onDragEnd={onDragEnd} />)
    press(wrapper.querySelector('.term-hover-guard')!, [10, 10], [10 + GUARD_CLICK_SLOP, 10])
    expect(onClick).toHaveBeenCalledTimes(1)
    expect(onDragEnd).not.toHaveBeenCalled()
  })

  it('a drag that moved the node is not a click', () => {
    const onClick = vi.fn()
    const onDragEnd = vi.fn()
    mount(<HoverGuard onPress={vi.fn()} onClick={onClick} onDragEnd={onDragEnd} />)
    press(wrapper.querySelector('.term-hover-guard')!, [10, 10], [40, 40])
    expect(onClick).not.toHaveBeenCalled()
    expect(onDragEnd).toHaveBeenCalledTimes(1)
  })

  it('a right click (the context menu) does not take the keyboard', () => {
    const onClick = vi.fn()
    const onPress = vi.fn()
    mount(<HoverGuard onPress={onPress} onClick={onClick} onDragEnd={vi.fn()} />)
    press(wrapper.querySelector('.term-hover-guard')!, [10, 10], [10, 10], 2)
    expect(onPress).not.toHaveBeenCalled()
    expect(onClick).not.toHaveBeenCalled()
  })

  it('is the guard TerminalNode actually renders (no mouse-event guard left behind)', () => {
    // Source pin: TerminalNode is a 6000-line component that cannot be mounted here, and a bare
    // `<div className="term-hover-guard" onMouseDown=…>` reintroduced there would compile, pass every
    // other test, and silently bring the dead click back.
    const src = readFileSync(resolve(__dirname, 'TerminalNode.tsx'), 'utf8').replace(/\r\n/g, '\n')
    expect(src).toContain('<HoverGuard onPress={onGuardPress} onClick={onGuardClick} onDragEnd={onBodyEnter} />')
    expect(src).not.toMatch(/className="term-hover-guard"/)
  })
})
