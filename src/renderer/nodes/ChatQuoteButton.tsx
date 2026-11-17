import { useEffect, useState, type RefObject, type SyntheticEvent } from 'react'
import { createPortal } from 'react-dom'

/**
 * "Add to chat" beside a text selection in a ⌘M chat thread (`.term-chat__msgs`). Offered only for
 * a non-empty selection whose anchor AND focus are inside `containerRef` — a selection that spans
 * two panels, or leaves the thread, gets no button. A click hands `selection.toString()` to
 * `onAdd` (which runs `addQuoteToNode` for `targetNodeId`) and clears the selection.
 *
 * Portaled to <body> and placed `position: fixed` from the selection's own client rect: the panel
 * sits inside React Flow's scaled viewport, where a fixed element would be positioned against the
 * transformed ancestor and scaled with it. Client rects are window coordinates, so nothing is
 * divided by the canvas zoom. A scroll of the thread (or of anything holding it), a wheel (it may
 * pan the canvas) and a window resize would leave the button behind, so each hides it
 * (`selectionchange` brings it back), as does Escape. Other scrollers do not: a streaming terminal
 * elsewhere scrolls its viewport all the time.
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

/** The document selection, when it is a non-empty one wholly inside `container`. */
function selectionInside(container: HTMLElement | null): Selection | null {
  if (!container) return null
  const sel = document.getSelection()
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null
  if (!sel.anchorNode || !sel.focusNode) return null
  if (!container.contains(sel.anchorNode) || !container.contains(sel.focusNode)) return null
  // A whitespace-only selection would quote nothing; text selected inside a form field (a plan's
  // "Revise…" box) is not part of the document selection's text at all.
  if (sel.toString().trim() === '') return null
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

  useEffect(() => {
    const update = (): void => {
      const container = containerRef.current
      const sel = selectionInside(container)
      const next = sel && container ? placeFor(sel, container) : null
      setAt((prev) => (prev && next && prev.left === next.left && prev.top === next.top ? prev : next))
    }
    const hide = (): void => setAt(null)
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') hide()
    }
    // Capture: `scroll` does not bubble. Only a scroller that holds the thread moves the selection.
    const onScroll = (e: Event): void => {
      const t = e.target
      const container = containerRef.current
      if (t === document || (t instanceof Node && container !== null && t.contains(container))) hide()
    }
    document.addEventListener('selectionchange', update)
    document.addEventListener('scroll', onScroll, true)
    window.addEventListener('wheel', hide, { capture: true, passive: true })
    window.addEventListener('resize', hide)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('selectionchange', update)
      document.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('wheel', hide, { capture: true })
      window.removeEventListener('resize', hide)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [containerRef])

  if (!at) return null
  // React events bubble along the React tree, portal or not: keep a press here from reaching the
  // node and card handlers above the panel (node selection, the card modal's scrim).
  const stop = (e: SyntheticEvent): void => e.stopPropagation()
  return createPortal(
    <button
      type="button"
      className="chat-quote-btn"
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
