import { useEffect, useRef, useState, type RefObject, type SyntheticEvent } from 'react'
import { createPortal } from 'react-dom'
import { CANVAS_COVERED_ATTR, coveredByBoard } from '../lib/canvasCovered'

/**
 * "Add to chat" beside a text selection in a ⌘M chat thread (`.term-chat__msgs`). Offered only for
 * a non-empty selection whose anchor AND focus are inside `containerRef` — a selection that spans
 * two panels, or leaves the thread, gets no button. A click hands `selection.toString()` to
 * `onAdd` (which runs `addQuoteToNode` for `targetNodeId`) and clears the selection.
 *
 * Portaled to <body> and placed `position: fixed` from the selection's own client rect: the panel
 * sits inside React Flow's scaled viewport, where a fixed element would be positioned against the
 * transformed ancestor and scaled with it. Client rects are window coordinates, so nothing is
 * divided by the canvas zoom. A scroll of the thread, of a scroller inside it (a wide code block) or
 * of anything holding it, a wheel (it may pan the canvas) and a window resize would leave the button
 * behind, so each hides it (`selectionchange` brings it back). Other scrollers do not: a streaming
 * terminal elsewhere scrolls its viewport all the time.
 *
 * A press anywhere but on the button, and focus moving anywhere outside the thread, hide it too.
 * Both are needed because the selection can outlive the click that leaves it: xterm's mousedown
 * calls `preventDefault()`, so clicking into another node's terminal keeps the document selection
 * and fires no `selectionchange`. Window capture, so a handler that stops the press cannot hide it
 * from us. A press inside the thread hides it as well; the selection it starts brings it back.
 *
 * Only for a thread the person can see: not one `checkVisibility()` says is not rendered, and not
 * one on a canvas a board covers (`coveredByBoard`) — the canvas stays mounted under the board, a
 * selection made before the board opened outlives it, and the button is portaled ABOVE the board.
 * Opening a board fires no selection event, so the covered attribute is watched too.
 *
 * Escape belongs to the button while it shows AND the keyboard is near this thread (`escapeInScope`:
 * inside the chat panel, on the button, on <body>, or on an element that holds the thread — a press
 * on the thread's text focuses the nearest focusable ancestor, React Flow's node wrapper on the
 * canvas). Then it hides the button and goes no further — not to the card modal (which would
 * close), not to the composer (whose Escape interrupts a running turn). Focus anywhere else is
 * another surface's keyboard (another node's terminal, where Escape interrupts THAT agent): the key
 * is left alone there. Window capture is the earliest any listener can run; the card modal listens
 * there too, so it also steps aside while `chatQuoteButtonShowing()` (their order is registration
 * order).
 */

/** Space between the end of the selection and the button. */
const GAP_PX = 6
/** Keeps the button this far inside the window. */
const EDGE_PX = 8
/** The button's size, for keeping it inside the window (one line of 11px text, see styles.css). */
const BUTTON_W = 96
const BUTTON_H = 24

export interface ChatQuoteButtonProps {
  containerRef: RefObject<HTMLElement | null>
  /** The node the quote goes to (recorded on the button; the caller's `onAdd` acts on it). */
  targetNodeId: string
  onAdd(text: string): void
}

/** The button's class — and how a listener that must yield to it finds out it shows. */
const BUTTON_CLASS = 'chat-quote-btn'

/** Is an "Add to chat" button showing anywhere? It is in the DOM exactly while it shows. */
export function chatQuoteButtonShowing(): boolean {
  return typeof document !== 'undefined' && document.querySelector(`.${BUTTON_CLASS}`) !== null
}

/** Can the person see `container`? (See the component's docblock.) */
function shown(container: HTMLElement): boolean {
  if (typeof container.checkVisibility === 'function' && !container.checkVisibility()) return false
  return !coveredByBoard(container)
}

/**
 * The document selection, when it is a non-empty one wholly inside `container`. Every panel runs this
 * on every `selectionchange` in the window (a terminal's included), so the cheap checks go first and
 * the visibility check, which needs the element's computed style, runs only for a selection here.
 */
function selectionInside(container: HTMLElement | null): Selection | null {
  if (!container) return null
  const sel = document.getSelection()
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null
  if (!sel.anchorNode || !sel.focusNode) return null
  if (!container.contains(sel.anchorNode) || !container.contains(sel.focusNode)) return null
  // A whitespace-only selection would quote nothing; text selected inside a form field (a plan's
  // "Revise…" box) is not part of the document selection's text at all.
  if (sel.toString().trim() === '') return null
  if (!shown(container)) return null
  return sel
}

/** The last non-empty client rect of the selection — where it ends on screen. */
function endRect(sel: Selection): { left: number; top: number; right: number; bottom: number } | null {
  const range = sel.getRangeAt(sel.rangeCount - 1)
  if (typeof range.getClientRects === 'function') {
    const rects = range.getClientRects()
    for (let i = rects.length - 1; i >= 0; i--) {
      const r = rects[i]
      if (r.width > 0 || r.height > 0) return r
    }
  }
  if (typeof range.getBoundingClientRect === 'function') {
    const r = range.getBoundingClientRect()
    if (r.width > 0 || r.height > 0) return r
  }
  return null
}

