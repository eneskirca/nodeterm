import { useLayoutEffect, useRef, type ReactNode } from 'react'

/** Keep the ambient pills outside the dock's measured footprint, without creating a stacking
 * context (their popovers still need to rise above the sidebar/board independently). */
export function CanvasPills({ children }: { children: ReactNode }): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const row = ref.current!
    const wrap = row.parentElement!
    const dock = wrap.closest('.canvas-root')?.querySelector<HTMLElement>('.dock')
    if (!dock) return
    const measure = (): void => {
      const bounds = wrap.getBoundingClientRect()
      if (!wrap.offsetWidth || !bounds.width) return
      // DOMRects include UI zoom; CSS lengths do not.
      const scale = bounds.width / wrap.offsetWidth
      const left = (row.getBoundingClientRect().left - bounds.left) / scale
      const dockBounds = dock.getBoundingClientRect()
      const gap = 8
      const edge = parseFloat(getComputedStyle(row).getPropertyValue('--float-gap')) || 22
      const beside = (dockBounds.left - bounds.left) / scale - left - gap
      // Below this budget, even a short usage summary becomes hard to read. Use a second row
      // above the dock, still bounded by the canvas, instead of covering either control.
      const above = beside < 200
      row.style.maxWidth = `${Math.max(0, above ? wrap.offsetWidth - left - edge : beside)}px`
      row.style.bottom = above
        ? `${Math.max(0, (bounds.bottom - dockBounds.top) / scale) + gap}px`
        : ''
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(wrap)
    observer.observe(dock)
    return () => observer.disconnect()
  }, [])
  return <div ref={ref} className="canvas-pills" data-canvas-chrome>{children}</div>
}
