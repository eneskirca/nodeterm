/**
 * ⌘+middle-drag (Ctrl+middle-drag off-mac) pans the canvas — ALWAYS: whether or not the canvas
 * lock is on, and wherever the pointer is, a terminal included (issue #1130).
 *
 * The lock exists so the canvas stops sliding when a scroll or drag meant for a terminal lands on
 * it instead; it is often left on for a whole session. Unlocking to move the camera and locking
 * again is three clicks for one intended pan. A middle-drag with the primary modifier held is never
 * an accident and has no other meaning on the canvas, so it pans past the lock. Plain middle-drag
 * is unchanged: it pans when unlocked and does nothing when locked.
 *
 * React Flow's `panOnDrag` chooses mouse BUTTONS only (no modifier), and it is off entirely while
 * locked, so this is the canvas's own pointer handler — the same shape as the wheel-zoom handler.
 * It listens in the CAPTURE phase on the flow wrapper and cancels the pointerdown, which (by the
 * Pointer Events spec) suppresses the compatibility mouse events: d3-zoom, d3-drag and xterm all
 * listen to `mousedown`, so none of them sees the gesture — no node drag, no tmux mouse event.
 * The `auxclick` that follows is cancelled too, so Linux's middle-click paste and a browser's
 * middle-click handling stay out of it.
 */

export interface PanViewport {
  x: number
  y: number
  zoom: number
}

/** Whether this pointerdown starts a modifier pan: the middle button with exactly the primary
 *  modifier (⌘ on macOS, Ctrl elsewhere). Shift / Alt / the other modifier keep their meanings. */
export function isModifierPanStart(
  e: Pick<PointerEvent, 'button' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>,
  isMac: boolean
): boolean {
  if (e.button !== 1 || e.altKey || e.shiftKey) return false
  return isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey
}

export interface ModifierPanDeps {
  isMac: boolean
  getViewport: () => PanViewport
  setViewport: (v: PanViewport) => void
}

/** Install the gesture on the flow wrapper. Returns the uninstaller. */
export function installModifierPan(wrap: HTMLElement, deps: ModifierPanDeps): () => void {
  let active: { pointerId: number; lastX: number; lastY: number } | null = null
  // The auxclick that ends a modifier pan arrives after pointerup; it is swallowed once.
  let swallowAuxclick = false

  const end = (e: PointerEvent): void => {
    if (active === null || e.pointerId !== active.pointerId) return
    active = null
    swallowAuxclick = true
    wrap.releasePointerCapture?.(e.pointerId)
    e.preventDefault()
    e.stopPropagation()
  }

  const onDown = (e: PointerEvent): void => {
    // A pan released outside the window may never get its auxclick; never carry that over.
    swallowAuxclick = false
    if (!isModifierPanStart(e, deps.isMac)) return
    e.preventDefault()
    e.stopPropagation()
    active = { pointerId: e.pointerId, lastX: e.clientX, lastY: e.clientY }
    // Keep receiving moves when the pointer leaves the wrapper (or the window) mid-drag.
    wrap.setPointerCapture?.(e.pointerId)
  }

  const onMove = (e: PointerEvent): void => {
    if (active === null || e.pointerId !== active.pointerId) return
    e.preventDefault()
    e.stopPropagation()
    const dx = e.clientX - active.lastX
    const dy = e.clientY - active.lastY
    active.lastX = e.clientX
    active.lastY = e.clientY
    if (dx === 0 && dy === 0) return
    const v = deps.getViewport()
    deps.setViewport({ x: v.x + dx, y: v.y + dy, zoom: v.zoom })
  }

  const onAuxclick = (e: MouseEvent): void => {
    if (!swallowAuxclick || e.button !== 1) return
    swallowAuxclick = false
    e.preventDefault()
    e.stopPropagation()
  }

  wrap.addEventListener('pointerdown', onDown, { capture: true })
  wrap.addEventListener('pointermove', onMove, { capture: true })
  wrap.addEventListener('pointerup', end, { capture: true })
  wrap.addEventListener('pointercancel', end, { capture: true })
  wrap.addEventListener('auxclick', onAuxclick, { capture: true })
  return () => {
    wrap.removeEventListener('pointerdown', onDown, { capture: true })
    wrap.removeEventListener('pointermove', onMove, { capture: true })
    wrap.removeEventListener('pointerup', end, { capture: true })
    wrap.removeEventListener('pointercancel', end, { capture: true })
    wrap.removeEventListener('auxclick', onAuxclick, { capture: true })
  }
}

/**
 * While the canvas is locked, keep a plain middle press inside the viewport (on a node, an edge or
 * a selection box) from reaching React Flow's pan.
 *
 * The lock works by turning React Flow's `panOnDrag` off, but React Flow's zoom filter
 * (`@xyflow/system` `createFilter`) accepts a middle-button `mousedown` on a node / edge /
 * selection BEFORE it looks at `panOnDrag`, so a middle-drag that started on one panned straight
 * past the lock (#1130). Whether it did depended on what was under the pointer: a node header and
 * a terminal's hover guard leaked, the xterm itself did not (the #84 middle-click guard stops the
 * press there — unless middle-click paste is on), and empty canvas never did (the pane is outside
 * the viewport and React Flow honours `panOnDrag` there).
 *
 * The listener is on the VIEWPORT in the BUBBLE phase: everything inside it — the terminal, tmux's
 * middle click, the middle-click paste setting — has already seen the press; only React Flow's
 * listener, on an ancestor, is cut off. ⌘/Ctrl+middle never gets here (installModifierPan cancels
 * that pointerdown, so no `mousedown` follows). Install only while locked; returns the uninstaller.
 */
export function installLockedMiddleGuard(viewport: HTMLElement): () => void {
  const onMouseDown = (e: MouseEvent): void => {
    if (e.button === 1) e.stopPropagation()
  }
  viewport.addEventListener('mousedown', onMouseDown)
  return () => viewport.removeEventListener('mousedown', onMouseDown)
}
