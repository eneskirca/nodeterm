import { useEffect, type RefObject } from 'react'

/** While `open`, a press outside `ref` or Escape calls `close` (the document is the outside system).
 *  Capture phase on purpose: on the canvas, d3-zoom stops a press on the pane from bubbling, and a
 *  focused React Flow node can swallow Escape, so bubble listeners never heard either. */
export function useDismiss(open: boolean, ref: RefObject<HTMLElement>, close: () => void): void {
  useEffect(() => {
    if (!open) return
    const onDown = (event: PointerEvent) => { if (!ref.current?.contains(event.target as Node)) close() }
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') close() }
    document.addEventListener('pointerdown', onDown, true)
    document.addEventListener('keydown', onKey, true)
    return () => { document.removeEventListener('pointerdown', onDown, true); document.removeEventListener('keydown', onKey, true) }
  }, [open, ref, close])
}
