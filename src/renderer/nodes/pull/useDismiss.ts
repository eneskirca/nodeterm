import { useEffect, type RefObject } from 'react'

/** While `open`, a mousedown outside `ref` or Escape calls `close` (the document is the outside system). */
export function useDismiss(open: boolean, ref: RefObject<HTMLElement>, close: () => void): void {
  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent) => { if (!ref.current?.contains(event.target as Node)) close() }
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') close() }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [open, ref, close])
}
