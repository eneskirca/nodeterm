import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

/** How close the bubble may come to the window edge before it is slid back inward. */
const EDGE_MARGIN = 8

/** Gap between the trigger's edge and the bubble, on whichever axis the placement opens along. */
const TOOLTIP_OFFSET = 6

/** Which side of the trigger the bubble opens on. Chrome that hugs the bottom of the window (the
 *  dock) must open upward: below it, the bubble lands off-screen. Chrome stacked vertically against
 *  the left edge (the canvas controls) opens sideways, where an upward bubble would cover the
 *  button above the one being pointed at. */
export type TooltipPlacement = 'top' | 'bottom' | 'right'

interface TooltipOptions {
  delay?: number
  placement?: TooltipPlacement
}

/**
 * The point the bubble is pinned to, in viewport coordinates. It is only half the position: the
 * matching `.tooltip--*` rule supplies the transform that pulls the bubble off that point, so the
 * two must agree. `top`/`bottom` pin a horizontal CENTER and shift the bubble up or down; `right`
 * pins its LEFT edge and centers it vertically instead.
 */
export function tooltipAnchor(
  rect: { top: number; right: number; left: number; width: number; height: number },
  placement: TooltipPlacement
): { x: number; y: number } {
  if (placement === 'right') {
    return { x: rect.right + TOOLTIP_OFFSET, y: rect.top + rect.height / 2 }
  }
  return {
    x: rect.left + rect.width / 2,
    y: placement === 'top' ? rect.top - TOOLTIP_OFFSET : rect.top + rect.height + TOOLTIP_OFFSET
  }
}

/** `bottom` is what the base rule already does, so it takes no modifier. */
export function tooltipClass(placement: TooltipPlacement): string {
  return placement === 'bottom' ? 'tooltip' : `tooltip tooltip--${placement}`
}

/**
 * How much of the bubble sits on either side of `left`, which is what the edge clamp has to know:
 * a centered placement spends half its width each way, `right` spends all of it trailing.
 */
function horizontalExtent(width: number, placement: TooltipPlacement): { leading: number; trailing: number } {
  const leading = placement === 'right' ? 0 : width / 2
  return { leading, trailing: width - leading }
}

interface TooltipProps extends TooltipOptions {
  label: string
  children: ReactNode
}

interface TooltipTrigger {
  /** Spread onto the trigger element. */
  triggerProps: {
    onMouseEnter: (e: React.MouseEvent) => void
    onMouseLeave: () => void
    onMouseDown: () => void
  }
  /** Render anywhere in the tree: the bubble portals to `document.body` regardless. */
  bubble: ReactNode
}

/**
 * The tooltip without its wrapper element, for a trigger that cannot take one: a React Flow
 * `Handle` positions itself with `translate(±50%, ±50%)` against the node, so a wrapper risks
 * moving it. The props compose rather than replace, since `Handle` destructures `onMouseDown` and
 * calls it from its own pointer-down handler.
 */
export function useTooltip(label: string, { delay = 350, placement = 'bottom' }: TooltipOptions = {}): TooltipTrigger {
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null)
  const [left, setLeft] = useState(0)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const bubbleRef = useRef<HTMLDivElement>(null)

  // A centered bubble runs off-screen for a long label near the window edge (a link handle carries
  // a whole sentence). `nowrap` makes the width independent of `left`, so this settles in one pass.
  useLayoutEffect(() => {
    const el = bubbleRef.current
    if (!anchor || !el) return
    const { leading, trailing } = horizontalExtent(el.offsetWidth, placement)
    const min = EDGE_MARGIN + leading
    const max = window.innerWidth - EDGE_MARGIN - trailing
    const next = min > max ? window.innerWidth / 2 : Math.min(Math.max(anchor.x, min), max)
    if (next !== left) setLeft(next)
  }, [anchor, left, placement])

  const show = (e: React.MouseEvent): void => {
    const el = e.currentTarget as HTMLElement
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      const next = tooltipAnchor(el.getBoundingClientRect(), placement)
      setLeft(next.x)
      setAnchor(next)
    }, delay)
  }

  const hide = (): void => {
    if (timer.current) clearTimeout(timer.current)
    setAnchor(null)
  }

  return {
    triggerProps: { onMouseEnter: show, onMouseLeave: hide, onMouseDown: hide },
    bubble:
      anchor &&
      createPortal(
        <div
          ref={bubbleRef}
          className={tooltipClass(placement)}
          style={{ left, top: anchor.y }}
        >
          {label}
        </div>,
        document.body
      )
  }
}

/** A custom styled tooltip (portal, fixed-positioned) shown on hover after a short delay. */
export function Tooltip({ label, children, delay, placement }: TooltipProps) {
  const { triggerProps, bubble } = useTooltip(label, { delay, placement })

  return (
    <span className="tooltip-trigger nodrag" {...triggerProps}>
      {children}
      {bubble}
    </span>
  )
}