/**
 * Is the keyboard where an Escape belongs to this thread's button? (See the component's docblock.)
 * Nothing focused, the button itself, anything inside the chat panel that holds `container`, or an
 * element that holds the thread. Another node's terminal is none of these.
 */
function escapeInScope(container: HTMLElement | null, button: HTMLElement | null): boolean {
  const active = document.activeElement
  if (active === null || active === document.body || active === document.documentElement) return true
  if (button?.contains(active)) return true
  if (!container) return false
  const panel = container.closest('.term-chat') ?? container
  return panel.contains(active) || active.contains(container)
}

/** Where the button goes: just under the selection's end, pushed back inside the window. */
function placeFor(sel: Selection, container: HTMLElement): { left: number; top: number } {
  const rect = endRect(sel) ?? container.getBoundingClientRect()
  const maxLeft = Math.max(EDGE_PX, window.innerWidth - BUTTON_W - EDGE_PX)
  const left = Math.min(Math.max(EDGE_PX, rect.right), maxLeft)
  const below = rect.bottom + GAP_PX
  const top = below + BUTTON_H + EDGE_PX <= window.innerHeight ? below : Math.max(EDGE_PX, rect.top - GAP_PX - BUTTON_H)
  return { left, top }
}

export function ChatQuoteButton({ containerRef, targetNodeId, onAdd }: ChatQuoteButtonProps) {
  const [at, setAt] = useState<{ left: number; top: number } | null>(null)
  // For the Escape listener, registered once: does the button show right now?
  const showingRef = useRef(false)
  showingRef.current = at !== null
  const buttonRef = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    const update = (): void => {
      const container = containerRef.current
      const sel = selectionInside(container)
      const next = sel && container ? placeFor(sel, container) : null
      setAt((prev) => (prev && next && prev.left === next.left && prev.top === next.top ? prev : next))
    }
    const hide = (): void => setAt(null)
    const onButton = (t: EventTarget | null): boolean => t instanceof Node && buttonRef.current?.contains(t) === true
    const onKey = (e: KeyboardEvent): void => {
      // An IME composition's Escape cancels the composition; it is not ours.
      if (e.key !== 'Escape' || e.isComposing || !showingRef.current) return
      if (!escapeInScope(containerRef.current, buttonRef.current)) return
      e.preventDefault()
      e.stopImmediatePropagation()
      showingRef.current = false
      hide()
    }
    // Capture: `scroll` does not bubble. Only a scroller that holds the thread, or one inside it,
    // moves the selection.
    const onScroll = (e: Event): void => {
      const t = e.target
      const container = containerRef.current
      if (t === document) hide()
      else if (t instanceof Node && container !== null && (t.contains(container) || container.contains(t))) hide()
    }
    // A press anywhere but on the button (the button's own press keeps the selection: its mousedown
    // is prevented below), and focus moving out of the thread.
    const onPointerDown = (e: PointerEvent): void => {
      if (!onButton(e.target)) hide()
    }
    const onFocusIn = (e: FocusEvent): void => {
      const t = e.target
      if (onButton(t)) return
      const container = containerRef.current
      if (t instanceof Node && container !== null && container.contains(t)) return
      hide()
    }
    // A board opening over the canvas (or closing) changes what is visible without any event here.
    const covered = new MutationObserver(update)
    covered.observe(document.documentElement, { attributes: true, attributeFilter: [CANVAS_COVERED_ATTR] })
    document.addEventListener('selectionchange', update)
    document.addEventListener('scroll', onScroll, true)
    window.addEventListener('wheel', hide, { capture: true, passive: true })
    window.addEventListener('resize', hide)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('focusin', onFocusIn, true)
    return () => {
      covered.disconnect()
      document.removeEventListener('selectionchange', update)
      document.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('wheel', hide, { capture: true })
      window.removeEventListener('resize', hide)
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('focusin', onFocusIn, true)
    }
  }, [containerRef])

  if (!at) return null
  // React events bubble along the React tree, portal or not: keep a press here from reaching the
  // node and card handlers above the panel (node selection, the card modal's scrim).
  const stop = (e: SyntheticEvent): void => e.stopPropagation()
  return createPortal(
    <button
      ref={buttonRef}
      type="button"
      className={BUTTON_CLASS}
      style={{ left: at.left, top: at.top }}
      data-quote-target={targetNodeId}
      title="Add the selected text to the message as a quote"
      onPointerDown={stop}
      // Keep the selection: a press on a button would otherwise clear it before the click.
      onMouseDown={(e) => {
        e.preventDefault()
        e.stopPropagation()
      }}
      onClick={(e) => {
        e.stopPropagation()
        const sel = selectionInside(containerRef.current)
        if (sel) {
          onAdd(sel.toString())
          sel.removeAllRanges()
        }
        setAt(null)
      }}
    >
      Add to chat
    </button>,
    document.body
  )
}
