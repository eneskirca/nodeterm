// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installLockedMiddleGuard, installModifierPan, isModifierPanStart, type PanViewport } from './modifierPan'

const mods = { metaKey: false, ctrlKey: false, altKey: false, shiftKey: false }

describe('isModifierPanStart', () => {
  it('is the middle button with ⌘ on macOS', () => {
    expect(isModifierPanStart({ ...mods, button: 1, metaKey: true }, true)).toBe(true)
    expect(isModifierPanStart({ ...mods, button: 1, ctrlKey: true }, true)).toBe(false)
  })

  it('is the middle button with Ctrl elsewhere', () => {
    expect(isModifierPanStart({ ...mods, button: 1, ctrlKey: true }, false)).toBe(true)
    expect(isModifierPanStart({ ...mods, button: 1, metaKey: true }, false)).toBe(false)
  })

  it('is not a plain middle-drag, another button, or a chord with extra modifiers', () => {
    expect(isModifierPanStart({ ...mods, button: 1 }, true)).toBe(false)
    expect(isModifierPanStart({ ...mods, button: 0, metaKey: true }, true)).toBe(false)
    expect(isModifierPanStart({ ...mods, button: 1, metaKey: true, shiftKey: true }, true)).toBe(false)
    expect(isModifierPanStart({ ...mods, button: 1, metaKey: true, altKey: true }, true)).toBe(false)
    expect(isModifierPanStart({ ...mods, button: 1, metaKey: true, ctrlKey: true }, true)).toBe(false)
  })
})

/** jsdom has no PointerEvent constructor in every version; a MouseEvent carrying a pointerId is
 *  what the handler reads. */
function pointer(type: string, init: MouseEventInit & { pointerId?: number }): MouseEvent {
  const e = new MouseEvent(type, { bubbles: true, cancelable: true, ...init })
  Object.defineProperty(e, 'pointerId', { value: init.pointerId ?? 1 })
  return e
}

describe('installModifierPan', () => {
  let wrap: HTMLDivElement
  let child: HTMLDivElement
  let viewport: PanViewport
  let uninstall: () => void
  const setViewport = vi.fn((v: PanViewport) => {
    viewport = v
  })

  beforeEach(() => {
    wrap = document.createElement('div')
    child = document.createElement('div') // stands in for a node / terminal under the pointer
    wrap.appendChild(child)
    document.body.appendChild(wrap)
    viewport = { x: 10, y: 20, zoom: 0.5 }
    setViewport.mockClear()
    uninstall = installModifierPan(wrap, { isMac: true, getViewport: () => viewport, setViewport })
  })

  afterEach(() => {
    uninstall()
    document.body.innerHTML = ''
  })

  it('pans the camera by the pointer movement, keeping the zoom', () => {
    child.dispatchEvent(pointer('pointerdown', { button: 1, metaKey: true, clientX: 100, clientY: 100 }))

    child.dispatchEvent(pointer('pointermove', { clientX: 130, clientY: 90 }))
    child.dispatchEvent(pointer('pointermove', { clientX: 140, clientY: 95 }))

    expect(viewport).toEqual({ x: 50, y: 15, zoom: 0.5 })
  })

  it('keeps the gesture from the node underneath (cancelled and stopped in the capture phase)', () => {
    const below = vi.fn()
    child.addEventListener('pointerdown', below)
    const down = pointer('pointerdown', { button: 1, metaKey: true })

    child.dispatchEvent(down)

    expect(below).not.toHaveBeenCalled()
    expect(down.defaultPrevented).toBe(true)
  })

  it('stops panning at pointerup and swallows the auxclick that follows', () => {
    child.dispatchEvent(pointer('pointerdown', { button: 1, metaKey: true, clientX: 0, clientY: 0 }))
    child.dispatchEvent(pointer('pointerup', { button: 1, clientX: 0, clientY: 0 }))
    const aux = new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 })
    child.dispatchEvent(aux)

    child.dispatchEvent(pointer('pointermove', { clientX: 50, clientY: 50 }))

    expect(aux.defaultPrevented).toBe(true)
    expect(setViewport).not.toHaveBeenCalled()
  })

  it('leaves a plain middle-drag to React Flow (and the lock)', () => {
    const down = pointer('pointerdown', { button: 1, clientX: 0, clientY: 0 })
    child.dispatchEvent(down)
    child.dispatchEvent(pointer('pointermove', { clientX: 50, clientY: 50 }))
    const aux = new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 })
    child.dispatchEvent(aux)

    expect(down.defaultPrevented).toBe(false)
    expect(aux.defaultPrevented).toBe(false)
    expect(setViewport).not.toHaveBeenCalled()
  })

  it('stops listening once uninstalled', () => {
    uninstall()

    child.dispatchEvent(pointer('pointerdown', { button: 1, metaKey: true, clientX: 0, clientY: 0 }))
    child.dispatchEvent(pointer('pointermove', { clientX: 50, clientY: 50 }))

    expect(setViewport).not.toHaveBeenCalled()
    uninstall = () => {}
  })
})

describe('installLockedMiddleGuard', () => {
  /** zoomPane > viewport > node > header: React Flow's pan listens on the zoom pane. */
  function tree() {
    const zoomPane = document.createElement('div')
    const viewport = document.createElement('div')
    const node = document.createElement('div')
    zoomPane.appendChild(viewport)
    viewport.appendChild(node)
    document.body.appendChild(zoomPane)
    return { zoomPane, viewport, node }
  }
  const press = (button: number) => new MouseEvent('mousedown', { bubbles: true, cancelable: true, button })

  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('keeps a middle press on a node from reaching React Flow, after the node has seen it', () => {
    const { zoomPane, viewport, node } = tree()
    const reactFlow = vi.fn()
    const nodeSaw = vi.fn()
    zoomPane.addEventListener('mousedown', reactFlow)
    node.addEventListener('mousedown', nodeSaw)
    installLockedMiddleGuard(viewport)

    node.dispatchEvent(press(1))

    expect(nodeSaw).toHaveBeenCalledTimes(1)
    expect(reactFlow).not.toHaveBeenCalled()
  })

  it('leaves the left and right buttons alone (node drag, context menu)', () => {
    const { zoomPane, viewport, node } = tree()
    const reactFlow = vi.fn()
    zoomPane.addEventListener('mousedown', reactFlow)
    installLockedMiddleGuard(viewport)

    node.dispatchEvent(press(0))
    node.dispatchEvent(press(2))

    expect(reactFlow).toHaveBeenCalledTimes(2)
  })

  it('stops guarding once uninstalled (the canvas was unlocked)', () => {
    const { zoomPane, viewport, node } = tree()
    const reactFlow = vi.fn()
    zoomPane.addEventListener('mousedown', reactFlow)
    const uninstall = installLockedMiddleGuard(viewport)

    uninstall()
    node.dispatchEvent(press(1))

    expect(reactFlow).toHaveBeenCalledTimes(1)
  })
})
